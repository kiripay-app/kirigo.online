// Live operations map for admins: drivers as they go online, rides and deliveries as they happen,
// which driver each customer picked, and the route of a trip in progress until drop-off.
// Map data: OpenStreetMap (the same South Tarawa file the driver app uses).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { leafletLayer } from 'protomaps-leaflet';
import type { client } from '../api';
import { explain, money } from '../api';

type Call = ReturnType<typeof client>;
type Pt = { lat: number; lng: number };
type Driver = {
  id: string; name: string; code: string; vehicle: string | null; plate: string | null; rating: number | null; ratingCount: number; onlineAt: string;
  lat: number | null; lng: number | null; ageS: number | null; stale: boolean; state: 'free' | 'offered' | 'busy'; tripId: string | null; deliveries: boolean; rides: boolean;
};
type Trip = {
  id: string; parentId: string | null; kind: string; service: 'delivery' | 'ride'; seats: number; status: string; shop: string; customer: string | null; landmark: string | null;
  distanceM: number; deliveryCents: number; pickup: Pt; drop: Pt; emergency: boolean; phase: 'waiting' | 'active' | 'done';
  driver: { id: string; name: string; code: string; accepted: boolean; online: boolean } | null;
  createdAt: string; assignedAt: string | null; atPickupAt: string | null; pickedUpAt: string | null; handedOverAt: string | null; closedAt: string | null;
};
type Snap = { now: string; staleAfterS: number; counts: { online: number; free: number; busy: number; waiting: number; active: number }; drivers: Driver[]; trips: Trip[] };

const COLORS = { free: '#2BB673', offered: '#F5C400', busy: '#4DA3FF', stale: '#7f8c93', pickup: '#2BB673', drop: '#F59F00', waiting: '#F0544F' };

