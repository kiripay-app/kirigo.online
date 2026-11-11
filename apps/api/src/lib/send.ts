// KiriGo Send: someone sends a document or parcel to another person within a time frame.
// 1. The sender posts a job (no money yet). 2. Drivers who want it bid their own price.
// 3. The sender picks a bid and pays it into a KiriPay hold. 4. It runs as a normal delivery from the
// 'kirigo-send' placeholder shop: the driver collects from the sender, hands over to the recipient with the
// code + photo and is paid on the spot. Nothing else is in the hold, so the order closes there and then.
import { haversine, roadDistance, type LatLng } from '@kirigo/shared';
import type { Actor, Env } from '../env';
import { feeOkSql } from './fees';
import { pushToDriver, road } from './matching';
import { cancelOrder, eventStmt, getOrder, payDriver, transition, type OrderRow } from './orders';
import { loadSettings } from './settings';
import { driverCard } from './views';
import { ApiError, newId, nowIso } from './util';

export const SEND_SHOP = 'kirigo-send';
export const isSend = (o: Pick<OrderRow, 'shop_id'>) => o.shop_id === SEND_SHOP;

export interface SendJob {
  id: string; customer_id: string; source_ref: string; status: 'open' | 'chosen' | 'cancelled' | 'expired';
  pickup_lat: number; pickup_lng: number; pickup_note: string; drop_lat: number; drop_lng: number; drop_note: string;
  distance_m: number; item: string; description: string; recipient_name: string; recipient_phone: string; recipient_user_id: string | null;
  pickup_after: string; deliver_by: string; order_id: string | null; created_at: string; closed_at: string | null;
}


export async function getJob(env: Env, id: string): Promise<SendJob> {
  const j = await env.DB.prepare('SELECT * FROM send_jobs WHERE id=?').bind(id).first<SendJob>();
  if (!j) throw new ApiError('JOB_NOT_FOUND', 404);
  return j;
}

