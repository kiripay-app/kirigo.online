import { adultsOnly } from '@kirigo/shared';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, captureToken, client, explain, money, setToken } from '../api';
import { CameraShot, QrScan } from './camera';
import { addPending, checkQrOffline, pending, refreshKey, syncPending, toDataUrl } from './offline';

const call = client('driver', () => location.reload());
type Pos = { lat: number; lng: number };

// ------------------------------------------------------------------ location

let lastPos: Pos | null = null;
const watchers = new Set<(p: Pos) => void>();
function startGps() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    (p) => { lastPos = { lat: p.coords.latitude, lng: p.coords.longitude }; watchers.forEach((w) => w(lastPos!)); },
    () => {}, { enableHighAccuracy: true, maximumAge: 5000 },
  );
}
const here = (): Pos => lastPos ?? { lat: 0, lng: 0 };

// ------------------------------------------------------------------ app shell

function App() {
  const [token] = useState(() => captureToken('driver'));
  const [me, setMe] = useState<any>(null);
  const [state, setState] = useState<'loading' | 'signin' | 'apply' | 'ready'>(token ? 'loading' : 'signin');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setMe(await call('/api/driver/me'));
      setState('ready');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NOT_A_DRIVER') setState('apply');
      else if (e instanceof ApiError && e.status === 401) setState('signin');
      else { setErr(explain(e)); setState('ready'); }
    }
  }, []);
  useEffect(() => { if (token) void load(); startGps(); void refreshKey(); }, [token, load]);

  if (state === 'signin') return <SignIn />;
  if (state === 'loading') return <div className="app"><p>Loading…</p></div>;
  if (state === 'apply') return <Apply onDone={(t) => { setToken('driver', t); location.reload(); }} />;
  if (!me) return <div className="app">{err && <div className="error">{err}</div>}<button onClick={load}>Try again</button></div>;
  if (me.status === 'pending') return <Pending me={me} />;
  if (me.status !== 'approved') return <div className="app"><Top /><div className="error">Your driver account is {me.status}. Contact KiriGo support.</div></div>;
  return <Home me={me} reload={load} />;
}

function Top({ right }: { right?: React.ReactNode }) {
  return <div className="top"><span className="logo">KiriGo Driver</span>{right}</div>;
}

