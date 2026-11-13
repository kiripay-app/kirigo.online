import { adultsOnly } from '@kirigo/shared';
import { StrictMode, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, captureToken, client, explain, money, sessionClaims, setToken } from '../api';
import { CameraShot, QrScan } from './camera';
// the map (Leaflet + map tiles) loads only when the "where am I seen" map is opened: a much smaller first download
const WhereMap = lazy(() => import('./where').then((m) => ({ default: m.WhereMap })));
import { appUpdate, isApp, openDownload, setupPush, startBackgroundLocation, stopBackgroundLocation, type PublicApp } from './native';
import { ring, unlockSounds } from './sounds';

unlockSounds();
import { addPending, checkQrOffline, pending, refreshKey, syncPending, toDataUrl } from './offline';

const call = client('driver', () => location.reload());
type Pos = { lat: number; lng: number };

// ------------------------------------------------------------------ guided prices, sides, chat

type Core = { baseCents: number; perKmCents: number; minimumCents: number };
type Guide = { rates: Record<'delivery_motorbike' | 'delivery_car' | 'ride_car', { recommended: Core; lowest: Core; highest: Core }>; band: { belowPct: number; abovePct: number } };
const kindFor = (service: 'delivery' | 'ride', type: string) => (service === 'ride' ? 'ride_car' : type === 'motorbike' ? 'delivery_motorbike' : 'delivery_car') as keyof Guide['rates'];
const dollars = (c: number) => (c / 100).toFixed(2);

function useGuide(path = '/api/driver/rates') {
  const [g, setG] = useState<Guide | null>(null);
  useEffect(() => { call(path).then(setG).catch(() => {}); }, [path]);
  return g;
}

/** Under each price box: KiriGo's recommended value and the allowed range; red when outside it. */
function PriceHint({ g, kind, field, value }: { g: Guide | null; kind: keyof Guide['rates']; field: keyof Core; value: string }) {
  if (!g) return null;
  const r = g.rates[kind];
  const c = Math.round(Number(value || 0) * 100);
  const out = c < r.lowest[field] || c > r.highest[field];
  return <p className="small" style={{ margin: '2px 0 6px', color: out ? '#fca5a5' : undefined }}>
    Suggested ${dollars(r.recommended[field])} · allowed ${dollars(r.lowest[field])}–${dollars(r.highest[field])}
  </p>;
}

function GuideNote({ g }: { g: Guide | null }) {
  if (!g) return null;
  return <p className="small">KiriGo suggests prices that most people on Tarawa can afford. You choose your own, from {g.band.belowPct}% below to {g.band.abovePct}% above the suggestion. Drivers close to it get a <b>Fair price</b> badge that customers see.</p>;
}

/** Lagoon side / ocean side of the road: how people on Tarawa say where to stop. */
export function SideTag({ side }: { side?: string | null }) {
  if (!side) return null;
  return <span className="pill" style={{ marginLeft: 6, background: side === 'lagoon' ? '#0e4f5c' : '#1e3a8a' }}>{side === 'lagoon' ? 'Lagoon side' : 'Ocean side'}</span>;
}

const DRIVER_REPLIES = ['On my way', "I'm outside", "I can't find you, please call", 'Please come to the road'];

/** Messages with the customer, newest first. Their one-tap replies to "I'm here" show up here. */
function Chat({ orderId }: { orderId: string }) {
  const [msgs, setMsgs] = useState<any[]>([]);
  const [text, setText] = useState('');
  const load = useCallback(() => call(`/api/driver/jobs/${orderId}/messages`).then(setMsgs).catch(() => {}), [orderId]);
  useEffect(() => { void load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  const send = async (body: string) => { if (!body.trim()) return; try { await call(`/api/driver/jobs/${orderId}/messages`, { body: { body } }); setText(''); void load(); } catch { /* try again */ } };
  const last = [...msgs].reverse().find((m) => m.from_type === 'customer');
  return (
    <div className="card">
      <h3>Messages</h3>
      {last && <div className="notice" style={{ marginBottom: 8 }}>Customer: <b>{last.body}</b></div>}
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{DRIVER_REPLIES.map((r) => <button key={r} className="secondary" style={{ flex: '0 0 auto' }} onClick={() => send(r)}>{r}</button>)}</div>
      <div className="row" style={{ marginTop: 8 }}><input aria-label="Message to the customer" placeholder="Message" maxLength={300} value={text} onChange={(e) => setText(e.target.value)} /><button onClick={() => send(text)}>Send</button></div>
      {msgs.slice(-6).reverse().map((m, i) => <p key={i} className="small" style={{ margin: '4px 0' }}><b>{m.from_type === 'driver' ? 'You' : 'Customer'}:</b> {m.body}</p>)}
    </div>
  );
}

/** "I'm here": marks you arrived and rings the customer with your car's colour and plate. */
function HereButton({ orderId, onDone, again, label = "I'm here" }: { orderId: string; onDone: (o: any) => void; again?: boolean; label?: string }) {
  const [err, setErr] = useState('');
  const ring = async () => { setErr(''); try { onDone(await call(`/api/driver/jobs/${orderId}/here`, { body: here() })); } catch (e) { setErr(e instanceof ApiError && e.code === 'JUST_RANG' ? 'You just let them know. Try again in a minute.' : explain(e)); } };
  return <>
    <button className={again ? 'secondary block' : 'block'} style={again ? { marginTop: 8 } : undefined} onClick={ring}>{again ? 'Let them know again' : label}</button>
    {err && <p className="small">{err}</p>}
  </>;
}

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
  if (state === 'apply') {
    const claims = sessionClaims('driver');
    if (!claims.mfa || (claims.kyc ?? 1) < 2) return <GetReady twoStep={!!claims.mfa} idOk={(claims.kyc ?? 1) >= 2} />;
    return <Apply onDone={(t) => { setToken('driver', t); location.reload(); }} />;
  }
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
      <GetTheApp />
    </div>
  );
}

