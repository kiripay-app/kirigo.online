import { adultsOnly, driverApplyRequest, sendBidRequest, gpsPoint, handoffRequest, rateCardSchema, rateRequest, rideApplyRequest, rideRateCardSchema, validateRateCard } from '@kirigo/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Actor, AppEnv, Env } from '../env';
import { requireDriver, requireMember, signSession, type SessionClaims } from '../lib/auth';
import { checkHandoff, trackTicket } from '../lib/handoff';
import { nextDriver, pushToDriver } from '../lib/matching';
import { eventStmt, getOrder, notDelivered, payDriver, transition, type OrderRow } from '../lib/orders';
import { claimPhoto, savePhoto, type PhotoKind } from '../lib/photos';
import { submitRatings } from '../lib/ratings';
import { board, emergency, endRide, noShow, watchRide } from '../lib/rides';
import { loadSettings } from '../lib/settings';
import { driverDropped, isSend, openJobs, placeBid, returnToSender, sendDelivered, withdrawBid } from '../lib/send';
import { chargeMonthlyFee, feeStatus } from '../lib/fees';
import { orderView } from '../lib/views';
import { ApiError, body, newId, nowIso, plusMs, takeAttempt } from '../lib/util';
import { haversine } from '@kirigo/shared';

export const driver = new Hono<AppEnv>();

// ------------------------------------------------------------------ sign-up (any signed-in KiriPay member)

const member = new Hono<AppEnv>();
member.use('*', requireMember());

/** Licence / vehicle photos before the driver record exists (raw image body). */
member.post('/photos', async (c) => {
  const kind = c.req.query('kind') as PhotoKind;
  if (!['licence', 'vehicle'].includes(kind)) throw new ApiError('PHOTO_KIND', 422);
  const s = (c as any).get('session') as SessionClaims;
  return c.json({ photoId: await savePhoto(c.env, { type: 'driver', id: `u:${s.sub}`, userId: s.sub }, c.req.raw, kind, null, 0) }, 201);
});

member.post('/apply', async (c) => {
  const s = (c as any).get('session') as SessionClaims;
  const st = await loadSettings(c.env.DB);
  if (!st.driver_signup_open) throw new ApiError('SIGNUP_CLOSED', 503);
  if (!s.mfa) throw new ApiError('TWO_STEP_REQUIRED', 403);
  // drivers must have had their ID checked in KiriPay first (level 2: passport or licence + selfie)
  if ((s.kyc ?? 1) < 2) throw new ApiError('ID_CHECK_REQUIRED', 403);
  const b = await body(c, driverApplyRequest);
  const errs = validateRateCard(b.rateCard);
  if (errs.length) throw new ApiError('RATE_CARD_INVALID', 422, { errs });
  const exists = await c.env.DB.prepare('SELECT id FROM drivers WHERE kiripay_user_id=?').bind(s.sub).first();
  if (exists) throw new ApiError('ALREADY_APPLIED', 409);
  const tmp: Actor = { type: 'driver', id: `u:${s.sub}`, userId: s.sub };
  await claimPhoto(c.env, b.vehicle.photoId, 'vehicle', null, tmp);
  if (b.vehicle.type !== 'motorbike' || b.licencePhotoId) {
    if (!b.licencePhotoId) throw new ApiError('LICENCE_REQUIRED', 422);
    await claimPhoto(c.env, b.licencePhotoId, 'licence', null, tmp);
  }
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM drivers').bind().first<{ n: number }>();
  const id = newId('drv');
  const code = `KG-${String((n?.n ?? 0) + 101).padStart(4, '0')}`;
  const freeUntil = plusMs(st.free_period_months * 30 * 86_400_000);
  const day = Math.min(28, new Date(Date.now() + 12 * 3600_000).getUTCDate());
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO drivers (id, kiripay_user_id, driver_code, first_name, licence_photo_id, free_until, fee_anchor_day) VALUES (?,?,?,?,?,?,?)')
      .bind(id, s.sub, code, b.firstName, b.licencePhotoId ?? null, freeUntil, day),
    c.env.DB.prepare('INSERT INTO vehicles (id, driver_id, type, plate, photo_id, can_bulky) VALUES (?,?,?,?,?,?)')
      .bind(newId('veh'), id, b.vehicle.type, b.vehicle.plate, b.vehicle.photoId, b.vehicle.canBulky ? 1 : 0),
    c.env.DB.prepare('INSERT INTO rate_cards (driver_id, base_cents, per_km_cents, minimum_cents, night_cents, bulky_cents) VALUES (?,?,?,?,?,?)')
      .bind(id, b.rateCard.baseCents, b.rateCard.perKmCents, b.rateCard.minimumCents, b.rateCard.nightCents, b.rateCard.bulkyCents),
    c.env.DB.prepare('UPDATE photos SET taken_by=? WHERE taken_by=?').bind(id, `u:${s.sub}`),
  ]);
  // a fresh session that knows the driver id
  return c.json({ driverId: id, driverCode: code, status: 'pending', token: await signSession(c.env, { ...s, drv: id }) }, 201);
});