function SignIn() {
  return (
    <div className="app">
      <Top />
      <div className="card">
        <h2>Mauri!</h2>
        <p>Sign in with your KiriPay account. You'll be paid into your KiriPay wallet, and you need two-step sign-in turned on in KiriPay.</p>
        <a className="btn block" href="/auth/start?app=driver">Sign in with KiriPay</a>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ sign-up

function Apply({ onDone }: { onDone: (token: string) => void }) {
  const [f, setF] = useState({ firstName: '', type: 'motorbike', plate: '', canBulky: false, base: '2.00', perKm: '1.00', minimum: '3.00', night: '0', bulky: '0', terms: false });
  const [vehicle, setVehicle] = useState<string | null>(null);
  const [licence, setLicence] = useState<string | null>(null);
  const [shoot, setShoot] = useState<'vehicle' | 'licence' | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const c = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const cents = (s: string) => Math.round(Number(s || 0) * 100);
  const upload = async (kind: 'vehicle' | 'licence', b: Blob) => {
    const r = await call(`/api/driver/signup/photos?kind=${kind}`, { raw: b });
    kind === 'vehicle' ? setVehicle(r.photoId) : setLicence(r.photoId);
    setShoot(null);
  };
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const r = await call('/api/driver/signup/apply', { body: {
        firstName: f.firstName, vehicle: { type: f.type, plate: f.plate, canBulky: f.canBulky, photoId: vehicle }, licencePhotoId: licence ?? undefined,
        rateCard: { baseCents: cents(f.base), perKmCents: cents(f.perKm), minimumCents: cents(f.minimum), nightCents: cents(f.night), bulkyCents: cents(f.bulky) },
        acceptTerms: f.terms,
      } });
      onDone(r.token);
    } catch (e) { setErr(explain(e)); } finally { setBusy(false); }
  };
  if (shoot) return <div className="app"><Top /><h3>{shoot === 'vehicle' ? 'Photo of your vehicle with the plate showing' : 'Photo of your driver’s licence'}</h3><CameraShot label="Take photo" onShot={(b) => upload(shoot, b)} /><button className="secondary block" style={{ marginTop: 8 }} onClick={() => setShoot(null)}>Cancel</button></div>;
  return (
    <div className="app">
      <Top />
      <h2>Drive with KiriGo</h2>
      <p>Set your own prices and keep 100% of every delivery charge. The first 3 months are free.</p>
      {err && <div className="error">{err}</div>}
      <div className="card">
        <label>First name (shown to customers)</label><input value={f.firstName} onChange={c('firstName')} />
        <label>Vehicle</label>
        <select value={f.type} onChange={c('type')}><option value="motorbike">Motorbike</option><option value="car">Car</option><option value="van">Van</option><option value="truck">Truck</option></select>
        <label>Plate number</label><input value={f.plate} onChange={c('plate')} />
        <div className="check"><input type="checkbox" checked={f.canBulky} onChange={c('canBulky')} />I can carry bulky items</div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="secondary" onClick={() => setShoot('vehicle')}>{vehicle ? '✓ Vehicle photo' : 'Vehicle photo'}</button>
          <button className="secondary" onClick={() => setShoot('licence')}>{licence ? '✓ Licence photo' : 'Licence photo'}</button>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>An admin checks your licence matches the photo on your KiriPay ID before you can drive.</p>
      </div>
      <div className="card">
        <h3>Your prices</h3>
        <p className="small">Customers see your price for each trip: base fee + price per km, never less than your minimum.</p>
        <div className="row"><div><label>Base fee $</label><input inputMode="decimal" value={f.base} onChange={c('base')} /></div><div><label>Per km $</label><input inputMode="decimal" value={f.perKm} onChange={c('perKm')} /></div></div>
        <div className="row"><div><label>Minimum $</label><input inputMode="decimal" value={f.minimum} onChange={c('minimum')} /></div><div><label>Night extra $</label><input inputMode="decimal" value={f.night} onChange={c('night')} /></div></div>
        <label>Bulky item extra $</label><input inputMode="decimal" value={f.bulky} onChange={c('bulky')} />
      </div>
      <div className="check"><input type="checkbox" checked={f.terms} onChange={c('terms')} />I accept the KiriGo driver terms: I'm responsible for goods while I carry them, my location is tracked during jobs, and I take a photo at every handoff.</div>
      <button className="block" disabled={busy || !f.firstName || !vehicle || (f.type !== 'motorbike' && !licence) || !f.terms} onClick={submit}>Apply</button>
    </div>
  );
}

function Pending({ me }: { me: any }) {
  return <div className="app"><Top /><div className="card"><h2>Thanks, {me.firstName}!</h2><p>Your driver ID is <b>{me.driverCode}</b>. An admin is checking your licence and vehicle. You'll be able to go online once you're approved.</p></div></div>;
}

// ------------------------------------------------------------------ home

