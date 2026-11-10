-- 0002: KiriGo Rides. Passenger trips reuse the order machinery (statuses, events, money, ratings, live tracking).
-- A ride is an order with service = 'ride'. Rides have no shop, so they all point at one placeholder shop row
-- that is never paid and never shown to KiriPOS. For rides: delivery_cents = the fare, goods_cents = a small
-- refundable buffer that covers waiting time or a late-cancellation fee.
ALTER TABLE orders ADD COLUMN service TEXT NOT NULL DEFAULT 'delivery' CHECK (service IN ('delivery','ride'));
ALTER TABLE orders ADD COLUMN seats INTEGER NOT NULL DEFAULT 1;
ALTER TABLE orders ADD COLUMN at_pickup_at TEXT;          -- driver arrived at the pickup; waiting time counts from here
ALTER TABLE orders ADD COLUMN waiting_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN eta_s INTEGER;              -- expected trip time, for overtime alerts
ALTER TABLE orders ADD COLUMN emergency_at TEXT;
ALTER TABLE orders ADD COLUMN drop_note TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_orders_service ON orders(service, status);
INSERT INTO shops (id, name, kiripay_merchant_id, delivery_enabled) VALUES ('kirigo-rides', 'KiriGo Rides', 'none', 0)
  ON CONFLICT(id) DO NOTHING;

-- what each driver does, and their ride approval
ALTER TABLE drivers ADD COLUMN deliveries_on INTEGER NOT NULL DEFAULT 1;
ALTER TABLE drivers ADD COLUMN rides_on INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drivers ADD COLUMN ride_status TEXT NOT NULL DEFAULT 'none' CHECK (ride_status IN ('none','pending','approved','suspended','rejected'));
ALTER TABLE drivers ADD COLUMN ride_seats INTEGER;
ALTER TABLE drivers ADD COLUMN roadworthy_photo_id TEXT;
ALTER TABLE drivers ADD COLUMN ride_approved_by TEXT;
ALTER TABLE drivers ADD COLUMN ride_approved_at TEXT;

-- a driver's prices for passengers, separate from deliveries
CREATE TABLE ride_rate_cards (
  driver_id TEXT PRIMARY KEY REFERENCES drivers(id),
  base_cents INTEGER NOT NULL CHECK (base_cents >= 0),
  per_km_cents INTEGER NOT NULL CHECK (per_km_cents >= 0),
  minimum_cents INTEGER NOT NULL CHECK (minimum_cents >= 0),
  night_cents INTEGER NOT NULL DEFAULT 0 CHECK (night_cents >= 0),
  wait_per_min_cents INTEGER NOT NULL DEFAULT 0 CHECK (wait_per_min_cents >= 0),
  cancel_cents INTEGER NOT NULL DEFAULT 0 CHECK (cancel_cents >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Trip buddies: KiriPay members following one trip, until shortly after it ends
CREATE TABLE trip_buddies (
  order_id TEXT NOT NULL REFERENCES orders(id),
  user_id TEXT NOT NULL,             -- KiriPay member id
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  until TEXT,                        -- set when the trip ends (+15 minutes); NULL while it runs
  stopped_at TEXT,                   -- the rider stopped sharing
  PRIMARY KEY (order_id, user_id)
);
CREATE INDEX idx_buddies_user ON trip_buddies(user_id);

-- alerts raised during a trip (off route, long stop, overtime, emergency). Kept with the trip.
CREATE TABLE trip_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('off_route','long_stop','overtime','emergency')),
  raised_by TEXT,                    -- 'system' | 'customer' | 'driver'
  lat REAL, lng REAL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  handled_by TEXT, handled_at TEXT, note TEXT
);
CREATE INDEX idx_alerts_order ON trip_alerts(order_id);
CREATE INDEX idx_alerts_open ON trip_alerts(handled_at, kind);

-- last movement per trip, for long-stop detection
CREATE TABLE trip_watch (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  lat REAL NOT NULL, lng REAL NOT NULL,
  still_since TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
