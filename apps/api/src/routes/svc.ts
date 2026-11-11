import { createOrderRequest, createRideRequest, problemRequest, sendChooseRequest, sendJobRequest, quoteRequest, rateRequest, rideQuoteRequest, roadDistance, PRE_PICKUP } from '@kirigo/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireKiriPay } from '../lib/auth';
import { handoffCode, handoffToken, trackTicket } from '../lib/handoff';
import { kiripay, mockCreateHold } from '../lib/kiripay';
import { makeQuote, offer, priceDrivers, road, sortOptions, type QuoteOption } from '../lib/matching';
import { moveMoney } from '../lib/money';
import { cancelOrder, eventStmt, getOrder, settleAccept, type OrderRow } from '../lib/orders';
import { savePhoto } from '../lib/photos';
import { answerDiscount, correctionAccepted, reportProblem } from '../lib/problems';
import { submitRatings } from '../lib/ratings';
import { addBuddies, alertsFor, cancelRide, emergency, following, isBuddy, makeRideQuote, priceRideDrivers, RIDE_SHOP, stopSharing } from '../lib/rides';
import { loadSettings } from '../lib/settings';
import { cancelJob, chooseBid, getJob, incoming, isRecipient, isSend, jobView, postJob } from '../lib/send';
import { orderView } from '../lib/views';
import { ApiError, body, newId, nowIso } from '../lib/util';

/**
 * Customer routes. Called by KiriPay's server for a signed-in member (the KiriPay app never talks to
 * KiriGo directly, except the live-tracking socket, which uses a short ticket from here).
 */
export const svc = new Hono<AppEnv>();
svc.use('*', requireKiriPay());

const me = (c: any) => c.get('actor').id as string;

async function mine(c: any, id: string): Promise<OrderRow> {
  const o = await getOrder(c.env.DB, id);
  if (o.customer_id !== me(c)) throw new ApiError('ORDER_NOT_FOUND', 404);
  return o;
}

svc.post('/quotes', async (c) => {
  const b = await body(c, quoteRequest);
  return c.json(await makeQuote(c.env, me(c), b.shopId, b.dropoff, b.size, b.sort));
});

/**
 * Create the order. The customer has ALREADY paid goods + delivery into a KiriPay escrow hold (in the KiriPay app).
 * Nothing is sent to the shop or a driver unless that hold is exactly right and not used by another order.
 */
