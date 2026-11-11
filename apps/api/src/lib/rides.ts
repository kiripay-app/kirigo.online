import {
  displayRating, haversine, inKiWindow, positionOnRoad, priceRide, roadDistance, waitingCharge, type LatLng, type Settings,
} from '@kirigo/shared';
import type { Actor, Env } from '../env';
import { feeOkSql } from './fees';
import { onlineNear, pushToDriver, road, sortOptions, type QuoteOption } from './matching';
import { moveMoney } from './money';
import { notify } from './notify';
import { eventStmt, getOrder, payDriver, transition, type OrderRow } from './orders';
import { loadSettings } from './settings';
import { ApiError, newId, nowIso, plusMs } from './util';

/**
 * Rides: a passenger trip is an order with service = 'ride'.
 *   delivery_cents = the fare (100% to the driver at drop-off)
 *   goods_cents    = a small refundable buffer held with it, for waiting time or a late-cancel / no-show fee
 * Both are paid up front into one KiriPay hold, exactly like a delivery.
 */
export const RIDE_SHOP = 'kirigo-rides';
const SYSTEM: Actor = { type: 'system', id: null };

export interface RideOption extends QuoteOption { seats: number; colour?: string }

/** Drivers approved for rides, switched on for rides, free, near the pickup, with enough seats, priced on their ride card. */
export async function priceRideDrivers(env: Env, s: Settings, pickup: LatLng, distanceM: number, seats: number, excludeDriver?: string | null): Promise<RideOption[]> {
  const near = await onlineNear(env, pickup, s.pickup_radius_km);
  const ids = near.map((n) => n.driverId).filter((id) => id !== excludeDriver);
  if (!ids.length) return [];
  const now = nowIso();
  const qs = ids.map((_, i) => `?${i + 2}`).join(',');
  const { results } = await env.DB.prepare(`
    SELECT d.id, d.driver_code, d.first_name, d.rating_avg, d.rating_count, d.deliveries, d.ride_seats,
           v.type AS v_type, v.plate, v.photo_id,
           r.base_cents, r.per_km_cents, r.minimum_cents, r.night_cents, r.wait_per_min_cents, r.cancel_cents,
           (SELECT COUNT(*) FROM orders o WHERE o.driver_id=d.id AND o.status IN ('DRIVER_ASSIGNED','AT_SHOP','PICKED_UP','ARRIVED')) AS busy
    FROM drivers d JOIN ride_rate_cards r ON r.driver_id=d.id
    JOIN vehicles v ON v.driver_id=d.id AND v.active=1
    WHERE d.status='approved' AND d.ride_status='approved' AND d.rides_on=1 AND ${feeOkSql(s.monthly_fee_cents)}
      AND d.id IN (${qs})`).bind(now, ...ids).all<any>();
  const night = s.night_hours ? inKiWindow(Date.now(), s.night_hours.start, s.night_hours.end) : false;
  const byId = new Map(near.map((n) => [n.driverId, n]));
  const out: RideOption[] = [];
  for (const d of results ?? []) {
    if (d.busy > 0 || (d.ride_seats ?? 0) < seats) continue;
    const pos = byId.get(d.id)!;
    const toPickup = Math.round(haversine(pos, pickup));
    out.push({
      driverId: d.id, driverCode: d.driver_code, firstName: d.first_name, photoId: d.photo_id,
      vehicle: { type: d.v_type, plate: d.plate }, verified: true, seats: d.ride_seats,
      rating: displayRating(d.rating_avg, d.rating_count), deliveries: d.deliveries,
      priceCents: priceRide({ baseCents: d.base_cents, perKmCents: d.per_km_cents, minimumCents: d.minimum_cents, nightCents: d.night_cents, waitPerMinCents: d.wait_per_min_cents, cancelCents: d.cancel_cents }, distanceM, night, s),
      etaMin: Math.max(2, Math.round((toPickup / 1000 / 25) * 60) + 2),
      distanceToShopM: toPickup,
    });
  }
  return out;
}

