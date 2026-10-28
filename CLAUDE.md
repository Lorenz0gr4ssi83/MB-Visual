# MB Desk (prima MB Visual) - note per riprendere il lavoro

## NOME DELL'APP: MB Desk (dal 25/10/2026) - REGOLA PER TUTTE LE SESSIONI
SOCIETA' (decisione dell'utente, 25/10/2026): dove serve la ragione sociale (editore dell'installabile, copyright, titolare dei dati
nell'informativa e nelle statistiche, richieste privacy) = "MB Workshop Srl"; dove non serve = "MB Group". MAI "MB Engineering".
Timbri, cartigli, modelli vuoti e metadati dei file creati dall'utente: NESSUN nome di ditta (ognuno mette il suo; il timbro PDF e'
testo libero e l'app ricorda l'ultimo usato in localStorage mbv-timbro).
INSTALLABILE (25/10/2026): 7 applicazioni (documenti, pdf, disegni, modelli, grafica, video, posta) + sempre inclusi; niente profili.
ui/components.json `aliases` = id interni (office, cad, bim...) usati nel codice: isOn/needComp/data-comp li traducono; le scelte salvate
con gli id vecchi si convertono (components.py, AppInList in mbvisual.iss).
L'utente ha rinominato l'app: OGNI cosa visibile dice "MB Desk" (logo con DESK al posto di GROUP da tools/make_logo.py, finestre,
installabile, collegamenti "MB Desk.lnk", eseguibile "MB Desk.exe", setup MBDesk-Setup-<ver>.exe, MBDesk-<ver>-mac.dmg, "MB Desk.app",
"MB Desk Admin", app per telefono, pagine web, testi in 5 lingue). La parola "Visual" non deve comparire da nessuna parte visibile.
Restano col nome storico SOLO cose tecniche invisibili, per non perdere dati e licenze: cartelle dati %LOCALAPPDATA%\MBVisual e
%TEMP%\MBVisual, chiavi HKCU\Software\MB Visual\*, ProgID MBVisual.<ext>, pacchetto Python mbvisual/, cartella del progetto e
"App per PC", installazioni gia' esistenti in %LOCALAPPDATA%\Programs\MB Visual (le nuove vanno in ...\Programs\MB Desk).
MAI rinominare costanti di cifratura: entropia DPAPI `_ENTROPY` di cloud.py ("MB Visual - archivi cloud", usata anche dalla
posta) e voce del Portachiavi `_SERVICE` di secret.py ("MB Visual"). Nella 1.6.6-1.6.7 il cambio di nome le aveva toccate:
posta e cloud davano "DPAPI non riuscita (13)". Dalla 1.6.8 si leggono sia i dati storici sia quelli scritti da quelle versioni.
Ponte per gli aggiornamenti delle copie precedenti (finche' ce ne sono in giro, almeno qualche versione):
- release GitHub: oltre a MBDesk-Setup-<ver>.exe caricare la STESSA copia anche come MBVisual-Setup-<ver>.exe (le copie vecchie cercano
  quel nome); su Drive e in Desktop\MB Desk SOLO i nomi nuovi. "App per PC" contiene anche MBVisual.exe (lo mette build_portable).
- l'installabile lascia MBVisual.exe accanto a "MB Desk.exe" solo se c'era prima (OldExeExists): la copia vecchia riavvia quello;
  update.migrate_exe_name (app.py) rifa' i collegamenti e lo toglie quando l'app gira come "MB Desk.exe".
- Mac: l'aggiornamento rinomina "MB Visual.app" in "MB Desk.app" (MAC_OLD_INSTALL).
- Server: Worker principale "mbdesk" (https://mbdesk.mb-group.workers.dev, LICENSE_URL); il Worker "mbvisual" resta acceso con lo
  stesso codice e lo stesso database ma senza cron, per i telefoni installati sul vecchio indirizzo (tools/publish_web.py li pubblica
  entrambi). Un Worker nuovo vuole i segreti: python tools/license_setup.py segreti.


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
  Interfaccia: rifatta il 22/10/2026, vedi sezione "Editor PDF in stile Acrobat Pro". Ogni modifica scrive un file NUOVO
  (mai sostituire quello aperto da pdf.js). apply_ops lavora in `_apply_ops` + gc + nuovi tentativi: i campi di PyMuPDF
  tengono aperto il file. `_page_draws` esclude dai disegni l'aspetto di campi e annotazioni (get_drawings li riporta).
- Inventor: vedi sezione "Autodesk Inventor senza Inventor" (22/10/2026). Creo: nessun lettore realistico.
- Migliorie rimandate dall'utente (21/10/2026): pulsanti "Modifica in AutoCAD/BricsCAD/Inventor"; motore ODA (a pagamento).
  Funzioni Navisworks Manage: FATTE il 22/10/2026 (sezione "Funzioni di Navisworks Manage nel 3D").
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

## Componenti scelti all'installazione (23/10/2026) - FATTO
Scopo commerciale: chi installa vede tutto cio' che l'app sa fare e sceglie cosa gli serve. I file restano TUTTI installati: i
componenti accendono e spengono le funzioni. Registro unico `ui/components.json` (id, icona SVG, categorie/estensioni di
formats.json legate al componente, `invite: "usa"` = invito "per usare tutte le funzioni" invece di "per modificarlo", profili).
Sempre inclusi: base, shell (Integrazione con Windows). Facoltativi: office, cad, bim, mech (anche Revit), survey, gis, measure,
graphics (Photoshop/Publisher/Visio: anche le immagini), video, sign, mail, tools (lotti, ricerca, cloud), special
(DICOM, HDF5/NetCDF, iWork). Profili: completo (predefinito), studio, impresa, ufficio, personalizzato.
- Scelta salvata in `%LOCALAPPDATA%\MBVisual\componenti.json` ({profilo, attivi, noti}: un componente nuovo, assente da "noti",
  nasce acceso) e su Windows anche in HKCU\Software\MB Visual\Componenti (Attivi, Profilo). Motore `mbvisual/components.py`
  (API `components`, GET/POST, permessa anche senza licenza); `MBV_COMPONENTI=<file>` = file di prova (non tocca registro e scelta vera).
- Interfaccia `ui/js/components.js` + `ui/css/components.css`: `isOn(id)`, `compFor(cat, ext)`, `needComp(id)` (finestra "Attiva"),
  `showComponents()` = File > Componenti... (vetrina con profili e interruttori, la stessa dell'installabile). Elementi legati a un
  componente: attributo `data-comp="<id>"` (o `button(..., { comp })` di core.js), nascosti da un foglio di stile generato.
  File di un componente spento: si apre col suo visualizzatore + invito discreto nella barra (`lockIfNeeded` in app.js), Salva
  propone di attivarlo; attivato, le schede si riaprono da sole (se non modificate). Office spento = niente ONLYOFFICE (editor leggeri),
  CAD spento = cad2d senza editor. Nella web app tutto acceso. Mac: il .dmg non ha pagine, la scelta si fa al primo avvio
  (`needsFirstRun`: Mac e nessun componenti.json).
- "Seleziona tutto" sia nell'installabile (casella sotto l'elenco, SyncSelAll in mbvisual.iss) sia in File > Componenti (25/10/2026).
- Installabile: `installer/mbvisual.iss` (WizardStyle modern dark, it + en scelti dalla lingua di Windows, pagina componenti con
  tendina dei profili, elenco a sinistra e scheda con icona/nome/descrizione a destra). `tools/make_setup_art.py <cartella>` genera
  da components.json e da it/en.json: componenti.iss ([Types], [Components], [CustomMessages]), icone BMP 48/96 e immagini col logo;
  lo chiama `tools/build_setup.py` (`--out <cartella>` per le prove senza sovrascrivere il setup da pubblicare). Il setup scrive
  componenti.json e il registro a fine installazione; aggiornando (anche /VERYSILENT di update.py) riprende la scelta dal registro.

## Collegamento PC <-> telefono in tempo reale (24/10/2026) - FATTO (prova su telefoni veri: la fa l'utente)
Abbinamento con un QR mostrato dal PC (pulsante "Telefono" nella barra laterale, `ui/js/link/linkpc.js`) e letto dall'app del
telefono (Home -> "Collega al PC", lettore QR interno con jsQR, `ui/js/link/linkphone.js`). Il QR e' l'indirizzo dell'app per telefono
con `#mbvlink=<stanza>.<chiave>.<nome PC>` (il frammento non arriva al server; se lo apre la fotocamera del sistema l'app lo legge).
- Server `server/src/link.js`: Durable Object `LinkRoom` (SQLite, piano gratuito, WebSocket in ibernazione, binding LINK + migrazione v1
  in wrangler.toml) = stanza "<licenza>/<stanza>" che INOLTRA soltanto; `POST /v1/link/ticket` (attivazione del PC nel corpo o cookie
  del telefono -> ticket Ed25519 di 5 min con `x:"link"`, che non vale come attivazione) e `GET /v1/link/ws?room&tk`. Solo dispositivi
  della stessa licenza; stesso dispositivo ricollegato = la vecchia connessione si chiude (4000). Presenza: JSON dal server.
- `ui/js/link/linkcore.js` (comune): AES-GCM con chiave di 32 byte che sta solo nel QR (il server non legge nulla), saluto cifrato
  per riconoscere i dispositivi con la chiave giusta, file a pezzi da 256 KB con avanzamento, richieste con risposta, riconnessione.
- Funzioni: file dal telefono (scansioni, foto, biglietti = .vcf + rubrica della Posta del PC) salvati in `Documenti\MB Visual\Dal
  telefono` (cartella a scelta) e aperti; "Invia al telefono" (menu File e pannello) e "File del PC" dal telefono (SOLO schede aperte,
  recenti e condivisi) = DOCUMENTI CONDIVISI: salvataggio sul telefono -> originale del PC (se intanto e' cambiato o e' aperto con
  modifiche: copia "nome (dal telefono data).ext" accanto), salvataggio sul PC -> versione nuova al telefono (controllo ogni 3 s);
  appunti nei due versi (anche automatici dal PC; `mbvisual/link.py` con pywin32/pbcopy); telecomando (`ui/js/link/remote.js`: gesti =
  eventi puntatore/rotella sul canvas piu' grande della scheda, PDF via PDFViewerApplication, anteprima JPEG dello schermo).
- PC: `mbvisual/link.py` (API `api/link?op=load|save|ticket|put|conflict|clip_get|clip_set`), abbinamento e impostazioni cifrati
  (DPAPI) in DATA_DIR/collegamento.bin (`MBV_COLLEGAMENTO` = file di prova). Telefono: abbinamenti in localStorage "mbv-link";
  webapi.js `writeOut` chiama `MBLinkSaved` (documento del PC: la versione va al PC invece del foglio Condividi/Scarica).
- Testi `link.*`, `srv_link.*` (5 lingue). Collaudo: `node server/test/link.mjs` (28 prove: ticket, controlli, stanza, cifratura, file,
  richieste) e prova completa PC+telefono con `node server/test/linkserve.mjs 8799` (Worker + WebSocket minimo in Node) piu' due Edge
  senza finestra (27 prove: abbinamento, file nei due versi, documento condiviso con conflitto, appunti, file del PC, telecomando).
  Online provato: ticket e WebSocket verso la stanza vera. Limiti: niente funziona con l'app chiusa; il server inoltra (nessun
  passaggio diretto fra i dispositivi); il telecomando non fa misure ne' selezioni.

## App Android MB Desk (25/10/2026) - FATTA, da provare su telefoni veri
`android-app/` = Capacitor 7.6.9 (MIT), pacchetto `it.mbgroup.app` (scelto dall'utente, NON cambiarlo mai: gli aggiornamenti
dipendono da lui). La pagina e' l'app per telefono del server (`capacitor.config.json` server.url = https://mbdesk.mb-group.workers.dev),
quindi si aggiorna con il server come la web app; l'APK si rifa' solo se cambia il guscio. Play Store: piu' avanti (decisione
dell'utente), in forma privata (test chiuso) con account Organizzazione MB Group (D-U-N-S) per non mostrare il nome dell'utente.
- Nativo: `MainActivity.java` (App Link /l/<link> -> WebView sul link: l'app si attiva da sola; file -> plugin) e
  `MbDeskPlugin.java` (file di "Apri con"/"Condividi" copiati in cache/ricevuti e letti a pezzi con readChunk; evento "file"
  conservato finche' la pagina ascolta; `insertContact` = schermata "Nuovo contatto" di Android gia' compilata). Manifest: VIEW su
  content/file con */*, SEND/SEND_MULTIPLE, App Link autoVerify su mbdesk.mb-group.workers.dev/l/, CAMERA.
- Web: webapi.js (window.Capacitor.Plugins.MbDesk -> register + MB.openPaths), bcard.js (NATIVE -> insertContact).
  Pagina del QR (LINK_PAGE): dentro l'app = standalone; su Android con ANDROID_APK="1" (wrangler.toml) propone prima l'app
  (/scarica-android = ultimo .apk della release, intent:// per aprirla sul link), "versione nel browser" come alternativa.
  `/.well-known/assetlinks.json` con ANDROID_CERT_SHA256 (impronta pubblica del certificato).
- Firma: `%USERPROFILE%\.mbvisual\licenzendroid-firma.p12` + android-firma.json (password, alias mbdesk, sha256) -> secret
  MBD_KEYSTORE_B64 / MBD_KEYSTORE_PASSWORD. SENZA quella chiave gli aggiornamenti non si installano sopra: l'utente ne fa una copia.
- Build: workflow `build-android.yml` (a mano, ubuntu, JDK 21) -> artefatto MBDesk-android con MBDesk-<ver>.apk e .aab
  (versionCode = A*10000+B*100+C della VERSION di app.py). Icone/avvio: `python tools/make_android_icons.py`.
- Distribuzione: .apk nella release GitHub (serve a /scarica-android), cartella Drive e Desktop\MB Desk.
- Attivazione (25/10/2026, richiesta dell'utente "deve partire e basta"): la pagina del QR nel browser registra un'impronta
  (/v1/mlink/offer: sha256 di IP + modello, versione di Android, schermo, fuso; link allungato a 30 min); l'app aperta dalla
  schermata Home senza attivazione chiama /v1/mlink/resume e si attiva da sola se c'e' UN solo link candidato (colonne
  offer_fp/offered, migrazione 006). Altrimenti la pagina di attivazione dell'app mostra "Inquadra il QR del PC" (fotocamera,
  BarcodeDetector o /vendor/jsqr pubblico) e "Ho una chiave". `native: true` nel claim: la WebView dell'app non e' un browser sbagliato.
- Icone (Android e MB Desk Admin per telefono): grigio della piastrella a tutto campo (#8A8C89) con il marchio al centro, MAI
  fondo scuro attorno (Android lo mostrava come bordi neri). MB Desk Admin = logo con la scritta ADMIN (make_logo.py ->
  admin/logo-admin-512.png e admin/admin.ico), niente chiave.

## Interfaccia per telefono in stile app (23/10/2026) - FATTO (prova su telefoni veri: la fa l'utente)
Sui telefoni (lato corto sotto i 600 px, nella web app o con il dito come puntatore; decisione in uno script di `ui/index.html`
prima del primo disegno, che aggiunge `html.phone` e carica `css/phone.css`) la cornice del PC sparisce e c'e' un guscio da
app mobile: `ui/js/phone.js` (caricato da app.js solo in quel caso) + `ui/css/phone.css` + `ui/js/phonestore.js`.
Tablet (768+) e PC NON cambiano (schermate prima/dopo identiche al pixel). Testi: chiavi `ph.*` (5 lingue).
- Barra in basso grafite con 5 schede: Home, File, Scansiona (pulsante arancione al centro = scanner), Strumenti, Account.
  Schermate con titolo grande che si riduce scorrendo (`ph-scrolled`). Home: logo, "Apri file" (selettore del sistema), Scansiona,
  Crea nuovo, documenti aperti, recenti con miniatura/tipo/data, "Apri per tipo" (accept del selettore; su iOS niente accept per
  dwg/ifc... che iOS spegnerebbe). File: sfoglia/foto/fotocamera, file salvati con ricerca e ordinamento, spazio usato, Svuota.
  Strumenti: Scansiona, Confronta revisioni (due file), Unisci PDF (pdf-lib), Formati, Crea nuovo. Account: licenza (license.js
  `accountInfo`/`licenseReport`/`licenseChange`/`licenseNewKey`), tema Automatico/Chiaro/Scuro, lingua, spazio, versione
  (`window.MBV_BUILD` scritto da build_web.py).
- Recenti: copia del file in IndexedDB "mbv-telefono" (max 150 MB per file, 600 MB e 60 file in tutto) + miniatura JPEG presa dal
  disegno del visualizzatore (canvas, pagine di pdf.js, three.js con preserveDrawingBuffer) o dall'immagine. Un file salvato
  aggiorna la copia (`MBPhoneSaved` da webapi.js); licenza non valida = database cancellato (mlicenza.js).
- Documento aperto a tutto schermo: barra in alto (indietro, nome, condividi = Web Share con il file nello stesso tocco tramite
  `MBV_API.blobOf`, altro = foglio di azioni Salva/Salva con nome/Condividi/Apri come/Confronta/Proprieta'/Chiudi). Tocco singolo
  sul documento o scorrimento verso il basso = barre nascoste (`ph-imm`); doppio tocco = zoom (4 scatti di rotella simulata con
  Ctrl sui canvas: CAD, DWF, HP-GL, confronto, immagini, 3D; nei PDF zoom pdf.js / larghezza pagina; le mappe hanno il loro).
  La barra `.tb` di OGNI visualizzatore diventa il foglio "Strumenti" (stessa DOM, solo CSS: griglia di riquadri con icona e
  nome; i pulsanti con sola icona prendono il nome dal title); il pannello `.side > :first-child`, `.gis-left`, `.cmp-side`
  diventa un foglio trascinabile (chiuso/meta'/pieno; in orizzontale pannello a sinistra) con il pulsante "Pannello".
  PDF (adattatore in phone.js): barra di pdf.js nascosta, pagina "n / N" (tocco = vai alla pagina), Cerca (barra sopra il
  documento), Evidenzia/Testo/Disegno/Immagine (modi editor di pdf.js con il pulsante arancione per uscire), foglio "Pagine e
  segnalibri" con miniature e struttura.
- Menu di tutti gli editor (.menu, .ps-menu, .cad-menu, .pb-pop, .vs-pop...) come fogli in basso via CSS; `core.js modal`
  sul telefono: avvisi brevi = foglio in basso con pulsanti impilati, le altre finestre a tutta altezza con Annulla a sinistra
  e l'azione (o "Fine") a destra; `loading()` = scheletro della pagina; avvisi in basso; scaricamenti della web app = foglio
  "Condividi o Salva in File / Scarica" (`MBPhoneDeliver`). Tasto/gesto indietro: fogli -> menu -> pannello -> barre nascoste ->
  chiude il documento (`phoneUi.back` in goBack). Vibrazione leggera (navigator.vibrate, Android) su schede, menu, fogli.
- Editor di immagini sul telefono: strumenti in una striscia in basso, opzioni in alto, pannelli come foglio.
- Revisione 2 (24/10/2026). Barra in basso: Home, File, Scansiona, POSTA, Account (gli Strumenti sono una sezione della Home).
  * Aggiornamento in parallelo all'app per PC: `tools/build_portable.py` (pubblicazione in App per PC, salvo `--no-web`) lancia
    `tools/publish_web.py [commit]` = wt-web sullo STESSO commit + ui/vendor allineata, license_setup.py server, build_web.py
    --mobile con `MBV_VERSIONE` (= VERSION di app.py), wrangler deploy (Node x64). Si puo' lanciare anche da solo. Nella web app
    `window.MBV_VERSION` (numero dell'app per PC) e `MBV_BUILD` (numero + data); service worker controllato all'apertura, ogni
    30 min, al ritorno in primo piano e con la rete; versione nuova = ricarica da sola, ma con file modificati non salvati
    chiede prima (`mbv-update` -> foglio "Aggiornamento pronto"); dopo l'aggiornamento avviso "Aggiornata alla versione X".
  * Posta sul telefono: il browser non apre connessioni TCP, quindi `server/src/mailgw.js` = passaggio IMAP/SMTP SENZA memoria
    (POST /v1/mail/imap e /v1/mail/smtp, solo con il cookie di un telefono attivato; porte 993/143 e 465/587; TLS o STARTTLS
    con `connect` di cloudflare:sockets importato dinamicamente in index.js; `env._connect` per le prove). Il Worker esegue i
    comandi e restituisce le risposte GREZZE (intestazione JSON + byte), saltando i letterali senza esaminarli: poca CPU.
    Telefono: `ui/js/mmailcore.js` (gestori preimpostati PEC/comuni come accounts.py, IndexedDB "mbv-posta", password cifrate
    AES-GCM con chiave non esportabile, analisi delle risposte IMAP, MIME con postal-mime, MIME in uscita, PEC: X-Ricevuta,
    X-Trasporto, postacert.eml, daticert.xml) + `ui/js/mmail.js` (elenco con i non letti, cartelle, lettura in iframe senza
    script con immagini remote a richiesta, allegati aperti in MB Visual, rispondi/a tutti/inoltra, scrivi con allegati,
    sposta/elimina/contrassegna, aggiungi account con riconoscimento del gestore). Numero dei non letti sulla scheda (STATUS
    UNSEEN ogni 3 min con l'app aperta; niente notifiche ad app chiusa: servirebbe tenere le password sul server). "Invia per
    email" nel menu del documento aperto. Outlook.com/Microsoft 365 (solo OAuth) non ancora: messaggio che rimanda all'app per PC.
    Collaudo: `python tests/mailserver.py --imap 11143 --smtp 11025` poi `node server/test/mailgw.mjs` (10 prove; `nodesockets.mjs`
    imita cloudflare:sockets). Testi `mm.*` (5 lingue). Licenza non valida = anche la posta del telefono cancellata (mlicenza.js).
- Prove: Edge senza finestra via DevTools (Node, WebSocket) con emulazione iPhone 15 / SE, Pixel 8, Android 360x740, verticale e
  orizzontale, tema chiaro e scuro; server di prova = ui/ con l'intestazione della web app (MBV_WEB) e vendor della copia
  pubblicata. NB: il profilo di Edge di prova deve stare in un percorso corto, altrimenti IndexedDB da' "Internal error".

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
- ONLINE (dal 25/10/2026, 1.6.6): server principale https://mbdesk.mb-group.workers.dev (Worker "mbdesk", segreti caricati, cron);
  https://mbvisual.mb-group.workers.dev resta acceso senza cron per i telefoni gia' installati. Storia: ONLINE: server https://mbvisual.mb-group.workers.dev (dal 22/10/2026: Worker "mbvisual", sottodominio dell'account "mb-group"; il vecchio
  indirizzo con il nome dell'utente NON esiste piu' e non va mai rimesso: l'utente non vuole il suo nome negli indirizzi; account Cloudflare dell'utente,
  D1 "mbvisual-licenze" in EEUR, segreti SIGNING_KEY/ADMIN_TOKEN caricati, app per cellulari = stessa URL).
  wrangler NON gira con Node ARM64: usare Node x64 portatile in %USERPROFILE%\.mbvisual
ode-x64 e wrangler installato in
  %USERPROFILE%\.mbvisual\server (PATH="$NODE:$PATH" "$NODE/npx.cmd" wrangler deploy|d1 ...). Ripubblicare: license_setup.py
  server, build_web.py --mobile, poi deploy dalla copia di lavoro.
- App per cellulari (web app): si ricostruisce da una copia pulita `git worktree` in %USERPROFILE%\.mbvisual\wt-web
  (checkout di origin/main + copia di ui/vendor), `build_web.py --mobile` -> server\public, poi `wrangler deploy`. VERSION del
  service worker = data e ora della build (i telefoni prendono i file nuovi e la pagina si ricarica). Formati web in WEB_EXTS
  (anche dwf, calendari, contatti, hpgl, vis3d, visio vsdx, mbpub, las/pts/xyz); restano fuori quelli che vogliono il motore
  Python (DICOM, certificati, dati scientifici, iWork, Revit, skp, montaggio video, .vsd/.pub). `build_web.py` SENZA --mobile
  scrive docs/ = rimando di GitHub Pages al server (sw.js cancella la vecchia copia nei telefoni).
- Setup: `tools/build_setup.py` (Inno Setup 6 in %LOCALAPPDATA%\Programs\Inno Setup 6) -> MBVisual-Setup-<ver>.exe; release
  pubblicate con gh (account Lorenz0gr4ssi83) su https://github.com/Lorenz0gr4ssi83/MB-Visual-Rilasci (v1.4.2):
  `gh release create v<ver> <setup> --repo Lorenz0gr4ssi83/MB-Visual-Rilasci`. L'app senza OneDrive si aggiorna da li'.
- Cartella Google Drive di distribuzione (24/10/2026, richiesta dell'utente): a ogni rilascio setup Windows e .dmg Mac vanno in
  https://drive.google.com/drive/folders/1g0K6LkMuwgx4O1s1Pul32pgVDmpjNO1e e le versioni precedenti nella sottocartella "Old"
  (creata una volta sola). DAL 25/10/2026 (richiesta dell'utente): la cartella condivisa si chiama "MB Desk" (pubblica, sola
  lettura) e contiene SOLO l'ultima versione in "Windows" e "Mac"; apk (mai visibile ai clienti: si installa dal QR) e versioni
  vecchie vanno nella cartella PRIVATA "MB Desk - Archivio" (sottocartelle Android e Old) nella radice del Drive dell'utente.
  `tools/publish_drive.py <file>...` (smista da solo per tipo; `--riordina` = solo struttura) (token in %USERPROFILE%\.mbvisual\licenze\drive_token.json, rifare
  con --login se scade); lo chiama da solo build_portable.py --solo-pubblica / publish (salvo --no-drive). Il .dmg arrivato dopo:
  `python tools/publish_drive.py <dmg>` (non sposta il setup della stessa versione). MAI MB Visual Admin in quella cartella.
  Copia per l'utente in C:\Users\loren\OneDrive\Desktop\MB Desk (mai sul Desktop).
- DA FARE (decisione dell'utente): attivare l'obbligo di licenza = `server_url.txt` gia' scritto; lanciare
  `tools/license_setup.py chiavi` (scrive LICENSE_URL in license_pub.py) e fare una build SOLO quando l'utente ha creato le
  licenze per se' e i colleghi con MB Visual Admin. Poi rendere privato il repository MB-Visual (lo fa l'utente; prima
  spostare/spegnere la web app di GitHub Pages, sostituita dall'app per cellulari sul server).

- QR della home per installare l'app sul cellulare (22/10/2026): `ui/js/mobileqr.js` (riquadro in basso a destra della home,
  clic = QR grande; QR disegnato in locale con qrcode-generator 2.0.4 MIT in ui/vendor) + `license.mobile_link` (API
  license/mobile, ogni 6 s mentre la home e' visibile). Server: POST /v1/mlink (link monouso 10 min, posti liberi, blocco),
  GET /l/<link> (pagina del telefono), /v1/mlink/claim (attiva il cellulare: UPDATE condizionati -> un solo telefono per link e
  blocco della licenza 1 min con `licenses.mobile_lock`, rilasciato se l'attivazione fallisce), /v1/mlink/pair (codice di 6 cifre
  per l'app installata su iPhone, che non vede i cookie di Safari: prende lo stesso posto). Tabelle mobile_links e pair_codes
  (migrazione `server/migrations/001_qr_cellulari.sql`; online `d1 execute --file` da' errore di autenticazione: usare --command).
  Testi chiavi `mqr.*` (5 lingue). Le icone dei pulsanti hanno un contorno: sul QR va tolto (stroke: none) o copre i moduli.
- App per telefono di MB Visual Admin (22/10/2026), solo per il proprietario: `server/src/adminapp.js` (+ `adminui.js` GENERATO da
  `tools/build_admin_mobile.py` con `server/adminapp/index.html`, `sw.js` e le icone). Indirizzo segreto https://<server>/<ADMIN_PATH>/
  (segreto del Worker; valore in chiavi.json `admin_path`, MAI in file del repo o pubblici). Accesso con il codice di gestione o con
  un codice di 6 cifre (POST /admin/pair dall'Admin per PC: Impostazioni -> App per telefono, QR + codice, 10 minuti, una volta sola);
  5 errori per IP = attesa 15 min. Sessione nel cookie `mbv_a` (HttpOnly, Path=/<ADMIN_PATH>/, nel database solo lo SHA-256).
  Impronta/volto/PIN con WebAuthn (CBOR e verifica scritti a mano, ES256/RS256, UV obbligatorio, contatore): sblocco a ogni apertura e
  dopo 10 min senza operazioni (423 = bloccata). Notifiche Web Push: ogni `event()` del Worker manda la notifica (VAPID ES256 +
  aes128gcm RFC 8291 con WebCrypto, segreto VAPID_JWK; iscrizioni scadute 404/410 cancellate). iPhone: notifiche solo con l'app
  installata sulla Home, e l'app installata non vede l'accesso fatto in Safari (serve un altro codice di 6 cifre).
  Tabelle in `server/migrations/002_admin_telefono.sql`. Segreti: `tools/license_setup.py telefono` (crea e carica ADMIN_PATH/VAPID_JWK).
  Collaudo: `node server/test/admin_mobile.mjs` (40 prove: autenticatore WebAuthn simulato e finto servizio push che verifica VAPID e
  decifra); ambiente di prova condiviso in `server/test/shim.mjs`; `harness.mjs serve` apre l'app su /gestione-prova-locale-0000/.
  Admin per PC: `admin/build_admin.py [--dist <cartella>]` (con l'Admin aperto i file sono bloccati: costruire altrove e sostituire dopo).
- Notifiche a scelta e limiti modificabili (22/10/2026): `GET/POST /admin/settings` (tabella admin_settings, `{tipo: false}` = niente
  notifica; stesse scelte per Windows nell'Admin per PC e per il push del telefono; gli avvisi restano comunque). Tipi: activation_pc,
  activation_mobile, change, change_pending, report, expiring, expired, limit, invalid_key, revoked_use, admin_login. `update` di una
  licenza: max_pc/max_mobile anche con dispositivi attivi; sotto i dispositivi attivi serve `free` (id da disattivare), altrimenti 409
  `troppi_dispositivi` (le finestre chiedono quali disattivare). Scadenza da campo data = fino alle 23:59:59. Cron giornaliero (06:00 UTC,
  wrangler.toml [triggers]) = avvisi "in scadenza" (15 giorni prima) e "scaduta", una volta sola (colonne warn_*; migrazione 003).
- Admin, revisione 3 (23/10/2026): Panoramica raggruppata per giorno/mese/anno (gruppi richiudibili, filtro per tipo, "Segna come
  letti" e "Archivia" per gruppo, vista Archivio: colonna events.archived, migrazione 004, `POST /admin/events/read|archive {ids}`,
  `events?after=0[&archiviati=1]` = ultimi 3000); licenze eliminabili (`POST /admin/licenses/delete {keys}` o `/:key/delete`: via anche
  dispositivi, link, codici, richieste) con selezione multipla, filtri (prova/test/collaudo, revocate, mai attivate, sostituite) e
  "Annulla" per 6 s (l'eliminazione parte allo scadere); ordinamento per creazione / prima attivazione (`prima_attivazione` nell'elenco) /
  nome, nei due versi, ricordato (localStorage mbva-*). Email con la chiave: testo preimpostato in admin_settings "email" (segnaposto
  {cliente} {chiave} {pc} {cellulari} {link_setup} {link_telefono}); PC = SMTP dell'utente in Impostazioni (admin.py, password DPAPI in
  %USERPROFILE%\.mbvisual\licenzedmin_email.json; prova: `python admin/test_mail.py`) o programma di posta (mailto); telefono =
  mailto / Condividi. `GET /scarica` = ultimo setup da RELEASES_REPO passato attraverso il Worker (nessun nome nell'indirizzo).
  Telefono: avviso "Notifiche non attive" in Panoramica finche' il push non e' attivo (prima l'utente non l'aveva mai attivato).

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
- Google REGISTRATO (23/10/2026): progetto Google Cloud "mb-visual" (account dell'utente), Gmail/Calendar/People/Drive API attive,
  schermata di consenso "MB Visual" Esterna IN PRODUZIONE non verificata dal 24/10/2026 (chiunque si collega da solo, accesso che
  NON scade ogni 7 giorni; restano l'avviso "app non verificata" e il tetto di 100 utenti per tutta la vita del progetto),
  home page /mbvisual e privacy /privacy del Worker, dominio autorizzato mb-group.workers.dev, client "Applicazione desktop". ID e segreto NON nel repo
  (la protezione push di GitHub li rifiuta): `%USERPROFILE%\.mbvisual\licenze\cloud_ids.json` + secret MBV_CLOUD_IDS del repo;
  `tools/cloud_secrets.py` scrive `mbvisual/cloud_ids_build.py` (gitignore) a ogni build. Per i clienti: pubblicare l'app (home page,
  informativa privacy, verifica Google e valutazione di sicurezza annuale CASA per l'ambito mail.google.com).
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
- Insidie: in Python mai t() a livello di modulo (la lingua cambia per richiesta): nelle tabelle si mettono le chiavi e si traduce
  all'uso (es. batch.py `_ops()`, convert.py `_label`, inventor.py NOMI). I testi usati come CHIAVI di dati (rapporti, valori
  di stato, nomi di stili, dati in cache) restano fissi e si traducono solo nella visualizzazione (es. inventor3d.js `missLabel`).
  Menu costruiti dai nomi delle chiavi (`Object.keys(MENUS)`): etichetta con t("modulo.menu_" + nome).
- Conflitti nei rebase sui JSON: `python tools/i18n_check.py --resolve` unisce le due parti. I JSON si scrivono con "\n"
  (in Python `write_bytes`, non `write_text` che su Windows mette CRLF e cambia tutto il file).
- Verifica nel browser: `localStorage.setItem("mbv-lang","en")` + ricarica, poi cercare parole italiane nel DOM.

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


## Biglietti da visita dal telefono (24/10/2026) - FATTO (prova su telefoni veri: la fa l'utente)
Solo web app. Nella fotocamera dello scanner scelta "Documento / Biglietto da visita" sopra lo scatto (localStorage `mbv-scan-mode`) e,
per i biglietti, chip "Fronte e retro" PRIMA dello scatto (`mbv-bcard-fr`): dopo il fronte l'app chiede di girare il biglietto e
scatta il retro (stesso scatto automatico: aspetta che il biglietto sparisca o si sposti). `detectQuad(cv, canvas, { card: true })`
= area minima 4% e proporzioni 1,3-2,0 (85x55 = 1,55). Importa in modo biglietto: prima foto fronte, seconda retro.
- `ui/js/bcardparse.js` (puro, provato in Node): `parseText` (righe { text, h, conf } dell'OCR: email, siti, social, P.IVA/CF, telefoni
  con etichette it/en/de/fr e tipo dal numero se manca, indirizzo con CAP/citta'/provincia anche su una riga o con "Sede legale",
  nome con titolo Ing./Arch./Geom..., cognome in maiuscolo, particelle De/Di/Van; azienda da forma societaria o dominio dell'email;
  ruolo da parole chiave; righe illeggibili scartate), `parseQr` (vCard 2.1-4.0, MECARD, BIZCARD, link), `merge` (QR, fronte, retro
  senza doppioni), `buildVcard` (3.0 UTF-8, righe piegate a 75 byte, PHOTO base64, P.IVA/CF nella NOTE).
- `ui/js/bcard.js`: QR con jsQR (biglietto raddrizzato, poi foto intera; la zona del QR si copre di bianco prima dell'OCR), OCR
  Tesseract "ita+eng" (worker separato da quello dei PDF: `getOcr(langs)` di scanner.js), biglietti scuri invertiti, orientamento
  provato (0/180 o 90/270 per i verticali) finche' la confidenza non supera 62. Scheda di revisione (colori dell'app, chiaro/scuro)
  con foto fronte/retro, campi modificabili, righe non assegnate da toccare per inserirle nel campo attivo, "Salva nei contatti":
  Android = Web Share del file .vcf, iPhone/iPad (o senza condivisione di file) = apertura del file; il telefono mostra "Nuovo
  contatto" e conferma l'utente (una web app non puo' scrivere nei contatti). Foglio "Contatto pronto" con Apri/Condividi di nuovo.
  "Aggiungi anche alla rubrica della Posta" (solo con un account della posta del telefono): kv "indirizzi" (suggerimenti del campo A)
  e kv "rubrica" in IndexedDB "mbv-posta". Nessun dato al server.
- Librerie in build_web.py WEB_LIBS: eng.traineddata (best_int, Apache 2.0), jsQR 1.4.0 (Apache 2.0). Testi `bcard.*` (5 lingue).
- Revisione 24/10/2026 (richieste dell'utente): (1) biglietto su un piano di colore simile: terza strada in `detectQuad` solo per i
  biglietti (Canny a soglie basse su L equalizzata e sui canali a/b di Lab, bordi richiusi) + riquadro guida tratteggiato 85x55 quando
  i bordi non si trovano (lo scatto ritaglia quella zona, poi si regolano gli angoli). (2) Scatto "Automatico / Manuale" (scelta in
  alto, `mbv-scan-scatto` = auto|manuale, MANUALE predefinito per richiesta dell'utente, anche per i documenti). (3) Niente raffica: dopo uno scatto automatico si aspetta un foglio NUOVO = spostato
  oltre il 15% della diagonale, oppure sparito e ricomparso con contenuto diverso (impronta 16x16 normalizzata, correlazione <= 0,7);
  una mano che passa o un fotogramma senza bordi non bastano piu'. Dopo "Altro biglietto" il primo biglietto visto e' quello appena
  letto. Prova: piano quasi bianco senza ombra `it_fronte_retro_fronte_foto_chiaro.jpg`.
- Collaudo: `python tools/make_bcard_samples.py` -> tests/samples/biglietti (fronte/retro, QR vCard, MECARD, bilingue con fronte scuro;
  attesi.json) poi `node tests/test_bcard.mjs` (77 prove). Interfaccia provata in Edge senza finestra (fotocamera simulata con
  canvas.captureStream sulle foto *_foto.jpg, navigator.share sostituito): lettura 2-7 s per biglietto, campi esatti sui 4 campioni.
  Prove dalla console: `window.MB_BCARD` (res, current(), makeFile()), `MB_SCAN.cardSides`.
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
## Disegni e tavole sulla mappa (22/10/2026) - FATTO
DWG/DXF e PDF come livelli del visualizzatore GIS. Ingressi: pulsante "Mostra sulla mappa" nel CAD 2D (`ctx.openAs("gis")`: il GIS
apre il disegno come primo file), "Aggiungi disegno..." nella barra del GIS, trascinamento di dwg/dxf/pdf sulla mappa (acceptDrop).
- `ui/js/georef.js` = solo calcolo (collaudo `node tests/test_georef.mjs`, 41 prove): affine X = aX+bY+c, Y = dx+ey+f ai minimi
  quadrati su coordinate ridotte ai baricentri; metodi rigida (scala nota: unita' del disegno o scala della tavola, 1+ punti,
  rotazione data con un punto), similarita' (2+), affine (3+); scarti per punto e RMS in metri, punti escludibili (off).
  GEODATA: DXF letto dal testo (`geodataFromDxf`), DWG con l'API dinamica di libredwg (`dwgGeodata` in cad2d.js, solo se
  `ctx.geodata`): punto di progetto -> punto di riferimento (tipo 3 = lon/lat, proiettato nel sistema), scala orizzontale,
  rotazione dalla direzione del nord; sistema da `<Alias id="EPSG">` dell'XML di AutoCAD/Map 3D, WKT o nome (`epsgFromCsDef`).
  Coordinate gia' georeferenziate riconosciute dall'estensione (`guessFromExtent`: Gauss-Boaga O/E, fuso Italia, UTM -> 7791).
- `ui/js/gisdraw.js`: ogni disegno ha una proiezione OpenLayers "MBVDRAW:n" (piano del disegno) collegata con
  addCoordinateTransforms a TUTTI i sistemi di giscrs (affine + proj4): riproiezione, esportazioni GeoJSON/KML/shapefile
  (exportFeatures di gis.js) e raster PDF riproiettato (ImageStatic con projection = quella del disegno) funzionano senza casi
  speciali. CAD: `readDrawing`/`buildModel` -> un MultiLineString / MultiPolygon ogni 2000 tratti per gruppo layer+colore (non
  un elemento per entita': troppi oggetti OpenLayers), testi = punti con stile in pixel da altezza x scala / risoluzione; bianco
  ACI 7 -> scuro; layer CAD accendibili (`L.drawing.cadLayers`; quelli spenti non si esportano). PDF: pagina resa con pdf.js
  (max 8192 px / 36 Mpx), bianco reso trasparente (si puo' togliere). Ordine iniziale: `<file>.mbgeo` -> GEODATA -> coordinate
  -> posizione provvisoria al centro della mappa (pannello di georeferenziazione aperto da solo; "Sposta qui" la porta al centro
  della vista e sceglie il fuso UTM 32/33 dalla longitudine).
- Pannello (in alto a destra della mappa): sistema, metodo, unita' (mm/cm/m...) o scala 1:N, rotazione, "Aggiungi punti"
  (clic sul disegno, poi sulla mappa; Esc finisce), "Quota nota" (due clic sul disegno + distanza reale = scala), tabella con
  E/N modificabili a mano, scarti (in evidenza se > 3 x RMS), riepilogo scala/rotazione/RMS, opacita'. Aggancio GEOMETRICO
  (indice spaziale delle sorgenti, non la hit detection di OpenLayers che dipende dal disegno a schermo): prima le entita'
  PUNTO (`D.nodes`; la crocetta disegnata ha estremi a +-0,5 unita' e ingannava l'aggancio), poi i vertici; sul lato mappa i
  vertici degli altri livelli vettoriali (anche un altro disegno gia' georeferenziato). Misure Distanza/Area agganciate ai
  vertici dei disegni (ol.interaction.Snap, fino a ~300.000 vertici).
- `.mbgeo` = JSON accanto al file con il nome completo (`lotto.dxf.mbgeo`, cosi' lotto.dxf e lotto.pdf non si scontrano):
  crs, method, unit, transform, points, rms, page/pdfScale per i PDF. Si scrive solo con "Salva georeferenziazione" (nella
  web app si scarica). Testi: chiavi `gisdraw.*` (5 lingue).
- Campioni: `python tools/make_georef_samples.py` -> `tests/samples/georef` (stesso lotto a Bologna: UTM 32N in metri, locale
  in mm ruotato di 25 gradi, locale con GEODATA, tavola PDF A3 1:500, `punti_controllo.json`). Provato nell'app: UTM e GEODATA
  si sovrappongono da soli (errore 0), locale con 3 punti (uno con 4 cm di errore) RMS 1,6 cm e vertice di verifica a 1,5 mm,
  PDF 1:500 con 2 punti; .mbgeo salvato e riapplicato; GeoJSON e shapefile (.prj RDN2008/UTM 32N) corretti; DWG reale
  (libredwg) in 0,5 s. NON provato: GEODATA dentro un DWG vero (nessun campione; i nomi dei campi sono quelli di libredwg).
- Prove nel riquadro del browser nascosto: OpenLayers non disegna (rAF fermo) -> `map.renderSync()` prima dei clic simulati
  (`MB.active.api._gis.drw.onMapClick({ coordinate, pixel })`).

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


## Autodesk ReCap .rcs / .rcp (28/10/2026) - FATTO
Prima: .rcs/.rcp non erano nel registro -> si apriva la schermata "file sconosciuto". Ora categoria `pointcloud` (stesso motore,
ottree e cache delle altre nuvole). Nessuna specifica pubblica ne' lettore open source: struttura ricavata da file veri, descritta in
testa a `mbvisual/rcs.py` (NIENTE SDK o DLL Autodesk). "ADOCT" v3: tabella delle sezioni non allineata (si cerca), sezione 2 = voxel
(u64 N + record da 368 byte: cubo, ingombro, punti, byte, nodi/punti per livello), sezione 1 = per voxel tabella dell'ottree
(u32: bit 27 foglia, bit 19-26 figli) + 16 byte per punto: u64 con x/y/z da 18 bit in mm dal minimo del voxel, intensita', B, G, R,
u16 normale. Coordinate = minimo del voxel + mm/1000 + traslazione dell'intestazione (rotazione/scala: nei file visti 0 e 1).
Altre versioni / file troncati = messaggio chiaro con il consiglio "esporta da ReCap in E57" (chiavi `srv_pointcloud.rcs_*`, `rcp_*`).
- `.rcp`: zip o XML con i percorsi degli .rcs (+ matrice 4x4 se presente); se non si capisce, tutti gli .rcs di "<progetto> Support".
  NON verificato su un .rcp vero (nessun campione pubblico): da provare con i progetti dell'utente.
- Web app: non abilitato (serve il motore Python). Riconoscimento dal contenuto in misc.sniff e recover.identify.
- Collaudo: `python tests/test_rcs.py` (RCS sintetico scritto con la stessa struttura, .rcp, errori) e
  `python tests/test_rcs.py <file.rcs> <file.e57>` (confronto con l'E57 dello stesso rilievo). Campione vero usato (NON nel repo, licenza
  "solo prove, non ridistribuire"): rilievo di un edificio "Eka 15mm res" di arrival3d.com/laser-scanning-sample-downloads (RCS da 5,2 GB,
  232 milioni di punti, + lo stesso in E57). Risultato 28/10/2026: 232.118.216 punti letti in 84 s, campione di 5,8 milioni tutti
  ritrovati nell'E57 (scarti di micron), colori e intensita' identici; nell'app ottree pronto in 292 s (cache 3,7 GB), poi immediato.
- pointcloud._build: indici a 32 bit e confronti a blocchi (`_starts`): prima con 232 M punti MemoryError su 16 GB; uscita identica
  byte per byte alla versione precedente (verificato).
- PROVE CON UN SERVER AVVIATO DA CODICE: l'interfaccia avvia da sola il motore della posta (mailbadge.js) sui dati VERI di
  %LOCALAPPDATA%\MBVisual\posta. Impostare LOCALAPPDATA su una cartella di prova (DATA_DIR lo segue) prima di start_server.

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

## Formati aggiuntivi (22/10/2026) - FATTO
DICOM, calendari, contatti, certificati, Apple iWork, plotter HP-GL, HDF5/NetCDF/Parquet/Arrow, Revit. Registro con
`python tools/add_fx_formats.py` (rilanciabile: toglie e rimette le 8 categorie; sposta ics/vcf/cer/crt/pem/csr da "text"
e p7b da "signed"), poi `tools/gen_elenco.py`. Backend: UNA sola API `api/fx?op=...` (server.py `api_fx` -> `mbvisual/formati.py`,
che ritorna JSON oppure (byte, intestazioni) per i dati binari). Stili in `ui/css/formati.css`. Riconoscimento dal contenuto
in `misc.sniff`: kind `dicom` (DICM a 128), `scidata` (CDF/HDF5), `iwork` (`_is_iwork` legge l'indice dello zip).
I DICOM SENZA estensione (o con nome numerico) si aprono col visualizzatore DICOM se il contenuto lo conferma (app.js resolveCategory).
- DICOM `fx_dicom.py` + `viewers/dicom.js`: serie = file della cartella con lo stesso SeriesInstanceUID (anche senza
  estensione), ordinati lungo la normale; DICOMDIR (nome senza estensione -> NAME_AS_EXT dicomdir). Pixel con LUT di
  modalita' mandati grezzi (i16/f32 o RGB u8, intestazioni X-W/X-H/X-C/X-T): finestra/livello nel browser con LUT a 65536 voci.
  Compressi via python-gdcm. Tasto destro = finestra, centrale = sposta, rotella = sezioni, Ctrl+rotella = zoom.
- Certificati `fx_cert.py` + `viewers/cert.js`: la password .p12 va solo nel corpo della richiesta di lettura; le
  esportazioni (PEM/CRT/CER/P7B/TXT) usano i PEM pubblici gia' letti, mai la password. Catena verificata con
  `verify_directly_issued_by`, poi archivio di Windows (ssl.enum_certificates ROOT/CA).
- Calendari/contatti `ui/js/pim.js` (iCalendar con RRULE/EXDATE/fusi IANA e Windows, vCard 2.1-4.0 con quoted-printable e foto),
  `viewers/calendar.js`, `viewers/contacts.js`: funzionano anche nella web app; PDF via `html_pdf` (PyMuPDF Story), Excel via `xlsx`.
- HP-GL `ui/js/hpgl.js` (interprete scritto da zero: PE compresso base 64/32, PM/FP, CI/AA/AT, SC/IP, LB, PC/PW, RO) +
  `viewers/hpgl.js`; SVG in mm, PDF = SVG -> PyMuPDF (`svg_pdf`) a dimensione reale.
- Dati `fx_sci.py` + `viewers/scidata.js`: HDF5/NetCDF-4 con h5py, NetCDF 3 letto a mano (classe NC3, anche CDF-5),
  Parquet a gruppi di righe, Feather/Arrow; grafico (serie o mappa) da un campione con passo.
- iWork `fx_iwork.py` + `viewers/iwork.js`: Snappy + protobuf scritti a mano. Testi = oggetti tipo 2001 (TSWP.StorageArchive,
  campo 3); tabelle Numbers = 6001 (modello) -> tile 6002 -> celle; formato celle v4 (2013-2018) decifrato e verificato
  sui file di Tika; v5 (dal 2019, campi 6/7 delle righe) scritto ma NON collaudato (manca un file di prova).
  iWork '09 = XML (index.xml/index.apxl). Anteprime: preview.jpg, QuickLook/Thumbnail.jpg, QuickLook/Preview.pdf.
- Revit `fx_revit.py` + `viewers/revit.js`: olefile; BasicFileInfo (versione, build, condivisione, centrale), RevitPreview4.0 (PNG),
  PartAtom (famiglie: categoria, parametri, tipi), TransmissionData (collegamenti esterni). Geometria non leggibile.
  Revit -> IFC (28/10/2026, segnalazione "i .rfa non si salvano in IFC"): la geometria NON si puo' ricavare senza Revit
  (Partitions = oggetti serializzati con lo schema di Formats/Latest, gzip senza coda; forme in ExtrusionElem/BlendElem ->
  GNode -> GFace; nessun lettore libero la decifra, rvt-rs Apache-2.0 dice "no family geometry"; Revit non e' su questo PC;
  alternative a pagamento: Autodesk APS, ODA BimRv). Il visualizzatore lo spiega in un riquadro e per le FAMIGLIE offre
  Salva con nome -> "IFC con i soli dati della famiglia" (`fx_revit.family_ifc`: IFC4 con un tipo + un'occorrenza senza
  rappresentazione per ogni tipo, classe IFC dalla categoria (`_IFC_MAP`, nomi inglesi e italiani; altrimenti proxy),
  property set dai gruppi di PartAtom ripetuti per ogni tipo (DefinesType [0:1]), misure in metri, OmniClass dalle
  categorie con scheme std:oc*). Per i .rvt niente IFC (messaggio: esportarlo da Revit). Collaudo:
  `python tests/test_revit_ifc.py [cartella .rfa]` (web-ifc con tests/check_ifc_webifc.mjs; IfcOpenShell se installato).
- Prove: `python tools/make_fx_samples.py [--pubblici]` -> tests/samples/fx (campioni generati + `pubblici/` da Apache Tika e
  DynamoRevit, Apache-2.0, vedi FONTI.md), poi `python tests/test_fx_formats.py` (46 controlli).
- Testi in 5 lingue: chiavi v_dicom.*, v_cert.*, v_calendar.*, v_contacts.*, v_hpgl.*, v_scidata.*, v_iwork.*, v_revit.*, pim.*,
  srv_fx_*.*, srv_formati.*, fmt.<id>.*. Nei moduli Python le etichette fisse sono funzioni (_names(), _labels()...) perche' la lingua
  e' quella della richiesta, non quella dell'importazione; le chiavi tecniche (BasicFileInfo di Revit, blocchi PEM) restano in inglese.
- Librerie nuove (requirements.txt + hidden import in build_portable.py): pydicom MIT, python-gdcm Apache-2.0/BSD, h5py BSD-3,
  pyarrow Apache-2.0, olefile BSD-2.

## Autodesk DWF / DWFx (22/10/2026) - FATTO
Visualizzatore `ui/js/viewers/dwf.js` (categoria `dwf` in formats.json: .dwf .dwfx .w2d .xps; .xps spostato qui da office-lo perche'
senza LibreOffice non si apriva; .oxps resta in office-lo, non collaudato), tutto in JS (anche web app), scritto da zero.
- Pacchetto `ui/js/dwfpkg.js`: DWF 6 (zip dopo "(DWF V06.xx)": JSZip riceve il file intero), DWF <= 5.5 (un solo W2D), DWFx/XPS
  (manifest, descrittori ePlot/eModel, risorse ?dwfresource_N = Canvas della FixedPage). Fogli in coordinate della carta (y in su),
  layer, oggetti (ObjectDefinition 6.0, content.xml + SectionContent 6.2/DWFx, nodi W2D/W2X), marcature (MarkupObjectDefinition),
  unita' (matrice Units + trasformazione del descrittore; riquadri W2D con Units propri; DWFx: viewport W2X per elemento -> `vpUnits`).
- `ui/js/w2d.js` (specifica WHIP! di Autodesk): coordinate relative con somma a 32 bit senza segno; angoli delle immagini e riquadro dei
  testi Ctrl-X sono RELATIVI (aggiornano il punto corrente; ordine reale: sopra/sotto-lineato, riquadro, riservati). Compressione zlib/LZ con
  cronologia precaricata `ui/js/w2dpreload.js` (dati del formato dal DWF Toolkit, Adler-32 5CBC15B9); `ui/js/inflate.js` = inflate proprio.
  Testi: il riquadro (P0->P1 base, P0->P3 alto) da' orientamento e larghezza veri; flag 1 = testo verticale (lettere impilate).
- `ui/js/xpspage.js`: FixedPage (Path, Glyphs con Indices, Canvas, dizionari, ImageBrush, gradienti); caratteri .odttf de-offuscati con la GUID.
- Disegno `ui/js/dwfdraw.js` (gruppi Path2D, ritagli, selezione, aggancio), esportazioni `ui/js/dwfexport.js` (SVG, PNG 200 dpi, PDF vettoriale
  scritto a mano con Helvetica adattata in larghezza; Salva con nome PDF = tutti i fogli 2D).
- 3D: `ui/js/hsf.js` (HSF/W3D: specifica v10 + opcode delle versioni 11-12 ricavati dai dati: sfera 0x1a, ':' attributi geometria, archi con
  byte in piu' dalla 12.00, Rendering_Options con riallineamento), `ui/js/edgebreaker.js` (Edgebreaker da Rossignac 1999/2001: anello iniziale
  k = T - 2C + 2 per componente, "tappo" virtuale, zip in un solo verso; vertici fittizi e patch come differenze progressive, nuovo indice
  delle patch = numerazione finale; i punti sono float in chiaro dopo il blocco), `ui/js/w3d.js` (scena three.js: inclusioni ?Include Library,
  colori, spigoli, nodo = indice di tag HSF -> proprieta' via navisId/navisProps). model3d.js: aggancio `ctx.preloaded`.
  NB: i sorgenti w3dtk del DWF Toolkit portano un avviso "trade secret" Tech Soft 3D: NON usarli (consultati solo per l'ordine dei campi
  della shell, il formato dei bit a parole di 32 bit e l'opcode 0xE0; nessun codice copiato).
- Collaudo (campioni pubblici: repo aspose-cad/Aspose.CAD-for-.NET MIT, kveretennicov/dwf-toolkit samples Autodesk, esempi di
  flyfish-dev/dwf-viewer solo come file di prova): 2D fedeli alle miniature originali; 3D Inventor/Revit/esempi corretti (9.500+ componenti
  edgebreaker chiuse, 0 errori). Texture dei materiali (titolo della risorsa nel descrittore = nome dell'immagine nel flusso; Revit lo usa
  come colore diffuso, Inventor passa da TKE_Texture) con UV dove ci sono, altrimenti colore medio. Immagini CCITT Group 4: `ui/js/ccittg4.js`
  (T.6 + TIFF, collaudato con TIFF di Pillow). Non gestiti: macro W2D, NURBS, normali compresse (si ricalcolano).

## Interfaccia premium "Grafite di precisione" (22/10/2026) - FATTO
Direzione approvata dall'utente sul mockup https://claude.ai/artifact/Wwi8B75nmM8pTZofAqvk45 (home, CAD, PDF, BIM, palette, sistema).
- Regole dell'utente: il logo `ui/img/logo.png` e' il PROTAGONISTA (grande al centro della home) ma MAI ripetuto nella barra del titolo sotto quello della cornice della finestra (richiesta dell'utente, ribadita il 22/10/2026);
  sopra il logo una quota con "MB GROUP" nel grigio del logo (#8A8C89 = `--brand`); NIENTE diciture inventate (niente
  "Professional", copyright, slogan): solo testi gia' presenti o dati dall'utente. Avvio (solo mockup): "Passepartout App" e "MB Group".
  Niente caselle "Cosa apre" nella home: i formati si consultano nella scheda Formati (pseudo-scheda accanto ai file aperti).
- Token in testa a `ui/css/app.css` (tema chiaro predefinito, scuro con data-theme o prefers-color-scheme): cornice sempre grafite
  (`--t0`, `--chrome*`), superfici `--bg/--panel/--panel-2`, `--hover`, accento unico arancione MB `--accent` (#F07D2E in scuro,
  #EA7426 in chiaro) con testo `--accent-fg` quasi nero sopra l'arancione e `--accent-ink` per il testo arancione leggibile,
  ombre `--sh-1/2/3` (`--shadow` = `--sh-3`), raggi `--r-sm/md/lg/xl`, badge tenui (`.badge` con `--c` = colore del tipo `--t-*`).
  Gli editor usano solo questi token; Premiere (blu della testina), Publisher (verde acqua) e Visio (blu) tengono il loro
  accento come i programmi originali, con i grigi allineati.
- Caratteri OFL inclusi in `ui/fonts` (`tools/fetch_fonts.py`, Fontsource 5.3.0, sottoinsiemi latin + latin-ext, licenze accanto):
  IBM Plex Sans (interfaccia), Space Grotesk variabile (titoli, `--display`), IBM Plex Mono (`--mono`). server.py: tipo font/woff2.
- Struttura (`ui/index.html`): barra del titolo (logo, schede, ricerca comandi) -> barra comandi (File, Apri, comandi del file,
  `#ctx-tools`, percorso `#crumb`) -> `.workspace` con barra laterale `#rail` (Home, Esplora, Cloud aggiunto da cloud.js dopo
  `#btn-explorer`, Cerca nel progetto, Formati; in basso Scorciatoie e Tema) + pannelli + `#stage` -> barra di stato.
  Su schermi stretti la barra laterale va in basso come barra delle schede. ID invariati (cloud.js, search.js li usano).
- Palette dei comandi `ui/js/palette.js` (Ctrl+K o la ricerca nella barra del titolo): comandi dell'app, file aperti, recenti,
  ".ext" = come si apre un formato. Ctrl+K resta all'editor quando il programma originale lo usa (Premiere, Publisher, Office:
  `editorOwnsCtrlK` legge `active.shortcuts`) o nei campi di testo. Chiavi `pal.*` nelle 5 lingue.
- Home: `body.at-home`; trascinando file sulla finestra `body.dragging` illumina il riquadro del logo (fuori dalla home resta
  il riquadro "Rilascia per aprire"). Scorciatoie "Crea nuovo" = `createNew({ ext })` (newfile.js) senza galleria.
- pdf.js: colori della sua barra presi dai token dell'app (`viewers/pdf.js`, anche al cambio tema). Finestra di Windows 11:
  cornice grafite con DwmSetWindowAttribute (`_graphite_frame` in app.py; su Windows 10 resta quella di sistema).
- Prove in modalita' browser: per lavorare in un worktree serve una COPIA di ui/vendor (con un collegamento/junction il server
  rifiuta i file fuori dalla cartella ui: pdf.js dava "Non trovato").

## Funzioni di Navisworks Manage nel 3D (22/10/2026) - FATTO (da provare sui modelli veri dell'utente)
Tre pulsanti nella barra del visualizzatore 3D dopo "Segnalazioni": Interferenze, Viste, Computo = un pannello a schede a destra
(`ui/js/navmanage.js`, larghezza trascinabile; chiude il pannello BCF e viceversa). Stili `ui/css/navis.css` (token esistenti).
- Clash Detective (`ui/js/clashpanel.js`): test con schede Regole / Selezione / Risultati / Rapporto. Insiemi A e B per modello
  federato, classe (nome del gruppo IFC, classe Navisworks o layer Rhino), livello (piano IFC, `qtocore.levelMap`) o selezione
  salvata (chiavi degli elementi). Tipi: compenetrazione con tolleranza, distanza minima, duplicati; "ignora coppie dello stesso
  modello"; raggruppamento delle interferenze vicine (raggio). Stati come Navisworks: nuovo -> attivo alla riesecuzione,
  rivisto/approvato restano, scomparse -> risolto (`mergeRun`), "Compatta" toglie le risolte. Clic = elemento 1 rosso, 2 verde,
  resto trasparente/nascosto/normale, zoom sulla zona (intersezione degli ingombri) spostato nella parte non coperta dal pannello;
  frecce su/giu' nell'elenco; nota e assegnatario per interferenza. Massimo 20.000 risultati per test.
- Motore (`ui/js/clashcore.js`, puro, nessuna libreria: BVH di triangoli scritto qui) in un Web Worker modulo
  (`ui/js/clashworker.js`); la geometria si manda a blocchi (Float32 in coordinate della scena; dei modelli uniti per colore si
  copiano solo i vertici usati dalle copie di selezione). Fase larga = ordinamento e scorrimento degli ingombri. Compenetrazione =
  spigoli che attraversano l'altro elemento (gli estremi e le facce complanari non contano: elementi appoggiati non sono
  interferenze); profondita' = massima distanza dalla superficie dell'altro dei punti che gli stanno dentro (centri dei tratti di
  spigolo tra due attraversamenti, vertici), dentro/fuori con 3 raggi a maggioranza; anche "tutto dentro l'altro". Distanza minima
  = BVH contro BVH con distanze triangolo-triangolo (Ericson). Interrompi = il worker si chiude.
- Rapporto (`ui/js/clashreport.js`): HTML unico con immagini incluse, PDF (scrittore di `bcfreport.js`, ora esporta PdfDoc,
  toJpeg, wrap, ellipsis, textW), CSV (;), BCF: file .bcfzip o "Aggiungi alle segnalazioni" nel pannello BCF del modello
  (tipo Clash, punto di vista con selezione e colori A/B, istantanea; `clash.bcf` = GUID della segnalazione: riesportando si
  aggiorna). Stati -> BCF: nuovo/attivo Open, rivisto In Progress, approvato Closed, risolto Resolved.
- Viste salvate (in navmanage.js): punto di vista BCF del ponte (`bcfview.js`, coordinate del progetto: camera, sezioni,
  visibilita', colori) + distanza dal punto di mira + miniatura. "Colora" = colore di sostituzione (`bridge.colorize`, nuovo),
  "Ripristina" = colori, sezioni e visibilita' originali. Il ponte BCF ora e' unico per segnalazioni e viste (`getBridge` in
  model3d.js, terzo argomento di `attach3d`).
- File `.mbvnav` (`ui/js/navdoc.js`, JSON) accanto al modello (stesso nome), salvato da solo ~1 s dopo ogni modifica (nella web
  app solo "Salva con nome" = download); contiene viste, test con risultati (punti in coordinate del progetto, distanze in metri),
  elenco dei modelli federati: riaprendo il primo modello l'app propone di ricaricare gli altri della stessa cartella (come un NWF).
  Tolleranze salvate in metri e mostrate in m (IFC, Navisworks, glTF, SketchUp) o mm (CAD e mesh).
- Computo (`ui/js/qtopanel.js` + `ui/js/qtocore.js` puro): per elemento IFC classe, tipo (IfcRelDefinesByType), livello,
  quantita' delle IfcElementQuantity e misure dei Pset (IfcLength/Area/Volume/MassMeasure), convertite in SI con le unita' del
  progetto. Quantita' principali per nomi preferiti (`MAIN`; lunghezze solo Length/NetLength/GrossLength). Raggruppamento
  Classe/Tipo/Livello (5 ordini), tutto / solo visibili / solo selezione, clic = selezione nel 3D, doppio clic = inquadra; Excel con
  foglio Riepilogo e foglio Elementi (tutte le quantita', una colonna per "set · nome"). Solo modelli IFC.
- model3d.js: aggiunte puntuali (bcfHost con `unitOf`, `bcf`, `addModels`; `addModels` estratta da "Aggiungi modello" che ora
  aggiorna anche `parts`; pulsanti; `api._nav`; controllo del .mbvnav all'apertura). Testi `nav.*`, `clash.*`, `clashrep.*`,
  `qto.*`, `v_model3d.interferenze|viste|computo*` in 5 lingue.
- Collaudo: `node tests/test_clash.mjs` (34 prove, senza browser: web-ifc in Node con fetch del .wasm dal disco) su
  `tests/samples/interferenze` (`python tools/make_clash_samples.py`: struttura.ifc con trave nei muri e pilastro duplicato,
  impianti.ifc con tubo nei muri, canale nelle travi, tubo a 3 cm da una trave) + solidi sintetici + 20.200 elementi (~3 s).
  Prova di carico nell'app: `python tools/make_clash_samples.py --grande <file.ifc> 112` (16 MB, 25.200 elementi, modello unito
  per colore): 12.544 interferenze in 2 s, interfaccia viva, Interrompi provato. Provati nell'app (server avviato senza app.py
  per non toccare l'integrazione con Esplora): federazione, stati, gruppi, rapporti HTML/PDF/CSV/BCF, viste, Excel, modello OBJ.
- Da provare con i file veri: modelli Revit/Archicad con aperture (IfcOpeningElement escluso dalla lettura) e elementi non chiusi
  (dentro/fuori a maggioranza), Navisworks NWD grandi, prestazioni oltre 100.000 elementi, unita' imperiali nel computo.

## Editor PDF in stile Acrobat Pro (22/10/2026) - FATTO
Richiesta dell'utente: niente pulsanti grandi con testo, TUTTO IN UNA RIGA raggruppato per tipo di modifica, funzioni da
Acrobat Pro / PDF-XChange / Foxit. Solo app per PC (la web app tiene la barra semplice con pdf-lib, `viewers/pdf.js`).
- Riga unica (`ui/js/pdfedbar.js`, in `ctx.tb` con classe `pe-tbrow`): pagina / zoom / ricerca (la barra di pdf.js e'
  nascosta con PDFJS_CHROME) + gruppi con icone, didascalia sotto e menu "altro": Seleziona (V, H), Modifica (T testo,
  W aggiungi testo, I immagine, R forme ▾, menu: collegamento, bianchetto, copia/incolla, gruppi, ordine), Commenti (S nota,
  U evidenzia ▾ sottolinea/barra/ondulato, X casella, D penna, N forme di commento ▾ con nuvola di revisione, K timbro ▾),
  Moduli (Q campo ▾ 7 tipi), Pagine (organizza, inserisci ▾, ruota, C ritaglia, menu: estrai, elimina, dividi, unisci...),
  Proteggi (Y oscura area, oscura testo cercato, firma, menu: applica oscuramenti, password, rimuovi info nascoste...),
  Documento (intestazione/pie', filigrana, Bates, OCR, menu: sfondo, ottimizza, confronta, proprieta', segnalibri...),
  Annulla/Ripeti con il nome del passo, pannello. Se non ci sta spariscono le didascalie (`compact`), poi scorre.
  Misure: ~1380 px; a 1366 px di finestra sta in una riga in modo compatto.
- `ui/js/pdfeditor.js` = nucleo (oggetto E: stato, coda delle modifiche, copia di lavoro, annulla/ripeti, strati sulle
  pagine, strumenti, selezione con 8 maniglie + rotazione (Maiusc 15°), guide di allineamento (Alt = senza), allinea/
  distribuisci, ordine, copia/taglia/incolla tra pagine (obj_copy), gruppi Ctrl+G (solo nella sessione), tasti di Acrobat).
  `pdfedpanel.js` pannello a destra (schede Proprieta'/Commenti, sezioni richiudibili, posizione X/Y/L/A in mm e rotazione),
  `pdfcomments.js` elenco commenti (filtri, risposte, stato Review, CSV), `pdfpages.js` Organizza pagine (miniature,
  trascina per riordinare, ruota, duplica, elimina, estrai, inserisci, sostituisci), `pdfdocs.js` finestre di pagine e
  documento (anteprima per intestazioni e filigrana), `colorpick.js` selettore colori (HEX/RGB/CMYK, opacita',
  contagocce EyeDropper o sulla pagina, colori del documento, recenti), `pdfedicons.js`, `ui/css/pdfeditor.css`.
  Prove dalla console: `MB.active.api._pe` (E: setMode, sel, ops, align, paste, pageCmd, docCmd...).
- Motore: `mbvisual/pdfobjects.py` (oggetti, ops su oggetti e commenti, `annots_list`, `image_export`, `paths_hit`) +
  `mbvisual/pdfdoc.py` (OPS di pagine e documento: page_order/replace/insert/blank/delete/rotate/duplicate, crop con
  margini o reset, header_footer, bates, watermark, background, redact_search/redact_apply, sanitize, metadata, toc, flatten).
  API nuove: pdf_annots, pdf_image_export, pdf_hit. Angoli in gradi orari come si vedono (filigrana: antiorari come Acrobat).
- Insidie scoperte (PyMuPDF 2.0): Pixmap(doc, xref) da' un canale alfa TUTTO OPACO senza applicare SMask -> la maschera
  si applica a mano (`_image_bytes`, anche /Mask a chiave di colore e /ImageMask di stencil col colore letto dalla pagina);
  prima spostando un logo trasparente diventava un rettangolo nero. TextWriter va creato con page.rect (rettangolo visibile)
  e morph ruota in verso antiorario: sulle pagine ruotate le righe si compongono nel verso di lettura e si riportano attorno
  al centro. fill_textbox scrive spazi non separabili: le righe si compongono in `_write_block`. Con i caratteri di Windows
  MuPDF scrive ToUnicode con U+00A0/U+00AD per spazio e trattino: `pdfedit.fix_tounicode` li corregge (anche nel vecchio
  editor). I sottoinsiemi incorporati non hanno cmap: `_font_with_cmap` la ricostruisce dalla ToUnicode con fontTools e il
  testo riscritto usa il carattere originale se ha tutti i glifi (altrimenti il carattere di Windows piu' simile).
  Campi nuovi: proprieta' PRIMA di add_widget (nasce un /Parent). Conteggio immagini condivise dalle risorse
  (get_image_info con xrefs decodifica tutto: 194 s su una pagina con 1951 tasselli).
- Testo: paragrafi ricostruiti (righe piene unite, pallino + testo sulla stessa linea di base con tabulazione), allineamento
  riconosciuto (titoli centrati sull'area del testo), una riga sola si allarga invece di andare a capo (`fit`).
- Tavole CAD con oltre 25.000 tracciati: non si elencano; clic su un tratto / riquadro = `pdf_hit` (cache dei disegni per
  file+pagina in memoria): 0,5 s sulla tavola da 64.830 tracciati, modifica del colore ~4 s.
- Collaudo: `python tests/test_pdfeditor.py [cartella_pdf_reali]` (50 prove sintetiche + per ogni PDF reale lettura,
  modifiche, immagini con maschera). Interfaccia provata con PDF reali (relazioni, tavole CAD, scansione OCR, moduli) in
  Edge senza finestra via DevTools; schermate prima/dopo nella cartella della sessione.

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
- Collaudo su Mac (24-25/10/2026): guida e lista delle prove in `COLLAUDO_MAC.md`. Log dell'app impacchettata aperta dal
  Finder: ~/Library/Logs/MBVisual.log (app.py). Artefatti del workflow: MBVisual-mac-dmg, MBVisual-mac-zip (riserva), avvio-log.
- nwd2mbv per Mac NON compila ancora con Apple clang 16 (Xcode 16.2): std::jthread risolto con -fexperimental-library,
  ma manca std::from_chars per i double (nwd-reader src/protein_schema.cpp). Strada: LLVM di Homebrew con la sua libc++
  collegata statica, oppure ripiego a strtod in una copia locale. Nel workflow il passo e' continue-on-error.
- Unione con main 1.5.9 (22/10/2026): una sola base di codice per Windows e Mac; workflow Build Mac anche da main.
  Parti nuove rese indipendenti da Windows: `app.py` (guilib "cocoa" sul Mac: prima forzava edgechromium e sarebbe finito
  nel ripiego del browser), stampa con CUPS (`mbvisual/stampa_cups.py`: lpstat, lpoptions -l, lp con media e copie; GDI e
  DEVMODE solo Windows), `winsign`/`windialog`/`stampa` importabili ovunque (`mbvisual/wintypes_compat.py`), finestre
  Apri/Salva/Cartella del Finder con osascript (solo per il ripiego nel browser: la finestra pywebview usa NSOpenPanel),
  segreti (token cloud, password TSA) con Fernet e chiave nel Portachiavi (`mbvisual/secret.py`, comando security),
  shellint spento fuori da Windows, lingua del Mac da `defaults read -g AppleLanguages`, cartelle dati da DATA_DIR.
  Interfaccia: TOOLS.mac (api/tools) nasconde "Integrazione con Windows", "Sposta in Applicazioni", Cmd vale come Ctrl
  (app.js, fase di cattura). Firma sul Mac: solo .p12 e CSC (smart card del Portachiavi da fare).
- Prove automatiche sul runner: `tests/mac_smoke.py` (impronta, caratteri, stampanti CUPS, OCR Vision, conversioni, file
  di esempio aperti in WebKit con Playwright; schermate e esito nell'artefatto prove-mac e nel riassunto del job).
  L'app impacchettata con la licenza obbligatoria risponde 402 alle API dei file: per questo i file si provano da sorgente.

## Recupero dei file danneggiati e sconosciuti (22/10/2026) - FATTO
Motore `mbvisual/recover.py` (+ `recover_zip.py`, `recover_sqlite.py`), API unica `api/recover?op=check|identify|start|carve|text|
as_ext|save|put|out`, schermata `ui/js/viewers/recover.js` + `ui/css/recover.css` (viewer "recover"). Solo app per PC (la web app
resta con l'errore semplice ed esadecimale). Testi: chiavi `rec.*` e `srv_recover.*` (5 lingue).
- Quando compare: (1) all'apertura `check` (letture veloci: %%EOF/startxref dei PDF, indice finale degli ZIP e testzip < 25 MB,
  fine di JPEG/PNG/GIF e PIL < 40 MB, atomi MP4/MOV, intestazione e quick_check SQLite < 50 MB, intestazione DWG, contenitore
  .msg) -> se danneggiato si apre "recover" con "Apri comunque l'originale"; (2) il visualizzatore lancia un errore: `showError`
  di app.js chiama `showRecovery`; (3) estensione non in elenco: "recover" in modo "unknown" al posto dell'esadecimale (che resta a
  un clic); (4) "Apri come -> Recupero e analisi" per qualsiasi file.
- Recupero (lavoro in background, copie in %TEMP%\MBVisual\recupero\<sha1 percorso|dimensione|data>; l'originale si legge soltanto,
  `save` rifiuta la destinazione = originale e le sorgenti fuori dalla cartella di recupero):
  PDF = PyMuPDF (ricostruisce l'xref) poi, se non trova pagine, `_pdf_rebuild` (oggetti "N G obj..endobj" sparsi, nuovo albero
  delle pagine e catalogo). pikepdf NON e' installato. ZIP/Office/OpenDocument = intestazioni locali una per una (deflate si
  ferma da solo: funziona anche con i data descriptor), XML troncati ricostruiti con lxml recover=True, [Content_Types].xml/_rels
  ricostruiti se mancano, relazioni/Override verso parti perse tolte, manifest ODF e mimetype in testa. Immagini = Pillow con
  LOAD_TRUNCATED_IMAGES (stima della parte leggibile solo se il file e' davvero troncato); intestazione rotta -> immagini
  incorporate. Audio/video = FFmpeg -err_detect ignore_err -fflags +genpts+discardcorrupt+igndts (-ignore_editlist solo MP4: con
  MKV FFmpeg rifiuta l'opzione), prima copia dei flussi in MKV poi ricodifica H.264/AAC; MP4 senza moov: non recuperabile, spiegato.
  SQLite = `.recover` di sqlite3.exe se c'e' (bin/sqlite o PATH, oggi NO) altrimenti lettore interno delle pagine (B-tree da
  sqlite_master, overflow, righe orfane in lost_and_found come .recover). Email = .eml riletto con compat32 e base64 tollerante,
  .msg con olefile per flussi (__substg1.0_*) o, se il contenitore e' illeggibile, testo UTF-16 + allegati ritagliati; il
  risultato e' un .eml ricostruito. DWG = anteprima incorporata (indirizzo a 0x0D, BMP/PNG) + copie .bak/.sv$ (cartella del
  disegno e TEMP) copiate come .dwg; il disegno lo rilegge la pagina con libredwg chiamando `dwg_read_file` senza fermarsi agli
  errori (anche con il file allungato di zeri) e lo salva in DXF con cad_save.
- Sconosciuti: `identify` (circa 100 firme: documenti, immagini, audio/video, archivi, CAD/3D, database, programmi, font,
  certificati, testi XML/JSON/CSV/email...) -> "Aprilo come X" = copia con l'estensione giusta in recupero\<chiave>\come (oltre
  1,5 GB si apre l'originale col visualizzatore forzato). `carve` = JPEG, PNG, GIF, BMP, PDF, ZIP (tipo Office riconosciuto),
  RIFF, GZIP, 7z, SQLite, RTF dentro qualsiasi file (primo GB). `text` = testo leggibile in un .txt aperto nell'editor.
- Collaudo: `python tools/make_damaged_samples.py [--dwg disegno.dwg]` -> `tests/samples/danneggiati` (attese in ATTESI.json;
  i disegno_troncato* da un DWG reale sono in .gitignore) poi `python tests/test_recover.py` (97 prove: ogni copia recuperata si
  riapre con PyMuPDF/python-docx/openpyxl/python-pptx/Pillow/sqlite3/email/FFmpeg, originali invariati). Il .msg di prova e'
  scritto da un piccolo scrittore CFB nello script (nessuna libreria lo crea).

## Converti in disegno: PDF e scansioni -> DXF/DWG (22/10/2026) - FATTO
Comando "Converti in disegno" nella barra del visualizzatore PDF e delle immagini, File -> "Converti in disegno (DXF)...", palette
dei comandi, "Salva con nome" -> DXF/DWG (apre la stessa finestra con il nome scelto) e operazione "drawing" della conversione a lotti.
Solo app per PC. Il risultato si apre subito nell'editor CAD. DWG solo con ODA File Converter (`cadedit._to_dwg`).
- `mbvisual/todrawing.py` = ingresso unico (info, page_png, preview, convert; API `api/drawing?op=info|page|preview|convert`),
  formato neutro delle entita' (in testa al file: unita' della sorgente con y in alto), scrittore DXF (`Writer`: layer, colori
  ACI/true color, spessori, tipi di linea MBV_<hash> dai tratteggi, stili TrueType, HATCH, MTEXT), scala: `scale` = 1:N,
  `ref_mm` + `ref_len` = quota nota (distanza misurata in mm della CARTA, cosi' vale per PDF e pixel), unita' mm/cm/m.
  Pagine affiancate nel modello (riquadro sul layer CONTORNO-PAGINA, non stampabile) o `layout: sheets` = anche un layout per
  pagina con la carta e una VIEWPORT in scala sulla sua parte di modello.
- `mbvisual/pdfvec.py` (PyMuPDF get_drawings + get_texttrace): Bezier -> arco se il cerchio per estremi e punto medio regge a
  t=1/8..7/8 E le tangenti negli estremi sono perpendicolari al raggio; archi consecutivi con lo stesso centro uniti, chiusi a 360
  = CIRCLE; polilinee di >= 5 segmenti uguali con curvatura costante -> archi (`_arcs_from_lines`); il resto spline (bezier_to_bspline).
  Layer: OCG del PDF (campo "layer"), altrimenti "C<RRGGBB>-<mm>" per colore e spessore; testi sul layer TESTI, testi invisibili
  (render mode 3: OCR, SHX di AutoCAD) su TESTI-NASCOSTI spento. Altezza TEXT = altezza delle maiuscole (OS/2 sCapHeight con
  fontTools, 0,716 se manca), fattore di larghezza misurato, carattere di Windows piu' simile (`publisher._font_file`).
  Righe allineate e con interlinea regolare -> MTEXT. Riempimenti bianchi ignorati (maschere). Insidia: le linee orizzontali/
  verticali hanno un Rect vuoto e `Rect.intersects` da' False (prima sparivano).
- `mbvisual/rastervec.py` (solo numpy + Pillow; NIENTE OpenCV/potrace): sfondo uniformato, Otsu, inversione automatica,
  raddrizzamento (proiezioni dei punti neri, +-6 gradi; `Image.rotate(+ang)`), macchie e buchi tolti con le componenti connesse
  per corse (`components`), OCR di Windows (`pdfedit._ocr_png`, max 10000 px per lato) anche ruotato di 90 gradi; una parola vale
  se l'inchiostro estraneo nel suo riquadro (pixel veri, non riquadri delle componenti) e' sotto il 25%. "Linee d'asse" = Zhang-Suen
  a ondate sui soli pixel di bordo + scaletta tolta con tabella, catene tra nodi, incroci uniti nel baricentro, rametti tolti;
  "Solo contorni" = crack following (anelli densificati prima del cerchio). Poi Douglas-Peucker, archi/cerchi ai minimi quadrati
  (scarto <= max(1,5 tol, min(1,5% r, 2,5 tol)), freccia >= 2,5 px), archi dello stesso cerchio riuniti (>= 300 gradi = cerchio:
  pilastri attraversati dagli assi), linee quasi H/V raddrizzate, segmenti allineati riuniti attraverso gli incroci.
- Interfaccia `ui/js/todrawing.js` + `ui/css/todrawing.css`: opzioni a sinistra, anteprima sovrapposta (Sovrapposti / Solo disegno /
  Originale; rotella = zoom, trascina = sposta, doppio clic = adatta), scale trovate nel testo della tavola ("SCALA 1:100") come
  pulsanti, "Indica due punti" con aggancio agli estremi, avviso fisso "Risultato approssimato" per le scansioni. Testi `todrawing.*`,
  `srv_drawing.*` (5 lingue; anche i nomi dei layer creati). app.js: `addDrawingButton`, `toDrawing`, `canToDrawing`.
- Collaudo: `python tests/test_todrawing.py [--keep cartella]` (61 prove: DXF noto -> PDF di ezdxf 1:100 con OCG -> DXF entro
  0,05 mm di carta, archi con angoli, bulge, layer, spessori, quota nota, fogli con VIEWPORT 1:100; testi PyMuPDF con rotazioni,
  MTEXT, tratteggi, HATCH; scansione sintetica con rumore, macchie, rotazione 1,5 gradi, OCR, contorni, PDF scansionato).
  NB ezdxf arrotonda la pagina ai punti interi e scala il disegno: nel collaudo il foglio e' 25400 x 17780 mm (720 x 504 pt).
  Campioni realistici (pianta A3 1:100 vettoriale + "scansione" TIFF storta): `python tools/make_todrawing_samples.py <cartella>`
  (non nel repo: il TIFF pesa 15 MB). Tempi: PDF immediato, scansione A3 300 dpi ~17 s con OCR.
- Da provare con le tavole vere dell'utente (AutoCAD/Revit, scansioni A1/A0): PDF con testi SHX (tratti + testo nascosto),
  archi spezzati in segmenti, retini a tratteggio (restano linee), scansioni a colori/cianografie, testi inclinati (l'OCR di Windows
  legge solo orizzontale e verticale).
## Posta elettronica in stile Outlook (22/10/2026) - FATTO (tappe 1-4; account veri da provare con l'utente)
Scheda "Posta" (pulsante busta nella barra laterale, `MB.openMail()`; percorso virtuale `mail://posta`, i messaggi nuovi
`mail://scrivi/<n>` con il visualizzatore `mailcompose`). Solo app per PC. Guida utente: `ui/guide/posta.md`.
- Motore `mbvisual/mail/` (API unica `api/mail?op=...` -> `mail/api.py handle`; errori MailError/ValueError = `{ok:false}`):
  `vault.py` chiave AES-256 in posta/chiave.bin protetta DPAPI, blob AES-GCM (MBV1+nonce+zlib); `store.py` indice SQLite IN
  MEMORIA salvato cifrato in posta/indice.bin 3 s dopo le modifiche (serialize/deserialize; FTS5 subject/people/body/atts) +
  messaggi completi cifrati in posta/msg/<aa>/<sha256>.bin; `accounts.py` account.json (senza segreti) + segreti.bin, preset
  PEC (Aruba, Legalmail, Namirial, Postecert/Postecertifica, Register, Actalis, Libero, TIM) e caselle comuni, autoconfig
  (preset -> autoconfig del dominio -> ISPDB Thunderbird -> MX con nslookup -> Autodiscover POX -> nomi tipici);
  `imapc.py` imaplib (+XOAUTH2, UTF-7 modificato, parser FETCH, MOVE/COPYUID/APPENDUID, ruoli SPECIAL-USE o dai nomi);
  `compose.py` MIME (immagini data: -> cid, inviti text/calendar come alternativa) e SMTP; `parse.py` riepilogo/lettura,
  PEC (X-Ricevuta, X-Trasporto, X-Riferimento-Message-ID, daticert.xml, postacert.eml anche in busta S/MIME opaca);
  `engine.py` un thread per account + pianificatore, operazioni in coda (tabella ops: flags/move/expunge/append/cartelle)
  applicate subito in locale e sul server quando c'e' rete, posta in uscita con invio programmato, conversazioni
  (References/In-Reply-To, poi oggetto normalizzato entro 60 giorni), stato PEC del messaggio inviato (`pec_status`:
  accettazione, consegne/errori per destinatario certificato, esterni) salvato in messages.pec_state; `ver` cambia solo
  con i dati (lo stato degli account no); `rules.py` regole + commessa automatica se certa; `commesse.py` archiviazione in
  <cartella>/<sottocartella "Posta">/<data ora> <oggetto>/ (.eml + allegati; PEC con daticert e "Ricevute PEC");
  `bigfile.py` invii grandi come link (OneDrive createLink anonimo 30 gg -> organizzazione, Drive permesso anyone, Dropbox
  shared link: aggiunto sharing.write agli ambiti di cloud.py); `ical.py` + `calapi.py` risposte agli inviti (REPLY
  all'organizzatore + evento nel calendario dell'account).
- Interfaccia `ui/js/mail/`: `mailapp.js` (cartelle/preferiti/PEC/commesse/account, elenco virtuale a righe da 74 px con
  conversazioni espandibili, filtri, ricerca con operatori, menu, trascinamento su cartelle e commesse, notifiche e
  promemoria, tasti di Outlook con `keymap`), `mailread.js` (iframe sandbox allow-same-origin senza script + CSP che
  blocca le immagini remote; proxy `op=img`; cid -> `op=part`; avviso link ingannevoli; PEC; inviti; allegati in anteprima
  con `MB.mountPreview` = stesso visualizzatore delle schede montato in un riquadro), `compose.js`, `mailsettings.js`,
  `mailicons.js`, `ui/css/mail.css`. In app.js: `openMail`, `mountPreview`, `closeTab` in window.MB, scheda mail:// senza file.
  Le appendici con figli opzionali usano `ap()` (DOM append scriverebbe "null").
- Testi: chiavi `mail.*` e `srv_mail.*` nelle 5 lingue.
- Prove: `python tests/test_mail.py` (73 prove, archivio in cartella temporanea, server di prova `tests/mailserver.py` IMAP+SMTP
  con gestore PEC simulato `tests/pecsim.py`: buste e ricevute firmate S/MIME, daticert); interfaccia: `python tests/mail_demo.py`
  (stampa l'indirizzo; account mario@studio.prova.it e studio@pec.prova.it, password "prova").
- Microsoft 365 / Outlook.com e Gmail (tappa 2): `oauth.py` (PKCE con l'ascoltatore di cloud.py, ID applicazione di cloud.config:
  "onedrive" per Microsoft, "gdrive" con segreto per Google; ambiti Mail.ReadWrite/Mail.Send/Calendars/Contacts e
  https://mail.google.com/ + calendar + contacts; token per account in segreti["oauth"], rinnovo automatico; refresh
  rifiutato = MailError auth -> "Accedi di nuovo" nelle impostazioni dell'account). `graphmail.py` GraphProvider: cartelle
  (+childFolders, ruoli dalle well-known), delta per cartella (folders.delta), elenco da intestazioni sintetiche, MIME da
  /$value, flags/categorie/completamento con PATCH (op "local" per categorie), move (nuovo id), DELETE, bozze e APPEND con
  POST /me/messages MIME, invio /me/sendMail MIME (<3,5 MB) o bozza JSON + upload session + /send. Gmail = IMAP/SMTP
  XOAUTH2 (salva_inviati false: la copia locale in Inviata si aggancia a quella del server per Message-ID).
  Collaudo `python tests/test_mail_oauth.py` (25 prove: finto OAuth, finto Graph per la posta, server di prova con XOAUTH2).
- Calendario e contatti (tappa 3): `calsync.py` CalDAV/CardDAV (scoperta current-user-principal -> *-home-set -> collezioni,
  solo calendari con VEVENT; REPORT calendar-query in una finestra -120/+400 giorni, ctag per saltare i calendari fermi; PUT
  con If-Match / If-None-Match, DELETE; vCard riscritte conservando le proprieta' non gestite; Google = stesso codice con
  il token OAuth: principal .../caldav/v2/<email>/user e rubrica .../carddav/v1/principals/<email>/lists/default/),
  Microsoft Graph (calendars + calendarView = occorrenze gia' espanse, rrule "occ"; eventi POST/PATCH/DELETE: gli inviti li
  manda Exchange; contatti /me/contacts), calendario e rubrica locali (href "locale" / "locale-rubrica"). Giro ogni 10 min
  (dopo la posta) o subito dopo una modifica. Eventi con partecipanti: invito METHOD:REQUEST spedito dall'account
  (CANCEL quando si eliminano); risposte agli inviti ricevuti: REPLY o, con Microsoft 365, accept/tentativelyAccept/decline.
  `calapi.upcoming` = avvisi 15 min prima (status "eventi"). Interfaccia `mailcal.js` (giorno, settimana lavorativa,
  settimana, mese, agenda, mini calendario, calendari con colori; ricorrenze CalDAV espanse con pim.parseCalendar) e
  `mailpeople.js` (rubrica, scheda dal vCard con pim.parseVcards, Scrivi, messaggi recenti), stili `ui/css/mailcal.css`.
  core.js `el`: le chiavi di style che iniziano con "--" ora usano setProperty (prima le variabili CSS si perdevano).
  Collaudo `python tests/test_mail_cal.py` (22 prove, server `tests/davserver.py`) + calendario/contatti Graph in
  test_mail_oauth.py (30 prove).
- Rifiniture (tappa 4): `ui/js/mail/mailbadge.js` avviato da app.js all'avvio (solo PC): il motore della posta parte subito,
  contatore dei da leggere sul pulsante Posta, avvisi di messaggi nuovi/promemoria/eventi quando la scheda Posta non e' aperta
  (la scheda aperta consuma lei i "nuovi"). Conferme di lettura: barra "Invia conferma" (op `mdn`, multipart/report RFC 8098,
  msgid ricordati in settings "mdn_inviati"). File .eml PEC aperti dal disco (viewers/email.js + misc.read_email): si
  mostra postacert.eml con i dati del gestore o l'esito della ricevuta. Campioni `python tools/make_pec_samples.py` ->
  tests/samples/pec. Collaudo `python tests/test_mail_bigfile.py` (8 prove: link OneDrive anonimo/organizzazione, Dropbox, MDN).
- Aggiungi account in un passo (23/10/2026, richiesta dell'utente "semplice e intuitivo, anche la posta aziendale"):
  `ui/js/mail/mailadd.js` (finestra a una colonna: solo indirizzo + Continua; poi password, accesso nel browser, "Fatto";
  le vecchie schede sono `manualAccount` in mailsettings.js dietro "Impostazioni manuali") + `mbvisual/mail/wizard.py`
  (`detect`: preset PEC -> password; gmail/googlemail o MX/autoconfig Google -> "google"; outlook/hotmail/live o MX
  outlook.com / server office365 -> "microsoft"; senza ID applicazione si ripiega su IMAP con password e nota;
  `quick_add`: prova IMAP (anche nome utente senza dominio) e SMTP, salva, nome dalla parte prima della @, errori con
  codice password / password_google (link myaccount.google.com/apppasswords + 3 passi) / password_microsoft / rete / server).
  API `w_detect`, `w_add` (lavori), `oauth_cancel`. Testi `mail.w_*`. Prove in test_mail_oauth.py (40).
- Da provare con l'utente: account veri (registrazioni in ui/guide/posta.md cap. 6), firma degli allegati con il suo
  dispositivo, invii come link con il suo OneDrive/Dropbox (per Dropbox rifare l'accesso: nuovo ambito sharing.write).

## Tablet e iPad (22/10/2026) - FATTO (prova su iPad/Android veri: la fa l'utente)
Web app (app per cellulari sul server delle licenze) finalizzata per tablet 768-1366 px, verticale e orizzontale.
- `ui/js/touch.js` (avviato da app.js `initTouch`, `afterMount` dopo ogni visualizzatore) + `ui/css/touch.css` (caricato solo con
  schermo tattile). Classi su <html>: `touch` (dito = puntatore principale; un portatile touch con mouse NON la prende), `ipad`
  (iPadOS si presenta come Mac: si riconosce da maxTouchPoints), `standalone` (app installata: aree sicure), `kb-open`.
  Bersagli di almeno 40 px (cmd, schede, barra laterale, menu 46 px, editor Photoshop/GIS/confronto); scorciatoie nascoste
  senza tastiera; body `touch-action: pan-x pan-y` (niente zoom della pagina: il pizzico lo gestiscono i documenti).
  Pannelli a scomparsa: `.side`, `.gis`, `.cmp-root` diventano `.drawer` (pulsante `.drawer-btn` nella barra): in verticale o
  sotto 1100 px il pannello scorre sopra il documento (chiuso all'avvio), in orizzontale resta affiancato e si chiude.
  NB: il pannello in assoluto esce dalla griglia, quindi la griglia passa a una colonna sola. Telefono (lato corto < 600 px):
  nessun cassetto, resta la disposizione di app.css. Tastiera virtuale: `--app-h`/`--kb` da visualViewport + viewport
  `interactive-widget=resizes-content`. Tocco lungo = `contextmenu` sintetico (Safari non lo manda; con quello nativo di
  Android non si duplica). `pinchPan(el, {onStart,onPan,onZoom})`: pizzico e due dita sui canvas (cad2d, imgedit, cadcmp, pdfcmp);
  il secondo dito annulla l'operazione del primo. Three.js (OrbitControls) e OpenLayers gestiscono il tocco da soli.
- Penna `ui/js/ink.js` + `ui/css/ink.css` (barra in basso al centro): penna con pressione, evidenziatore, gomma a tratti,
  colori, 3 spessori, annulla/ripeti, "dito disegna" (si spegne da solo al primo uso della penna = rifiuto del palmo, ricordato
  in localStorage `mbv-ink-penna`), contatti larghi ignorati, tasto laterale S Pen / coda gomma = gomma, doppio tocco della punta =
  strumento precedente (il doppio tocco sul corpo dell'Apple Pencil NON arriva alle web app). Le dita le gestisce sempre l'app
  (`nativeTouch: false`): con lo scorrimento nativo Chrome annulla i tratti della penna (pointercancel).
  * PDF (solo web app, pulsante Penna): livello per pagina dentro i `.page` di pdf.js; Salva -> `ui/js/inkpdf.js` aggiunge
    annotazioni /Ink con /InkList e aspetto /AP (spessore variabile, evidenziatore in Multiply) con pdf-lib, poi il PDF si
    ricarica. I byte di pdf.js vengono dall'iframe: per pdf-lib vanno copiati in un Uint8Array del documento principale.
  * DWG/DXF (pulsante Penna dove non c'e' l'editor CAD, cioe' nella web app): `ui/js/inkdxf.js` aggiunge in fondo a ENTITIES
    LWPOLYLINE con larghezza per vertice su layer MARKUP e MARKUP-EVID (trasparenza 440, colore vero 420 + ACI), layer nella
    tabella, maniglie da $HANDSEED; R12 -> POLYLINE/VERTEX; il resto del file resta identico (righe dei codici comprese).
    DWG: "Salva con nome" DXF = file a parte con le sole revisioni nelle stesse coordinate. PNG/PDF/SVG includono i tratti.
    cad2d.js ora disegna le larghezze delle polilinee (40/41/43) e la trasparenza (440); dxf.js le legge.
  * Immagini (imgedit, anche sul PC): "Fine" mette i tratti in un livello "Annotazioni N"; il pennello usa la pressione
    della penna; con la penna in uso il dito sposta la vista.
- Installazione iPad/iPhone: build_web.py genera apple-touch-icon 152/167/180 (quadrate piene) e le schermate di avvio
  `img/splash-WxH.png` per 9 iPad e 9 iPhone (verticale e orizzontale); stesso elenco `SPLASH` in server/src/index.js, perche'
  l'app si installa spesso dalle pagine di attivazione (`APPLE_HEAD` in LINK_PAGE e ACTIVATION_PAGE; immagini in PUBLIC).
  Pagine di attivazione: iPad riconosciuto (istruzioni con il Condividi in alto a destra, nome dispositivo "iPad"/"Tablet Android").
  L'app installata su iPad ha cookie separati da Safari come su iPhone: chiede la chiave o il codice di 6 cifre.
- Prove (Edge senza finestra + DevTools: emulazione tocco/UA, penna con `Input.dispatchMouseEvent pointerType:"pen" force`,
  dita con `Input.dispatchTouchEvent`), iPad Pro 12,9" 1024x1366, iPad 10,9" 820x1180, Android 1280x800 nei due versi:
  nessun elemento fuori schermo; bersagli sotto 40 px solo i colori sovrapposti di Photoshop e l'attribuzione OSM.
  DXF salvati validati con ezdxf (audit 0 errori), PDF con PyMuPDF (annotazioni Ink lette e disegnate). Testi: chiavi
  `ink.*`, `touch.*` nelle 5 lingue. Collaudi dalla console: `MB.active.api._ink` (PDF).

## Pratiche edilizie - TOLTE (25/10/2026)
Modulo eliminato su richiesta dell'utente ("non serve a nulla"): edilizia.py, viewers/pratica.js, modelli .mbm, formato .mbcomm,
componente "pratiche", pulsante della barra laterale e chiavi pratiche.*/srv_edilizia.*. Si recupera dalla cronologia git se servisse.

## Misure ed estrazioni di quantita' (22/10/2026) - FATTO (da provare sui file veri dell'utente)
Pannello "Misure" UNICO per PDF, disegni CAD (DWG/DXF), fogli DWF/DWFx e modelli 3D/BIM (stile Bluebeam Revu Measurements /
Quantity Takeoff). Pulsante "Misure" nella barra di ogni visualizzatore; moduli in `ui/js/measure/`, stile `ui/css/measure.css`.
- `mcore.js` (puro, senza DOM): geometria (aree con fori per parita' di annidamento, Newell 3D, angoli, cerchio per 3 punti 2D/3D),
  scale `{page, box, k = unita' reali per unita' del disegno, unit, label}` (riquadro che contiene il primo punto > pagina >
  documento > base), `ratioScale(N, unit, paperM)` / `calibrate`, `parseScales` (testi del cartiglio), quantita' `compute`/`row`
  (unita' mostrate, importo = prezzo x quantita' principale), `groupRows` (si sommano solo le quantita' PRINCIPALI: il perimetro
  di un'area non e' una lunghezza), CSV, `.mbmis` (`serialize` con 12 cifre significative: arrotondare a 1e-6 sbagliava le scale
  PDF), mesh (`meshQuantities` volume/superficie, `planarFace`, `sectionSegments`/`sectionArea`, `gridVolume` nuvole, `hull2`).
- `mtool.js` motore degli strumenti 2D (anche 3D: i punti agganciati hanno `s.p` con z) su "superfici" fornite dal visualizzatore
  (toScreen/toWorld/snap/pick/similar): lunghezza, polilinea, perimetro, area, foro, volume (area x altezza), angolo, raggio, quota
  di livello (riferimento ±0,00 in `doc.ref`), conteggio con simboli, taratura, riquadro con scala propria, oggetto con un clic,
  simboli uguali; Maiusc ortogonale, Alt senza aggancio, Invio/doppio clic/destro finiscono, Backspace toglie l'ultimo punto,
  selezione e trascinamento dei vertici, Canc. Aggancio 2D = `cadgeom.osnap` (stesso indice di cad2d: `snapModel`).
- `mpanel.js` sessione + pannello (schede Misure / Estrazioni / Scala o Unita'): voci con colore (tavolozza automatica) e prezzo,
  layer, note, raggruppamento, totali, Excel (Riepilogo + Misure + ultima estrazione) e CSV. Estrazioni: record con quantita' in
  unita' del disegno (`real: true` = gia' reali, 3D) aggregati con la scala della pagina/riquadro; "Aggiungi all'elenco" = righe `ext`.
- `mextract.js` (puro): CAD lunghezze per layer/colore/tipo linea/tipo entita' (quote escluse, blocchi esplosi), aree di polilinee
  chiuse/cerchi/retini con fori, blocchi con lo stesso nome anche annidati (esclusi quelli delle quote e gli anonimi), testi e quote
  (DIMENSION senza codice 42: valore dai punti di definizione); tracciati vettoriali (DWF, PDF) lunghezze/aree per stile e layer,
  simboli uguali (firma dei segmenti normalizzati, anche ruotati di 90 gradi), `vecPick` (un clic dentro un foro prende il foro).
- cad2d.js `build` ora restituisce anche `closed` (polilinee chiuse, cerchi), `hatches` (contorni dei retini), `inserts` (blocchi con
  profondita') e su ogni elemento `c` (colore) e `lt` (tipo linea). `mcad.js` = adattatori CAD (`attachCad`, unita' da $INSUNITS,
  computo mostrato in metri per i disegni in mm) e DWF (`attachDwf`, scale dai riquadri del DWF per foglio). Misure nel file
  `<nome>.mbmis` accanto al disegno/modello (salvataggio automatico; nella web app = scaricamento).
- PDF (`mpdf.js`, solo app per PC): uno strato canvas per pagina di pdf.js (`.mbm-layer`, eventi solo con uno strumento attivo; gli
  strumenti dell'editor PDF e quelli di misura si escludono). Motore `mbvisual/measure.py` (API unica `api/measure?op=`): pdf_page
  (tracciati nello spazio PDF, cerchi riconosciuti dalle 4 Bezier), pdf_scales (/VP /Measure di Acrobat/Bluebeam + "Scala 1:N"
  nei testi, proposta all'apertura del pannello), pdf_texts (quote e livelli), pdf_tables (testo delle celle letto con il ritaglio:
  extract() riordinava "20,00" in "2000 ,"), pdf_lines (per pagina, regione e stile; layer = contenuto opzionale), pdf_symbols /
  pdf_similar, pdf_read / pdf_strip / pdf_write. Salva (Ctrl+S, "Salva nel PDF" = MB.save) scrive nel file salvato: Line /
  PolyLine / Polygon con /IT ...Dimension e /Measure (1 pt = k unita'), etichette FreeText legate con /IRT /RT /Group, fori come
  poligoni bianchi, /VP "MB Visual ..." per pagina e riquadro, allegato `misure.mbmis` con tutti i dati. Aprendo il pannello su un
  PDF con misure di MB Visual la copia di lavoro si ricrea senza quelle annotazioni (le disegna lo strato); misure di altri
  programmi con /Measure si importano. Insidie PyMuPDF 2.0: `embfile_upd` non accetta bytes (si cancella e si riaggiunge),
  cancellando un'annotazione spariscono anche le sue /IRT (si cancella per xref con load_annot).
- 3D (`m3d.js`, ponte = bcfHost di model3d.js con `pickHook` e `measureActive`): punti sulla superficie con aggancio a vertici,
  medi degli spigoli, centri delle facce piane, punti delle nuvole; strumenti Faccia (area piana), Elemento (volume se la mesh e'
  chiusa, superficie, ingombro), Sezione (piano attivo o orizzontale nel punto). Estrazioni: quantita' per elemento per classe /
  materiale (IfcRelAssociatesMaterial) / livello (qtocore.levelMap(...).levelOf) / elemento, sezione con area, nuvola di punti
  (punti caricati, impronta, volume sopra la quota piu' bassa). IFC: quota di livello = Z del progetto (ref = coordMatrix[13]).
- Testi: chiavi `mis.*` e `srv_measure.*` (5 lingue). Collaudo: `python tools/make_measure_samples.py` (tests/samples/misure: PDF
  A3 1:100 con dettaglio /VP 1:20, DXF in mm, IFC con materiali e piani, valori in attesi.json) poi `node tests/test_measure.mjs`
  (57 prove: nucleo, DXF con il modello vero di cad2d, IFC con web-ifc, tracciati) e `python tests/test_measure.py` (32 prove:
  scale, aggancio, lunghezze/aree/simboli/tabelle/testi, scrittura e rilettura nel PDF). Provato nell'app (Edge senza finestra via
  DevTools): PDF, DXF, DWF (blocks_and_tables.dwf) e IFC con valori esatti. Prove dalla console: `(await MB.active.api._meas.get()).M`.
- Immagini (`mimg.js`, scansioni e foto di tavole): strato sopra la vista dell'editor di immagini (`measureHost` di imgedit.js:
  zoom/spostamento in sola lettura + `onPaint`), riceve il mouse solo con uno strumento attivo; senza taratura = millimetri di
  stampa ai dpi del file (96 se mancano), scala 1:N dai dpi, taratura, riquadri. Nessun aggancio (immagine raster).
- DA FARE / limiti: nei DWF i caratteri disegnati come tracciati
  finiscono tra i "simboli uguali"; volumi solo per mesh chiuse; nessuna prova con PDF da 60.000 tracciati (l'aggancio si ferma a
  300.000 segmenti per pagina, i simboli oltre 25.000 tracciati).
- 1.6.1 (23/10/2026) pubblicata: setup Windows + MBVisual-1.6.1-mac.dmg nella release v1.6.1 di MB-Visual-Rilasci,
  Windows anche in "App per PC". Il .dmg si prende dall'artefatto MBVisual-mac-dmg della build Mac (gh run download,
  a volte si interrompe: ripetere).
- DIFETTO GRAVE corretto nella 1.6.1: dalla 1.5.7 `from webview import guilib` in app.py dava None (in pywebview e' una
  variabile fino a start()), quindi l'app partiva SEMPRE nel ripiego in Edge (avvio.log in %LOCALAPPDATA%\MBVisual):
  icona a parte nella barra delle applicazioni, finestra di Edge che restava aperta durante l'aggiornamento e seconda
  finestra dopo. Ora `from webview.guilib import initialize`; all'avvio si chiudono le finestre di Edge del profilo
  MBVisual\edge-app rimaste dalle versioni vecchie. Controllo rapido: nessuna riga nuova "uso Edge" in avvio.log.
- Icona: app.ico con il logo completo in tutti i formati 16-256 (tools/make_logo.py icon_frame); la versione "solo mb"
  sotto i 32 px non piaceva all'utente. update.repair_shortcuts rinfresca la cache delle icone (ie4uinit -show) a ogni build.

## Statistiche d'uso anonime con consenso (23/10/2026) - FATTO e online
Base legale: consenso esplicito (GDPR art. 6.1.a + art. 122 Codice privacy). Richiesta dell'utente: "Si'" come scelta principale (pulsante
arancione con il fuoco) ma il consenso vale SOLO se cliccato (Esc/nessuna scelta = niente, si richiede al prossimo avvio). Nessuna domanda
nell'installabile (una casella gia' spuntata non e' un consenso valido). Solo app per PC/Mac (web app esclusa).
- App: `mbvisual/stats.py` (API `api/stats?op=stato|consenso|conta`, esente dal controllo licenza) + `ui/js/stats.js` (finestra alla prima
  apertura quando l'app e' libera, File > Impostazioni > Statistiche d'uso con l'identificativo visibile, informativa `stat.inf_*`).
  `app.py main` chiama `stats.on_launch()`. Stato in DATA_DIR/statistiche.json (consenso, inst = token_hex(16) nuovo a ogni consenso, giorni,
  da_cancellare); `MBV_STATISTICHE=<file>` per le prove; in sviluppo non si invia nulla senza `MBV_STAT_URL`. Thread: dopo 60 s e ogni 6 h manda
  i giorni CONCLUSI a POST /v1/stats e ripete /v1/stats/forget finche' il server conferma; giorni locali non inviati oltre 40 scartati.
- Conteggi: `track("ext", ext)` solo per estensioni del registro (altrimenti "altro"), `track("fn", chiave)` (app.js: v.<visualizzatore>,
  stampa, salva, converti.<ext>, crea_nuovo, palette; altri moduli con `window.MBStat?.track`: conversione_lotti, firma, converti_disegno,
  misure, nav.clash|views|qto, bcf, editor_pdf, ricerca_progetto, realta_aumentata), `trackError(viewer, e, ext)` = "viewer|NomeErrore|ext"
  (mai il messaggio). MAI posta/PEC, cloud, Google (Limited Use), nomi file, percorsi. Chiavi nuove: rispettare le regex di stats.py e
  server/src/stats.js (altrimenti vengono scartate) e aggiungere l'etichetta in U_FN delle due Admin.
- Conservazione (scelta dell'utente): NESSUNA scadenza automatica; dati anonimi tenuti finche' servono, cancellati alla revoca (automatico) o
  su richiesta (`POST /admin/usage/forget {inst}`, campo "Cancellazione su richiesta" nella scheda Utilizzo). L'informativa dice esattamente
  questo: non scrivere scadenze che il codice non applica.
- Server: `server/src/stats.js` (tabella usage_days una riga per installazione e giorno, nessun IP; chiavi filtrate con regex; giorno
  rimandato = sostituito), `GET /admin/usage?giorni=N` -> scheda "Utilizzo" in admin/ui e server/adminapp (rigenerare adminui.js con
  tools/build_admin_mobile.py). Migrazione `server/migrations/005_statistiche.sql`.
- Pagine pubbliche `server/src/pages.js` (richieste per l'app OAuth di Google): https://mbvisual.mb-group.workers.dev/mbvisual (presentazione) e
  /privacy (informativa unica: licenza, statistiche, posta e cloud con la frase Limited Use di Google). Contatto: segnalazione dall'app +
  variabile SUPPORT_EMAIL di wrangler.toml se si aggiunge un indirizzo NEUTRO (mai quello col nome dell'utente). Bozza legale.
- Collaudo: `node server/test/harness.mjs` (statistiche, cancellazione su richiesta, pagine pubbliche), `python tests/test_stats.py` (22 prove).
- Informativa nell'app e /privacy = BOZZE da far rivedere a un consulente privacy (titolare: MB Workshop Srl).
