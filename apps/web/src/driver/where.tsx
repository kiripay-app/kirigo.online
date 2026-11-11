// A small map for the driver: where KiriGo last heard from them, where their phone thinks they are,
// and how far customers can be (the pickup reach). Map data: OpenStreetMap, one file served by KiriGo.
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { leafletLayer } from 'protomaps-leaflet';

type Pt = { lat: number; lng: number };
const dot = (bg: string, size: number) => L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.5)"></div>` });
const KIRIGO = dot('#F59F00', 22), PHONE = dot('#2F80ED', 14);

export function WhereMap({ seen, phone, reachKm }: { seen: Pt | null; phone: Pt | null; reachKm: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<L.Layer[]>([]);

  useEffect(() => {
    const m = L.map(el.current!, { minZoom: 11, maxZoom: 18, attributionControl: true }).setView([1.335, 172.99], 13);
    leafletLayer({ url: '/tiles/tarawa.pmtiles', flavor: 'light', lang: 'en', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } as any).addTo(m);
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current; if (!m) return;
    layers.current.forEach((l) => l.remove()); layers.current = [];
    if (seen) {
      layers.current.push(L.circle([seen.lat, seen.lng], { radius: reachKm * 1000, color: '#F59F00', weight: 1, fillOpacity: 0.07 }).addTo(m));
      layers.current.push(L.marker([seen.lat, seen.lng], { icon: KIRIGO, keyboard: false, zIndexOffset: 500 }).addTo(m));
    }
    if (phone) layers.current.push(L.marker([phone.lat, phone.lng], { icon: PHONE, keyboard: false }).addTo(m));
    const pts = [seen, phone].filter(Boolean) as Pt[];
    const one = pts.at(0);
    if (pts.length === 1 && one) m.setView([one.lat, one.lng], 15);
    else if (pts.length === 2) m.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng] as [number, number])), { padding: [40, 40], maxZoom: 16 });
  }, [seen?.lat, seen?.lng, phone?.lat, phone?.lng, reachKm]);

  return <div ref={el} role="img" aria-label="Map of where KiriGo sees you" style={{ height: 220, borderRadius: 12, overflow: 'hidden', margin: '8px 0', zIndex: 0 }} />;
}
