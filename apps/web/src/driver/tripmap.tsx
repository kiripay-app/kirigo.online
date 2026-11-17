// Map for the price estimator: tap to put the pickup (green) and the drop-off (orange).
// Map data: OpenStreetMap, the same file the rest of the driver app uses.
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { leafletLayer } from 'protomaps-leaflet';

export type Pt = { lat: number; lng: number };
const dot = (bg: string, size: number) => L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.5)"></div>` });
const FROM = dot('#2BB673', 20), TO = dot('#F59F00', 20);

export function TripMap({ from, to, onTap }: { from: Pt | null; to: Pt | null; onTap: (p: Pt) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const pins = useRef<L.Layer[]>([]);
  const cb = useRef(onTap); cb.current = onTap;

  useEffect(() => {
    const m = L.map(el.current!, { minZoom: 11, maxZoom: 18 }).setView([1.345, 173.03], 12);
    leafletLayer({ url: '/tiles/tarawa.pmtiles', flavor: 'light', lang: 'en', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } as any).addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => cb.current({ lat: Math.round(e.latlng.lat * 1e5) / 1e5, lng: Math.round(e.latlng.lng * 1e5) / 1e5 }));
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current; if (!m) return;
    pins.current.forEach((l) => l.remove()); pins.current = [];
    if (from) pins.current.push(L.marker([from.lat, from.lng], { icon: FROM, keyboard: false }).addTo(m));
    if (to) pins.current.push(L.marker([to.lat, to.lng], { icon: TO, keyboard: false }).addTo(m));
    if (from && to) pins.current.push(L.polyline([[from.lat, from.lng], [to.lat, to.lng]], { color: '#F59F00', weight: 2, dashArray: '6 6' }).addTo(m));
  }, [from?.lat, from?.lng, to?.lat, to?.lng]);

  return <div ref={el} role="application" aria-label="Map: tap the pickup, then the drop-off" style={{ height: 300, borderRadius: 12, overflow: 'hidden', margin: '8px 0', zIndex: 0 }} />;
}
