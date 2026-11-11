// Rides through the real KiriPay app routes (no stand-in): the rider pays fare + buffer with /api/kirigo/rides,
// picks a Trip buddy from their KiriPay contacts, boards with the code, the friend follows through KiriPay, the trip ends
// and the money lands where it should. Same setup as integration.mjs (KiriPay :8788 with 0048, KiriGo :8787 live).
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';

const GO = 'http://localhost:8787', KP = 'http://localhost:8788';
const JWT_SECRET = process.env.KP_JWT_SECRET ?? 'local-jwt-secret-for-testing-only-0123456789';
const KP_DIR = process.env.KP_DIR ?? '/home/claude/kp-check';
const run = Date.now().toString(36);
const PICKUP = { lat: 1.3290, lng: 172.9800 }, DEST = { lat: 1.3450, lng: 173.0280 };   // Bairiki → Ambo
let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

function kpCookie(sub) {
  const body = Buffer.from(JSON.stringify({ mfa: true, ver: 0, sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64');
  return `kp_session=${body}.${createHmac('sha256', JWT_SECRET).update(body).digest('base64')}`;
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
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
async function signIn(user, app = 'driver') {
  const start = await req(`${GO}/auth/start?app=${app}`, { redirect: 'manual' });
  const back = await req(start.headers.get('location').replace('https://kiripay.online', KP), { redirect: 'manual', headers: { cookie: kpCookie(user) } });
  const done = await req(back.headers.get('location'), { redirect: 'manual' });
  return decodeURIComponent(done.headers.get('location').split('#token=')[1]);
}

async function main() {
  // people in KiriPay: a car driver, and a friend the rider has saved as a contact
  const DRV = `u_rd_${run}`, BUD = `u_bd_${run}`, CT = `ct_${run}`;
  sql(`INSERT INTO users (id,email,name,pw_hash,pw_salt,email_verified,kyc_tier) VALUES ('${DRV}','${DRV}@test.ki','Bwebwe Driver','x','x',1,2),('${BUD}','${BUD}@test.ki','Nei Friend','x','x',1,2)`);
  sql(`INSERT INTO accounts (id, owner_id, kind, balance) VALUES ('acc_${DRV}','${DRV}','user',0),('acc_${BUD}','${BUD}','user',0)`);
  sql(`INSERT INTO contacts (id, owner_id, name, email) VALUES ('${CT}','u_cust','Nei','${BUD}@test.ki'),('${CT}x','u_cust','Nobody','nobody-${run}@test.ki')`);

  sql("UPDATE users SET admin_role='super_admin' WHERE id='u_owner'");
  const at = await signIn('u_owner', 'admin');
  const admin = (p, o = {}) => req(`${GO}/api/admin${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${at}` } });
  await admin('/settings', { method: 'PUT', body: { rides_open: true, ride_buffer_cents: 500, ride_free_cancel_min: 2, ride_noshow_wait_min: 5 } });

  let dt = await signIn(DRV);
  const su = (p, o = {}) => req(`${GO}/api/driver/signup${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${dt}` } });
  const drv = (p, o = {}) => req(`${GO}/api/driver${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${dt}` } });
  const pic = (f, p) => f(p, { method: 'POST', raw: jpeg, headers: { 'content-type': 'image/jpeg' } });
  const v = (await pic(su, '/photos?kind=vehicle')).photoId, l = (await pic(su, '/photos?kind=licence')).photoId;
  const ap = await su('/apply', { method: 'POST', body: { firstName: 'Bwebwe', vehicle: { type: 'car', plate: `C ${run.slice(-3)}`, photoId: v }, licencePhotoId: l, rateCard: { baseCents: 200, perKmCents: 100, minimumCents: 300, nightCents: 0, bulkyCents: 0 }, acceptTerms: true } });
  dt = ap.token;
  await admin(`/drivers/${ap.driverId}/approve`, { method: 'POST', body: { licenceSeen: true, licenceMatchesKyc: true, licenceExpiry: '2031-01-01' } });
  const rw = (await pic(drv, '/photos?kind=vehicle')).photoId;
  const noFace = await admin(`/drivers/${ap.driverId}/rides/approve`, { method: 'POST', body: { roadworthyChecked: true, override: true } }).then(() => false, (e) => String(e).includes('FACE_PHOTO_NEEDED'));
  await admin(`/drivers/${ap.driverId}/face-photo`, { method: 'POST', raw: jpeg, headers: { 'content-type': 'image/jpeg' } });
  await drv('/rides/apply', { method: 'POST', body: { seats: 4, roadworthyPhotoId: rw, rateCard: { baseCents: 300, perKmCents: 150, minimumCents: 500, nightCents: 0, waitPerMinCents: 50, cancelCents: 300 } } });
  await admin(`/drivers/${ap.driverId}/rides/approve`, { method: 'POST', body: { roadworthyChecked: true, override: true, note: 'test' } });
  await drv('/services', { method: 'PUT', body: { deliveries: false, rides: true } });
  ok(noFace, 'rides need a face photo cut from the licence first');
  await drv('/online', { method: 'POST', body: { selfiePhotoId: (await pic(drv, '/photos?kind=selfie')).photoId, lat: PICKUP.lat + 0.001, lng: PICKUP.lng } });
  ok(true, `ride driver ${ap.driverId} approved and online`);

  // the rider books and pays in KiriPay
  const cust = kp('u_cust'), friend = kp(BUD);
  const before = { cust: balance('acc_cust'), drv: balance(`acc_${DRV}`) };
  const q = await cust('/kirigo/svc/rides/quotes', { method: 'POST', body: { pickup: PICKUP, dropoff: DEST, seats: 2 } });
  const opt = q.options?.find((o) => o.driverId === ap.driverId);
  ok(q.available && opt, `quote through KiriPay: fare ${opt?.priceCents}c, ${q.distanceM} m, buffer ${q.bufferCents}c`);
  const direct = await cust('/kirigo/svc/rides', { method: 'POST', body: {} }).then(() => false, (e) => String(e).includes('404'));
  ok(direct, 'booking straight through the pass-through (without paying) is blocked');
  const key = `r${run}`;
  const paid = await cust('/kirigo/rides', { method: 'POST', body: { quoteId: q.quoteId, driverId: ap.driverId, fareCents: opt.priceCents, bufferCents: q.bufferCents, pickupNote: 'blue gate', dropNote: 'Ambo: church', buddyContactIds: [CT, `${CT}x`], key } });
  ok(paid.status === 'APPROVED' && paid.order?.service === 'ride' && paid.order.status === 'PAID_HELD', 'paid in KiriPay, ride booked in KiriGo');
  ok(paid.buddiesAsked === 2 && paid.buddiesFound === 1 && paid.order.ride.sharingWith === 1, 'only the contact with a verified KiriPay account becomes a Trip buddy');
  const id = paid.order.id;
  const total = opt.priceCents + q.bufferCents;
  ok(balance('acc_cust') === before.cust - total, 'rider wallet down by fare + buffer');
  const hold = sql(`SELECT * FROM escrow_holds WHERE ref='${id}'`)[0];
  ok(hold && balance(hold.id) === total, 'money sits in the hold');
  const again = await cust('/kirigo/rides', { method: 'POST', body: { quoteId: q.quoteId, driverId: ap.driverId, fareCents: opt.priceCents, bufferCents: q.bufferCents, key } });
  ok(again.duplicate && balance('acc_cust') === before.cust - total, 'pressing pay twice charges once');

  // driver comes; the friend can see who it is
  const of = (await drv('/offers')).find((o) => o.orderId === id);
  await drv(`/offers/${of.offerId}/accept`, { method: 'POST' });
  const f1 = await friend('/kirigo/svc/following');
  ok(f1.length === 1 && f1[0].riderFirstName === 'Tekaai' && f1[0].driver?.vehicle?.plate === `C ${run.slice(-3)}`, 'friend sees the rider (first name from KiriPay) and the driver and plate');
  ok(!JSON.stringify(f1).match(/Cents|"code"/), 'friend sees no money and no boarding code');

  const fc = (await cust(`/kirigo/svc/orders/${id}`)).ride.faceCheck;
  ok(fc?.approvedUrl && fc?.todayUrl, 'rider sees the approved face and today\'s selfie before boarding');
  ok(!JSON.stringify(f1).includes('faceCheck'), 'friend does not get the face photos');
  await drv(`/jobs/${id}/status`, { method: 'POST', body: { status: 'at_pickup', ...PICKUP } });
  const bc = await cust(`/kirigo/svc/orders/${id}/handoff`);
  ok(/^\d{4}$/.test(bc.code) && bc.qr, 'rider gets the boarding code through KiriPay');
  await drv(`/jobs/${id}/status`, { method: 'POST', body: { status: 'picked_up', ...PICKUP, code: bc.code } });
  await drv(`/jobs/${id}/gps`, { method: 'POST', body: { points: [{ lat: 1.336, lng: 173.0, at: Date.now() }] } });
  const pos = await cust(`/kirigo/svc/orders/${id}/position`);
  const fpos = await friend(`/kirigo/svc/following/${id}/position`);
  ok(pos.last?.point?.lng === 173.0 && fpos.last?.point?.lng === 173.0, 'rider and friend both see the car moving');
  const stranger = await kp(DRV)(`/kirigo/svc/following/${id}/position`).then(() => false, () => true);
  ok(stranger, 'someone who is not a Trip buddy cannot see the trip');
  await friend(`/kirigo/svc/following/${id}/alert`, { method: 'POST', body: {} });
  ok((await admin('/alerts')).some((a) => a.order_id === id && a.kind === 'emergency'), "friend's alert reaches KiriGo admin");

  // drop-off
  await drv(`/jobs/${id}/end-ride`, { method: 'POST', body: DEST });
  const end = await cust(`/kirigo/svc/orders/${id}`);
  ok(end.status === 'ACCEPTED', 'trip ended');
  ok(balance(`acc_${DRV}`) === before.drv + opt.priceCents, `driver +${opt.priceCents} (the whole fare)`);
  ok(balance('acc_cust') === before.cust - opt.priceCents, 'rider got the unused buffer back');
  ok(balance(hold.id) === 0, 'hold empty');
  const f2 = await friend('/kirigo/svc/following');
  ok(f2.length === 1 && f2[0].arrivedSafely, 'friend sees "arrived safely"');
  await cust(`/kirigo/svc/orders/${id}/rate`, { method: 'POST', body: { ratings: [{ to: 'driver', stars: 5 }] } });
  ok(true, 'rider rated the driver');

  // the face check: two riders say it isn't the same person → full refunds, rides paused
  for (const n of [1, 2]) {
    const q2 = await cust('/kirigo/svc/rides/quotes', { method: 'POST', body: { pickup: PICKUP, dropoff: DEST, seats: 1 } });
    const o2 = q2.options.find((o) => o.driverId === ap.driverId);
    const b0 = balance('acc_cust');
    const p2 = await cust('/kirigo/rides', { method: 'POST', body: { quoteId: q2.quoteId, driverId: ap.driverId, fareCents: o2.priceCents, bufferCents: q2.bufferCents, key: `fm${n}${run}` } });
    const of2 = (await drv('/offers')).find((o) => o.orderId === p2.order.id);
    await drv(`/offers/${of2.offerId}/accept`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, n === 1 ? 2500 : 0));
    const c2 = await cust(`/kirigo/svc/orders/${p2.order.id}/face-mismatch`, { method: 'POST', body: { reason: n === 1 ? 'unclear' : 'no_match' } });
    ok(c2.status === 'CANCELLED' && balance('acc_cust') === b0, `face check cancel ${n}: every cent back, even after the free-cancel minutes`);
  }
  const reports = await admin('/face-reports');
  ok(reports.filter((r) => r.driver_id === ap.driverId).length === 2 && reports.some((r) => r.driver_id === ap.driverId && r.paused_driver), 'KiriGo team sees both reports');
  const paused = (await admin('/rides/applications?status=suspended')).some((d) => d.id === ap.driverId);
  ok(paused, "second report pauses the driver's rides");
  const tooLate = await cust(`/kirigo/svc/orders/${id}/face-mismatch`, { method: 'POST', body: { reason: 'no_match' } }).then(() => false, (e) => String(e).includes('TOO_LATE'));
  ok(tooLate, 'no face-check cancel after the trip');

  const sum = sql('SELECT SUM(balance) AS s FROM accounts')[0].s;
  ok(sum === 0, 'KiriPay ledger still sums to zero');
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
