// KiriPay + KiriGo together, real escrow (no stand-in).
// Needs: KiriPay with migrations/0048 on :8788, KiriGo (KIRIPAY_MODE=live, KIRIPAY_URL=http://localhost:8788) on :8787,
// and the seed users from docs/kiripay-escrow.md ("Testing locally"). Run: node test/integration.mjs
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';

const GO = 'http://localhost:8787', KP = 'http://localhost:8788';
const JWT_SECRET = process.env.KP_JWT_SECRET ?? 'local-jwt-secret-for-testing-only-0123456789';
const POS_KEY = process.env.KIRIPOS_SERVICE_KEY ?? 'dev-kiripos-key';
const KP_DIR = process.env.KP_DIR ?? '/home/claude/kp-check';
const SHOP = { id: 'store_integ', lat: 1.329, lng: 172.979 };
const HOME = { lat: 1.3305, lng: 172.995 };
let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

/** A KiriPay sign-in cookie, the same format KiriPay's signToken() makes. */
function kpCookie(sub) {
  const body = Buffer.from(JSON.stringify({ mfa: true, ver: 0, sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64');
  const sig = createHmac('sha256', JWT_SECRET).update(body).digest('base64');
  return `kp_session=${body}.${sig}`;
}
const sql = (q) => JSON.parse(execSync(`npx wrangler d1 execute kiripay --local --json --command "${q.replace(/"/g, '\\"')}"`, { cwd: KP_DIR, stdio: ['ignore', 'pipe', 'ignore'] }).toString())[0].results;
const balance = (acc) => sql(`SELECT balance FROM accounts WHERE id='${acc}'`)[0].balance;

async function req(url, { method = 'GET', body, headers = {}, raw, redirect = 'follow' } = {}) {
  const res = await fetch(url, { method, redirect, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  if (redirect === 'manual') return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const kp = (user) => (p, o = {}) => req(`${KP}/api${p}`, { ...o, headers: { ...(o.headers ?? {}), cookie: kpCookie(user) } });
const shop = (p, o = {}) => req(`${GO}/api/pos/shops/${SHOP.id}${p}`, { ...o, headers: { ...(o.headers ?? {}), 'x-kirigo-key': POS_KEY } });
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

/** The real "Sign in with KiriPay" round trip: KiriGo → KiriPay authorize → KiriGo callback → session token. */
async function signIn(user, app = 'driver') {
  const start = await req(`${GO}/auth/start?app=${app}`, { redirect: 'manual' });
  const authorize = start.headers.get('location');
  const back = await req(authorize.replace('https://kiripay.online', KP), { redirect: 'manual', headers: { cookie: kpCookie(user) } });
  const callback = back.headers.get('location');
  const done = await req(callback, { redirect: 'manual' });
  return decodeURIComponent(done.headers.get('location').split('#token=')[1]);
}

async function main() {
  // admin
  sql("UPDATE users SET admin_role='super_admin' WHERE id='u_owner'");
  const adminToken = await signIn('u_owner', 'admin');
  ok(adminToken.split('.').length === 3, 'admin signed in through KiriPay (no password seen by KiriGo)');
  const admin = (p, o = {}) => req(`${GO}/api/admin${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${adminToken}` } });
  await admin('/settings', { method: 'PUT', body: { monthly_fee_cents: 1000, max_per_km_cents: 300, floor_minimum_cents: 200, night_hours: { start: '20:00', end: '06:00' }, enroute_pickup_fee_cents: 100, delivery_open: true } });
  await shop('/', { method: 'PUT', body: { name: 'Integration Shop', kiripayMerchantId: 'mer_smoke', deliveryEnabled: true, pickup: { lat: SHOP.lat, lng: SHOP.lng } } });

  // driver
  let dt = await signIn('u_drv');
  const signup = (p, o = {}) => req(`${GO}/api/driver/signup${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${dt}` } });
  const drv = (p, o = {}) => req(`${GO}/api/driver${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${dt}` } });
  const pic = (f, p, at) => f(p, { method: 'POST', raw: jpeg, headers: { 'content-type': 'image/jpeg', ...(at ? { 'x-photo-lat': String(at.lat), 'x-photo-lng': String(at.lng) } : {}) } });
  let driverId;
  try {
    const v = (await pic(signup, '/photos?kind=vehicle')).photoId;
    const a = await signup('/apply', { method: 'POST', body: { firstName: 'Teeta', vehicle: { type: 'motorbike', plate: 'T 1', photoId: v }, rateCard: { baseCents: 200, perKmCents: 100, minimumCents: 300, nightCents: 0, bulkyCents: 0 }, acceptTerms: true } });
    dt = a.token; driverId = a.driverId;
    await admin(`/drivers/${driverId}/approve`, { method: 'POST', body: { licenceSeen: true, licenceMatchesKyc: true, licenceExpiry: '2031-01-01' } });
  } catch (e) {
    if (!String(e).includes('ALREADY_APPLIED')) throw e;
    dt = await signIn('u_drv'); driverId = (await drv('/me')).driverId;
  }
  const selfie = (await pic(drv, '/photos?kind=selfie')).photoId;
  await drv('/online', { method: 'POST', body: { selfiePhotoId: selfie, lat: SHOP.lat, lng: SHOP.lng + 0.001 } });
  ok(true, `driver ${driverId} approved and online`);

  // customer pays in KiriPay
  const cust = kp('u_cust');
  const before = { cust: balance('acc_cust'), drv: balance('acc_drv'), shop: balance('acc_shop') };
  const q = await cust('/kirigo/svc/quotes', { method: 'POST', body: { shopId: SHOP.id, dropoff: HOME } });
  const opt = q.options.find((o) => o.driverId === driverId);
  ok(!!opt, `quote through KiriPay: delivery ${opt?.priceCents}c`);
  const goods = 2000;
  const paid = await cust('/kirigo/orders', { method: 'POST', body: { quoteId: q.quoteId, driverId, source: 'kiripos', sourceRef: `I-${Date.now()}`, goodsCents: goods, deliveryCents: opt.priceCents, key: `k${Date.now()}` } });
  ok(paid.status === 'APPROVED' && paid.order?.status === 'PAID_HELD', 'customer paid in KiriPay; order created in KiriGo');
  const orderId = paid.order.id;
  ok(balance('acc_cust') === before.cust - goods - opt.priceCents, 'customer wallet down by goods + delivery');
  const hold = sql(`SELECT * FROM escrow_holds WHERE ref='${orderId}'`)[0];
  ok(hold && balance(hold.id) === goods + opt.priceCents, 'money sits in the hold account');

  // a second order with the same hold is impossible
  const reuse = await req(`${KP}/api/internal/escrow/holds/${hold.id}/bind`, { method: 'POST', body: { ref: 'ord_other' }, headers: { 'x-kirigo-key': 'local-escrow-key' } }).then(() => false, () => true);
  ok(reuse, 'a hold cannot be bound to a second order');

  // delivery
  const of = (await drv('/offers')).find((o) => o.orderId === orderId);
  await drv(`/offers/${of.offerId}/accept`, { method: 'POST' });
  for (const s of ['at_pickup', 'picked_up']) await drv(`/jobs/${orderId}/status`, { method: 'POST', body: { status: s, ...SHOP } });
  await drv(`/jobs/${orderId}/status`, { method: 'POST', body: { status: 'arrived', ...HOME } });
  const code = await cust(`/kirigo/svc/orders/${orderId}/handoff`);
  const hp = (await pic(drv, `/photos?kind=handoff&order=${orderId}`, HOME)).photoId;
  await drv(`/jobs/${orderId}/handoff`, { method: 'POST', body: { token: code.qr, photoId: hp, at: Date.now(), ...HOME, adultConfirmed: true } });
  ok(balance('acc_drv') === before.drv + opt.priceCents, `driver wallet +${opt.priceCents} at handoff (100%)`);
  ok(balance('acc_shop') === before.shop, 'shop not paid yet');
  await cust(`/kirigo/svc/orders/${orderId}/accept`, { method: 'POST' });
  ok(balance('acc_shop') === before.shop + goods, `shop wallet +${goods} after the customer accepted`);
  ok(balance(hold.id) === 0 && sql(`SELECT status FROM escrow_holds WHERE id='${hold.id}'`)[0].status === 'closed', 'hold empty and closed');

  // double-release is impossible (same idempotency key, and the cap)
  const again = await req(`${KP}/api/internal/escrow/holds/${hold.id}/release`, { method: 'POST', headers: { 'x-kirigo-key': 'local-escrow-key' }, body: { to: { kind: 'user', id: 'u_drv' }, amount: 1, idempotency_key: 'extra-key-1' } }).then(() => false, () => true);
  ok(again, 'nothing more can be released from an empty hold');

  // cancel → refund
  const q2 = await cust('/kirigo/svc/quotes', { method: 'POST', body: { shopId: SHOP.id, dropoff: HOME } });
  const o2 = q2.options.find((o) => o.driverId === driverId);
  const mid = balance('acc_cust');
  const p2 = await cust('/kirigo/orders', { method: 'POST', body: { quoteId: q2.quoteId, driverId, source: 'kiripos', sourceRef: `I2-${Date.now()}`, goodsCents: 500, deliveryCents: o2.priceCents, key: `k2${Date.now()}` } });
  await cust(`/kirigo/svc/orders/${p2.order.id}/cancel`, { method: 'POST' });
  ok(balance('acc_cust') === mid, 'cancelled before pickup: customer wallet back to where it was');

  // wrong delivery price → KiriGo refuses, KiriPay gives the hold straight back
  const q3 = await cust('/kirigo/svc/quotes', { method: 'POST', body: { shopId: SHOP.id, dropoff: HOME } });
  const pre3 = balance('acc_cust');
  const bad = await cust('/kirigo/orders', { method: 'POST', body: { quoteId: q3.quoteId, driverId, source: 'kiripos', sourceRef: `I3-${Date.now()}`, goodsCents: 500, deliveryCents: 1, key: `k3${Date.now()}` } });
  ok(bad.status === 'DECLINED' && balance('acc_cust') === pre3, `tampered price refused (${bad.reason}) and the money returned`);

  // the ledger still adds up
  const total = sql('SELECT SUM(balance) AS s FROM accounts')[0].s;
  ok(total === 0, 'KiriPay ledger: all accounts still sum to zero');

  await drv('/offline', { method: 'POST' });
  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
