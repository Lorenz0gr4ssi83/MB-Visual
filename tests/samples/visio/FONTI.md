# File di prova Visio - fonti

File pubblici e gratuiti usati per collaudare l'editor di diagrammi (ui/js/vsd*.js). Non sono usati dall'app.

- `poi_*` - Apache POI, cartella `test-data/diagram` (https://github.com/apache/poi), licenza Apache 2.0.
- `vx_*` - libreria Python vsdx di Dave Howard, cartella `tests` (https://github.com/dave-howard/vsdx), licenza BSD-3-Clause.

Durante lo sviluppo sono stati provati anche (non inclusi qui) i file di prova di libvisio
(https://github.com/LibreOffice/libvisio, `src/test/data`, MPL 2.0) per temi, varianti di colore e stili rapidi.

Collaudo strutturale di un .vsdx salvato: `python tests/check_vsdx.py file.vsdx`.
