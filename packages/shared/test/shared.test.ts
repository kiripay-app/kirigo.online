import { describe, expect, it } from 'vitest';
import {
  adultsOnly, addToAverage, canTransition, checkEnroute, displayRating, generateKeyPair, haversine, inKiWindow,
  kiDate, positionOnRoad, priceDelivery, priceEnroute, roadDistance, shouldFlag, signHandoff, TRANSITIONS,
  vatPortion, verifyHandoff, type Road, type RateCard,
} from '../src';

const rc: RateCard = { baseCents: 200, perKmCents: 100, minimumCents: 300, nightCents: 150, bulkyCents: 500 };
const noCaps = { max_per_km_cents: null, floor_minimum_cents: null };

describe('pricing', () => {
  it('uses the minimum for short trips', () => {
    expect(priceDelivery(rc, 500, { night: false, size: 'small' }, noCaps)).toBe(300);
  });
  it('base + per km beyond the minimum', () => {
    expect(priceDelivery(rc, 4000, { night: false, size: 'small' }, noCaps)).toBe(600);
  });
  it('adds night and bulky surcharges', () => {
    expect(priceDelivery(rc, 4000, { night: true, size: 'bulky' }, noCaps)).toBe(600 + 150 + 500);
  });
  it('applies admin caps', () => {
    expect(priceDelivery(rc, 4000, { night: false, size: 'small' }, { max_per_km_cents: 50, floor_minimum_cents: 400 })).toBe(400);
  });
  it('rounds to whole cents', () => {
    expect(Number.isInteger(priceDelivery(rc, 1234, { night: false, size: 'small' }, noCaps))).toBe(true);
  });
  it('rejects negative distance', () => {
    expect(() => priceDelivery(rc, -1, { night: false, size: 'small' }, noCaps)).toThrow();
  });
  it('prices en-route detours', () => {
    expect(priceEnroute(rc, 600, 100, noCaps)).toBe(160);
  });
  it('VAT inside 12.5%', () => {
    expect(vatPortion(1125)).toBe(125);
  });
});

