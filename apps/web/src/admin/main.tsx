import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { captureToken, client, explain, money, setToken } from '../api';

const call = client('admin', () => location.reload());
const fmt = (iso?: string | null) => (iso ? new Date(Date.parse(iso) + 12 * 3600_000).toISOString().replace('T', ' ').slice(0, 16).replace(/^(\d+)-(\d+)-(\d+)/, '$3/$2/$1') : '—');

function App() {
  const [token] = useState(() => captureToken('admin'));
  const [tab, setTab] = useState('alerts');
  if (!token) return (
    <div className="app"><div className="top"><span className="logo">KiriGo Admin</span></div>
      <div className="card"><p>Sign in with your KiriPay admin account (two-step sign-in required).</p><a className="btn block" href="/auth/start?app=admin">Sign in with KiriPay</a></div></div>
  );
  const tabs: [string, string][] = [['alerts', 'Alerts'], ['settings', 'Settings'], ['drivers', 'Drivers'], ['rides', 'Ride approvals'], ['problems', 'Problems'], ['orders', 'Orders'], ['flags', 'Ratings'], ['selfies', 'Shift selfies'], ['money', 'Money']];
  return (
    <div className="app wide">
      <div className="top"><span className="logo">KiriGo Admin</span><button className="secondary" onClick={() => { setToken('admin', null); location.reload(); }}>Sign out</button></div>
      <nav className="tabs">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</nav>
      {tab === 'alerts' && <Alerts />}
      {tab === 'rides' && <RideApprovals />}
      {tab === 'settings' && <><PhoneAlerts /><Settings /></>}
      {tab === 'drivers' && <Drivers />}
      {tab === 'problems' && <Problems />}
      {tab === 'orders' && <Orders />}
      {tab === 'flags' && <Flags />}
      {tab === 'selfies' && <Selfies />}
      {tab === 'money' && <Money />}
    </div>
  );
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => call<T>(path).then(setData).catch((e) => setErr(explain(e))), [path]);
  useEffect(() => { void load(); }, [load]);
  return { data, err, load, setErr };
}

// ------------------------------------------------------------------ settings

const FIELDS: { k: string; label: string; kind: 'cents' | 'num' | 'bool' | 'night' | 'text' }[] = [
  { k: 'delivery_open', label: 'Delivery service open', kind: 'bool' },
  { k: 'driver_signup_open', label: 'Driver sign-up open', kind: 'bool' },
  { k: 'monthly_fee_cents', label: 'Driver monthly fee (VAT incl.) $', kind: 'cents' },
  { k: 'free_period_months', label: 'Free launch period (months)', kind: 'num' },
  { k: 'max_per_km_cents', label: 'Maximum price per km $', kind: 'cents' },
  { k: 'floor_minimum_cents', label: 'Lowest allowed minimum charge $', kind: 'cents' },
  { k: 'night_hours', label: 'Night surcharge hours', kind: 'night' },
  { k: 'enroute_pickup_fee_cents', label: 'En-route pickup fee $', kind: 'cents' },
  { k: 'pickup_radius_km', label: 'Pickup search radius (km)', kind: 'num' },
  { k: 'drivers_shown', label: 'Drivers shown at checkout', kind: 'num' },
  { k: 'accept_window_s', label: 'Driver accept window (seconds)', kind: 'num' },
  { k: 'door_wait_min', label: 'Wait at the door (minutes)', kind: 'num' },
  { k: 'auto_release_h', label: 'Shop paid automatically after (hours)', kind: 'num' },
  { k: 'shop_fault_response_h', label: 'Shop fault-check answer time (hours)', kind: 'num' },
  { k: 'return_handover_h', label: 'Return must be handed over within (hours)', kind: 'num' },
  { k: 'return_receipt_h', label: 'Shop confirms return within (hours)', kind: 'num' },
  { k: 'max_failed_corrections', label: 'Failed corrections before refund', kind: 'num' },
  { k: 'rating_blind_h', label: 'Ratings hidden for (hours)', kind: 'num' },
  { k: 'adults_only_after', label: 'Adults only after (HH:MM)', kind: 'text' },
  { k: 'retention_photos_days', label: 'Keep proof photos (days)', kind: 'num' },
  { k: 'retention_gps_months', label: 'Keep GPS routes (months)', kind: 'num' },
  { k: 'send_open', label: 'Parcels (KiriGo Send) open', kind: 'bool' },
  { k: 'send_bid_max_cents', label: 'Highest parcel offer a driver can make $', kind: 'cents' },
  { k: 'send_sms_recipients', label: 'Text parcel recipients who aren\'t on KiriPay (driver + code, by SMS)', kind: 'bool' },
  { k: 'rides_open', label: 'Rides open', kind: 'bool' },
  { k: 'ride_buffer_cents', label: 'Refundable extra held with each ride $', kind: 'cents' },
  { k: 'ride_free_wait_min', label: 'Free waiting at pickup (minutes)', kind: 'num' },
  { k: 'ride_free_cancel_min', label: 'Free cancelling after booking (minutes)', kind: 'num' },
  { k: 'ride_noshow_wait_min', label: 'Wait before a no-show (minutes)', kind: 'num' },
  { k: 'ride_min_deliveries', label: 'Deliveries needed before rides', kind: 'num' },
  { k: 'ride_min_rating', label: 'Rating needed before rides', kind: 'num' },
  { k: 'buddy_after_min', label: 'Trip buddies see the trip after it ends (minutes)', kind: 'num' },
  { k: 'alert_offroute_m', label: 'Off-route alert distance (m)', kind: 'num' },
  { k: 'alert_stop_min', label: 'Long-stop alert (minutes)', kind: 'num' },
];

