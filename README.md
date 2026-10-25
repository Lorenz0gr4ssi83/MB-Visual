# MB Desk

Visualizzatore e editor di documenti, disegni CAD, modelli 3D e BIM, firme digitali, immagini, audio/video e archivi, di MB Group.

## Web app (telefono, tablet, qualsiasi PC)
Aprire **https://mbvisual.mb-group.workers.dev** con Chrome, Edge o Safari e scegliere *Installa app* / *Aggiungi a schermata Home*.
I file aperti restano sul dispositivo: nessun invio a server. Sul telefono si possono anche condividere i file da altre app verso MB Desk.
Formati disponibili nella web app: pagina *Formati* dell'app (circa 530 estensioni).

## App per PC (Windows, tutti i formati)
Versione portatile senza installazione: estrarre `MB Desk - portatile.zip` (si crea con `python tools/build_portable.py`) e avviare `MBVisual.exe`.
Oltre 900 estensioni, comprese foto RAW, conversione di qualsiasi video, Office con LibreOffice, Navisworks tramite i modelli sorgente.

## Struttura
- `app.py`, `mbvisual/` - app per PC (Python + WebView2)
- `ui/` - interfaccia comune; `ui/js/webapi.js`, `cms.js`, `pptxweb.js` - motore della web app nel browser
- `docs/` - web app pubblicata da GitHub Pages (generata con `python tools/build_web.py`)
- `ELENCO_FORMATI.md` - elenco completo dei formati dell'app per PC
- `GUIDA.md` - guida d'uso