const hhmm = (iso?: string | null) => (iso ? new Date(Date.parse(iso) + 12 * 3600_000).toISOString().slice(11, 16) : '—');
const ago = (iso: string | null | undefined) => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const agoS = (s: number | null) => (s == null ? 'no location yet' : s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`);

const DELIVERY_LABEL: Record<string, string> = {
  PAID_HELD: 'Waiting for the driver to accept', DRIVER_ASSIGNED: 'Driver heading to the shop', AT_SHOP: 'Driver at the shop', PICKED_UP: 'On the way to the customer',
  ARRIVED: 'At the drop-off', HANDED_OVER: 'Dropped off', ACCEPTED: 'Completed', PROBLEM_REPORTED: 'Problem reported', REFUNDED: 'Refunded', NOT_DELIVERED: 'Not delivered', CANCELLED: 'Cancelled',
};
const RIDE_LABEL: Record<string, string> = {
  ...DELIVERY_LABEL, DRIVER_ASSIGNED: 'Driver heading to the rider', AT_SHOP: 'Driver at the pickup', PICKED_UP: 'Rider on board', ARRIVED: 'At the destination', HANDED_OVER: 'Dropped off', NOT_DELIVERED: 'No-show',
};
const label = (t: Trip) => (t.service === 'ride' ? RIDE_LABEL : DELIVERY_LABEL)[t.status] ?? t.status;
const noun = (t: Trip) => (t.service === 'ride' ? 'Ride' : t.kind === 'delivery' ? 'Delivery' : t.kind[0]!.toUpperCase() + t.kind.slice(1));

function driverIcon(d: Driver) {
  const bg = d.stale ? COLORS.stale : COLORS[d.state];
  const num = d.code.replace(/\D/g, '').replace(/^0+/, '') || d.code;
  return L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15],
    html: `<div class="lm-driver" style="background:${bg};opacity:${d.stale ? 0.65 : 1}">${num}</div>` });
}
const pin = (bg: string, shape: 'square' | 'flag', pulse = false) => L.divIcon({ className: '', iconSize: [16, 16], iconAnchor: [8, 8],
  html: `<div class="lm-pin ${shape} ${pulse ? 'pulse' : ''}" style="background:${bg}"></div>` });

export function LiveMap({ call }: { call: Call }) {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [err, setErr] = useState('');
  const [updated, setUpdated] = useState<number>(0);
  const [sel, setSel] = useState<{ kind: 'trip' | 'driver'; id: string } | null>(null);
  const [route, setRoute] = useState<Pt[]>([]);
  const [showDone, setShowDone] = useState(true);
  const [, tick] = useState(0);

  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const dMarkers = useRef(new Map<string, L.Marker>());
  const tLayers = useRef(new Map<string, L.LayerGroup>());
  const trail = useRef<L.Polyline | null>(null);
  const fitted = useRef<string>('');

  // ---- map
  useEffect(() => {
    const m = L.map(el.current!, { minZoom: 11, maxZoom: 18 }).setView([1.345, 173.03], 12);
    leafletLayer({ url: '/tiles/tarawa.pmtiles', flavor: 'light', lang: 'en', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } as any).addTo(m);
    map.current = m;
    const dm = dMarkers.current, tl = tLayers.current;
    return () => { m.remove(); map.current = null; dm.clear(); tl.clear(); trail.current = null; };
  }, []);

  // ---- poll every 5 seconds while the tab is visible
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try { setSnap(await call<Snap>('/api/admin/live')); setErr(''); setUpdated(Date.now()); }
    catch (e) { setErr(explain(e)); }
    finally { busy.current = false; }
  }, [call]);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    const t2 = setInterval(() => tick((n) => n + 1), 15000);   // keeps "x min ago" fresh
    const vis = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); clearInterval(t2); document.removeEventListener('visibilitychange', vis); };
  }, [load]);

  const trips = snap?.trips ?? [];
  const drivers = snap?.drivers ?? [];
  const selTrip = useMemo(() => (sel?.kind === 'trip' ? trips.find((t) => t.id === sel.id) ?? null : null), [sel, trips]);
  const selDriver = useMemo(() => (sel?.kind === 'driver' ? drivers.find((d) => d.id === sel.id) ?? null : null), [sel, drivers]);

  // ---- draw drivers
  useEffect(() => {
    const m = map.current; if (!m || !snap) return;
    const seen = new Set<string>();
    for (const d of snap.drivers) {
      if (d.lat == null || d.lng == null) continue;
      seen.add(d.id);
      const tip = `${d.name} ${d.code}${d.vehicle ? ` · ${d.vehicle}` : ''}${d.plate ? ` ${d.plate}` : ''}<br>${d.state === 'busy' ? 'On a job' : d.state === 'offered' ? 'Being asked for a job' : 'Online, free'} · seen ${agoS(d.ageS)}`;
      let mk = dMarkers.current.get(d.id);
      if (!mk) {
        mk = L.marker([d.lat, d.lng], { icon: driverIcon(d), zIndexOffset: 1000, keyboard: false }).addTo(m).bindTooltip(tip, { direction: 'top', offset: [0, -14] });
        mk.on('click', () => setSel({ kind: 'driver', id: d.id }));
        dMarkers.current.set(d.id, mk);
      } else { mk.setLatLng([d.lat, d.lng]); mk.setIcon(driverIcon(d)); mk.setTooltipContent(tip); }
    }
    for (const [id, mk] of dMarkers.current) if (!seen.has(id)) { mk.remove(); dMarkers.current.delete(id); }
  }, [snap]);

  // ---- draw trips: pickup and drop-off pins with a dashed line, pulsing while nobody has accepted yet
  useEffect(() => {
    const m = map.current; if (!m || !snap) return;
    const want = snap.trips.filter((t) => t.phase !== 'done' || (sel?.kind === 'trip' && sel.id === t.id));
    const ids = new Set(want.map((t) => t.id));
    for (const t of want) {
      const key = `${t.id}:${t.phase}:${t.status}`;
      const have = tLayers.current.get(t.id) as (L.LayerGroup & { _k?: string }) | undefined;
      if (have && have._k === key) continue;
      have?.remove();
      const g = L.layerGroup() as L.LayerGroup & { _k?: string };
      g._k = key;
      const click = () => setSel({ kind: 'trip', id: t.id });
      L.marker([t.pickup.lat, t.pickup.lng], { icon: pin(t.phase === 'waiting' ? COLORS.waiting : COLORS.pickup, 'square', t.phase === 'waiting'), keyboard: false })
        .bindTooltip(`${noun(t)} pickup · ${t.shop}`).on('click', click).addTo(g);
      L.marker([t.drop.lat, t.drop.lng], { icon: pin(COLORS.drop, 'flag'), keyboard: false }).bindTooltip(`${noun(t)} drop-off${t.landmark ? ` · ${t.landmark}` : ''}`).on('click', click).addTo(g);
      L.polyline([[t.pickup.lat, t.pickup.lng], [t.drop.lat, t.drop.lng]], { color: t.phase === 'waiting' ? COLORS.waiting : COLORS.drop, weight: 2, opacity: 0.6, dashArray: '6 6' }).addTo(g);
      g.addTo(m);
      tLayers.current.set(t.id, g);
    }
    for (const [id, g] of tLayers.current) if (!ids.has(id)) { g.remove(); tLayers.current.delete(id); }
  }, [snap, sel]);

  // ---- the route driven so far on the selected trip (refreshed with each update)
  useEffect(() => {
    if (!selTrip) { setRoute([]); return; }
    let live = true;
    call<{ points: Pt[] }>(`/api/admin/live/trips/${selTrip.id}/route`).then((r) => { if (live) setRoute(r.points); }).catch(() => {});
    return () => { live = false; };
  }, [call, selTrip?.id, selTrip?.status, updated]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = map.current; if (!m) return;
    trail.current?.remove(); trail.current = null;
    if (route.length > 1) trail.current = L.polyline(route.map((p) => [p.lat, p.lng] as [number, number]), { color: COLORS.busy, weight: 4, opacity: 0.9 }).addTo(m);
  }, [route]);

  // ---- when something is picked in the list, bring it into view once
  useEffect(() => {
    const m = map.current; if (!m || !sel) return;
    const key = `${sel.kind}:${sel.id}`;
    if (fitted.current === key) return;
    const pts: [number, number][] = [];
    if (selTrip) {
      pts.push([selTrip.pickup.lat, selTrip.pickup.lng], [selTrip.drop.lat, selTrip.drop.lng]);
      const d = drivers.find((x) => x.id === selTrip.driver?.id); if (d?.lat != null && d.lng != null) pts.push([d.lat, d.lng]);
    } else if (selDriver?.lat != null && selDriver.lng != null) pts.push([selDriver.lat, selDriver.lng]);
    if (!pts.length) return;
    fitted.current = key;
    if (pts.length === 1) m.setView(pts[0]!, Math.max(m.getZoom(), 15)); else m.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 16 });
  }, [sel, selTrip, selDriver, drivers]);

  const waiting = trips.filter((t) => t.phase === 'waiting');
  const active = trips.filter((t) => t.phase === 'active');
  const done = trips.filter((t) => t.phase === 'done');
  const pick = (kind: 'trip' | 'driver', id: string) => { fitted.current = ''; setSel({ kind, id }); };
  const noLoc = drivers.filter((d) => d.lat == null).length;
  const c = snap?.counts;

  const driverFor = (t: Trip) => (t.driver ? `${t.driver.name} ${t.driver.code}` : 'No driver yet');

  const row = (t: Trip) => (
    <button key={t.id} className={`lm-row ${sel?.kind === 'trip' && sel.id === t.id ? 'on' : ''}`} onClick={() => pick('trip', t.id)}>
      <span className="between"><b>{noun(t)} · {t.shop}</b><span className="small muted">{ago(t.createdAt)}</span></span>
      <span className="small">{label(t)}{t.emergency && <span className="pill bad" style={{ marginLeft: 6 }}>Emergency</span>}</span>
      <span className="small muted">{t.driver ? `${t.driver.accepted ? 'Driver' : 'Asked'}: ${driverFor(t)}` : 'No driver yet'}{t.customer ? ` · for ${t.customer}` : ''}</span>
    </button>
  );

  return (
    <>
      <div className="lm-stats">
        <div className="card"><div className="big">{c?.online ?? '–'}</div><span className="small muted">Drivers online</span></div>
        <div className="card"><div className="big" style={{ color: COLORS.free }}>{c?.free ?? '–'}</div><span className="small muted">Free</span></div>
        <div className="card"><div className="big" style={{ color: COLORS.busy }}>{c?.busy ?? '–'}</div><span className="small muted">On a job</span></div>
        <div className="card"><div className="big" style={{ color: c && c.waiting ? COLORS.waiting : undefined }}>{c?.waiting ?? '–'}</div><span className="small muted">Waiting for a driver</span></div>
        <div className="card"><div className="big">{c?.active ?? '–'}</div><span className="small muted">In progress</span></div>
      </div>
      {err && <div className="error">{err}{updated ? ` Showing what was seen at ${hhmm(new Date(updated).toISOString())}.` : ''}</div>}
      <div className="lm">
        <div>
          <div ref={el} className="lm-map" role="application" aria-label="Live map of drivers and trips" />
          <p className="small muted" style={{ marginTop: 8 }}>
            <span className="lm-key" style={{ background: COLORS.free }} /> free
            <span className="lm-key" style={{ background: COLORS.offered }} /> being asked
            <span className="lm-key" style={{ background: COLORS.busy }} /> on a job
            <span className="lm-key" style={{ background: COLORS.stale }} /> no update for {Math.round((snap?.staleAfterS ?? 180) / 60)}+ min
            <span className="lm-key sq" style={{ background: COLORS.pickup }} /> pickup
            <span className="lm-key sq" style={{ background: COLORS.drop }} /> drop-off
            <span className="lm-key sq" style={{ background: COLORS.waiting }} /> waiting for a driver
            {' · '}Updated {updated ? hhmm(new Date(updated).toISOString()) : '—'}. Positions are live only; idle drivers' locations are not saved.
          </p>
        </div>

        <div className="lm-side">
          {selTrip && <TripCard t={selTrip} driver={drivers.find((d) => d.id === selTrip.driver?.id)} onClose={() => setSel(null)} />}
          {selDriver && !selTrip && (
            <div className="card">
              <div className="between"><h3>{selDriver.name} · {selDriver.code}</h3><button className="secondary" onClick={() => setSel(null)}>Close</button></div>
              <p className="small">{selDriver.vehicle ?? 'Vehicle'} {selDriver.plate ?? ''} · {selDriver.rating ? `★ ${selDriver.rating}` : 'New'} · online since {hhmm(selDriver.onlineAt)}<br />
                {selDriver.state === 'busy' ? 'On a job' : selDriver.state === 'offered' ? 'Being asked for a job' : 'Free'} · last seen {agoS(selDriver.ageS)}<br />
                {[selDriver.deliveries && 'Deliveries', selDriver.rides && 'Rides'].filter(Boolean).join(' and ') || 'No services switched on'}</p>
              {selDriver.tripId && <button className="secondary" onClick={() => pick('trip', selDriver.tripId!)}>Show their trip</button>}
            </div>
          )}

          <div className="card">
            <h3>Waiting for a driver ({waiting.length})</h3>
            {waiting.length ? waiting.map(row) : <p className="small muted">Nothing waiting.</p>}
          </div>
          <div className="card">
            <h3>In progress ({active.length})</h3>
            {active.length ? active.map(row) : <p className="small muted">No trips in progress.</p>}
          </div>
          <div className="card">
            <div className="between"><h3>Just finished ({done.length})</h3><button className="secondary" onClick={() => setShowDone((v) => !v)}>{showDone ? 'Hide' : 'Show'}</button></div>
            {showDone && (done.length ? done.slice(0, 15).map(row) : <p className="small muted">Nothing in the last 30 minutes.</p>)}
          </div>
          <div className="card">
            <h3>Drivers online ({drivers.length})</h3>
            {noLoc > 0 && <p className="small muted">{noLoc} online without a location yet (not on the map).</p>}
            {drivers.length ? drivers.map((d) => (
              <button key={d.id} className={`lm-row ${sel?.kind === 'driver' && sel.id === d.id ? 'on' : ''}`} onClick={() => pick('driver', d.id)}>
                <span className="between"><b>{d.name} · {d.code}</b><span className={`pill ${d.state === 'free' ? 'good' : d.state === 'offered' ? 'warn' : ''}`}>{d.state === 'free' ? 'Free' : d.state === 'offered' ? 'Being asked' : 'On a job'}</span></span>
                <span className="small muted">{d.vehicle ?? ''} {d.plate ?? ''} · seen {agoS(d.ageS)}{d.stale && d.ageS != null ? ' (old)' : ''}</span>
              </button>
            )) : <p className="small muted">Nobody is online.</p>}
          </div>
        </div>
      </div>
    </>
  );
}

function TripCard({ t, driver, onClose }: { t: Trip; driver?: Driver; onClose: () => void }) {
  const steps: [string, string | null][] = [['Ordered', t.createdAt], ['Driver accepted', t.assignedAt], ['At the pickup', t.atPickupAt], [t.service === 'ride' ? 'Rider on board' : 'Picked up', t.pickedUpAt], ['Dropped off', t.handedOverAt]];
  return (
    <div className="card">
      <div className="between"><h3>{noun(t)} · {t.shop}</h3><button className="secondary" onClick={onClose}>Close</button></div>
      <p style={{ color: 'var(--text)' }}>{label(t)}{t.emergency && <span className="pill bad" style={{ marginLeft: 6 }}>Emergency</span>}</p>
      <p className="small">
        Driver: <b>{t.driver ? `${t.driver.name} ${t.driver.code}` : 'not picked yet'}</b>{t.driver && !t.driver.accepted ? ' (asked, has not answered)' : ''}
        {driver && <> · {driver.vehicle ?? ''} {driver.plate ?? ''} · seen {agoS(driver.ageS)}</>}<br />
        {t.customer ? <>For: {t.customer}<br /></> : null}
        {t.landmark ? <>Drop-off: {t.landmark}<br /></> : null}
        {(t.distanceM / 1000).toFixed(1)} km · delivery charge {money(t.deliveryCents)}{t.service === 'ride' ? ` · ${t.seats} seat${t.seats === 1 ? '' : 's'}` : ''}<br />
        <span className="muted">{t.id}</span>
      </p>
      <table><tbody>{steps.filter(([, v]) => v).map(([k, v]) => <tr key={k}><td>{k}</td><td>{hhmm(v)}</td></tr>)}</tbody></table>
      {t.phase === 'active' && <p className="small muted" style={{ marginTop: 8 }}>The blue line is the route driven so far. It is kept only from accept to handed over.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ super admin: who may open the live map

type Access = { admins: { user_id: string; name: string; role: string; live_map: number; always: boolean; changed_at: string | null; last_seen_at: string }[]; log: { at: string; name: string; action: string; detail: string }[] };
const ROLE: Record<string, string> = { super_admin: 'Super admin', super: 'Super admin', cashier: 'Cashier', kyc_reviewer: 'KYC reviewer', auditor: 'Auditor' };
const ACTION: Record<string, string> = { view: 'opened the live map', grant: 'switched live map on for', revoke: 'switched live map off for' };

export function LiveAccess({ call }: { call: Call }) {
  const [data, setData] = useState<Access | null>(null);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState('');
  const load = useCallback(() => call<Access>('/api/admin/live-access').then((d) => { setData(d); setErr(''); }).catch((e) => setErr(explain(e))), [call]);
  useEffect(() => { void load(); }, [load]);
  const set = async (id: string, enabled: boolean) => {
    setBusyId(id);
    try { await call(`/api/admin/live-access/${id}`, { method: 'PUT', body: { enabled } }); await load(); } catch (e) { setErr(explain(e)); } finally { setBusyId(''); }
  };
  return (
    <div className="card">
      <h3>Live map access</h3>
      <p className="small">Who may open the Live map tab (drivers on the map, trips as they happen). Super admins always can. Everyone else is off until you switch them on here. An admin appears in this list after they first sign in to KiriGo Admin.</p>
      {err && <div className="error">{err}</div>}
      {data && (data.admins.length ? (
        <table><tbody>{data.admins.map((a) => (
          <tr key={a.user_id}>
            <td><b>{a.name || a.user_id}</b><br /><span className="small muted">{ROLE[a.role] ?? a.role} · last here {hhmm(a.last_seen_at)} {a.last_seen_at.slice(0, 10).split('-').reverse().join('/')}</span></td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              {a.always ? <span className="pill good">Always on</span>
                : <button className={a.live_map ? 'danger' : ''} disabled={busyId === a.user_id} onClick={() => set(a.user_id, !a.live_map)}>{a.live_map ? 'Switch off' : 'Switch on'}</button>}
            </td>
          </tr>
        ))}</tbody></table>
      ) : <p className="small muted">No admins yet.</p>)}
      {!!data?.log.length && (
        <details style={{ marginTop: 10 }}><summary className="small">Recent activity</summary>
          <table><tbody>{data.log.map((l, i) => <tr key={i}><td className="small">{hhmm(l.at)} {l.at.slice(0, 10).split('-').reverse().join('/')}</td><td className="small">{l.name || 'Someone'} {ACTION[l.action] ?? l.action} {l.action !== 'view' ? l.detail : ''}</td></tr>)}</tbody></table>
        </details>
      )}
    </div>
  );
}