driver.route('/signup', member);

// ------------------------------------------------------------------ approved drivers

const d = new Hono<AppEnv>();
d.use('*', requireDriver());
const meId = (c: any) => c.get('actor').id as string;

async function myJob(c: any, id: string): Promise<OrderRow> {
  const o = await getOrder(c.env.DB, id);
  if (o.driver_id !== meId(c)) throw new ApiError('ORDER_NOT_FOUND', 404);
  return o;
}

d.get('/me', async (c) => {
  const id = meId(c);
  const row = await c.env.DB.prepare('SELECT * FROM drivers WHERE id=?').bind(id).first<any>();
  const v = await c.env.DB.prepare('SELECT type, plate, can_bulky FROM vehicles WHERE driver_id=? AND active=1').bind(id).first();
  const rc = await c.env.DB.prepare('SELECT base_cents, per_km_cents, minimum_cents, night_cents, bulky_cents FROM rate_cards WHERE driver_id=?').bind(id).first();
  const shift = await c.env.DB.prepare('SELECT id, online_at FROM shifts WHERE driver_id=? AND offline_at IS NULL').bind(id).first();
  return c.json({
    driverId: id, driverCode: row.driver_code, firstName: row.first_name, status: row.status,
    rating: row.rating_count >= 5 ? row.rating_avg : null, ratingCount: row.rating_count, deliveries: row.deliveries,
    vehicle: v, rateCard: rc, online: !!shift, fee: await feeStatus(c.env, row),
    services: { deliveries: !!row.deliveries_on, rides: !!row.rides_on },
    rides: { status: row.ride_status, seats: row.ride_seats, rateCard: await c.env.DB.prepare('SELECT * FROM ride_rate_cards WHERE driver_id=?').bind(id).first() },
  });
});

d.put('/rate-card', async (c) => {
  const rc = await body(c, rateCardSchema);
  const online = await c.env.DB.prepare('SELECT 1 FROM shifts WHERE driver_id=? AND offline_at IS NULL').bind(meId(c)).first();
  if (online) throw new ApiError('GO_OFFLINE_FIRST', 409);
  await c.env.DB.prepare('UPDATE rate_cards SET base_cents=?, per_km_cents=?, minimum_cents=?, night_cents=?, bulky_cents=?, updated_at=? WHERE driver_id=?')
    .bind(rc.baseCents, rc.perKmCents, rc.minimumCents, rc.nightCents, rc.bulkyCents, nowIso(), meId(c)).run();
  return c.json({ ok: true });
});

/** In-app camera photo (raw image body). ?kind=handoff|selfie|problem&order=… */
d.post('/photos', async (c) => {
  const kind = c.req.query('kind') as PhotoKind;
  if (!['handoff', 'selfie', 'pickup', 'vehicle'].includes(kind)) throw new ApiError('PHOTO_KIND', 422);
  const orderId = c.req.query('order') || null;
  if (orderId) await myJob(c, orderId);
  const s = await loadSettings(c.env.DB);
  return c.json({ photoId: await savePhoto(c.env, c.get('actor'), c.req.raw, kind, orderId, s.retention_photos_days) }, 201);
});

d.post('/online', async (c) => {
  const b = await body(c, z.object({ selfiePhotoId: z.string(), lat: z.number(), lng: z.number() }));
  const row = await c.env.DB.prepare('SELECT * FROM drivers WHERE id=?').bind(meId(c)).first<any>();
  if (row.status !== 'approved') throw new ApiError('NOT_APPROVED_YET', 403);
  const fee = await feeStatus(c.env, row);
  if (!fee.canGoOnline) throw new ApiError('MONTHLY_FEE_DUE', 402 as any, { fee });
  await claimPhoto(c.env, b.selfiePhotoId, 'selfie', null, c.get('actor'));
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE shifts SET offline_at=? WHERE driver_id=? AND offline_at IS NULL').bind(nowIso(), meId(c)),
    c.env.DB.prepare('INSERT INTO shifts (id, driver_id, selfie_photo_id, online_at) VALUES (?,?,?,?)').bind(newId('sh'), meId(c), b.selfiePhotoId, nowIso()),
  ]);
  await presence(c.env, 'online', { driverId: meId(c), lat: b.lat, lng: b.lng });
  return c.json({ online: true, ticket: await trackTicket(c.env, 'driver', meId(c)) });
});