svc.post('/orders', async (c) => {
  const b = await body(c, createOrderRequest);
  const customerId = me(c);
  const q = await c.env.DB.prepare('SELECT * FROM quotes WHERE id=?').bind(b.quoteId).first<any>();
  if (!q || q.customer_id !== customerId) throw new ApiError('QUOTE_NOT_FOUND', 404);
  if (q.used_by_order) throw new ApiError('QUOTE_USED', 409);
  if (q.expires_at < nowIso()) throw new ApiError('QUOTE_EXPIRED', 409);
  const options: QuoteOption[] = JSON.parse(q.options_json);
  const chosen = options.find((o) => o.driverId === b.driverId);
  if (!chosen) throw new ApiError('DRIVER_NOT_IN_QUOTE', 422);
  const shop = await c.env.DB.prepare('SELECT * FROM shops WHERE id=?').bind(q.shop_id).first<any>();
  if (!shop?.delivery_enabled) throw new ApiError('SHOP_NO_DELIVERY', 409);

  const total = b.goodsCents + chosen.priceCents;
  const kp = kiripay(c.env);
  const hold = await kp.getHold(b.holdId);
  if (!hold || hold.payerId !== customerId) throw new ApiError('HOLD_NOT_FOUND', 404);
  if (hold.status !== 'open' || hold.remaining !== total || hold.amount !== total) throw new ApiError('HOLD_AMOUNT_MISMATCH', 409, { expected: total, held: hold.remaining });

  const id = newId('ord');
  const bound = await kp.bindHold(b.holdId, id);
  if (!bound.ok) throw new ApiError(bound.code, 409);

  const fallback = b.fallbackDriverIds.map((d) => options.find((o) => o.driverId === d)).filter(Boolean).map((o) => ({ driverId: o!.driverId, priceCents: o!.priceCents }));
  const actor = c.get('actor');
  const ins = await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO customers (id) VALUES (?) ON CONFLICT(id) DO NOTHING').bind(customerId),
    c.env.DB.prepare(`INSERT INTO orders (id, kind, source, source_ref, shop_id, customer_id, quote_id, fallback_json, pickup_lat, pickup_lng, drop_lat, drop_lng,
      landmark, size, distance_m, goods_cents, delivery_cents, hold_id, status, share_phone) VALUES (?,'delivery',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PAID_HELD',?)
      ON CONFLICT(source, source_ref, kind) DO NOTHING`)
      .bind(id, b.source, b.sourceRef, q.shop_id, customerId, q.id, JSON.stringify(fallback), shop.pickup_lat, shop.pickup_lng, q.drop_lat, q.drop_lng,
        b.landmark, q.size, q.distance_m, b.goodsCents, chosen.priceCents, b.holdId, b.sharePhone ? 1 : 0),
    c.env.DB.prepare('UPDATE quotes SET used_by_order=? WHERE id=? AND used_by_order IS NULL').bind(id, q.id),
  ]);
  if (!ins[1]?.meta.changes) {
    // the same KiriPOS/Market order was already sent: give the hold straight back
    await moveMoney(c.env, { orderId: null, amount: total, key: `dup:${b.holdId}:refund`, reference: 'KiriGo: duplicate order', move: { action: 'refund', holdId: b.holdId } });
    throw new ApiError('ORDER_EXISTS', 409);
  }
  await c.env.DB.batch([eventStmt(c.env.DB, id, actor, 'created', { goodsCents: b.goodsCents, deliveryCents: chosen.priceCents, holdId: b.holdId })]);
  const o = await getOrder(c.env.DB, id);
  await offer(c.env, o, chosen.driverId, chosen.priceCents);
  return c.json(await orderView(c.env, o, actor), 201);
});

svc.get('/orders', async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM orders WHERE customer_id=? AND kind='delivery' AND service='delivery' AND send_job_id IS NULL ORDER BY created_at DESC LIMIT 50").bind(me(c)).all<OrderRow>();
  return c.json(await Promise.all((results ?? []).map((o) => orderView(c.env, o, c.get('actor')))));
});

svc.get('/orders/:id', async (c) => c.json(await orderView(c.env, await mine(c, c.req.param('id')), c.get('actor'))));

/** The QR + 4-digit code the customer shows the driver at the door. */
svc.get('/orders/:id/handoff', async (c) => {
  const o = await mine(c, c.req.param('id'));
  if (!['DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ARRIVED'].includes(o.status)) throw new ApiError('NOT_ON_THE_WAY', 409);
  return c.json({ qr: handoffToken(c.env, o.id), code: await handoffCode(c.env, o.id) }, 200, { 'cache-control': 'no-store' });
});

svc.get('/orders/:id/track-ticket', async (c) => {
  const o = await mine(c, c.req.param('id'));
  return c.json({ ticket: await trackTicket(c.env, o.parent_order_id ?? o.id, `customer:${o.customer_id}`), ws: `/ws/orders/${o.parent_order_id ?? o.id}` });
});

/** "Received, all correct": the shop is paid. */
svc.post('/orders/:id/accept', async (c) => {
  const o = await mine(c, c.req.param('id'));
  if (o.service === 'ride' || isSend(o)) throw new ApiError('NOT_A_DELIVERY', 409);
  if (o.status !== 'HANDED_OVER') throw new ApiError('NOT_DELIVERED_YET', 409);
  if (o.kind === 'correction') await correctionAccepted(c.env, o, c.get('actor'));
  else if (o.kind === 'delivery') await settleAccept(c.env, o, c.get('actor'), { shopAtFault: false });
  else throw new ApiError('NOT_A_DELIVERY', 409);
  return c.json(await orderView(c.env, await getOrder(c.env.DB, o.parent_order_id ?? o.id), c.get('actor')));
});

