import { adminRuling, DEFAULT_SETTINGS } from '@kirigo/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireAdmin } from '../lib/auth';
import { moveMoney } from '../lib/money';
import { eventStmt, getOrder, settleAccept, settleRefund } from '../lib/orders';
import { continueProblem } from '../lib/problems';
import { flagged, removeRating } from '../lib/ratings';
import { loadSettings, missingForLaunch, saveSettings } from '../lib/settings';
import { orderView } from '../lib/views';
import { photoUrl, savePhoto } from '../lib/photos';
import { keyState, testDriver } from '../lib/push';
import { ApiError, body, nowIso } from '../lib/util';

export const admin = new Hono<AppEnv>();
admin.use('*', requireAdmin());
const who = (c: any) => c.get('actor').id as string;

admin.get('/settings', async (c) => {
  const s = await loadSettings(c.env.DB);
  return c.json({ settings: s, missingForLaunch: missingForLaunch(s) });
});

admin.put('/settings', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in raw) patch[k] = raw[k];
  if (patch.delivery_open === true) {
    const missing = missingForLaunch({ ...(await loadSettings(c.env.DB)), ...patch } as any);
    if (missing.length) throw new ApiError('SET_THESE_FIRST', 422, { missing });
  }
  return c.json({ settings: await saveSettings(c.env.DB, patch as any, who(c)) });
});

// ------------------------------------------------------------------ phone alerts (Firebase)

/** Whether phone alerts are set up, and which drivers have the Android app registered. */
admin.get('/push/status', async (c) => {
  const k = await keyState(c.env);
  const { results } = await c.env.DB.prepare(`SELECT d.id, d.first_name, d.driver_code, d.status, COUNT(t.token) AS phones, MAX(t.last_seen_at) AS last_seen
    FROM push_tokens t JOIN drivers d ON d.id=t.driver_id GROUP BY d.id ORDER BY last_seen DESC LIMIT 300`).all<any>();
  return c.json({ key: k.state, projectId: k.projectId, drivers: results ?? [] });
});

/** Rings one driver's phones with a test alert and reports what happened to each phone. */
admin.post('/push/test', async (c) => {
  const b = await body(c, z.object({ driverId: z.string().min(1).max(80) }));
  const d = await c.env.DB.prepare('SELECT id, first_name, driver_code FROM drivers WHERE id=?').bind(b.driverId).first<any>();
  if (!d) throw new ApiError('NOT_FOUND', 404);
  const r = await testDriver(c.env, d.id);
  console.log('push.test', JSON.stringify({ by: who(c), driver: d.id, key: r.key, sent: r.phones.filter((p) => p.ok).length, phones: r.phones.length }));
  return c.json({ driver: d, ...r });
});

admin.get('/drivers', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  const { results } = await c.env.DB.prepare(`SELECT d.*, v.type AS vehicle_type, v.plate, v.photo_id AS vehicle_photo
    FROM drivers d LEFT JOIN vehicles v ON v.driver_id=d.id AND v.active=1 WHERE d.status=? ORDER BY d.created_at LIMIT 200`).bind(status).all<any>();
  return c.json(await Promise.all((results ?? []).map(async (d) => ({
    ...d,
    licencePhotoUrl: d.licence_photo_id ? await photoUrl(c.env, d.licence_photo_id) : null,
    facePhotoUrl: d.face_photo_id ? await photoUrl(c.env, d.face_photo_id) : null,
    vehiclePhotoUrl: d.vehicle_photo ? await photoUrl(c.env, d.vehicle_photo) : null,
  }))));
});

/**
 * Approve a driver. Admin must have SEEN the licence and confirmed it matches the person in their KiriPay ID selfie
 * (Kiribati licences can't be checked online).
 */
admin.post('/drivers/:id/approve', async (c) => {
  const b = await body(c, z.object({ licenceSeen: z.literal(true), licenceMatchesKyc: z.literal(true), licenceExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().max(300).default('') }));
  if (b.licenceExpiry < nowIso().slice(0, 10)) throw new ApiError('LICENCE_EXPIRED', 422);
  const r = await c.env.DB.prepare("UPDATE drivers SET status='approved', licence_expiry=?, licence_matches_kyc=1, review_note=?, approved_by=?, approved_at=? WHERE id=? AND status IN ('pending','suspended')")
    .bind(b.licenceExpiry, b.note, who(c), nowIso(), c.req.param('id')).run();
  if (!r.meta.changes) throw new ApiError('NOT_PENDING', 409);
  return c.json({ ok: true });
});

