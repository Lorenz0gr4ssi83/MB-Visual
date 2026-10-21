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
- Inventor: vedi sezione "Autodesk Inventor senza Inventor" (22/10/2026). Creo: nessun lettore realistico.
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

## Archivi cloud (22/10/2026) - FATTO, collegamento reale da provare dopo la registrazione delle app
Pannello "Cloud" accanto a Esplora (solo app per PC): SharePoint/OneDrive (Microsoft Graph), Google Drive, Dropbox,
Autodesk Construction Cloud/BIM 360 (APS Data Management), senza sincronizzare le cartelle.
- `mbvisual/cloud.py` (solo urllib): OAuth 2.0 + PKCE nel browser predefinito, ritorno su `http://localhost:47613/callback`
  (porta fissa e configurabile: Dropbox e Autodesk vogliono l'indirizzo esatto; Google app desktop: `http://127.0.0.1:<porta>/`),
  server di ritorno aperto solo durante l'accesso (senza SO_REUSEADDR). Token in `%LOCALAPPDATA%\MBVisual\cloud_token.bin`
  cifrati con DPAPI (ctypes), rinnovo automatico, revoca/uscita. ID applicazione: `mbvisual/cloud_ids.py` (vuoti = servizio
  nascosto) o `%LOCALAPPDATA%\MBVisual\cloud.json` scritto da Cloud -> Configura (segreto Google cifrato DPAPI).
  Un solo ingresso API: `api_cloud` in server.py (`/api/cloud?op=stato|config|config_set|login|login_cancel|logout|list|search|
  open|pending|aperti|upload|upload_copy|skip|check|refresh|save_new|info|guida`).
- Apertura = download in `%TEMP%\MBVisual\cloud\<servizio>\<chiave>\<nome>` (+ `aperti.json`), poi il visualizzatore normale.
  `ui/js/cloud.js` ogni 2,5 s chiede `pending` (file salvati e fermi da 1,5 s) e li carica con controllo di versione
  (Graph If-Match cTag, Dropbox mode update rev, Google headRevisionId, Autodesk versione tip -> nuova versione); conflitto =
  Salva come copia / Sovrascrivi / Apri la versione del cloud / Decidi dopo (`skip`). Ogni 60 s la scheda attiva aperta dal
  cloud controlla la versione remota e, senza modifiche locali, la riscarica (la scheda si ricarica da checkExternalChange).
  Documenti nativi Google: esportati in docx/xlsx/pptx, al salvataggio si propone un file nuovo. File -> "Salva nel cloud..."
  (anche in un altro formato via api convert). app.js: solo import all'avvio e la voce di menu.
- Guida per l'utente (registrazioni Entra, Google Cloud, Dropbox, APS + integrazione personalizzata ACC): `ui/guide/archivi-cloud.md`.
- Testi tradotti: chiavi `cloud.*` (cloud.js, import `t as tr`: `t` e' la scheda attiva) e `srv_cloud.*` (cloud.py; la variabile
  dei token si chiama `toks`, non `t`). La guida e' solo in italiano.
- Collaudo SENZA account: `python tests/test_cloud.py` (finto fornitore OAuth + finte API Dropbox e Graph, 52 prove);
  interfaccia: `python tests/cloud_demo.py` (stampa l'indirizzo; accesso simulato). Nel riquadro browser di Claude i cookie
  `mbv` di 127.0.0.1/localhost vengono sovrascritti da altre sessioni: le API rispondono 403 dopo un po' (ricaricare con ?t=).

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

## Firma digitale PAdES/CAdES (22/10/2026) - FATTO (prova con smart card vera: la fa l'utente)
- `mbvisual/firma.py` (pyHanko 0.38, MIT): PAdES nei PDF (sottotipo ETSI.CAdES.detached; visibile con riquadro o invisibile;
  campi Firma1, Firma2... con aggiornamento incrementale: le firme precedenti restano valide), CAdES .p7m / .p7s separata /
  firma parallela su un .p7m (`_add_parallel` aggiunge il SignerInfo alla busta esistente) / busta annidata.
  Marca temporale RFC 3161 (HTTPTimeStamper, URL/utente/password in %LOCALAPPDATA%\MBVisual\firma.json, password cifrata
  con DPAPI). Dopo la firma verifica automatica con signed.py (+ apertura del PDF con PyMuPDF).
- `mbvisual/winsign.py`: magazzino personale di Windows via ctypes (crypt32/ncrypt): CryptAcquireCertificatePrivateKey +
  NCryptSignHash (RSA PKCS#1 v1.5, ECDSA) o CryptSignHash per i vecchi driver CryptoAPI; il PIN lo chiede Windows (finestra
  agganciata a quella in primo piano), l'app non lo vede. Catena dagli intermedi presenti in Windows (senza rete).
  `use_test_pfx` = SOLO collaudo: magazzino in memoria con chiave non salvata (stesso percorso NCrypt, nessun certificato
  installato nel PC). Elenco: si nascondono i certificati solo di autenticazione; nell'interfaccia i non qualificati
  (senza nonRepudiation, es. MS-Organization-Access) solo con "Mostra anche...".
- API unica `api/firma?op=` (certificati, impostazioni, p12, anteprima, uscita; pades/cades = lavori in background).
  Interfaccia `ui/js/firma.js` (anteprima della pagina da PyMuPDF, riquadro da trascinare); ingressi: pulsante Firma nel
  PDF, "Aggiungi firma" nei .p7m, File -> Firma digitale... per qualsiasi file. Solo app per PC.
- Collaudo: `python tests/test_firma.py [--tsa http://timestamp.digicert.com]` (21/21, 23/23 con marca): certificato
  autofirmato di prova generato al momento. In un browser di prova con piu' server MB Visual aperti il cookie di
  127.0.0.1 e' condiviso tra le porte: usare http://<nome>.localhost:<porta>/?t=... (nome a piacere: cookie separato) per non avere "non autorizzato".
- Revisione 2 (22/10/2026), richiesta dell'utente "CIE, anche senza lettore tramite app" e firma remota:
  * CIE con lettore: riconosciuta dall'emittente (Ministero dell'Interno) -> `cie: true`, mostrata come "CIE" (firma
    elettronica avanzata, non qualificata), mai filtrata.
  * Senza lettore: `mbvisual/firmaponte.py` = cartella di scambio (OneDrive, proposta da OneDriveCommercial/Consumer,
    "MB Visual - Firma"): il documento si copia li', sul telefono si firma con CieSign (app ufficiale IPZS, NFC) o con
    l'app del certificatore e si salva nella stessa cartella; `tel_stato` trova il file nuovo/modificato (fermo da 2 s),
    lo verifica (firme valide + stesso documento: PDF originale come prefisso, o contenuto del p7m uguale) e `tel_salva`
    lo copia accanto all'originale. CieSign NON ha API per altri programmi. Un ponte Wi-Fi con server sulla rete locale
    e' stato scartato (bloccato dai permessi: niente server esposti sulla LAN).
  * Firma remota: `mbvisual/csc.py` = client Cloud Signature Consortium v1/v2 (info, auth/login Basic, credentials/list|
    info|sendOTP|authorize, signatures/signHash; SCAL 1/2; RSA/ECDSA) agganciato a pyHanko. Collaudato con
    `tests/csc_mock.py` (servizio simulato su 127.0.0.1). Con Aruba/InfoCert/Namirial serve che il certificatore attivi
    l'accesso API (indirizzo e credenziali): non verificato con un servizio reale.
  * Testi in t() (chiavi firma.* e srv_firma.*, 5 lingue). server.py: risposta 403 chiude la connessione (la POST non
    letta rompeva la richiesta successiva con 501).

## Multilingua (22/10/2026) - REGOLA PER TUTTE LE SESSIONI
**Ogni testo nuovo visibile all'utente passa da t() con la chiave in `ui/i18n/it.json` E in `ui/i18n/en.json`** (anche es/fr/de
se possibile; chi manca ricade sull'inglese). Niente stringhe italiane scritte direttamente nell'interfaccia o nei messaggi del motore.
- JS: `import { t } from "./i18n.js"` (nei file dove `t` e' gia' una variabile locale: `import { t as tr }` e si usa `tr(...)`).
  `t("modulo.chiave", x, y)` con `{0}`, `{1}` nel testo; `t("k", { n })` con `{n}`; plurali `tn("k", n)` con chiavi `k.one`/`k.other`.
  Numeri e date: `fmtNum`, `fmtDate`, `fmtDateTime`, `LOCALE` da i18n.js (mai "it-IT" fisso). HTML statico: `data-i18n`, `data-i18n-title`.
- Python (mbvisual/): `from .i18n import t` e `t("srv_modulo.chiave", x)`: la lingua arriva dall'interfaccia (intestazione X-MBV-Lang).
- Chiavi: `<modulo>.<descrizione>` (es. `imgedit.nuovo_livello`, viewer `v_pdf.*`, motore `srv_convert.*`); comuni in `common.*`
  (Annulla = `common.annulla`, annulla azione = `common.annulla_op`, Salva, Chiudi, OK...). Nomi dei tasti: `keys.*` (Maiusc/Shift).
- Strumenti: `python tools/i18n_scan.py <file>` elenca i testi italiani non ancora tradotti; `--plan`/`--apply` li convertono;
  `python tools/i18n_check.py` controlla chiavi mancanti e segnaposto; `--merge file.json` unisce traduzioni
  (`{"chiave": ["it", "en", "es", "fr", "de"]}`). Il registro formati si traduce con le chiavi `fmt.<id>.name/view/edit`.
- Lingua: automatica da Windows (api/lang) o scelta in File > Impostazioni > Lingua (localStorage "mbv-lang", si applica ricaricando).

## App per telefono: scansione documenti e realta' aumentata (22/10/2026) - FATTO
Solo nella web app (window.MBV_WEB), tutto nel dispositivo, senza l'app per PC.
- Scansione: `ui/js/scanner.js` + `ui/css/scanner.css`; voce "Scansiona documento..." nel menu Apri e pulsante nella home (testi: chiavi scanner.* e ar.* in ui/i18n)
  (app.js `doScan`). Fotocamera (getUserMedia, posteriore) con bordi del foglio rilevati ~7 volte/s su copia a 480 px
  (`detectQuad`: Canny + Otsu, quadrilatero convesso piu' grande), scatto automatico quando il foglio e' fermo (poi
  aspetta che cambi), scatto manuale -> ritaglio con 4 angoli e lente, raddrizzamento (`warp`, rifilo 0,6%), filtri
  (colore migliorato/grigi = divisione per lo sfondo stimato; B/N = soglia adattiva; originale), pagine con ordine
  (frecce o tieni premuto e trascina), rotazione, eliminazione, importazione da galleria; PDF con pdf-lib (A4, Lettera
  o come il foglio) e testo invisibile da OCR (Tesseract.js, lingua ita, render mode 3) -> Condividi / Salva / Apri in
  MB Visual / Copia testo. Librerie in tools/build_web.py WEB_LIBS: OpenCV.js 4.10 (@techstark, Apache 2.0, 10 MB),
  tesseract.js 6.0.1 + core 6.0.0 (Apache 2.0), ita.traineddata best_int (Apache 2.0). Caricate solo al primo uso.
  ATTENZIONE: il modulo OpenCV e' "thenable" (then risolve con se stesso): mai `await cv` ne' restituirlo da una
  funzione async senza `delete cv.then` (blocca la pagina per sempre). Prove: `window.MB_SCAN` (pages, importFiles);
  foto di prova `tests/samples/scansione_foglio1/2.jpg`; fotocamera simulata sostituendo getUserMedia con
  canvas.captureStream() (con riquadro del browser nascosto sostituire anche requestAnimationFrame).
- Realta' aumentata: `ui/js/ar.js` + `ui/css/ar.css`, pulsante "Vedi in AR" in testa alla barra del visualizzatore 3D.
  Finestra con unita' del file (mm per CAD/mesh, m per IFC/glTF/Navisworks) e scala (1:1 ... 1:1000, proposta
  automatica se il modello supera 30 m). Android: WebXR immersive-ar + hit-test + dom-overlay (tocco = appoggia,
  un dito ruota, due dita scala, Sposta, Ruota 90, 100%). Scene Viewer NON usabile: vuole un URL pubblico del modello.
  iPhone: USDZExporter (quickLookCompatible, ancoraggio a piano orizzontale) + <a rel="ar"> con <img> dentro.
  `prepareModel`: solo mesh visibili, niente copie di selezione (userData.proxy), MeshStandardMaterial, multi-materiale
  diviso, istanze espanse, specchiature applicate ai vertici. Salva GLB/USDZ (condivisione) se l'AR non c'e'.
  Tasto indietro: `window.MBV_BACK` (app.js goBack lo chiama per primo).
- NON provati su telefono veri: fotocamera reale, sessione WebXR e Quick Look (vanno provati dall'utente).

## Confronto tra revisioni (22/10/2026) - FATTO
Avvio: File -> "Confronta con..." (file PDF/DWG/DXF/IFC aperto, si sceglie il secondo) oppure trascinando insieme due file
dello stesso tipo (domanda "Confronta / Apri separatamente"). Visualizzatore `compare` (`ui/js/viewers/compare.js`, scheda
con `compareWith`; vecchia = il file salvato prima, pulsante Inverti); moduli in `ui/js/compare/`, stile `ui/css/compare.css`.
Salva / Salva con nome = report (pdf, xlsx, csv; `noConvert` in app.js). Tutto nel browser: funziona anche nella web app.
Testi: chiavi `cmp.*`, `pdfcmp.*`, `cadcmp.*`, `ifccmp.*`, `v_compare.*`, `app.confront*` (it/en/es/fr/de complete).
- `common.js`: differenze tra sequenze (Myers con limite, `diffHunks`), PDF minimo scritto a mano (JPEG + testo Helvetica
  WinAnsi, ricercabile), tabelle del report, Excel con SheetJS (`ui/vendor/xlsx`), CSV con ";" e BOM, elenco virtuale.
- `pdfcmp.js`: pdf.js diretto (`/vendor/pdfjs/build/pdf.mjs`, render con intent "print": con "display" pdf.js aspetta
  requestAnimationFrame e si ferma a finestra nascosta). Sovrapposizione per pixel (grigio uguale, rosso solo vecchia, verde
  solo nuova, tolleranza 0,6 pt), zone cambiate (celle unite) con riquadri; allineamento automatico (maschere di inchiostro,
  ricerca grossolana + fine + piena risoluzione; scala se la larghezza pagina e' diversa) e manuale (trascina, frecce, X/Y mm,
  %, "Tutte le pagine"); vista affiancata con scorrimento sincronizzato per pagina; differenze di testo su tutto il documento
  (parole con posizione da getTextContent, pezzi attaccati riuniti). Le zone coperte per lo piu' da testo cambiato non si
  ripetono nell'elenco. Pagine abbinate per numero.
- `cadcmp.js`: `readDrawing`/`buildModel`/`ACI` esportati da cad2d.js. Abbinamento: firma (JSON canonico senza handle/owner,
  numeri a 1e-6, contenuto dei blocchi; blocchi anonimi *D/*U per contenuto) -> handle -> stessa posizione/tipo/layer.
  Modelli separati per uguali/eliminate/aggiunte/modificate (vecchia tratteggiata), riquadri di revisione, clic sul disegno.
- `ifccmp.js`: web-ifc, confronto per GlobalId; proprieta' = attributi, Pset/Qto (anche del tipo), tipo, materiali,
  contenitore; firma geometrica = triangoli + ingombro + baricentro al mm. Seconda revisione con la matrice di coordinamento
  della prima (come i modelli federati). Dettaglio proprieta' vecchia/nuova nel pannello a destra.
- Prove: `python tools/make_compare_samples.py` -> `tests/samples/confronto` (coppie PDF, DXF, IFC con modifiche note);
  dalla console `MB.active.api._cmp._pc / _cc / _ic`. Nel riquadro del browser di Claude i cookie del token sono condivisi
  con i server delle altre sessioni (403 a caso): per le prove aggiungere `t=<token>` alle fetch /api/.
## Segnalazioni BIM BCF (22/10/2026) - FATTO
Formato BCF (buildingSMART) 2.0/2.1/3.0, estensioni `.bcfzip`/`.bcf` (categoria `bcf` in formats.json, anche nella web app).
- `ui/js/bcf.js` lettura/scrittura (modello unico per tutte le versioni, schema in testa al file; file non interpretati come
  documents.xml/Documents/ e allegati delle segnalazioni conservati tali e quali). In scrittura: GUID minuscoli (3.0) e quelli
  malformati sostituiti, colori in maiuscolo, FieldOfView 45-60 in 2.1 (limiti dello schema), ServerAssignedId solo in 3.0.
  Valori standard in inglese nei file (Open, Clash, High...), nomi tradotti con le chiavi `bcf.status|type|priority.<valore>`
  (`lbl`); testi del pannello/report/visualizzatore in `bcfpanel.*`, `bcfreport.*`, `v_bcf.*` (5 lingue).
- `ui/js/bcfview.js` ponte con la scena 3D: coordinate BCF (metri, Z in alto) -> scena = C*N*mondo per IFC (C = matrice di
  coordinamento di web-ifc, verificata con un IFC georeferenziato) e N*S(1/m)*mondo per gli altri modelli (m = metri per unita').
  Elementi per GlobalId (`GetGuidFromExpressId`), elementi composti (facciate continue...) tramite IfcRelAggregates/IfcRelNests;
  modelli non IFC: AuthoringToolId = posizione nell'albero ("0/3/1"). Visibilita' sugli elementi (non con Isola, che spegne le
  mesh e non funziona con gli IFC uniti per colore); sezioni = piu' piani (`setClip` in model3d.js, voce "Sezione del punto di vista").
  Camera ortogonale resa in prospettiva con la stessa altezza inquadrata.
- `ui/js/bcfpanel.js` pannello (elenco con filtri, scheda, punti di vista, commenti, Salva 2.1/3.0, report) + `attach3d` per
  il visualizzatore 3D (pulsante "Segnalazioni"; copia di recupero in IndexedDB per modello finche' non si salva in un BCF;
  autore in localStorage `mbv-bcf-autore`). `ui/js/viewers/bcf.js` = BCF aperto da solo + "Sovrapponi al modello"
  (modello aperto, IFC indicato nell'intestazione del BCF nella stessa cartella, o scelto). `ui/js/bcfreport.js` = report PDF
  (scrittore PDF minimo interno, Helvetica WinAnsi + istantanee JPEG) ed Excel (SheetJS). Stili in `ui/css/bcf.css`.
- In model3d.js solo aggiunte: `bcfHost`, pulsante, `api._bcf`, `setClip`/`clippedOut` (selezione che rispetta tutti i piani).
- Collaudo: file di prova ufficiali del repository github.com/buildingSMART/BCF-XML (rami release_2_1 e release_3_0, cartelle
  "Test Cases", con Architectural.ifc ed Estructura.ifc; NON copiati nel repo): 122 file letti, riscritti in 2.1 e 3.0 e
  validati con gli XSD ufficiali (1138 documenti, 0 errori); punti di vista confrontati con le istantanee originali (camera,
  sezione, facciata scomposta, muro nascosto); ciclo crea -> esporta -> reimporta senza perdite. Il riquadro del browser
  integrato, se nascosto, congela la pagina: per le prove si e' usato Edge senza finestra pilotato via DevTools Protocol.

## Visualizzatore GIS (22/10/2026) - FATTO
`ui/js/viewers/gis.js` (mappa OpenLayers 10.2.1 BSD-2 in EPSG:3857), `ui/js/gisio.js` (lettori/scrittori), `ui/js/giscrs.js`
(sistemi italiani: proj4 e WKT generati dagli stessi parametri), `ui/css/gis.css`, `mbvisual/gis.py` (API gis_tile).
Librerie in fetch_vendor.py: ol (BSD-2), proj4 2.12.1 (MIT), geotiff 2.1.3 (MIT); jszip gia' presente. Shapefile/DBF: codice proprio.
- Formati: .shp (con .dbf/.prj/.cpg accanto; senza .cpg: UTF-8 se valido, altrimenti Windows-1252), zip con shapefile,
  GeoJSON (anche membro "crs") / TopoJSON, KML/KMZ (stili e icone interne), GPX, GeoPackage (via api sqlite_query + hex(geom)),
  GeoTIFF (geotiff.js con richieste a intervalli; .tfw/.prj accanto). Categoria `gis` in formats.json: in app.js
  `resolveCategory` le da' la precedenza, mentre TIFF e ZIP vanno alla mappa solo se `gisViewer` trova chiavi GeoTIFF / shapefile.
- Sistemi senza .prj: ipotesi dall'estensione delle coordinate (WGS84, Gauss-Boaga Ovest/Est, UTM 32) segnata "ipotizzato".
  RDN2008: 7791-7795 = E-N, 6707-6709/6875/6876 = N-E (stessa definizione; nei .prj si scrive il codice E-N). I .prj scritti non
  hanno TOWGS84 (come GDAL: con TOWGS84 PROJ/QGIS non riconoscono il codice). Verifica con PROJ: UTM/RDN2008/ETRS89 identici;
  Monte Mario con i 7 parametri nazionali (in Sicilia/Sardegna PROJ usa parametri regionali: 5-7 m di differenza).
- Sfondo: OSM via proxy locale (User-Agent dell'app, cache %TEMP%\MBVisual\gis-tessere >= 7 giorni, solo tessere guardate,
  attribuzione sempre visibile), ortofoto Esri/MapTiler solo con chiave dell'utente, XYZ/WMS personalizzati, "Nessuno sfondo".
  Impostazioni in localStorage "mbv-gis-sfondo". NON incluse: ortofoto PCN (limiti d'uso), EOX Sentinel-2 (commerciale a pagamento).
  OpenLayers: zIndex negativo = livello non disegnato (lo sfondo sta a 0, i livelli da 1).
- Testi: chiavi v_gis.*, gisio.*, giscrs.*, srv_gis.*, fmt.gis.* in tutte e 5 le lingue (traduzioni unite con i18n_check --merge).
- Salva con nome: GeoJSON/KML/KMZ/GPX (WGS84), shapefile zip (sistema a scelta; un file per tipo di geometria), PNG/JPG/PDF vista.
- Campioni: `tests/samples/gis` da `tools/make_gis_samples.py` (Natural Earth pubblico dominio, Copernicus DEM GLO-90; fonti in FONTI.md;
  serve un venv a parte con pyproj e pyshp, NON nell'app). Prove dalla console: `MB.active.api._gis` (map, layers, sel, addPaths, saveVector).
- Prove nel riquadro browser: il cookie "mbv" e' per host e non per porta, quindi altre sessioni con un server di prova lo sovrascrivono
  (403 "non autorizzato"): usare http://localhost:PORTA/?t=... oppure aggiungere ?t= alle richieste.
## Nuvole di punti da rilievo (22/10/2026) - FATTO
LAS, LAZ, E57, PTS, PTX (Leica), XYZ e PLY a soli punti (categoria `pointcloud` in formats.json, visualizzatore model3d;
LAS resta anche tra i testi e PTX tra i RAW Pentax: decide `misc.sniff` dal contenuto, `LASF` / `ASTM-E57` / due interi in testa).
- Motore `mbvisual/pointcloud.py` (laspy BSD-2 + lazrs MIT, pye57 MIT con libE57Format BSL-1.0 e Xerces Apache-2.0, numpy):
  lettura a blocchi di 2 M punti (E57: pose delle scansioni, coordinate sferiche, punti non validi; PTX: matrice per scansione),
  poi ottree con livelli di dettaglio stile Potree (codici di Morton 21 bit/asse con tabella, un punto per cella di una griglia
  128^3 per nodo, nodi con <= 6000 punti presi interi) salvato in cache `%TEMP%\MBVisual\nuvole\<sha1 percorso|dimensione|data>`
  (pos.f32 relativi a `offset`, rgb.u8, int.u16 normalizzata su `i_range` a percentili, cls.u8, meta.json con i nodi; max 20 GB,
  si cancellano le meno recenti). API: `pc_open` (job), `pc_data?key&start&count` (binario di un nodo), `pc_export` (job, `clip` =
  piani [nx,ny,nz,d] in coordinate del file). Tempi su questo PC: LAZ 19,5 M punti ~50-60 s la prima volta, poi immediato.
- Interfaccia `ui/js/pointcloud.js` (classe Cloud): ogni fotogramma sceglie i nodi per priorita' (dimensione a schermo) entro il
  budget (Dettaglio 1-20 M, predefinito 3 M), carica 4 nodi alla volta, scarica i meno usati oltre 1,5x il budget; colori
  RGB/intensita'/quota (percentili del nodo radice)/classificazione ASPRS/unico con alfa = classi nascoste (alphaTest; righe per
  classe nell'albero); raycast solo sui nodi visibili. In model3d: misura con aggancio al punto vero (marcatore anche al passaggio
  del mouse) + in pianta e dislivello; clic = coordinate/attributi del punto; Salva con nome LAS/LAZ/E57/PLY/PTS/XYZ/TXT (tutti i
  punti o solo la parte visibile della sezione). Web app: LAS non compresso/XYZ/PTS/PLY letti nel browser (max 5 M punti).
- Testi tradotti: chiavi `pc.*` (interfaccia), `v_model3d.pc_*` / `v_model3d.distanza_*`, `srv_pointcloud.*` (motore), `fmt.pointcloud.*`.
- Federazione: coordinate del file (Z in alto) -> scena con `info.coordMatrix` (stessa matrice dei modelli IFC); se la nuvola e'
  il primo modello crea lei la traslazione comune. Verificato con un IFC di prova a coordinate UTM: angoli coincidenti nei due ordini.
- File di prova pubblici (non nel repo): USGS 3DEP LiDAR (pubblico dominio) `USGS_LPC_ARRA_CA_GOLDENGATE_2010_000982.laz`
  (9,4 M punti) e `USGS_LPC_NY_New_York_CMGP_SANDY_LiDAR_15_18TWL850045.laz` (19,5 M) da rockyweb.usgs.gov (ricerca con
  tnmaccess.nationalmap.gov); E57/PTS/PTX di esempio di libE57 (e57-3d-imgfmt.sourceforge.net/data.html: bunny, pump, Station018).
- Prove con il riquadro del browser nascosto: requestAnimationFrame e i timer sono fermi, quindi `MB.active.three`
  (renderer, camera, controls, info.clouds) + `cloud.update(...)` e `renderer.render` a mano; il cookie `mbv` e' comune a tutti i
  server locali (stesso host, porte diverse): con piu' sessioni aperte aggiungere `t=<token>` alle chiamate /api.


## Stampa professionale (22/10/2026) - FATTO (prova sul plotter vero: la fa l'utente)
File -> Stampa (Ctrl+P, anche il pulsante/Ctrl+P di pdf.js) e Stampa a lotti (Ctrl+Maiusc+P). Solo app per PC.
- `mbvisual/stampa.py` (API print_*): sorgente -> PDF di stampa (una pagina per foglio, gia' alla dimensione della carta,
  contenuto vettoriale con show_pdf_page) -> anteprima PNG con lo stesso stile -> stampante o PDF. Office/immagini/testo via
  convert.py (cache in TEMP/stampa/pdf), p7m via signed.open_signed. CAD: ezdxf disegna sul foglio (Settings.scale =
  mm per unita' x rapporto; estensioni/limiti/vista/finestra/layout, unita' da $INSUNITS, ColorPolicy per grigi/nero,
  tabelle .ctb di AutoCAD con RenderContext(ctb=...), spessori ABSOLUTE). Layout: foglio dal LAYOUT, 1:1.
- Stampanti: win32print.DeviceCapabilities (formati in decimi di mm, risoluzioni, copie, DC_MAXEXTENT = formati
  personalizzati/rotoli); stampa GDI via ctypes: DEVMODE da DocumentPropertiesW (formato, DMPAPER_USER per rotoli,
  orientamento, copie, colore), CreateDCW, ResetDCW tra pagine di formato diverso, bande rasterizzate con PyMuPDF alla
  risoluzione del dispositivo (max 600 dpi fino ad A2, 300 oltre, o quella scelta) e StretchDIBits. "Proprieta'..." apre
  la finestra del driver (DM_IN_PROMPT) e il DEVMODE scelto vale per quella stampa. "PDF vettoriale (MB Visual)" salva il
  PDF di stampa (grigi/nero dei documenti non CAD: pagine rasterizzate a 300 dpi; i CAD restano vettoriali).
- Formato automatico: stesso formato (tolleranza 1%), poi il piu' piccolo formato "da disegno" (ISO prima di ANSI/ARCH,
  mai buste/cartoline), poi personalizzato se il driver lo consente, altrimenti il piu' grande ridotto (avviso).
  Lotti: scala documenti "Dimensione reale" (A1 su A1), disegni "Automatica" (tavola 1:1 sul suo formato, disegno al
  vero adattato al formato scelto) o "In scala 1:N"; area "Layout o estensioni".
- `ui/js/print.js` + `ui/css/print.css`. Agganci: cad2d.js `printSource()` (modifiche + layer spenti -> cad_save in un
  DXF temporaneo, vista, limiti, toWorld per "Finestra" con due clic), pdf.js `printSource()` (annotazioni non salvate)
  e window.print dell'iframe; publisher con pubexport.exportPdfFile; model3d = immagine del canvas. DWG nei lotti: letti
  con libredwg nell'interfaccia e passati come DXF (con ODA File Converter installato li converte il motore, layout compresi).
- Collaudo su "Microsoft Print to PDF" (PDF misurati a 254 dpi): quadrato 100 mm -> 100,4 mm (contorno compreso),
  pianta 10 m a 1:100 -> 100,5 mm, a 1:50 -> 200,6 mm, fogli A1/A4/A3 misti nello stesso lavoro con le misure esatte.
  Prove dalla console: `document.querySelector(".pr-back").__pr` (S impostazioni, addList, comp).
- Nota prove nel browser: piu' sessioni con il server su 127.0.0.1 si sovrascrivono il cookie "mbv" (porte diverse,
  stesso host): nelle prove aggiungere `t=` alle richieste /api.
- ezdxf tronca il foglio ai punti interi (297 mm -> 841 pt) e scala il disegno su quel valore: in compose la pagina di
  ezdxf si posa con il fattore esatto (A0 a 1:10: 1000,003 mm invece di 999,4). Testi: chiavi `print.*` e `srv_stampa.*`.

## Ricerca nel progetto (22/10/2026) - FATTO
Pannello "Cerca nel progetto" (Ctrl+Maiusc+F o pulsante Cerca di Esplora; usa la cartella di Esplora) = `ui/js/search.js`
+ `ui/css/search.css`; motore `mbvisual/search.py` (API search/*), estrattori `mbvisual/search_extract.py`.
- Indice SQLite FTS5 per cartella in %LOCALAPPDATA%\MBVisual\indice\<sha1>.sqlite (unicode61 senza accenti, prefix=3);
  rowid dei blocchi = id file << 20 | n (cancellazione per intervallo). Se una cartella superiore ha gia' un indice si usa
  quello con filtro sottocartella. Aggiornamento in thread: scansione (stat), rilettura solo dei file cambiati
  (dimensione/data/VERSION), ricontrollo automatico ogni 120 s delle cartelle usate nell'ultima ora.
- File solo online di OneDrive (attributi RECALL/OFFLINE): MAI letti; stato "nuvola" = solo nome e proprieta',
  contenuto quando tornano locali. DWG: stato "dwg", testo letto nell'interfaccia (`ui/js/searchdwg.worker.js`, libredwg
  in un worker nuovo per ogni disegno) e inviato con search/dwg_put.
- Blocchi con posizione: loc {page|sheet|slide|line|attach|block} + pos {k: cell|handle|ifc, o: scostamenti, v: valori};
  `_precise` sceglie la voce con piu' parole trovate. Etichette e avvisi nell'indice = chiavi `search_extract.L(...)`
  (JSON ["srv_search.x", arg...]) tradotte alla ricerca da `search.tr_label`; i testi aggiunti al contenuto (Da:, Layer:...)
  sono nella lingua attiva al momento dell'indicizzazione. Testi del pannello: chiavi search.* (5 lingue). Apertura al punto: PDF (pagina + ricerca pdf.js), Monaco (riga),
  IFC (`selectExpressId` in model3d.js), DXF/DWG (zoom con `__cad` di cad2d); per ONLYOFFICE solo avviso con il punto.
- Estrattori: PDF (testo e OCR gia' presente, note, metadati; avvisa se scansione senza testo), docx/xlsx/pptx e
  OpenDocument via XML, doc/xls/ppt binari via olefile (testo approssimato), RTF, testo/codice/HTML, eml/msg/mbox con
  allegati (anche il loro contenuto), DXF (parser dei codici di gruppo), IFC (STEP: nomi, Pset/Qto, materiali, piano,
  classificazioni), STEP (PRODUCT), p7m (contenuto firmato), zip/7z (elenco), immagini (EXIF/XMP/PNG text).
- Collaudo: `python tests/make_search_samples.py <cartella> --copie 3000` poi `python tests/test_search.py <cartella> --nuovo`
  (47/47). NOTA: nel venv e' installato pymupdf_layout (con pymupdf4llm): `import pymupdf` carica modelli ONNX (11-18 s).

## SketchUp .skp senza SketchUp (22/10/2026) - FATTO
SDK ufficiale Trimble (SketchUp C API) NON usato: si ottiene solo su richiesta con account Trimble e accettazione dei
termini API (download dietro login), quindi non scaricabile/collaudabile qui. Al suo posto OpenSKP 1.3.0 (MIT, lettore
reverse-engineered, non affiliato a Trimble) + fflate (MIT), earcut (ISC), flatbuffers (Apache-2.0): `tools/fetch_vendor.py`
li mette in ui/vendor/{openskp,fflate,earcut,flatbuffers}, riscrive gli import in percorsi relativi (il Worker non vede
l'import map) e aggiunge due esportazioni (`_parseToRaw`, `_buildInstancedSceneFromParsed`: il file si legge una volta sola).
- `ui/js/skpworker.js` (Worker modulo): scena a istanze (geometria per definizione + matrici), spigoli visibili per
  definizione (non nascosti/morbidi/levigati), texture associate al materiale SketchUp, tag, scene. Coordinate: pollici
  Z-alto -> metri Y-alto = (x, z, -y) * 0.0254. Facce senza materiale: bianco SketchUp (OpenSKP userebbe il colore del tag).
- `ui/js/sketchup.js` (`loadSkp`, chiamato da model3d.js `loadAny`): gruppi/componenti come Group con userData (Tipo,
  Definizione, Tag, GUID, attributi dinamici e dizionari), mesh e spigoli con `pickParent` (il clic seleziona il gruppo;
  export3d.js fa un elemento per gruppo), voce "Tag" nell'albero, scene come viste nel menu "Vista..." (`loaded.views`).
  Insidie risolte: la texture glTF di OpenSKP e' moltiplicata per il colore medio (qui: bianco, o "colorizzata" ricalcolata),
  l'opacita' include l'alfa del colore (qui: transparency del materiale), fronte/retro diversi = due facce a lato singolo
  (rispettare `doubleSided`), UV con origine in basso (createImageBitmap flipY), depth buffer logaritmico = polygonOffset
  inutile (gli spigoli si avvicinano alla camera nello shader).
- Collaudo (campioni pubblici in %TEMP%\skp-campioni, confrontati con la miniatura salvata nel file): 22 file su 26 aperti,
  SketchUp 8, 14-18, 20-23, 25, 26. Non si aprono: alcuni file "legacy" 2013-2020 (errore del lettore, messaggio chiaro con
  consiglio di risalvare da SketchUp 2021+) e file molto grandi (67 MB SketchUp 2023: memoria esaurita). Scene implementate
  ma NON verificate (nessun campione ne aveva); testi, quote e linee di costruzione non disegnati; componenti "sempre rivolti
  alla camera" restano fermi. Web app: .skp non abilitato (WEB_EXTS/WEB_LIBS di build_web.py).
- Prove nel browser con altre sessioni attive: il cookie `mbv` e' per host (non per porta) e le altre app su 127.0.0.1 lo
  sovrascrivono -> usare http://localhost:<porta>/?t=<token> e rifare `fetch("/?t=" + token)` prima di aprire.
## Diagrammi di Visio (22/10/2026) - FATTO
Categoria `visio` in formats.json (vsdx, vsdm, vstx, vstm, vsd; tolti vsd/vsdx/vsdm da office-lo), voce "Diagramma" in Crea nuovo
(pacchetto vuoto generato da `vsdmodel.blankVsdx`, A4 in mm). Scritto da zero sulla specifica pubblica [MS-VSDX].
- `ui/js/vsdmodel.js` pacchetto (JSZip + DOM XML delle parti: si modificano i DOM e si riscrivono solo le parti cambiate, tutto
  il resto resta com'e' -> il file si riapre in Visio), ereditarieta' delle celle forma -> forma del master -> stili (LineStyle/
  FillStyle/TextStyle) -> tema, sezioni unite riga per riga (Del="1"), valutatore delle formule (ad albero: unita', MIN/MAX/IF...,
  Geometry1.X2, User.x, Controls.Row_1.Y, Sheet.N!Cella, ThePage!). Regola di scrittura: la formula di una cella cambiata resta
  solo se, rivalutata con i valori nuovi, da' lo stesso valore (F="Inh" se ereditata), altrimenti diventa costante.
  Colori "Themed": senza tema nel file = bianco/nero (come Visio); con tema = QuickStyle*Color (0-7 dk1/lt1/accent, 100 e
  200-206 = colori della variante VariationColorIndex della pagina). Forme con Del="1" (ID 4294967295) si ignorano.
- `ui/js/vsdrender.js` disegno unico (operazioni in punti, stesso formato del PDF delle pubblicazioni): geometrie (anche
  ArcTo con freccia positiva a destra della corda, EllipticalArcTo, NURBS, PolylineTo, Rel*), Rounding, frecce, retini/
  gradienti, ombre, testo con a capo/allineamenti/margini, immagini (EMF/WMF -> PNG con Pillow, API visio_metafile), livelli,
  pagine di sfondo, scala del disegno. `ui/js/vsdops.js` modifiche (sposta, ridimensiona con ricalcolo delle formule, ruota,
  capovolgi, connettori dinamici con Connect + _WALKGLUE/_XFTRIGGER e percorso ad angoli retti, gruppi, ordine, incolla con ID e
  Sheet.N! rinumerati, formato, dati forma, livelli, pagine). `ui/js/vsdedit.js` interfaccia in stile Visio (schede Home/Inserisci/
  Progettazione/Visualizza, pannello Forme con stencil di `vsdshapes.js` e "Forme del documento", linguette pagine, Dati forma,
  Dimensioni e posizione, Trova/Sostituisci, tasti di Visio in keymap). `ui/css/visio.css`, icone `vsdicons.js` (+ pubicons).
- Salva con nome: vsdx/vsdm/vstx/vstm (tipo del pacchetto cambiato su una copia; senza "m" si toglie il progetto VBA), PDF
  vettoriale (riusa `publisher.export_pdf`, API visio_pdf), SVG e PNG una per pagina.
- `.vsd` binari (`mbvisual/visio.py`, API visio_vsd): con Visio installato conversione COM in .vsdx (non provata: Visio non c'e'
  su questo PC); con LibreOffice pagine come immagini; altrimenti anteprima del file e testi delle pagine (flussi LZSS
  decompressi, blocchi 0x0E) per la versione 11+.
- Testi in 5 lingue: chiavi vsdedit.*, vsdshapes.*, vsdops.*, vsdmodel.*, v_visio.*, srv_visio.*, fmt.visio.* (plurali con tn).
- Prove: file pubblici in `tests/samples/visio` (fonti in FONTI.md), `tests/check_vsdx.py` controlla la struttura del file
  salvato. Confronto visivo utile: `docProps/thumbnail.emf` dentro ogni vsdx e' l'anteprima disegnata da Visio.
  Dalla console: `MB.tabs[i].api._vs` (doc, page, model, sel, run, exportPdf...). Se il server di prova risponde "non
  autorizzato", il cookie e' stato sovrascritto da un altro server su 127.0.0.1: aggiungere ?t=token alle richieste.

## Conversione a lotti (22/10/2026) - FATTO
File -> "Conversione a lotti..." e clic destro nel pannello Esplora (cartella o file). `mbvisual/batch.py` (API unica
`api/batch?op=scan|start|status|cancel|list|take|client`) + `ui/js/batch.js` (finestra, avanzamento, riquadro ridotto) +
`ui/css/batch.css`. Coda sequenziale nel motore (un lotto alla volta, gli altri aspettano), annullabile (FFmpeg fermato subito,
gli altri dopo il file in corso), rapporto CSV (riusciti / saltati / falliti con il motivo leggibile, `_reason`), uscita accanto
agli originali o in una cartella con la struttura replicata; mai sopra l'originale; esistente = numero / sostituisci / salta.
- Operazioni: PDF, altro formato (convert.py), immagini (ridimensiona/converti/comprimi con Pillow), unisci in un PDF
  (segnalibri per file, gli altri documenti convertiti prima), comprimi PDF, OCR, video MP4 (H.264 CRF + altezza max).
- Office: un'istanza di Word/Excel/PowerPoint per tutto il lotto (`_office_convert`; avviarli a ogni file costava 30-100 s e un
  riavvio a ridosso del precedente faceva fallire il file successivo); password finta per non bloccare la coda sui file protetti.
- DWG/DXF -> PDF/SVG/PNG con ezdxf (`cad_render`): modello e/o fogli (pagina per foglio, segnalibri), formato carta, scala 1:N
  esatta (Settings.scale = mm per unita' / N), colori/b-n. DXF letti da ezdxf; DWG: con ODA File Converter -> DXF, senza ODA la
  PAGINA decodifica il DWG con libredwg (`decodeDwg` esportata da cad2d.js) e manda il database: `doc_from_db` ricostruisce
  modello (cadedit._from_db/_create) e fogli con le finestre (la prima VIEWPORT di ogni foglio e' il foglio stesso: saltata).
- 3D/BIM -> GLB/STEP/IFC/STL/OBJ...: la pagina monta `viewers/model3d.js` in un contenitore fuori schermo (.bt-hidden) e usa il
  suo save(). Compiti della pagina: il motore li pubblica in `status.task`, la pagina fa `take` e risponde con `client`; se la
  pagina non interroga per 45 s (o 30 min dopo aver preso il compito) il file fallisce con un motivo chiaro.
- Prove: cartella mista in scratchpad (Office, email .msg/.eml, PDF reali, PDF rotto, immagini, video, DWG reali, IFC, STEP, STL).
  libredwg-web NON legge i DXF: i fogli DWG si provano con un database sintetico (struttura di libredwg) -> doc_from_db.
- Prove nel browser con piu' sessioni: il cookie `mbv` e' per host (non per porta), le app di prova delle altre sessioni lo
  sovrascrivono -> aprire l'app con un nome unico, es. http://mbvlotti.localhost:PORTA/?t=TOKEN.

## Integrazione con Esplora risorse (22/10/2026)
Miniature, riquadro di anteprima, "Apri con", icone dei tipi e "Apri con MB Visual" nel tasto destro, SOLO per l'utente (HKCU).
- `tools/mbvshell/` DLL COM in C++ (MSVC, `build.cmd` -> `bin/shell/mbvshell-arm64.dll` e `-x64.dll`, si caricano quella
  dell'architettura del PC: Esplora su ARM64 vuole ARM64). IThumbnailProvider (IInitializeWithStream, processo isolato) e
  IPreviewHandler (prevhost, DisableLowILProcessIsolation=1, pulsante "Apri in MB Visual"). Prima le immagini incorporate
  (anteprima DWG all'offset 0x0D, proprieta' Thumbnail e flussi "Preview" dei file OLE, PNG degli SketchUp), poi
  `MBVisual.exe --miniatura <file> <png> <lato>` con cache in %LOCALAPPDATA%\MBVisual\miniature\cache (le miniature
  ricevono un flusso: la DLL ne fa una copia in miniature\sorgenti). Prova senza registro: `obj-arm64\prova.exe <dll> <file>
  <png>` con MBVSHELL_Comando nell'ambiente (ogni valore di HKCU\Software\MB Visual\Integrazione si puo' dare cosi').
- `mbvisual/miniature.py`: il primo processo diventa "servizio" (finestra WebView2 fuori schermo, porta/token in
  miniature\servizio.json, si chiude dopo 90 s senza richieste), gli altri gli passano le richieste. `ui/js/thumbmode.js`
  apre il file col visualizzatore normale: 3D = disegno dedicato su sfondo trasparente (tab.three), 2D = canvas ritagliato
  sul contenuto. NON avviare la finestra con SW_HIDE (WebView2 nascosto carica in 75 s invece di 3) e non toccare
  window.native da altri thread (blocca tutto): la finestra si toglie dalla barra con Win32 (WS_EX_TOOLWINDOW).
  Tempi su questo PC: avvio a freddo ~3-8 s, poi DXF/DWG/STEP/IFC 2-15 s; DWG con anteprima incorporata 0,1-1 s.
- `mbvisual/shellint.py`: ProgID MBVisual.<ext> per tutte le estensioni di formats.json (tranne programmi/collegamenti),
  icone generate con Pillow in %LOCALAPPDATA%\MBVisual\icone, OpenWithProgids, Capabilities + RegisteredApplications,
  gestori sotto SystemFileAssociations (se AutoCAD & co. hanno un gestore loro, resta il loro: elencati in AltriGestori),
  predefinito solo per le estensioni SENZA programma (opzione "libere"). DLL copiata in %LOCALAPPDATA%\MBVisual\shell con
  nome per versione (Esplora la tiene aperta). `--integrazione attiva|rimuovi|stato`; all'avvio dell'app
  `refresh_if_needed` riscrive se cambiano exe o versione. Interfaccia: File > Integrazione con Windows (`ui/js/shellint.js`),
  casella in "Installa su questo PC" (update.install integrazione=True), attivita' "integrazione" dell'installer Inno Setup
  (disinstallazione = rimuovi).
- DA PROVARE con l'utente: registrazione reale su questo PC (la scrittura nel registro era bloccata dai permessi della sessione),
  miniature in Esplora, riquadro di anteprima, PC x64. Windows 11: la voce del tasto destro sta in "Mostra altre opzioni"
  (il menu nuovo richiede un pacchetto MSIX firmato).

## JT, U3D e modelli 3D dei PDF (22/10/2026) - FATTO (PRC no)
Categoria `vis3d` in formats.json (jt, u3d) -> visualizzatore 3D. Lettori propri in JS, eseguiti in un Web Worker
(`ui/js/neutral3dworker.js`); `ui/js/neutral3d.js` costruisce la scena (albero, colori per mesh `mc`, matrici, proprieta' in
userData) e salva la conversione in cache nel motore (`mbvisual/model3dcache.py`, API `model_cache`, %TEMP%\MBVisual\modelli3d,
chiave = percorso+dimensione+data+`CACHE_VER`: alzare CACHE_VER quando cambia l'uscita di un lettore). model3d.js: `NEUTRAL`.
- JT (`ui/js/jt.js` + `ui/js/jtcodec.js`), scritto sulla specifica pubblica JT File Format Reference v8.1/v9.5/v10.5 (PDF in
  github.com/Arsanias/Delphi-JT-Loader/docs). LSG (partizioni anche in file esterni, istanze, parti, LOD = primo figlio,
  switch), materiali, trasformazioni (F32 o F64: si capisce dalla lunghezza dell'elemento), Property Table + metadati
  (Property Proxy). Mesh: JT 8 strisce (Int32CDP: bitlength, Huffman con heap come l'implementazione di riferimento -
  i pareggi decidono l'albero -, aritmetico; vertici con/senza perdita), JT 9/10 compressione topologica (Appendice E,
  `decodeDualMesh`). JT 10: segmenti XZ/LZMA2 (decodificatore proprio), versioni U8, Bitlength con "nibble" da 4 bit,
  coordinate senza perdita = bit IEEE con Lag1, intestazione di elemento incorporata prima dei dati topologici.
  Non letti (avviso): B-rep XT/JT, PMI, ULP/LWPA, Polyline/Point/Primitive set, texture.
- U3D (`ui/js/u3d.js`): ECMA-363 4a ed. (lettore di bit dall'implementazione informativa dell'Annex A), catene, nodi
  gruppo/modello, shading -> lit texture shader -> materiale, mesh CLOD di BASE. Mancano: aggiornamenti progressivi
  (blocchi 0xFFFFFF3C: avviso "risoluzione di base"; i file con risoluzione minima 0 restano vuoti), linee, punti, texture.
- PDF 3D: `mbvisual/pdf3d.py` (API `pdf3d`) estrae i flussi U3D/PRC (annotazioni /3D, 3DRef, RichMedia, allegati) in
  %TEMP%\MBVisual\pdf3d; `ui/js/pdf3d.js` aggiunge "Modello 3D" nel visualizzatore PDF (solo app per PC).
  PRC: elencati ma NON letti (nessuna specifica gratuita; ISO 14739 a pagamento). Strada possibile: interprete dello
  schema MIT `prc.json` di github.com/ralovich/prc-rs (+ riferimento MIT CalyPdf/Caly.Rendering.Scene3D); NON usare nanoPRC (AGPL).
- `.prc` resta anche "codice" (procedure PL/SQL). Riconoscimento dal contenuto in misc.sniff: "U3D\0", "Version N.N JT".
- Collaudo (file pubblici NON nel repo): JT da github.com/Arsanias/Delphi-JT-Loader/Examples (MIT) e bitbybit3d/dxjt_toolkit
  /samples: 15 file 8.0-10.3 tutti aperti, stesso modello in 8/9.5/10 = stesso ingombro; U3D da github.com/ralovich/u3d-db
  (21 file); PDF: media9.pdf da CTAN (2 U3D + 1 PRC). Visto nell'app: motore radiale, CoffeeMaker, dado di media9.

## SolidWorks, Solid Edge e Parasolid senza i programmi originali (22/10/2026) - FATTO
Categoria `solidcad` in formats.json (sldprt/sldasm/slddrw/prtdot/asmdot/drwdot, par/psm/asm/dft/pwd, x_t/x_b/xmt_*/p_t/p_b);
`.asm`/`.psm` condivise con testo/audio: vince solidcad se il contenuto e' OLE (SNIFF_FAMILY.ole in app.js).
Visualizzatore `ui/js/viewers/solidcad.js` (pannello anteprima/proprieta'/configurazioni/componenti + resoconto; il 3D e'
`model3d.js` montato su uno STEP convertito; Salva con nome STEP = copia dello STEP esatto). API `solid_info`, `solid_step` (job).
Tutto scritto da zero, niente codice di terzi:
- `mbvisual/parasolid.py`: lettore XT testo e binario neutro dalla specifica pubblica "Parasolid XT Format Reference" (2006).
  Schema di base SCH_13006 scritto a mano dalla specifica; gli schemi incorporati (V14+) si applicano come modifiche (C/D/I/A/Z).
  Campi utente dopo OGNI nodo. Vecchi (verificati): fino alla V11 fin senza attributi e ATTRIB_DEF senza field_names con
  13 proprietari; V9 anche corpo senza nom_geom_state. Limite: x_t salvati "per una versione precedente" SENZA schema
  incorporato (es. SCH_2400000_20000) non si leggono (servirebbe il file di schema di Parasolid).
- `mbvisual/xt2step.py`: B-rep -> STEP AP214 in mm. Esatti: piano, cilindro, cono (asse STEP opposto: verso u invertito ->
  flip), sfera, toro (DEGENERATE_TOROIDAL se R<=r), B-spline/NURBS (poli: v piu' veloce, verificato), offset, estrusa,
  rivoluzione, rette/cerchi/ellissi. Approssimati: intersezioni (polilinea dalla chart), SP-curve e spigoli tolleranti
  (campionati), raccordi a palla 'R' ed 'E' (NURBS dai punti di contatto, parametrizzati come Parasolid cosi' SP-curve e
  proiezioni sui raccordi funzionano). same_sense = senso faccia == senso superficie (xor flip). Assiemi XT annidati
  con NAUO + ITEM_DEFINED_TRANSFORMATION. Resoconto con codici (faces, faces_ok, skip:<codice>...) tradotti nell'interfaccia.
- `mbvisual/solidcad.py`: contenitori. SW <=2014 e Solid Edge = OLE (olefile); SW 2015+ = sezioni `14 00 06 00 08 00`,
  nome a semibyte scambiati, deflate grezzo (si tiene l'ultima copia valida). Flussi SW compressi a pezzi:
  [GUID 231dd571...][u32 esteso][u32 compresso][zlib]... (`sw_records`, `_unzlb`). Geometria SW: Contents/Config-N-Partition
  (partizione neutra binaria); se e' vuota i corpi stanno in Config-N-FeatureBodies/LocalBodies. Solid Edge:
  PARASOLID/STREAM0.X_B (o .P_B; SKETCH.P_B = schizzi, ignorato). Assiemi SW: swXmlContents/COMPINSTANCETREE (file, modelli,
  riferimenti con swTransform: 16 numeri a vettore riga, metri) + file delle parti cercati in cartella/sottocartelle/percorso
  salvato. Proprieta' OLE con `mbvisual/olepropset.py` (anche sezione personalizzata e set Solid Edge), SW 2015+ da docProps/*.xml;
  anteprima PreviewPNG / Preview (DIB) / "Large DIB" di Solid Edge. Cache in TEMP_DIR/solidcad (VERSION nel modulo).
- Collaudo: `python tools/fetch_solidcad_samples.py` (file pubblici GitHub, fonti nel file) poi `python tests/test_solidcad.py --occt`.
  Risultato 22/10/2026: 171 file, 145 con geometria, 143 convertiti (2 x_t senza schema incorporato), 14.027/14.027 facce;
  OpenCascade legge 143/143 STEP, 139 facce su 15.532 (0,9%) restano senza triangoli. Estrusioni con sezione B-spline
  scritte come B-spline limitate: la SURFACE_OF_LINEAR_EXTRUSION infinita bloccava la triangolazione dell'intero solido;
  assieme SW 1690-20-8300 composto dalle matrici: 40/40 componenti coincidono entro 0,5 mm con l'x_t ufficiale.
- DA FARE: assiemi Solid Edge (ora solo elenco componenti; posizioni non decodificate: Attachments / Preview/Structure/IOT;
  mesh di visualizzazione in Preview/Display/Scene0/Geometries), mesh di visualizzazione SW (DisplayLists) come ripiego,
  sotto-assiemi SW non descritti nell'albero del padre, x_t senza schema incorporato, parti SE vecchie con solo schizzi.

## Autodesk Inventor senza Inventor (22/10/2026) - FATTO
Lettore scritto da zero (nessun codice GPL: InventorLoader NON usato; librerie: olefile BSD, OpenCascade/occt-import-js LGPL
gia' presente). Categorie `inventor` (ipt, iam -> model3d) e `inventor-doc` (idw, ipn -> `ui/js/viewers/inventor.js`). Solo app per PC.
- `mbvisual/inventor.py`: file OLE. iProperties dagli insiemi MS-OLEPS (parser proprio: olefile legge male le stringhe
  UTF-16; nomi italiani in `NOMI`, 58/59/60/61 = massa g / area cm2 / volume cm3 / densita'), anteprima = proprieta' 17 di
  "Inventor Summary Information" (PNG, o DIB). RSeStorage: flusso M<x> = meta col nome del tipo di segmento (UTF-16 con
  lunghezza), B<x> = dati zlib dopo 18 byte. Il solido sta nel segmento `PmBRepSegment` come "ASM BinaryFile4" non compresso.
  Colore: nome dell'aspetto da `_Private Model Information` prop 16 (StyleName), definizione nel segmento PmApp/AmApp
  (nome, descrizione, "1:nome", id libreria, GUID testuale, poi RGBA float ambiente/diffuso...).
- Assiemi: `UFRxDoc` = elenco file (percorso UTF-16 con lunghezza, poi GUID documento) + blocchi per occorrenza
  (`01 03 01 00 00 00 03` + GUID del documento, `01 05 ... 05` + nome). Con piu' stati del modello l'elenco e' ripetuto per
  intero: si tiene il primo periodo. Posizioni: segmento `AmRx*`, una matrice 4x4 per occorrenza nello STESSO ordine,
  compatta: uint32 di indicatori (bit k = elemento k vale 1, con bit k+16 = -1; solo bit k+16 = 0), poi i double rimanenti
  (righe, cm). Si riconoscono dall'ultima riga 0 0 0 1 (indicatori & 0x70008000) + rotazione ortonormale (`find_transforms`).
  File copiati con "Salva con nome" hanno lo STESSO GUID: abbinamento GUID unico -> GUID+nome file -> nome visualizzato
  (scritto in UFRxDoc tra percorso e GUID) -> nome. Ricerca dei file: percorso originale, stessa struttura relativa,
  cartella e sottocartelle, 3 livelli sopra (`_Finder`).
- `mbvisual/acis.py`: lettore SAB (valori con byte di tipo; record chiusi da 0x11; i sottotipi `{ }` sono numerati in
  ordine di scrittura, i `{ ref n }` NON contano). Punti di controllo delle B-spline: u varia piu' in fretta.
  Estremi dei nodi ACIS con molteplicita' = grado (STEP = grado+1, `_bspline_knots`).
- `mbvisual/acis_step.py`: STEP AP214 (mm; unita' ACIS dall'intestazione, Inventor = cm). Piani, coni/cilindri (normale
  verso l'esterno se cos>0; coni ellittici come cono circolare), sfere/tori (raggio negativo = normale invertita),
  B-spline esatte o approssimazioni delle procedurali (prima B-spline al livello del blocco), estrusioni/rivoluzioni
  ricostruite, eliche: `helix_int_cur`, `helix_spl_line` (segmento L = componenti su raggio, raggio ruotato, asse),
  `helix_spl_circ` (tubo di raccordo; verso invertito se il valore dopo gli intervalli e' pi) come B-spline di Hermite;
  formula elica C + (1+k t/2pi)(M cos t + N sin t) + P t/2pi (k = conicita' dei filetti NPT) verificata sui vertici.
  Elemento non convertibile: la faccia si salta e finisce nel rapporto (mostrato nell'app).
- Cache: `api/inventor` (lavoro in background) -> TEMP_DIR/inventor/<hash percorso+data+lettore>/ (modello.stp, info.json,
  anteprima.png). Interfaccia `ui/js/inventor3d.js`: worker OpenCascade persistente (`ui/js/occtworker.js`, il motore si
  carica una volta), ogni parte tassellata una volta e ripetuta nelle occorrenze; proprieta' nella scheda (formato navisProps).
- Collaudo (file pubblici, fuori dal repo in %USERPROFILE%\.mbvisual\ipt-campioni): github.com/gdh-uniandes/gpr20_vna_holder e
  gpr20_cartesian_arm (32 parti + STL di confronto: dimensioni/area/volume identici; 3 assiemi = anteprime di Inventor) e
  github.com/RespiraWorks/Ventilator (Apache-2.0, Inventor 2019-2023: 134/134 parti, tutte le facce dopo le eliche;
  39/39 assiemi senza componenti mancanti; ventilator.iam = 380 componenti, 87 parti, ~3,5 min la prima volta per la
  scheda da 98 MB; tavole .idw ok). Script di prova nella cartella scratchpad della sessione (non nel repo).
- Da provare con file dell'utente: nessun file Inventor sul PC. Mai visti: file pre-2010 ("ACIS BinaryFile" vecchio), .ipn,
  saldature (geometria nell'assieme), pattern di componenti, componenti soppressi, sostituzioni di colore nell'assieme.
