-- 0006: easier pickups and guided prices.

-- Lagoon side / ocean side of the road, for the pickup and the drop-off
ALTER TABLE orders ADD COLUMN pickup_side TEXT CHECK (pickup_side IN ('lagoon','ocean'));
ALTER TABLE orders ADD COLUMN drop_side TEXT CHECK (drop_side IN ('lagoon','ocean'));
-- the driver tapped "I'm here" (rides and parcels): the rider/sender is told and can reply with one tap
ALTER TABLE orders ADD COLUMN here_at TEXT;
ALTER TABLE send_jobs ADD COLUMN pickup_side TEXT CHECK (pickup_side IN ('lagoon','ocean'));
ALTER TABLE send_jobs ADD COLUMN drop_side TEXT CHECK (drop_side IN ('lagoon','ocean'));

-- car colour, so riders can spot it ("white Toyota")
ALTER TABLE vehicles ADD COLUMN colour TEXT NOT NULL DEFAULT '';

-- Places: shared landmarks everyone can pick (owner_id NULL, pinned on the map by KiriGo admins) and each member's own saved
-- places (Home, Work, …). A place is a point plus the side of the road and a short note for the driver.
CREATE TABLE places (
  id TEXT PRIMARY KEY,
  owner_id TEXT,                     -- KiriPay member id; NULL = shared landmark
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('home','work','other','landmark')),
  label TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL,
  side TEXT CHECK (side IN ('lagoon','ocean')),
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_places_owner ON places(owner_id, active);


-- Ride requests waiting for a driver. Nothing is paid: when a driver comes online nearby, the rider is told and
-- books them in the usual way.
CREATE TABLE ride_waits (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  pickup_lat REAL NOT NULL, pickup_lng REAL NOT NULL,
  drop_lat REAL NOT NULL, drop_lng REAL NOT NULL,
  seats INTEGER NOT NULL DEFAULT 1,
  pickup_note TEXT NOT NULL DEFAULT '',
  pickup_side TEXT CHECK (pickup_side IN ('lagoon','ocean')),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','found','booked','expired','cancelled')),
  found_at TEXT,
  drivers_told INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ride_waits_status ON ride_waits(status, expires_at);
CREATE INDEX idx_ride_waits_customer ON ride_waits(customer_id, status);