admin.post('/drivers/:id/:action{suspend|reject}', async (c) => {
  const b = await body(c, z.object({ note: z.string().min(3).max(300) }));
  const status = c.req.param('action') === 'suspend' ? 'suspended' : 'rejected';
  await c.env.DB.prepare('UPDATE drivers SET status=?, review_note=? WHERE id=?').bind(status, b.note, c.req.param('id')).run();
  await c.env.DB.prepare('UPDATE shifts SET offline_at=? WHERE driver_id=? AND offline_at IS NULL').bind(nowIso(), c.req.param('id')).run();
  return c.json({ ok: true });
});

/** Random recent shift selfies to compare against the KiriPay ID photo (no automatic face matching yet). */
admin.get('/selfies', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT s.id, s.driver_id, d.driver_code, d.first_name, s.online_at, s.selfie_photo_id
    FROM shifts s JOIN drivers d ON d.id=s.driver_id WHERE s.spot_checked_by IS NULL AND s.selfie_photo_id IS NOT NULL ORDER BY RANDOM() LIMIT 20`).all<any>();
  return c.json(await Promise.all((results ?? []).map(async (r) => ({ ...r, selfieUrl: await photoUrl(c.env, r.selfie_photo_id) }))));
});

admin.post('/selfies/:id', async (c) => {
  const b = await body(c, z.object({ result: z.enum(['match', 'no_match']) }));
  await c.env.DB.prepare('UPDATE shifts SET spot_checked_by=?, spot_check_result=? WHERE id=?').bind(who(c), b.result, c.req.param('id')).run();
  return c.json({ ok: true });
});

admin.get('/disputes', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM disputes WHERE ruled_at IS NULL ORDER BY due_at').all();
  return c.json(results ?? []);
});

/**
 * Rule on a dispute (or any problem). shop at fault → the normal shop-pays path; customer at fault → the shop is
 * paid (or, if the item went back, the customer pays the return trip); driver at fault → the driver's charge is
 * clawed back to the customer and the goods are refunded.
 */
admin.post('/orders/:id/rule', async (c) => {
  const b = await body(c, adminRuling);
  const p = await getOrder(c.env.DB, c.req.param('id'));
  if (p.parent_order_id) throw new ApiError('RULE_ON_THE_MAIN_ORDER', 422);
  if (p.status !== 'PROBLEM_REPORTED') throw new ApiError('NO_PROBLEM_OPEN', 409);
  const actor = c.get('actor');
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO disputes (id, order_id, reason, due_at, ruled_at, ruled_by, at_fault, ruling_json, notes) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(order_id) DO UPDATE SET ruled_at=excluded.ruled_at, ruled_by=excluded.ruled_by, at_fault=excluded.at_fault, ruling_json=excluded.ruling_json, notes=excluded.notes`)
      .bind(`dsp_${p.id}`, p.id, p.problem_reason ?? 'admin', nowIso(), nowIso(), who(c), b.atFault, JSON.stringify(b), b.note),
    c.env.DB.prepare("UPDATE orders SET shop_fault=COALESCE(shop_fault,'dispute') WHERE id=?").bind(p.id),
    eventStmt(c.env.DB, p.id, actor, 'admin:ruling', b),
  ]);
  const fresh = await getOrder(c.env.DB, p.id);
  if (b.atFault === 'driver') {
    const drv = fresh.driver_id ? await c.env.DB.prepare('SELECT kiripay_user_id FROM drivers WHERE id=?').bind(fresh.driver_id).first<{ kiripay_user_id: string }>() : null;
    if (drv) {
      await moveMoney(c.env, {
        orderId: p.id, driverId: fresh.driver_id, amount: fresh.delivery_cents, key: `${p.id}:charge:user:${drv.kiripay_user_id}:clawback`,
        reference: `KiriGo ${p.id}: delivery charge returned (damage)`,
        move: { action: 'charge', from: { kind: 'user', id: drv.kiripay_user_id }, to: { kind: 'user', id: fresh.customer_id }, toKind: 'customer' },
      });
    }
    await settleRefund(c.env, fresh, actor, { shopAtFault: false });
  } else if (fresh.problem_choice === 'keep' || b.refundGoodsCents != null) {
    // item kept: shop paid, less any partial refund the admin set (e.g. 1 of 5 items missing)
    await settleAccept(c.env, fresh, actor, { shopAtFault: false, partialRefund: b.atFault === 'shop' ? b.refundGoodsCents ?? 0 : 0 });
  } else {
    await continueProblem(c.env, p.id);
  }
  return c.json(await orderView(c.env, await getOrder(c.env.DB, p.id), actor));
});

