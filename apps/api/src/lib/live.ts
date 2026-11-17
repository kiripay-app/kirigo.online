import type { Context, Next } from 'hono';
import type { AppEnv, Env } from '../env';
import { ApiError, MIN, nowIso, plusMs } from './util';

/**
 * Live operations map for admins.
 *
 * Where the positions come from: drivers' phones already report their position while online (for matching) and
 * every 10–15 s during a job. The Durable Object `DriverPresence` keeps the latest one in memory. This module only
 * READS that. Nothing here saves an idle driver's position, so there is no trail of where a driver went while merely
 * online. A trip's saved route (accept → handed over) is the same as before.
 */

/** KiriPay's top admin role. ('super' is the mock sign-in used in local development.) */
export const isSuper = (role: string | null | undefined) => role === 'super_admin' || role === 'super';

const ACTIVE = ['DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ARRIVED'];
const RECENT_MIN = 30;       // finished and cancelled trips stay on the board this long
const STALE_S = 180;         // same limit the matcher uses: older than this and the driver isn't offered jobs

type Admin = { id: string; role: string };

/** Remembers who has signed in to the admin, so the super admin has a list to switch on. */
export async function touchAdmin(env: Env, id: string, name: string, role: string) {
  await env.DB.prepare(`INSERT INTO admin_access (user_id, name, role) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET name=excluded.name, role=excluded.role, last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .bind(id, name.slice(0, 60), role.slice(0, 40)).run();
}

export async function canSeeLive(env: Env, a: Admin): Promise<boolean> {
  if (isSuper(a.role)) return true;
  const r = await env.DB.prepare('SELECT live_map FROM admin_access WHERE user_id=?').bind(a.id).first<{ live_map: number }>();
  return r?.live_map === 1;
}

/** Checked on every request, so switching someone off takes effect straight away (their sign-in lasts 4 hours). */
export function requireLiveMap() {
  return async (c: Context<AppEnv>, next: Next) => {
    const a = c.get('actor');
    if (a.type !== 'admin' || !(await canSeeLive(c.env, a))) throw new ApiError('LIVE_MAP_NOT_ALLOWED', 403);
    await next();
  };
}

export async function logLive(env: Env, a: Admin, action: string, detail = '', name = '') {
  await env.DB.prepare('INSERT INTO live_map_log (user_id, name, action, detail) VALUES (?,?,?,?)').bind(a.id, name.slice(0, 60), action, detail.slice(0, 200)).run();
}

/** One "view" line per admin per 30 minutes: who looked at the live map, without a line for every refresh. */
export async function logViewOnce(env: Env, a: Admin) {
  const seen = await env.DB.prepare("SELECT 1 FROM live_map_log WHERE user_id=? AND action='view' AND at > ? LIMIT 1").bind(a.id, plusMs(-30 * MIN)).first();
  if (!seen) {
    const n = await env.DB.prepare('SELECT name FROM admin_access WHERE user_id=?').bind(a.id).first<{ name: string }>();
    await logLive(env, a, 'view', '', n?.name ?? '');
  }
}

export interface LiveDriver {
  id: string; name: string; code: string; vehicle: string | null; plate: string | null;
  rating: number | null; ratingCount: number; onlineAt: string;
  lat: number | null; lng: number | null; ageS: number | null; stale: boolean;
  /** free = online with no job; offered = a customer picked them and they haven't answered; busy = on a job */
  state: 'free' | 'offered' | 'busy';
  tripId: string | null;
  deliveries: boolean; rides: boolean;
}

export async function liveSnapshot(env: Env) {
  const now = Date.now();
  const cutoff = plusMs(-RECENT_MIN * MIN, now);
  const ph = ACTIVE.map(() => '?').join(',');

  const [shifts, trips, presence] = await Promise.all([
    env.DB.prepare(`SELECT s.driver_id, s.online_at, d.first_name, d.driver_code, d.rating_avg, d.rating_count, d.deliveries_on, d.rides_on, v.type AS vehicle, v.plate
      FROM shifts s JOIN drivers d ON d.id=s.driver_id LEFT JOIN vehicles v ON v.driver_id=d.id AND v.active=1
      WHERE s.offline_at IS NULL AND d.status='approved' LIMIT 500`).all<any>(),
    env.DB.prepare(`SELECT o.id, o.parent_order_id, o.kind, o.service, o.seats, o.status, o.shop_id, sh.name AS shop_name, cu.first_name AS customer_name,
        o.driver_id, o.offer_driver_id, o.offer_expires_at, o.pickup_lat, o.pickup_lng, o.drop_lat, o.drop_lng, o.landmark, o.distance_m, o.delivery_cents,
        o.created_at, o.assigned_at, o.at_pickup_at, o.picked_up_at, o.handed_over_at, o.closed_at, o.emergency_at
      FROM orders o JOIN shops sh ON sh.id=o.shop_id LEFT JOIN customers cu ON cu.id=o.customer_id
      WHERE o.status='PAID_HELD' OR o.status IN (${ph}) OR COALESCE(o.handed_over_at, o.closed_at, o.created_at) > ?
      ORDER BY o.created_at DESC LIMIT 200`).bind(...ACTIVE, cutoff).all<any>(),
    env.DRIVER_PRESENCE.get(env.DRIVER_PRESENCE.idFromName('tarawa')).fetch('https://do/all').then((r) => r.json<any[]>()).catch(() => []),
  ]);

  const pos = new Map<string, { lat: number; lng: number; at: number }>();
  for (const p of presence) pos.set(p.driverId, p);

  const onJob = new Map<string, string>();       // driver → the trip they are on
  const offered = new Map<string, string>();     // driver → the trip waiting for their answer
  for (const t of trips.results ?? []) {
    if (ACTIVE.includes(t.status) && t.driver_id) onJob.set(t.driver_id, t.id);
    if (t.status === 'PAID_HELD' && t.offer_driver_id && (!t.offer_expires_at || t.offer_expires_at > nowIso())) offered.set(t.offer_driver_id, t.id);
  }

  const drivers: LiveDriver[] = (shifts.results ?? []).map((s) => {
    const p = pos.get(s.driver_id);
    const ageS = p ? Math.max(0, Math.round((now - p.at) / 1000)) : null;
    const state = onJob.has(s.driver_id) ? 'busy' : offered.has(s.driver_id) ? 'offered' : 'free';
    return {
      id: s.driver_id, name: s.first_name, code: s.driver_code, vehicle: s.vehicle ?? null, plate: s.plate ?? null,
      rating: s.rating_count >= 5 ? s.rating_avg : null, ratingCount: s.rating_count, onlineAt: s.online_at,
      lat: p?.lat ?? null, lng: p?.lng ?? null, ageS, stale: ageS == null || ageS > STALE_S,
      state, tripId: onJob.get(s.driver_id) ?? offered.get(s.driver_id) ?? null, deliveries: !!s.deliveries_on, rides: !!s.rides_on,
    };
  });
  drivers.sort((a, b) => a.code.localeCompare(b.code));

  // the driver a customer picked: the one on the job, or the one still being asked
  const known = new Map(drivers.map((d) => [d.id, d]));
  const missing = [...new Set((trips.results ?? []).map((t) => t.driver_id ?? t.offer_driver_id).filter((id) => id && !known.has(id)))] as string[];
  const other = new Map<string, any>();
  if (missing.length) {
    const { results } = await env.DB.prepare(`SELECT id, first_name, driver_code FROM drivers WHERE id IN (${missing.map(() => '?').join(',')})`).bind(...missing).all<any>();
    for (const r of results ?? []) other.set(r.id, r);
  }

  const out = (trips.results ?? []).map((t) => {
    const did = t.driver_id ?? t.offer_driver_id ?? null;
    const dv = did ? known.get(did) : null;
    const od = did ? other.get(did) : null;
    return {
      id: t.id, parentId: t.parent_order_id, kind: t.kind, service: t.service as 'delivery' | 'ride', seats: t.seats, status: t.status,
      shop: t.shop_name, customer: t.customer_name || null, landmark: t.landmark || null, distanceM: t.distance_m, deliveryCents: t.delivery_cents,
      pickup: { lat: t.pickup_lat, lng: t.pickup_lng }, drop: { lat: t.drop_lat, lng: t.drop_lng },
      driver: did ? { id: did, name: dv?.name ?? od?.first_name ?? '', code: dv?.code ?? od?.driver_code ?? '', accepted: !!t.driver_id, online: !!dv } : null,
      createdAt: t.created_at, assignedAt: t.assigned_at, atPickupAt: t.at_pickup_at, pickedUpAt: t.picked_up_at, handedOverAt: t.handed_over_at, closedAt: t.closed_at,
      emergency: !!t.emergency_at,
      phase: t.status === 'PAID_HELD' ? 'waiting' : ACTIVE.includes(t.status) ? 'active' : 'done',
    };
  });

  return {
    now: new Date(now).toISOString(),
    staleAfterS: STALE_S,
    counts: {
      online: drivers.length, free: drivers.filter((d) => d.state === 'free').length, busy: drivers.filter((d) => d.state === 'busy').length,
      waiting: out.filter((t) => t.phase === 'waiting').length, active: out.filter((t) => t.phase === 'active').length,
    },
    drivers, trips: out,
  };
}

/** The route driven so far on one trip: from the live tracker, or the saved route once the trip has ended. */
export async function tripRoute(env: Env, orderId: string): Promise<{ points: { lat: number; lng: number; at: number }[]; live: boolean }> {
  const o = await env.DB.prepare('SELECT id, parent_order_id FROM orders WHERE id=?').bind(orderId).first<{ id: string; parent_order_id: string | null }>();
  if (!o) throw new ApiError('NOT_FOUND', 404);
  const stub = env.ORDER_TRACKER.get(env.ORDER_TRACKER.idFromName(o.parent_order_id ?? o.id));
  const live = await stub.fetch(`https://do/route?orderId=${encodeURIComponent(o.id)}`).then((r) => r.json<any[]>()).catch(() => []);
  if (live.length) return { points: thin(live), live: true };
  const saved = await env.DB.prepare('SELECT points_json FROM order_routes WHERE order_id=?').bind(o.id).first<{ points_json: string }>();
  return { points: thin(saved ? JSON.parse(saved.points_json) : []), live: false };
}

/** Keep the picture light: at most ~400 points, always including the last one. */
function thin<T>(pts: T[], max = 400): T[] {
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]!);
  out.push(pts[pts.length - 1]!);
  return out;
}
