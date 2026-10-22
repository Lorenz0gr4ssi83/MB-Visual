-- QR della home del PC (22/10/2026): da applicare una volta al database online
--   wrangler d1 execute mbvisual-licenze --remote --file=migrations/001_qr_cellulari.sql
ALTER TABLE licenses ADD COLUMN mobile_lock TEXT;
CREATE TABLE IF NOT EXISTS mobile_links (
  token       TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  expires     TEXT NOT NULL,
  used        TEXT,
  device_id   INTEGER,
  created     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pair_codes (
  code        TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  device_id   INTEGER NOT NULL,
  expires     TEXT NOT NULL,
  used        TEXT
);