export async function makeRideQuote(env: Env, customerId: string, pickup: LatLng, dropoff: LatLng, seats: number, sort: 'closest' | 'cheapest' | 'top_rated') {
  const s = await loadSettings(env.DB);
  if (!s.rides_open) return { available: false, reason: 'RIDES_NOT_OPEN', options: [] };
  const cust = await env.DB.prepare('SELECT delivery_restricted FROM customers WHERE id=?').bind(customerId).first<any>();
  if (cust?.delivery_restricted) return { available: false, reason: 'CUSTOMER_RESTRICTED', options: [] };
  const distanceM = roadDistance(pickup, dropoff, road(env));
  if (distanceM < 100) return { available: false, reason: 'TOO_SHORT', options: [] };
  const all = await priceRideDrivers(env, s, pickup, distanceM, seats);
  const options = sortOptions(all, sort, s.drivers_shown);
  if (!options.length) return { available: false, reason: 'NO_DRIVERS_ONLINE', options: [] };
  const id = newId('q');
  await env.DB.prepare('INSERT INTO quotes (id, customer_id, shop_id, drop_lat, drop_lng, size, distance_m, options_json, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, customerId, RIDE_SHOP, dropoff.lat, dropoff.lng, `seats:${seats}|${pickup.lat},${pickup.lng}`, distanceM, JSON.stringify(all), plusMs(s.quote_valid_min * 60_000)).run();
  return { available: true, quoteId: id, distanceM, bufferCents: s.ride_buffer_cents, options, expiresInMin: s.quote_valid_min };
}

async function rideCard(env: Env, driverId: string) {
  const r = await env.DB.prepare('SELECT * FROM ride_rate_cards WHERE driver_id=?').bind(driverId).first<any>();
  if (!r) throw new ApiError('NO_RIDE_PRICES', 409);
  return r;
}

/** Give back what's left of the hold to the rider. */
async function refundRest(env: Env, o: OrderRow, tag: string) {
  const fresh = await getOrder(env.DB, o.id);
  const paidOut = (fresh.driver_paid ? fresh.delivery_cents : 0) + fresh.waiting_cents + fresh.extra_cost_cents;
  const left = fresh.delivery_cents + fresh.goods_cents - paidOut;
  if (left > 0) {
    const r = await moveMoney(env, { orderId: o.id, amount: left, key: `${o.id}:refund:${tag}`, reference: `KiriGo ride ${o.id}: refund`, move: { action: 'refund', holdId: o.hold_id! } });
    if (!r.ok) throw new ApiError('REFUND_FAILED', 502, { code: r.code });
  }
  return Math.max(0, left);
}

/** Pay the driver an extra amount from the buffer (waiting time, cancel or no-show fee). Recorded in extra_cost_cents/waiting_cents. */
async function payFromBuffer(env: Env, o: OrderRow, amount: number, what: 'waiting' | 'cancel' | 'noshow') {
  if (amount <= 0 || !o.driver_id) return 0;
  const d = await env.DB.prepare('SELECT kiripay_user_id FROM drivers WHERE id=?').bind(o.driver_id).first<{ kiripay_user_id: string }>();
  const pay = Math.min(amount, o.goods_cents);
  const r = await moveMoney(env, {
    orderId: o.id, driverId: o.driver_id, amount: pay, key: `${o.id}:release:driver-${what}`, reference: `KiriGo ride ${o.id}: ${what}`,
    move: { action: 'release', holdId: o.hold_id!, to: { kind: 'user', id: d!.kiripay_user_id }, toKind: 'driver' },
  });
  if (!r.ok) throw new ApiError('PAYOUT_FAILED', 502, { code: r.code });
  const col = what === 'waiting' ? 'waiting_cents' : 'extra_cost_cents';
  await env.DB.prepare(`UPDATE orders SET ${col}=? WHERE id=?`).bind(pay, o.id).run();
  return pay;
}

/** Rider boards: boarding code checked by the caller. Waiting time is worked out now. */
export async function board(env: Env, o: OrderRow, actor: Actor, at: LatLng) {
  const s = await loadSettings(env.DB);
  const rc = await rideCard(env, o.driver_id!);
  const waiting = o.at_pickup_at ? waitingCharge(Date.parse(o.at_pickup_at), Date.now(), s.ride_free_wait_min, rc.wait_per_min_cents, o.goods_cents) : 0;
  const etaS = Math.round((o.distance_m / 1000 / 25) * 3600) + 120;
  const next = await transition(env, o, 'PICKED_UP', actor, { at, set: { picked_up_at: nowIso(), eta_s: etaS }, data: { waitingCents: waiting } });
  if (waiting > 0) await payFromBuffer(env, next, waiting, 'waiting');
  return getOrder(env.DB, o.id);
}

/** Drop-off: fare (100%) and any waiting already paid to the driver; the rest of the buffer back to the rider. */
export async function endRide(env: Env, o: OrderRow, actor: Actor, at: LatLng) {
  if (o.status === 'PICKED_UP') o = await transition(env, o, 'ARRIVED', actor, { at, data: { auto: true } });
  if (o.status !== 'ARRIVED') throw new ApiError('NOT_ON_A_RIDE', 409);
  const near = haversine(at, { lat: o.drop_lat, lng: o.drop_lng });
  const next = await transition(env, o, 'HANDED_OVER', actor, { at, set: { handed_over_at: nowIso() }, data: { metresFromDestination: Math.round(near) } });
  await payDriver(env, next);
  const refunded = await refundRest(env, next, 'end');
  const done = await transition(env, await getOrder(env.DB, o.id), 'ACCEPTED', SYSTEM, { set: { accepted_at: nowIso(), closed_at: nowIso() }, data: { refundCents: refunded } });
  await finishSharing(env, done);
  const stub = env.ORDER_TRACKER.get(env.ORDER_TRACKER.idFromName(o.id));
  await stub.fetch('https://do/finish', { method: 'POST', body: JSON.stringify({ orderId: o.id }) }).catch(() => {});
  return done;
}

/**
 * Rider cancels. Free before a driver accepts, or within the free minutes after booking; after that the driver
 * gets their cancellation fee from the buffer and the rest comes back.
 */
export async function cancelRide(env: Env, o: OrderRow, actor: Actor) {
  if (!['PAID_HELD', 'DRIVER_ASSIGNED', 'AT_SHOP'].includes(o.status)) throw new ApiError('TOO_LATE_TO_CANCEL', 409);
  const s = await loadSettings(env.DB);
  await env.DB.prepare("UPDATE offers SET result='withdrawn' WHERE order_id=? AND result IS NULL").bind(o.id).run();
  let fee = 0;
  const late = Date.now() - Date.parse(o.created_at) > s.ride_free_cancel_min * 60_000;
  if (o.driver_id && late) {
    const rc = await rideCard(env, o.driver_id);
    fee = await payFromBuffer(env, o, rc.cancel_cents, 'cancel');
  }
  await refundRest(env, o, 'cancel');
  const done = await transition(env, await getOrder(env.DB, o.id), 'CANCELLED', actor, { set: { closed_at: nowIso() }, data: { feeCents: fee } });
  await finishSharing(env, done);
  return done;
}

/** Driver waited at the pickup and the rider never came: the driver gets the cancellation fee. */
export async function noShow(env: Env, o: OrderRow, actor: Actor, at: LatLng) {
  if (o.status !== 'AT_SHOP' || !o.at_pickup_at) throw new ApiError('NOT_AT_PICKUP', 409);
  const s = await loadSettings(env.DB);
  if (Date.now() - Date.parse(o.at_pickup_at) < s.ride_noshow_wait_min * 60_000) throw new ApiError('WAIT_A_LITTLE_LONGER', 409, { minutes: s.ride_noshow_wait_min });
  const rc = await rideCard(env, o.driver_id!);
  const fee = await payFromBuffer(env, o, rc.cancel_cents, 'noshow');
  await refundRest(env, o, 'noshow');
  const done = await transition(env, await getOrder(env.DB, o.id), 'NOT_DELIVERED', actor, { at, set: { closed_at: nowIso() }, data: { reason: 'no_show', feeCents: fee } });
  await finishSharing(env, done);
  return done;
}

// ------------------------------------------------------------------ Trip buddies

export async function addBuddies(env: Env, o: OrderRow, userIds: string[]) {
  const ids = [...new Set(userIds)].filter((u) => u !== o.customer_id).slice(0, 5);
  if (!ids.length) return;
  await env.DB.batch([
    ...ids.map((u) => env.DB.prepare('INSERT INTO trip_buddies (order_id, user_id) VALUES (?,?) ON CONFLICT(order_id, user_id) DO UPDATE SET stopped_at=NULL').bind(o.id, u)),
    eventStmt(env.DB, o.id, { type: 'customer', id: o.customer_id }, 'buddies:added', { count: ids.length }),
  ]);
  await notify(env, o, 'buddies:added');
}

export async function stopSharing(env: Env, o: OrderRow) {
  await env.DB.batch([
    env.DB.prepare('UPDATE trip_buddies SET stopped_at=? WHERE order_id=? AND stopped_at IS NULL').bind(nowIso(), o.id),
    eventStmt(env.DB, o.id, { type: 'customer', id: o.customer_id }, 'buddies:stopped'),
  ]);
}

/** When a trip ends, buddies keep seeing it (with "Arrived safely") for a short while. */
async function finishSharing(env: Env, o: OrderRow) {
  const s = await loadSettings(env.DB);
  await env.DB.prepare('UPDATE trip_buddies SET until=? WHERE order_id=? AND until IS NULL').bind(plusMs(s.buddy_after_min * 60_000), o.id).run();
  await notify(env, o, o.status === 'ACCEPTED' ? 'ride:arrived_safely' : `ride:${o.status.toLowerCase()}`);
}

export async function buddyIds(env: Env, orderId: string): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT user_id FROM trip_buddies WHERE order_id=? AND stopped_at IS NULL').bind(orderId).all<{ user_id: string }>();
  return (results ?? []).map((r) => r.user_id);
}

