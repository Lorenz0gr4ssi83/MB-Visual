-- App Android aperta dalla schermata Home dopo l'installazione dalla pagina del QR (25/10/2026): si attiva da sola
--   wrangler d1 execute mbvisual-licenze --remote --command "ALTER TABLE mobile_links ADD COLUMN offer_fp TEXT"
--   wrangler d1 execute mbvisual-licenze --remote --command "ALTER TABLE mobile_links ADD COLUMN offered TEXT"
ALTER TABLE mobile_links ADD COLUMN offer_fp TEXT;
ALTER TABLE mobile_links ADD COLUMN offered TEXT;