d.post('/offline', async (c) => {
  await c.env.DB.prepare('UPDATE shifts SET offline_at=? WHERE driver_id=? AND offline_at IS NULL').bind(nowIso(), meId(c)).run();
  await presence(c.env, 'offline', { driverId: meId(c) });
  return c.json({ online: false });
});

/** Position while online and free: only kept in memory for matching (not stored). */
d.post('/position', async (c) => {
  const b = await body(c, z.object({ lat: z.number(), lng: z.number() }));
  const r = await presence(c.env, 'position', { driverId: meId(c), lat: b.lat, lng: b.lng });
  // the shift is open but the matcher lost track of this driver (e.g. after a restart): put them back
  if (r?.offline) {
    const open = await c.env.DB.prepare('SELECT 1 FROM shifts WHERE driver_id=? AND offline_at IS NULL').bind(meId(c)).first();
    if (open) await presence(c.env, 'online', { driverId: meId(c), lat: b.lat, lng: b.lng });
  }
  return c.json({ ok: true });
});

/** The Android app registers its phone for alerts (Firebase token). One phone can belong to one driver. */
d.post('/push-token', async (c) => {
  const b = await body(c, z.object({ token: z.string().min(20).max(4096), platform: z.enum(['android']).default('android') }));
  await c.env.DB.prepare(`INSERT INTO push_tokens (token, driver_id, platform) VALUES (?,?,?)
    ON CONFLICT(token) DO UPDATE SET driver_id=excluded.driver_id, last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(b.token, meId(c), b.platform).run();
  return c.json({ ok: true });
});
d.delete('/push-token', async (c) => {
  const b = await body(c, z.object({ token: z.string().min(20).max(4096) }));
  await c.env.DB.prepare('DELETE FROM push_tokens WHERE token=? AND driver_id=?').bind(b.token, meId(c)).run();
  return c.json({ ok: true });
});

/**
 * What KiriGo can see of this driver right now: the last position it received and, for deliveries and rides,
 * whether customers can find them — and if not, every reason why, in plain words.
 */
d.get('/visibility', async (c) => {
  const id = meId(c);
  const s = await loadSettings(c.env.DB);
  const row = await c.env.DB.prepare('SELECT * FROM drivers WHERE id=?').bind(id).first<any>();
  const shift = await c.env.DB.prepare('SELECT 1 FROM shifts WHERE driver_id=? AND offline_at IS NULL').bind(id).first();
  const stub = c.env.DRIVER_PRESENCE.get(c.env.DRIVER_PRESENCE.idFromName('tarawa'));
  const seen = await (await stub.fetch(`https://do/one?driver=${encodeURIComponent(id)}`)).json<any>();
  const ageS = seen ? Math.round((Date.now() - seen.at) / 1000) : null;
  const fee = await feeStatus(c.env, row);
  const busy = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE driver_id=? AND status IN ('DRIVER_ASSIGNED','AT_SHOP','PICKED_UP','ARRIVED')").bind(id).first<{ n: number }>();
  const common: string[] = [];
  if (row.status !== 'approved') common.push(row.status === 'pending' ? 'Your application is waiting for approval' : 'Your driver account is not active');
  if (!shift) common.push('You are offline. Tap Go online');
  else if (!seen) common.push('KiriGo has not received your location yet. Allow location for kirigo.online and keep this screen open');
  else if (ageS! > 180) common.push(`Your location reached KiriGo ${Math.round(ageS! / 60)} minutes ago. Keep this screen open with the phone awake`);
  if (fee.due) common.push('Your monthly fee is due');
  if ((busy?.n ?? 0) > 0) common.push('You are on a job. New ones come after you finish');
  const del = [...common, ...(row.deliveries_on ? [] : ['Deliveries are switched off in Me → Services'])];
  const rideStatus: Record<string, string> = { none: 'You have not applied for rides yet (Me → Rides)', pending: 'Your rides application is waiting for approval', suspended: 'Your rides are paused. Contact KiriGo', rejected: 'Your rides application was not approved' };
  const ride = [...common,
    ...(row.ride_status === 'approved' ? [] : [rideStatus[row.ride_status] ?? 'Not approved for rides']),
    ...(row.ride_status === 'approved' && !row.rides_on ? ['Rides are switched off in Me → Services'] : []),
    ...(s.rides_open ? [] : ['KiriGo rides are closed right now'])];
  return c.json({
    online: !!shift,
    seen: seen ? { lat: seen.lat, lng: seen.lng, ageS } : null,
    reachKm: s.pickup_radius_km,
    deliveries: { visible: del.length === 0, why: del },
    rides: { visible: ride.length === 0, why: ride },
  }, 200, { 'cache-control': 'no-store' });
});

d.get('/offers', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT f.id, f.order_id, f.price_cents, f.expires_at, f.kind, o.kind AS order_kind, o.service, o.seats, o.distance_m, o.size,
      o.pickup_lat, o.pickup_lng, o.drop_lat, o.drop_lng, s.name AS shop_name, cu.rating_avg AS customer_rating, cu.rating_count AS customer_ratings
    FROM offers f JOIN orders o ON o.id=f.order_id JOIN shops s ON s.id=o.shop_id LEFT JOIN customers cu ON cu.id=o.customer_id
    WHERE f.driver_id=? AND f.result IS NULL AND f.expires_at > ?`).bind(meId(c), nowIso()).all<any>();
  return c.json((results ?? []).map((r) => ({
    offerId: r.id, orderId: r.order_id, kind: r.service === 'ride' ? 'ride' : r.order_kind, seats: r.seats, priceCents: r.price_cents, expiresAt: r.expires_at, distanceM: r.distance_m, size: r.size,
    shop: r.shop_name, pickupArea: { lat: Math.round(r.pickup_lat * 100) / 100, lng: Math.round(r.pickup_lng * 100) / 100 },
    dropArea: { lat: Math.round(r.drop_lat * 100) / 100, lng: Math.round(r.drop_lng * 100) / 100 },
    customerRating: r.customer_ratings >= 5 ? r.customer_rating : 'New',
  })));
});

d.post('/offers/:id/accept', async (c) => {
  const of = await c.env.DB.prepare('SELECT * FROM offers WHERE id=? AND driver_id=?').bind(c.req.param('id'), meId(c)).first<any>();
  if (!of || of.result) throw new ApiError('OFFER_GONE', 409);
  if (of.expires_at < nowIso()) throw new ApiError('OFFER_EXPIRED', 409);
  const r = await c.env.DB.prepare("UPDATE offers SET result='accepted' WHERE id=? AND result IS NULL").bind(of.id).run();
  if (!r.meta.changes) throw new ApiError('OFFER_GONE', 409);
  const o = await getOrder(c.env.DB, of.order_id);
  if (o.status !== 'PAID_HELD' || o.offer_driver_id !== meId(c)) throw new ApiError('OFFER_GONE', 409);
  const next = await transition(c.env, o, 'DRIVER_ASSIGNED', c.get('actor'), {
    set: { driver_id: meId(c), assigned_at: nowIso(), offer_driver_id: null, offer_expires_at: null, delivery_cents: of.price_cents },
  });
  return c.json(await orderView(c.env, next, c.get('actor')));
});

d.post('/offers/:id/decline', async (c) => {
  const of = await c.env.DB.prepare('SELECT * FROM offers WHERE id=? AND driver_id=?').bind(c.req.param('id'), meId(c)).first<any>();
  if (!of) throw new ApiError('OFFER_GONE', 404);
  const r = await c.env.DB.prepare("UPDATE offers SET result='declined' WHERE id=? AND result IS NULL").bind(of.id).run();
  if (r.meta.changes) await nextDriver(c.env, of.order_id, 'declined');
  return c.json({ ok: true });
});

d.get('/jobs', async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM orders WHERE driver_id=? AND status IN ('DRIVER_ASSIGNED','AT_SHOP','PICKED_UP','ARRIVED') ORDER BY assigned_at").bind(meId(c)).all<OrderRow>();
  return c.json(await Promise.all((results ?? []).map((o) => orderView(c.env, o, c.get('actor')))));
});

d.get('/jobs/:id', async (c) => c.json(await orderView(c.env, await myJob(c, c.req.param('id')), c.get('actor'))));

d.get('/jobs/:id/track-ticket', async (c) => {
  const o = await myJob(c, c.req.param('id'));
  return c.json({ ticket: await trackTicket(c.env, o.parent_order_id ?? o.id, `driver:${meId(c)}`), ws: `/ws/orders/${o.parent_order_id ?? o.id}` });
});

/** GPS from accept to handed over, every 10–15 s (batched when the signal is patchy). */
d.post('/jobs/:id/gps', async (c) => {
  const o = await myJob(c, c.req.param('id'));
  if (!['DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ARRIVED'].includes(o.status)) throw new ApiError('NOT_TRACKING', 409);
  const b = await body(c, z.object({ points: z.array(gpsPoint).min(1).max(200) }));
  const stub = c.env.ORDER_TRACKER.get(c.env.ORDER_TRACKER.idFromName(o.parent_order_id ?? o.id));
  await stub.fetch('https://do/gps', { method: 'POST', body: JSON.stringify({ orderId: o.id, driverId: meId(c), points: b.points }) });
  const last = b.points.at(-1)!;
  await presence(c.env, 'position', { driverId: meId(c), lat: last.lat, lng: last.lng });
  if (o.service === 'ride') await watchRide(c.env, o, last);
  return c.json({ ok: true });
});

d.post('/jobs/:id/status', async (c) => {
  const o = await myJob(c, c.req.param('id'));
  const b = await body(c, z.object({ status: z.enum(['at_pickup', 'picked_up', 'arrived']), lat: z.number(), lng: z.number(), code: z.string().optional(), token: z.string().optional() }));
  const at = { lat: b.lat, lng: b.lng };
  if (b.status === 'at_pickup') return c.json(await orderView(c.env, await transition(c.env, o, 'AT_SHOP', c.get('actor'), { at, set: o.service === 'ride' ? { at_pickup_at: nowIso() } : {} }), c.get('actor')));
  if (b.status === 'picked_up' && o.service === 'ride') {
    // the rider boards: they show their boarding code
    if (b.code && !b.token && !(await takeAttempt(c.env.DB, `board:${o.id}`, 5, 3600_000))) throw new ApiError('TOO_MANY_TRIES', 429);
    const ok = await checkHandoff(c.env, o.id, { code: b.code, token: b.token });
    if (!ok.ok) throw new ApiError('HANDOFF_CODE_WRONG', 422, { reason: ok.reason });
    return c.json(await orderView(c.env, await board(c.env, o, c.get('actor'), at), c.get('actor')));
  }
  if (b.status === 'picked_up') {
    // collecting a return from the customer: they show their code, like a handoff in reverse
    if (o.kind === 'return') {
      const ok = await checkHandoff(c.env, o.id, { code: b.code, token: b.token });
      if (!ok.ok) throw new ApiError('HANDOFF_CODE_WRONG', 422, { reason: ok.reason });
    }
    return c.json(await orderView(c.env, await transition(c.env, o, 'PICKED_UP', c.get('actor'), { at, set: { picked_up_at: nowIso() } }), c.get('actor')));
  }
  return c.json(await orderView(c.env, await transition(c.env, o, 'ARRIVED', c.get('actor'), { at }), c.get('actor')));
});

/** Driver gives up a job before pickup: it goes back to the customer's list. Counts against their standing. */
d.post('/jobs/:id/release', async (c) => {
  const o = await myJob(c, c.req.param('id'));
  if (!['DRIVER_ASSIGNED', 'AT_SHOP'].includes(o.status)) throw new ApiError('TOO_LATE', 409);
  if (isSend(o)) {
    await driverDropped(c.env, o, c.get('actor'));
    await c.env.DB.prepare('UPDATE drivers SET accept_then_cancel = accept_then_cancel + 1 WHERE id=?').bind(meId(c)).run();
    return c.json({ ok: true });
  }
  await transition(c.env, o, 'PAID_HELD', c.get('actor'), { set: { driver_id: null, assigned_at: null }, data: { reason: 'driver_released' } });
  await c.env.DB.prepare('UPDATE drivers SET accept_then_cancel = accept_then_cancel + 1 WHERE id=?').bind(meId(c)).run();
  await nextDriver(c.env, o.id, 'dropped');
  return c.json({ ok: true });
});

type HandoffInput = z.infer<typeof handoffRequest>;

/**
 * Handoff at the door: valid QR (works offline) or 4-digit code (online, 5 tries), plus an in-app photo.
 * After 22:00 only an adult may accept. Pays the driver straight away.
 * For a return trip the "handoff" is the drop at the shop: no code, photo + position near the shop pin.
 */
async function doHandoff(env: Env, actor: Actor, o: OrderRow, b: HandoffInput, offline: boolean) {
  if (o.status === 'PICKED_UP') o = await transition(env, o, 'ARRIVED', actor, { at: { lat: b.lat, lng: b.lng }, data: { auto: true } });
  if (o.status !== 'ARRIVED') throw new ApiError('NOT_ARRIVED', 409);
  const s = await loadSettings(env.DB);
  if (o.kind === 'return') {
    const near = haversine({ lat: b.lat, lng: b.lng }, { lat: o.drop_lat, lng: o.drop_lng });
    if (near > 300) throw new ApiError('NOT_AT_SHOP', 422, { metres: Math.round(near) });
  } else {
    if (offline && !b.token) throw new ApiError('OFFLINE_NEEDS_QR', 422);
    if (b.code && !b.token && !(await takeAttempt(env.DB, `handoff:${o.id}`, 5, 3600_000))) throw new ApiError('TOO_MANY_TRIES', 429);
    const ok = await checkHandoff(env, o.id, b);
    if (!ok.ok) throw new ApiError('HANDOFF_CODE_WRONG', 422, { reason: ok.reason });
    if (adultsOnly(b.at, s.adults_only_after) && (b.receiverIsChild || !b.adultConfirmed)) throw new ApiError('ADULT_REQUIRED', 422);
  }
  await claimPhoto(env, b.photoId, 'handoff', o.id, actor);
  const next = await transition(env, o, 'HANDED_OVER', actor, {
    at: { lat: b.lat, lng: b.lng },
    set: { handed_over_at: new Date(Math.min(b.at, Date.now())).toISOString() },
    data: {
      photoId: b.photoId, via: b.token ? 'qr' : 'code', offline, takenAt: new Date(b.at).toISOString(),
      someoneElse: b.receivedBySomeoneElse, receiverName: b.receiverName, child: b.receiverIsChild, adultConfirmed: b.adultConfirmed, faceRefused: b.faceRefused,
    },
  });
  await payDriver(env, next);
  if (isSend(next)) await sendDelivered(env, next);
  // the GPS route ends here
  const stub = env.ORDER_TRACKER.get(env.ORDER_TRACKER.idFromName(o.parent_order_id ?? o.id));
  await stub.fetch('https://do/finish', { method: 'POST', body: JSON.stringify({ orderId: o.id }) }).catch(() => {});
  return getOrder(env.DB, o.id);
}

d.post('/jobs/:id/handoff', async (c) => {
  const o = await myJob(c, c.req.param('id'));
  if (o.service === 'ride') throw new ApiError('USE_END_RIDE', 409);
  const b = await body(c, handoffRequest);
  return c.json(await orderView(c.env, await doHandoff(c.env, c.get('actor'), o, b, false), c.get('actor')));
});

/** Handoffs saved on the phone while offline (QR only), sent when back online. */
d.post('/sync', async (c) => {
  const b = await body(c, z.object({ handoffs: z.array(z.object({ orderId: z.string() }).passthrough()).max(20) }));
  const out = [];
  for (const h of b.handoffs) {
    try {
      const o = await myJob(c, h.orderId);
      if (o.status === 'HANDED_OVER' || o.driver_paid) { out.push({ orderId: h.orderId, ok: true, already: true }); continue; }
      const parsed = handoffRequest.safeParse(h);
      if (!parsed.success) { out.push({ orderId: h.orderId, ok: false, error: 'INVALID_INPUT' }); continue; }
      await doHandoff(c.env, c.get('actor'), o, parsed.data, true);
      out.push({ orderId: h.orderId, ok: true });
    } catch (e) {
      out.push({ orderId: h.orderId, ok: false, error: e instanceof ApiError ? e.code : 'SERVER_ERROR' });
    }
  }
  return c.json({ results: out });
});

d.post('/jobs/:id/not-delivered', async (c) => {
  const o = await myJob(c, c.req.param('id'));
  const b = await body(c, z.object({ reason: z.enum(['no_adult', 'customer_absent']), lat: z.number(), lng: z.number() }));
  if (o.status !== 'ARRIVED') throw new ApiError('NOT_ARRIVED', 409);
  const s = await loadSettings(c.env.DB);
  const arrived = await c.env.DB.prepare("SELECT at FROM order_events WHERE order_id=? AND type='status:ARRIVED' ORDER BY id DESC LIMIT 1").bind(o.id).first<{ at: string }>();
  if (arrived && Date.now() - Date.parse(arrived.at) < s.door_wait_min * 60_000) throw new ApiError('WAIT_A_LITTLE_LONGER', 409, { minutes: s.door_wait_min });
  await logPos(c.env, o.id, c.get('actor'), b);
  if (isSend(o)) {
    // first time: take it back to the sender. Already on the way back and nobody there either: KiriGo's team follows up.
    if (!o.return_trip) return c.json(await orderView(c.env, await returnToSender(c.env, o, c.get('actor'), b.reason), c.get('actor')));
    await transition(c.env, o, 'NOT_DELIVERED', c.get('actor'), { set: { closed_at: nowIso() }, data: { reason: b.reason, parcelWithDriver: true } });
    return c.json({ ok: true });
  }
  await notDelivered(c.env, o, c.get('actor'), b.reason);
  return c.json({ ok: true });
});

d.post('/jobs/:id/rate', async (c) => {
  const o = await getOrder(c.env.DB, c.req.param('id'));
  if (o.driver_id !== meId(c)) throw new ApiError('ORDER_NOT_FOUND', 404);
  await submitRatings(c.env, o, c.get('actor'), (await body(c, rateRequest)).ratings as any);
  return c.json({ ok: true });
});

d.get('/jobs/:id/messages', async (c) => {
  const o = await myJob(c, c.req.param('id'));
  const { results } = await c.env.DB.prepare('SELECT from_type, body, created_at FROM messages WHERE order_id=? ORDER BY id').bind(o.id).all();
  return c.json(results ?? []);
});

d.post('/jobs/:id/messages', async (c) => {
  const o = await myJob(c, c.req.param('id'));
  const b = await body(c, z.object({ body: z.string().min(1).max(500) }));
  await c.env.DB.prepare('INSERT INTO messages (order_id, from_type, from_id, body) VALUES (?,?,?,?)').bind(o.id, 'driver', meId(c), b.body).run();
  return c.json({ ok: true });
});

d.get('/earnings', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT substr(created_at,1,10) AS day, SUM(amount_cents) AS cents, COUNT(*) AS trips
    FROM money_calls WHERE driver_id=? AND action='release' AND to_kind='driver' AND status='done' GROUP BY day ORDER BY day DESC LIMIT 60`).bind(meId(c)).all();
  return c.json({ days: results ?? [] });
});

