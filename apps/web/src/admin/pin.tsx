// Map for admins to drop a landmark pin. Map data: OpenStreetMap, the same file the driver app uses.
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { leafletLayer } from 'protomaps-leaflet';

type Pt = { lat: number; lng: number };
const dot = (bg: string, size: number) => L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.5)"></div>` });
const NEW = dot('#F59F00', 22), OLD = dot('#64748b', 12);

export function PinMap({ pin, onPin, others }: { pin: Pt | null; onPin: (p: Pt) => void; others: (Pt & { label: string })[] }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const cb = useRef(onPin); cb.current = onPin;

  useEffect(() => {
    const m = L.map(el.current!, { minZoom: 11, maxZoom: 19 }).setView([1.345, 173.03], 12);
    leafletLayer({ url: '/tiles/tarawa.pmtiles', flavor: 'light', lang: 'en', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } as any).addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => cb.current({ lat: Math.round(e.latlng.lat * 1e5) / 1e5, lng: Math.round(e.latlng.lng * 1e5) / 1e5 }));
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    layer.current?.clearLayers();
    for (const o of others) L.marker([o.lat, o.lng], { icon: OLD, title: o.label, keyboard: false }).addTo(layer.current!);
  }, [others]);

  useEffect(() => {
    marker.current?.remove(); marker.current = null;
    if (pin && map.current) marker.current = L.marker([pin.lat, pin.lng], { icon: NEW, keyboard: false, zIndexOffset: 500 }).addTo(map.current);
  }, [pin?.lat, pin?.lng]);

  return <div ref={el} role="application" aria-label="Map: tap to place the landmark" style={{ height: 320, borderRadius: 12, overflow: 'hidden', margin: '8px 0', zIndex: 0, cursor: 'crosshair' }} />;
}
