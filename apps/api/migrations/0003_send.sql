-- KiriGo Send: person-to-person parcels and documents. The sender posts a job with a time frame,
-- drivers who want it bid their own price, the sender picks one and pays. It then runs as a delivery
-- order from the 'kirigo-send' placeholder shop (no goods, the whole hold is the driver's fare).

CREATE TABLE send_jobs (
  id TEXT PRIMARY KEY,                         -- snd_…
  customer_id TEXT NOT NULL,                   -- the sender (KiriPay user id)
  source_ref TEXT NOT NULL,                    -- KiriPay's idempotency key
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','chosen','cancelled','expired')),
  pickup_lat REAL NOT NULL, pickup_lng REAL NOT NULL, pickup_note TEXT NOT NULL DEFAULT '',
  drop_lat REAL NOT NULL, drop_lng REAL NOT NULL, drop_note TEXT NOT NULL DEFAULT '',
  distance_m INTEGER NOT NULL,
  item TEXT NOT NULL CHECK (item IN ('document','small','medium','bulky')),
  description TEXT NOT NULL DEFAULT '',
  recipient_name TEXT NOT NULL,
  recipient_phone TEXT NOT NULL DEFAULT '',
  recipient_user_id TEXT,                      -- set by KiriPay when the phone/email matches a verified member
  pickup_after TEXT NOT NULL,
  deliver_by TEXT NOT NULL,
  order_id TEXT REFERENCES orders(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT,
  UNIQUE (customer_id, source_ref)
);
CREATE INDEX idx_send_jobs_status ON send_jobs(status, deliver_by);
CREATE INDEX idx_send_jobs_customer ON send_jobs(customer_id, created_at);
CREATE INDEX idx_send_jobs_recipient ON send_jobs(recipient_user_id);

CREATE TABLE send_bids (
  id TEXT PRIMARY KEY,                         -- bid_…
  job_id TEXT NOT NULL REFERENCES send_jobs(id),
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  withdrawn_at TEXT,
  UNIQUE (job_id, driver_id)
);
CREATE INDEX idx_send_bids_driver ON send_bids(driver_id, created_at);

ALTER TABLE orders ADD COLUMN send_job_id TEXT;
ALTER TABLE orders ADD COLUMN deliver_by TEXT;
ALTER TABLE orders ADD COLUMN return_trip INTEGER NOT NULL DEFAULT 0;

INSERT INTO shops (id, name, kiripay_merchant_id, delivery_enabled) VALUES ('kirigo-send','KiriGo Send','none',0) ON CONFLICT(id) DO NOTHING;
