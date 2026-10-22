-- Notifiche a scelta e avvisi di scadenza delle licenze
ALTER TABLE licenses ADD COLUMN warn_expiring TEXT;
ALTER TABLE licenses ADD COLUMN warn_expired TEXT;
CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