function Settings() {
  const { data, err, load, setErr } = useLoad<{ settings: any; missingForLaunch: string[] }>('/api/admin/settings');
  const [s, setS] = useState<any>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { if (data) setS(data.settings); }, [data]);
  if (!s) return err ? <div className="error">{err}</div> : <p>Loading…</p>;
  const save = async () => {
    setMsg(''); setErr('');
    try { await call('/api/admin/settings', { method: 'PUT', body: s }); setMsg('Saved'); void load(); }
    catch (e: any) { setErr(`${explain(e)}${e?.data?.missing ? `: ${e.data.missing.join(', ')}` : ''}`); }
  };
  return (
    <div className="card">
      {data?.missingForLaunch.length ? <div className="notice">Set these before opening delivery: {data.missingForLaunch.join(', ')}</div> : null}
      {err && <div className="error">{err}</div>}
      {FIELDS.map((f) => (
        <div key={f.k}>
          {f.kind === 'bool' ? <div className="check"><input type="checkbox" checked={!!s[f.k]} onChange={(e) => setS({ ...s, [f.k]: e.target.checked })} />{f.label}</div> : <label>{f.label}</label>}
          {f.kind === 'cents' && <input inputMode="decimal" value={s[f.k] == null ? '' : (s[f.k] / 100).toFixed(2)} placeholder="not set" onChange={(e) => setS({ ...s, [f.k]: e.target.value === '' ? null : Math.round(Number(e.target.value) * 100) })} />}
          {f.kind === 'num' && <input inputMode="numeric" value={s[f.k]} onChange={(e) => setS({ ...s, [f.k]: Number(e.target.value) })} />}
          {f.kind === 'text' && <input value={s[f.k]} onChange={(e) => setS({ ...s, [f.k]: e.target.value })} />}
          {f.kind === 'night' && <div className="row"><input placeholder="from 20:00" value={s.night_hours?.start ?? ''} onChange={(e) => setS({ ...s, night_hours: { start: e.target.value, end: s.night_hours?.end ?? '06:00' } })} /><input placeholder="to 06:00" value={s.night_hours?.end ?? ''} onChange={(e) => setS({ ...s, night_hours: { start: s.night_hours?.start ?? '20:00', end: e.target.value } })} /></div>}
        </div>
      ))}
      <button className="block" style={{ marginTop: 16 }} onClick={save}>Save settings</button>
      {msg && <p style={{ marginTop: 8 }}>{msg}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ phone alerts (Firebase)

const KEY_TEXT: Record<string, { pill: string; text: string }> = {
  ok: { pill: 'good', text: 'Set up and accepted by Google' },
  missing: { pill: 'bad', text: 'Not set up: the FCM_SERVICE_ACCOUNT secret is missing, so phones are never rung' },
  invalid: { pill: 'bad', text: "The FCM_SERVICE_ACCOUNT secret isn't a Firebase service-account key file — set it again from Firebase" },
  rejected: { pill: 'bad', text: 'Google refused the key (deleted or disabled in Firebase?) — generate a new one and set it again' },
};

function PhoneAlerts() {
  const { data, err, load } = useLoad<{ key: string; projectId: string | null; drivers: any[] }>('/api/admin/push/status');
  const [driverId, setDriverId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [testErr, setTestErr] = useState('');
  useEffect(() => { if (data?.drivers.length && !driverId) setDriverId(data.drivers[0].id); }, [data, driverId]);
  const send = async () => {
    setBusy(true); setResult(null); setTestErr('');
    try { setResult(await call('/api/admin/push/test', { method: 'POST', body: { driverId } })); void load(); }
    catch (e) { setTestErr(explain(e)); } finally { setBusy(false); }
  };
  const k = data ? KEY_TEXT[data.key] ?? KEY_TEXT.missing : null;
  return (
    <div className="card">
      <div className="between"><h3>Phone alerts (Android app)</h3>{k && <span className={`pill ${k.pill}`}>{data!.key === 'ok' ? 'working' : 'not working'}</span>}</div>
      {err && <div className="error">{err}</div>}
      {!data ? <p className="muted">Checking…</p> : (<>
        <p className="small">Firebase key: {k!.text}{data.projectId ? ` (project ${data.projectId})` : ''}.</p>
        {data.drivers.length === 0 ? (
          <p className="small muted">No driver has the KiriGo Driver app registered yet. Install the APK, sign in, allow notifications and go online once — the phone then appears here.</p>
        ) : (<>
          <label>Ring this driver's phone</label>
          <div className="row">
            <select value={driverId} onChange={(e) => { setDriverId(e.target.value); setResult(null); }}>
              {data.drivers.map((d) => <option key={d.id} value={d.id}>{d.first_name} · {d.driver_code} — {d.phones} phone{d.phones === 1 ? '' : 's'}, last seen {fmt(d.last_seen)}{d.status !== 'approved' ? ` (${d.status})` : ''}</option>)}
            </select>
            <button onClick={send} disabled={busy || !driverId || data.key !== 'ok'}>{busy ? 'Sending…' : 'Send test alert'}</button>
          </div>
          <p className="small muted">The phone shows "KiriGo test alert" on the loud Job offers channel, even when locked. Tell the driver first.</p>
        </>)}
        {testErr && <div className="error">{testErr}</div>}
        {result && (
          result.key !== 'ok' ? <div className="error">{KEY_TEXT[result.key]?.text}</div>
          : result.phones.length === 0 ? <div className="notice">{result.driver.first_name} has no phone registered any more.</div>
          : <ul className="small">{result.phones.map((p: any) => <li key={p.phone}>{p.ok ? '✓' : '✗'} {p.phone}: {p.ok ? 'sent — Firebase accepted it. Ask the driver if it rang.' : p.error}</li>)}</ul>
        )}
      </>)}
    </div>
  );
}

// ------------------------------------------------------------------ drivers

function Drivers() {
  const [status, setStatus] = useState('pending');
  const { data, err, load } = useLoad<any[]>(`/api/admin/drivers?status=${status}`);
  return (
    <>
      <nav className="tabs">{['pending', 'approved', 'suspended', 'rejected'].map((s) => <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{s}</button>)}</nav>
      {err && <div className="error">{err}</div>}
      {data?.length === 0 && <p className="muted">Nobody here.</p>}
      {data?.map((d) => <DriverCard key={d.id} d={d} onDone={load} />)}
    </>
  );
}

function DriverCard({ d, onDone }: { d: any; onDone: () => void }) {
  const [f, setF] = useState({ seen: false, match: false, expiry: '', note: '' });
  const [err, setErr] = useState('');
  const act = async (path: string, body: unknown) => { try { await call(`/api/admin/drivers/${d.id}/${path}`, { body }); onDone(); } catch (e) { setErr(explain(e)); } };
  return (
    <div className="card">
      <div className="between"><h3>{d.first_name} · {d.driver_code}</h3><span className="pill">{d.status}</span></div>
      <p className="small">KiriPay member {d.kiripay_user_id} · {d.vehicle_type} {d.plate} · applied {fmt(d.created_at)} · {d.deliveries} deliveries · rating {d.rating_count >= 5 ? d.rating_avg : 'New'}</p>
      <div className="row">
        {d.licencePhotoUrl && <div><p className="small">Licence</p><img className="shot" src={d.licencePhotoUrl} alt="licence" /></div>}
        {d.vehiclePhotoUrl && <div><p className="small">Vehicle</p><img className="shot" src={d.vehiclePhotoUrl} alt="vehicle" /></div>}
      </div>
      {d.licencePhotoUrl && d.status !== 'rejected' && <FaceCrop d={d} onSaved={onDone} />}
      {err && <div className="error">{err}</div>}
      {d.status === 'pending' || d.status === 'suspended' ? (
        <>
          <p className="small" style={{ marginTop: 8 }}>Compare the licence with the ID selfie in KiriPay admin (KYC) for member {d.kiripay_user_id}.</p>
          <div className="check"><input type="checkbox" checked={f.seen} onChange={(e) => setF({ ...f, seen: e.target.checked })} />I have seen the driver's licence</div>
          <div className="check"><input type="checkbox" checked={f.match} onChange={(e) => setF({ ...f, match: e.target.checked })} />The licence photo matches their KiriPay ID selfie</div>
          <label>Licence expiry</label><input type="date" value={f.expiry} onChange={(e) => setF({ ...f, expiry: e.target.value })} />
          <label>Note</label><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="secondary" onClick={() => act('reject', { note: f.note || 'Not approved' })}>Reject</button>
            <button disabled={!f.seen || !f.match || !f.expiry} onClick={() => act('approve', { licenceSeen: true, licenceMatchesKyc: true, licenceExpiry: f.expiry, note: f.note })}>Approve</button>
          </div>
        </>
      ) : d.status === 'approved' ? (
        <div className="row" style={{ marginTop: 8 }}><input placeholder="Reason" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /><button className="danger" disabled={f.note.length < 3} onClick={() => act('suspend', { note: f.note })}>Suspend</button></div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ problems & rulings

function Problems() {
  const { data, err, load } = useLoad<any[]>('/api/admin/orders?status=PROBLEM_REPORTED');
  const disputes = useLoad<any[]>('/api/admin/disputes');
  const due = new Map((disputes.data ?? []).map((d) => [d.order_id, d.due_at]));
  const mains = (data ?? []).filter((o) => o.kind === 'delivery');
  return (
    <>
      {err && <div className="error">{err}</div>}
      {!mains.length && <p className="muted">No open problems.</p>}
      {mains.map((o) => <ProblemCard key={o.id} id={o.id} due={due.get(o.id)} onDone={() => { void load(); void disputes.load(); }} />)}
    </>
  );
}

function ProblemCard({ id, due, onDone }: { id: string; due?: string; onDone: () => void }) {
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState({ atFault: 'shop', partial: '', note: '' });
  const [err, setErr] = useState('');
  useEffect(() => { call(`/api/admin/orders/${id}`).then(setD).catch((e) => setErr(explain(e))); }, [id]);
  if (!d) return <div className="card">{err || 'Loading…'}</div>;
  const o = d.order;
  const rule = async () => {
    try {
      await call(`/api/admin/orders/${id}/rule`, { body: { atFault: f.atFault, note: f.note, ...(f.partial ? { refundGoodsCents: Math.round(Number(f.partial) * 100) } : {}) } });
      onDone();
    } catch (e) { setErr(explain(e)); }
  };
  return (
    <div className="card">
      <div className="between"><h3>{o.shop.name} · {id}</h3>{due && <span className={`pill ${Date.parse(due) < Date.now() ? 'bad' : 'warn'}`}>rule by {fmt(due)}</span>}</div>
      <p className="small">Goods {money(o.goodsCents)} · delivery {money(o.deliveryCents)} · problem: <b>{o.problem?.reason?.replace(/_/g, ' ')}</b> · customer chose <b>{o.problem?.choice}</b> · shop {o.problem?.shopFault ?? 'has not answered'}</p>
      <div className="row">{o.photos.map((p: any) => <div key={p.url}><p className="small">{p.kind} · {fmt(p.takenAt)}</p><img className="shot" src={p.url} alt={p.kind} /></div>)}</div>
      {o.children.length > 0 && <p className="small">Trips: {o.children.map((c: any) => `${c.kind} (${c.label})`).join(' · ')}</p>}
      <details><summary className="small">Event log ({d.events.length})</summary><table><tbody>{d.events.map((e: any) => <tr key={e.id}><td>{fmt(e.at)}</td><td>{e.actor_type}</td><td>{e.type}</td><td className="small">{e.data_json}</td></tr>)}</tbody></table></details>
      {err && <div className="error">{err}</div>}
      <label>Who was at fault?</label>
      <select value={f.atFault} onChange={(e) => setF({ ...f, atFault: e.target.value })}>
        <option value="shop">Shop — customer gets goods + delivery back; shop pays the trips</option>
        <option value="customer">Customer — shop is paid (customer pays any return trip)</option>
        <option value="driver">Driver — damage in transit: driver's charge goes to the customer, goods refunded</option>
      </select>
      {f.atFault === 'shop' && o.problem?.choice === 'keep' && <><label>Partial refund $ (e.g. missing items)</label><input inputMode="decimal" value={f.partial} onChange={(e) => setF({ ...f, partial: e.target.value })} /></>}
      <label>Note (kept in the log)</label><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      <button className="block" style={{ marginTop: 10 }} onClick={rule}>Rule</button>
    </div>
  );
}

// ------------------------------------------------------------------ orders

function Orders() {
  const [status, setStatus] = useState('');
  const { data, err } = useLoad<any[]>(`/api/admin/orders${status ? `?status=${status}` : ''}`);
  const [open, setOpen] = useState<string | null>(null);
  if (open) return <OrderDetail id={open} onBack={() => setOpen(null)} />;
  return (
    <>
      <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 260, marginBottom: 12 }}>
        <option value="">All</option>{['PAID_HELD', 'DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ARRIVED', 'HANDED_OVER', 'ACCEPTED', 'PROBLEM_REPORTED', 'REFUNDED', 'NOT_DELIVERED', 'CANCELLED'].map((s) => <option key={s}>{s}</option>)}
      </select>
      {err && <div className="error">{err}</div>}
      <table><thead><tr><th>Created</th><th>Order</th><th>Kind</th><th>Status</th><th>Goods</th><th>Delivery</th></tr></thead>
        <tbody>{data?.map((o) => <tr key={o.id} onClick={() => setOpen(o.id)} style={{ cursor: 'pointer' }}><td>{fmt(o.created_at)}</td><td>{o.id}</td><td>{o.kind}</td><td>{o.status}</td><td>{money(o.goods_cents)}</td><td>{money(o.delivery_cents)}</td></tr>)}</tbody></table>
    </>
  );
}

function OrderDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => { call(`/api/admin/orders/${id}`).then(setD).catch(() => {}); }, [id]);
  if (!d) return <p>Loading…</p>;
  const route = d.routes.flatMap((r: any) => JSON.parse(r.points_json));
  return (
    <>
      <button className="secondary" onClick={onBack}>Back</button>
      <div className="card" style={{ marginTop: 12 }}>
        <h3>{id} · {d.order.label}</h3>
        <p className="small">Driver {d.order.driver ? `${d.order.driver.firstName} ${d.order.driver.driverCode} (${d.order.driver.vehicle.type} ${d.order.driver.vehicle.plate})` : '—'} · {route.length} GPS points</p>
        {route.length > 1 && <a href={`https://www.google.com/maps/dir/${route.filter((_: any, i: number) => i % Math.ceil(route.length / 20) === 0).map((p: any) => `${p.lat},${p.lng}`).join('/')}`} target="_blank" rel="noreferrer">Replay route on a map</a>}
        <div className="row">{d.order.photos.map((p: any) => <div key={p.url}><p className="small">{p.kind}</p><img className="shot" src={p.url} alt={p.kind} /></div>)}</div>
      </div>
      <div className="card"><h3>Money</h3><table><tbody>{d.money.map((m: any) => <tr key={m.id}><td>{fmt(m.created_at)}</td><td>{m.action} → {m.to_kind}</td><td>{money(m.amount_cents)}</td><td><span className={`pill ${m.status === 'done' ? 'good' : m.status === 'failed' ? 'bad' : ''}`}>{m.status}</span></td></tr>)}</tbody></table></div>
      <div className="card"><h3>Event log (cannot be changed)</h3><table><tbody>{d.events.map((e: any) => <tr key={e.id}><td>{fmt(e.at)}</td><td>{e.actor_type}</td><td>{e.type}</td><td className="small">{e.data_json}</td></tr>)}</tbody></table></div>
      <div className="card"><h3>Ratings</h3><table><tbody>{d.ratings.map((r: any) => <tr key={r.id}><td>{r.from_type} → {r.to_type}</td><td>{'★'.repeat(r.stars)}</td><td className="small">{r.reasons_json} {r.comment}</td><td>{r.removed_by ? 'removed' : r.visible_at ? 'visible' : 'hidden'}</td>
        <td>{!r.removed_by && <button className="secondary" onClick={async () => { const reason = prompt('Why remove this rating?'); if (reason) { await call(`/api/admin/ratings/${r.id}/remove`, { body: { reason } }); location.reload(); } }}>Remove</button>}</td></tr>)}</tbody></table></div>
    </>
  );
}

// ------------------------------------------------------------------ ratings, selfies, money

function Flags() {
  const { data, err } = useLoad<any[]>('/api/admin/flags');
  return (
    <div className="card">
      <p className="small">Patterns only: drivers below 3.5 after 20 ratings, customers below 3.0 after 5, shops below 3.5 after 20.</p>
      {err && <div className="error">{err}</div>}
      {!data?.length ? <p className="muted">Nobody flagged.</p> : <table><tbody>{data.map((f) => <tr key={f.kind + f.id}><td>{f.kind}</td><td>{f.name} {f.driver_code ?? ''}</td><td>★ {f.rating_avg} ({f.rating_count})</td>
        <td>{f.kind === 'customer' && <button className="secondary" onClick={() => call(`/api/admin/customers/${f.id}/${f.delivery_restricted ? 'unrestrict' : 'restrict'}`, { method: 'POST' }).then(() => location.reload())}>{f.delivery_restricted ? 'Allow delivery' : 'Restrict delivery'}</button>}</td></tr>)}</tbody></table>}
    </div>
  );
}

function Selfies() {
  const { data, load } = useLoad<any[]>('/api/admin/selfies');
  return (
    <>
      <p className="muted">Random shift selfies. Compare each with the driver's KiriPay ID photo.</p>
      {!data?.length && <p className="muted">Nothing to check.</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {data?.map((s) => (
          <div className="card" key={s.id}>
            <img className="shot" src={s.selfieUrl} alt="selfie" />
            <p className="small">{s.first_name} {s.driver_code} · {fmt(s.online_at)}</p>
            <div className="row"><button className="danger" onClick={() => call(`/api/admin/selfies/${s.id}`, { body: { result: 'no_match' } }).then(load)}>Not them</button><button onClick={() => call(`/api/admin/selfies/${s.id}`, { body: { result: 'match' } }).then(load)}>Match</button></div>
          </div>
        ))}
      </div>
    </>
  );
}

function Money() {
  const failed = useLoad<any[]>('/api/admin/money/failed');
  const debts = useLoad<any[]>('/api/admin/debts');
  return (
    <>
      <div className="card"><h3>Payments KiriPay refused</h3><p className="small">Network failures retry automatically every minute. These need a look.</p>
        {!failed.data?.length ? <p className="muted">None.</p> : <table><tbody>{failed.data.map((m) => <tr key={m.id}><td>{fmt(m.created_at)}</td><td>{m.order_id ?? m.driver_id}</td><td>{m.action} → {m.to_kind}</td><td>{money(m.amount_cents)}</td><td>{m.error}</td></tr>)}</tbody></table>}</div>
      <div className="card"><h3>Shop debts</h3><p className="small">Taken automatically from the shop's next payment.</p>
        {!debts.data?.length ? <p className="muted">None.</p> : <table><tbody>{debts.data.map((d) => <tr key={d.id}><td>{d.shop_id}</td><td>owes {d.creditor_kind}</td><td>{money(d.amount_cents - d.settled_cents)}</td><td>{d.order_id}</td></tr>)}</tbody></table>}</div>
    </>
  );
}

// ------------------------------------------------------------------ alerts and ride approvals

function FaceReports() {
  const { data, load } = useLoad<any[]>('/api/admin/face-reports');
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  const handle = async (id: number) => { const note = prompt('What did you find?'); if (note) { await call(`/api/admin/face-reports/${id}/handle`, { body: { note } }); void load(); } };
  const why: Record<string, string> = { no_match: 'Not the same person', unclear: 'Selfie too unclear to tell', no_photo: 'No photo to compare' };
  if (!data?.length) return null;
  return (
    <>
      <h3 style={{ marginTop: 16 }}>Riders who cancelled at the face check</h3>
      {data.map((f) => (
        <div className="card" key={f.id} style={f.paused_driver ? { borderColor: 'var(--bad)' } : undefined}>
          <div className="between"><h3>{f.first_name} · {f.driver_code}</h3><span className={`pill ${f.paused_driver ? 'bad' : 'warn'}`}>{fmt(f.at)}</span></div>
          <p className="small">{why[f.reason] ?? f.reason} · rider {f.rider_id} · trip {f.order_id}{f.paused_driver ? ' · rides paused: re-approve in Ride approvals once checked' : ''}</p>
          <div className="row">
            <div><p className="small">Today's selfie</p>{f.selfieUrl ? <img className="shot" src={f.selfieUrl} alt="selfie" style={{ maxWidth: 220 }} /> : <p className="small">none</p>}</div>
            <div><p className="small">Approved face</p>{f.faceUrl ? <img className="shot" src={f.faceUrl} alt="approved face" style={{ maxWidth: 220 }} /> : <p className="small">none</p>}</div>
          </div>
          <button onClick={() => handle(f.id)}>Mark checked</button>
        </div>
      ))}
    </>
  );
}

/** Click the face on the licence, size the square, save: that crop is what riders compare with. */
function FaceCrop({ d, onSaved }: { d: any; onSaved: () => void }) {
  const img = useRef<HTMLImageElement>(null);
  const [c, setC] = useState({ x: 0.25, y: 0.5, s: 0.3 });
  const [open, setOpen] = useState(!d.facePhotoUrl);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const pick = (e: React.MouseEvent<HTMLImageElement>) => { const r = e.currentTarget.getBoundingClientRect(); setC({ ...c, x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }); };
  const save = async () => {
    const el = img.current; if (!el) return;
    const w = el.naturalWidth, h = el.naturalHeight, side = Math.round(c.s * w);
    const sx = Math.max(0, Math.min(w - side, Math.round(c.x * w - side / 2))), sy = Math.max(0, Math.min(h - side, Math.round(c.y * h - side / 2)));
    const cv = document.createElement('canvas'); cv.width = 480; cv.height = 480;
    cv.getContext('2d')!.drawImage(el, sx, sy, side, side, 0, 0, 480, 480);
    const blob: Blob | null = await new Promise((ok) => cv.toBlob(ok, 'image/jpeg', 0.9));
    if (!blob) return;
    setBusy(true); setErr('');
    try { await call(`/api/admin/drivers/${d.id}/face-photo`, { raw: blob }); setOpen(false); onSaved(); } catch (e) { setErr(explain(e)); } finally { setBusy(false); }
  };
  if (!open) return <div className="row" style={{ marginTop: 8 }}>{d.facePhotoUrl && <img src={d.facePhotoUrl} alt="approved face" style={{ width: 96, height: 96, borderRadius: 12, objectFit: 'cover' }} />}<button className="secondary" onClick={() => setOpen(true)}>Change face photo</button></div>;
  const el = img.current, aspect = el && el.naturalHeight ? el.naturalWidth / el.naturalHeight : 1.5;
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <p className="small"><b>Face photo for riders.</b> Click the middle of the face on the licence, then size the square so it shows the face only, no licence number, address or date of birth.</p>
      <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', overflow: 'hidden', borderRadius: 8 }}>
        <img ref={img} src={d.licencePhotoUrl} alt="licence" onClick={pick} onLoad={() => setC({ ...c })} style={{ display: 'block', maxWidth: '100%', maxHeight: 360, cursor: 'crosshair', borderRadius: 8 }} />
        <div style={{ position: 'absolute', pointerEvents: 'none', border: '3px solid #F59F00', borderRadius: 6, boxShadow: '0 0 0 9999px rgba(0,0,0,.45)',
          left: `${(c.x - c.s / 2) * 100}%`, top: `${(c.y - (c.s * aspect) / 2) * 100}%`, width: `${c.s * 100}%`, height: `${c.s * aspect * 100}%` }} />
      </div>
      <label>Square size</label><input type="range" min="0.08" max="0.8" step="0.01" value={c.s} onChange={(e) => setC({ ...c, s: Number(e.target.value) })} />
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        {d.facePhotoUrl && <button className="secondary" onClick={() => setOpen(false)}>Keep current</button>}
        <button disabled={busy} onClick={save}>Save face photo</button>
      </div>
    </div>
  );
}

function Alerts() {
  const { data, err, load } = useLoad<any[]>('/api/admin/alerts');
  useEffect(() => { const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  const handle = async (id: number) => { const note = prompt('What was done?'); if (note) { await call(`/api/admin/alerts/${id}/handle`, { body: { note } }); void load(); } };
  const label: Record<string, string> = { emergency: 'EMERGENCY', off_route: 'Off route', long_stop: 'Long stop', overtime: 'Running late' };
  return (
    <>
      {err && <div className="error">{err}</div>}
      {!data?.length && <p className="muted">No open alerts. This page refreshes every 15 seconds.</p>}
      <FaceReports />
      {data?.map((a) => (
        <div className="card" key={a.id} style={a.kind === 'emergency' ? { borderColor: 'var(--bad)' } : undefined}>
          <div className="between"><h3>{label[a.kind] ?? a.kind} · {a.order_id}</h3><span className={`pill ${a.kind === 'emergency' ? 'bad' : 'warn'}`}>{fmt(a.at)}</span></div>
          <p className="small">Raised by {a.raised_by} · trip {a.status} · rider {a.customer_id} · driver {a.driver_id ?? '—'}</p>
          <div className="row">
            {a.lat != null && <a className="btn secondary" href={`https://www.google.com/maps?q=${a.lat},${a.lng}`} target="_blank" rel="noreferrer">Where it happened</a>}
            <button onClick={() => handle(a.id)}>Mark handled</button>
          </div>
        </div>
      ))}
    </>
  );
}

function RideApprovals() {
  const [status, setStatus] = useState('pending');
  const { data, err, load } = useLoad<any[]>(`/api/admin/rides/applications?status=${status}`);
  const [msg, setMsg] = useState('');
  const act = async (d: any, action: string, override = false) => {
    setMsg('');
    try { await call(`/api/admin/drivers/${d.id}/rides/${action}`, { body: { roadworthyChecked: true, override, note: '' } }); void load(); }
    catch (e: any) {
      if (e?.code === 'NOT_ENOUGH_RECORD' && confirm(`${d.first_name} has ${d.deliveries} deliveries and a ${d.rating_avg ?? 'new'} rating, below the usual requirement. Approve anyway?`)) return act(d, action, true);
      setMsg(explain(e));
    }
  };
  return (
    <>
      <nav className="tabs">{['pending', 'approved', 'suspended'].map((s) => <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{s}</button>)}</nav>
      {(err || msg) && <div className="error">{err || msg}</div>}
      {data?.length === 0 && <p className="muted">Nobody here.</p>}
      {data?.map((d) => (
        <div className="card" key={d.id}>
          <div className="between"><h3>{d.first_name} · {d.driver_code}</h3><span className="pill">{d.ride_seats} seats</span></div>
          <p className="small">{d.vehicle_type} {d.plate} · {d.deliveries} deliveries · rating {d.rating_count >= 5 ? d.rating_avg : 'New'} · fare {money(d.base_cents)} + {money(d.per_km_cents)}/km, min {money(d.minimum_cents)} · waiting {money(d.wait_per_min_cents)}/min · cancel {money(d.cancel_cents)}</p>
          <div className="row">
            {d.roadworthyUrl && <div><p className="small">Car</p><img className="shot" src={d.roadworthyUrl} alt="car" /></div>}
            {d.facePhotoUrl ? <div><p className="small">Face riders will see</p><img className="shot" src={d.facePhotoUrl} alt="driver's face" style={{ maxWidth: 220 }} /></div>
              : <p className="small">No face photo yet. Riders compare today's selfie with it, so it's needed before rides.</p>}
          </div>
          {!d.facePhotoUrl && d.licencePhotoUrl && <FaceCrop d={d} onSaved={load} />}
          <div className="row" style={{ marginTop: 8 }}>
            {status !== 'approved' && <button onClick={() => act(d, 'approve')}>Car checked — approve rides</button>}
            {status === 'approved' && <button className="danger" onClick={() => act(d, 'suspend')}>Suspend rides</button>}
            {status === 'pending' && <button className="secondary" onClick={() => act(d, 'reject')}>Reject</button>}
          </div>
        </div>
      ))}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