svc.post('/orders/:id/problem', async (c) => {
  const o = await mine(c, c.req.param('id'));
  if (o.service === 'ride' || isSend(o)) throw new ApiError('NOT_A_DELIVERY', 409);
  return c.json(await reportProblem(c.env, o, c.get('actor'), await body(c, problemRequest)));
});

svc.post('/orders/:id/discount', async (c) => {
  const o = await mine(c, c.req.param('id'));
  const b = await body(c, z.object({ accept: z.boolean() }));
  await answerDiscount(c.env, o, c.get('actor'), b.accept);
  return c.json(await orderView(c.env, await getOrder(c.env.DB, o.id), c.get('actor')));
});

svc.post('/orders/:id/cancel', async (c) => {
  const o = await mine(c, c.req.param('id'));
  if (o.service === 'ride') return c.json(await orderView(c.env, await cancelRide(c.env, o, c.get('actor')), c.get('actor')));
  if (!PRE_PICKUP.includes(o.status)) throw new ApiError('TOO_LATE_TO_CANCEL', 409);
  if (o.kind !== 'delivery') throw new ApiError('CANNOT_CANCEL_THIS', 409);
  await c.env.DB.prepare("UPDATE offers SET result='withdrawn' WHERE order_id=? AND result IS NULL").bind(o.id).run();
  await cancelOrder(c.env, o, c.get('actor'), 'customer_cancelled');
  return c.json(await orderView(c.env, await getOrder(c.env.DB, o.id), c.get('actor')));
});

/** Drivers available right now for an order that needs one (no one accepted, or a return/correction trip). */
svc.get('/orders/:id/drivers', async (c) => {
  const o = await mine(c, c.req.param('id'));
  if (isSend(o)) throw new ApiError('NOT_CHOOSING', 409);
  if (o.status !== 'PAID_HELD' || o.offer_driver_id) throw new ApiError('NOT_CHOOSING', 409);
  const s = await loadSettings(c.env.DB);
  const sort = (c.req.query('sort') as 'closest' | 'cheapest' | 'top_rated') || 'closest';
  const distance = roadDistance({ lat: o.pickup_lat, lng: o.pickup_lng }, { lat: o.drop_lat, lng: o.drop_lng }, road(c.env));
  const all = o.service === 'ride'
    ? await priceRideDrivers(c.env, s, { lat: o.pickup_lat, lng: o.pickup_lng }, distance, o.seats, null)
    : await priceDrivers(c.env, s, { lat: o.pickup_lat, lng: o.pickup_lng }, distance, o.size as any);
  const fits = await affordable(c, o, all);
  return c.json({ options: sortOptions(fits, sort, s.drivers_shown), paysBy: o.kind === 'delivery' ? 'you (already paid)' : 'the shop' });
});

/**
 * Which drivers the customer may pick when choosing again:
 *  - their own delivery: at or below what they already paid (any difference is refunded);
 *  - a return/correction the SHOP pays for: at or below the original delivery charge (or the cheapest available,
 *    if nobody is that cheap), so a customer can't run up the shop's costs by picking the dearest driver.
 */
async function affordable(c: any, o: OrderRow, all: QuoteOption[]): Promise<QuoteOption[]> {
  if (o.kind === 'delivery') return all.filter((d) => d.priceCents <= o.delivery_cents);
  const parent = await getOrder(c.env.DB, o.parent_order_id!);
  const cheapest = Math.min(...all.map((d) => d.priceCents));
  const cap = Math.max(parent.delivery_cents, Number.isFinite(cheapest) ? cheapest : 0);
  return all.filter((d) => d.priceCents <= cap);
}

