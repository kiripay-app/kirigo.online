import { rateRequest, shopFaultRequest } from '@kirigo/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireKiriPos } from '../lib/auth';
import { eventStmt, getOrder, type OrderRow } from '../lib/orders';
import { notify } from '../lib/notify';
import { savePhoto } from '../lib/photos';
import { offerDiscount, returnReceived, shopFault } from '../lib/problems';
import { submitRatings } from '../lib/ratings';
import { loadSettings } from '../lib/settings';
import { orderView } from '../lib/views';
import { ApiError, body, nowIso } from '../lib/util';

/** Shop routes, called by KiriPOS's server for one shop. Mounted at /pos/shops/:shopId */
export const pos = new Hono<AppEnv>({ strict: false });
pos.use('*', requireKiriPos());

const shopId = (c: any) => c.req.param('shopId') as string;

async function ours(c: any, id: string): Promise<OrderRow> {
  const o = await getOrder(c.env.DB, id);
  if (o.shop_id !== shopId(c)) throw new ApiError('ORDER_NOT_FOUND', 404);
  return o;
}

/** KiriPOS keeps the shop's delivery settings here: on/off, pickup pin, which KiriPay merchant gets paid, minimum customer rating. */
pos.put('/', async (c) => {
  const b = await body(c, z.object({
    name: z.string().min(1).max(120),
    kiripayMerchantId: z.string().min(1).max(80),
    deliveryEnabled: z.boolean(),
    pickup: z.object({ lat: z.number(), lng: z.number() }).nullable(),
    pickupNote: z.string().max(200).default(''),
    minCustomerRating: z.number().min(1).max(5).nullable().default(null),
  }));
  if (b.deliveryEnabled && !b.pickup) throw new ApiError('PICKUP_PIN_REQUIRED', 422);
  await c.env.DB.prepare(`INSERT INTO shops (id, name, kiripay_merchant_id, pickup_lat, pickup_lng, pickup_note, delivery_enabled, min_customer_rating, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, kiripay_merchant_id=excluded.kiripay_merchant_id, pickup_lat=excluded.pickup_lat,
    pickup_lng=excluded.pickup_lng, pickup_note=excluded.pickup_note, delivery_enabled=excluded.delivery_enabled, min_customer_rating=excluded.min_customer_rating, updated_at=excluded.updated_at`)
    .bind(shopId(c), b.name, b.kiripayMerchantId, b.pickup?.lat ?? null, b.pickup?.lng ?? null, b.pickupNote, b.deliveryEnabled ? 1 : 0, b.minCustomerRating, nowIso()).run();
  return c.json({ ok: true });
});

pos.get('/orders', async (c) => {
  const status = c.req.query('open') === '1' ? "AND status NOT IN ('ACCEPTED','REFUNDED','CANCELLED','NOT_DELIVERED')" : '';
  const { results } = await c.env.DB.prepare(`SELECT * FROM orders WHERE shop_id=? ${status} ORDER BY created_at DESC LIMIT 100`).bind(shopId(c)).all<OrderRow>();
  return c.json(await Promise.all((results ?? []).map((o) => orderView(c.env, o, c.get('actor')))));
});

pos.get('/orders/:id', async (c) => c.json(await orderView(c.env, await ours(c, c.req.param('id')), c.get('actor'))));

pos.post('/orders/:id/ready', async (c) => {
  const o = await ours(c, c.req.param('id'));
  if (!['PAID_HELD', 'DRIVER_ASSIGNED', 'AT_SHOP'].includes(o.status)) throw new ApiError('NOT_WAITING', 409);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE orders SET shop_ready=1 WHERE id=?').bind(o.id),
    eventStmt(c.env.DB, o.id, c.get('actor'), 'shop:ready'),
  ]);
  await notify(c.env, { ...o, shop_ready: 1 } as OrderRow, 'shop:ready');
  return c.json({ ok: true });
});

/** Shop staff photo the driver with the package at pickup (raw image body). */
pos.post('/orders/:id/pickup-photo', async (c) => {
  const o = await ours(c, c.req.param('id'));
  if (!['AT_SHOP', 'DRIVER_ASSIGNED', 'PICKED_UP'].includes(o.status)) throw new ApiError('NOT_AT_PICKUP', 409);
  const s = await loadSettings(c.env.DB);
  const id = await savePhoto(c.env, c.get('actor'), c.req.raw, 'pickup', o.id, s.retention_photos_days);
  await c.env.DB.prepare('INSERT INTO order_events (order_id, actor_type, actor_id, type, data_json) VALUES (?,?,?,?,?)').bind(o.id, 'shop', shopId(c), 'photo:pickup', JSON.stringify({ photoId: id })).run();
  return c.json({ photoId: id }, 201);
});

/** Fault check after a problem report: Agree, or Dispute (goes to admin). */
pos.post('/orders/:id/fault', async (c) => {
  const o = await ours(c, c.req.param('id'));
  const b = await body(c, shopFaultRequest);
  await shopFault(c.env, o, c.get('actor'), b.response, b.note);
  return c.json(await orderView(c.env, await getOrder(c.env.DB, o.id), c.get('actor')));
});

pos.post('/orders/:id/discount', async (c) => {
  const o = await ours(c, c.req.param('id'));
  const b = await body(c, z.object({ cents: z.number().int().positive() }));
  await offerDiscount(c.env, o, c.get('actor'), b.cents);
  return c.json({ ok: true });
});

/** The returned item arrived (raw image body = photo of what came back). */
pos.post('/orders/:id/return-received', async (c) => {
  const child = await ours(c, c.req.param('id'));
  const s = await loadSettings(c.env.DB);
  await savePhoto(c.env, c.get('actor'), c.req.raw, 'return_receipt', child.id, s.retention_photos_days);
  await returnReceived(c.env, child, c.get('actor'));
  return c.json(await orderView(c.env, await getOrder(c.env.DB, child.parent_order_id!), c.get('actor')));
});

pos.post('/orders/:id/rate', async (c) => {
  const o = await ours(c, c.req.param('id'));
  const b = await body(c, rateRequest);
  await submitRatings(c.env, o, c.get('actor'), b.ratings as any);
  return c.json({ ok: true });
});