d.post('/fee/pay', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM drivers WHERE id=?').bind(meId(c)).first<any>();
  return c.json(await chargeMonthlyFee(c.env, row, true));
});

d.get('/ws-ticket', async (c) => c.json({ ticket: await trackTicket(c.env, 'driver', meId(c)), ws: '/ws/driver' }));

// ------------------------------------------------------------------ rides (driver side)

/** What this driver does: deliveries, rides, or both. Only while offline. */
d.put('/services', async (c) => {
  const b = await body(c, z.object({ deliveries: z.boolean(), rides: z.boolean() }));
  const row = await c.env.DB.prepare('SELECT ride_status FROM drivers WHERE id=?').bind(meId(c)).first<{ ride_status: string }>();
  if (b.rides && row?.ride_status !== 'approved') throw new ApiError('RIDES_NOT_APPROVED', 403);
  if (!b.deliveries && !b.rides) throw new ApiError('PICK_AT_LEAST_ONE', 422);
  const online = await c.env.DB.prepare('SELECT 1 FROM shifts WHERE driver_id=? AND offline_at IS NULL').bind(meId(c)).first();
  if (online) throw new ApiError('GO_OFFLINE_FIRST', 409);
  await c.env.DB.prepare('UPDATE drivers SET deliveries_on=?, rides_on=? WHERE id=?').bind(b.deliveries ? 1 : 0, b.rides ? 1 : 0, meId(c)).run();
  return c.json({ ok: true });
});