svc.post('/orders/:id/choose-driver', async (c) => {
  const o = await mine(c, c.req.param('id'));
  if (isSend(o)) throw new ApiError('NOT_CHOOSING', 409);
  const b = await body(c, z.object({ driverId: z.string() }));
  if (o.status !== 'PAID_HELD' || o.offer_driver_id) throw new ApiError('NOT_CHOOSING', 409);
  const s = await loadSettings(c.env.DB);
  const all = o.service === 'ride'
    ? await priceRideDrivers(c.env, s, { lat: o.pickup_lat, lng: o.pickup_lng }, o.distance_m, o.seats, null)
    : await priceDrivers(c.env, s, { lat: o.pickup_lat, lng: o.pickup_lng }, o.distance_m, o.size as any);
  const pick = (await affordable(c, o, all)).find((d) => d.driverId === b.driverId);
  if (!pick) throw new ApiError('DRIVER_NOT_AVAILABLE', 409);
  if (o.kind === 'delivery') {
    if (pick.priceCents > o.delivery_cents) throw new ApiError('PRICE_ABOVE_PAID', 409);
    const diff = o.delivery_cents - pick.priceCents;
    if (diff > 0) {
      const r = await moveMoney(c.env, { orderId: o.id, amount: diff, key: `${o.id}:refund:repick:${pick.driverId}`, reference: `KiriGo ${o.id}: cheaper driver`, move: { action: 'refund', holdId: o.hold_id! } });
      if (!r.ok) throw new ApiError('REFUND_FAILED', 502);
    }
  }
  await c.env.DB.prepare('UPDATE orders SET delivery_cents=? WHERE id=?').bind(pick.priceCents, o.id).run();
  await offer(c.env, { ...o, delivery_cents: pick.priceCents }, pick.driverId, pick.priceCents);
  return c.json(await orderView(c.env, await getOrder(c.env.DB, o.id), c.get('actor')));
});

svc.post('/orders/:id/rate', async (c) => {
  const o = await mine(c, c.req.param('id'));
  const b = await body(c, rateRequest);
  await submitRatings(c.env, o, c.get('actor'), b.ratings as any);
  return c.json({ ok: true });
});

svc.get('/orders/:id/messages', async (c) => {
  const o = await mine(c, c.req.param('id'));
  const { results } = await c.env.DB.prepare('SELECT from_type, body, created_at FROM messages WHERE order_id=? ORDER BY id').bind(o.id).all();
  return c.json(results ?? []);
});

svc.post('/orders/:id/messages', async (c) => {
  const o = await mine(c, c.req.param('id'));
  const b = await body(c, z.object({ body: z.string().min(1).max(500) }));
  if (o.closed_at && Date.parse(o.closed_at) < Date.now() - 24 * 3600_000) throw new ApiError('CHAT_CLOSED', 409);
  await c.env.DB.prepare('INSERT INTO messages (order_id, from_type, from_id, body) VALUES (?,?,?,?)').bind(o.id, 'customer', o.customer_id, b.body).run();
  return c.json({ ok: true });
});

/** Problem photo, taken in the KiriPay app's camera and passed through by KiriPay. */
svc.post('/orders/:id/photos', async (c) => {
  const o = await mine(c, c.req.param('id'));
  const s = await loadSettings(c.env.DB);
  return c.json({ photoId: await savePhoto(c.env, c.get('actor'), c.req.raw, 'problem', o.id, s.retention_photos_days) }, 201);
});

/** Development only: pretend the customer paid in KiriPay (KIRIPAY_MODE=mock). */
svc.post('/dev/hold', async (c) => {
  if (c.env.KIRIPAY_MODE !== 'mock') throw new ApiError('NOT_FOUND', 404);
  const b = await body(c, z.object({ amountCents: z.number().int().positive() }));
  return c.json({ holdId: await mockCreateHold(c.env.DB, me(c), b.amountCents) });
});


// ================================================================== rides (customer side, via KiriPay)

svc.post('/rides/quotes', async (c) => {
  const b = await body(c, rideQuoteRequest);
  return c.json(await makeRideQuote(c.env, me(c), b.pickup, b.dropoff, b.seats, b.sort));
});

