// Price estimator for drivers: what a trip would cost with the driver's own prices, using exactly the formulas,
// admin caps and road distances real bookings use, next to KiriGo's suggested price.
import { inKiWindow, priceDelivery, priceRide, rateKindFor, recommendedPrice, roadDistance, isFairPrice, rateLimits, type LatLng, type Size } from '@kirigo/shared';
import type { Env } from '../env';
import { road } from './matching';
import { loadSettings } from './settings';
import { ApiError } from './util';

export interface EstimateInput {
  service: 'delivery' | 'ride';
  from?: LatLng; to?: LatLng; distanceKm?: number;
  size: Size; night: boolean | null; passengers: number;
}

export async function estimate(env: Env, driverId: string, b: EstimateInput) {
  const s = await loadSettings(env.DB);
  const distanceM = b.from && b.to ? roadDistance(b.from, b.to, road(env)) : Math.round((b.distanceKm ?? 0) * 1000);
  if (!(distanceM > 0)) throw new ApiError('NO_DISTANCE', 422);
  const night = b.night ?? (s.night_hours ? inKiWindow(Date.now(), s.night_hours.start, s.night_hours.end) : false);
  const veh = await env.DB.prepare('SELECT type FROM vehicles WHERE driver_id=? AND active=1').bind(driverId).first<{ type: string }>();
  const kind = rateKindFor(b.service, veh?.type);
  const rec = s.recommended_rates[kind];
  const km = distanceM / 1000;

  let card: { baseCents: number; perKmCents: number; minimumCents: number; nightCents: number; extraCents: number } | null = null;
  let yourCents: number | null = null;
  if (b.service === 'ride') {
    const r = await env.DB.prepare('SELECT * FROM ride_rate_cards WHERE driver_id=?').bind(driverId).first<any>();
    if (r) {
      const rc = { baseCents: r.base_cents, perKmCents: r.per_km_cents, minimumCents: r.minimum_cents, nightCents: r.night_cents, waitPerMinCents: r.wait_per_min_cents, cancelCents: r.cancel_cents };
      yourCents = priceRide(rc, distanceM, night, s);
      card = { baseCents: rc.baseCents, perKmCents: rc.perKmCents, minimumCents: rc.minimumCents, nightCents: night ? rc.nightCents : 0, extraCents: 0 };
    }
  } else {
    const r = await env.DB.prepare('SELECT * FROM rate_cards WHERE driver_id=?').bind(driverId).first<any>();
    if (r) {
      const rc = { baseCents: r.base_cents, perKmCents: r.per_km_cents, minimumCents: r.minimum_cents, nightCents: r.night_cents, bulkyCents: r.bulky_cents };
      yourCents = priceDelivery(rc, distanceM, { night, size: b.size }, s);
      card = { baseCents: rc.baseCents, perKmCents: rc.perKmCents, minimumCents: rc.minimumCents, nightCents: night ? rc.nightCents : 0, extraCents: b.size === 'bulky' ? rc.bulkyCents : 0 };
    }
  }
  const suggestedCents = recommendedPrice(rec, distanceM);
  const { lowest, highest } = rateLimits(rec, s.rate_band);
  // the plain price (no night or bulky extra) is what "Fair price" compares
  const plain = card ? Math.max(card.minimumCents, card.baseCents + Math.round(card.perKmCents * km)) : null;
  const people = Math.max(1, Math.min(12, Math.round(b.passengers)));
  return {
    service: b.service, kind, distanceM, night,
    your: card && yourCents != null ? {
      totalCents: yourCents,
      steps: { baseCents: card.baseCents, distanceCents: Math.round(card.perKmCents * km), perKmCents: card.perKmCents, minimumCents: card.minimumCents,
        minimumApplied: card.baseCents + Math.round(card.perKmCents * km) < card.minimumCents, nightCents: card.nightCents, extraCents: card.extraCents },
      fairPrice: plain != null && isFairPrice(plain, suggestedCents, s.fair_price_pct),
      // rides are priced for the whole car; this is what each rider pays if they share the fare evenly
      perPersonCents: b.service === 'ride' ? Math.ceil(yourCents / people / 10) * 10 : null,
    } : null,
    suggestedCents,
    range: { lowestCents: recommendedPrice(lowest, distanceM), highestCents: recommendedPrice(highest, distanceM) },
    passengers: people,
  };
}