/** Ask to carry passengers: seats, a roadworthiness photo of the car, ride prices. Admin approves. */
d.post('/rides/apply', async (c) => {
  const b = await body(c, rideApplyRequest);
  const v = await c.env.DB.prepare('SELECT type FROM vehicles WHERE driver_id=? AND active=1').bind(meId(c)).first<{ type: string }>();
  if (!v || !['car', 'van'].includes(v.type)) throw new ApiError('RIDES_NEED_A_CAR', 422);
  await claimPhoto(c.env, b.roadworthyPhotoId, 'vehicle', null, c.get('actor'));
  const rc = b.rateCard;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE drivers SET ride_status=CASE WHEN ride_status='approved' THEN 'approved' ELSE 'pending' END, ride_seats=?, roadworthy_photo_id=? WHERE id=?").bind(b.seats, b.roadworthyPhotoId, meId(c)),
    c.env.DB.prepare(`INSERT INTO ride_rate_cards (driver_id, base_cents, per_km_cents, minimum_cents, night_cents, wait_per_min_cents, cancel_cents) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(driver_id) DO UPDATE SET base_cents=excluded.base_cents, per_km_cents=excluded.per_km_cents, minimum_cents=excluded.minimum_cents,
      night_cents=excluded.night_cents, wait_per_min_cents=excluded.wait_per_min_cents, cancel_cents=excluded.cancel_cents, updated_at=excluded.updated_at`)
      .bind(meId(c), rc.baseCents, rc.perKmCents, rc.minimumCents, rc.nightCents, rc.waitPerMinCents, rc.cancelCents),
  ]);
  return c.json({ ok: true });
});

