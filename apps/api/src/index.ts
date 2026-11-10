import { Hono } from 'hono';
import { InvalidTransitionError } from '@kirigo/shared';
import type { AppEnv, Env } from './env';
import { runCron } from './cron';
import { readTicket } from './lib/handoff';
import { checkPhotoUrl } from './lib/photos';
import { ApiError } from './lib/util';
import { admin } from './routes/admin';
import { auth } from './routes/auth';
import { driver } from './routes/driver';
import { pos } from './routes/pos';
import { svc } from './routes/svc';

export { OrderTracker } from './do/OrderTracker';
export { DriverPresence } from './do/DriverPresence';

const app = new Hono<AppEnv>({ strict: false });

app.use('*', async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  c.header('x-frame-options', 'DENY');
});

app.get('/api/health', (c) => c.json({ ok: true, service: 'kirigo', mode: c.env.KIRIPAY_MODE ?? 'live' }));

/** The driver app needs the handoff public key to check customers' QR codes offline. */
app.get('/api/handoff-key', (c) => c.json({ publicKey: c.env.HANDOFF_PUBLIC_KEY }));

app.route('/api/svc', svc);
app.route('/api/pos/shops/:shopId', pos);
app.route('/api/driver', driver);
app.route('/api/admin', admin);
app.route('/auth', auth);

/** Private photos, through short-lived signed links only. */
app.get('/p/:id', async (c) => {
  const id = c.req.param('id');
  if (!(await checkPhotoUrl(c.env, id, c.req.query('e') ?? '0', c.req.query('s') ?? ''))) return c.text('link expired', 403);
  const row = await c.env.DB.prepare('SELECT r2_key FROM photos WHERE id=? AND deleted_at IS NULL').bind(id).first<{ r2_key: string }>();
  const obj = row ? await c.env.PHOTOS.get(row.r2_key) : null;
  if (!obj) return c.text('not found', 404);
  return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType ?? 'image/jpeg', 'cache-control': 'private, max-age=600' } });
});

/** Map tiles of South Tarawa (PMTiles in R2), supports range requests. */
app.get('/tiles/:file', async (c) => {
  const range = c.req.header('range');
  const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
  const obj = await c.env.TILES.get(c.req.param('file'), m ? { range: { offset: Number(m[1]), length: m[2] ? Number(m[2]) - Number(m[1]) + 1 : undefined } } : undefined);
  if (!obj) return c.text('not found', 404);
  const h = new Headers({ 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=86400', 'accept-ranges': 'bytes' });
  if (m && 'range' in obj && obj.range) {
    const r = obj.range as { offset: number; length: number };
    h.set('content-range', `bytes ${r.offset}-${r.offset + r.length - 1}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers: h });
  }
  return new Response(obj.body, { headers: h });
});

/** Live tracking socket for one order (customer, shop or driver), with a ticket from their own API. */
app.get('/ws/orders/:id', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.text('expected websocket', 426);
  const t = await readTicket(c.env, c.req.query('ticket') ?? '');
  if (!t || t.orderId !== c.req.param('id')) return c.text('bad ticket', 403);
  const stub = c.env.ORDER_TRACKER.get(c.env.ORDER_TRACKER.idFromName(t.orderId));
  return stub.fetch(`https://do/socket?who=${encodeURIComponent(t.who)}`, c.req.raw);
});

/** Driver's socket: offers are pushed here the moment they are made. */
app.get('/ws/driver', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.text('expected websocket', 426);
  const t = await readTicket(c.env, c.req.query('ticket') ?? '');
  if (!t || t.orderId !== 'driver') return c.text('bad ticket', 403);
  const stub = c.env.DRIVER_PRESENCE.get(c.env.DRIVER_PRESENCE.idFromName('tarawa'));
  return stub.fetch(`https://do/socket?driver=${encodeURIComponent(t.who)}`, c.req.raw);
});

app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'NOT_FOUND' }, 404) : c.env.ASSETS.fetch(c.req.raw)));

app.onError((e, c) => {
  if (e instanceof ApiError) return c.json({ error: e.code, ...e.extra }, e.status as any);
  if (e instanceof InvalidTransitionError) return c.json({ error: 'WRONG_STATUS', from: e.from, to: e.to }, 409);
  console.error(e);
  return c.json({ error: 'SERVER_ERROR' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env, new Date(ev.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
