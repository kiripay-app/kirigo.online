-- Riders check the driver's face before getting in: today's shift selfie beside a face photo the KiriGo team
-- cropped from the driver's licence at approval. A rider who says they don't match (or the selfie is unclear)
-- cancels free, and the team is told; repeated reports pause the driver's rides until someone checks.
ALTER TABLE drivers ADD COLUMN face_photo_id TEXT;

CREATE TABLE face_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  rider_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('no_match','unclear','no_photo')),
  selfie_photo_id TEXT,
  paused_driver INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  handled_by TEXT, handled_at TEXT, note TEXT
);
CREATE INDEX idx_face_reports_driver ON face_reports(driver_id, at);
CREATE INDEX idx_face_reports_open ON face_reports(handled_at);
