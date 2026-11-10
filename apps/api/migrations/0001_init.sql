-- KiriGo core schema. Money is integer cents. KiriGo never holds balances: every money movement is a
-- KiriPay escrow call, recorded in money_calls with the KiriPay transaction reference.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Shops are KiriPOS stores. KiriPOS keeps them up to date through PUT /pos/shops/:id
CREATE TABLE shops (
  id TEXT PRIMARY KEY,                       -- KiriPOS store id
  name TEXT NOT NULL,
  kiripay_merchant_id TEXT NOT NULL,         -- where goods money is released
  pickup_lat REAL, pickup_lng REAL,
  pickup_note TEXT,
  delivery_enabled INTEGER NOT NULL DEFAULT 0,
  min_customer_rating REAL,                  -- e.g. 3.0: no delivery to customers rated below
  rating_avg REAL, rating_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Customers are KiriPay members. Only what KiriGo needs: their rating.
CREATE TABLE customers (
  id TEXT PRIMARY KEY,                       -- KiriPay user id
  first_name TEXT,
  rating_avg REAL, rating_count INTEGER NOT NULL DEFAULT 0,
  delivery_restricted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE drivers (
  id TEXT PRIMARY KEY,                       -- drv_…
  kiripay_user_id TEXT NOT NULL UNIQUE,
  driver_code TEXT NOT NULL UNIQUE,          -- KG-0142, shown to customers
  first_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended','rejected')),
  licence_photo_id TEXT,
  licence_expiry TEXT,
  licence_matches_kyc INTEGER,
  review_note TEXT,
  approved_by TEXT, approved_at TEXT,
  free_until TEXT,                           -- free launch period end (ISO)
  fee_paid_until TEXT,                       -- monthly fee paid up to (ISO)
  fee_anchor_day INTEGER,                    -- day of month the fee is due (sign-up anniversary)
  rating_avg REAL, rating_count INTEGER NOT NULL DEFAULT 0,
  deliveries INTEGER NOT NULL DEFAULT 0,
  accept_then_cancel INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_drivers_status ON drivers(status);

CREATE TABLE vehicles (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  type TEXT NOT NULL CHECK (type IN ('motorbike','car','van','truck')),
  plate TEXT NOT NULL DEFAULT '',
  photo_id TEXT,
  can_bulky INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_vehicles_driver ON vehicles(driver_id, active);

CREATE TABLE rate_cards (
  driver_id TEXT PRIMARY KEY REFERENCES drivers(id),
  base_cents INTEGER NOT NULL CHECK (base_cents >= 0),
  per_km_cents INTEGER NOT NULL CHECK (per_km_cents >= 0),
  minimum_cents INTEGER NOT NULL CHECK (minimum_cents >= 0),
  night_cents INTEGER NOT NULL DEFAULT 0 CHECK (night_cents >= 0),
  bulky_cents INTEGER NOT NULL DEFAULT 0 CHECK (bulky_cents >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE shifts (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  selfie_photo_id TEXT,
  online_at TEXT NOT NULL,
  offline_at TEXT,
  spot_checked_by TEXT,
  spot_check_result TEXT CHECK (spot_check_result IN ('match','no_match'))
);
CREATE INDEX idx_shifts_driver ON shifts(driver_id, online_at);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  drop_lat REAL NOT NULL, drop_lng REAL NOT NULL,
  size TEXT NOT NULL,
  distance_m INTEGER NOT NULL,
  options_json TEXT NOT NULL,                -- [{driverId, priceCents, etaMin, …}]
  expires_at TEXT NOT NULL,
  used_by_order TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,                       -- ord_…
  kind TEXT NOT NULL DEFAULT 'delivery' CHECK (kind IN ('delivery','return','swap','correction','enroute')),
  parent_order_id TEXT REFERENCES orders(id),
  source TEXT NOT NULL,                      -- kiripay_market | kiripos
  source_ref TEXT NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  customer_id TEXT NOT NULL,
  driver_id TEXT REFERENCES drivers(id),
  quote_id TEXT,
  fallback_json TEXT NOT NULL DEFAULT '[]',  -- remaining driver choices [{driverId, priceCents}]
  pickup_lat REAL NOT NULL, pickup_lng REAL NOT NULL,
  drop_lat REAL NOT NULL, drop_lng REAL NOT NULL,
  landmark TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT 'small',
  distance_m INTEGER NOT NULL,
  goods_cents INTEGER NOT NULL CHECK (goods_cents >= 0),
  delivery_cents INTEGER NOT NULL CHECK (delivery_cents >= 0),
  hold_id TEXT,                              -- KiriPay escrow hold (parent orders); child trips pay from the parent's hold
  status TEXT NOT NULL,
  share_phone INTEGER NOT NULL DEFAULT 0,
  shop_ready INTEGER NOT NULL DEFAULT 0,
  handoff_code_hash TEXT,
  handoff_code_fails INTEGER NOT NULL DEFAULT 0,
  driver_paid INTEGER NOT NULL DEFAULT 0,
  shop_paid INTEGER NOT NULL DEFAULT 0,
  extra_cost_cents INTEGER NOT NULL DEFAULT 0, -- shop-fault trips (return/swap/correction) paid from this order's hold
  discount_cents INTEGER NOT NULL DEFAULT 0,      -- discount the customer accepted to keep a wrong item
  discount_offer_cents INTEGER,                  -- discount the shop offered, waiting for the customer
  return_received_at TEXT,
  failed_corrections INTEGER NOT NULL DEFAULT 0,
  problem_reason TEXT, problem_choice TEXT, problem_note TEXT,
  shop_fault TEXT CHECK (shop_fault IN ('agree','dispute')),
  offer_driver_id TEXT, offer_expires_at TEXT,
  assigned_at TEXT, picked_up_at TEXT, handed_over_at TEXT, accepted_at TEXT, problem_at TEXT, closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (source, source_ref, kind)
);
CREATE INDEX idx_orders_customer ON orders(customer_id, created_at);
CREATE INDEX idx_orders_shop ON orders(shop_id, created_at);
CREATE INDEX idx_orders_driver ON orders(driver_id, status);
CREATE INDEX idx_orders_status ON orders(status, handed_over_at);
CREATE INDEX idx_orders_parent ON orders(parent_order_id);

-- Append-only: who, what, when, where for every order. Nobody can change or delete it, admin included.
CREATE TABLE order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  type TEXT NOT NULL,
  data_json TEXT,
  lat REAL, lng REAL
);
CREATE INDEX idx_events_order ON order_events(order_id, id);
CREATE TRIGGER order_events_no_update BEFORE UPDATE ON order_events BEGIN SELECT RAISE(ABORT, 'order events are append-only'); END;
CREATE TRIGGER order_events_no_delete BEFORE DELETE ON order_events BEGIN SELECT RAISE(ABORT, 'order events are append-only'); END;

-- The GPS route of each delivery, written once when tracking ends. Deleted after 12 months.
CREATE TABLE order_routes (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  points_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('pickup','handoff','problem','return_receipt','licence','vehicle','selfie')),
  r2_key TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  lat REAL, lng REAL,
  taken_by_type TEXT NOT NULL,
  taken_by TEXT NOT NULL,
  delete_after TEXT,                         -- NULL = keep (licence, vehicle)
  deleted_at TEXT
);
CREATE INDEX idx_photos_order ON photos(order_id);
CREATE INDEX idx_photos_expiry ON photos(delete_after) WHERE deleted_at IS NULL;

CREATE TABLE ratings (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  from_type TEXT NOT NULL, from_id TEXT NOT NULL,
  to_type TEXT NOT NULL, to_id TEXT NOT NULL,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  comment TEXT NOT NULL DEFAULT '',
  visible_at TEXT,                           -- NULL = still blind
  removed_by TEXT, removed_reason TEXT,       -- admin removed it on appeal
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (order_id, from_type, to_type)
);
CREATE INDEX idx_ratings_to ON ratings(to_type, to_id);

CREATE TABLE disputes (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  reason TEXT NOT NULL,
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  due_at TEXT NOT NULL,                      -- admin target: 3 days
  ruled_at TEXT, ruled_by TEXT, at_fault TEXT, ruling_json TEXT, notes TEXT
);

-- Offers made to drivers (the 60-second accept window, and en-route jobs)
CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  kind TEXT NOT NULL CHECK (kind IN ('primary','enroute')),
  price_cents INTEGER NOT NULL,
  detour_m INTEGER,
  expires_at TEXT NOT NULL,
  result TEXT CHECK (result IN ('accepted','declined','expired','withdrawn')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_offers_driver ON offers(driver_id, result);
CREATE INDEX idx_offers_open ON offers(result, expires_at);

-- Every KiriPay escrow call. Unique idempotency key = a retry can never move money twice.
CREATE TABLE money_calls (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  driver_id TEXT,
  action TEXT NOT NULL,                      -- release | refund | charge
  to_kind TEXT,                              -- driver | shop | customer | fees
  to_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','done','failed')),
  kiripay_ref TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_money_order ON money_calls(order_id);
CREATE INDEX idx_money_pending ON money_calls(status, created_at);

-- What a shop still owes after a charge its wallet couldn't cover. Taken from its next goods release.
CREATE TABLE shop_debts (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  order_id TEXT NOT NULL,
  creditor_kind TEXT NOT NULL CHECK (creditor_kind IN ('customer','driver')),
  creditor_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  settled_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_debts_shop ON shop_debts(shop_id);

CREATE TABLE driver_fees (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  period TEXT NOT NULL,                      -- yyyy-mm (Kiribati)
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'owing' CHECK (status IN ('owing','paid','waived')),
  money_call_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (driver_id, period)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  from_type TEXT NOT NULL, from_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_messages_order ON messages(order_id, id);

-- Outgoing status webhooks to KiriPay and KiriPOS, retried until accepted
CREATE TABLE webhooks_out (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL CHECK (target IN ('kiripay','kiripos')),
  body_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX idx_webhooks_due ON webhooks_out(delivered_at, next_try_at);

-- One-time codes from the "Sign in with KiriPay" flow, and rate-limit counters
CREATE TABLE auth_states (state TEXT PRIMARY KEY, return_to TEXT, created_at TEXT NOT NULL);
CREATE TABLE attempts (k TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX idx_attempts ON attempts(k, at);

-- Test-only stand-in for the KiriPay escrow API (KIRIPAY_MODE=mock). Never used in production.
CREATE TABLE mock_holds (
  id TEXT PRIMARY KEY, payer_id TEXT NOT NULL, amount INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0,
  refunded INTEGER NOT NULL DEFAULT 0, ref TEXT, status TEXT NOT NULL DEFAULT 'open'
);
CREATE TABLE mock_moves (
  key TEXT PRIMARY KEY, hold_id TEXT, action TEXT NOT NULL, to_id TEXT, from_id TEXT, amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