d.put('/rides/rate-card', async (c) => {
  const rc = await body(c, rideRateCardSchema);
  const online = await c.env.DB.prepare('SELECT 1 FROM shifts WHERE driver_id=? AND offline_at IS NULL').bind(meId(c)).first();
  if (online) throw new ApiError('GO_OFFLINE_FIRST', 409);
  const r = await c.env.DB.prepare('UPDATE ride_rate_cards SET base_cents=?, per_km_cents=?, minimum_cents=?, night_cents=?, wait_per_min_cents=?, cancel_cents=?, updated_at=? WHERE driver_id=?')
    .bind(rc.baseCents, rc.perKmCents, rc.minimumCents, rc.nightCents, rc.waitPerMinCents, rc.cancelCents, nowIso(), meId(c)).run();
  if (!r.meta.changes) throw new ApiError('APPLY_FOR_RIDES_FIRST', 409);
  return c.json({ ok: true });
});

/** Drop-off: ends the ride and pays the driver. */
d.post('/jobs/:id/end-ride', async (c) => {
  const o = await myJob(c, c.req.param('id'));
  if (o.service !== 'ride') throw new ApiError('NOT_A_RIDE', 409);
  const b = await body(c, z.object({ lat: z.number(), lng: z.number() }));
  return c.json(await orderView(c.env, await endRide(c.env, o, c.get('actor'), b), c.get('actor')));
});