/** On the website (not inside the app): the Android app, with its version and size, when one is published. */
function GetTheApp() {
  const [app, setApp] = useState<PublicApp | null>(null);
  useEffect(() => { if (!isApp) void appUpdate().then((r) => setApp(r?.app ?? null)); }, []);
  if (isApp || !app?.available) return null;
  return (
    <div className="card">
      <h3>Get the Android app</h3>
      <p className="small">Job offers ring your phone even when it's locked, and your location keeps going while you use other apps. Version {app.version}, {((app.size ?? 0) / 1048576).toFixed(1)} MB.</p>
      <a className="btn block" href={app.url} download>Download KiriGo Driver for Android</a>
      <p className="small muted">After it downloads, open it and allow "Install unknown apps" for your browser when Android asks.</p>
    </div>
  );
}

/** Inside the app: a newer version is on kirigo.online. */
function UpdateNotice() {
  const [u, setU] = useState<PublicApp | null>(null);
  const [manual, setManual] = useState(false);
  useEffect(() => { if (isApp) void appUpdate().then((r) => { if (r?.newer) setU(r.app); }); }, []);
  if (!u) return null;
  return (
    <div className="notice">
      A new version of KiriGo Driver ({u.version}) is ready.{' '}
      {manual ? <>Open <b>kirigo.online/driver</b> in Chrome and tap Download.</>
        : <button className="secondary" onClick={() => void openDownload(u.url!).then((ok) => { if (!ok) setManual(true); })}>Download update</button>}
    </div>
  );
}

// ------------------------------------------------------------------ sign-up

/** Before the form: KiriPay must have checked their ID, and two-step sign-in must be on. */
function GetReady({ twoStep, idOk }: { twoStep: boolean; idOk: boolean }) {
  const again = () => { setToken('driver', null); location.href = '/auth/start?app=driver'; };
  return (
    <div className="app">
      <Top />
      <h2>Get your KiriPay account ready</h2>
      <p>Before you can sign up to drive, finish these in the KiriPay app. It takes a day or so for your ID to be checked.</p>
      <div className="card">
        <div className="between"><b>Your ID checked (Level 2)</b><span className={`pill ${idOk ? 'good' : 'warn'}`}>{idOk ? 'Done' : 'To do'}</span></div>
        <p className="small">In KiriPay open Verify your account, choose Level 2 and send a photo of your passport or driver's licence plus a selfie.</p>
        <div className="between" style={{ marginTop: 12 }}><b>Two-step sign-in</b><span className={`pill ${twoStep ? 'good' : 'warn'}`}>{twoStep ? 'Done' : 'To do'}</span></div>
        <p className="small">In KiriPay open Security and set up two-step sign-in with an authenticator app.</p>
      </div>
      <a className="btn block" href="https://kiripay.online/kirigo">Step-by-step guide</a>
      <button className="secondary block" style={{ marginTop: 8 }} onClick={again}>I've done both — check again</button>
    </div>
  );
}

