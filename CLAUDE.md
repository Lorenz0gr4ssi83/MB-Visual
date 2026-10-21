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

## Revisione 3 (21/10/2026) - richieste dell'utente e stato
PC dell'utente: Windows 11 su ARM64. Python 3.13 **x64** in `%LOCALAPPDATA%\Programs\Python\Python313-x64` (gira in emulazione;
l'exe x64 funziona anche sugli altri PC aziendali). L'ambiente `%USERPROFILE%\.mbvisual\venv` usa quel Python.
1. 3D: clic sul modello -> elemento evidenziato e reso visibile nell'albero (rami aperti a richiesta, righe create solo quando servono) - FATTO
2. 3D: modalita' Ruota / Sposta / Seleziona (riquadro di selezione, Ctrl aggiunge/toglie, Esc deseleziona) - FATTO
6. 3D: scheda BIM completa in `ui/js/bim.js` (attributi, posizione piano/edificio, tipo e sue proprieta', tutti i Pset/Qset con unita'
   del progetto, materiali con strati, classificazioni, relazioni, dati IFC grezzi; ricerca, copia, CSV) - FATTO
8a. DWG "out of WASM memory": motore libredwg nuovo per ogni disegno + secondo tentativo (cad2d.js `decodeDwg`) - FATTO;
    il file che dava l'errore non e' ancora stato provato (chiederlo all'utente)
8b. File solo su OneDrive: `api/info` non li legge senza conferma (`nuvola: true`), l'interfaccia chiede "Scarica e apri";
    se il download viene annullato l'apertura si ferma (prima `misc.sniff` ignorava l'errore e il visualizzatore rileggeva il file) - FATTO
5 (parte). Pulsante "Modifica in Excel/Word/PowerPoint" (programmi trovati con `paths.find_office`) e ricarica automatica dei file
   salvati da altri programmi (`api/stat` ogni 2 s sulla scheda attiva) - FATTO
- Tasto indietro (telefono/browser/mouse): `setupBack` in app.js, voce di cronologia di riserva; `onBack` nei visualizzatori - FATTO
4. Editor PDF - FATTO (prima parte): `mbvisual/pdfedit.py` (PyMuPDF) + `ui/js/pdfeditor.js` sopra pdf.js. Modifica del testo
   esistente (riga per riga, font Windows piu' simile incorporato con TextWriter e ridotto ai caratteri usati), Oscura (rimozione
   definitiva), Bianchetto, Annulla; menu Altro: comprimi, numeri di pagina, password (AES-256) e sblocco, pagina bianca,
   riordina, PDF -> Word (pdf2docx), pagine -> immagini. Le modifiche vanno su una copia di lavoro in TEMP_DIR/pdf-modifica;
   l'originale cambia solo con Salva. Solo app per PC (nella web app i pulsanti non compaiono).
   OCR "Rendi ricercabile": motore OCR di Windows chiamato da `mbvisual/ocr.ps1` (PowerShell, lingua it-IT), testo
   invisibile sotto la scansione. NON usare i pacchetti Python winrt: importati prima di PyMuPDF lo mandano in crash
   (anche nell'analisi di PyInstaller).
   Immagini, firme e testi nuovi: strumenti di pdf.js (in alto a destra nel documento).
5. ONLYOFFICE integrato - FATTO: build di github.com/ranuts/document (AGPL) in `%USERPROFILE%\.mbvisual\onlyoffice`
   (si rifa' con `pnpm install && pnpm run build` in `%USERPROFILE%\.mbvisual\src\oo-document`, poi copia di dist/).
   Servito da un secondo server locale (`server.onlyoffice_url`, intestazioni COOP/COEP/CORP, file .br con Content-Encoding);
   l'app principale manda COOP/COEP (pagina isolata). Visualizzatore `ui/js/viewers/oo.js` (postMessage open-buffer / save);
   alla pagina dell'editor si aggiunge uno script (server `_INJECT`) che segnala le modifiche (tasti + indicatore del motore)
   e forza il puntatore a freccia. Lingua: `?locale=it`. Solo app per PC; la web app usa gli editor leggeri.
3. Salva con nome in quasi ogni formato - FATTO: `mbvisual/convert.py` (Office via COM con pywin32, LibreOffice di riserva,
   Pillow, FFmpeg, PyMuPDF, pdf2docx, 7-Zip, fontTools, sqlite3/openpyxl, markdown). In app.js `chooseFormat` + `convertTo`
   (job con avanzamento). Collaudo 43/43 conversioni riuscite. 3D: glb, gltf, stl, obj, ply, usdz.
7. Modifica dei disegni CAD - FATTO: `ui/js/cadedit.js` (selezione, proprieta', Sposta/Copia/Ruota/Elimina, Linea, Polilinea,
   Rettangolo, Cerchio, Testo, aggancio, Orto F8, Annulla/Ripeti, nuovi layer) + `mbvisual/cadedit.py` (ezdxf): i DXF si
   modificano sull'originale (handle o posizione nel model space se il file non ha handle), i DWG si ricostruiscono in DXF
   da layer, blocchi ed entita'; uscita DXF, DWG (solo con ODA File Converter installato), PDF/SVG/PNG vettoriali.
- Rhino .3dm - FATTO: Rhino3dmLoader di three.js; i solidi salvati senza mesh (file esportati da EsaPRO) si ricostruiscono
  in `ui/js/rhino.js` (estrusioni da profili, Brep campionati, facce piane dai bordi). Albero per layer, user strings in scheda.
- Navisworks senza Navisworks - FATTO per NWD/NWC: `tools/nwd2mbv/nwd2mbv.cpp` sulla libreria open source nwd-reader
  (build: `tools/nwd2mbv/build.sh`, eseguibile in `%USERPROFILE%\.mbvisual\nwd`). Esporta gerarchia, proprieta', materiali
  (colori dagli asset Autodesk `generic_diffuse`) e geometria in metri; `ui/js/navis.js` la carica (oltre 3000 mesh: blocchi
  uniti per colore + copie invisibili per selezione). NWF: resta il modello federato dai file sorgente.
- Puntatore sempre a freccia (richiesta esplicita): regola globale in app.css e negli iframe (pdf.js, ONLYOFFICE).
