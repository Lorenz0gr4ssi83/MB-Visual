-- Panoramica: avvisi archiviati
ALTER TABLE events ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
