import { displayRating, STATUS_LABEL } from '@kirigo/shared';
import type { Actor, Env } from '../env';
import type { OrderRow } from './orders';
import { canSeePhoto, photoUrl, type PhotoKind } from './photos';

const LABEL_BY_KIND: Record<string, Partial<Record<string, string>>> = {
  return: { PAID_HELD: 'Return: choose a driver', DRIVER_ASSIGNED: 'Return: driver coming to collect', PICKED_UP: 'Return: on the way to the shop', HANDED_OVER: 'Return: dropped at the shop', ACCEPTED: 'Return received by the shop' },
  correction: { PAID_HELD: 'Correct item: choose a driver' },
};

export async function driverCard(env: Env, driverId: string | null) {
  if (!driverId) return null;
  const d = await env.DB.prepare(`SELECT d.id, d.driver_code, d.first_name, d.rating_avg, d.rating_count, d.deliveries, v.type, v.plate, v.photo_id
    FROM drivers d LEFT JOIN vehicles v ON v.driver_id=d.id AND v.active=1 WHERE d.id=?`).bind(driverId).first<any>();
  if (!d) return null;
  return {
    driverId: d.id, driverCode: d.driver_code, firstName: d.first_name, verified: true,
    rating: displayRating(d.rating_avg, d.rating_count), deliveries: d.deliveries,
    vehicle: { type: d.type, plate: d.plate, photoUrl: d.photo_id ? await photoUrl(env, d.photo_id) : null },
  };
}

/** What each side may see of an order. Customer pins are shown to a driver only after they accept. */
export async function orderView(env: Env, o: OrderRow, viewer: Actor) {
  const { results: photos } = await env.DB.prepare('SELECT id, kind, taken_at FROM photos WHERE order_id=? AND deleted_at IS NULL').bind(o.id).all<{ id: string; kind: PhotoKind; taken_at: string }>();
  const visible = [];
  for (const p of photos ?? []) if (canSeePhoto(p.kind, viewer.type)) visible.push({ kind: p.kind, takenAt: p.taken_at, url: await photoUrl(env, p.id) });
  const { results: children } = await env.DB.prepare('SELECT id, kind, status, driver_id, delivery_cents FROM orders WHERE parent_order_id=? ORDER BY created_at').bind(o.id).all<any>();
  const driverMayLocate = viewer.type !== 'driver' || (o.driver_id === viewer.id && o.status !== 'PAID_HELD');
  const shop = await env.DB.prepare('SELECT name, pickup_lat, pickup_lng, pickup_note FROM shops WHERE id=?').bind(o.shop_id).first<any>();
  let customerPhone: string | null = null;
  void customerPhone;
  return {
    id: o.id, kind: o.kind, parentOrderId: o.parent_order_id, status: o.status,
    label: LABEL_BY_KIND[o.kind]?.[o.status] ?? STATUS_LABEL[o.status],
    source: o.source, sourceRef: o.source_ref,
    shop: { id: o.shop_id, name: shop?.name ?? '', pickup: { lat: o.pickup_lat, lng: o.pickup_lng }, note: shop?.pickup_note ?? '' },
    dropoff: driverMayLocate ? { lat: o.drop_lat, lng: o.drop_lng, landmark: o.landmark } : { area: approxArea(o.drop_lat, o.drop_lng) },
    distanceM: o.distance_m, size: o.size,
    goodsCents: viewer.type === 'driver' ? undefined : o.goods_cents,
    deliveryCents: o.delivery_cents,
    driver: await driverCard(env, o.driver_id),
    sharePhone: !!o.share_phone,
    shopReady: !!o.shop_ready,
    paid: { driver: !!o.driver_paid, shop: !!o.shop_paid },
    problem: o.problem_reason ? { reason: o.problem_reason, choice: o.problem_choice, shopFault: o.shop_fault, discountOfferCents: o.discount_offer_cents, discountCents: o.discount_cents } : null,
    children: (children ?? []).map((c) => ({ id: c.id, kind: c.kind, status: c.status, label: LABEL_BY_KIND[c.kind]?.[c.status] ?? STATUS_LABEL[c.status as keyof typeof STATUS_LABEL], hasDriver: !!c.driver_id })),
    photos: visible,
    times: { created: o.created_at, assigned: o.assigned_at, pickedUp: o.picked_up_at, handedOver: o.handed_over_at, accepted: o.accepted_at, closed: o.closed_at },
  };
}

/** Rough area for drivers before they accept: rounded to ~1 km so the exact house isn't revealed. */
function approxArea(lat: number, lng: number) {
  return { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 };
}
