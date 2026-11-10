import type { LatLng } from './types';

const R = 6_371_000; // metres
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The road network as one polyline ([lng, lat] pairs, GeoJSON order), e.g. the South Tarawa main road
 * from Betio to Bonriki. Export it from OpenStreetMap; see docs/road-data.md.
 */
export type Road = [number, number][];

/** Local flat projection (metres) around a reference latitude: accurate enough over a few tens of km. */
function project(p: LatLng, lat0: number): [number, number] {
  return [rad(p.lng) * R * Math.cos(rad(lat0)), rad(p.lat) * R];
}

export interface RoadPosition {
  /** metres along the road from its first point */
  along: number;
  /** metres from the point to the road */
  offset: number;
}

/** Where a point sits on the road: distance along it, and how far off it. */
export function positionOnRoad(p: LatLng, road: Road): RoadPosition {
  if (road.length < 2) throw new Error('road needs at least 2 points');
  const lat0 = road[0]![1];
  const [px, py] = project(p, lat0);
  let best: RoadPosition = { along: 0, offset: Infinity };
  let walked = 0;
  for (let i = 0; i < road.length - 1; i++) {
    const [ax, ay] = project({ lng: road[i]![0], lat: road[i]![1] }, lat0);
    const [bx, by] = project({ lng: road[i + 1]![0], lat: road[i + 1]![1] }, lat0);
    const dx = bx - ax, dy = by - ay;
    const segLen = Math.hypot(dx, dy);
    const t = segLen === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (segLen * segLen)));
    const cx = ax + t * dx, cy = ay + t * dy;
    const off = Math.hypot(px - cx, py - cy);
    if (off < best.offset) best = { along: walked + t * segLen, offset: off };
    walked += segLen;
  }
  return best;
}

/** Straight-line distance × this ≈ road distance when no road data is loaded. */
export const FALLBACK_ROAD_FACTOR = 1.3;

/**
 * Road distance in metres between two pins: walk to the road, along it, and off it again.
 * Without road data, falls back to straight line × 1.3.
 */
export function roadDistance(a: LatLng, b: LatLng, road: Road | null): number {
  if (!road) return Math.round(haversine(a, b) * FALLBACK_ROAD_FACTOR);
  const pa = positionOnRoad(a, road);
  const pb = positionOnRoad(b, road);
  return Math.round(pa.offset + Math.abs(pa.along - pb.along) + pb.offset);
}

export interface EnrouteCheck {
  enroute: boolean;
  /** extra metres the driver travels to make the pickup */
  detourM: number;
}

/**
 * Is a driver already heading past the customer and then on to the shop?
 * `prev` and `now` are two recent driver positions (gives the direction of travel along the road).
 * The extra distance is the two side trips off the road (to the customer and to the shop).
 */
export function checkEnroute(
  prev: LatLng, now: LatLng, customer: LatLng, shop: LatLng, road: Road | null, maxDetourM: number,
): EnrouteCheck {
  if (!road) return { enroute: false, detourM: Infinity };
  const p0 = positionOnRoad(prev, road).along;
  const p1 = positionOnRoad(now, road).along;
  const dir = Math.sign(p1 - p0);
  if (dir === 0) return { enroute: false, detourM: Infinity };
  const c = positionOnRoad(customer, road);
  const s = positionOnRoad(shop, road);
  const ahead = (x: number) => (x - p1) * dir >= 0;
  const inOrder = (s.along - c.along) * dir >= 0; // customer first, then shop
  const detourM = Math.round(2 * c.offset + 2 * s.offset);
  return { enroute: ahead(c.along) && ahead(s.along) && inOrder && detourM <= maxDetourM, detourM };
}
