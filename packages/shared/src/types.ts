export type Cents = number;

export const ORDER_STATUSES = [
  'PAID_HELD',        // paid, waiting for a driver to accept
  'DRIVER_ASSIGNED',  // driver accepted, heading to shop
  'AT_SHOP',          // driver arrived at shop
  'PICKED_UP',        // on the way to customer
  'ARRIVED',          // at customer's pin
  'HANDED_OVER',      // code scanned + photo; driver paid
  'ACCEPTED',         // customer accepted (or auto-release); shop paid
  'PROBLEM_REPORTED', // customer reported a problem; goods money held
  'REFUNDED',         // goods refunded to customer
  'NOT_DELIVERED',    // could not hand over (no adult after 22:00, customer absent)
  'CANCELLED',        // cancelled before pickup, full refund
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_KINDS = ['delivery', 'return', 'swap', 'correction', 'enroute'] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

export const VEHICLE_TYPES = ['motorbike', 'car', 'van', 'truck'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const SIZES = ['small', 'medium', 'bulky'] as const;
export type Size = (typeof SIZES)[number];

export const ACTOR_TYPES = ['customer', 'shop', 'driver', 'admin', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const DRIVER_STATUSES = ['pending', 'approved', 'suspended', 'rejected'] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export const PROBLEM_REASONS = ['wrong_item', 'damaged', 'missing_items', 'not_as_described'] as const;
export type ProblemReason = (typeof PROBLEM_REASONS)[number];

export const PROBLEM_CHOICES = ['keep', 'return', 'swap', 'correction'] as const;
export type ProblemChoice = (typeof PROBLEM_CHOICES)[number];

export const CUSTOMER_REASON_TAGS = [
  'not_home', 'wrong_pin', 'long_wait', 'rude', 'false_complaint', 'great_customer',
] as const;
export const SHOP_REASON_TAGS = ['order_not_ready', 'long_wait_pickup', 'well_packed'] as const;

export interface LatLng { lat: number; lng: number }

export interface RateCard {
  baseCents: Cents;
  perKmCents: Cents;
  minimumCents: Cents;
  nightCents: Cents;
  bulkyCents: Cents;
}

/** All business numbers live in the `settings` table. Null = must be set before go-live. */
export interface Settings {
  monthly_fee_cents: Cents | null;
  free_period_months: number;
  max_per_km_cents: Cents | null;
  floor_minimum_cents: Cents | null;
  night_hours: { start: string; end: string } | null;
  enroute_pickup_fee_cents: Cents | null;
  pickup_radius_km: number;
  drivers_shown: number;
  accept_window_s: number;
  door_wait_min: number;
  auto_release_h: number;
  shop_fault_response_h: number;
  return_handover_h: number;
  return_receipt_h: number;
  max_failed_corrections: number;
  enroute_max_detour_m: number;
  enroute_max_jobs: number;
  enroute_fallback_min: number;
  rating_blind_h: number;
  gps_interval_s: number;
  adults_only_after: string;
  retention_gps_months: number;
  retention_photos_days: number;
  retention_records_years: number;
  quote_valid_min: number;
  driver_signup_open: boolean;
  delivery_open: boolean;
  // rides
  rides_open: boolean;
  ride_buffer_cents: Cents;        // refundable extra held with each fare, covers waiting time / late-cancel fee
  ride_free_wait_min: number;
  ride_free_cancel_min: number;
  ride_noshow_wait_min: number;
  ride_min_deliveries: number;     // to be approved for rides
  ride_min_rating: number;
  buddy_after_min: number;         // Trip buddies keep seeing the trip this long after it ends
  alert_offroute_m: number;
  alert_stop_min: number;
  alert_overtime_factor: number;
}

export const DEFAULT_SETTINGS: Settings = {
  monthly_fee_cents: null,
  free_period_months: 3,
  max_per_km_cents: null,
  floor_minimum_cents: null,
  night_hours: null,
  enroute_pickup_fee_cents: null,
  pickup_radius_km: 3,
  drivers_shown: 5,
  accept_window_s: 60,
  door_wait_min: 5,
  auto_release_h: 24,
  shop_fault_response_h: 24,
  return_handover_h: 48,
  return_receipt_h: 24,
  max_failed_corrections: 2,
  enroute_max_detour_m: 1000,
  enroute_max_jobs: 2,
  enroute_fallback_min: 10,
  rating_blind_h: 48,
  gps_interval_s: 12,
  adults_only_after: '22:00',
  retention_gps_months: 12,
  retention_photos_days: 90,
  retention_records_years: 7,
  quote_valid_min: 5,
  driver_signup_open: true,
  delivery_open: false,
  rides_open: true,
  ride_buffer_cents: 500,
  ride_free_wait_min: 3,
  ride_free_cancel_min: 2,
  ride_noshow_wait_min: 5,
  ride_min_deliveries: 20,
  ride_min_rating: 4.3,
  buddy_after_min: 15,
  alert_offroute_m: 500,
  alert_stop_min: 5,
  alert_overtime_factor: 1.5,
};

export interface RideRateCard {
  baseCents: Cents;
  perKmCents: Cents;
  minimumCents: Cents;
  nightCents: Cents;
  waitPerMinCents: Cents;
  cancelCents: Cents;
}

/** Settings that block go-live while null. */
export const REQUIRED_BEFORE_LAUNCH: (keyof Settings)[] = [
  'monthly_fee_cents', 'max_per_km_cents', 'floor_minimum_cents', 'night_hours', 'enroute_pickup_fee_cents',
];
