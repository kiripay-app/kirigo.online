import {
  displayRating, haversine, inKiWindow, priceDelivery, roadDistance, type LatLng, type Road, type Settings, type Size,
} from '@kirigo/shared';
import type { Env } from '../env';
import { feeOkSql } from './fees';
import { alertFor, sendToDriver } from './push';
import { eventStmt, getOrder, type OrderRow } from './orders';
import { notify } from './notify';
import { loadSettings } from './settings';
import { ApiError, newId, nowIso, plusMs } from './util';

let roadCache: { src: string; road: Road | null } | null = null;
export function road(env: Env): Road | null {
  const src = env.ROAD_GEOJSON ?? '';
  if (roadCache?.src === src) return roadCache.road;
  let r: Road | null = null;
  try {
    const g = src ? JSON.parse(src) : null;
    const coords = g?.type === 'LineString' ? g.coordinates : g?.geometry?.type === 'LineString' ? g.geometry.coordinates : null;
    if (Array.isArray(coords) && coords.length >= 2) r = coords as Road;
  } catch { r = null; }
  roadCache = { src, road: r };
  return r;
}

export interface PresenceDriver { driverId: string; lat: number; lng: number; at: number; prevLat?: number; prevLng?: number }

export async function onlineNear(env: Env, at: LatLng, radiusKm: number): Promise<PresenceDriver[]> {
  const stub = env.DRIVER_PRESENCE.get(env.DRIVER_PRESENCE.idFromName('tarawa'));
  const res = await stub.fetch(`https://do/near?lat=${at.lat}&lng=${at.lng}&km=${radiusKm}`);
  return res.ok ? ((await res.json()) as PresenceDriver[]) : [];
}

/** Tells a driver: instantly over the open app's live connection, and as a phone alert if they use the Android app. */
export async function pushToDriver(env: Env, driverId: string, msg: any) {
  const stub = env.DRIVER_PRESENCE.get(env.DRIVER_PRESENCE.idFromName('tarawa'));
  await stub.fetch('https://do/push', { method: 'POST', body: JSON.stringify({ driverId, msg }) }).catch(() => {});
  const alert = alertFor(msg);
  if (alert) await sendToDriver(env, driverId, alert);
}

export interface QuoteOption {
  driverId: string; driverCode: string; firstName: string; photoId: string | null;
  vehicle: { type: string; plate: string }; verified: boolean;
  rating: string; deliveries: number; priceCents: number; etaMin: number; distanceToShopM: number;
}


/** Drivers who can take a trip from `from`, with their price for `distanceM`. */
export async function priceDrivers(env: Env, s: Settings, from: LatLng, distanceM: number, size: Size, excludeDriver?: string | null): Promise<QuoteOption[]> {
  const near = await onlineNear(env, from, s.pickup_radius_km);
  if (!near.length) return [];
  const ids = near.map((n) => n.driverId).filter((id) => id !== excludeDriver);
  if (!ids.length) return [];
  const now = nowIso();
  const qs = ids.map((_, i) => `?${i + 2}`).join(',');
  const { results } = await env.DB.prepare(`
    SELECT d.id, d.driver_code, d.first_name, d.rating_avg, d.rating_count, d.deliveries,
           v.type AS v_type, v.plate, v.can_bulky, v.photo_id,
           r.base_cents, r.per_km_cents, r.minimum_cents, r.night_cents, r.bulky_cents,
           (SELECT COUNT(*) FROM orders o WHERE o.driver_id=d.id AND o.status IN ('DRIVER_ASSIGNED','AT_SHOP','PICKED_UP','ARRIVED') AND o.kind <> 'enroute') AS busy
    FROM drivers d JOIN rate_cards r ON r.driver_id=d.id
    JOIN vehicles v ON v.driver_id=d.id AND v.active=1
    WHERE d.status='approved' AND d.deliveries_on=1 AND ${feeOkSql(s.monthly_fee_cents)} AND d.id IN (${qs})`).bind(now, ...ids).all<any>();
  const night = s.night_hours ? inKiWindow(Date.now(), s.night_hours.start, s.night_hours.end) : false;
  const byId = new Map(near.map((n) => [n.driverId, n]));
  const out: QuoteOption[] = [];
  for (const d of results ?? []) {
    if (d.busy > 0) continue;
    if (size === 'bulky' && !d.can_bulky) continue;
    const pos = byId.get(d.id)!;
    const toShop = Math.round(haversine(pos, from));
    out.push({
      driverId: d.id, driverCode: d.driver_code, firstName: d.first_name, photoId: d.photo_id,
      vehicle: { type: d.v_type, plate: d.plate }, verified: true,
      rating: displayRating(d.rating_avg, d.rating_count), deliveries: d.deliveries,
      priceCents: priceDelivery(
        { baseCents: d.base_cents, perKmCents: d.per_km_cents, minimumCents: d.minimum_cents, nightCents: d.night_cents, bulkyCents: d.bulky_cents },
        distanceM, { night, size }, s,
      ),
      // ~25 km/h around Tarawa, plus a couple of minutes to get going
      etaMin: Math.max(2, Math.round((toShop / 1000 / 25) * 60) + 2),
      distanceToShopM: toShop,
    });
  }
  return out;
}

