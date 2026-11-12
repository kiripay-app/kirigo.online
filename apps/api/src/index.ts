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

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; " +
  "img-src 'self' data: blob: https:; connect-src 'self' wss: https:; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; " +
  "form-action 'self'; frame-ancestors 'none'";

// www.kirigo.online → kirigo.online (one address for links, sign-in and app stores)
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname === 'www.kirigo.online') {
    url.hostname = 'kirigo.online';
    return c.redirect(url.toString(), 301);
  }
  await next();
  const h = new Headers(c.res.headers);   // pages come from the static-assets binding, whose headers can't be changed in place
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'no-referrer');
  h.set('x-frame-options', 'DENY');
  h.set('permissions-policy', 'camera=(self), geolocation=(self), microphone=(), payment=()');
  // Scripts only from kirigo.online itself, so injected text can never run as code. Pictures, map tiles, Google Fonts and the
  // live-tracking sockets keep working. Map tiles and photos are same-site; data:/blob: cover camera snapshots and Leaflet.
  // The Android driver app loads /driver/ and its native bridge may add a small inline script, so those pages also allow inline
  // scripts (still none from other sites).
  if (!c.req.path.startsWith('/tiles/') && !c.req.path.startsWith('/p/'))
    h.set('content-security-policy', c.req.path.startsWith('/driver') ? CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") : CSP);
  if (url.protocol === 'https:') h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  // API answers are personal (orders, earnings, locations): never stored by the phone or anything in between.
  // (The year-long caching of the hashed app files is in apps/web/public/_headers.)
  if (c.req.path.startsWith('/api/') && !h.has('cache-control')) h.set('cache-control', 'no-store');
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers: h });
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

/** Map tiles of South Tarawa (PMTiles in R2), supports range requests. Open map data, so any site (the KiriPay app) may read it. */
const TILE_CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range, content-length, etag', 'access-control-allow-headers': 'range, if-match', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400' };
app.options('/tiles/:file', (c) => new Response(null, { status: 204, headers: TILE_CORS }));
app.get('/tiles/:file', async (c) => {
  const range = c.req.header('range');
  const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
  const obj = await c.env.TILES.get(c.req.param('file'), m ? { range: { offset: Number(m[1]), length: m[2] ? Number(m[2]) - Number(m[1]) + 1 : undefined } } : undefined);
  if (!obj) return new Response('not found', { status: 404, headers: TILE_CORS });
  const h = new Headers({ 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=86400', 'accept-ranges': 'bytes', etag: obj.httpEtag, ...TILE_CORS });
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
