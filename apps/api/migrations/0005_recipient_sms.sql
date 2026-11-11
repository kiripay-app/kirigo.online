-- Texts to KiriGo Send recipients who are NOT on KiriPay (they have no app, so SMS is how they get the driver's
-- details and their handoff code). Sent through KiriPay's Twilio service: POST KIRIPAY_URL/api/internal/sms.
-- One row per order + event; the cron sends them and retries. See src/lib/sms.ts.
CREATE TABLE sms_out (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,                 -- <order id>:<template>, also KiriPay's idempotency key
  order_id TEXT NOT NULL REFERENCES orders(id),
  template TEXT NOT NULL,                   -- send_on_the_way | send_arrived (KiriPay builds the actual text)
  to_phone TEXT NOT NULL,
  values_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT NOT NULL,
  sent_at TEXT,
  gave_up_reason TEXT,                      -- set when it will never be sent (bad number, limits, too late)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sms_out_due ON sms_out(sent_at, gave_up_reason, next_try_at);