/** Trips a KiriPay member is following right now. */
export async function following(env: Env, userId: string) {
  const now = nowIso();
  const { results } = await env.DB.prepare(`SELECT o.* FROM trip_buddies b JOIN orders o ON o.id=b.order_id
    WHERE b.user_id=? AND b.stopped_at IS NULL AND (b.until IS NULL OR b.until > ?) ORDER BY o.created_at DESC LIMIT 10`).bind(userId, now).all<OrderRow>();
  return results ?? [];
}

export async function isBuddy(env: Env, orderId: string, userId: string) {
  const r = await env.DB.prepare('SELECT 1 FROM trip_buddies WHERE order_id=? AND user_id=? AND stopped_at IS NULL AND (until IS NULL OR until > ?)').bind(orderId, userId, nowIso()).first();
  return !!r;
}

// ------------------------------------------------------------------ alerts and emergencies

async function raise(env: Env, o: OrderRow, kind: 'off_route' | 'long_stop' | 'overtime' | 'emergency', by: string, at: LatLng | null) {
  // one alert of each kind per 10 minutes, except emergencies which always go through
  if (kind !== 'emergency') {
    const recent = await env.DB.prepare('SELECT 1 FROM trip_alerts WHERE order_id=? AND kind=? AND at > ?').bind(o.id, kind, new Date(Date.now() - 10 * 60_000).toISOString()).first();
    if (recent) return;
  }
  await env.DB.batch([
    env.DB.prepare('INSERT INTO trip_alerts (order_id, kind, raised_by, lat, lng) VALUES (?,?,?,?,?)').bind(o.id, kind, by, at?.lat ?? null, at?.lng ?? null),
    eventStmt(env.DB, o.id, by === 'system' || by === 'buddy' ? SYSTEM : ({ type: by as 'customer' | 'driver', id: by === 'customer' ? o.customer_id : o.driver_id } as Actor), `alert:${kind}`, { by }, at),
    ...(kind === 'emergency' ? [env.DB.prepare('UPDATE orders SET emergency_at=COALESCE(emergency_at, ?) WHERE id=?').bind(nowIso(), o.id)] : []),
  ]);
  await notify(env, o, `alert:${kind}`);
}

