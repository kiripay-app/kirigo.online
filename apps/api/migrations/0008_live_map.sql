-- Live operations map (admin). Who may open it, and a record of who did.
-- Super admins always can. Everyone else needs live_map = 1, which only a super admin can set.
CREATE TABLE admin_access (
  user_id       TEXT PRIMARY KEY,                -- KiriPay user id
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT '',        -- KiriPay admin role at last sign-in
  live_map      INTEGER NOT NULL DEFAULT 0 CHECK (live_map IN (0,1)),
  changed_by    TEXT,
  changed_at    TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE live_map_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id TEXT NOT NULL,
  name    TEXT NOT NULL DEFAULT '',
  action  TEXT NOT NULL,                         -- view | grant | revoke | trip
  detail  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_live_map_log_user ON live_map_log(user_id, action, at);
