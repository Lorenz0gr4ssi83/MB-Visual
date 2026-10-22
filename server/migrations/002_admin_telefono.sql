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
