import type { Cents, RateCard, RateCore, RateKind, RideRateCard, Settings, Size } from './types';

export interface PriceOptions {
  night: boolean;
  size: Size;
}

export type PriceCaps = Pick<Settings, 'max_per_km_cents' | 'floor_minimum_cents'>;

/** Apply admin caps to a driver's rate card. */
export function clampRateCard(rc: RateCard, caps: PriceCaps): RateCard {
  const perKm = caps.max_per_km_cents == null ? rc.perKmCents : Math.min(rc.perKmCents, caps.max_per_km_cents);
  const minimum = caps.floor_minimum_cents == null ? rc.minimumCents : Math.max(rc.minimumCents, caps.floor_minimum_cents);
  return { ...rc, perKmCents: perKm, minimumCents: minimum };
}

/**
 * Delivery charge = max(minimum, base + perKm × km) + surcharges.
 * Distance is shop → customer only; the driver's trip to the shop is not charged.
 * Result is rounded to whole cents.
 */
export function priceDelivery(rc: RateCard, distanceM: number, opts: PriceOptions, caps: PriceCaps): Cents {
  if (!Number.isFinite(distanceM) || distanceM < 0) throw new Error('distance must be a non-negative number');
  const r = clampRateCard(rc, caps);
  const km = distanceM / 1000;
  const core = Math.max(r.minimumCents, r.baseCents + Math.round(r.perKmCents * km));
  const night = opts.night ? r.nightCents : 0;
  const bulky = opts.size === 'bulky' ? r.bulkyCents : 0;
  return core + night + bulky;
}

/** En-route job pay: detour distance at the driver's per-km rate + fixed pickup fee. */
export function priceEnroute(rc: RateCard, detourM: number, pickupFeeCents: Cents, caps: PriceCaps): Cents {
  const r = clampRateCard(rc, caps);
  return Math.round(r.perKmCents * (detourM / 1000)) + pickupFeeCents;
}

/** Monthly fee is VAT-inclusive (12.5%). Returns the VAT part for the ledger. */
export const VAT_RATE = 0.125;
export function vatPortion(inclusiveCents: Cents): Cents {
  return Math.round(inclusiveCents - inclusiveCents / (1 + VAT_RATE));
}

export function validateRateCard(rc: RateCard): string[] {
  const errs: string[] = [];
  for (const [k, v] of Object.entries(rc)) {
    if (!Number.isInteger(v) || v < 0) errs.push(`${k} must be a whole, non-negative number of cents`);
  }
  return errs;
}

/** Ride fare, fixed when booked: max(minimum, base + perKm × km) + night extra. Same admin caps as deliveries. */
export function priceRide(rc: RideRateCard, distanceM: number, night: boolean, caps: PriceCaps): Cents {
  if (!Number.isFinite(distanceM) || distanceM < 0) throw new Error('distance must be a non-negative number');
  const perKm = caps.max_per_km_cents == null ? rc.perKmCents : Math.min(rc.perKmCents, caps.max_per_km_cents);
  const minimum = caps.floor_minimum_cents == null ? rc.minimumCents : Math.max(rc.minimumCents, caps.floor_minimum_cents);
  return Math.max(minimum, rc.baseCents + Math.round(perKm * (distanceM / 1000))) + (night ? rc.nightCents : 0);
}

/** Waiting charge at pickup: free minutes first, then per minute, never more than the buffer held for it. */
export function waitingCharge(arrivedAtMs: number, boardedAtMs: number, freeMin: number, perMinCents: Cents, capCents: Cents): Cents {
  const mins = Math.floor(Math.max(0, boardedAtMs - arrivedAtMs) / 60_000) - freeMin;
  return Math.max(0, Math.min(capCents, mins * perMinCents));
}

// ---------------------------------------------------------------- guided prices

/** Which recommended card applies: motorbikes have their own delivery rate, every other vehicle uses the car rate. */
export function rateKindFor(service: 'delivery' | 'ride', vehicleType: string | null | undefined): RateKind {
  if (service === 'ride') return 'ride_car';
  return vehicleType === 'motorbike' ? 'delivery_motorbike' : 'delivery_car';
}

export interface RateLimits { lowest: RateCore; highest: RateCore }

/** The allowed range for each number: belowPct under to abovePct over the recommended value, rounded to 10 cents. */
export function rateLimits(rec: RateCore, band: Settings['rate_band']): RateLimits {
  const lo = (v: number) => Math.floor((v * (100 - band.belowPct)) / 1000) * 10;
  const hi = (v: number) => Math.ceil((v * (100 + band.abovePct)) / 1000) * 10;
  return {
    lowest: { baseCents: lo(rec.baseCents), perKmCents: lo(rec.perKmCents), minimumCents: lo(rec.minimumCents) },
    highest: { baseCents: hi(rec.baseCents), perKmCents: hi(rec.perKmCents), minimumCents: hi(rec.minimumCents) },
  };
}

const RATE_NAMES: Record<keyof RateCore, string> = { baseCents: 'Starting price', perKmCents: 'Price per km', minimumCents: 'Minimum charge' };
const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

/** Plain-words problems with a driver's base / per km / minimum against the allowed range. Empty = fine. */
export function checkRateBand(rc: RateCore, rec: RateCore, band: Settings['rate_band']): string[] {
  const { lowest, highest } = rateLimits(rec, band);
  const errs: string[] = [];
  for (const k of Object.keys(RATE_NAMES) as (keyof RateCore)[]) {
    if (rc[k] < lowest[k]) errs.push(`${RATE_NAMES[k]} can't be below ${dollars(lowest[k])}`);
    if (rc[k] > highest[k]) errs.push(`${RATE_NAMES[k]} can't be above ${dollars(highest[k])}`);
  }
  return errs;
}

/** The recommended price for a trip, to compare drivers against. */
export function recommendedPrice(rec: RateCore, distanceM: number): Cents {
  return Math.max(rec.minimumCents, rec.baseCents + Math.round(rec.perKmCents * (distanceM / 1000)));
}

/** "Fair price": at or below the recommended price, or no more than pct above it. Night/bulky extras are left out of both. */
export function isFairPrice(priceCents: Cents, recommendedCents: Cents, pct: number): boolean {
  return priceCents <= Math.round(recommendedCents * (1 + pct / 100));
}