export function sortOptions(opts: QuoteOption[], sort: 'closest' | 'cheapest' | 'top_rated', limit: number): QuoteOption[] {
  const r = (o: QuoteOption) => (o.rating === 'New' ? 0 : Number(o.rating));
  const cmp = sort === 'cheapest' ? (a: QuoteOption, b: QuoteOption) => a.priceCents - b.priceCents || a.distanceToShopM - b.distanceToShopM
    : sort === 'top_rated' ? (a: QuoteOption, b: QuoteOption) => r(b) - r(a) || a.distanceToShopM - b.distanceToShopM
    : (a: QuoteOption, b: QuoteOption) => a.distanceToShopM - b.distanceToShopM;
  return [...opts].sort(cmp).slice(0, limit);
}

export async function makeQuote(env: Env, customerId: string, shopId: string, dropoff: LatLng, size: Size, sort: 'closest' | 'cheapest' | 'top_rated') {
  const s = await loadSettings(env.DB);
  if (!s.delivery_open) return { deliveryAvailable: false, reason: 'DELIVERY_NOT_OPEN', options: [] };
  const shop = await env.DB.prepare('SELECT * FROM shops WHERE id=?').bind(shopId).first<any>();
  if (!shop || !shop.delivery_enabled || shop.pickup_lat == null) return { deliveryAvailable: false, reason: 'SHOP_NO_DELIVERY', options: [] };
  const cust = await env.DB.prepare('SELECT rating_avg, rating_count, delivery_restricted FROM customers WHERE id=?').bind(customerId).first<any>();
  if (cust?.delivery_restricted) return { deliveryAvailable: false, reason: 'CUSTOMER_RESTRICTED', options: [] };
  if (shop.min_customer_rating != null && cust && cust.rating_count >= 5 && cust.rating_avg < shop.min_customer_rating) {
    return { deliveryAvailable: false, reason: 'BELOW_SHOP_MINIMUM', options: [] };
  }
  const from = { lat: shop.pickup_lat, lng: shop.pickup_lng };
  const distanceM = roadDistance(from, dropoff, road(env));
  const all = await priceDrivers(env, s, from, distanceM, size);
  const options = sortOptions(all, sort, s.drivers_shown);
  if (!options.length) return { deliveryAvailable: false, reason: 'NO_DRIVERS_ONLINE', options: [] };
  const id = newId('q');
  await env.DB.prepare('INSERT INTO quotes (id, customer_id, shop_id, drop_lat, drop_lng, size, distance_m, options_json, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, customerId, shopId, dropoff.lat, dropoff.lng, size, distanceM, JSON.stringify(all), plusMs(s.quote_valid_min * 60_000)).run();
  return { deliveryAvailable: true, quoteId: id, distanceM, options, expiresInMin: s.quote_valid_min };
}

// ------------------------------------------------------------------ offers (60-second accept window)

export async function offer(env: Env, o: OrderRow, driverId: string, priceCents: number) {
  const s = await loadSettings(env.DB);
  const id = newId('of');
  const exp = plusMs(s.accept_window_s * 1000);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO offers (id, order_id, driver_id, kind, price_cents, expires_at) VALUES (?,?,?,?,?,?)').bind(id, o.id, driverId, 'primary', priceCents, exp),
    env.DB.prepare('UPDATE orders SET offer_driver_id=?, offer_expires_at=? WHERE id=?').bind(driverId, exp, o.id),
    eventStmt(env.DB, o.id, { type: 'system', id: null }, 'offer:sent', { driverId, priceCents }),
  ]);
  await pushToDriver(env, driverId, { type: 'offer', offerId: id, orderId: o.id, expiresAt: exp, kind: o.service === 'ride' ? 'ride' : 'delivery' });
}

/**
 * The offered driver declined or let it time out: offer the customer's next choice. The price may differ;
 * a cheaper driver means the difference goes back to the customer, a dearer one needs their OK (the
 * KiriPay app asks), so automatic fallback only uses drivers at or below the price paid.
 */
export async function nextDriver(env: Env, orderId: string, why: 'declined' | 'expired' | 'dropped') {
  const o = await getOrder(env.DB, orderId);
  if (o.status !== 'PAID_HELD') return;
  const queue: { driverId: string; priceCents: number }[] = JSON.parse(o.fallback_json || '[]');
  let next = queue.shift();
  while (next && next.priceCents > o.delivery_cents) next = queue.shift();
  await env.DB.prepare('UPDATE orders SET fallback_json=?, offer_driver_id=NULL, offer_expires_at=NULL WHERE id=?').bind(JSON.stringify(queue), o.id).run();
  if (next) {
    await offer(env, { ...o, fallback_json: JSON.stringify(queue) }, next.driverId, next.priceCents);
  } else {
    await env.DB.prepare('INSERT INTO order_events (order_id, actor_type, type, data_json) VALUES (?,?,?,?)').bind(o.id, 'system', 'offer:none_left', JSON.stringify({ why })).run();
    await notify(env, o, 'need_driver');
  }
}

export async function expireOffers(env: Env): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id, order_id FROM offers WHERE result IS NULL AND expires_at < ?").bind(nowIso()).all<{ id: string; order_id: string }>();
  for (const of of results ?? []) {
    const r = await env.DB.prepare("UPDATE offers SET result='expired' WHERE id=? AND result IS NULL").bind(of.id).run();
    if (r.meta.changes) await nextDriver(env, of.order_id, 'expired');
  }
  return results?.length ?? 0;
}

export function assertOpen(s: Settings) {
  if (!s.delivery_open) throw new ApiError('DELIVERY_NOT_OPEN', 503);
}
