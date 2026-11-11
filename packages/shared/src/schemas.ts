import { z } from 'zod';
import {
  CUSTOMER_REASON_TAGS, PROBLEM_CHOICES, PROBLEM_REASONS, SHOP_REASON_TAGS, SIZES, VEHICLE_TYPES,
} from './types';

const cents = z.number().int().min(0).max(10_000_000);
export const latLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

export const rateCardSchema = z.object({
  baseCents: cents, perKmCents: cents, minimumCents: cents, nightCents: cents, bulkyCents: cents,
});

export const quoteRequest = z.object({
  shopId: z.string().min(1).max(80),
  dropoff: latLng,
  size: z.enum(SIZES).default('small'),
  sort: z.enum(['closest', 'cheapest', 'top_rated']).default('closest'),
});

export const createOrderRequest = z.object({
  quoteId: z.string().min(1),
  driverId: z.string().min(1),
  /** other drivers from the same quote, in the customer's order of preference, for automatic fallback */
  fallbackDriverIds: z.array(z.string()).max(10).default([]),
  source: z.enum(['kiripay_market', 'kiripos']),
  sourceRef: z.string().min(1).max(120),
  goodsCents: cents.refine((v) => v > 0, 'goods amount must be more than zero'),
  landmark: z.string().max(200).default(''),
  sharePhone: z.boolean().default(false),
  /** KiriPay hold id: the customer paid in the KiriPay app before this call */
  holdId: z.string().min(1),
});

export const problemRequest = z.object({
  reason: z.enum(PROBLEM_REASONS),
  choice: z.enum(PROBLEM_CHOICES),
  note: z.string().max(500).default(''),
  photoId: z.string().min(1),
});

export const rateRequest = z.object({
  ratings: z.array(z.object({
    to: z.enum(['customer', 'shop', 'driver']),
    stars: z.number().int().min(1).max(5),
    reasons: z.array(z.enum([...CUSTOMER_REASON_TAGS, ...SHOP_REASON_TAGS])).max(6).default([]),
    comment: z.string().max(300).default(''),
  })).min(1).max(2),
});

export const driverApplyRequest = z.object({
  firstName: z.string().min(1).max(40),
  vehicle: z.object({
    type: z.enum(VEHICLE_TYPES),
    plate: z.string().max(20).default(''),
    canBulky: z.boolean().default(false),
    photoId: z.string().min(1),
  }),
  licencePhotoId: z.string().min(1).optional(),
  rateCard: rateCardSchema,
  acceptTerms: z.literal(true),
});

export const gpsPoint = z.object({
  lat: z.number(), lng: z.number(), at: z.number().int(), acc: z.number().min(0).max(5000).optional(),
});

export const handoffRequest = z.object({
  /** signed QR token (works offline) OR the 4-digit code (online only) */
  token: z.string().max(600).optional(),
  code: z.string().regex(/^\d{4}$/).optional(),
  photoId: z.string().min(1),
  at: z.number().int(),
  lat: z.number(),
  lng: z.number(),
  receivedBySomeoneElse: z.boolean().default(false),
  receiverName: z.string().max(80).default(''),
  receiverIsChild: z.boolean().default(false),
  adultConfirmed: z.boolean().default(false),
  faceRefused: z.boolean().default(false),
}).refine((v) => !!v.token || !!v.code, 'scan the QR or type the code');

export const shopFaultRequest = z.object({ response: z.enum(['agree', 'dispute']), note: z.string().max(500).default('') });

export const adminRuling = z.object({
  atFault: z.enum(['shop', 'customer', 'driver']),
  /** partial refund of goods, cents; omit for all */
  refundGoodsCents: cents.optional(),
  note: z.string().max(1000).default(''),
});

export const rideRateCardSchema = z.object({
  baseCents: cents, perKmCents: cents, minimumCents: cents, nightCents: cents, waitPerMinCents: cents, cancelCents: cents,
});

export const rideQuoteRequest = z.object({
  pickup: latLng,
  dropoff: latLng,
  seats: z.number().int().min(1).max(12).default(1),
  sort: z.enum(['closest', 'cheapest', 'top_rated']).default('closest'),
});

export const createRideRequest = z.object({
  quoteId: z.string().min(1),
  driverId: z.string().min(1),
  fallbackDriverIds: z.array(z.string()).max(10).default([]),
  holdId: z.string().min(1),
  pickupNote: z.string().max(200).default(''),
  dropNote: z.string().max(200).default(''),
  sharePhone: z.boolean().default(false),
  /** KiriPay members (from the rider's contacts) to follow this trip */
  buddies: z.array(z.string().regex(/^[A-Za-z0-9_-]{3,80}$/)).max(5).default([]),
  sourceRef: z.string().min(6).max(120),
});

export const rideApplyRequest = z.object({
  seats: z.number().int().min(1).max(12),
  roadworthyPhotoId: z.string().min(1),
  rateCard: rideRateCardSchema,
});

// ---------------------------------------------------------------- KiriGo Send

export const SEND_ITEMS = ['document', 'small', 'medium', 'bulky'] as const;
export type SendItem = (typeof SEND_ITEMS)[number];

/** A sender posts a parcel job; drivers bid on it. Times are ISO strings. */
export const sendJobRequest = z.object({
  pickup: latLng, pickupNote: z.string().max(200).default(''),
  dropoff: latLng, dropNote: z.string().max(200).default(''),
  item: z.enum(SEND_ITEMS), description: z.string().max(200).default(''),
  recipientName: z.string().trim().min(1).max(60),
  recipientPhone: z.string().trim().max(30).default(''),
  recipientUserId: z.string().max(64).nullable().default(null),
  pickupAfter: z.string().datetime(), deliverBy: z.string().datetime(),
  sourceRef: z.string().min(4).max(64),
});
export const sendBidRequest = z.object({ priceCents: z.number().int().positive(), note: z.string().max(140).default('') });
export const sendChooseRequest = z.object({ bidId: z.string().min(1), holdId: z.string().min(1), sharePhone: z.boolean().default(false) });