describe('state machine', () => {
  it('allows the happy path', () => {
    const path = ['PAID_HELD', 'DRIVER_ASSIGNED', 'AT_SHOP', 'PICKED_UP', 'ARRIVED', 'HANDED_OVER', 'ACCEPTED'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });
  it('blocks cancel after pickup', () => {
    expect(canTransition('PICKED_UP', 'CANCELLED')).toBe(false);
  });
  it('terminal states go nowhere', () => {
    for (const s of ['ACCEPTED', 'REFUNDED', 'CANCELLED', 'NOT_DELIVERED'] as const) expect(TRANSITIONS[s]).toHaveLength(0);
  });
});

// a straight east-west test road, ~11 km at the equator-ish latitude of Tarawa
const road: Road = [[172.90, 1.35], [173.00, 1.35]];

describe('distance', () => {
  it('haversine is about 111 km per degree', () => {
    expect(Math.round(haversine({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) / 1000)).toBe(111);
  });
  it('projects onto the road', () => {
    const p = positionOnRoad({ lat: 1.351, lng: 172.95 }, road);
    expect(Math.round(p.offset)).toBeGreaterThan(100);
    expect(Math.round(p.along / 1000)).toBe(6);
  });
  it('road distance ≥ straight line', () => {
    const a = { lat: 1.351, lng: 172.92 }, b = { lat: 1.349, lng: 172.98 };
    expect(roadDistance(a, b, road)).toBeGreaterThanOrEqual(Math.round(haversine(a, b)));
  });
  it('falls back without road data', () => {
    const a = { lat: 1.35, lng: 172.92 }, b = { lat: 1.35, lng: 172.93 };
    expect(roadDistance(a, b, null)).toBe(Math.round(haversine(a, b) * 1.3));
  });
});

describe('en-route', () => {
  const prev = { lat: 1.35, lng: 172.91 }, now = { lat: 1.35, lng: 172.92 }; // heading east
  it('accepts customer then shop ahead', () => {
    const r = checkEnroute(prev, now, { lat: 1.3502, lng: 172.95 }, { lat: 1.3502, lng: 172.98 }, road, 1000);
    expect(r.enroute).toBe(true);
  });
  it('rejects when shop is behind', () => {
    expect(checkEnroute(prev, now, { lat: 1.35, lng: 172.95 }, { lat: 1.35, lng: 172.90 }, road, 1000).enroute).toBe(false);
  });
  it('rejects a big detour', () => {
    expect(checkEnroute(prev, now, { lat: 1.36, lng: 172.95 }, { lat: 1.35, lng: 172.98 }, road, 1000).enroute).toBe(false);
  });
  it('is off without road data', () => {
    expect(checkEnroute(prev, now, now, now, null, 1000).enroute).toBe(false);
  });
});

describe('handoff tokens', () => {
  const kp = generateKeyPair();
  it('verifies offline with the public key', () => {
    const t = signHandoff({ o: 'ord_1', exp: 2_000_000_000 }, kp.privateKey);
    expect(verifyHandoff(t, kp.publicKey, 'ord_1', 1_900_000_000).ok).toBe(true);
  });
  it('rejects another order, expiry and tampering', () => {
    const t = signHandoff({ o: 'ord_1', exp: 1000 }, kp.privateKey);
    expect(verifyHandoff(t, kp.publicKey, 'ord_2', 0)).toMatchObject({ ok: false, reason: 'wrong_order' });
    expect(verifyHandoff(t, kp.publicKey, 'ord_1', 2000)).toMatchObject({ ok: false, reason: 'expired' });
    const other = generateKeyPair();
    expect(verifyHandoff(t, other.publicKey, 'ord_1', 0)).toMatchObject({ ok: false, reason: 'bad_signature' });
    expect(verifyHandoff('nonsense', kp.publicKey, 'ord_1')).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

describe('Kiribati time', () => {
  // 2026-11-10 10:30 UTC = 22:30 in Tarawa
  const late = Date.UTC(2026, 10, 10, 10, 30);
  const day = Date.UTC(2026, 10, 10, 0, 0); // 12:00 Tarawa
  it('adults only after 22:00', () => {
    expect(adultsOnly(late, '22:00')).toBe(true);
    expect(adultsOnly(day, '22:00')).toBe(false);
  });
  it('windows across midnight', () => {
    expect(inKiWindow(Date.UTC(2026, 10, 10, 15, 0), '22:00', '06:00')).toBe(true); // 03:00 Tarawa
  });
  it('formats dd/mm/yyyy', () => {
    expect(kiDate(Date.UTC(2026, 10, 10, 13, 0))).toBe('11/11/2026');
  });
});

describe('ratings', () => {
  it('shows New under 5 ratings', () => {
    expect(displayRating(4.9, 4)).toBe('New');
    expect(displayRating(4.86, 5)).toBe('4.9');
  });
  it('flags patterns only', () => {
    expect(shouldFlag('driver', 3.0, 10)).toBe(false);
    expect(shouldFlag('driver', 3.0, 20)).toBe(true);
    expect(shouldFlag('customer', 2.9, 5)).toBe(true);
  });
  it('running average', () => {
    expect(addToAverage(4, 1, 2)).toEqual({ avg: 3, count: 2 });
  });
});

describe('ride pricing', () => {
  const rrc = { baseCents: 300, perKmCents: 150, minimumCents: 500, nightCents: 100, waitPerMinCents: 50, cancelCents: 300 };
  it('fixed fare with minimum and night extra', async () => {
    const { priceRide } = await import('../src');
    expect(priceRide(rrc, 1000, false, { max_per_km_cents: null, floor_minimum_cents: null })).toBe(500);
    expect(priceRide(rrc, 4000, true, { max_per_km_cents: null, floor_minimum_cents: null })).toBe(300 + 600 + 100);
  });
  it('waiting: free minutes, per minute, capped by the buffer', async () => {
    const { waitingCharge } = await import('../src');
    expect(waitingCharge(0, 2 * 60_000, 3, 50, 500)).toBe(0);
    expect(waitingCharge(0, 6 * 60_000, 3, 50, 500)).toBe(150);
    expect(waitingCharge(0, 60 * 60_000, 3, 50, 500)).toBe(500);
  });
});
