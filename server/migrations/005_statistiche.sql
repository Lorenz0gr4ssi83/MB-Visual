-- Statistiche d'uso anonime (solo con il consenso dell'utente): una riga per installazione e giorno, cancellate alla revoca
-- del consenso o su richiesta (nessuna scadenza automatica). Nessun IP, nessun dato della licenza, nessun nome di file.
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