/** Book a ride. The rider has ALREADY paid fare + refundable buffer into a KiriPay hold. */
svc.post('/rides', async (c) => {
  const b = await body(c, createRideRequest);
  const customerId = me(c);
  const s = await loadSettings(c.env.DB);
  if (!s.rides_open) throw new ApiError('RIDES_NOT_OPEN', 503);
  const q = await c.env.DB.prepare('SELECT * FROM quotes WHERE id=?').bind(b.quoteId).first<any>();
  if (!q || q.customer_id !== customerId || q.shop_id !== RIDE_SHOP) throw new ApiError('QUOTE_NOT_FOUND', 404);
  if (q.used_by_order) throw new ApiError('QUOTE_USED', 409);
  if (q.expires_at < nowIso()) throw new ApiError('QUOTE_EXPIRED', 409);
  const [seatsPart, pickupPart] = String(q.size).split('|');
  const seats = Number(seatsPart!.split(':')[1]);
  const [plat, plng] = pickupPart!.split(',').map(Number);
  const options: QuoteOption[] = JSON.parse(q.options_json);
  const chosen = options.find((o) => o.driverId === b.driverId);
  if (!chosen) throw new ApiError('DRIVER_NOT_IN_QUOTE', 422);
  const total = chosen.priceCents + s.ride_buffer_cents;
  const kp = kiripay(c.env);
  const hold = await kp.getHold(b.holdId);
  if (!hold || hold.payerId !== customerId) throw new ApiError('HOLD_NOT_FOUND', 404);
  if (hold.status !== 'open' || hold.remaining !== total || hold.amount !== total) throw new ApiError('HOLD_AMOUNT_MISMATCH', 409, { expected: total, held: hold.remaining });
  const id = newId('ord');
  const bound = await kp.bindHold(b.holdId, id);
  if (!bound.ok) throw new ApiError(bound.code, 409);
  const fallback = b.fallbackDriverIds.map((d) => options.find((o) => o.driverId === d)).filter(Boolean).map((o) => ({ driverId: o!.driverId, priceCents: o!.priceCents }));
  const ins = await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO customers (id) VALUES (?) ON CONFLICT(id) DO NOTHING').bind(customerId),
    c.env.DB.prepare(`INSERT INTO orders (id, kind, service, source, source_ref, shop_id, customer_id, quote_id, fallback_json, pickup_lat, pickup_lng, drop_lat, drop_lng,
      landmark, drop_note, size, seats, distance_m, goods_cents, delivery_cents, hold_id, status, share_phone)
      VALUES (?,'delivery','ride','kiripay_ride',?,?,?,?,?,?,?,?,?,?,?,'small',?,?,?,?,?,'PAID_HELD',?) ON CONFLICT(source, source_ref, kind) DO NOTHING`)
      .bind(id, b.sourceRef, RIDE_SHOP, customerId, q.id, JSON.stringify(fallback), plat, plng, q.drop_lat, q.drop_lng, b.pickupNote, b.dropNote,
        seats, q.distance_m, s.ride_buffer_cents, chosen.priceCents, b.holdId, b.sharePhone ? 1 : 0),
    c.env.DB.prepare('UPDATE quotes SET used_by_order=? WHERE id=? AND used_by_order IS NULL').bind(id, q.id),
  ]);
  if (!ins[1]?.meta.changes) {
    await moveMoney(c.env, { orderId: null, amount: total, key: `dup:${b.holdId}:refund`, reference: 'KiriGo: duplicate ride', move: { action: 'refund', holdId: b.holdId } });
    throw new ApiError('RIDE_EXISTS', 409);
  }
  await eventStmt(c.env.DB, id, c.get('actor'), 'created', { service: 'ride', fareCents: chosen.priceCents, bufferCents: s.ride_buffer_cents, seats }).run();
  const o = await getOrder(c.env.DB, id);
  if (b.buddies.length) await addBuddies(c.env, o, b.buddies);
  await offer(c.env, o, chosen.driverId, chosen.priceCents);
  return c.json(await orderView(c.env, o, c.get('actor')), 201);
});