export async function emergency(env: Env, o: OrderRow, by: 'customer' | 'driver' | 'buddy', at: LatLng | null) {
  if (!['PAID_HELD', 'DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ARRIVED'].includes(o.status)) throw new ApiError('NOT_ACTIVE', 409);
  await raise(env, o, 'emergency', by, at);
}

/**
 * Checked on every GPS batch during a ride: far off the road line (off route), or not moving for a while
 * away from the destination (long stop). Overtime is checked by the cron job.
 */
export async function watchRide(env: Env, o: OrderRow, p: LatLng) {
  if (o.service !== 'ride' || o.status !== 'PICKED_UP') return;
  const s = await loadSettings(env.DB);
  const r = road(env);
  if (r && positionOnRoad(p, r).offset > s.alert_offroute_m) await raise(env, o, 'off_route', 'system', p);
  const w = await env.DB.prepare('SELECT * FROM trip_watch WHERE order_id=?').bind(o.id).first<any>();
  const now = nowIso();
  if (!w || haversine(w, p) > 40) {
    await env.DB.prepare('INSERT INTO trip_watch (order_id, lat, lng, still_since, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, still_since=excluded.still_since, updated_at=excluded.updated_at')
      .bind(o.id, p.lat, p.lng, now, now).run();
    return;
  }
  await env.DB.prepare('UPDATE trip_watch SET updated_at=? WHERE order_id=?').bind(now, o.id).run();
  const stillMin = (Date.now() - Date.parse(w.still_since)) / 60_000;
  const farFromEnd = haversine(p, { lat: o.drop_lat, lng: o.drop_lng }) > 300;
  if (stillMin >= s.alert_stop_min && farFromEnd) await raise(env, o, 'long_stop', 'system', p);
}

