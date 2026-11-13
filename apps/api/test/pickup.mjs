// Easier pickups and guided prices, against `npm run dev` (KIRIPAY_MODE=mock):
// recommended rates and the allowed range, "Fair price", waiting for a driver, saved places and landmarks,
// lagoon/ocean side, "I'm here" and a one-tap reply.
const BASE = process.env.BASE ?? 'http://localhost:8787';
const KP = process.env.KIRIPAY_SERVICE_KEY ?? 'dev-kiripay-key';
const run = Date.now().toString(36);
const RIDER = `u_prider_${run}`, DRV = `u_pdrv_${run}`;
const PICKUP = { lat: 1.3480, lng: 173.0400 }, DEST = { lat: 1.3650, lng: 173.1170 };
let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

async function call(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const fails_with = (p, code) => p.then(() => false, (e) => String(e).includes(code));
const rider = (p, o = {}) => call(`/api/svc${p}`, { ...o, headers: { ...(o.headers ?? {}), 'x-kirigo-key': KP, 'x-kirigo-user': RIDER, 'x-kirigo-name': 'Teata' } });
let dt = '';
const drv = (p, o = {}) => call(`/api/driver${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${dt}` } });
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const pic = (f, p) => f(p, { method: 'POST', raw: jpeg, headers: { 'content-type': 'image/jpeg' } });