svc.get('/rides', async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM orders WHERE customer_id=? AND service='ride' ORDER BY created_at DESC LIMIT 30").bind(me(c)).all<OrderRow>();
  return c.json(await Promise.all((results ?? []).map((o) => orderView(c.env, o, c.get('actor')))));
});

/** Trip buddy: let KiriPay contacts follow this trip, or stop sharing. */
svc.post('/orders/:id/buddies', async (c) => {
  const o = await mine(c, c.req.param('id'));
  const b = await body(c, z.object({ userIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{3,80}$/)).min(1).max(5) }));
  if (o.closed_at) throw new ApiError('TRIP_ENDED', 409);
  await addBuddies(c.env, o, b.userIds);
  return c.json({ ok: true });
});
svc.delete('/orders/:id/buddies', async (c) => {
  await stopSharing(c.env, await mine(c, c.req.param('id')));
  return c.json({ ok: true });
});

/** Emergency button (rider). Alerts Trip buddies and KiriGo admin with the live location. */
svc.post('/orders/:id/emergency', async (c) => {
  const o = await mine(c, c.req.param('id'));
  const b = await body(c, z.object({ lat: z.number().optional(), lng: z.number().optional() }));
  await emergency(c.env, o, 'customer', b.lat != null && b.lng != null ? { lat: b.lat, lng: b.lng } : null);
  return c.json({ ok: true });
});

/** Trips this member is following as a Trip buddy (the friend's view). */
svc.get('/following', async (c) => {
  const trips = await following(c.env, me(c));
  return c.json(await Promise.all(trips.map(async (o) => ({ ...(await buddyView(c.env, o)), alerts: await alertsFor(c.env, o.id) }))));
});

svc.get('/following/:id/track-ticket', async (c) => {
  const id = c.req.param('id');
  if (!(await isBuddy(c.env, id, me(c)))) throw new ApiError('ORDER_NOT_FOUND', 404);
  return c.json({ ticket: await trackTicket(c.env, id, `buddy:${me(c)}`), ws: `/ws/orders/${id}` });
});

/** A buddy sees the driver card, route and progress — not money, not codes. */
async function buddyView(env: any, o: OrderRow) {
  const v = await orderView(env, o, { type: 'customer', id: o.customer_id });
  return {
    id: v.id, status: v.status, label: v.label, driver: v.driver, pickup: { lat: o.pickup_lat, lng: o.pickup_lng }, dropoff: { lat: o.drop_lat, lng: o.drop_lng },
    riderFirstName: (await env.DB.prepare('SELECT first_name FROM customers WHERE id=?').bind(o.customer_id).first())?.first_name ?? null,
    times: v.times, etaS: o.eta_s, arrivedSafely: o.status === 'ACCEPTED',
  };
}

/** Latest driver position (for screens that poll instead of holding a socket open, e.g. the KiriPay app). */
async function lastPosition(env: any, orderId: string) {
  const stub = env.ORDER_TRACKER.get(env.ORDER_TRACKER.idFromName(orderId));
  const r = await stub.fetch('https://do/last');
  return r.ok ? r.json() : null;
}
svc.get('/orders/:id/position', async (c) => {
  const o = await mine(c, c.req.param('id'));
  return c.json({ status: o.status, last: await lastPosition(c.env, o.parent_order_id ?? o.id) });
});
svc.get('/following/:id/position', async (c) => {
  const id = c.req.param('id');
  if (!(await isBuddy(c.env, id, me(c)))) throw new ApiError('ORDER_NOT_FOUND', 404);
  const o = await getOrder(c.env.DB, id);
  return c.json({ status: o.status, last: await lastPosition(c.env, id) });
});
/** The friend presses "Alert KiriGo". */
svc.post('/following/:id/alert', async (c) => {
  const id = c.req.param('id');
  if (!(await isBuddy(c.env, id, me(c)))) throw new ApiError('ORDER_NOT_FOUND', 404);
  await emergency(c.env, await getOrder(c.env.DB, id), 'buddy', null);
  return c.json({ ok: true });
});