function Home({ me, reload }: { me: any; reload: () => void }) {
  const [tab, setTab] = useState<'work' | 'me'>('work');
  const [offers, setOffers] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [selfie, setSelfie] = useState(false);
  const [err, setErr] = useState('');
  const [queued, setQueued] = useState(pending().length);

  const refresh = useCallback(async () => {
    try {
      const [o, j] = await Promise.all([call('/api/driver/offers'), call('/api/driver/jobs')]);
      setOffers(o); setJobs(j);
    } catch (e) { if (!(e instanceof ApiError && e.code === 'OFFLINE')) setErr(explain(e)); }
  }, []);

  // offers arrive over the socket instantly; polling is the fallback
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, me.online ? 5000 : 30000);
    let ws: WebSocket | null = null;
    if (me.online) {
      call('/api/driver/ws-ticket').then((r) => {
        ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}${r.ws}?ticket=${encodeURIComponent(r.ticket)}`);
        ws.onmessage = () => void refresh();
      }).catch(() => {});
    }
    return () => { clearInterval(t); ws?.close(); };
  }, [me.online, refresh]);

  // where we are, while online and free (not stored, just for matching)
  useEffect(() => {
    if (!me.online || jobs.length) return;
    const t = setInterval(() => { if (lastPos) void call('/api/driver/position', { body: lastPos }).catch(() => {}); }, 30_000);
    return () => clearInterval(t);
  }, [me.online, jobs.length]);

  // send handoffs saved while offline
  useEffect(() => {
    const go = () => syncPending(call).then((n) => { if (n) { setQueued(pending().length); void refresh(); } }).catch(() => {});
    void go();
    window.addEventListener('online', go);
    return () => window.removeEventListener('online', go);
  }, [refresh]);

  const goOnline = async (b: Blob) => {
    setErr('');
    try {
      const p = here();
      const ph = await call('/api/driver/photos?kind=selfie', { raw: b });
      await call('/api/driver/online', { body: { selfiePhotoId: ph.photoId, ...p } });
      setSelfie(false); reload();
    } catch (e) { setErr(explain(e)); setSelfie(false); }
  };
  const goOffline = async () => { await call('/api/driver/offline', { method: 'POST' }); reload(); };

  if (open) return <Job id={open} onClose={() => { setOpen(null); setQueued(pending().length); void refresh(); }} />;
  if (selfie) return <div className="app"><Top /><h3>Quick selfie to start your shift</h3><p className="small">So nobody else can drive on your account.</p><CameraShot facing="user" label="Take selfie and go online" onShot={goOnline} /><button className="secondary block" style={{ marginTop: 8 }} onClick={() => setSelfie(false)}>Cancel</button></div>;

  return (
    <div className="app">
      <Top right={<span className={`pill ${me.online ? 'good' : ''}`}>{me.online ? 'Online' : 'Offline'}</span>} />
      <nav className="tabs"><button className={tab === 'work' ? 'on' : ''} onClick={() => setTab('work')}>Work</button><button className={tab === 'me' ? 'on' : ''} onClick={() => setTab('me')}>Me</button></nav>
      {err && <div className="error">{err}</div>}
      {queued > 0 && <div className="notice">{queued} handoff(s) saved offline — they'll send when you have signal. You're paid when they do.</div>}
      {tab === 'me' ? <Me me={me} reload={reload} /> : (
        <>
          {me.fee?.due && <div className="notice">Your monthly fee of {money(me.fee.amountCents)} is due. <button onClick={async () => { try { await call('/api/driver/fee/pay', { method: 'POST' }); reload(); } catch (e) { setErr(explain(e)); } }}>Pay from KiriPay</button></div>}
          {!me.online
            ? <button className="block" disabled={me.fee?.due} onClick={() => setSelfie(true)}>Go online</button>
            : <button className="secondary block" disabled={jobs.length > 0} onClick={goOffline}>Go offline</button>}
          {offers.map((o) => <Offer key={o.offerId} o={o} onDone={(job) => { void refresh(); if (job) setOpen(job); }} />)}
          {jobs.map((j) => (
            <div className="card" key={j.id} onClick={() => setOpen(j.id)} style={{ cursor: 'pointer' }}>
              <div className="between"><b>{j.kind === 'return' ? 'Return' : j.kind === 'correction' ? 'Correct item' : 'Delivery'} · {j.shop.name}</b><span className="pill">{j.label}</span></div>
              <p className="small">{money(j.deliveryCents)} · {(j.distanceM / 1000).toFixed(1)} km</p>
            </div>
          ))}
          {me.online && !offers.length && !jobs.length && <p className="muted" style={{ marginTop: 16 }}>Waiting for jobs… keep the app open.</p>}
        </>
      )}
    </div>
  );
}

function Offer({ o, onDone }: { o: any; onDone: (jobId: string | null) => void }) {
  const [left, setLeft] = useState(Math.max(0, Math.round((Date.parse(o.expiresAt) - Date.now()) / 1000)));
  const [err, setErr] = useState('');
  useEffect(() => { const t = setInterval(() => setLeft(Math.max(0, Math.round((Date.parse(o.expiresAt) - Date.now()) / 1000))), 500); return () => clearInterval(t); }, [o.expiresAt]);
  const act = async (a: 'accept' | 'decline') => {
    try { await call(`/api/driver/offers/${o.offerId}/${a}`, { method: 'POST' }); onDone(a === 'accept' ? o.orderId : null); }
    catch (e) { setErr(explain(e)); setTimeout(() => onDone(null), 1500); }
  };
  return (
    <div className="card offer">
      <div className="between"><b>{o.kind === 'return' ? 'Return pickup' : o.kind === 'correction' ? 'Correct item' : 'New delivery'}</b><span className="countdown pill warn">{left}s</span></div>
      <div className="big">{money(o.priceCents)}</div>
      <p className="small">{o.shop} · {(o.distanceM / 1000).toFixed(1)} km · {o.size} · customer rating {typeof o.customerRating === 'number' ? o.customerRating.toFixed(1) : o.customerRating}</p>
      {err && <div className="error">{err}</div>}
      <div className="row"><button className="secondary" onClick={() => act('decline')}>Decline</button><button onClick={() => act('accept')} disabled={!left}>Accept</button></div>
    </div>
  );
}

// ------------------------------------------------------------------ one job

const mapsLink = (p: { lat: number; lng: number }) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;

function Job({ id, onClose }: { id: string; onClose: () => void }) {
  const [o, setO] = useState<any>(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'view' | 'handoff' | 'pickupCode'>('view');
  const load = useCallback(async () => { try { setO(await call(`/api/driver/jobs/${id}`)); } catch (e) { setErr(explain(e)); } }, [id]);
  useEffect(() => { void load(); }, [load]);

  // GPS from accept to handoff, batched every ~12 s so patchy signal doesn't lose points
  const buf = useRef<{ lat: number; lng: number; at: number }[]>([]);
  useEffect(() => {
    if (!o || !['DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ARRIVED'].includes(o.status)) return;
    const w = (p: Pos) => buf.current.push({ ...p, at: Date.now() });
    watchers.add(w);
    const t = setInterval(async () => {
      if (!buf.current.length) return;
      const points = buf.current.splice(0, 200);
      try { await call(`/api/driver/jobs/${id}/gps`, { body: { points } }); } catch { buf.current.unshift(...points); }
    }, 12_000);
    return () => { watchers.delete(w); clearInterval(t); };
  }, [o?.status, id]);

  const step = async (status: 'at_pickup' | 'picked_up' | 'arrived', extra: any = {}) => {
    setErr('');
    try { setO(await call(`/api/driver/jobs/${id}/status`, { body: { status, ...here(), ...extra } })); setMode('view'); } catch (e) { setErr(explain(e)); }
  };
  const giveBack = async () => { if (!confirm('Give this job back? It counts against your record.')) return; try { await call(`/api/driver/jobs/${id}/release`, { method: 'POST' }); onClose(); } catch (e) { setErr(explain(e)); } };
  const notDelivered = async (reason: 'no_adult' | 'customer_absent') => { try { await call(`/api/driver/jobs/${id}/not-delivered`, { body: { reason, ...here() } }); onClose(); } catch (e) { setErr(explain(e)); } };

  if (!o) return <div className="app"><Top />{err ? <div className="error">{err}</div> : <p>Loading…</p>}</div>;
  const isReturn = o.kind === 'return';
  const order = ['DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ARRIVED', 'HANDED_OVER'];
  const at = order.indexOf(o.status);
  if (mode === 'handoff') return <Handoff o={o} onDone={() => { setMode('view'); void load(); }} onCancel={() => setMode('view')} />;
  if (mode === 'pickupCode') return <PickupFromCustomer onCode={(code, token) => step('picked_up', { code, token })} onCancel={() => setMode('view')} err={err} />;
  return (
    <div className="app">
      <Top right={<button className="secondary" onClick={onClose}>Back</button>} />
      <div className="steps">{order.map((s, i) => <span key={s} className={i <= at ? 'on' : ''} />)}</div>
      <h2>{o.label}</h2>
      {err && <div className="error">{err}</div>}
      <div className="card">
        <div className="between"><b>{isReturn ? 'Collect from customer' : o.shop.name}</b><a href={mapsLink(o.shop.pickup)} target="_blank" rel="noreferrer">Directions</a></div>
        {!isReturn && o.shop.note && <p className="small">{o.shop.note}</p>}
        {!isReturn && <p className="small">{o.shopReady ? '✓ Ready for pickup' : 'Shop is still preparing'}</p>}
      </div>
      <div className="card">
        <div className="between"><b>{isReturn ? `Drop at ${o.shop.name}` : 'Customer'}</b><a href={mapsLink(o.dropoff)} target="_blank" rel="noreferrer">Directions</a></div>
        {o.dropoff.landmark && <p className="small">{o.dropoff.landmark}</p>}
        <p className="small">You earn {money(o.deliveryCents)}</p>
      </div>
      {o.status === 'DRIVER_ASSIGNED' && <button className="block" onClick={() => step('at_pickup')}>I'm at the {isReturn ? 'customer' : 'shop'}</button>}
      {o.status === 'AT_SHOP' && (isReturn
        ? <button className="block" onClick={() => setMode('pickupCode')}>Collect the item (customer's code)</button>
        : <button className="block" onClick={() => step('picked_up')}>I have the package</button>)}
      {o.status === 'PICKED_UP' && <button className="block" onClick={() => step('arrived')}>I've arrived</button>}
      {(o.status === 'ARRIVED' || o.status === 'PICKED_UP') && <button className="block" style={{ marginTop: 8 }} onClick={() => setMode('handoff')}>{isReturn ? 'Drop off at the shop' : 'Hand over'}</button>}
      {o.status === 'ARRIVED' && !isReturn && (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="secondary" onClick={() => notDelivered('customer_absent')}>Nobody home</button>
          <button className="secondary" onClick={() => notDelivered('no_adult')}>No adult (after 10 pm)</button>
        </div>
      )}
      {['DRIVER_ASSIGNED', 'AT_SHOP'].includes(o.status) && <button className="secondary block" style={{ marginTop: 16 }} onClick={giveBack}>Give job back</button>}
      {o.status === 'HANDED_OVER' && <Rate orderId={o.id} isReturn={isReturn} onDone={onClose} />}
    </div>
  );
}

function PickupFromCustomer({ onCode, onCancel, err }: { onCode: (code?: string, token?: string) => void; onCancel: () => void; err: string }) {
  const [code, setCode] = useState('');
  return (
    <div className="app"><Top /><h3>Scan the customer's return QR</h3>{err && <div className="error">{err}</div>}
      <QrScan onCode={(t) => onCode(undefined, t)} />
      <label>…or type their 4-digit code</label>
      <div className="row"><input inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /><button disabled={code.length !== 4} onClick={() => onCode(code)}>Confirm</button></div>
      <button className="secondary block" style={{ marginTop: 8 }} onClick={onCancel}>Back</button>
    </div>
  );
}

/** Scan QR (works offline) or type code (online) → photo → who received it → done. */
function Handoff({ o, onDone, onCancel }: { o: any; onDone: () => void; onCancel: () => void }) {
  const isReturn = o.kind === 'return';
  const [token, setToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [photo, setPhoto] = useState<{ b: Blob; at: number } | null>(null);
  const [f, setF] = useState({ someoneElse: false, name: '', child: false, adult: false, faceRefused: false });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const late = adultsOnly(Date.now(), '22:00');
  const scanned = useCallback((t: string) => {
    const r = checkQrOffline(t, o.id);
    if (r.ok || r.reason === 'no_key') setToken(t);
    else setErr(r.reason === 'wrong_order' ? 'That QR is for a different order.' : 'That QR is not valid.');
  }, [o.id]);
  const verified = isReturn || !!token || code.length === 4;

  const finish = async () => {
    if (!photo) return;
    setBusy(true); setErr('');
    const p = here();
    const details = { receivedBySomeoneElse: f.someoneElse, receiverName: f.name, receiverIsChild: f.child, adultConfirmed: f.adult, faceRefused: f.faceRefused };
    try {
      const ph = await call(`/api/driver/photos?kind=handoff&order=${o.id}`, { raw: photo.b, headers: { 'x-photo-lat': String(p.lat), 'x-photo-lng': String(p.lng), 'x-photo-at': String(photo.at) } });
      await call(`/api/driver/jobs/${o.id}/handoff`, { body: { ...(token ? { token } : { code: isReturn ? '0000' : code }), photoId: ph.photoId, at: photo.at, ...p, ...details } });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'OFFLINE' && token && !isReturn) {
        addPending({ orderId: o.id, token, at: photo.at, ...p, photo: await toDataUrl(photo.b), ...details });
        alert('Saved. No signal right now — it will send automatically and you will be paid then.');
        onDone();
      } else setErr(explain(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="app">
      <Top right={<button className="secondary" onClick={onCancel}>Back</button>} />
      <h2>{isReturn ? 'Drop off the return' : 'Hand over'}</h2>
      {err && <div className="error">{err}</div>}
      {!isReturn && !verified && (
        <div className="card">
          <h3>1. Scan the customer's QR</h3>
          <QrScan onCode={scanned} />
          <label>…or type their 4-digit code (needs signal)</label>
          <input inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
        </div>
      )}
      {verified && !photo && (
        <div className="card">
          <h3>{isReturn ? 'Photo of the item at the shop' : '2. Photo of the person receiving it, holding the package'}</h3>
          {!isReturn && <div className="check"><input type="checkbox" checked={f.faceRefused} onChange={(e) => setF({ ...f, faceRefused: e.target.checked })} />They don't want their face photographed (take the package being handed over)</div>}
          <CameraShot label="Take photo" onShot={(b, at) => setPhoto({ b, at })} />
        </div>
      )}
      {verified && photo && (
        <div className="card">
          <img className="shot" src={URL.createObjectURL(photo.b)} alt="" />
          {!isReturn && <>
            <div className="check"><input type="checkbox" checked={f.someoneElse} onChange={(e) => setF({ ...f, someoneElse: e.target.checked })} />Received by someone else</div>
            {f.someoneElse && <><label>Their name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></>}
            <div className="check"><input type="checkbox" checked={f.child} onChange={(e) => setF({ ...f, child: e.target.checked, adult: e.target.checked ? false : f.adult })} />Received by a child</div>
            {late && <div className="notice">After 10 pm only an adult may receive an order.</div>}
            {late && <div className="check"><input type="checkbox" checked={f.adult} disabled={f.child} onChange={(e) => setF({ ...f, adult: e.target.checked })} />An adult received it</div>}
          </>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="secondary" onClick={() => setPhoto(null)}>Retake</button>
            <button disabled={busy || (late && !isReturn && (!f.adult || f.child))} onClick={finish}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Rate({ orderId, isReturn, onDone }: { orderId: string; isReturn: boolean; onDone: () => void }) {
  const [stars, setStars] = useState(5);
  const [shopStars, setShopStars] = useState(5);
  const [reasons, setReasons] = useState<string[]>([]);
  const tags = ['great_customer', 'not_home', 'wrong_pin', 'long_wait', 'rude'];
  const send = async () => {
    try {
      await call(`/api/driver/jobs/${orderId}/rate`, { body: { ratings: isReturn ? [{ to: 'shop', stars: shopStars }] : [{ to: 'customer', stars, reasons }, { to: 'shop', stars: shopStars }] } });
    } catch { /* rating is optional */ }
    onDone();
  };
  const Stars = ({ v, set }: { v: number; set: (n: number) => void }) => <div className="row">{[1, 2, 3, 4, 5].map((n) => <button key={n} className={n <= v ? '' : 'secondary'} onClick={() => set(n)}>★</button>)}</div>;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Done! You've been paid.</h3>
      {!isReturn && <><label>Rate the customer</label><Stars v={stars} set={setStars} />
        <div style={{ marginTop: 8 }}>{tags.map((t) => <span key={t} className={`pill ${reasons.includes(t) ? 'warn' : ''}`} style={{ margin: 3, cursor: 'pointer' }} onClick={() => setReasons(reasons.includes(t) ? reasons.filter((x) => x !== t) : [...reasons, t])}>{t.replace(/_/g, ' ')}</span>)}</div></>}
      <label>Rate the shop</label><Stars v={shopStars} set={setShopStars} />
      <button className="block" style={{ marginTop: 12 }} onClick={send}>Send ratings</button>
      <p className="small muted" style={{ marginTop: 8 }}>Ratings stay hidden until the other side rates you too.</p>
    </div>
  );
}

// ------------------------------------------------------------------ me

function Me({ me, reload }: { me: any; reload: () => void }) {
  const [earn, setEarn] = useState<any[]>([]);
  const [rc, setRc] = useState(me.rateCard);
  const [msg, setMsg] = useState('');
  useEffect(() => { call('/api/driver/earnings').then((r) => setEarn(r.days)).catch(() => {}); }, []);
  const save = async () => {
    try { await call('/api/driver/rate-card', { method: 'PUT', body: { baseCents: rc.base_cents, perKmCents: rc.per_km_cents, minimumCents: rc.minimum_cents, nightCents: rc.night_cents, bulkyCents: rc.bulky_cents } }); setMsg('Prices saved'); reload(); }
    catch (e) { setMsg(explain(e)); }
  };
  const f = (k: string) => (e: any) => setRc({ ...rc, [k]: Math.round(Number(e.target.value || 0) * 100) });
  return (
    <>
      <div className="card">
        <div className="between"><h3>{me.firstName} · {me.driverCode}</h3><span className="pill">{me.rating ? `★ ${me.rating.toFixed(1)}` : 'New'}</span></div>
        <p className="small">{me.deliveries} deliveries · {me.vehicle?.type} {me.vehicle?.plate}</p>
        <p className="small">Monthly fee: {me.fee?.freeUntil && Date.parse(me.fee.freeUntil) > Date.now() ? `free until ${new Date(me.fee.freeUntil).toLocaleDateString('en-GB')}` : me.fee?.paidUntil ? `paid until ${new Date(me.fee.paidUntil).toLocaleDateString('en-GB')}` : money(me.fee?.amountCents)}</p>
      </div>
      <div className="card">
        <h3>Earnings</h3>
        {!earn.length ? <p className="small">No deliveries yet.</p> : <table><tbody>{earn.map((d) => <tr key={d.day}><td>{d.day.split('-').reverse().join('/')}</td><td>{d.trips} trips</td><td>{money(d.cents)}</td></tr>)}</tbody></table>}
      </div>
      <div className="card">
        <h3>My prices</h3>
        {me.online && <p className="small">Go offline to change your prices.</p>}
        <div className="row"><div><label>Base $</label><input defaultValue={(rc.base_cents / 100).toFixed(2)} onChange={f('base_cents')} /></div><div><label>Per km $</label><input defaultValue={(rc.per_km_cents / 100).toFixed(2)} onChange={f('per_km_cents')} /></div></div>
        <div className="row"><div><label>Minimum $</label><input defaultValue={(rc.minimum_cents / 100).toFixed(2)} onChange={f('minimum_cents')} /></div><div><label>Night $</label><input defaultValue={(rc.night_cents / 100).toFixed(2)} onChange={f('night_cents')} /></div></div>
        <label>Bulky $</label><input defaultValue={(rc.bulky_cents / 100).toFixed(2)} onChange={f('bulky_cents')} />
        <button className="block" style={{ marginTop: 10 }} disabled={me.online} onClick={save}>Save prices</button>
        {msg && <p className="small" style={{ marginTop: 8 }}>{msg}</p>}
      </div>
      <button className="secondary block" onClick={() => { setToken('driver', null); location.reload(); }}>Sign out</button>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
