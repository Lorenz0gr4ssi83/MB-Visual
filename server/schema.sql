-- Server delle licenze di MB Visual (Cloudflare D1 / SQLite)
-- Una licenza = 1 PC + 2 cellulari (modificabili per licenza). Un cambio dispositivo genera una chiave nuova
-- (stesso "root"): la vecchia diventa "sostituita" e tutti i suoi dispositivi smettono di funzionare.

CREATE TABLE IF NOT EXISTS licenses (
  key         TEXT PRIMARY KEY,               -- MBV-XXXXX-XXXXX-XXXXX-XXXXX
  root        TEXT NOT NULL,                  -- prima chiave della catena (conta i cambi dispositivo)
  customer    TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active', -- active | revoked | replaced
  replaced_by TEXT,
  max_pc      INTEGER NOT NULL DEFAULT 1,
  max_mobile  INTEGER NOT NULL DEFAULT 2,
  expires     TEXT,                           -- scadenza facoltativa (ISO), null = senza scadenza
  mobile_lock TEXT,                           -- ultima attivazione di un cellulare dal QR (blocco di qualche minuto)
  created     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS devices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT NOT NULL,
  kind        TEXT NOT NULL,                  -- pc | mobile
  device      TEXT NOT NULL,                  -- impronta del dispositivo (hash)
  name        TEXT NOT NULL DEFAULT '',
  version     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active', -- active | revoked
  activated   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS devices_license ON devices(license_key);

CREATE TABLE IF NOT EXISTS requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT NOT NULL,
  root        TEXT NOT NULL,
  type        TEXT NOT NULL,                  -- change | report
  message     TEXT NOT NULL DEFAULT '',
  device_name TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',   -- open | pending | done | closed
  new_key     TEXT,
  created     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- avvisi per l'app di gestione (attivazioni, richieste, segnalazioni, problemi)
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                  -- activation | change | change_pending | report | limit | invalid_key | revoked_use
  license_key TEXT,
  text        TEXT NOT NULL,
  read        INTEGER NOT NULL DEFAULT 0,
  created     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- QR della home del PC: link monouso (server/migrations/001_qr_cellulari.sql per i database gia' creati)
CREATE TABLE IF NOT EXISTS mobile_links (
  token       TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  expires     TEXT NOT NULL,
  used        TEXT,
  device_id   INTEGER,
  created     TEXT NOT NULL DEFAULT (datetime('now'))
);
-- codice di 6 cifre per l'app installata su iPhone (non vede i cookie di Safari): stesso posto del browser
CREATE TABLE IF NOT EXISTS pair_codes (
  code        TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  device_id   INTEGER NOT NULL,
  expires     TEXT NOT NULL,
  used        TEXT
);