// ================================================================== KiriGo Send (customer side, via KiriPay)

/** Post a parcel job. KiriPay calls this itself (it fills in recipientUserId), not the member's app directly. */
svc.post('/send/jobs', async (c) => {
  const b = await body(c, sendJobRequest);
  const id = await postJob(c.env, me(c), b);
  return c.json(await jobView(c.env, await getJob(c.env, id)), 201);
});

svc.get('/send/jobs', async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM send_jobs WHERE customer_id=? AND (status='open' OR closed_at > ?) ORDER BY created_at DESC LIMIT 30")
    .bind(me(c), new Date(Date.now() - 7 * 86400_000).toISOString()).all<any>();
  const out = [];
  for (const j of results ?? []) {
    const o = j.order_id ? await getOrder(c.env.DB, j.order_id) : null;
    out.push({ ...(await jobView(c.env, j)), order: o ? { id: o.id, status: o.status } : null });
  }
  return c.json(out);
});

async function myJob(c: any, id: string) {
  const j = await getJob(c.env, id);
  if (j.customer_id !== me(c)) throw new ApiError('JOB_NOT_FOUND', 404);
  return j;
}
svc.get('/send/jobs/:id', async (c) => c.json(await jobView(c.env, await myJob(c, c.req.param('id')))));
svc.post('/send/jobs/:id/cancel', async (c) => {
  const j = await myJob(c, c.req.param('id'));
  await cancelJob(c.env, j);
  return c.json(await jobView(c.env, await getJob(c.env, j.id)));
});

/** The sender picked a bid and has ALREADY paid exactly that price into a KiriPay hold. */
svc.post('/send/jobs/:id/choose', async (c) => {
  const j = await myJob(c, c.req.param('id'));
  const b = await body(c, sendChooseRequest);
  const bid = await c.env.DB.prepare('SELECT price_cents FROM send_bids WHERE id=? AND job_id=? AND withdrawn_at IS NULL').bind(b.bidId, j.id).first<{ price_cents: number }>();
  if (!bid) throw new ApiError('BID_GONE', 409);
  const kp = kiripay(c.env);
  const hold = await kp.getHold(b.holdId);
  if (!hold || hold.payerId !== j.customer_id) throw new ApiError('HOLD_NOT_FOUND', 404);
  if (hold.status !== 'open' || hold.remaining !== bid.price_cents || hold.amount !== bid.price_cents) throw new ApiError('HOLD_AMOUNT_MISMATCH', 409, { expected: bid.price_cents, held: hold.remaining });
  const o = await chooseBid(c.env, j, b.bidId, b.holdId, b.sharePhone, c.get('actor'), async (orderId) => {
    const bound = await kp.bindHold(b.holdId, orderId);
    if (!bound.ok) throw new ApiError(bound.code, 409);
  });
  return c.json(await orderView(c.env, o, c.get('actor')), 201);
});

/** Parcels coming to me (when the sender's recipient phone/email matched my KiriPay account). */
svc.get('/incoming', async (c) => c.json(await incoming(c.env, me(c))));
async function forMe(c: any, id: string) {
  if (!(await isRecipient(c.env, id, me(c)))) throw new ApiError('ORDER_NOT_FOUND', 404);
  return getOrder(c.env.DB, id);
}
svc.get('/incoming/:id/handoff', async (c) => {
  const o = await forMe(c, c.req.param('id'));
  if (o.return_trip || !['DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ARRIVED'].includes(o.status)) throw new ApiError('NOT_ON_THE_WAY', 409);
  return c.json({ qr: handoffToken(c.env, o.id), code: await handoffCode(c.env, o.id) }, 200, { 'cache-control': 'no-store' });
});
svc.get('/incoming/:id/position', async (c) => {
  const o = await forMe(c, c.req.param('id'));
  return c.json({ status: o.status, last: o.return_trip ? null : await lastPosition(c.env, o.id) });
});