function Apply({ onDone }: { onDone: (token: string) => void }) {
  const [f, setF] = useState({ firstName: '', type: 'motorbike', plate: '', colour: '', canBulky: false, base: '', perKm: '', minimum: '', night: '0', bulky: '0', terms: false });
  const g = useGuide('/api/driver/signup/rates');
  const kind = kindFor('delivery', f.type);
  const [touched, setTouched] = useState(false);
  // start from KiriGo's suggestion for the vehicle, until the driver changes a price themselves
  useEffect(() => {
    if (!g || touched) return;
    const r = g.rates[kind].recommended;
    setF((x) => ({ ...x, base: dollars(r.baseCents), perKm: dollars(r.perKmCents), minimum: dollars(r.minimumCents) }));
  }, [g, kind, touched]);
  const price = (k: 'base' | 'perKm' | 'minimum') => (e: any) => { setTouched(true); setF({ ...f, [k]: e.target.value }); };
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
        firstName: f.firstName, vehicle: { type: f.type, plate: f.plate, colour: f.colour, canBulky: f.canBulky, photoId: vehicle }, licencePhotoId: licence ?? undefined,
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
      <p>Choose your own prices and keep 100% of every delivery charge. The first 3 months are free.</p>
      {err && <div className="error">{err}</div>}
      <div className="card">
        <label>First name (shown to customers)</label><input value={f.firstName} onChange={c('firstName')} />
        <label>Vehicle</label>
        <select value={f.type} onChange={c('type')}><option value="motorbike">Motorbike</option><option value="car">Car</option><option value="van">Van</option><option value="truck">Truck</option></select>
        <label>Plate number</label><input value={f.plate} onChange={c('plate')} />
        <label>Colour (helps customers spot you)</label><input placeholder="e.g. White" maxLength={30} value={f.colour} onChange={c('colour')} />
        <div className="check"><input type="checkbox" checked={f.canBulky} onChange={c('canBulky')} />I can carry bulky items</div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="secondary" onClick={() => setShoot('vehicle')}>{vehicle ? '✓ Vehicle photo' : 'Vehicle photo'}</button>
          <button className="secondary" onClick={() => setShoot('licence')}>{licence ? '✓ Licence photo' : 'Licence photo'}</button>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>An admin checks your licence matches the photo on your KiriPay ID before you can drive.</p>
      </div>
      <div className="card">
        <h3>Your prices</h3>
        <p className="small">Customers see your price for each trip: starting price + price per km, never less than your minimum.</p>
        <GuideNote g={g} />
        <label>Starting price $</label><input inputMode="decimal" value={f.base} onChange={price('base')} /><PriceHint g={g} kind={kind} field="baseCents" value={f.base} />
        <label>Per km $</label><input inputMode="decimal" value={f.perKm} onChange={price('perKm')} /><PriceHint g={g} kind={kind} field="perKmCents" value={f.perKm} />
        <label>Minimum $</label><input inputMode="decimal" value={f.minimum} onChange={price('minimum')} /><PriceHint g={g} kind={kind} field="minimumCents" value={f.minimum} />
        <label>Night extra $</label><input inputMode="decimal" value={f.night} onChange={c('night')} />
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
  const [tab, setTab] = useState<'work' | 'send' | 'me'>('work');
  const [offers, setOffers] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [selfie, setSelfie] = useState(false);
  const [err, setErr] = useState('');
  const [queued, setQueued] = useState(pending().length);
  const [waitingNote, setWaitingNote] = useState('');

  const seenOffers = useRef<Set<string>>(new Set());
  const refresh = useCallback(async () => {
    try {
      const [o, j] = await Promise.all([call('/api/driver/offers'), call('/api/driver/jobs')]);
      // a new offer (by socket, Firebase or polling) rings with KiriGo's offer sound
      if (o.some((x: any) => !seenOffers.current.has(x.offerId))) ring('offer');
      seenOffers.current = new Set(o.map((x: any) => x.offerId));
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
        ws.onmessage = (ev) => {
          try {
            const m = JSON.parse(String(ev.data));
            if (m?.type === 'rider_waiting') { setWaitingNote('A rider near you is waiting. Stay online and they can book you.'); ring('offer'); }
            else if (m?.type && m.type !== 'offer') ring('job');
          } catch { /* not JSON */ }
          void refresh();
        };
      }).catch(() => {});
    }
    return () => { clearInterval(t); ws?.close(); };
  }, [me.online, refresh]);

  // Android app: phone alerts for offers, and location that keeps flowing in the background while online
  const [alerts, setAlerts] = useState<'on' | 'off' | 'web'>(isApp ? 'off' : 'web');
  // Firebase alert while the app is open: Android shows nothing itself, so play KiriGo's sound here (offers ring once
  // the refreshed list shows them)
  useEffect(() => { void setupPush(call, () => void refresh(), (d) => { if (d.type === 'rider_waiting') ring('offer'); else if (d.type && d.type !== 'offer') ring('job'); void refresh(); }).then(setAlerts); }, [refresh]);
  useEffect(() => {
    if (!isApp) return;
    if (me.online) void startBackgroundLocation((p) => { lastPos = p; watchers.forEach((w) => w(p)); });
    else void stopBackgroundLocation();
  }, [me.online]);

  // where we are, while online and free (not stored, just for matching)
  useEffect(() => {
    if (!me.online || jobs.length) return;
    const send = () => { if (lastPos) void call('/api/driver/position', { body: lastPos }).catch(() => {}); };
    const first = setTimeout(send, 3000);
    const t = setInterval(send, 20_000);
    const back = () => { if (document.visibilityState === 'visible') send(); };
    document.addEventListener('visibilitychange', back);
    return () => { clearTimeout(first); clearInterval(t); document.removeEventListener('visibilitychange', back); };
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
      <nav className="tabs"><button className={tab === 'work' ? 'on' : ''} onClick={() => setTab('work')}>Work</button><button className={tab === 'send' ? 'on' : ''} onClick={() => setTab('send')}>Parcels</button><button className={tab === 'me' ? 'on' : ''} onClick={() => setTab('me')}>Me</button></nav>
      <UpdateNotice />
      {err && <div className="error">{err}</div>}
      {queued > 0 && <div className="notice">{queued} handoff(s) saved offline — they'll send when you have signal. You're paid when they do.</div>}
      {tab === 'send' ? <SendJobs me={me} /> : tab === 'me' ? <Me me={me} reload={reload} /> : (
        <>
          {me.fee?.due && <div className="notice">Your monthly fee of {money(me.fee.amountCents)} is due. <button onClick={async () => { try { await call('/api/driver/fee/pay', { method: 'POST' }); reload(); } catch (e) { setErr(explain(e)); } }}>Pay from KiriPay</button></div>}
          {!me.online
            ? <button className="block" disabled={me.fee?.due} onClick={() => setSelfie(true)}>Go online</button>
            : <button className="secondary block" disabled={jobs.length > 0} onClick={goOffline}>Go offline</button>}
          {waitingNote && me.online && !jobs.length && <div className="notice">{waitingNote}</div>}
          <Visibility online={me.online} alerts={alerts} />
          {offers.map((o) => <Offer key={o.offerId} o={o} onDone={(job) => { void refresh(); if (job) setOpen(job); }} />)}
          {jobs.map((j) => (
            <div className="card" key={j.id} onClick={() => setOpen(j.id)} style={{ cursor: 'pointer' }}>
              <div className="between"><b>{j.service === 'ride' ? 'Ride' : j.send ? `Parcel${j.send.late ? ' · late' : ''}` : j.kind === 'return' ? 'Return' : j.kind === 'correction' ? 'Correct item' : 'Delivery'}{j.service === 'ride' || j.send ? '' : ` · ${j.shop.name}`}</b><span className="pill">{j.label}</span></div>
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
      <div className="between"><b>{o.kind === 'ride' ? `New ride · ${o.seats} ${o.seats === 1 ? 'seat' : 'seats'}` : o.kind === 'return' ? 'Return pickup' : o.kind === 'correction' ? 'Correct item' : 'New delivery'}</b><span className="countdown pill warn">{left}s</span></div>
      <div className="big">{money(o.priceCents)}</div>
      <p className="small">{o.kind === 'ride' ? 'Passenger' : o.shop} · {(o.distanceM / 1000).toFixed(1)} km{o.kind === 'ride' ? '' : ` · ${o.size}`} · {o.kind === 'ride' ? 'rider' : 'customer'} rating {typeof o.customerRating === 'number' ? o.customerRating.toFixed(1) : o.customerRating}</p>
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
  if (o.service === 'ride') return <RideJob o={o} setO={setO} onClose={onClose} />;
  if (o.send) return <SendJob o={o} setO={setO} err={err} setErr={setErr} mode={mode} setMode={setMode} step={step} giveBack={giveBack} notDelivered={notDelivered} load={load} onClose={onClose} />;
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
        {o.dropoff.landmark && <p className="small">{o.dropoff.landmark}<SideTag side={o.sides?.dropoff} /></p>}
        {!o.dropoff.landmark && o.sides?.dropoff && <p className="small"><SideTag side={o.sides.dropoff} /></p>}
        <p className="small">You earn {money(o.deliveryCents)}</p>
      </div>
      {o.status === 'DRIVER_ASSIGNED' && <button className="block" onClick={() => step('at_pickup')}>I'm at the {isReturn ? 'customer' : 'shop'}</button>}
      {o.status === 'AT_SHOP' && (isReturn
        ? <button className="block" onClick={() => setMode('pickupCode')}>Collect the item (customer's code)</button>
        : <button className="block" onClick={() => step('picked_up')}>I have the package</button>)}
      {o.status === 'PICKED_UP' && (isReturn ? <button className="block" onClick={() => step('arrived')}>I've arrived</button> : <HereButton orderId={o.id} onDone={setO} label="I'm here — let the customer know" />)}
      {o.status === 'ARRIVED' && !isReturn && <HereButton orderId={o.id} onDone={setO} again />}
      {(o.status === 'ARRIVED' || o.status === 'PICKED_UP') && <button className="block" style={{ marginTop: 8 }} onClick={() => setMode('handoff')}>{isReturn ? 'Drop off at the shop' : 'Hand over'}</button>}
      {o.status === 'ARRIVED' && !isReturn && (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="secondary" onClick={() => notDelivered('customer_absent')}>Nobody home</button>
          <button className="secondary" onClick={() => notDelivered('no_adult')}>No adult (after 10 pm)</button>
        </div>
      )}
      {['DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ARRIVED'].includes(o.status) && !isReturn && <Chat orderId={o.id} />}
      {['DRIVER_ASSIGNED', 'AT_SHOP'].includes(o.status) && <button className="secondary block" style={{ marginTop: 16 }} onClick={giveBack}>Give job back</button>}
      {o.status === 'HANDED_OVER' && <Rate orderId={o.id} isReturn={isReturn} onDone={onClose} />}
    </div>
  );
}

// ------------------------------------------------------------------ where KiriGo sees you

/** Where KiriGo last heard from you, whether customers can find you for deliveries and rides, and why not. */
function Visibility({ online, alerts }: { online: boolean; alerts: 'on' | 'off' | 'web' }) {
  const [v, setV] = useState<any>(null);
  const [phone, setPhone] = useState<Pos | null>(lastPos);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('');
  const load = useCallback(() => call('/api/driver/visibility').then(setV).catch(() => {}), []);
  useEffect(() => { void load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load, online]);
  useEffect(() => { const w = (p: Pos) => setPhone({ ...p }); watchers.add(w); return () => { watchers.delete(w); }; }, []);
  const sendNow = async () => {
    setBusy(true); setMsg('');
    try {
      const p = await new Promise<Pos>((ok, no) => navigator.geolocation
        ? navigator.geolocation.getCurrentPosition((x) => ok({ lat: x.coords.latitude, lng: x.coords.longitude }), no, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 })
        : no(new Error('no gps')));
      lastPos = p; setPhone(p);
      await call('/api/driver/position', { body: p });
      await load();
      setMsg('Sent. This is where customers see you now.');
    } catch (e: any) {
      setMsg(e?.code === 1 ? 'Location is blocked. Allow location for kirigo.online in your browser or phone settings.' : e instanceof ApiError ? explain(e) : "Couldn't get your location. Step outside or check that location is on.");
    } finally { setBusy(false); }
  };
  if (!v) return null;
  const line = (name: string, x: { visible: boolean; why: string[] }) => (
    <div style={{ marginTop: 6 }}>
      <div className="between"><b>{name}</b><span className={`pill ${x.visible ? 'good' : 'warn'}`}>{x.visible ? 'Customers can find you' : 'Not visible'}</span></div>
      {!x.visible && <ul className="small" style={{ margin: '4px 0 0 18px' }}>{x.why.map((w: string) => <li key={w}>{w}</li>)}</ul>}
    </div>);
  const age = v.seen ? (v.seen.ageS < 10 ? 'just now' : v.seen.ageS < 60 ? `${v.seen.ageS} seconds ago` : `${Math.round(v.seen.ageS / 60)} minutes ago`) : null;
  return (
    <div className="card">
      <div className="between"><b>Where KiriGo sees you</b><button className="secondary" onClick={() => setShow(!show)}>{show ? 'Hide map' : 'Show map'}</button></div>
      <p className="small">{v.seen ? `Last location received ${age}.` : online ? 'No location received yet.' : 'You are offline.'}</p>
      {show && <>
        <Suspense fallback={<p className="small">Loading map…</p>}><WhereMap seen={v.seen} phone={phone} reachKm={v.reachKm} /></Suspense>
        <p className="small"><span style={{ color: '#F59F00' }}>●</span> where KiriGo has you · <span style={{ color: '#2F80ED' }}>●</span> where your phone says you are · circle: customers within {v.reachKm} km can pick you</p>
      </>}
      {online && <button className="block" disabled={busy} onClick={sendNow}>{busy ? 'Getting your location…' : 'Send my location now'}</button>}
      {msg && <p className="small">{msg}</p>}
      {line('Deliveries', v.deliveries)}
      {line('Rides', v.rides)}
      {alerts === 'off' && <p className="small" style={{ marginTop: 8 }}>Phone alerts are off, so offers only show while this screen is open. Allow notifications for KiriGo Driver in your phone settings.</p>}
      {alerts === 'web' && online && <p className="small" style={{ marginTop: 8 }}>In a browser, keep this screen open while online. The KiriGo Driver app keeps working with the screen off.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ KiriGo Send

const ITEM: Record<string, string> = { document: 'Documents', small: 'Small parcel', medium: 'Medium parcel', bulky: 'Bulky item' };
const when = (iso: string) => new Date(iso).toLocaleString('en-AU', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const kmText = (m: number) => `${(m / 1000).toFixed(1)} km`;

/** Open parcel jobs. Drivers set their own price; the sender chooses. */
function SendJobs({ me }: { me: any }) {
  const [jobs, setJobs] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try { const p = lastPos; setJobs(await call(`/api/driver/send/jobs${p ? `?lat=${p.lat}&lng=${p.lng}` : ''}`)); } catch (e) { setErr(explain(e)); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, [load]);
  if (me.services && !me.services.deliveries) return <p className="muted">Switch on deliveries in Me → Services to bid on parcels.</p>;
  return (
    <>
      <p className="small">People sending documents and parcels. Offer your price; if the sender picks you, the job appears in Work and you're paid at the handoff.</p>
      {err && <div className="error">{err}</div>}
      {jobs === null ? <p>Loading…</p> : jobs.length === 0 ? <p className="muted">No parcel jobs open right now.</p> : jobs.map((j) => <SendJobCard key={j.id} j={j} onChange={load} />)}
    </>
  );
}

function SendJobCard({ j, onChange }: { j: any; onChange: () => void }) {
  const [price, setPrice] = useState(j.myBid ? (j.myBid.priceCents / 100).toFixed(2) : j.suggestedCents ? dollars(j.suggestedCents) : '');
  const [note, setNote] = useState(j.myBid?.note ?? '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const bid = async () => {
    const cents = Math.round(Number(price) * 100);
    if (!Number.isFinite(cents) || cents <= 0) { setErr('Enter your price'); return; }
    setBusy(true); setErr('');
    try { await call(`/api/driver/send/jobs/${j.id}/bid`, { body: { priceCents: cents, note } }); onChange(); } catch (e) { setErr(explain(e)); } finally { setBusy(false); }
  };
  const withdraw = async () => { try { await call(`/api/driver/send/jobs/${j.id}/bid`, { method: 'DELETE' }); setPrice(''); onChange(); } catch (e) { setErr(explain(e)); } };
  return (
    <div className="card">
      <div className="between"><b>{ITEM[j.item] ?? j.item}</b><span className="pill">{j.bids} {j.bids === 1 ? 'offer' : 'offers'}</span></div>
      {j.description && <p className="small">{j.description}</p>}
      <p className="small">{kmText(j.distanceM)} trip{j.toPickupM != null ? ` · pickup ${kmText(j.toPickupM)} from you` : ''}</p>
      <p className="small">Collect after {when(j.pickupAfter)} · deliver by <b>{when(j.deliverBy)}</b></p>
      {j.suggestedCents ? <p className="small">KiriGo suggests {money(j.suggestedCents)} for this trip. Offers close to it show as a Fair price.</p> : null}
      {j.myBid && <p className="small">Your offer: <b>{money(j.myBid.priceCents)}</b>. You'll hear if the sender picks you.</p>}
      <div className="row">
        <input inputMode="decimal" aria-label="Your price in dollars" placeholder="Your price $" value={price} onChange={(e) => setPrice(e.target.value)} style={{ maxWidth: 130 }} />
        <input aria-label="Note for the sender (optional)" placeholder="Note (optional)" maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        {j.myBid && <button className="secondary" onClick={withdraw}>Withdraw</button>}
        <button onClick={bid} disabled={busy}>{j.myBid ? 'Update offer' : 'Offer this price'}</button>
      </div>
    </div>
  );
}

function SendJob({ o, setO, err, mode, setMode, step, giveBack, notDelivered, load, onClose }: any) {
  const sd = o.send;
  const order = ['DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ARRIVED', 'ACCEPTED'];
  const at = order.indexOf(o.status === 'HANDED_OVER' ? 'ACCEPTED' : o.status);
  if (mode === 'handoff') return <Handoff o={o} onDone={() => { setMode('view'); void load(); }} onCancel={() => setMode('view')} />;
  return (
    <div className="app">
      <Top right={<button className="secondary" onClick={onClose}>Back</button>} />
      <div className="steps">{order.map((s, i) => <span key={s} className={i <= at ? 'on' : ''} />)}</div>
      <h2>{sd.returning && o.status !== 'ACCEPTED' ? 'Bring it back to the sender' : o.label}</h2>
      {sd.late && <div className="notice">Past the deliver-by time ({when(sd.deliverBy)}). Please get it there as soon as you can.</div>}
      {err && <div className="error">{err}</div>}
      <div className="card">
        <div className="between"><b>Collect from the sender</b><a href={mapsLink(o.shop.pickup)} target="_blank" rel="noreferrer">Directions</a></div>
        {(sd.pickupNote || o.sides?.pickup) && <p className="small">{sd.pickupNote}<SideTag side={o.sides?.pickup} /></p>}
        <p className="small">{ITEM[sd.item] ?? sd.item}{sd.description ? ` · ${sd.description}` : ''} · after {when(sd.pickupAfter)}</p>
      </div>
      <div className="card">
        <div className="between"><b>{sd.returning ? 'Back to the sender' : `Deliver to ${sd.recipient?.name ?? 'the recipient'}`}</b><a href={mapsLink(o.dropoff)} target="_blank" rel="noreferrer">Directions</a></div>
        {(o.dropoff.landmark || o.sides?.dropoff) && <p className="small">{o.dropoff.landmark}<SideTag side={o.sides?.dropoff} /></p>}
        {!sd.returning && sd.recipient?.phone && <p className="small"><a href={`tel:${sd.recipient.phone}`}>Call {sd.recipient.name}</a></p>}
        <p className="small">By {when(sd.deliverBy)} · you earn {money(o.deliveryCents)}</p>
        <p className="small">{sd.returning ? 'The sender shows you their code to get it back.' : 'The recipient shows you a 4-digit code or QR. Take the photo at the handoff.'}</p>
      </div>
      {o.status === 'DRIVER_ASSIGNED' && <HereButton orderId={o.id} onDone={setO} label="I'm here — let the sender know" />}
      {o.status === 'AT_SHOP' && <><button className="block" onClick={() => step('picked_up')}>I have the parcel</button><HereButton orderId={o.id} onDone={setO} again /></>}
      {o.status === 'PICKED_UP' && (sd.returning ? <button className="block" onClick={() => step('arrived')}>I've arrived</button> : <HereButton orderId={o.id} onDone={setO} label="I'm here — let them know" />)}
      {(o.status === 'ARRIVED' || o.status === 'PICKED_UP') && <button className="block" style={{ marginTop: 8 }} onClick={() => setMode('handoff')}>Hand over</button>}
      {o.status === 'ARRIVED' && (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="secondary" onClick={() => notDelivered('customer_absent')}>{sd.returning ? 'Sender not there' : 'Nobody to take it'}</button>
          <button className="secondary" onClick={() => notDelivered('no_adult')}>No adult (after 10 pm)</button>
        </div>
      )}
      {['DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ARRIVED'].includes(o.status) && <Chat orderId={o.id} />}
      {o.status === 'ARRIVED' && !sd.returning && <p className="small">If nobody can take it, you're paid for the trip and bring it back to the sender.</p>}
      {['DRIVER_ASSIGNED', 'AT_SHOP'].includes(o.status) && <button className="secondary block" style={{ marginTop: 16 }} onClick={giveBack}>Give job back</button>}
      {(o.status === 'ACCEPTED' || o.status === 'HANDED_OVER') && <RideRate orderId={o.id} onDone={onClose} parcel />}
    </div>
  );
}

// ------------------------------------------------------------------ a ride

function RideJob({ o, setO, onClose }: { o: any; setO: (o: any) => void; onClose: () => void }) {
  const [err, setErr] = useState('');
  const [boarding, setBoarding] = useState(false);
  const [code, setCode] = useState('');
  const [sos, setSos] = useState('');
  const act = async (path: string, body: unknown = here()) => {
    setErr('');
    try { setO(await call(`/api/driver/jobs/${o.id}/${path}`, { body })); setBoarding(false); } catch (e) { setErr(explain(e)); }
  };
  const step = (status: string, extra: any = {}) => act('status', { status, ...here(), ...extra });
  const emergency = async () => {
    if (!confirm('Send an emergency alert with your location to KiriGo?')) return;
    try { await call(`/api/driver/jobs/${o.id}/emergency`, { body: here() }); setSos('Alert sent. KiriGo has your location.'); } catch (e) { setErr(explain(e)); }
  };
  const order = ['DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ACCEPTED'];
  const at = Math.max(0, order.indexOf(o.status === 'ARRIVED' || o.status === 'HANDED_OVER' ? 'PICKED_UP' : o.status));
  const active = ['DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ARRIVED'].includes(o.status);

  if (boarding) return (
    <div className="app"><Top /><h3>Scan the rider's boarding code</h3>{err && <div className="error">{err}</div>}
      <QrScan onCode={(t) => step('picked_up', { token: t })} />
      <label>…or type their 4-digit code</label>
      <div className="row"><input inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /><button disabled={code.length !== 4} onClick={() => step('picked_up', { code })}>Start ride</button></div>
      <button className="secondary block" style={{ marginTop: 8 }} onClick={() => setBoarding(false)}>Back</button>
    </div>
  );
  return (
    <div className="app">
      <Top right={<button className="secondary" onClick={onClose}>Back</button>} />
      <div className="steps">{order.map((s, i) => <span key={s} className={i <= at ? 'on' : ''} />)}</div>
      <h2>{o.label}</h2>
      {err && <div className="error">{err}</div>}
      {sos && <div className="notice">{sos}</div>}
      {o.ride.sharing && active && <p className="small">The rider is sharing this trip with someone they know.</p>}
      <div className="card">
        <div className="between"><b>Pick up</b><a href={mapsLink(o.ride.pickup)} target="_blank" rel="noreferrer">Directions</a></div>
        {(o.ride.pickup.note || o.sides?.pickup) && <p className="small">{o.ride.pickup.note}<SideTag side={o.sides?.pickup} /></p>}
        <p className="small">{o.ride.seats} {o.ride.seats === 1 ? 'passenger' : 'passengers'}</p>
      </div>
      <div className="card">
        <div className="between"><b>Drop off</b><a href={mapsLink(o.dropoff)} target="_blank" rel="noreferrer">Directions</a></div>
        {(o.ride.dropNote || o.sides?.dropoff) && <p className="small">{o.ride.dropNote}<SideTag side={o.sides?.dropoff} /></p>}
        <p className="small">Fare {money(o.ride.fareCents)}{o.ride.waitingCents ? ` + waiting ${money(o.ride.waitingCents)}` : ''}</p>
      </div>
      {o.status === 'DRIVER_ASSIGNED' && <HereButton orderId={o.id} onDone={setO} label="I'm here — let the rider know" />}
      {o.status === 'AT_SHOP' && <>
        <button className="block" onClick={() => setBoarding(true)}>Rider is here — scan boarding code</button>
        <HereButton orderId={o.id} onDone={setO} again />
        <button className="secondary block" style={{ marginTop: 8 }} onClick={() => act('no-show')}>Rider didn't come</button>
      </>}
      {(o.status === 'PICKED_UP' || o.status === 'ARRIVED') && <button className="block" onClick={() => act('end-ride')}>End ride at destination</button>}
      {['DRIVER_ASSIGNED', 'AT_SHOP'].includes(o.status) && <Chat orderId={o.id} />}
      {['DRIVER_ASSIGNED', 'AT_SHOP'].includes(o.status) && <button className="secondary block" style={{ marginTop: 8 }} onClick={async () => { if (confirm('Give this ride back? It counts against your record.')) { try { await call(`/api/driver/jobs/${o.id}/release`, { method: 'POST' }); onClose(); } catch (e) { setErr(explain(e)); } } }}>Give ride back</button>}
      {active && <button className="danger block" style={{ marginTop: 16 }} onClick={emergency}>Emergency</button>}
      {o.status === 'ACCEPTED' && <RideRate orderId={o.id} onDone={onClose} />}
    </div>
  );
}

function RideRate({ orderId, onDone, parcel }: { orderId: string; onDone: () => void; parcel?: boolean }) {
  const [stars, setStars] = useState(5);
  const send = async () => { try { await call(`/api/driver/jobs/${orderId}/rate`, { body: { ratings: [{ to: 'customer', stars }] } }); } catch { /* optional */ } onDone(); };
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>{parcel ? 'Parcel delivered' : 'Ride complete'}. You've been paid.</h3>
      <label>Rate the {parcel ? 'sender' : 'rider'}</label>
      <div className="row">{[1, 2, 3, 4, 5].map((n) => <button key={n} className={n <= stars ? '' : 'secondary'} onClick={() => setStars(n)}>★</button>)}</div>
      <button className="block" style={{ marginTop: 12 }} onClick={send}>Send rating</button>
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

function Services({ me, reload }: { me: any; reload: () => void }) {
  const [msg, setMsg] = useState('');
  const set = async (deliveries: boolean, rides: boolean) => {
    try { await call('/api/driver/services', { method: 'PUT', body: { deliveries, rides } }); reload(); } catch (e) { setMsg(explain(e)); }
  };
  const rideOk = me.rides?.status === 'approved';
  return (
    <div className="card">
      <h3>What I do</h3>
      {me.online && <p className="small">Go offline to change this.</p>}
      <div className="check"><input type="checkbox" disabled={me.online} checked={me.services.deliveries} onChange={(e) => set(e.target.checked, me.services.rides)} />Deliveries</div>
      <div className="check"><input type="checkbox" disabled={me.online || !rideOk} checked={me.services.rides} onChange={(e) => set(me.services.deliveries, e.target.checked)} />Rides (passengers){!rideOk && <span className="pill" style={{ marginLeft: 8 }}>{me.rides?.status === 'pending' ? 'Being checked' : 'Not approved yet'}</span>}</div>
      {msg && <p className="small">{msg}</p>}
      {!rideOk && me.rides?.status !== 'pending' && ['car', 'van'].includes(me.vehicle?.type) && <RideApply onDone={reload} />}
      {!['car', 'van'].includes(me.vehicle?.type) && <p className="small">Rides are for cars and vans.</p>}
    </div>
  );
}

function RideApply({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [shot, setShot] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [f, setF] = useState({ seats: '4', colour: '', base: '', perKm: '', minimum: '', night: '0', wait: '0.20', cancel: '2.00' });
  const [err, setErr] = useState('');
  const g = useGuide();
  useEffect(() => {
    if (!g) return;
    const r = g.rates.ride_car.recommended;
    setF((x) => (x.base ? x : { ...x, base: dollars(r.baseCents), perKm: dollars(r.perKmCents), minimum: dollars(r.minimumCents) }));
  }, [g]);
  const c = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const cents = (v: string) => Math.round(Number(v || 0) * 100);
  if (!open) return <button className="secondary block" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>Apply to carry passengers</button>;
  if (shot) return <div style={{ marginTop: 8 }}><p className="small">Photo of your car showing the plate, tyres and condition.</p><CameraShot label="Take photo" onShot={async (b) => { const r = await call('/api/driver/photos?kind=vehicle', { raw: b }); setPhoto(r.photoId); setShot(false); }} /></div>;
  const submit = async () => {
    try {
      await call('/api/driver/rides/apply', { body: { seats: Number(f.seats), colour: f.colour, roadworthyPhotoId: photo, rateCard: { baseCents: cents(f.base), perKmCents: cents(f.perKm), minimumCents: cents(f.minimum), nightCents: cents(f.night), waitPerMinCents: cents(f.wait), cancelCents: cents(f.cancel) } } });
      onDone();
    } catch (e) { setErr(explain(e)); }
  };
  return (
    <div style={{ marginTop: 8 }}>
      {err && <div className="error">{err}</div>}
      <label>Passenger seats</label><input inputMode="numeric" value={f.seats} onChange={c('seats')} />
      <label>Car colour (riders look for it)</label><input placeholder="e.g. White" maxLength={30} value={f.colour} onChange={c('colour')} />
      <button className="secondary block" style={{ marginTop: 8 }} onClick={() => setShot(true)}>{photo ? '✓ Car photo' : 'Car photo'}</button>
      <GuideNote g={g} />
      <label>Starting price $</label><input inputMode="decimal" value={f.base} onChange={c('base')} /><PriceHint g={g} kind="ride_car" field="baseCents" value={f.base} />
      <label>Per km $</label><input inputMode="decimal" value={f.perKm} onChange={c('perKm')} /><PriceHint g={g} kind="ride_car" field="perKmCents" value={f.perKm} />
      <label>Minimum fare $</label><input inputMode="decimal" value={f.minimum} onChange={c('minimum')} /><PriceHint g={g} kind="ride_car" field="minimumCents" value={f.minimum} />
      <label>Night extra $</label><input inputMode="decimal" value={f.night} onChange={c('night')} />
      <div className="row"><div><label>Waiting per minute $</label><input value={f.wait} onChange={c('wait')} /></div><div><label>Cancel / no-show fee $</label><input value={f.cancel} onChange={c('cancel')} /></div></div>
      <p className="small">The first few minutes of waiting are free. You get the cancel fee if a rider cancels late or doesn't come out.</p>
      <button className="block" disabled={!photo} onClick={submit}>Send for approval</button>
    </div>
  );
}

function RidePrices({ me, g, reload }: { me: any; g: Guide | null; reload: () => void }) {
  const r0 = me.rides.rateCard;
  const [f, setF] = useState({ base: dollars(r0.base_cents), perKm: dollars(r0.per_km_cents), minimum: dollars(r0.minimum_cents), night: dollars(r0.night_cents), wait: dollars(r0.wait_per_min_cents), cancel: dollars(r0.cancel_cents) });
  const [msg, setMsg] = useState('');
  const c = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const cents = (v: string) => Math.round(Number(v || 0) * 100);
  const save = async () => {
    try { await call('/api/driver/rides/rate-card', { method: 'PUT', body: { baseCents: cents(f.base), perKmCents: cents(f.perKm), minimumCents: cents(f.minimum), nightCents: cents(f.night), waitPerMinCents: cents(f.wait), cancelCents: cents(f.cancel) } }); setMsg('Ride prices saved'); reload(); }
    catch (e) { setMsg(explain(e)); }
  };
  const suggest = () => { if (!g) return; const r = g.rates.ride_car.recommended; setF({ ...f, base: dollars(r.baseCents), perKm: dollars(r.perKmCents), minimum: dollars(r.minimumCents) }); };
  return (
    <div className="card">
      <h3>My ride prices</h3>
      {me.online && <p className="small">Go offline to change your prices.</p>}
      <label>Starting price $</label><input inputMode="decimal" value={f.base} onChange={c('base')} /><PriceHint g={g} kind="ride_car" field="baseCents" value={f.base} />
      <label>Per km $</label><input inputMode="decimal" value={f.perKm} onChange={c('perKm')} /><PriceHint g={g} kind="ride_car" field="perKmCents" value={f.perKm} />
      <label>Minimum fare $</label><input inputMode="decimal" value={f.minimum} onChange={c('minimum')} /><PriceHint g={g} kind="ride_car" field="minimumCents" value={f.minimum} />
      <div className="row"><div><label>Night $</label><input inputMode="decimal" value={f.night} onChange={c('night')} /></div><div><label>Waiting / min $</label><input inputMode="decimal" value={f.wait} onChange={c('wait')} /></div></div>
      <label>Cancel / no-show fee $</label><input inputMode="decimal" value={f.cancel} onChange={c('cancel')} />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="secondary" disabled={me.online || !g} onClick={suggest}>Use suggested prices</button>
        <button disabled={me.online} onClick={save}>Save ride prices</button>
      </div>
      {msg && <p className="small" style={{ marginTop: 8 }}>{msg}</p>}
    </div>
  );
}

function Me({ me, reload }: { me: any; reload: () => void }) {
  const [earn, setEarn] = useState<any[]>([]);
  const [rc, setRc] = useState(me.rateCard);
  const [msg, setMsg] = useState('');
  const g = useGuide();
  const kind = kindFor('delivery', me.vehicle?.type);
  const reset = () => { if (!g) return; const r = g.rates[kind].recommended; setRc({ ...rc, base_cents: r.baseCents, per_km_cents: r.perKmCents, minimum_cents: r.minimumCents }); };
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
      <Services me={me} reload={reload} />
      <div className="card">
        <h3>Earnings</h3>
        {!earn.length ? <p className="small">No deliveries yet.</p> : <table><tbody>{earn.map((d) => <tr key={d.day}><td>{d.day.split('-').reverse().join('/')}</td><td>{d.trips} trips</td><td>{money(d.cents)}</td></tr>)}</tbody></table>}
      </div>
      <div className="card">
        <h3>My prices</h3>
        {me.online && <p className="small">Go offline to change your prices.</p>}
        <GuideNote g={g} />
        <label>Starting price $</label><input key={`b${rc.base_cents}`} defaultValue={dollars(rc.base_cents)} onBlur={f('base_cents')} /><PriceHint g={g} kind={kind} field="baseCents" value={dollars(rc.base_cents)} />
        <label>Per km $</label><input key={`k${rc.per_km_cents}`} defaultValue={dollars(rc.per_km_cents)} onBlur={f('per_km_cents')} /><PriceHint g={g} kind={kind} field="perKmCents" value={dollars(rc.per_km_cents)} />
        <label>Minimum $</label><input key={`m${rc.minimum_cents}`} defaultValue={dollars(rc.minimum_cents)} onBlur={f('minimum_cents')} /><PriceHint g={g} kind={kind} field="minimumCents" value={dollars(rc.minimum_cents)} />
        <div className="row"><div><label>Night $</label><input defaultValue={dollars(rc.night_cents)} onChange={f('night_cents')} /></div><div><label>Bulky $</label><input defaultValue={dollars(rc.bulky_cents)} onChange={f('bulky_cents')} /></div></div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="secondary" disabled={me.online || !g} onClick={reset}>Use suggested prices</button>
          <button disabled={me.online} onClick={save}>Save prices</button>
        </div>
        {msg && <p className="small" style={{ marginTop: 8 }}>{msg}</p>}
      </div>
      {me.rides?.status === 'approved' && me.rides.rateCard && <RidePrices me={me} g={g} reload={reload} />}
      <button className="secondary block" onClick={() => { setToken('driver', null); location.reload(); }}>Sign out</button>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