/** Everything about one order: full event log, GPS route, all photos, money calls. */
admin.get('/orders/:id', async (c) => {
  const o = await getOrder(c.env.DB, c.req.param('id'));
  const ids = [o.id, ...((await c.env.DB.prepare('SELECT id FROM orders WHERE parent_order_id=?').bind(o.id).all<{ id: string }>()).results ?? []).map((r) => r.id)];
  const q = ids.map(() => '?').join(',');
  const [events, routes, money, ratings] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM order_events WHERE order_id IN (${q}) ORDER BY id`).bind(...ids).all(),
    c.env.DB.prepare(`SELECT * FROM order_routes WHERE order_id IN (${q})`).bind(...ids).all(),
    c.env.DB.prepare(`SELECT * FROM money_calls WHERE order_id IN (${q}) ORDER BY created_at`).bind(...ids).all(),
    c.env.DB.prepare(`SELECT * FROM ratings WHERE order_id IN (${q})`).bind(...ids).all(),
  ]);
  return c.json({ order: await orderView(c.env, o, c.get('actor')), events: events.results, routes: routes.results, money: money.results, ratings: ratings.results });
});

admin.get('/orders', async (c) => {
  const status = c.req.query('status');
  const { results } = status
    ? await c.env.DB.prepare('SELECT id, kind, status, shop_id, customer_id, driver_id, goods_cents, delivery_cents, created_at FROM orders WHERE status=? ORDER BY created_at DESC LIMIT 200').bind(status).all()
    : await c.env.DB.prepare('SELECT id, kind, status, shop_id, customer_id, driver_id, goods_cents, delivery_cents, created_at FROM orders ORDER BY created_at DESC LIMIT 200').all();
  return c.json(results ?? []);
});

admin.get('/flags', async (c) => c.json(await flagged(c.env)));

admin.post('/ratings/:id/remove', async (c) => {
  const b = await body(c, z.object({ reason: z.string().min(3).max(300) }));
  await removeRating(c.env, c.req.param('id'), who(c), b.reason);
  return c.json({ ok: true });
});

admin.post('/customers/:id/:action{restrict|unrestrict}', async (c) => {
  await c.env.DB.prepare('INSERT INTO customers (id, delivery_restricted) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET delivery_restricted=excluded.delivery_restricted')
    .bind(c.req.param('id'), c.req.param('action') === 'restrict' ? 1 : 0).run();
  return c.json({ ok: true });
});

admin.get('/money/failed', async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM money_calls WHERE status='failed' ORDER BY created_at DESC LIMIT 100").all();
  return c.json(results ?? []);
});

/** Approve a driver for rides. Needs the delivery record set in settings (default 20 deliveries, 4.3 rating) unless overridden. */
admin.post('/drivers/:id/rides/:action{approve|suspend|reject}', async (c) => {
  const b = await body(c, z.object({ roadworthyChecked: z.boolean().default(false), override: z.boolean().default(false), note: z.string().max(300).default('') }));
  const id = c.req.param('id');
  const d = await c.env.DB.prepare('SELECT * FROM drivers WHERE id=?').bind(id).first<any>();
  if (!d) throw new ApiError('NOT_FOUND', 404);
  const action = c.req.param('action');
  if (action === 'approve') {
    if (d.status !== 'approved') throw new ApiError('APPROVE_AS_DRIVER_FIRST', 409);
    if (!b.roadworthyChecked) throw new ApiError('CHECK_THE_CAR', 422);
    if (!d.face_photo_id) throw new ApiError('FACE_PHOTO_NEEDED', 422);
    const s = await loadSettings(c.env.DB);
    const record = d.deliveries >= s.ride_min_deliveries && (d.rating_count < 5 ? s.ride_min_rating <= 0 : d.rating_avg >= s.ride_min_rating);
    if (!record && !b.override) throw new ApiError('NOT_ENOUGH_RECORD', 422, { deliveries: d.deliveries, rating: d.rating_avg, need: { deliveries: s.ride_min_deliveries, rating: s.ride_min_rating } });
  }
  const status = action === 'approve' ? 'approved' : action === 'suspend' ? 'suspended' : 'rejected';
  await c.env.DB.prepare(`UPDATE drivers SET ride_status=?, ride_approved_by=?, ride_approved_at=?, rides_on=CASE WHEN ?='approved' THEN rides_on ELSE 0 END, review_note=COALESCE(NULLIF(?, ''), review_note) WHERE id=?`)
    .bind(status, who(c), nowIso(), status, b.note, id).run();
  return c.json({ ok: true });
});

/** The face cut from the driver's licence (cropped in the admin page), shown to riders before they get in. */
admin.post('/drivers/:id/face-photo', async (c) => {
  const id = c.req.param('id');
  const d = await c.env.DB.prepare('SELECT id FROM drivers WHERE id=?').bind(id).first();
  if (!d) throw new ApiError('NOT_FOUND', 404);
  const photoId = await savePhoto(c.env, c.get('actor'), c.req.raw, 'licence', null, 0);
  await c.env.DB.prepare('UPDATE drivers SET face_photo_id=? WHERE id=?').bind(photoId, id).run();
  return c.json({ ok: true, facePhotoUrl: await photoUrl(c.env, photoId) });
});

/** Riders who cancelled because the driver didn't match their photo. */
admin.get('/face-reports', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT f.*, d.first_name, d.driver_code, d.face_photo_id, d.ride_status FROM face_reports f JOIN drivers d ON d.id=f.driver_id
    WHERE f.handled_at IS NULL ORDER BY f.id DESC LIMIT 100`).all<any>();
  return c.json(await Promise.all((results ?? []).map(async (f) => ({ ...f,
    selfieUrl: f.selfie_photo_id ? await photoUrl(c.env, f.selfie_photo_id) : null,
    faceUrl: f.face_photo_id ? await photoUrl(c.env, f.face_photo_id) : null }))));
});
admin.post('/face-reports/:id/handle', async (c) => {
  const b = await body(c, z.object({ note: z.string().min(2).max(500) }));
  await c.env.DB.prepare('UPDATE face_reports SET handled_by=?, handled_at=?, note=? WHERE id=? AND handled_at IS NULL').bind(who(c), nowIso(), b.note, c.req.param('id')).run();
  return c.json({ ok: true });
});

