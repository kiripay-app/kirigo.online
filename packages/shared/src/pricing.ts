import type { Cents, RateCard, RideRateCard, Settings, Size } from './types';

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
