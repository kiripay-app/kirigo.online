-- Phone alerts for drivers using the KiriGo Driver Android app (Firebase Cloud Messaging).
-- One row per phone; a token Firebase says is gone is deleted the next time we try it.
CREATE TABLE push_tokens (
  token TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  platform TEXT NOT NULL DEFAULT 'android',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_push_tokens_driver ON push_tokens(driver_id);
