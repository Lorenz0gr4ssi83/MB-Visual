# MB Visual - guida rapida

## Avvio
- **Versione portatile**: estrai `MB Visual - portatile.zip` (per esempio sul Desktop) e avvia `MB Visual\MBVisual.exe`. Non serve installare nulla.
- Puoi anche trascinare un file sopra `MBVisual.exe` per aprirlo subito.

## Aprire i file
- Trascina uno o piu' file nella finestra, oppure **Apri**: il menu offre *Nuovo file* (Ctrl+O), *Cartella di progetto* e l'elenco dei *Recenti*.
- **Esplora** apre a sinistra il pannello della cartella di progetto: un clic su un file lo apre, un clic su una cartella la apre.
- **Proprieta'** mostra i dati del file e la sua impronta SHA-256 (per verificare che un elaborato consegnato non sia stato modificato).
- Ogni file si apre in una scheda. Ctrl+Tab cambia scheda, Ctrl+W la chiude.
- **Apri come** apre il file corrente con un altro visualizzatore (testo, esadecimale, ecc.).
- **Formati** mostra l'elenco completo delle estensioni supportate, con la ricerca: scrivi l'estensione e l'app risponde Si o No.
- Qualsiasi file non in elenco si apre comunque come byte grezzi (editor esadecimale).

## Salvare
- **Salva** (Ctrl+S) scrive sul file originale quando il formato lo permette.
- **Salva con nome** (Ctrl+Maiusc+S) crea un nuovo file. Per Word, RAW, CAD e video il salvataggio crea sempre un nuovo file, cosi' l'originale non si perde.
- Prima di sovrascrivere, MB Visual tiene una copia di sicurezza in `%TEMP%\MBVisual\backup`.

## Cosa si puo' fare per tipo di file
| Tipo | Vista | Modifica |
|---|---|---|
| PDF | pagine, ricerca, firme PAdES | testo, disegno, evidenziatore, immagini, moduli; unisci, estrai, elimina, ruota, dividi, filigrana, timbro |
| p7m / p7s / tsd / m7m | firmatario, codice fiscale, validita', integrita' | estrazione del documento firmato |
| Word (docx) | impaginazione fedele | testo formattato, salva in DOCX |
| Excel / ODS / CSV | tutti i fogli | celle, formule, righe, colonne |
| PowerPoint (pptx) | diapositive | testi mantenendo la formattazione |
| DWG / DXF | layer, blocchi, testi, quote, misura | layer, esporta PNG/SVG/PDF, DXF come testo |
| STEP / IGES / BREP | 3D, albero parti, sezioni, misure | colori, visibilita', esporta STL/OBJ/GLB |
| IFC | 3D, classi BIM, proprieta' | come sopra |
| STL, OBJ, GLB, FBX, 3DS... | 3D | come sopra |
| Navisworks (nwd/nwc/nwf) | modello federato dai file IFC/STEP della stessa cartella; Navisworks Freedom se installato | - |
| Immagini (anche RAW, HEIC, PSD, TIFF) | zoom, EXIF | ruota, ritaglia, ridimensiona, regolazioni, disegno, testo |
| Audio / video (qualsiasi) | lettore, forma d'onda | taglio, rotazione, audio, fotogrammi, conversione |
| ZIP, RAR, 7Z, ISO... | contenuto, apertura file interni | aggiungi, elimina, rinomina, estrai |
| Email (eml, msg, mbox) | messaggio e allegati | salva allegati, esporta corpo |
| Testo e codice | editor Monaco (VS Code) | completa |
| SQLite | tabelle, SQL | celle, righe, SQL |

## Navigazione 3D
- Selettore **Ruota / Sposta** nella barra: decide cosa fa il tasto sinistro del mouse.
- Tieni premuto **Maiusc** per passare temporaneamente all'altra modalita'. Il tasto destro sposta sempre, la rotella fa lo zoom.
- **Aggiungi modello** carica altri file nella stessa scena (modello federato, per esempio architettonico + strutturale).

## Programmi opzionali
Se presenti sul PC vengono usati in automatico (nella pagina Formati vedi se sono stati trovati):
- **LibreOffice** (gratuito): doc, ppt, odt, rtf, vsd, pub e altri formati Office meno comuni.
- **Autodesk Navisworks Freedom** (gratuito): nwd, nwc, nwf.
- **Autodesk DWG TrueView** (gratuito): apertura esterna dei DWG.

## Limiti noti
- Firme digitali: sono verificate l'integrita' del documento e la firma; la catena di fiducia verso l'elenco AgID e la revoca dei certificati non sono verificate (richiedono la rete).
- Word: in modifica le impaginazioni complesse (colonne, caselle di testo) vengono semplificate; il file si salva come nuovo.
- DWG: si visualizzano i disegni nello spazio modello; per modificare la geometria serve un CAD.
- Navisworks: formato chiuso, la geometria e' visibile solo nei programmi Autodesk.
