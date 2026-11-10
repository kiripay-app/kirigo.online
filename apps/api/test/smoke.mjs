// End-to-end check against a local `npm run dev` (KIRIPAY_MODE=mock).
//   npm run dev        (in one terminal)
//   npm run smoke      (in another)
// Walks a full delivery, a return with a refund, and a correction, and checks every cent.
import { ed25519 } from '@noble/curves/ed25519';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const KP = process.env.KIRIPAY_SERVICE_KEY ?? 'dev-kiripay-key';
const POS = process.env.KIRIPOS_SERVICE_KEY ?? 'dev-kiripos-key';
const SHOP = { id: 'store_smoke', lat: 1.3290, lng: 172.9790 };    // Bairiki-ish
const HOME = { lat: 1.3500, lng: 173.0400 };                         // a customer pin
const run = Date.now().toString(36);
const CUSTOMER = `u_cust_${run}`;
const DRIVER_USER = `u_drv_${run}`;

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails++; };

async function call(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const cust = (p, o = {}) => call(`/api/svc${p}`, { ...o, headers: { ...(o.headers ?? {}), 'x-kirigo-key': KP, 'x-kirigo-user': CUSTOMER } });
const shop = (p, o = {}) => call(`/api/pos/shops/${SHOP.id}${p}`, { ...o, headers: { ...(o.headers ?? {}), 'x-kirigo-key': POS } });
let driverToken = '';
const drv = (p, o = {}) => call(`/api/driver${p}`, { ...o, headers: { authorization: `Bearer ${driverToken}`, ...(o.headers ?? {}) } });
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const photo = (who, path, at) => who(path, { method: 'POST', raw: jpeg, headers: { 'content-type': 'image/jpeg', ...(at ? { 'x-photo-lat': String(at.lat), 'x-photo-lng': String(at.lng), 'x-photo-at': String(Date.now()) } : {}) } });
const moves = async () => (await call('/api/admin/orders?status=ACCEPTED', { headers: { authorization: `Bearer ${adminToken}` } }));
let adminToken = '';

async function main() {
  // --- admin opens the service
  adminToken = (await call('/auth/dev?user=u_admin&admin=1')).token;
  const admin = (p, o = {}) => call(`/api/admin${p}`, { ...o, headers: { authorization: `Bearer ${adminToken}` } });
  await admin('/settings', { method: 'PUT', body: { monthly_fee_cents: null, delivery_open: false } });
  const blocked = await admin('/settings', { method: 'PUT', body: { delivery_open: true } }).then(() => false, () => true);
  ok(blocked, 'cannot open delivery while launch settings are blank');
  await admin('/settings', { method: 'PUT', body: { monthly_fee_cents: 1000, max_per_km_cents: 300, floor_minimum_cents: 200, night_hours: { start: '20:00', end: '06:00' }, enroute_pickup_fee_cents: 100, delivery_open: true } });
  ok(true, 'admin set launch settings and opened delivery');

  // --- KiriPOS registers the shop
  await shop('/', { method: 'PUT', body: { name: 'Smoke Shop', kiripayMerchantId: 'mer_smoke', deliveryEnabled: true, pickup: { lat: SHOP.lat, lng: SHOP.lng }, pickupNote: 'blue door' } });
  ok(true, 'shop registered with delivery on');

  // --- a driver signs up and is approved
  driverToken = (await call(`/auth/dev?user=${DRIVER_USER}&name=Teeta`)).token;
  const vehiclePhoto = (await photo((p, o) => call(`/api/driver/signup${p}`, { ...o, headers: { ...o.headers, authorization: `Bearer ${driverToken}` } }), '/photos?kind=vehicle')).photoId;
  const licencePhoto = (await photo((p, o) => call(`/api/driver/signup${p}`, { ...o, headers: { ...o.headers, authorization: `Bearer ${driverToken}` } }), '/photos?kind=licence')).photoId;
  const applied = await call('/api/driver/signup/apply', { method: 'POST', headers: { authorization: `Bearer ${driverToken}` }, body: {
    firstName: 'Teeta', vehicle: { type: 'motorbike', plate: 'T 1234', canBulky: false, photoId: vehiclePhoto }, licencePhotoId: licencePhoto,
    rateCard: { baseCents: 200, perKmCents: 100, minimumCents: 300, nightCents: 0, bulkyCents: 0 }, acceptTerms: true,
  } });
  driverToken = applied.token;
  ok(/^KG-\d{4}$/.test(applied.driverCode), `driver applied as ${applied.driverCode}`);
  const pending = await admin('/drivers?status=pending');
  ok(pending.some((d) => d.id === applied.driverId), 'driver waits for approval');
  await admin(`/drivers/${applied.driverId}/approve`, { method: 'POST', body: { licenceSeen: true, licenceMatchesKyc: true, licenceExpiry: '2030-01-01' } });
  const selfie = (await photo(drv, '/photos?kind=selfie')).photoId;
  await drv('/online', { method: 'POST', body: { selfiePhotoId: selfie, lat: SHOP.lat + 0.002, lng: SHOP.lng } });
  ok((await drv('/me')).online, 'driver approved and online near the shop');

  // --- happy path
  const q = await cust('/quotes', { method: 'POST', body: { shopId: SHOP.id, dropoff: HOME, size: 'small' } });
  const mineOpt = (qq) => qq.options.find((o) => o.driverId === applied.driverId);
  ok(q.deliveryAvailable && !!mineOpt(q), `quote: ${q.options.length} driver(s) online, ${q.distanceM} m by road`);
  const opt = mineOpt(q);
  const goods = 2500;
  const total = goods + opt.priceCents;
  const { holdId } = await cust('/dev/hold', { method: 'POST', body: { amountCents: total } });
  const wrongHold = await cust('/orders', { method: 'POST', body: { quoteId: q.quoteId, driverId: opt.driverId, source: 'kiripos', sourceRef: `R1-${run}`, goodsCents: goods + 1, holdId } }).then(() => false, () => true);
  ok(wrongHold, 'order refused when the hold is not exactly goods + delivery');
  const order = await cust('/orders', { method: 'POST', body: { quoteId: q.quoteId, driverId: opt.driverId, source: 'kiripos', sourceRef: `R1-${run}`, goodsCents: goods, holdId, landmark: 'behind the church' } });
  ok(order.status === 'PAID_HELD', `order ${order.id}: paid, held by KiriPay`);

  const offers = await drv('/offers');
  ok(offers.length === 1 && offers[0].orderId === order.id, 'driver got the offer');
  ok(offers[0].dropArea && !offers[0].dropArea.landmark, 'exact pin hidden before accepting');
  await drv(`/offers/${offers[0].offerId}/accept`, { method: 'POST' });
  await shop(`/orders/${order.id}/ready`, { method: 'POST' });
  await drv(`/jobs/${order.id}/status`, { method: 'POST', body: { status: 'at_pickup', ...SHOP } });
  await photo(shop, `/orders/${order.id}/pickup-photo`);
  await drv(`/jobs/${order.id}/gps`, { method: 'POST', body: { points: [{ lat: SHOP.lat, lng: SHOP.lng, at: Date.now() }, { lat: 1.34, lng: 173.0, at: Date.now() + 1000 }] } });
  await drv(`/jobs/${order.id}/status`, { method: 'POST', body: { status: 'picked_up', ...SHOP } });
  await drv(`/jobs/${order.id}/status`, { method: 'POST', body: { status: 'arrived', ...HOME } });

  const hand = await cust(`/orders/${order.id}/handoff`);
  const pub = (await call('/api/handoff-key')).publicKey;
  const [, b64body, sig] = hand.qr.split('.');
  const verified = ed25519.verify(Buffer.from(sig, 'base64url'), new TextEncoder().encode(b64body), Buffer.from(pub, 'base64url'));
  ok(verified, 'customer QR verifies with only the public key (offline check)');
  const hp = (await photo(drv, `/photos?kind=handoff&order=${order.id}`, HOME)).photoId;
  const badCode = await drv(`/jobs/${order.id}/handoff`, { method: 'POST', body: { code: hand.code === '0000' ? '0001' : '0000', photoId: hp, at: Date.now(), ...HOME, adultConfirmed: true } }).then(() => false, () => true);
  ok(badCode, 'wrong 4-digit code refused');
  const after = await drv(`/jobs/${order.id}/handoff`, { method: 'POST', body: { token: hand.qr, photoId: hp, at: Date.now(), ...HOME, adultConfirmed: true } });
  ok(after.status === 'HANDED_OVER' && after.paid.driver, 'handed over; driver paid at handoff');
  const accepted = await cust(`/orders/${order.id}/accept`, { method: 'POST' });
  ok(accepted.status === 'ACCEPTED' && accepted.paid.shop, 'customer accepted; shop paid');

  const full = await admin(`/orders/${order.id}`);
  const paid = Object.fromEntries(full.money.map((m) => [m.to_kind + ':' + m.action, m.amount_cents]));
  ok(paid['driver:release'] === opt.priceCents, `driver got ${opt.priceCents} (100% of the delivery charge)`);
  ok(paid['shop:release'] === goods, `shop got ${goods}`);
  ok(full.routes.length === 1, 'GPS route saved once at handoff');
  ok(full.events.length >= 8, `${full.events.length} events in the append-only log`);

  // --- ratings are blind until both sides rate
  await cust(`/orders/${order.id}/rate`, { method: 'POST', body: { ratings: [{ to: 'driver', stars: 5 }, { to: 'shop', stars: 4 }] } });
  let r = (await admin(`/orders/${order.id}`)).ratings;
  ok(r.every((x) => !x.visible_at), 'ratings hidden until the other side rates');
  await drv(`/jobs/${order.id}/rate`, { method: 'POST', body: { ratings: [{ to: 'customer', stars: 5, reasons: ['great_customer'] }] } });
  r = (await admin(`/orders/${order.id}`)).ratings;
  ok(r.find((x) => x.from_type === 'customer' && x.to_type === 'driver').visible_at && r.find((x) => x.from_type === 'driver').visible_at, 'both directions revealed together');

  // --- problem → return → refund (shop agrees it was wrong)
  const q2 = await cust('/quotes', { method: 'POST', body: { shopId: SHOP.id, dropoff: HOME } });
  const o2t = 4000 + mineOpt(q2).priceCents;
  const h2 = (await cust('/dev/hold', { method: 'POST', body: { amountCents: o2t } })).holdId;
  const o2 = await cust('/orders', { method: 'POST', body: { quoteId: q2.quoteId, driverId: mineOpt(q2).driverId, source: 'kiripos', sourceRef: `R2-${run}`, goodsCents: 4000, holdId: h2 } });
  await deliver(o2.id);
  const pp = (await photo(cust, `/orders/${o2.id}/photos`)).photoId;
  const prob = await cust(`/orders/${o2.id}/problem`, { method: 'POST', body: { reason: 'wrong_item', choice: 'return', photoId: pp } });
  ok(!!prob.returnOrderId, 'problem reported; return trip created');
  await shop(`/orders/${o2.id}/fault`, { method: 'POST', body: { response: 'agree' } });
  await drv('/position', { method: 'POST', body: HOME }); // the driver app reports where it is
  const rd = await cust(`/orders/${prob.returnOrderId}/drivers`);
  ok(rd.options.some((o) => o.driverId === applied.driverId) && rd.paysBy === 'the shop', 'customer picks a return driver; the shop pays');
  await cust(`/orders/${prob.returnOrderId}/choose-driver`, { method: 'POST', body: { driverId: applied.driverId } });
  const retOffer = (await drv('/offers'))[0];
  await drv(`/offers/${retOffer.offerId}/accept`, { method: 'POST' });
  await drv(`/jobs/${prob.returnOrderId}/status`, { method: 'POST', body: { status: 'at_pickup', ...HOME } });
  const retCode = await cust(`/orders/${prob.returnOrderId}/handoff`);
  await drv(`/jobs/${prob.returnOrderId}/status`, { method: 'POST', body: { status: 'picked_up', ...HOME, token: retCode.qr } });
  await drv(`/jobs/${prob.returnOrderId}/status`, { method: 'POST', body: { status: 'arrived', ...SHOP } });
  const dp = (await photo(drv, `/photos?kind=handoff&order=${prob.returnOrderId}`, SHOP)).photoId;
  const farAway = await drv(`/jobs/${prob.returnOrderId}/handoff`, { method: 'POST', body: { photoId: dp, at: Date.now(), ...HOME, code: '0000' } }).then(() => false, () => true);
  ok(farAway, 'return drop refused away from the shop');
  await drv(`/jobs/${prob.returnOrderId}/handoff`, { method: 'POST', body: { photoId: dp, at: Date.now(), ...SHOP, code: '0000' } });
  const back = await photo(shop, `/orders/${prob.returnOrderId}/return-received`);
  ok(back.status === 'REFUNDED', 'return received; order refunded');
  const m2 = (await admin(`/orders/${o2.id}`)).money;
  const sum = (k, a) => m2.filter((m) => m.to_kind === k && m.action === a && m.status === 'done').reduce((s, m) => s + m.amount_cents, 0);
  const retPrice = rd.options.find((o) => o.driverId === applied.driverId).priceCents;
  ok(sum('customer', 'refund') === 4000 - retPrice, `customer refunded goods left in hold (${4000 - retPrice})`);
  ok(sum('customer', 'charge') === mineOpt(q2).priceCents + retPrice, 'shop charged the original delivery + return trip back to the customer');
  ok(sum('driver', 'release') === mineOpt(q2).priceCents + retPrice, 'both drivers paid in full');
  ok(sum('customer', 'refund') + sum('customer', 'charge') === 4000 + mineOpt(q2).priceCents, 'customer is made whole: goods + delivery back');

  // --- cancelling before pickup refunds everything
  await drv('/position', { method: 'POST', body: { lat: SHOP.lat + 0.002, lng: SHOP.lng } });
  const q3 = await cust('/quotes', { method: 'POST', body: { shopId: SHOP.id, dropoff: HOME } });
  const h3 = (await cust('/dev/hold', { method: 'POST', body: { amountCents: 1000 + mineOpt(q3).priceCents } })).holdId;
  const o3 = await cust('/orders', { method: 'POST', body: { quoteId: q3.quoteId, driverId: mineOpt(q3).driverId, source: 'kiripos', sourceRef: `R3-${run}`, goodsCents: 1000, holdId: h3 } });
  const c3 = await cust(`/orders/${o3.id}/cancel`, { method: 'POST' });
  ok(c3.status === 'CANCELLED', 'cancel before pickup → full refund');

  await drv('/offline', { method: 'POST' });
  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  process.exit(fails ? 1 : 0);

  async function deliver(id) {
    const of = (await drv('/offers')).find((o) => o.orderId === id);
    await drv(`/offers/${of.offerId}/accept`, { method: 'POST' });
    await drv(`/jobs/${id}/status`, { method: 'POST', body: { status: 'at_pickup', ...SHOP } });
    await drv(`/jobs/${id}/status`, { method: 'POST', body: { status: 'picked_up', ...SHOP } });
    await drv(`/jobs/${id}/status`, { method: 'POST', body: { status: 'arrived', ...HOME } });
    const t = await cust(`/orders/${id}/handoff`);
    const ph = (await photo(drv, `/photos?kind=handoff&order=${id}`, HOME)).photoId;
    await drv(`/jobs/${id}/handoff`, { method: 'POST', body: { code: t.code, photoId: ph, at: Date.now(), ...HOME, adultConfirmed: true } });
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
void moves;
