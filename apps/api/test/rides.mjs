// Rides end to end against `npm run dev` (KIRIPAY_MODE=mock): booking with a Trip buddy, boarding code,
// the buddy's view, emergency button, drop-off and money; then a late cancel and a no-show.
const BASE = process.env.BASE ?? 'http://localhost:8787';
const KP = process.env.KIRIPAY_SERVICE_KEY ?? 'dev-kiripay-key';
const run = Date.now().toString(36);
const RIDER = `u_rider_${run}`, BUDDY = `u_buddy_${run}`, DRV = `u_rdrv_${run}`;
const PICKUP = { lat: 1.3290, lng: 172.9800 }, DEST = { lat: 1.3330, lng: 173.0050 };
let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

async function call(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const as = (user, name) => (p, o = {}) => call(`/api/svc${p}`, { ...o, headers: { ...(o.headers ?? {}), 'x-kirigo-key': KP, 'x-kirigo-user': user, ...(name ? { 'x-kirigo-name': name } : {}) } });
const rider = as(RIDER, 'Teata'), buddy = as(BUDDY);
let dt = '';
const drv = (p, o = {}) => call(`/api/driver${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${dt}` } });
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const pic = (f, p) => f(p, { method: 'POST', raw: jpeg, headers: { 'content-type': 'image/jpeg' } });