/** Cron: rides running well past their expected time. */
export async function overtimeCheck(env: Env) {
  const s = await loadSettings(env.DB);
  const { results } = await env.DB.prepare("SELECT * FROM orders WHERE service='ride' AND status='PICKED_UP' AND eta_s IS NOT NULL").all<OrderRow>();
  for (const o of results ?? []) {
    const elapsed = (Date.now() - Date.parse(o.picked_up_at!)) / 1000;
    if (elapsed > (o.eta_s ?? 0) * s.alert_overtime_factor + 300) await raise(env, o, 'overtime', 'system', null);
  }
}

export async function alertsFor(env: Env, orderId: string) {
  const { results } = await env.DB.prepare('SELECT kind, raised_by, at, lat, lng, handled_at FROM trip_alerts WHERE order_id=? ORDER BY id').bind(orderId).all();
  return results ?? [];
}

// ---------------------------------------------------------------- face check before boarding

/** Today's shift selfie and the face the KiriGo team cut from the licence, for the rider to compare before getting in. */
export async function faceCheck(env: Env, driverId: string) {
  const d = await env.DB.prepare('SELECT face_photo_id FROM drivers WHERE id=?').bind(driverId).first<{ face_photo_id: string | null }>();
  const sh = await env.DB.prepare('SELECT selfie_photo_id FROM shifts WHERE driver_id=? AND offline_at IS NULL ORDER BY online_at DESC LIMIT 1').bind(driverId).first<{ selfie_photo_id: string | null }>();
  return { faceId: d?.face_photo_id ?? null, selfieId: sh?.selfie_photo_id ?? null };
}

/**
 * The rider says the driver doesn't look like their approved photo, or today's selfie is too unclear to tell.
 * Free cancel: every cent back, the driver gets nothing, the team is told. Enough reports in a short time pause
 * the driver's rides until the team has looked.
 */
export async function faceMismatch(env: Env, o: OrderRow, actor: Actor, reason: 'no_match' | 'unclear' | 'no_photo') {
  if (o.service !== 'ride') throw new ApiError('NOT_A_RIDE', 409);
  if (!o.driver_id || !['DRIVER_ASSIGNED', 'AT_SHOP'].includes(o.status)) throw new ApiError('TOO_LATE_TO_CANCEL', 409);
  const s = await loadSettings(env.DB);
  const { selfieId } = await faceCheck(env, o.driver_id);
  await env.DB.prepare("UPDATE offers SET result='withdrawn' WHERE order_id=? AND result IS NULL").bind(o.id).run();
  await refundRest(env, o, 'face');
  const done = await transition(env, await getOrder(env.DB, o.id), 'CANCELLED', actor, { set: { closed_at: nowIso() }, data: { reason: `face_${reason}`, feeCents: 0 } });
  await finishSharing(env, done);
  const since = new Date(Date.now() - s.face_reports_days * 86400_000).toISOString();
  const prior = await env.DB.prepare('SELECT COUNT(*) AS n FROM face_reports WHERE driver_id=? AND at > ?').bind(o.driver_id, since).first<{ n: number }>();
  const pause = (prior?.n ?? 0) + 1 >= s.face_reports_to_pause;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO face_reports (order_id, driver_id, rider_id, reason, selfie_photo_id, paused_driver) VALUES (?,?,?,?,?,?)').bind(o.id, o.driver_id, o.customer_id, reason, selfieId, pause ? 1 : 0),
    ...(pause ? [env.DB.prepare("UPDATE drivers SET ride_status='suspended', rides_on=0, review_note='Rides paused: riders said the driver did not match their photo' WHERE id=? AND ride_status='approved'").bind(o.driver_id)] : []),
  ]);
  await pushToDriver(env, o.driver_id, { type: 'ride_cancelled', orderId: o.id, why: 'face_check', ridesPaused: pause });
  return done;
}