async function main() {
  const at = (await call('/auth/dev?user=u_admin&admin=1')).token;
  const admin = (p, o = {}) => call(`/api/admin${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${at}` } });
  await admin('/settings', { method: 'PUT', body: { monthly_fee_cents: 1000, max_per_km_cents: 300, floor_minimum_cents: 200, night_hours: { start: '23:59', end: '00:00' }, enroute_pickup_fee_cents: 100,
    delivery_open: true, rides_open: true, ride_buffer_cents: 500, ride_wait_min: 10 } });
  const badBand = await fails_with(admin('/settings', { method: 'PUT', body: { rate_band: { belowPct: 95, abovePct: 50 } } }), 'RATE_BAND_INVALID');
  ok(badBand, 'admin: a silly price band is refused');

  // ---- guided prices
  dt = (await call(`/auth/dev?user=${DRV}&name=Kaure`)).token;
  const su = (p, o = {}) => call(`/api/driver/signup${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${dt}` } });
  const guide = await su('/rates');
  ok(guide.rates.delivery_car.recommended.perKmCents === 60 && guide.rates.delivery_motorbike.recommended.baseCents === 100 && guide.rates.ride_car.recommended.minimumCents === 300,
    'sign-up form gets the recommended rates (car 60c/km, motorbike $1 start, ride $3 minimum)');
  ok(guide.rates.delivery_car.lowest.perKmCents === 40 && guide.rates.delivery_car.highest.perKmCents === 90, `allowed range for car per km: ${guide.rates.delivery_car.lowest.perKmCents}–${guide.rates.delivery_car.highest.perKmCents}c`);
  const v = (await pic(su, '/photos?kind=vehicle')).photoId, l = (await pic(su, '/photos?kind=licence')).photoId;
  const apply = (rc) => su('/apply', { method: 'POST', body: { firstName: 'Kaure', vehicle: { type: 'car', plate: 'C 501', colour: 'White', photoId: v }, licencePhotoId: l, rateCard: { nightCents: 0, bulkyCents: 0, ...rc }, acceptTerms: true } });
  let tooDear = '';
  await apply({ baseCents: 200, perKmCents: 150, minimumCents: 350 }).catch((e) => { tooDear = String(e); });
  ok(tooDear.includes('RATE_OUT_OF_RANGE') && tooDear.includes("Price per km can't be above $0.90"), 'a per-km price far above the recommended one is refused, in plain words');
  const ap = await apply(guide.rates.delivery_car.recommended);
  dt = ap.token;
  await admin(`/drivers/${ap.driverId}/approve`, { method: 'POST', body: { licenceSeen: true, licenceMatchesKyc: true, licenceExpiry: '2031-01-01' } });
  const rw = (await pic(drv, '/photos?kind=vehicle')).photoId;
  const rideCard = { ...guide.rates.ride_car.recommended, nightCents: 0, waitPerMinCents: 20, cancelCents: 200 };
  const cheapRide = await fails_with(drv('/rides/apply', { method: 'POST', body: { seats: 4, roadworthyPhotoId: rw, colour: 'White', rateCard: { ...rideCard, baseCents: 50 } } }), 'RATE_OUT_OF_RANGE');
  ok(cheapRide, 'a ride starting price far below the recommended one is refused too (no race to the bottom)');
  await drv('/rides/apply', { method: 'POST', body: { seats: 4, roadworthyPhotoId: rw, colour: 'White', rateCard: rideCard } });
  await admin(`/drivers/${ap.driverId}/face-photo`, { method: 'POST', raw: jpeg, headers: { 'content-type': 'image/jpeg' } });
  await admin(`/drivers/${ap.driverId}/rides/approve`, { method: 'POST', body: { roadworthyChecked: true, override: true, note: 'test' } });
  await drv('/services', { method: 'PUT', body: { deliveries: false, rides: true } });

  // ---- places: Home, and a landmark pinned by an admin
  const lm = await admin('/landmarks', { method: 'POST', body: { label: `Test hospital ${run}`, lat: DEST.lat, lng: DEST.lng, side: 'ocean', note: 'Main gate' } });
  await rider('/places', { method: 'POST', body: { kind: 'home', label: 'Home', lat: PICKUP.lat, lng: PICKUP.lng, side: 'lagoon', note: 'Green house, white fence' } });
  await rider('/places', { method: 'POST', body: { kind: 'home', label: 'Home', lat: PICKUP.lat, lng: PICKUP.lng, side: 'ocean', note: 'Green house, white fence' } });
  const places = await rider('/places');
  const home = places.saved.filter((p) => p.kind === 'home');
  ok(home.length === 1 && home[0].side === 'ocean', 'Home saved once (saving again moves it), with its side of the road');
  ok(places.landmarks.some((p) => p.id === lm.id && p.note === 'Main gate'), 'rider sees the shared landmark');

  // ---- no driver yet: wait for one
  const q0 = await rider('/rides/quotes', { method: 'POST', body: { pickup: PICKUP, dropoff: DEST } });
  ok(!q0.available && q0.reason === 'NO_DRIVERS_ONLINE', 'no ride driver online yet');
  const w = await rider('/rides/waits', { method: 'POST', body: { pickup: PICKUP, dropoff: DEST, pickupNote: home[0].note, pickupSide: 'ocean' } });
  ok(w.status === 'waiting' && w.expiresAt, 'rider chose "Wait for a driver" (nothing paid)');
  ok((await rider(`/rides/waits/${w.id}`)).status === 'waiting', 'still waiting while nobody is online');

  const sp = (await pic(drv, '/photos?kind=selfie')).photoId;
  const on = await drv('/online', { method: 'POST', body: { selfiePhotoId: sp, lat: PICKUP.lat + 0.002, lng: PICKUP.lng } });
  ok(on.ridersWaiting >= 1, `driver went online and was told ${on.ridersWaiting} rider(s) nearby are waiting`);
  const found = await rider(`/rides/waits/${w.id}`);
  const opt = found.quote?.options?.find((o) => o.driverId === ap.driverId);
  ok(found.status === 'found' && opt, 'the waiting rider now sees the driver to book');
  ok(opt?.fairPrice === true && opt?.colour === 'White', `driver at the recommended rate shows "Fair price" (${opt?.priceCents}c), car colour White`);

  // ---- book with the side of the road; the wait closes
  const total = opt.priceCents + found.quote.bufferCents;
  const { holdId } = await rider('/dev/hold', { method: 'POST', body: { amountCents: total } });
  const ride = await rider('/rides', { method: 'POST', body: { quoteId: found.quote.quoteId, driverId: ap.driverId, holdId, sourceRef: `pk-${run}`, pickupNote: home[0].note, pickupSide: 'ocean', dropSide: 'lagoon' } });
  ok(ride.sides.pickup === 'ocean' && ride.sides.dropoff === 'lagoon', 'ride booked with pickup on the ocean side, drop-off on the lagoon side');
  ok((await rider(`/rides/waits/${w.id}`)).status === 'booked', 'the wait closed when the rider booked');

  const of = (await drv('/offers')).find((o) => o.orderId === ride.id);
  await drv(`/offers/${of.offerId}/accept`, { method: 'POST' });
  const job = await drv(`/jobs/${ride.id}`);
  ok(job.sides.pickup === 'ocean' && job.ride.pickup.note === 'Green house, white fence', 'driver sees: ocean side, "Green house, white fence"');

  // ---- I'm here + one-tap reply
  const here = await drv(`/jobs/${ride.id}/here`, { method: 'POST', body: { lat: PICKUP.lat, lng: PICKUP.lng } });
  ok(here.status === 'AT_SHOP' && here.here?.at, '"I\'m here" marks the driver arrived');
  const rv = await rider(`/orders/${ride.id}`);
  ok(rv.here && rv.label === 'Driver has arrived' && rv.driver.vehicle.colour === 'White' && rv.driver.vehicle.plate === 'C 501', 'rider sees "Driver has arrived", a white car, plate C 501');
  ok(await fails_with(drv(`/jobs/${ride.id}/here`, { method: 'POST', body: { lat: PICKUP.lat, lng: PICKUP.lng } }), 'JUST_RANG'), 'can ring again only after a minute');
  await rider(`/orders/${ride.id}/messages`, { method: 'POST', body: { body: 'Coming, 2 minutes' } });
  const msgs = await drv(`/jobs/${ride.id}/messages`);
  ok(msgs.some((m) => m.from_type === 'driver' && m.body.startsWith("I'm here (White car, plate C 501)")) && msgs.some((m) => m.from_type === 'customer' && m.body === 'Coming, 2 minutes'),
    'chat shows "I\'m here (White car, plate C 501)" and the rider\'s reply');

  // ---- changing prices later stays in the range
  await drv('/offline', { method: 'POST' });
  ok(await fails_with(drv('/rides/rate-card', { method: 'PUT', body: { ...rideCard, perKmCents: 200 } }), 'RATE_OUT_OF_RANGE'), 'raising the ride per-km price past the ceiling is refused');
  await admin(`/landmarks/${lm.id}`, { method: 'DELETE' });

  console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
