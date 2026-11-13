import { displayRating, RIDE_LABEL, SEND_LABEL, STATUS_LABEL } from '@kirigo/shared';
import type { Actor, Env } from '../env';
import type { OrderRow } from './orders';
import { canSeePhoto, photoUrl, type PhotoKind } from './photos';

const LABEL_BY_KIND: Record<string, Partial<Record<string, string>>> = {
  return: { PAID_HELD: 'Return: choose a driver', DRIVER_ASSIGNED: 'Return: driver coming to collect', PICKED_UP: 'Return: on the way to the shop', HANDED_OVER: 'Return: dropped at the shop', ACCEPTED: 'Return received by the shop' },
  correction: { PAID_HELD: 'Correct item: choose a driver' },
};

export async function driverCard(env: Env, driverId: string | null) {
  if (!driverId) return null;
  const d = await env.DB.prepare(`SELECT d.id, d.driver_code, d.first_name, d.rating_avg, d.rating_count, d.deliveries, v.type, v.plate, v.photo_id, v.colour
    FROM drivers d LEFT JOIN vehicles v ON v.driver_id=d.id AND v.active=1 WHERE d.id=?`).bind(driverId).first<any>();
  if (!d) return null;
  return {
    driverId: d.id, driverCode: d.driver_code, firstName: d.first_name, verified: true,
    rating: displayRating(d.rating_avg, d.rating_count), deliveries: d.deliveries,
    vehicle: { type: d.type, plate: d.plate, colour: d.colour || '', photoUrl: d.photo_id ? await photoUrl(env, d.photo_id) : null },
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
    id: o.id, kind: o.kind, service: o.service, parentOrderId: o.parent_order_id, status: o.status,
    label: o.service === 'ride' ? RIDE_LABEL[o.status] : o.send_job_id ? (o.return_trip && o.status !== 'ACCEPTED' ? 'Coming back to you' : o.return_trip ? 'Returned to you' : SEND_LABEL[o.status]) : LABEL_BY_KIND[o.kind]?.[o.status] ?? STATUS_LABEL[o.status],
    send: o.send_job_id ? await sendBlock(env, o, viewer) : undefined,
    ride: o.service === 'ride' ? {
      seats: o.seats, fareCents: o.delivery_cents, bufferCents: o.goods_cents, waitingCents: o.waiting_cents,
      pickup: driverMayLocate ? { lat: o.pickup_lat, lng: o.pickup_lng, note: o.landmark } : { area: approxArea(o.pickup_lat, o.pickup_lng) },
      dropNote: o.drop_note, etaS: o.eta_s, emergency: !!o.emergency_at,
      sharingWith: viewer.type === 'customer' ? ((await env.DB.prepare('SELECT COUNT(*) AS n FROM trip_buddies WHERE order_id=? AND stopped_at IS NULL').bind(o.id).first<{ n: number }>())?.n ?? 0) : undefined,
      sharing: viewer.type === 'driver' ? !!(await env.DB.prepare('SELECT 1 FROM trip_buddies WHERE order_id=? AND stopped_at IS NULL').bind(o.id).first()) : undefined,
      faceCheck: viewer.type === 'customer' && o.driver_id && ['DRIVER_ASSIGNED', 'AT_SHOP'].includes(o.status) ? await faceUrls(env, o.driver_id) : undefined,
    } : undefined,
    // easier pickups: which side of the road, and when the driver tapped "I'm here"
    sides: { pickup: o.pickup_side ?? null, dropoff: o.drop_side ?? null },
    here: o.here_at ? { at: o.here_at } : null,
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

/** KiriGo Send details: the recipient (name and phone go to the driver only once they have the job), item, time frame. */
async function sendBlock(env: Env, o: OrderRow, viewer: Actor) {
  const j = await env.DB.prepare('SELECT item, description, recipient_name, recipient_phone, pickup_after, deliver_by, pickup_note FROM send_jobs WHERE id=?').bind(o.send_job_id).first<any>();
  if (!j) return null;
  const mayKnow = viewer.type !== 'driver' || o.driver_id === viewer.id;
  return {
    item: j.item, description: j.description, pickupAfter: j.pickup_after, deliverBy: j.deliver_by, returning: !!o.return_trip,
    late: !!o.deliver_by && o.deliver_by < new Date().toISOString() && !['HANDED_OVER', 'ACCEPTED', 'CANCELLED', 'REFUNDED', 'NOT_DELIVERED'].includes(o.status),
    recipient: mayKnow ? { name: j.recipient_name, phone: j.recipient_phone } : null,
    pickupNote: j.pickup_note,
  };
}

/** For the rider before boarding: today's selfie beside the face photo the KiriGo team approved (signed links, 10 minutes). */
async function faceUrls(env: Env, driverId: string) {
  const { faceCheck } = await import('./rides');
  const { faceId, selfieId } = await faceCheck(env, driverId);
  return { approvedUrl: faceId ? await photoUrl(env, faceId) : null, todayUrl: selfieId ? await photoUrl(env, selfieId) : null };
}
