// Ride requests that wait for a driver. When nobody is free near the rider, they can choose "Wait for a driver":
// nothing is paid, ride drivers are alerted (offline ones are asked to go online), and the rider's app checks
// every few seconds. As soon as a driver is free nearby, the rider sees the usual list and books as normal.
import { haversine, type LatLng } from '@kirigo/shared';
import type { Env } from '../env';
import { feeOkSql } from './fees';
import { pushToDriver } from './matching';
import { makeRideQuote } from './rides';
import { loadSettings } from './settings';
import { ApiError, newId, nowIso, plusMs, takeAttempt } from './util';

export interface RideWait {
  id: string; customer_id: string; pickup_lat: number; pickup_lng: number; drop_lat: number; drop_lng: number;
  seats: number; pickup_note: string; pickup_side: string | null; status: 'waiting' | 'found' | 'booked' | 'expired' | 'cancelled';
  found_at: string | null; drivers_told: number; expires_at: string; created_at: string;
}

export async function startWait(env: Env, customerId: string, b: { pickup: LatLng; dropoff: LatLng; seats: number; pickupNote: string; pickupSide: string | null }) {
  const s = await loadSettings(env.DB);
  if (!s.rides_open) throw new ApiError('RIDES_NOT_OPEN', 503);
  // one waiting request per rider: a new one replaces the old
  await env.DB.prepare("UPDATE ride_waits SET status='cancelled' WHERE customer_id=? AND status IN ('waiting','found')").bind(customerId).run();
  const id = newId('rw');
  const expires = plusMs(s.ride_wait_min * 60_000);
  await env.DB.prepare(`INSERT INTO ride_waits (id, customer_id, pickup_lat, pickup_lng, drop_lat, drop_lng, seats, pickup_note, pickup_side, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id, customerId, b.pickup.lat, b.pickup.lng, b.dropoff.lat, b.dropoff.lng, b.seats, b.pickupNote, b.pickupSide, expires).run();
  const told = await alertRideDrivers(env, s.monthly_fee_cents, b.seats, customerId);
  await env.DB.prepare('UPDATE ride_waits SET drivers_told=? WHERE id=?').bind(told, id).run();
  return { id, status: 'waiting' as const, expiresAt: expires, driversTold: told };
}

/**
 * Tell approved ride drivers with the app that a rider is waiting. Offline drivers' positions aren't known, so on a
 * small island everyone approved hears, but each driver at most once every 10 minutes.
 */
async function alertRideDrivers(env: Env, feeCents: number | null, seats: number, customerId: string): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT DISTINCT d.id,
      (SELECT 1 FROM shifts sh WHERE sh.driver_id=d.id AND sh.offline_at IS NULL) AS online
    FROM drivers d JOIN push_tokens p ON p.driver_id=d.id
    WHERE d.status='approved' AND d.ride_status='approved' AND d.rides_on=1 AND COALESCE(d.ride_seats,0) >= ?2 AND d.kiripay_user_id <> ?3
      AND ${feeOkSql(feeCents)} LIMIT 100`).bind(nowIso(), seats, customerId).all<{ id: string; online: number | null }>();
  let n = 0;
  for (const d of results ?? []) {
    if (!(await takeAttempt(env.DB, `rider-waiting:${d.id}`, 1, 10 * 60_000))) continue;
    await pushToDriver(env, d.id, { type: 'rider_waiting', online: !!d.online });
    n++;
  }
  return n;
}

export async function getWait(env: Env, id: string, customerId: string): Promise<RideWait> {
  const w = await env.DB.prepare('SELECT * FROM ride_waits WHERE id=? AND customer_id=?').bind(id, customerId).first<RideWait>();
  if (!w) throw new ApiError('WAIT_NOT_FOUND', 404);
  return w;
}

/** The rider's app polls this. Once a driver is free nearby it returns a normal quote to book from. */
export async function checkWait(env: Env, w: RideWait) {
  const base = { id: w.id, expiresAt: w.expires_at, pickup: { lat: w.pickup_lat, lng: w.pickup_lng }, dropoff: { lat: w.drop_lat, lng: w.drop_lng }, seats: w.seats };
  if (w.status === 'waiting' && w.expires_at < nowIso()) {
    await env.DB.prepare("UPDATE ride_waits SET status='expired' WHERE id=? AND status='waiting'").bind(w.id).run();
    return { ...base, status: 'expired' as const };
  }
  if (w.status !== 'waiting' && w.status !== 'found') return { ...base, status: w.status };
  const q = await makeRideQuote(env, w.customer_id, base.pickup, base.dropoff, w.seats, 'closest');
  if (q.available) {
    await env.DB.prepare("UPDATE ride_waits SET status='found', found_at=COALESCE(found_at, ?) WHERE id=?").bind(nowIso(), w.id).run();
    return { ...base, status: 'found' as const, quote: q };
  }
  if (q.reason !== 'NO_DRIVERS_ONLINE') return { ...base, status: 'waiting' as const, reason: q.reason };
  return { ...base, status: 'waiting' as const };
}

export async function cancelWait(env: Env, w: RideWait) {
  await env.DB.prepare("UPDATE ride_waits SET status='cancelled' WHERE id=? AND status IN ('waiting','found')").bind(w.id).run();
}

/** The rider booked: close any wait they had. */
export async function closeWaits(env: Env, customerId: string) {
  await env.DB.prepare("UPDATE ride_waits SET status='booked' WHERE customer_id=? AND status IN ('waiting','found')").bind(customerId).run();
}

/** A driver just went online: if a rider nearby is waiting, tell the driver to stay online (the rider is told by their app). */
export async function driverCameOnline(env: Env, driverId: string, at: LatLng) {
  const s = await loadSettings(env.DB);
  const d = await env.DB.prepare("SELECT ride_status, rides_on FROM drivers WHERE id=?").bind(driverId).first<any>();
  if (!d || d.ride_status !== 'approved' || !d.rides_on) return 0;
  const { results } = await env.DB.prepare("SELECT pickup_lat, pickup_lng FROM ride_waits WHERE status='waiting' AND expires_at > ? LIMIT 50").bind(nowIso()).all<any>();
  const near = (results ?? []).filter((w) => haversine(at, { lat: w.pickup_lat, lng: w.pickup_lng }) <= s.pickup_radius_km * 1000).length;
  if (near) await pushToDriver(env, driverId, { type: 'rider_waiting', online: true, count: near });
  return near;
}