/** The rider never came out: after the wait, the driver gets the cancellation fee. */
d.post('/jobs/:id/no-show', async (c) => {
  const o = await myJob(c, c.req.param('id'));
  if (o.service !== 'ride') throw new ApiError('NOT_A_RIDE', 409);
  const b = await body(c, z.object({ lat: z.number(), lng: z.number() }));
  return c.json(await orderView(c.env, await noShow(c.env, o, c.get('actor'), b), c.get('actor')));
});

/** Emergency button (driver). */
d.post('/jobs/:id/emergency', async (c) => {
  const o = await myJob(c, c.req.param('id'));
  const b = await body(c, z.object({ lat: z.number().optional(), lng: z.number().optional() }));
  await emergency(c.env, o, 'driver', b.lat != null && b.lng != null ? { lat: b.lat, lng: b.lng } : null);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- KiriGo Send: bid on parcel jobs

d.get('/send/jobs', async (c) => {
  const lat = Number(c.req.query('lat')), lng = Number(c.req.query('lng'));
  return c.json(await openJobs(c.env, meId(c), Number.isFinite(lat) && Number.isFinite(lng) && lat && lng ? { lat, lng } : null));
});
d.post('/send/jobs/:id/bid', async (c) => {
  const b = await body(c, sendBidRequest);
  return c.json(await placeBid(c.env, meId(c), c.req.param('id'), b.priceCents, b.note));
});
d.delete('/send/jobs/:id/bid', async (c) => {
  await withdrawBid(c.env, meId(c), c.req.param('id'));
  return c.json({ ok: true });
});

driver.route('/', d);

// ------------------------------------------------------------------ helpers

async function presence(env: Env, op: 'online' | 'offline' | 'position', data: Record<string, unknown>): Promise<any> {
  const stub = env.DRIVER_PRESENCE.get(env.DRIVER_PRESENCE.idFromName('tarawa'));
  const r = await stub.fetch(`https://do/${op}`, { method: 'POST', body: JSON.stringify(data) });
  return r.json().catch(() => null);
}

async function logPos(env: Env, orderId: string, actor: Actor, p: { lat: number; lng: number }) {
  await eventStmt(env.DB, orderId, actor, 'position', null, p).run();
}

export { pushToDriver };

