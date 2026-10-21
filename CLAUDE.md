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
- Crea nuovo (Ctrl+N, menu Apri, home): `ui/js/newfile.js`. Modelli vuoti in `ui/templates` creati da `tools/make_templates.py`
  (Word A4, Excel, PowerPoint 16:9, PDF A4/A3, DXF vuoto e fogli A4-A1 con squadratura e cartiglio, SQLite); testo, codice,
  CSV, SVG, PNG/JPG generati al momento. Il file nasce dove si sceglie e si apre nel suo editor (nella web app resta in memoria).
- Editor PDF completo (21/10/2026) - FATTO: pulsante "Modifica PDF" -> barra strumenti + pannello proprieta' a destra
  (`ui/js/pdfeditor.js`), motore `mbvisual/pdfobjects.py` (API `pdf_objects` = oggetti della pagina, `pdf_ops` = elenco operazioni).
  Oggetti: seleziona/sposta/ridimensiona/elimina immagini, blocchi di testo (riscrittura con a capo, carattere, colore,
  allineamento; doppio clic = modifica sul posto), disegni vettoriali, campi, collegamenti. Testo riga, Macchina da scrivere,
  Immagine, Forme (rettangolo, arrotondato, ellisse, linea, freccia), Campi modulo (testo, piu' righe, tendina, elenco,
  spunta, opzione, firma), Collegamento, Bianchetto, Oscura, Annulla/Ripeti; menu Pagina (ruota, duplica, bianca, inserisci
  PDF, sposta, ritaglia, elimina) e Documento (proprieta', segnalibri, appiattisci). Nota: i campi creati da PyMuPDF hanno
  un /Parent con nome, flag e voci: `_sync_field` li riscrive li' (PyMuPDF aggiorna solo il widget figlio).
- Aggiornamento automatico (21/10/2026) - FATTO: `tools/build_portable.py` scrive `_internal/build.json` (versione + data)
  e pubblica in `App per PC` (robocopy; `versione.json` con numero/peso dei file di _internal scritto per ULTIMO;
  `--no-publish` per non pubblicare). `mbvisual/update.py`: all'avvio l'app cerca `App per PC` nelle cartelle OneDrive del PC
  (o quella scelta a mano, salvata in %LOCALAPPDATA%\MBVisual\aggiornamenti.json), propone la build piu' recente solo se
  OneDrive l'ha scaricata tutta; uno script PowerShell attende la chiusura, copia (/MIR solo dentro _internal) e riavvia.
  "Installa su questo PC" copia in %LOCALAPPDATA%\Programs\MB Visual con collegamenti Desktop e Start. Versione nella barra di stato.
  Le copie anteriori alla 1.3.0 non hanno l'aggiornamento: vanno sostituite una volta a mano.
  Dalla 1.3.1 installazione/aggiornamento sono lavori con avanzamento (la copia la fa Python: legge e quindi scarica
  i file "solo online"), collegamenti via pywin32, sostituzione a app chiusa con uno script .cmd (niente PowerShell).
- OneDrive (21/10/2026): la cartella del progetto restava "Sincronizzazione in sospeso" perche' ogni build riscriveva
  1,1 GB + zip da 450 MB + docs/. Ora `tools/synctree.py` copia solo i file con contenuto cambiato (App per PC e docs)
  e lo zip sta in %USERPROFILE%\.mbvisual\dist. OneDrive non sincronizza i .lnk.
- Build pulita quando ci sono modifiche altrui non committate: `git worktree add --detach %USERPROFILE%\.mbvisual\wt-build main`,
  copiare ui/vendor (in .gitignore), `tools/build_portable.py --no-publish` li', poi `--solo-pubblica` dal progetto.
- IFC (21/10/2026): la pagina e' isolata (COOP/COEP per ONLYOFFICE) e web-ifc sceglieva la versione multi-thread,
  che non parte: Init() restava in attesa per sempre. Ora `Init(undefined, true)`. Lettura a blocchi (StreamMeshes) con
  avanzamento; oltre 15 MB geometria unita per colore (`navis.buildBatches`) con copie di selezione che condividono
  i vertici (`navis.sharedProxy`). IFC sintetico 500 MB: 57 s, 2,1 GB.
- Editor PDF, motore (pdfobjects.py): gruppi (`cluster_drawings`) e tracciati (`tracciati` con seqno) -> `draw_edit`
  (style/targets/delete/to); rimozione con LINE_ART_REMOVE_IF_TOUCHED (IF_COVERED non toglie i tracciati racchiusi
  in un altro) e ridisegno dei tracciati estranei; immagini tolte con redazione solo in quel punto (`_take_image`,
  mai delete_image: cambierebbe l'immagine condivisa su tutte le pagine); `image_edit` (colori trasparenti multipli
  con tolleranza, opacita', rotazione, specchio, b/n); annotazioni `annot_add/update/delete`.
  Interfaccia (1.3.2, ui/js/pdfeditor.js) - FATTO: barra unica sempre visibile (gruppi Annota / Modifica / Moduli /
  Altro), pulsante acceso finche' si e' in modifica, opzioni nel pannello a destra; evidenzia, testo libero e penna
  sono gli editor di pdf.js comandati con gli eventi switchannotationeditormode / switchannotationeditorparams
  (i loro pulsanti sono nascosti con PDFJS_HIDE); un pulsante per tipo di campo (nome automatico, voci nel pannello,
  strumento che resta attivo); Seleziona con selezione multipla e a riquadro, filtro, ingresso nei gruppi (doppio clic),
  contagocce e anteprima a scacchi della trasparenza. Ogni modifica scrive un file NUOVO (mai sostituire quello
  aperto da pdf.js). apply_ops lavora in `_apply_ops` + gc + nuovi tentativi: i campi di PyMuPDF tengono aperto il file.
  `_page_draws` esclude dai disegni l'aspetto di campi e annotazioni (get_drawings li riporta).
- Utente non vuole per ora Inventor/Creo (21/10/2026).
- Migliorie rimandate dall'utente (21/10/2026): pulsanti "Modifica in AutoCAD/BricsCAD/Inventor"; funzioni Navisworks Manage
  (interferenze, viste salvate, annotazioni, computo); motore ODA (a pagamento).
- Editor CAD professionale (21/10/2026) - FATTO. `ui/js/cadgeom.js` = geometria condivisa (matrici, impaginazione esatta dei
  testi usata sia per disegnare sia per selezionare, curve analitiche/intersezioni, osnap, retini, quote nuove).
  Causa del "riquadro fuori dall'oggetto": riquadri dei testi senza allineamento/rotazione/trasformazione del blocco; inoltre
  spazio carta mescolato al modello nei DWG, attributi DWG non letti (libredwg li mette fuori dall'INSERT con il testo in un
  sotto-oggetto: `normalize` in cad2d.js), estrusione OCS -Z ignorata. `build` produce elementi (L/A/P/Q/F/N) con entita' (o)
  e percorso nei blocchi (s) + indice a griglia (`model.query`). `ui/js/cadedit.js`: comandi asincroni con riga di comando e
  alias AutoCAD (L, PL, C, A, EL, REC, T, MT, H, DLI, DAL, DAN, DRA, DDI, DOR, DCO, DBA, M, CO, RO, SC, MI, AR, O, TR, EX, F,
  CHA, X, E, DI, AREA; ? = elenco), selezione a clic/finestra/intersezione, Maiusc toglie, Ctrl dentro i blocchi, ciclo
  sugli oggetti sovrapposti, grip, aggancio F3, orto F8. `mbvisual/cadedit.py`: quote nuove -> vere DIMENSION (ezdxf
  render, stile MBVISUAL); quote dei DWG -> DIMENSION col blocco originale; per i DXF le entita' semplici si riscrivono e le
  altre si trasformano con `_xf` (prima le linee spostate venivano spostate due volte). Collaudo dalla console:
  `tests/cad_harness.js` (clic simulati in coordinate del disegno).

## Editor di immagini in stile Photoshop (21/10/2026) - FATTO
Le immagini si aprono in `ui/js/imgedit.js` (da `ui/js/viewers/image.js`): menu Modifica/Immagine/Livello/Seleziona/Filtro/
Visualizza/Finestra nella barra del visualizzatore, barra opzioni dello strumento, barra strumenti verticale con gli stessi gruppi,
icone (`ui/js/psicons.js`) e lettere di Photoshop (Maiusc+lettera = strumento successivo del gruppo), pannelli Proprieta'/Regolazioni/
Cronologia e Livelli. Scorciatoie in `keymap` (F1). Il puntatore resta la freccia: il contorno del pennello e' disegnato sul canvas.
- Modello: livelli dal basso { kind pixel|text|shape|adjust, c, x, y, opacity, blend (globalCompositeOperation), mask {c,x,y,on} con
  l'alfa come visibilita' }. I canvas NON si modificano mai sul posto (copia nuova a ogni modifica): la cronologia (50 stati) tiene
  solo riferimenti. Selezione = canvas alfa grande quanto il documento + contorno (Path2D) per le formiche.
- `ui/js/imgadjust.js`: regolazioni (anche livelli di regolazione non distruttivi) e filtri; `ui/js/imgfile.js`: PSD con ag-psd
  (`ui/vendor/ag-psd`, tools/fetch_vendor.py, versione fissa 31.0.2: livelli, maschere, fusione, regolazioni vere; verificato con
  psd-tools) e ORA con JSZip (attributi mbv:* per testi, forme, regolazioni e maschere; gli altri programmi vedono i pixel).
- Salva: PSD/ORA con livelli, PNG/JPG/WEBP nel browser, TIFF/BMP/GIF via `api/image_save`. Ctrl+S su un JPG con piu' livelli
  chiede dove salvare proponendo .psd (come Photoshop).
- Prove dalla console: `MB.tabs[i].api._ps` (stato, comandi) con eventi puntatore simulati; con il riquadro del browser nascosto
  requestAnimationFrame e' fermo (anteprime e adattamento allo schermo aspettano che torni visibile).

## Licenze (21/10/2026) - in corso
Decisioni dell'utente: Cloudflare Workers + D1 piano GRATUITO (Firebase Blaze scartato: a pagamento), attivazione online,
1 PC + 2 cellulari per licenza, cambio dispositivo da File -> Account = chiave nuova (la vecchia smette di funzionare
ovunque), max 3 cambi automatici l'anno poi approvazione, niente email per ora, setup.exe unico, repository da rendere
privato (lo fa l'utente SOLO dopo che l'app per cellulari e' online su Cloudflare, altrimenti GitHub Pages si ferma).
- `server/` (Worker): schema.sql, src/index.js (API /v1/* e /admin/*, attivazioni firmate Ed25519, app per cellulari
  servita dai file statici ASSETS solo con cookie di attivazione "mobile"; pagina di attivazione nel browser = istruzioni
  di installazione), wrangler.toml (segnaposto chiave pubblica e id del database).
  Collaudo SENZA Cloudflare: `node server/test/harness.mjs` (node:sqlite al posto di D1; workerd non esiste per Windows
  ARM64, quindi `wrangler dev` non parte su questo PC) - 40 prove; `node server/test/harness.mjs serve 8787` = server di
  prova (MBV_ADMIN_PROVA=codice finto per la gestione).
- Segreti FUORI da OneDrive e dal repo: `%USERPROFILE%\.mbvisual\licenze\chiavi.json` (chiave privata, codice di
  gestione; l'utente ne deve fare una copia di sicurezza), `server_url.txt` (indirizzo del server dopo la messa online),
  `database_id.txt`. `tools/license_setup.py chiavi|server`: scrive `mbvisual/license_pub.py` (chiave pubblica + URL) e
  prepara la copia di lavoro del server in `%USERPROFILE%\.mbvisual\server` (con .dev.vars). `tools/build_web.py --mobile`
  -> `%USERPROFILE%\.mbvisual\server\public`.
- App per PC: `mbvisual/license.py` (impronta MachineGuid, rinnovo a ogni avvio e ogni 6 h, offline 30 giorni) +
  API license/* nel server dell'app (senza licenza attiva risponde 402) + `ui/js/license.js` (schermata di attivazione,
  File -> Account e licenza). La licenza NON e' richiesta finche' LICENSE_URL e' vuoto (versioni distribuite libere) e in
  sviluppo; per provarla: MBV_LICENZA=1 MBV_LICENZE_URL=http://127.0.0.1:8787.
- App per cellulari: `ui/js/mlicenza.js` (solo nella build --mobile) + File -> Account tramite cookie.
- `admin/`: MB Visual Admin (pywebview + pystray: area di notifica, notifiche di Windows ogni 20 s, avvio con Windows);
  eseguibile con `python admin/build_admin.py` -> `%USERPROFILE%\.mbvisual\dist\MB Visual Admin`.
- ONLINE (21/10/2026): server https://mbvisual-licenze.lorenzograssi83.workers.dev (account Cloudflare dell'utente,
  D1 "mbvisual-licenze" in EEUR, segreti SIGNING_KEY/ADMIN_TOKEN caricati, app per cellulari = stessa URL).
  wrangler NON gira con Node ARM64: usare Node x64 portatile in %USERPROFILE%\.mbvisual
ode-x64 e wrangler installato in
  %USERPROFILE%\.mbvisual\server (PATH="$NODE:$PATH" "$NODE/npx.cmd" wrangler deploy|d1 ...). Ripubblicare: license_setup.py
  server, build_web.py --mobile, poi deploy dalla copia di lavoro.
- Setup: `tools/build_setup.py` (Inno Setup 6 in %LOCALAPPDATA%\Programs\Inno Setup 6) -> MBVisual-Setup-<ver>.exe; release
  pubblicate con gh (account Lorenz0gr4ssi83) su https://github.com/Lorenz0gr4ssi83/MB-Visual-Rilasci (v1.4.2):
  `gh release create v<ver> <setup> --repo Lorenz0gr4ssi83/MB-Visual-Rilasci`. L'app senza OneDrive si aggiorna da li'.
- DA FARE (decisione dell'utente): attivare l'obbligo di licenza = `server_url.txt` gia' scritto; lanciare
  `tools/license_setup.py chiavi` (scrive LICENSE_URL in license_pub.py) e fare una build SOLO quando l'utente ha creato le
  licenze per se' e i colleghi con MB Visual Admin. Poi rendere privato il repository MB-Visual (lo fa l'utente; prima
  spostare/spegnere la web app di GitHub Pages, sostituita dall'app per cellulari sul server).

## Editor di pubblicazioni in stile Publisher (21/10/2026) - FATTO
Formato proprio `.mbpub` (zip: document.json + immagini/ + anteprima.png), categoria `publisher` in formats.json (anche `.pub`,
tolto da office-lo), voce "Pubblicazione" in Crea nuovo (un file vuoto; i modelli si scelgono nella galleria che si apre da sola).
- `ui/js/pubmodel.js` modello (punti tipografici; colori "sN"/"sN:tinta" della combinazione, caratteri "+t"/"+b"; storie =
  caratteri con stile condiviso, "\n" porta le proprieta' del paragrafo, U+2028 a capo, U+FFFC campi pagina/data/unione),
  `pubtext.js` impaginazione del testo nelle caselle collegate (colonne, giustificato, elenchi, contorno attorno agli oggetti),
  `pubrender.js` disegno unico per schermo/miniature/PDF (CanvasPainter e RecordPainter), forme, matrici,
  `pubedit.js` editor (selezione, maniglie, rotazione, aggancio a guide/margini/oggetti, gruppi, ritaglio, testo, cronologia,
  tasti in keymap), `pubribbon.js` barra multifunzione e finestre, `pubcmds.js` comandi, `pubtemplates.js` 15 modelli,
  `pubexport.js` esportazioni, `pubicons.js`, `ui/css/publisher.css`, `ui/js/viewers/publisher.js`.
- PDF: `mbvisual/publisher.py` (API pub_pdf) con caratteri di Windows dal registro (grassetto/corsivo simulati se manca il file);
  morph di PyMuPDF lavora con y verso l'alto: la matrice del testo va coniugata (b e c col segno cambiato).
  Web app: PDF di ripiego con le pagine come immagini.
- `.pub`: API pub_import (job). Con Publisher installato tutto via COM (pagine, caselle collegate, forme, tabelle, WordArt;
  il resto con SaveAsPicture); senza Publisher solo testo (Quill/QuillSub/CONTENTS) e immagini. Colori COM = BGR.
- Prove dalla console: `MB.tabs[i].api._pb` (interfaccia E) e `E._pb` (stato, toPage/toScreen, canvas per eventi simulati).

## Montaggio video e audio in stile Premiere Pro (21/10/2026) - FATTO
Formato proprio `.mbvid` (JSON: settings, media con percorso assoluto + `rel`, tracce V/A, clip, transizioni, marcatori; schema
in testa a `ui/js/vidmodel.js`), categoria `videoproject` -> visualizzatore `ui/js/viewers/video.js`. Voce "Progetto video" in
Crea nuovo; nel lettore audio/video pulsante "Apri nel montaggio" (progetto temporaneo con il file gia' in timeline).
- `ui/js/videdit.js` interfaccia (area di lavoro Montaggio: Sorgente/Controlli effetti/Mixer, Programma, Progetto/Effetti,
  strumenti V A B N R C Y U P H Z T, timeline su canvas con miniature e forme d'onda, menu, tasti Premiere in keymap),
  `vidplay.js` riproduzione (un video/audio per clip vicino alla testina, Web Audio per guadagni/fade/mute/solo/misuratori),
  `vidgl.js` compositore WebGL2, `vidicons.js`, `ui/css/videdit.css` (sempre scuro).
- Esportazione `mbvisual/video.py` (API video_*): UN grafo FFmpeg con le STESSE formule dello shader (lutrgb+colorchannelmixer,
  gblur, convolution, colorkey, lut3d, crop+pad, xfade, blend con alfa, overlay). Movimento animato = filtro perspective con
  espressioni nel numero di fotogramma (`in`); opacita' animata = sendcmd; volume animato = volume eval=frame. Le transizioni
  tra due clip le allungano di meta' durata oltre il taglio (fotogramma fermo con tpad se manca materiale). I titoli li disegna
  il browser (renderTitle) e passano come PNG; i titoli NON si adattano alla sequenza (1 px = 1 px).
  FFmpeg lavora in una cartella temporanea con cwd = quella cartella (niente percorsi Windows nel grafo); se fallisce, grafo e
  comando restano in %TEMP%\MBVisual\video\ultima_esportazione.
- Stabilizza = vidstab in due passate su una copia; Normalizza = volumedetect -> guadagno clip; loudnorm opzionale sul mix.
- Prove dalla console: `MB.tabs[i].api._ve` (P, player, importPaths, placeMedia, addTransition, goto, sel...).

## Editor immagini con IA locale (21/10/2026)
Richiesta dell'utente: modifiche per moda, marketing, campionati IFBB senza i filtri dei servizi online. Filtri al MINIMO
concordati: solo (1) minori: blocco assoluto (parole del prompt + controllo eta' CLIP ViT-B/32 su ingresso e risultato,
blocco se p(bambino)+p(adolescente) > 0.45) e (2) atti sessuali espliciti: blocco del prompt. Nudo artistico/moda, intimo,
costumi (anche "meno vestiti"), pose audaci: permessi. safety_checker di diffusers disattivato. Non togliere i due blocchi.
- Motore: `ia/engine.py`, processo separato con il suo Python (ARM64 nativo su questo PC) in `%USERPROFILE%\.mbvisual\ia\venv`
  (o `%LOCALAPPDATA%\MBVisual\ia\venv`), modelli in `...\ia\modelli` (~8 GB). Server HTTP 127.0.0.1 con token,
  `/run {op}`: segment (SegFormer-B3 abiti), subject/removebg (BiRefNet ONNX), erase (LaMa ONNX), fill (Realistic Vision 6
  inpainting + LCM-LoRA 6 passi), generate, upscale (RRDBNet scritto a mano: spandrel e transformers vogliono torchvision,
  che per Windows ARM64 non c'e'). torch CPU da download.pytorch.org (non su PyPI per win_arm64); bf16 lentissimo.
- `mbvisual/ia.py` avvia il motore e fa da ponte (API ia/status, ia/put, ia/run come job); `ui/js/aiedit.js` = menu IA
  dell'editor immagini (`imgedit.js`, `aiHost`): risultati come livelli nuovi, la selezione e' la maschera. Solo app per PC.
- fill con `persona: true` (spunta "Abiti su una persona", attiva da sola dopo Seleziona parti): zona = selezione DENTRO la
  sagoma (BiRefNet), base = colore pelle (SegFormer) x luminosita' dell'originale solo dove c'era il capo, strength 0.82:
  il corpo non cambia forma. Livelli col risultato: `with_alpha` (paste con maschera su RGBA vuoto scuriva i bordi due volte
  = la "riga/alone" attorno alle zone). MBV_IA_DEBUG=cartella salva i passaggi intermedi.
- Forme: ControlNet Depth SD1.5 (`modelli/controlnet-depth`) guidato da Depth Anything V2 Small ONNX sul ritaglio originale
  (`StableDiffusionControlNetInpaintPipeline.from_pipe`); dopo: `match_color` (guadagno per canale dalla pelle attorno) e
  `match_grain` (rumore stimato con la mediana degli scarti, max 5). Qualita': veloce 512 LCM / alta 768 LCM (predefinita) /
  massima 768 DPM++ 28 passi; LCM-LoRA NON fusa (set_mode la accende/spegne). Alta con forme: ~7-9 min su questo PC.
- Tempi su questo PC (CPU): genera 512x768 ~5 min, cambio abito 2,5-3,5 min, soggetto 30-60 s, parti 10-30 s.
- Elaborazioni NON bloccanti: riquadro in basso a destra (aiedit.js `run`), si lavora negli altri file; risultato nella
  scheda di partenza, "Vai all'immagine" (window.MB.activate/active). Interrompi = effetto immediato nell'app + `ia_cancel`
  (`_id` della richiesta): il motore si ferma al passo successivo (progress() solleva Cancelled; un calcolo ONNX o il
  caricamento di un modello non si spezzano).
- Altri PC: `python tools/ia_setup.py` (Python 3.13 ARM64 o x64; CUDA se c'e' nvidia-smi) in %LOCALAPPDATA%\MBVisual\ia.

## App per Mac (22/10/2026) - codice pronto, build da collaudare su un Mac vero
Codice Python indipendente da Windows: ogni parte solo-Windows si spegne con garbo, nessun modulo fallisce all'import.
- `mbvisual/paths.py`: IS_WIN/IS_MAC, NO_WINDOW (0 fuori da Windows: subprocess rifiuta creationflags), DATA_DIR
  (Windows %LOCALAPPDATA%\MBVisual come prima; Mac ~/Library/Application Support/MBVisual), open_default/reveal/open_with
  (Finder, `open -a` per Office per Mac), 7zz, LibreOffice.app, Office per Mac (solo "Modifica in Word/Excel").
- `convert.py`: COM solo su Windows, sul Mac LibreOffice. `fonts.py` (nuovo): caratteri dal registro o dalle cartelle Fonts
  del Mac (fontTools), usato da publisher.py e pdfedit.py. `license.py`: impronta da IOPlatformUUID (`ioreg`); su Windows la
  stringa e' identica a prima (attivazioni valide). OCR sul Mac: `tools/mbvocr/mbvocr.swift` (framework Vision, stessa uscita
  JSON di ocr.ps1) -> bin/mbvocr. `update.py` sul Mac: solo release GitHub con asset `MBVisual-<ver>-mac.dmg` (hdiutil + ditto,
  script sh che sostituisce il pacchetto dopo la chiusura e lo riapre); "Installa" = copia in /Applications.
- Build: `tools/build_mac.py` (solo macOS) -> "MB Visual.app" + `MBVisual-<ver>-mac.dmg` (7zz 25.01 scaricato, ffmpeg,
  mbvocr, nwd2mbv da `tools/nwd2mbv/build_mac.sh`, ONLYOFFICE se in ~/.mbvisual/onlyoffice). Workflow
  `.github/workflows/build-mac.yml` (macos-14 arm64, solo avvio a mano: i minuti macOS costano 10x sui repository privati):
  prova gli import, costruisce ONLYOFFICE dallo stesso commit di ranuts/document (7bf478b), avvia l'app e chiama
  /api/update_check, carica il .dmg come artefatto. `requirements.txt`: pywin32 solo su Windows.
- DA FARE: (1) firma e notarizzazione Apple: serve l'Apple Developer Program (99 USD/anno) con certificato "Developer ID
  Application"; poi `codesign --options runtime --timestamp` con entitlements (JIT per WebKit/pywebview), `xcrun notarytool
  submit --wait` e `xcrun stapler staple` sul .dmg; segreti del certificato nei secrets di GitHub. Senza firma macOS chiede
  conferma al primo avvio (clic destro -> Apri) e l'aggiornamento automatico puo' essere bloccato da Gatekeeper.
  (2) Prove su un Mac vero (nessun Mac qui): finestra pywebview/WebKit, trascinamento dei file, apertura dal Finder
  (--argv-emulation copre solo il primo file; i successivi arrivano come Apple Event non gestiti), OCR Vision, nwd2mbv,
  ONLYOFFICE in WebKit (COOP/COEP, SharedArrayBuffer), licenza e aggiornamento da .dmg. (3) Pubblicare il .dmg nelle
  release di MB-Visual-Rilasci accanto al setup Windows. (4) Interfaccia: testi "PC"/"Esplora file"/"Installa su questo PC"
  da adattare al Mac; motore IA (ia_setup.py) non preparato per il Mac.
