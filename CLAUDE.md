# MB Visual - note per riprendere il lavoro

App desktop Windows (Python + pywebview/WebView2) che apre, visualizza e modifica il maggior numero possibile di formati.
Interfaccia in italiano. Logo: `ui/img/logo.png` (marchio MB Group con "VISUAL" al posto di "GROUP", generato da `tools/make_logo.py`).

## Struttura
- `app.py` - avvio: server HTTP locale (127.0.0.1, token) + finestra pywebview, trascinamento con percorsi reali, dialoghi file.
- `mbvisual/` - motore Python: `server.py` (API `/api/*`), `signed.py` (CAdES/PAdES), `archive.py` (7-Zip), `media.py` (FFmpeg),
  `office.py` (PowerPoint, Word da HTML, LibreOffice), `misc.py` (immagini, testo, email, SQLite, riconoscimento tipo), `paths.py`, `jobs.py`.
- `ui/` - interfaccia: `index.html`, `css/app.css`, `js/app.js` (schede, scelta visualizzatore), `js/core.js`, `js/viewers/*.js` (uno per tipo).
- `ui/formats.json` - **registro unico dei formati**: l'app sceglie il visualizzatore solo da qui; `ELENCO_FORMATI.md` si rigenera con `python tools/gen_elenco.py`.
  Regola chiesta dall'utente: un'estensione non in elenco NON si apre (solo byte grezzi). Aggiungere estensioni solo dopo averle provate.
- `ui/vendor/` - librerie JS con versioni fisse, scaricate da `tools/fetch_vendor.py`.
- `bin/7zip/` - 7-Zip incluso. FFmpeg arriva da `imageio-ffmpeg`.
- `tests/samples/` - file di prova (`tools/make_samples.py`).
- `avanzamento/` - pagina di avanzamento pubblicata come Artifact (https://claude.ai/artifact/2e3ywJjJCAd3CaXGEEutH9): `fasi.json` + `build.py`.

## Ambiente
- Python 3.13, ambiente virtuale FUORI da OneDrive: `%USERPROFILE%\.mbvisual\venv` (creare con `python -m venv`, poi `pip install -r requirements.txt`).
- Sviluppo: `python app.py` (finestra) oppure `python app.py --browser` (interfaccia nel browser).
- Pacchetto portatile: `python tools/build_portable.py` -> `%USERPROFILE%\.mbvisual\dist\MB Visual\` e `MB Visual - portatile.zip` nel progetto.

## Stato (20/10/2026)
Fatto e provato: PDF (pdf.js con annotazioni), p7m/PAdES, Word, Excel/CSV, PowerPoint, DWG (libredwg) e DXF (lettore interno),
STEP/IGES (occt-import-js), IFC (web-ifc) e mesh three.js, immagini (anche RAW/HEIC via Pillow/rawpy), audio/video con conversione FFmpeg,
archivi, email, SQLite, testo (Monaco), Markdown, HTML, SVG, font, EPUB, esadecimale.
Da fare / idee: provare con l'utente i suoi file reali; LibreOffice non installato su questo PC (formati office-lo da collaudare);
anteprime miniature per Revit/SolidWorks; spazio carta (layout) nei DWG; verifica catena di fiducia AgID per le firme.

## Revisione 2 (20/10/2026) - richieste dell'utente e stato
1. Interfaccia professionale: barra comandi grafite, schede con badge colorati per tipo, home con griglia tecnica - FATTO
2. Scorrimento pagina Formati non funzionante (#views copriva la pagina) - CORRETTO
3. Logo "MB Visual" ripetuto nella barra: tolto (resta nella cornice della finestra) - FATTO
4. Elenco formati verificato con i motori: `tools/verify_formats.py` -> `tests/verifica_formati.md`; aggiunte 247 estensioni
   (`tools/add_engine_formats.py`), ora 941. Collaudi automatici: `tests/test_media_formats.py` (68 audio/video OK), `tests/test_image_formats.py` (46 immagini OK)
5. 3D: selettore Ruota/Sposta, Maiusc inverte temporaneamente, Ctrl disattivato - FATTO
6. Navisworks senza Navisworks: impossibile decodificare la geometria (compressione proprietaria Autodesk, provato sul file reale).
   Soluzione: "modello federato" dai file sorgente IFC/STEP della stessa cartella (stesse coordinate) + Navisworks Freedom se presente.
7. Aggiunte professionali: Esplora cartella di progetto, Proprieta' file con SHA-256, strumenti PDF (unisci, estrai, elimina, ruota, dividi,
   filigrana, timbro: `mbvisual/pdftools.py`), "Aggiungi modello" nel 3D (federazione).
- Home senza elenco recenti; il pulsante Apri ha un menu: Nuovo file / Cartella di progetto / Recenti.
- Nota tecnica: le librerie UMD si caricano con `loadScript` (core.js) in un ambito senza `define`, per non farle catturare dal caricatore AMD di Monaco.
