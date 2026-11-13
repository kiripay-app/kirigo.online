import { checkRateBand, rateKindFor, rateLimits, type RateCore, type RateKind, type Settings } from '@kirigo/shared';
import { ApiError } from './util';

/** What the driver app shows next to each price box: the recommended value and the allowed range, per kind. */
export function rateGuide(s: Settings) {
  const out = {} as Record<RateKind, { recommended: RateCore; lowest: RateCore; highest: RateCore }>;
  for (const k of Object.keys(s.recommended_rates) as RateKind[]) {
    out[k] = { recommended: s.recommended_rates[k], ...rateLimits(s.recommended_rates[k], s.rate_band) };
  }
  return { rates: out, band: s.rate_band, fairPricePct: s.fair_price_pct };
}

/** Refuse a rate card outside the band, with every problem in plain words. */
export function enforceBand(s: Settings, service: 'delivery' | 'ride', vehicleType: string | null | undefined, rc: RateCore) {
  const kind = rateKindFor(service, vehicleType);
  const errs = checkRateBand(rc, s.recommended_rates[kind], s.rate_band);
  if (errs.length) throw new ApiError('RATE_OUT_OF_RANGE', 422, { errs, kind, ...rateLimits(s.recommended_rates[kind], s.rate_band) });
}
