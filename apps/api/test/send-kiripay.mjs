// KiriGo Send through the real KiriPay routes: a member posts a parcel job, two drivers bid, the sender picks one
// and pays in KiriPay, the recipient (a KiriPay member found by their phone) sees the code, the driver hands over and
// is paid. Also: wrong price refunded, return to sender, cancel before pickup, a driver dropping a job reopens it.
// Same setup as integration.mjs (KiriPay :8788 with 0048, KiriGo :8787 live with 0003 applied).
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';

const GO = 'http://localhost:8787', KP = 'http://localhost:8788';
const JWT_SECRET = process.env.KP_JWT_SECRET ?? 'local-jwt-secret-for-testing-only-0123456789';
const KP_DIR = process.env.KP_DIR ?? '/home/claude/kp-check';
const run = Date.now().toString(36);
const FROM = { lat: 1.3290, lng: 172.9800 }, TO = { lat: 1.3450, lng: 173.0280 };
let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

function kpCookie(sub) {
  const body = Buffer.from(JSON.stringify({ mfa: true, ver: 0, sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64');
  return `kp_session=${body}.${createHmac('sha256', JWT_SECRET).update(body).digest('base64')}`;
}
const sql = (q) => JSON.parse(execSync(`npx wrangler d1 execute kiripay --local --json --command "${q.replace(/"/g, '\\"')}"`, { cwd: KP_DIR, stdio: ['ignore', 'pipe', 'ignore'] }).toString())[0].results;
const balance = (acc) => sql(`SELECT balance FROM accounts WHERE id='${acc}'`)[0].balance;
async function req(url, { method = 'GET', body, headers = {}, raw, redirect = 'follow' } = {}) {
  const go = () => fetch(url, { method, redirect, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  // the local server drops idle keep-alive connections while the test waits on a database read: the request never
  // reached it, so sending it once more is safe
  const res = await go().catch((e) => (e?.cause?.code === 'UND_ERR_SOCKET' ? go() : Promise.reject(e)));
  if (redirect === 'manual') return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const kp = (user) => (p, o = {}) => req(`${KP}/api${p}`, { ...o, headers: { ...(o.headers ?? {}), cookie: kpCookie(user) } });
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
async function signIn(user, app = 'driver') {
  const start = await req(`${GO}/auth/start?app=${app}`, { redirect: 'manual' });
  const stateCookie = (start.headers.get('set-cookie') ?? '').split(';')[0];   // the sign-in must finish in the browser that started it
  const back = await req(start.headers.get('location').replace('https://kiripay.online', KP), { redirect: 'manual', headers: { cookie: kpCookie(user) } });
  const done = await req(back.headers.get('location'), { redirect: 'manual', headers: { cookie: stateCookie } });
  return decodeURIComponent(done.headers.get('location').split('#token=')[1]);
}

async function main() {
  const D1 = `u_s1_${run}`, D2 = `u_s2_${run}`, REC = `u_rc_${run}`, PHONE = `+6867${String(Date.now()).slice(-7)}`;
  sql(`INSERT INTO users (id,email,name,pw_hash,pw_salt,email_verified,kyc_tier,totp_enabled) VALUES ('${D1}','${D1}@test.ki','Taam One','x','x',1,2,1),('${D2}','${D2}@test.ki','Bwena Two','x','x',1,2,1)`);
  sql(`INSERT INTO users (id,email,name,pw_hash,pw_salt,email_verified,phone,phone_verified,kyc_tier) VALUES ('${REC}','${REC}@test.ki','Nei Receiver','x','x',1,'${PHONE}',1,1)`);
  sql(`INSERT INTO accounts (id, owner_id, kind, balance) VALUES ('acc_${D1}','${D1}','user',0),('acc_${D2}','${D2}','user',0),('acc_${REC}','${REC}','user',0)`);

  sql("UPDATE users SET admin_role='super_admin' WHERE id='u_owner'");
  const at = await signIn('u_owner', 'admin');
  const admin = (p, o = {}) => req(`${GO}/api/admin${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${at}` } });
  await admin('/settings', { method: 'PUT', body: { send_open: true, send_bid_max_cents: 10000, door_wait_min: 0 } });

  async function driver(user, name, plate) {
    let t = await signIn(user);
    const call = (p, o = {}) => req(`${GO}/api/driver${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${t}` } });
    const su = (p, o = {}) => req(`${GO}/api/driver/signup${p}`, { ...o, headers: { ...(o.headers ?? {}), authorization: `Bearer ${t}` } });
    const pic = (f, p) => f(p, { method: 'POST', raw: jpeg, headers: { 'content-type': 'image/jpeg' } });
    const v = (await pic(su, '/photos?kind=vehicle')).photoId, l = (await pic(su, '/photos?kind=licence')).photoId;
    const a = await su('/apply', { method: 'POST', body: { firstName: name, vehicle: { type: 'motorbike', plate, photoId: v }, licencePhotoId: l, rateCard: { baseCents: 100, perKmCents: 40, minimumCents: 200, nightCents: 0, bulkyCents: 0 }, acceptTerms: true } });
    t = a.token;
    await admin(`/drivers/${a.driverId}/approve`, { method: 'POST', body: { licenceSeen: true, licenceMatchesKyc: true, licenceExpiry: '2031-01-01' } });
    return { id: a.driverId, call, pic: (p) => pic(call, p) };
  }
  const d1 = await driver(D1, 'Taam', `S1 ${run.slice(-3)}`), d2 = await driver(D2, 'Bwena', `S2 ${run.slice(-3)}`);
  ok(true, 'two delivery drivers approved');

  const cust = kp('u_cust'), rec = kp(REC);
  const soon = (min) => new Date(Date.now() + min * 60_000).toISOString();
  const post = (ref) => cust('/kirigo/send/jobs', { method: 'POST', body: { pickup: FROM, pickupNote: 'Office reception', dropoff: TO, dropNote: 'Ambo: green house', item: 'document', description: 'Signed contract', recipientName: 'Nei', recipientPhone: PHONE.slice(4), pickupAfter: soon(0), deliverBy: soon(180), sourceRef: `${ref}${run}` } });

  // 1. post, bid, choose, deliver
  const blocked = await cust('/kirigo/svc/send/jobs', { method: 'POST', body: {} }).then(() => false, (e) => String(e).includes('404'));
  ok(blocked, 'posting straight through the pass-through is blocked (KiriPay must match the recipient)');
  const job = await post('a');
  ok(job.status === 'open' && job.recipient.isMember && job.bids.length === 0, 'job posted; recipient matched to a KiriPay member by their local number');
  const again = await post('a');
  ok(again.id === job.id, 'posting twice makes one job');

  const seen = (await d1.call('/send/jobs')).find((j) => j.id === job.id);
  ok(seen && !('pickup' in seen) && seen.pickupArea && !JSON.stringify(seen).includes('Nei'), 'drivers see a rough area only, not the address or recipient');
  await d1.call(`/send/jobs/${job.id}/bid`, { method: 'POST', body: { priceCents: 450, note: 'Can do it in 30 min' } });
  await d2.call(`/send/jobs/${job.id}/bid`, { method: 'POST', body: { priceCents: 350 } });
  await d2.call(`/send/jobs/${job.id}/bid`, { method: 'POST', body: { priceCents: 380 } });
  const tooHigh = await d1.call(`/send/jobs/${job.id}/bid`, { method: 'POST', body: { priceCents: 999999 } }).then(() => false, (e) => String(e).includes('PRICE_TOO_HIGH'));
  ok(tooHigh, 'a mistyped huge offer is refused');
  const j2 = await cust(`/kirigo/svc/send/jobs/${job.id}`);
  ok(j2.bids.length === 2 && j2.bids[0].priceCents === 380 && j2.bids[0].driver.firstName === 'Bwena', 'sender sees both offers, cheapest first, updated price');

  const b1 = j2.bids.find((b) => b.driver.firstName === 'Taam');
  const before = { cust: balance('acc_cust'), d1: balance(`acc_${D1}`) };
  const wrong = await cust(`/kirigo/send/jobs/${job.id}/choose`, { method: 'POST', body: { bidId: b1.bidId, priceCents: 400, key: `w${run}` } });
  ok(wrong.status === 'DECLINED' && wrong.reason === 'HOLD_AMOUNT_MISMATCH' && balance('acc_cust') === before.cust, 'paying the wrong amount is refused and refunded');
  const paid = await cust(`/kirigo/send/jobs/${job.id}/choose`, { method: 'POST', body: { bidId: b1.bidId, priceCents: 450, key: `p${run}` } });
  ok(paid.status === 'APPROVED' && paid.order?.status === 'DRIVER_ASSIGNED' && paid.order.driver.firstName === 'Taam', 'sender paid 450; Taam assigned straight away');
  const id = paid.order.id;
  ok(balance('acc_cust') === before.cust - 450, 'sender wallet down by the chosen price');
  const hold = sql(`SELECT * FROM escrow_holds WHERE ref='${id}'`)[0];
  ok(hold && balance(hold.id) === 450, 'money in the hold');
  ok(!(await d2.call('/send/jobs')).some((j) => j.id === job.id), 'job no longer open for other drivers');
  const dj = await d1.call(`/jobs/${id}`);
  ok(dj.send?.recipient?.name === 'Nei' && dj.dropoff.lat === TO.lat, 'the chosen driver now sees the recipient and exact drop-off');

  const inc = await rec('/kirigo/svc/incoming');
  ok(inc.length === 1 && inc[0].id === id && inc[0].from === 'Tekaai', 'recipient sees the parcel coming, from the sender by first name');
  const rc = await rec(`/kirigo/svc/incoming/${id}/handoff`), sc = await cust(`/kirigo/svc/orders/${id}/handoff`);
  ok(rc.code === sc.code && /^\d{4}$/.test(rc.code), 'recipient and sender see the same handoff code');
  const nosy = await kp(D2)(`/kirigo/svc/incoming/${id}/handoff`).then(() => false, () => true);
  ok(nosy, 'someone else cannot get the code');

  await d1.call(`/jobs/${id}/status`, { method: 'POST', body: { status: 'at_pickup', ...FROM } });
  await d1.call(`/jobs/${id}/status`, { method: 'POST', body: { status: 'picked_up', ...FROM } });
  const late = await cust(`/kirigo/svc/orders/${id}/cancel`, { method: 'POST', body: {} }).then(() => false, (e) => String(e).includes('TOO_LATE'));
  ok(late, 'no cancelling once the parcel is collected');
  await d1.call(`/jobs/${id}/status`, { method: 'POST', body: { status: 'arrived', ...TO } });
  const hp = (await d1.pic(`/photos?kind=handoff&order=${id}`)).photoId;
  await d1.call(`/jobs/${id}/handoff`, { method: 'POST', body: { code: rc.code, photoId: hp, at: Date.now(), ...TO, adultConfirmed: true } });
  const done = await cust(`/kirigo/svc/orders/${id}`);
  ok(done.status === 'ACCEPTED' && done.label === 'Delivered', 'handed over → done straight away');
  ok(balance(`acc_${D1}`) === before.d1 + 450 && balance(hold.id) === 0, 'driver got the whole 450; hold empty');

  // 2. nobody there → back to the sender
  const jb = await post('b');
  await d2.call(`/send/jobs/${jb.id}/bid`, { method: 'POST', body: { priceCents: 300 } });
  const bb = (await cust(`/kirigo/svc/send/jobs/${jb.id}`)).bids[0];
  const pb = await cust(`/kirigo/send/jobs/${jb.id}/choose`, { method: 'POST', body: { bidId: bb.bidId, priceCents: 300, key: `b${run}` } });
  const idb = pb.order.id, d2before = balance(`acc_${D2}`);
  for (const s of ['at_pickup', 'picked_up']) await d2.call(`/jobs/${idb}/status`, { method: 'POST', body: { status: s, ...FROM } });
  await d2.call(`/jobs/${idb}/status`, { method: 'POST', body: { status: 'arrived', ...TO } });
  const back = await d2.call(`/jobs/${idb}/not-delivered`, { method: 'POST', body: { reason: 'customer_absent', ...TO } });
  ok(back.status === 'PICKED_UP' && back.send.returning && back.dropoff.lat === FROM.lat, 'nobody there: driver heads back to the sender');
  ok(balance(`acc_${D2}`) === d2before + 300, 'driver is paid for the trip anyway');
  ok((await rec('/kirigo/svc/incoming')).every((p) => p.id !== idb), 'recipient no longer shows it as coming');
  const sb = await cust(`/kirigo/svc/orders/${idb}/handoff`);
  await d2.call(`/jobs/${idb}/status`, { method: 'POST', body: { status: 'arrived', ...FROM } });
  const hp2 = (await d2.pic(`/photos?kind=handoff&order=${idb}`)).photoId;
  await d2.call(`/jobs/${idb}/handoff`, { method: 'POST', body: { code: sb.code, photoId: hp2, at: Date.now(), ...FROM, adultConfirmed: true } });
  const ret = await cust(`/kirigo/svc/orders/${idb}`);
  ok(ret.status === 'ACCEPTED' && ret.label === 'Returned to you' && balance(`acc_${D2}`) === d2before + 300, 'sender got it back with their code; driver not paid twice');

  // 3. cancel before pickup, and a driver dropping a job
  const jc = await post('c');
  await d1.call(`/send/jobs/${jc.id}/bid`, { method: 'POST', body: { priceCents: 500 } });
  await d2.call(`/send/jobs/${jc.id}/bid`, { method: 'POST', body: { priceCents: 520 } });
  const bc = (await cust(`/kirigo/svc/send/jobs/${jc.id}`)).bids.find((b) => b.priceCents === 500);
  const c0 = balance('acc_cust');
  const pc = await cust(`/kirigo/send/jobs/${jc.id}/choose`, { method: 'POST', body: { bidId: bc.bidId, priceCents: 500, key: `c${run}` } });
  await d1.call(`/jobs/${pc.order.id}/release`, { method: 'POST' });
  const reopened = await cust(`/kirigo/svc/send/jobs/${jc.id}`);
  ok(balance('acc_cust') === c0 && reopened.status === 'open' && reopened.bids.length === 1 && reopened.bids[0].priceCents === 520, 'driver dropped it: full refund, job open again with the other offer');
  const bc2 = reopened.bids[0];
  const pc2 = await cust(`/kirigo/send/jobs/${jc.id}/choose`, { method: 'POST', body: { bidId: bc2.bidId, priceCents: 520, key: `c2${run}` } });
  await cust(`/kirigo/svc/orders/${pc2.order.id}/cancel`, { method: 'POST', body: {} });
  ok(balance('acc_cust') === c0, 'sender cancelled before pickup: full refund');

  const jd = await post('d');
  await cust(`/kirigo/svc/send/jobs/${jd.id}/cancel`, { method: 'POST', body: {} });
  const bidClosed = await d1.call(`/send/jobs/${jd.id}/bid`, { method: 'POST', body: { priceCents: 300 } }).then(() => false, (e) => String(e).includes('JOB_CLOSED'));
  ok(bidClosed, 'a cancelled request takes no more offers');

  ok(sql('SELECT SUM(balance) AS s FROM accounts')[0].s === 0, 'KiriPay ledger still sums to zero');
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