admin.get('/rides/applications', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT d.*, v.type AS vehicle_type, v.plate, r.base_cents, r.per_km_cents, r.minimum_cents, r.wait_per_min_cents, r.cancel_cents
    FROM drivers d JOIN ride_rate_cards r ON r.driver_id=d.id LEFT JOIN vehicles v ON v.driver_id=d.id AND v.active=1 WHERE d.ride_status=? ORDER BY d.created_at`).bind(c.req.query('status') ?? 'pending').all<any>();
  return c.json(await Promise.all((results ?? []).map(async (d) => ({ ...d, roadworthyUrl: d.roadworthy_photo_id ? await photoUrl(c.env, d.roadworthy_photo_id) : null, licencePhotoUrl: d.licence_photo_id ? await photoUrl(c.env, d.licence_photo_id) : null, facePhotoUrl: d.face_photo_id ? await photoUrl(c.env, d.face_photo_id) : null }))));
});

/** Emergencies and trip alerts not yet handled, emergencies first, with the trip and its live state. */
admin.get('/alerts', async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT a.*, o.status, o.customer_id, o.driver_id, o.pickup_lat, o.pickup_lng, o.drop_lat, o.drop_lng
    FROM trip_alerts a JOIN orders o ON o.id=a.order_id WHERE a.handled_at IS NULL
    ORDER BY CASE a.kind WHEN 'emergency' THEN 0 ELSE 1 END, a.id DESC LIMIT 100`).all<any>();
  return c.json(results ?? []);
});

admin.post('/alerts/:id/handle', async (c) => {
  const b = await body(c, z.object({ note: z.string().min(2).max(500) }));
  await c.env.DB.prepare('UPDATE trip_alerts SET handled_by=?, handled_at=?, note=? WHERE id=? AND handled_at IS NULL').bind(who(c), nowIso(), b.note, c.req.param('id')).run();
  return c.json({ ok: true });
});

admin.get('/debts', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM shop_debts WHERE settled_cents < amount_cents ORDER BY created_at').all();
  return c.json(results ?? []);
});
