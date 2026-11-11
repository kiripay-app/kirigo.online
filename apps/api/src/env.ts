export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PHOTOS: R2Bucket;
  TILES: R2Bucket;
  ORDER_TRACKER: DurableObjectNamespace;
  DRIVER_PRESENCE: DurableObjectNamespace;

  SESSION_SECRET: string;
  HANDOFF_PRIVATE_KEY: string;
  HANDOFF_PUBLIC_KEY: string;
  KIRIPAY_URL?: string;
  KIRIPAY_ESCROW_KEY?: string;
  KIRIPAY_SERVICE_KEY?: string;
  /** secret, the same value as KiriPay's KIRIGO_SMS_KEY: texts to non-members go through KiriPay's Twilio (src/lib/sms.ts) */
  KIRIPAY_SMS_KEY?: string;
  KIRIPOS_SERVICE_KEY?: string;
  KIRIPOS_URL?: string;
  KIRIPAY_MODE?: 'live' | 'mock';
  APP_ENV?: string;
  /** optional GeoJSON LineString of the main road, as a JSON string (see docs/road-data.md) */
  ROAD_GEOJSON?: string;
}

export type Actor =
  | { type: 'customer'; id: string }
  | { type: 'shop'; id: string }
  | { type: 'driver'; id: string; userId: string }
  | { type: 'admin'; id: string; role: string }
  | { type: 'system'; id: null };

export interface Vars {
  actor: Actor;
}

export type AppEnv = { Bindings: Env; Variables: Vars };
