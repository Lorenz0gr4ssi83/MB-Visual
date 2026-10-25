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
  warn_expiring TEXT,                         -- avviso "in scadenza" gia' dato (si azzera cambiando la scadenza)
  warn_expired TEXT,                          -- avviso "scaduta" gia' dato
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
  archived    INTEGER NOT NULL DEFAULT 0,      -- archiviato dalla Panoramica (non compare piu' nell'elenco normale)
  created     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- QR della home del PC: link monouso (server/migrations/001_qr_cellulari.sql per i database gia' creati)
CREATE TABLE IF NOT EXISTS mobile_links (
  token       TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  expires     TEXT NOT NULL,
  used        TEXT,
  device_id   INTEGER,
  created     TEXT NOT NULL DEFAULT (datetime('now')),
  offer_fp    TEXT,   -- app Android: impronta (sha256 di IP + telefono) del browser che ha aperto il link (migrazione 006)
  offered     TEXT
);
-- codice di 6 cifre per l'app installata su iPhone (non vede i cookie di Safari): stesso posto del browser
CREATE TABLE IF NOT EXISTS pair_codes (
  code        TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  device_id   INTEGER NOT NULL,
  expires     TEXT NOT NULL,
  used        TEXT
);

-- App per telefono di MB Visual Admin (server/src/adminapp.js): sessioni, impronta/PIN (WebAuthn), codici di 6 cifre,
-- tentativi sbagliati e iscrizioni alle notifiche push
CREATE TABLE IF NOT EXISTS admin_sessions (
  n              INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash     TEXT NOT NULL UNIQUE,           -- SHA-256 del cookie (il cookie vero resta solo nel telefono)
  name           TEXT NOT NULL DEFAULT '',
  created        TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  expires        TEXT NOT NULL,
  revoked        INTEGER NOT NULL DEFAULT 0,
  cred_id        TEXT,                           -- passkey del telefono (impronta / volto / PIN)
  cred_key       TEXT,                           -- chiave pubblica (JWK)
  cred_alg       INTEGER,
  cred_count     INTEGER NOT NULL DEFAULT 0,
  unlocked_until TEXT
);
CREATE TABLE IF NOT EXISTS admin_challenges (
  id      TEXT PRIMARY KEY,
  session INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  expires TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_pairs (
  code    TEXT PRIMARY KEY,                      -- SHA-256 del codice di 6 cifre
  expires TEXT NOT NULL,
  used    TEXT
);
CREATE TABLE IF NOT EXISTS admin_fails (
  ip    TEXT PRIMARY KEY,
  n     INTEGER NOT NULL DEFAULT 0,
  first TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_push (
  endpoint TEXT PRIMARY KEY,
  session  INTEGER NOT NULL,
  p256dh   TEXT NOT NULL,
  auth     TEXT NOT NULL,
  created  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- impostazioni dell'app di gestione (notifiche a scelta): server/migrations/003_impostazioni.sql
CREATE TABLE IF NOT EXISTS admin_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- statistiche d'uso anonime (consenso esplicito nell'app): server/migrations/005_statistiche.sql
-- nessuna scadenza automatica: cancellazione alla revoca del consenso o su richiesta
CREATE TABLE IF NOT EXISTS usage_days (
  inst     TEXT NOT NULL,                        -- identificativo casuale dell installazione (non legato a licenza o PC)
  day      TEXT NOT NULL,                        -- AAAA-MM-GG
  app      TEXT NOT NULL DEFAULT '',               -- pc | mac
  version  TEXT NOT NULL DEFAULT '',
  os       TEXT NOT NULL DEFAULT '',
  arch     TEXT NOT NULL DEFAULT '',
  lang     TEXT NOT NULL DEFAULT '',
  launches INTEGER NOT NULL DEFAULT 0,
  seconds  INTEGER NOT NULL DEFAULT 0,
  comps    TEXT NOT NULL DEFAULT '[]',             -- componenti attivi (JSON)
  exts     TEXT NOT NULL DEFAULT '{}',             -- estensioni aperte -> volte (JSON)
  funcs    TEXT NOT NULL DEFAULT '{}',             -- funzioni usate -> volte (JSON)
  errors   TEXT NOT NULL DEFAULT '{}',             -- errori dei visualizzatori "visualizzatore|tipo|ext" -> volte (JSON)
  received TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (inst, day)
);
CREATE INDEX IF NOT EXISTS usage_days_day ON usage_days (day);