export async function postJob(env: Env, customerId: string, b: {
  pickup: LatLng; pickupNote: string; dropoff: LatLng; dropNote: string; item: string; description: string;
  recipientName: string; recipientPhone: string; recipientUserId: string | null; pickupAfter: string; deliverBy: string; sourceRef: string;
}) {
  const s = await loadSettings(env.DB);
  if (!s.send_open) throw new ApiError('SEND_NOT_OPEN', 503);
  const cust = await env.DB.prepare('SELECT delivery_restricted FROM customers WHERE id=?').bind(customerId).first<any>();
  if (cust?.delivery_restricted) throw new ApiError('CUSTOMER_RESTRICTED', 403);
  const after = Date.parse(b.pickupAfter), by = Date.parse(b.deliverBy);
  if (by <= Date.now() + 10 * 60_000) throw new ApiError('DEADLINE_TOO_SOON', 422);
  if (by <= after + 10 * 60_000) throw new ApiError('TIME_FRAME_TOO_SHORT', 422);
  if (after > Date.now() + 7 * 86400_000) throw new ApiError('TOO_FAR_AHEAD', 422);
  const distanceM = roadDistance(b.pickup, b.dropoff, road(env));
  if (distanceM < 100) throw new ApiError('TOO_SHORT', 422);
  const old = await env.DB.prepare('SELECT id FROM send_jobs WHERE customer_id=? AND source_ref=?').bind(customerId, b.sourceRef).first<{ id: string }>();
  if (old) return old.id;
  const id = newId('snd');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO customers (id) VALUES (?) ON CONFLICT(id) DO NOTHING').bind(customerId),
    env.DB.prepare(`INSERT INTO send_jobs (id, customer_id, source_ref, pickup_lat, pickup_lng, pickup_note, drop_lat, drop_lng, drop_note, distance_m, item, description,
      recipient_name, recipient_phone, recipient_user_id, pickup_after, deliver_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, customerId, b.sourceRef, b.pickup.lat, b.pickup.lng, b.pickupNote, b.dropoff.lat, b.dropoff.lng, b.dropNote, distanceM, b.item, b.description,
        b.recipientName, b.recipientPhone, b.recipientUserId, new Date(Math.max(after, Date.now())).toISOString(), new Date(by).toISOString()),
  ]);
  // let drivers online right now know there is something to bid on
  const { results } = await env.DB.prepare(`SELECT d.id FROM drivers d WHERE d.status='approved' AND d.deliveries_on=1 AND ${feeOkSql(s.monthly_fee_cents)}`).bind(nowIso()).all<{ id: string }>();
  await Promise.all((results ?? []).slice(0, 200).map((d) => pushToDriver(env, d.id, { type: 'send_job', jobId: id })));
  return id;
}

/** What the sender sees: the job and every live bid, cheapest first. */
export async function jobView(env: Env, j: SendJob) {
  const { results } = await env.DB.prepare('SELECT * FROM send_bids WHERE job_id=? AND withdrawn_at IS NULL ORDER BY price_cents, created_at').bind(j.id).all<any>();
  const bids = [];
  for (const b of results ?? []) {
    const card = await driverCard(env, b.driver_id);
    if (card) bids.push({ bidId: b.id, priceCents: b.price_cents, note: b.note, at: b.updated_at, driver: card });
  }
  return { ...jobBasics(j), recipient: { name: j.recipient_name, phone: j.recipient_phone, isMember: !!j.recipient_user_id }, bids, orderId: j.order_id };
}

function jobBasics(j: SendJob) {
  return {
    id: j.id, status: j.status, item: j.item, description: j.description, distanceM: j.distance_m,
    pickupAfter: j.pickup_after, deliverBy: j.deliver_by, createdAt: j.created_at,
    pickup: { lat: j.pickup_lat, lng: j.pickup_lng, note: j.pickup_note }, dropoff: { lat: j.drop_lat, lng: j.drop_lng, note: j.drop_note },
  };
}

/** Rough area for drivers before they win the job (~1 km), so nobody's house is shown to every driver. */
const area = (lat: number, lng: number) => ({ lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 });

async function bidder(env: Env, driverId: string, item: string) {
  const s = await loadSettings(env.DB);
  const d = await env.DB.prepare(`SELECT d.id, v.can_bulky FROM drivers d JOIN vehicles v ON v.driver_id=d.id AND v.active=1
    WHERE d.id=?2 AND d.status='approved' AND d.deliveries_on=1 AND ${feeOkSql(s.monthly_fee_cents)}`).bind(nowIso(), driverId).first<any>();
  if (!d) throw new ApiError('NOT_ABLE_TO_BID', 403);
  if (item === 'bulky' && !d.can_bulky) throw new ApiError('VEHICLE_TOO_SMALL', 422);
}

/** Open jobs for a driver to bid on, nearest pickup first when we know where they are. */
export async function openJobs(env: Env, driverId: string, at: LatLng | null) {
  const { results } = await env.DB.prepare(`SELECT j.*, b.id AS my_bid, b.price_cents AS my_price, b.note AS my_note, b.withdrawn_at AS my_withdrawn,
      (SELECT COUNT(*) FROM send_bids x WHERE x.job_id=j.id AND x.withdrawn_at IS NULL) AS bid_count
    FROM send_jobs j LEFT JOIN send_bids b ON b.job_id=j.id AND b.driver_id=?
    WHERE j.status='open' AND j.deliver_by > ? ORDER BY j.deliver_by LIMIT 100`).bind(driverId, nowIso()).all<any>();
  const v = await env.DB.prepare('SELECT can_bulky FROM vehicles WHERE driver_id=? AND active=1').bind(driverId).first<any>();
  return (results ?? [])
    .filter((j) => j.customer_id !== driverId && (j.item !== 'bulky' || v?.can_bulky))
    .map((j) => ({
      id: j.id, item: j.item, description: j.description, distanceM: j.distance_m, pickupAfter: j.pickup_after, deliverBy: j.deliver_by,
      pickupArea: area(j.pickup_lat, j.pickup_lng), dropArea: area(j.drop_lat, j.drop_lng),
      toPickupM: at ? Math.round(haversine(at, { lat: j.pickup_lat, lng: j.pickup_lng })) : null,
      bids: j.bid_count, myBid: j.my_bid && !j.my_withdrawn ? { bidId: j.my_bid, priceCents: j.my_price, note: j.my_note } : null,
    }))
    .sort((a, b) => (a.toPickupM ?? 0) - (b.toPickupM ?? 0));
}

export async function placeBid(env: Env, driverId: string, jobId: string, priceCents: number, note: string) {
  const s = await loadSettings(env.DB);
  const j = await getJob(env, jobId);
  if (j.status !== 'open' || j.deliver_by <= nowIso()) throw new ApiError('JOB_CLOSED', 409);
  if (priceCents > s.send_bid_max_cents) throw new ApiError('PRICE_TOO_HIGH', 422, { maxCents: s.send_bid_max_cents });
  await bidder(env, driverId, j.item);
  const me = await env.DB.prepare('SELECT kiripay_user_id FROM drivers WHERE id=?').bind(driverId).first<{ kiripay_user_id: string }>();
  if (me?.kiripay_user_id === j.customer_id) throw new ApiError('YOUR_OWN_JOB', 409);
  await env.DB.prepare(`INSERT INTO send_bids (id, job_id, driver_id, price_cents, note) VALUES (?,?,?,?,?)
    ON CONFLICT(job_id, driver_id) DO UPDATE SET price_cents=excluded.price_cents, note=excluded.note, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), withdrawn_at=NULL`)
    .bind(newId('bid'), jobId, driverId, priceCents, note).run();
  return env.DB.prepare('SELECT id AS bidId, price_cents AS priceCents, note FROM send_bids WHERE job_id=? AND driver_id=?').bind(jobId, driverId).first();
}

export async function withdrawBid(env: Env, driverId: string, jobId: string) {
  await env.DB.prepare("UPDATE send_bids SET withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id=? AND driver_id=? AND withdrawn_at IS NULL").bind(jobId, driverId).run();
}

export async function cancelJob(env: Env, j: SendJob) {
  if (j.status !== 'open') throw new ApiError('JOB_CLOSED', 409);
  await env.DB.prepare("UPDATE send_jobs SET status='cancelled', closed_at=? WHERE id=? AND status='open'").bind(nowIso(), j.id).run();
}

/**
 * The sender picked a bid and has ALREADY paid exactly that price into a KiriPay hold.
 * Creates the order with that driver assigned straight away (they bid, so they agreed).
 */
export async function chooseBid(env: Env, j: SendJob, bidId: string, holdId: string, sharePhone: boolean, actor: Actor, bindHold: (orderId: string) => Promise<void>) {
  if (j.status !== 'open') throw new ApiError('JOB_CLOSED', 409);
  const bid = await env.DB.prepare('SELECT * FROM send_bids WHERE id=? AND job_id=? AND withdrawn_at IS NULL').bind(bidId, j.id).first<any>();
  if (!bid) throw new ApiError('BID_GONE', 409);
  await bidder(env, bid.driver_id, j.item);
  const id = newId('ord');
  await bindHold(id);
  // the order goes in only while the job is still open; then the job points at it (one transaction)
  const ins = await env.DB.batch([
    env.DB.prepare(`INSERT INTO orders (id, kind, service, source, source_ref, shop_id, customer_id, fallback_json, pickup_lat, pickup_lng, drop_lat, drop_lng,
      landmark, drop_note, size, distance_m, goods_cents, delivery_cents, hold_id, status, share_phone, send_job_id, deliver_by)
      SELECT ?,'delivery','delivery','kiripay_send',?,?,?,'[]',?,?,?,?,?,?,?,?,0,?,?,'PAID_HELD',?,?,?
      WHERE EXISTS (SELECT 1 FROM send_jobs WHERE id=? AND status='open') ON CONFLICT(source, source_ref, kind) DO NOTHING`)
      .bind(id, `${j.id}:${bid.id}`, SEND_SHOP, j.customer_id, j.pickup_lat, j.pickup_lng, j.drop_lat, j.drop_lng, j.pickup_note, j.drop_note,
        j.item === 'document' ? 'small' : j.item, j.distance_m, bid.price_cents, holdId, sharePhone ? 1 : 0, j.id, j.deliver_by, j.id),
    env.DB.prepare("UPDATE send_jobs SET status='chosen', order_id=?, closed_at=? WHERE id=? AND status='open' AND EXISTS (SELECT 1 FROM orders WHERE id=?)").bind(id, nowIso(), j.id, id),
  ]);
  if (!ins[0]?.meta.changes || !ins[1]?.meta.changes) throw new ApiError('JOB_CLOSED', 409);
  await eventStmt(env.DB, id, actor, 'created', { service: 'send', jobId: j.id, bidId, priceCents: bid.price_cents, holdId }).run();
  const o = await getOrder(env.DB, id);
  const next = await transition(env, o, 'DRIVER_ASSIGNED', actor, { set: { driver_id: bid.driver_id, assigned_at: nowIso() }, data: { via: 'bid' } });
  await pushToDriver(env, bid.driver_id, { type: 'send_won', orderId: id });
  return next;
}

/** At the recipient's door: handed over → paid the driver already → nothing left in the hold, so it's done. */
export async function sendDelivered(env: Env, o: OrderRow) {
  const fresh = await getOrder(env.DB, o.id);
  if (fresh.status !== 'HANDED_OVER') return fresh;
  return transition(env, fresh, 'ACCEPTED', { type: 'system', id: null }, { set: { shop_paid: 1, accepted_at: nowIso(), closed_at: nowIso() }, data: { returned: !!o.return_trip } });
}

/**
 * Nobody could take it at the drop-off: the driver did the trip, so is paid now, and brings it back to the sender.
 * The sender shows the same handoff code to get it back.
 */
export async function returnToSender(env: Env, o: OrderRow, actor: Actor, reason: string) {
  if (o.return_trip) throw new ApiError('ALREADY_RETURNING', 409);
  await payDriver(env, o);
  const fresh = await getOrder(env.DB, o.id);
  return transition(env, fresh, 'PICKED_UP', actor, {
    set: { return_trip: 1, drop_lat: o.pickup_lat, drop_lng: o.pickup_lng, drop_note: `Back to the sender. ${o.landmark}`.trim() },
    data: { returning: true, reason },
  });
}

/** The driver dropped a won job before pickup: full refund to the sender, and the job opens for bids again. */
export async function driverDropped(env: Env, o: OrderRow, actor: Actor) {
  await cancelOrder(env, o, actor, 'driver_released');
  if (o.send_job_id) {
    await env.DB.batch([
      env.DB.prepare("UPDATE send_jobs SET status='open', order_id=NULL, closed_at=NULL WHERE id=? AND deliver_by > ?").bind(o.send_job_id, nowIso()),
      env.DB.prepare("UPDATE send_bids SET withdrawn_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id=? AND driver_id=?").bind(o.send_job_id, o.driver_id),
    ]);
  }
}

/** Parcels on their way to someone who is a KiriPay member: they see the driver and their handoff code. */
export async function incoming(env: Env, userId: string) {
  const { results } = await env.DB.prepare(`SELECT o.*, j.recipient_name, j.item, j.description FROM send_jobs j JOIN orders o ON o.id=j.order_id
    WHERE j.recipient_user_id=? AND o.return_trip=0 AND (o.closed_at IS NULL OR o.closed_at > ?) ORDER BY o.created_at DESC LIMIT 20`)
    .bind(userId, new Date(Date.now() - 86400_000).toISOString()).all<any>();
  const out = [];
  for (const o of results ?? []) {
    const sender = await env.DB.prepare('SELECT first_name FROM customers WHERE id=?').bind(o.customer_id).first<{ first_name: string | null }>();
    out.push({
      id: o.id, status: o.status, item: o.item, description: o.description, deliverBy: o.deliver_by, from: sender?.first_name ?? null,
      dropoff: { lat: o.drop_lat, lng: o.drop_lng, note: o.drop_note }, driver: await driverCard(env, o.driver_id), delivered: o.status === 'ACCEPTED' || o.status === 'HANDED_OVER',
    });
  }
  return out;
}

export async function isRecipient(env: Env, orderId: string, userId: string) {
  return !!(await env.DB.prepare('SELECT 1 FROM send_jobs WHERE order_id=? AND recipient_user_id=?').bind(orderId, userId).first());
}

/** Jobs whose deadline passed with nobody chosen. */
export async function expireJobs(env: Env) {
  await env.DB.prepare("UPDATE send_jobs SET status='expired', closed_at=? WHERE status='open' AND deliver_by <= ?").bind(nowIso(), nowIso()).run();
}

export const late = (o: Pick<OrderRow, 'deliver_by' | 'status'>) => !!o.deliver_by && o.deliver_by < nowIso() && !['HANDED_OVER', 'ACCEPTED', 'CANCELLED', 'REFUNDED', 'NOT_DELIVERED'].includes(o.status);