async function main() {
  const at = (await call('/auth/dev?user=u_admin&admin=1')).token;
  const admin = (p, o = {}) => call(`/api/admin${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${at}` } });
  await admin('/settings', { method: 'PUT', body: { monthly_fee_cents: 1000, max_per_km_cents: 300, floor_minimum_cents: 200, night_hours: { start: '20:00', end: '06:00' }, enroute_pickup_fee_cents: 100,
    delivery_open: true, rides_open: true, ride_free_cancel_min: 0, ride_noshow_wait_min: 0, ride_buffer_cents: 500 } });

  // a car driver, approved for deliveries, then for rides
  dt = (await call(`/auth/dev?user=${DRV}&name=Bwebwe`)).token;
  const su = (p, o = {}) => call(`/api/driver/signup${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${dt}` } });
  const v = (await pic(su, '/photos?kind=vehicle')).photoId, l = (await pic(su, '/photos?kind=licence')).photoId;
  const ap = await su('/apply', { method: 'POST', body: { firstName: 'Bwebwe', vehicle: { type: 'car', plate: 'C 77', photoId: v }, licencePhotoId: l, rateCard: { baseCents: 200, perKmCents: 60, minimumCents: 350, nightCents: 0, bulkyCents: 0 }, acceptTerms: true } });
  dt = ap.token;
  await admin(`/drivers/${ap.driverId}/approve`, { method: 'POST', body: { licenceSeen: true, licenceMatchesKyc: true, licenceExpiry: '2031-01-01' } });
  const notYet = await drv('/services', { method: 'PUT', body: { deliveries: true, rides: true } }).then(() => false, () => true);
  ok(notYet, 'cannot switch rides on before ride approval');
  const rw = (await pic(drv, '/photos?kind=vehicle')).photoId;
  await drv('/rides/apply', { method: 'POST', body: { seats: 4, roadworthyPhotoId: rw, rateCard: { baseCents: 200, perKmCents: 50, minimumCents: 300, nightCents: 0, waitPerMinCents: 50, cancelCents: 300 } } });
  await admin(`/drivers/${ap.driverId}/face-photo`, { method: 'POST', raw: jpeg, headers: { 'content-type': 'image/jpeg' } });
  const noRecord = await admin(`/drivers/${ap.driverId}/rides/approve`, { method: 'POST', body: { roadworthyChecked: true } }).then(() => false, (e) => String(e).includes('NOT_ENOUGH_RECORD'));
  ok(noRecord, 'ride approval needs a delivery record (20 deliveries, 4.3) unless overridden');
  await admin(`/drivers/${ap.driverId}/rides/approve`, { method: 'POST', body: { roadworthyChecked: true, override: true, note: 'launch driver' } });
  await drv('/services', { method: 'PUT', body: { deliveries: false, rides: true } });
  const sp = (await pic(drv, '/photos?kind=selfie')).photoId;
  await drv('/online', { method: 'POST', body: { selfiePhotoId: sp, lat: PICKUP.lat + 0.001, lng: PICKUP.lng } });
  const me = await drv('/me');
  ok(me.services.rides && !me.services.deliveries && me.rides.status === 'approved', 'driver approved for rides, rides only');

  // book a ride, shared with a friend
  const q = await rider('/rides/quotes', { method: 'POST', body: { pickup: PICKUP, dropoff: DEST, seats: 2 } });
  const opt = q.options?.find((o) => o.driverId === ap.driverId);
  ok(q.available && opt, `ride quote: ${opt?.priceCents}c for ${q.distanceM} m, +${q.bufferCents}c refundable`);
  const total = opt.priceCents + q.bufferCents;
  const { holdId } = await rider('/dev/hold', { method: 'POST', body: { amountCents: total } });
  const ride = await rider('/rides', { method: 'POST', body: { quoteId: q.quoteId, driverId: ap.driverId, holdId, buddies: [BUDDY], sourceRef: `ride-${run}`, pickupNote: 'by the blue gate' } });
  ok(ride.service === 'ride' && ride.status === 'PAID_HELD' && ride.ride.sharingWith === 1, 'ride booked, paid and held, shared with 1 friend');
  const delivQuote = await rider('/quotes', { method: 'POST', body: { shopId: 'store_smoke', dropoff: DEST } }).then((r) => r.options?.some((o) => o.driverId === ap.driverId), () => false);
  ok(!delivQuote, 'a rides-only driver is not offered for deliveries');

  const of = (await drv('/offers')).find((o) => o.orderId === ride.id);
  ok(of?.kind === 'ride' && of.seats === 2, 'driver sees a ride offer for 2 seats');
  await drv(`/offers/${of.offerId}/accept`, { method: 'POST' });
  const job = await drv(`/jobs/${ride.id}`);
  ok(job.ride.sharing === true, 'driver is told the rider is sharing the trip');

  const f1 = await buddy('/following');
  ok(f1.length === 1 && f1[0].driver?.driverCode === ap.driverCode && f1[0].riderFirstName === 'Teata' && f1[0].driver.vehicle.plate === 'C 77', 'friend sees the driver card (name, KG code, plate) and whose trip it is');
  ok(f1[0].fareCents === undefined && !JSON.stringify(f1[0]).includes('code'), 'friend sees no money and no boarding code');

  await drv(`/jobs/${ride.id}/status`, { method: 'POST', body: { status: 'at_pickup', ...PICKUP } });
  const bc = await rider(`/orders/${ride.id}/handoff`);
  const badBoard = await drv(`/jobs/${ride.id}/status`, { method: 'POST', body: { status: 'picked_up', ...PICKUP, code: bc.code === '0000' ? '0001' : '0000' } }).then(() => false, () => true);
  ok(badBoard, 'wrong boarding code refused');
  await drv(`/jobs/${ride.id}/status`, { method: 'POST', body: { status: 'picked_up', ...PICKUP, token: bc.qr } });
  await drv(`/jobs/${ride.id}/gps`, { method: 'POST', body: { points: [{ ...PICKUP, at: Date.now() }, { lat: 1.331, lng: 172.99, at: Date.now() + 1000 }] } });
  await rider(`/orders/${ride.id}/emergency`, { method: 'POST', body: { lat: 1.331, lng: 172.99 } });
  const f2 = await buddy('/following');
  ok(f2[0].alerts.some((a) => a.kind === 'emergency'), 'emergency button reaches the friend');
  const alerts = await admin('/alerts');
  ok(alerts[0]?.kind === 'emergency' && alerts[0].order_id === ride.id, 'and is first in the admin queue');

  const done = await drv(`/jobs/${ride.id}/end-ride`, { method: 'POST', body: DEST });
  ok(done.status === 'ACCEPTED', 'ride ended at the destination');
  const f3 = await buddy('/following');
  ok(f3[0]?.arrivedSafely === true, 'friend sees "arrived safely"');
  const m = (await admin(`/orders/${ride.id}`)).money.filter((x) => x.status === 'done');
  const sum = (k, a) => m.filter((x) => x.to_kind === k && x.action === a).reduce((s, x) => s + x.amount_cents, 0);
  ok(sum('driver', 'release') === opt.priceCents, `driver got the full fare (${opt.priceCents}c)`);
  ok(sum('customer', 'refund') === q.bufferCents, `unused buffer refunded (${q.bufferCents}c)`);

  // late cancel → driver gets the cancellation fee
  const q2 = await rider('/rides/quotes', { method: 'POST', body: { pickup: PICKUP, dropoff: DEST } });
  const o2 = q2.options.find((o) => o.driverId === ap.driverId);
  const h2 = (await rider('/dev/hold', { method: 'POST', body: { amountCents: o2.priceCents + q2.bufferCents } })).holdId;
  const r2 = await rider('/rides', { method: 'POST', body: { quoteId: q2.quoteId, driverId: ap.driverId, holdId: h2, sourceRef: `ride2-${run}` } });
  await drv(`/offers/${(await drv('/offers')).find((o) => o.orderId === r2.id).offerId}/accept`, { method: 'POST' });
  const c2 = await rider(`/orders/${r2.id}/cancel`, { method: 'POST' });
  const m2 = (await admin(`/orders/${r2.id}`)).money.filter((x) => x.status === 'done');
  ok(c2.status === 'CANCELLED' && m2.some((x) => x.to_kind === 'driver' && x.amount_cents === 300), 'late cancel: driver gets the 300c fee');
  ok(m2.filter((x) => x.action === 'refund').reduce((s, x) => s + x.amount_cents, 0) === o2.priceCents + q2.bufferCents - 300, 'rider gets the rest back');

  // no-show
  const q3 = await rider('/rides/quotes', { method: 'POST', body: { pickup: PICKUP, dropoff: DEST } });
  const o3 = q3.options.find((o) => o.driverId === ap.driverId);
  const h3 = (await rider('/dev/hold', { method: 'POST', body: { amountCents: o3.priceCents + q3.bufferCents } })).holdId;
  const r3 = await rider('/rides', { method: 'POST', body: { quoteId: q3.quoteId, driverId: ap.driverId, holdId: h3, sourceRef: `ride3-${run}` } });
  await drv(`/offers/${(await drv('/offers')).find((o) => o.orderId === r3.id).offerId}/accept`, { method: 'POST' });
  await drv(`/jobs/${r3.id}/status`, { method: 'POST', body: { status: 'at_pickup', ...PICKUP } });
  const ns = await drv(`/jobs/${r3.id}/no-show`, { method: 'POST', body: PICKUP });
  ok(ns.status === 'NOT_DELIVERED', 'no-show recorded; driver gets the fee, rider the rest');

  await drv('/offline', { method: 'POST' });
  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
