# MB Visual - elenco completo dei formati

**1004 estensioni** in 44 categorie si aprono con un visualizzatore dedicato.
Questo elenco e' generato automaticamente dallo stesso registro (`ui/formats.json`) che l'app usa per decidere come aprire un file:
**se un'estensione non compare qui, il file si apre solo come byte grezzi nell'editor esadecimale.**

Nell'app lo stesso elenco e' consultabile dal pulsante **Formati**, con la ricerca per estensione.

## PDF (1)

- **Visualizza:** Pagine, miniature, ricerca testo, zoom, stampa, firme digitali PAdES (informazioni firmatario)
- **Modifica:** Testo libero, disegno a mano, evidenziatore, immagini/timbri, compilazione moduli; salvataggio nel PDF

`.pdf`

## Firmati digitalmente (CAdES / PKCS#7) (6)

- **Visualizza:** Dati firmatario (nome, codice fiscale, ente certificatore, validita'), verifica integrita' firma, apertura del documento contenuto nel visualizzatore adatto (anche firme multiple annidate)
- **Modifica:** Estrazione del documento originale; il documento estratto si modifica col suo editor (la modifica invalida la firma: si salva come nuovo file)

`.m7m` `.p7c` `.p7m` `.p7s` `.spc` `.tsd`

## Documenti Word (4)

- **Visualizza:** Impaginazione fedele (testo, tabelle, immagini, intestazioni)
- **Modifica:** Editor testo formattato (grassetto, corsivo, titoli, elenchi, tabelle); salvataggio in DOCX

`.docm` `.docx` `.dotm` `.dotx`

## Fogli di calcolo (22)

- **Visualizza:** Tutti i fogli, celle, formule (valori calcolati)
- **Modifica:** Modifica celle e formule, aggiunta/rimozione righe e colonne; salvataggio nel formato originale (o XLSX)

`.csv` `.dbf` `.dif` `.et` `.fods` `.numbers` `.ods` `.prn` `.qpw` `.slk` `.sylk` `.tsv` `.wk1` `.wk3` `.wks` `.xls` `.xlsb` `.xlsm` `.xlsx` `.xlt` `.xltm` `.xltx`

## Presentazioni PowerPoint (6)

- **Visualizza:** Diapositive con testi, immagini e forme
- **Modifica:** Modifica dei testi delle diapositive mantenendo la formattazione; salvataggio in PPTX

`.potm` `.potx` `.ppsm` `.ppsx` `.pptm` `.pptx`

## Pubblicazioni (Publisher) (2)

- **Visualizza:** Pagine impaginate con caselle di testo collegate, immagini, forme, tabelle, WordArt e pagine master
- **Modifica:** Editor in stile Publisher (MBPUB modificabile, esportazione PDF/PNG/JPG); i .pub di Publisher si importano (impaginazione completa con Publisher installato, altrimenti testo e immagini)

`.mbpub` `.pub`

## Diagrammi (Visio) (5)

- **Visualizza:** Pagine con forme, connettori, testi, stili e temi, immagini (anche EMF), livelli, pagine di sfondo, dati delle forme; elenco pagine, zoom, ricerca nel testo e nei dati
- **Modifica:** Editor in stile Visio: sposta/ridimensiona/ruota, testo sul posto, forme base e di flusso, connettori dinamici incollati che seguono le forme, gruppi, ordine, allineamento, livelli, dati forma, pagine; salvataggio nel VSDX (apribile in Visio), esportazione PDF/SVG/PNG. I .vsd binari: modificabili con Visio installato (conversione), altrimenti anteprima e testi

`.vsd` `.vsdm` `.vsdx` `.vstm` `.vstx`

## Altri documenti Office e OpenDocument (34)

> Richiede **LibreOffice** (gratuito) installato sul PC: https://www.libreoffice.org/download/download/

- **Visualizza:** Conversione in PDF e visualizzazione completa
- **Modifica:** Esportazione in PDF / DOCX / XLSX / PPTX, poi modifica con il rispettivo editor

`.602` `.abw` `.cdr` `.doc` `.dot` `.fodg` `.fodp` `.fodt` `.hwp` `.key` `.lwp` `.mml` `.odf` `.odg` `.odp` `.odt` `.otg` `.otp` `.ott` `.oxps` `.pages` `.pot` `.pps` `.ppt` `.rtf` `.sxc` `.sxd` `.sxi` `.sxw` `.wpd` `.wps` `.wpt` `.wri` `.zabw`

## Testo e codice sorgente (332)

- **Visualizza:** Editor professionale (Monaco, lo stesso di VS Code) con colorazione sintassi, ricerca, mappa
- **Modifica:** Modifica completa, trova/sostituisci, salvataggio mantenendo la codifica

`.abap` `.ada` `.adb` `.adoc` `.ads` `.aes` `.ahk` `.apt` `.asc` `.asciidoc` `.ascx` `.asm` `.asp` `.aspx` `.ass` `.atom` `.au3` `.awk` `.azcli` `.babelrc` `.bas` `.bash` `.bat` `.bib` `.bicep` `.bowerrc` `.bst` `.c` `.cake` `.cc` `.cfg` `.cjs` `.clj` `.cljc` `.cljs` `.cls` `.cmake` `.cmd` `.cnc` `.coffee` `.conf` `.config` `.containerfile` `.cpp` `.cpy` `.cs` `.csh` `.cshtml` `.csp` `.csproj` `.css` `.csx` `.ctp` `.cts` `.cue` `.cui` `.cxx` `.cyp` `.cypher` `.dart` `.dat` `.dats` `.dax` `.dcl` `.desktop` `.diff` `.diz` `.dockerfile` `.dpr` `.dtd` `.ecl` `.editorconfig` `.edn` `.elm` `.env` `.erb` `.erl` `.es6` `.eslintrc` `.ex` `.exs` `.f` `.f03` `.f90` `.f95` `.fish` `.flow` `.for` `.frm` `.fs` `.fsi` `.fsscript` `.fsx` `.ftl` `.ftlh` `.ftlx` `.gcode` `.gemspec` `.geojson` `.gitattributes` `.gitconfig` `.gitignore` `.gitmodules` `.gml` `.go` `.gpx` `.gql` `.gradle` `.graphql` `.groovy` `.gyp` `.gypi` `.h` `.handlebars` `.har` `.hats` `.hbs` `.hcl` `.hh` `.hpp` `.hrl` `.hs` `.htaccess` `.hxx` `.i3` `.iecplc` `.iecst` `.ig` `.inf` `.ini` `.ino` `.ipynb` `.iso` `.jade` `.jav` `.java` `.jl` `.js` `.jscsrc` `.jshintrc` `.jshtm` `.json` `.json5` `.jsonc` `.jsonl` `.jsp` `.jsx` `.key` `.kml` `.ksh` `.kt` `.kts` `.las` `.latex` `.lc3lib` `.ldif` `.less` `.lex` `.ligo` `.lin` `.liquid` `.lock` `.log` `.lpr` `.lrc` `.lsp` `.lua` `.m` `.m3` `.m3u` `.m3u8` `.mak` `.makefile` `.manifest` `.mdoc` `.mdtext` `.mdtxt` `.mdwn` `.mediawiki` `.mg` `.mjs` `.mk` `.mkdn` `.ml` `.mli` `.mligo` `.mm` `.mnu` `.mod` `.mpf` `.msdax` `.nasm` `.nc` `.ndjson` `.nfo` `.ngc` `.nix` `.nmake` `.npmrc` `.nuspec` `.nvmrc` `.opf` `.org` `.p` `.pas` `.pat` `.patch` `.pgp` `.php` `.php4` `.php5` `.phtml` `.pl` `.pla` `.plist` `.pls` `.plsql` `.pm` `.pod` `.pp` `.pq` `.pqm` `.prc` `.prettierrc` `.properties` `.props` `.proto` `.ps1` `.psd1` `.psm1` `.psql` `.pub` `.pug` `.py` `.pyi` `.pyw` `.qs` `.r` `.rb` `.rbx` `.redis` `.reg` `.resx` `.rhistory` `.rjs` `.rkt` `.rlib` `.rmd` `.rprofile` `.rpy` `.rq` `.rs` `.rss` `.rst` `.rt` `.s` `.sass` `.sats` `.sb` `.sbt` `.sbv` `.sc` `.scala` `.sch` `.scm` `.scr` `.scss` `.sed` `.service` `.sh` `.shx` `.sig` `.sln` `.sol` `.spf` `.sql` `.srt` `.ss` `.ssa` `.st` `.sty` `.styl` `.sub` `.sum` `.sv` `.svelte` `.svh` `.swift` `.tap` `.targets` `.tcdut` `.tcgvl` `.tcio` `.tcl` `.tcpou` `.tex` `.text` `.textile` `.tf` `.tfvars` `.thrift` `.toml` `.topojson` `.ts` `.tsp` `.tsx` `.twig` `.txt` `.v` `.vb` `.vbproj` `.vbs` `.vcxproj` `.vh` `.vhd` `.vhdl` `.vtt` `.vue` `.wgsl` `.wiki` `.wxi` `.wxl` `.wxs` `.xaml` `.xml` `.xsd` `.xsl` `.xslt` `.xspf` `.yaml` `.yml` `.zsh`

## Markdown (5)

- **Visualizza:** Anteprima formattata affiancata al testo
- **Modifica:** Modifica con anteprima in tempo reale

`.markdown` `.md` `.mdown` `.mdx` `.mkd`

## Pagine web (7)

- **Visualizza:** Anteprima della pagina (isolata, senza accesso alla rete) e sorgente
- **Modifica:** Modifica del sorgente con anteprima aggiornata

`.htm` `.html` `.mht` `.mhtml` `.shtml` `.svgz` `.xhtml`

## Immagini (70)

- **Visualizza:** Zoom, adatta, pixel reali, informazioni (dimensioni, EXIF)
- **Modifica:** Editor in stile Photoshop: livelli (opacita', metodi di fusione, maschere, regolazioni), strumenti di selezione, pittura, timbro clone, sfumatura, testo e forme, regolazioni (livelli, curve, tonalita'/saturazione, bilanciamento colore...), filtri, trasformazione libera, ritaglio, dimensione immagine e quadro; salvataggio in PSD e ORA con i livelli o in PNG/JPG/WEBP/TIFF/BMP/GIF

`.apng` `.avif` `.avifs` `.blp` `.bmp` `.bw` `.cur` `.dcx` `.dds` `.dib` `.emf` `.fit` `.fits` `.flc` `.fli` `.fpx` `.ftc` `.fts` `.ftu` `.gbr` `.gif` `.heic` `.heics` `.heif` `.heifs` `.hif` `.icb` `.icns` `.ico` `.im` `.j2c` `.j2k` `.jfif` `.jp2` `.jpc` `.jpe` `.jpeg` `.jpf` `.jpg` `.jpx` `.mic` `.mpo` `.msp` `.ora` `.pbm` `.pcx` `.pfm` `.pgm` `.pjp` `.pjpeg` `.png` `.pnm` `.ppm` `.psd` `.pxr` `.qoi` `.ras` `.rgb` `.rgba` `.sgi` `.spi` `.tga` `.tif` `.tiff` `.vda` `.vst` `.webp` `.wmf` `.xbm` `.xpm`

## Foto RAW delle fotocamere (31)

- **Visualizza:** Sviluppo RAW con bilanciamento automatico, zoom, informazioni
- **Modifica:** Tutte le modifiche immagini; salvataggio come JPG/PNG/TIFF (il RAW originale non si sovrascrive)

`.3fr` `.arw` `.bay` `.cap` `.cr2` `.cr3` `.crw` `.dcr` `.dng` `.eip` `.erf` `.fff` `.iiq` `.kdc` `.mef` `.mos` `.mrw` `.nef` `.nrw` `.orf` `.pef` `.ptx` `.raf` `.raw` `.rw2` `.rwl` `.rwz` `.sr2` `.srf` `.srw` `.x3f`

## Grafica vettoriale SVG (1)

- **Visualizza:** Disegno vettoriale con zoom illimitato
- **Modifica:** Modifica del codice SVG con anteprima; esportazione in PNG

`.svg`

## Progetti di montaggio video (1)

- **Visualizza:** Montaggio in stile Premiere Pro: monitor sorgente e programma, timeline multitraccia con miniature e forme d'onda, anteprima in tempo reale
- **Modifica:** Taglio, rasoio, ripple, rullo, slittamento, velocita', tracce video e audio sovrapposte, effetti colore/sfocatura/chiave colore/LUT, movimento e opacita' con fotogrammi chiave, metodi di fusione, titoli, transizioni, volume con fotogrammi chiave, normalizzazione, stabilizzazione; esportazione MP4 H.264/H.265, WebM, MOV ProRes, MP3/WAV con FFmpeg

`.mbvid`

## Video (103)

- **Visualizza:** Riproduzione con barra, velocita', fotogrammi, schermo intero, tracce audio. I formati non nativi vengono convertiti automaticamente
- **Modifica:** Taglio inizio/fine, rotazione, rimozione audio, estrazione audio, cattura fotogramma, conversione in MP4/WEBM/MKV/AVI/MOV/GIF

`.264` `.265` `.266` `.3g2` `.3gp` `.amv` `.asf` `.av1` `.avc` `.avi` `.avs2` `.avs3` `.bik` `.bmv` `.cdg` `.cdxl` `.dav` `.dif` `.divx` `.drc` `.dv` `.dvr-ms` `.evc` `.evo` `.f4v` `.flv` `.gifv` `.gxf` `.h261` `.h264` `.h265` `.h266` `.h26l` `.hevc` `.ifv` `.imx` `.ipu` `.ism` `.isma` `.ismv` `.ivf` `.ivr` `.kux` `.lvf` `.m1v` `.m2t` `.m2ts` `.m2v` `.m4v` `.mj2` `.mjpeg` `.mjpg` `.mk3d` `.mkv` `.mod` `.moflex` `.mov` `.mp2v` `.mp4` `.mpe` `.mpeg` `.mpg` `.mpv` `.mts` `.mvi` `.mxf` `.mxg` `.nsv` `.nut` `.obu` `.ogm` `.ogv` `.qt` `.rcv` `.rm` `.rmvb` `.roq` `.ser` `.smk` `.str` `.swf` `.tod` `.tp` `.trp` `.ts` `.ty` `.ty+` `.usm` `.vc1` `.viv` `.vob` `.vp8` `.vp9` `.vro` `.vvc` `.webm` `.wmv` `.wtv` `.xmv` `.xvid` `.y4m` `.yop` `.yuv`

## Audio (178)

- **Visualizza:** Riproduzione con forma d'onda, velocita', volume. I formati non nativi vengono convertiti automaticamente
- **Modifica:** Taglio inizio/fine, volume, conversione in MP3/WAV/FLAC/OGG/M4A/OPUS

`.302` `.3ga` `.669` `.722` `.8svx` `.aa` `.aa3` `.aac` `.ac3` `.ac4` `.acm` `.adp` `.adts` `.adx` `.aea` `.afc` `.aif` `.aifc` `.aiff` `.aix` `.al` `.alaw` `.amr` `.ams` `.apc` `.ape` `.aptx` `.aptxhd` `.ast` `.at3` `.au` `.avr` `.awb` `.ay` `.bcstm` `.bfstm` `.binka` `.bonk` `.brstm` `.bwf` `.c2` `.caf` `.daud` `.dbm` `.dff` `.dfpwm` `.digi` `.dmf` `.dsf` `.dsm` `.dss` `.dtk` `.dts` `.dtshd` `.eac3` `.ec3` `.fap` `.far` `.flac` `.fsb` `.fwse` `.g722` `.g723_1` `.g729` `.gdm` `.genh` `.gsm` `.gym` `.hca` `.iamf` `.iff` `.imf` `.ircam` `.it` `.j2b` `.kar` `.lc3` `.m15` `.m2a` `.m4a` `.m4b` `.m4r` `.mac` `.mca` `.mdl` `.med` `.mid` `.midi` `.mka` `.mlp` `.mo3` `.mod` `.mods` `.mp+` `.mp2` `.mp3` `.mpa` `.mpc` `.mpp` `.mptm` `.msbc` `.msf` `.mt2` `.mtaf` `.mtm` `.musx` `.nist` `.nsf` `.nsp` `.oga` `.ogg` `.okt` `.oma` `.opus` `.osq` `.paf` `.pcm` `.plm` `.psm` `.pt36` `.ptm` `.qcp` `.qoa` `.ra` `.ram` `.rf64` `.rka` `.rsd` `.rso` `.s16le` `.s3m` `.sbc` `.sd2` `.sds` `.sf` `.shn` `.sln` `.snd` `.son` `.spc` `.sph` `.spx` `.ss2` `.st26` `.stk` `.stm` `.svag` `.svx` `.sw` `.tak` `.thd` `.truehd` `.tta` `.ub` `.ul` `.ulaw` `.ult` `.umx` `.uw` `.vag` `.vgm` `.voc` `.vpk` `.vqe` `.vqf` `.vql` `.w64` `.wav` `.wave` `.wma` `.wow` `.wsd` `.wv` `.xa` `.xm` `.xmd` `.xpk` `.xvag`

## Disegni CAD 2D (AutoCAD) (4)

- **Visualizza:** Disegno vettoriale con zoom/pan, layer, blocchi, quote, testi, misura distanze
- **Modifica:** Accensione/spegnimento layer, esportazione SVG/PNG/PDF; per DXF modifica diretta del contenuto testuale. Apertura in DWG TrueView se presente

`.dwg` `.dwt` `.dxb` `.dxf`

## Pubblicazioni Autodesk DWF / DWFx e documenti XPS (4)

- **Visualizza:** Elenco dei fogli con miniature, fogli 2D vettoriali (W2D e XPS) con zoom/pan, layer, testi e ricerca, proprieta' degli oggetti (AutoCAD, Revit, Inventor), marcature di revisione, misure di distanza e area in unita' del disegno, modelli 3D W3D nel visualizzatore 3D
- **Modifica:** Esportazione in PDF vettoriale (tutti i fogli), SVG e PNG del foglio aperto

`.dwf` `.dwfx` `.w2d` `.xps`

## Modelli CAD 3D (STEP, IGES, BREP) (8)

- **Visualizza:** Modello 3D navigabile (rotazione, pan, zoom), albero delle parti, nascondi/isola parti, sezioni, misure, vista filo di ferro
- **Modifica:** Colori e visibilita' delle parti, esportazione in STL / OBJ / GLB

`.brep` `.brp` `.iges` `.igs` `.p21` `.step` `.stp` `.stpz`

## Modelli 3D e BIM (24)

- **Visualizza:** Modello 3D navigabile (rotazione, pan, zoom), albero oggetti, nascondi/isola, sezioni, misure, animazioni (dove presenti), proprieta' BIM per IFC
- **Modifica:** Colori, visibilita', trasformazioni, esportazione in STL / OBJ / GLB

`.3dm` `.3ds` `.3mf` `.amf` `.bvh` `.dae` `.fbx` `.glb` `.gltf` `.ifc` `.kmz` `.lwo` `.md2` `.obj` `.pcd` `.pdb` `.ply` `.stl` `.usdz` `.vox` `.vrml` `.vtk` `.vtp` `.wrl`

## SketchUp (1)

- **Visualizza:** Modello 3D senza SketchUp installato (lettore OpenSKP): geometria con materiali, colori e texture, spigoli, gruppi e componenti ad albero con nomi e attributi, tag accendibili, scene salvate come viste. Provato con file da SketchUp 8 a 2026; alcuni file 2013-2020 e i modelli molto grandi (oltre circa 50 MB) possono non aprirsi
- **Modifica:** Visibilita', colori, sezioni e misure; Salva con nome in STEP, IFC, GLB/glTF, OBJ, STL, 3MF, DXF 3D, PLY, VRML, USDZ

`.skp`

## Nuvole di punti (laser scanner, LiDAR) (6)

- **Visualizza:** Nuvole anche di centinaia di milioni di punti lette a blocchi con livelli di dettaglio e cache su disco; colori RGB, intensita', quota o classificazione; dimensione dei punti e dettaglio regolabili; misure con aggancio al punto (distanza, in pianta, dislivello); sezione; coordinate del punto; insieme a IFC e altri modelli 3D (modello federato, coordinate allineate)
- **Modifica:** Salva con nome in LAS, LAZ, E57, PLY, PTS, XYZ (tutti i punti o solo la parte visibile della sezione); classi nascondibili

`.e57` `.las` `.laz` `.pts` `.ptx` `.xyz`

## Segnalazioni BIM (BCF) (2)

- **Visualizza:** Segnalazioni BCF 2.0 / 2.1 / 3.0 (Revit, Navisworks, Solibri, BIMcollab, Archicad, Tekla): elenco con filtri, istantanee, commenti, punti di vista; sovrapposizione al modello IFC con ripristino di camera, elementi selezionati e visibili, colori e sezioni
- **Modifica:** Nuove segnalazioni dal visualizzatore 3D (titolo, descrizione, tipo, stato, priorita', assegnatario, scadenza, commenti, punto di vista e istantanea); salvataggio in .bcfzip BCF 2.1 o 3.0; report PDF ed Excel

`.bcf` `.bcfzip`

## Formati 3D di visualizzazione (JT, U3D) (2)

- **Visualizza:** JT (ISO 14306, versioni 8-10): assieme, parti, istanze, colori, proprieta' e metadati, geometria tassellata al livello di dettaglio piu' fine; U3D (ECMA-363), anche estratti dai PDF 3D (i modelli PRC dei PDF vengono elencati ma non ancora letti). Navigazione, albero, sezioni, misure come gli altri modelli 3D
- **Modifica:** Colori e visibilita' delle parti, esportazione in STL / OBJ / GLB. B-rep (Parasolid XT, JT B-rep), PMI e texture non vengono letti

`.jt` `.u3d`

## Autodesk Inventor (parti e assiemi) (2)

- **Visualizza:** Modello 3D senza Inventor: il solido ShapeManager della parte convertito in STEP (piani, cilindri, coni, sfere, tori, superfici e curve B-spline), assiemi composti con le posizioni e i colori dei componenti (anche sottoassiemi), albero dei componenti, iProperties (codice, descrizione, materiale, autore, revisione) e anteprima
- **Modifica:** Visibilita' e colori dei componenti, misure, sezioni; esportazione in STEP / IFC / GLB / STL / OBJ

`.iam` `.ipt`

## Autodesk Inventor (tavole e presentazioni) (2)

- **Visualizza:** Anteprima salvata nel file, iProperties ed elenco dei modelli collegati (si aprono con un clic nel visualizzatore 3D)
- **Modifica:** Sola lettura

`.idw` `.ipn`

## Navisworks (3)

> Richiede **Autodesk Navisworks Freedom** (gratuito) installato sul PC: https://www.autodesk.com/viewers

- **Visualizza:** Formato proprietario Autodesk: si apre in Autodesk Navisworks Freedom (installato su questo PC) con un clic; in MB Visual: informazioni file e byte grezzi
- **Modifica:** Non modificabile fuori da Navisworks Manage/Simulate

`.nwc` `.nwd` `.nwf`

## SolidWorks, Solid Edge e Parasolid (19)

- **Visualizza:** Senza i programmi originali: anteprima incorporata, proprieta' (anche personalizzate e per configurazione), materiale, configurazioni, componenti degli assiemi e delle tavole; modello 3D esatto letto dal Parasolid contenuto nel file (assiemi SolidWorks composti dai file delle parti)
- **Modifica:** Esportazione in STEP esatto (B-rep), GLB, STL, OBJ, IFC; le tavole mostrano anteprima e proprieta'

`.asm` `.asmdot` `.dft` `.drwdot` `.p_b` `.p_t` `.par` `.prtdot` `.psm` `.pwd` `.sldasm` `.slddrw` `.sldprt` `.x_b` `.x_t` `.xmp_bin` `.xmp_txt` `.xmt_bin` `.xmt_txt`

## Archivi compressi e immagini disco (79)

> Richiede **7-Zip** (gratuito) installato sul PC: https://www.7-zip.org/

- **Visualizza:** Contenuto ad albero; ogni file interno si apre direttamente in MB Visual
- **Modifica:** Aggiunta (anche con trascinamento), eliminazione e rinomina di file per ZIP/7Z/TAR/WIM/JAR; estrazione di tutto o di singoli file per tutti

`.001` `.7z` `.a` `.aab` `.apk` `.appx` `.appxbundle` `.ar` `.arj` `.bz2` `.bzip2` `.cab` `.cb7` `.cbr` `.cbz` `.chi` `.chm` `.cpio` `.cramfs` `.deb` `.dmg` `.ear` `.egg` `.esd` `.gz` `.gzip` `.hfs` `.hfsx` `.img` `.ipa` `.iso` `.jar` `.kmz` `.lha` `.lib` `.lit` `.lzh` `.lzma` `.lzma86` `.msi` `.msix` `.msp` `.msu` `.nsis` `.nupkg` `.ova` `.pkg` `.ppkg` `.qcow` `.qcow2` `.r00` `.rar` `.rpm` `.squashfs` `.swm` `.tar` `.taz` `.tbz` `.tbz2` `.tgz` `.tpz` `.txz` `.udf` `.vdi` `.vhd` `.vmdk` `.vsix` `.war` `.whl` `.wim` `.xapk` `.xar` `.xip` `.xpi` `.xz` `.z` `.z01` `.zip` `.zipx`

## Email (5)

- **Visualizza:** Mittente, destinatari, data, corpo HTML/testo, allegati apribili direttamente in MB Visual
- **Modifica:** Estrazione e salvataggio degli allegati; il corpo si puo' esportare in HTML/TXT

`.eml` `.emlx` `.mbox` `.mbx` `.msg`

## eBook (1)

- **Visualizza:** Lettura a pagine con indice
- **Modifica:** Nessuna modifica (sola lettura)

`.epub`

## Caratteri (font) (6)

- **Visualizza:** Anteprima a piu' dimensioni, testo di prova personalizzabile, tutti i glifi, informazioni
- **Modifica:** Nessuna modifica (sola lettura)

`.otc` `.otf` `.ttc` `.ttf` `.woff` `.woff2`

## Database SQLite (9)

- **Visualizza:** Tabelle, viste, struttura, ricerca, query SQL
- **Modifica:** Modifica celle, inserimento/eliminazione righe, esecuzione SQL; salvataggio diretto

`.db` `.db3` `.gpkg` `.mbtiles` `.s3db` `.sdb` `.sl3` `.sqlite` `.sqlite3`

## Dati geografici (GIS) (10)

- **Visualizza:** Mappa con sfondo OpenStreetMap o ortofoto (servizi con chiave o WMS), riproiezione dei sistemi italiani (WGS84, ETRS89/RDN2008 UTM 32-33N, Gauss-Boaga Monte Mario, ED50) da .prj/EPSG, livelli con stile ed etichette, tabella attributi con ricerca e selezione collegata alla mappa, misura di distanze e aree, coordinate del cursore, valori dei raster
- **Modifica:** Salvataggio dei livelli in GeoJSON, KML/KMZ, GPX e shapefile (ZIP) con scelta del sistema di riferimento; vista in PNG, JPG e PDF

`.geojson` `.gpkg` `.gpx` `.kml` `.kmz` `.shp` `.tif` `.tiff` `.topojson` `.zip`

## Immagini mediche DICOM (2)

- **Visualizza:** Serie della cartella (o DICOMDIR) con scorrimento tra le sezioni e riproduzione, finestra/livello con preimpostazioni TC, inversione, zoom, misure di distanza e angolo, ROI con media/deviazione/area, valore del pixel (HU), tag DICOM in tabella con ricerca; anche compressi JPEG, JPEG lossless, JPEG-LS, JPEG 2000, RLE e multi-fotogramma
- **Modifica:** Esportazione della sezione attuale o di tutte le sezioni in PNG/JPG (con le misure) e dei tag in CSV

`.dcm` `.dicom`

## Calendari iCalendar (5)

- **Visualizza:** Eventi in elenco con ricerca e in vista mese (anche eventi ripetuti, giornate intere, promemoria, partecipanti, attivita')
- **Modifica:** Esportazione in PDF, CSV ed Excel

`.ical` `.icalendar` `.ics` `.ifb` `.vcs`

## Contatti vCard (2)

- **Visualizza:** Schede dei contatti con foto, telefoni, email, indirizzi, azienda, note; ricerca (vCard 2.1, 3.0 e 4.0, anche piu' contatti per file)
- **Modifica:** Esportazione in CSV ed Excel

`.vcard` `.vcf`

## Certificati digitali (9)

- **Visualizza:** Soggetto, emittente, validita', numero di serie, impronte SHA-1/SHA-256, chiave pubblica, usi della chiave, estensioni, catena di certificazione con verifica delle firme tra i certificati; PKCS#12 (.p12/.pfx) con password usata solo per la lettura e mai conservata; richieste di certificato (CSR) ed elenchi di revoca (CRL)
- **Modifica:** Esportazione dei soli dati pubblici: certificati in PEM, DER/CER, PKCS#7 (.p7b) e riepilogo in testo

`.cer` `.crl` `.crt` `.csr` `.der` `.p12` `.p7b` `.pem` `.pfx`

## Apple iWork (Pages, Numbers, Keynote) (3)

- **Visualizza:** Anteprima incorporata nel documento (pagina o PDF di anteprima), immagini contenute, testo del documento e tabelle (Numbers) letti dal file
- **Modifica:** Esportazione dell'anteprima in PDF/PNG, del testo in TXT e delle tabelle in CSV/Excel

`.key` `.numbers` `.pages`

## File di plotter HP-GL / HP-GL/2 (4)

- **Visualizza:** Disegno vettoriale con penne colorate e spessori, testi (LB), archi e cerchi, poligoni pieni; zoom, misura, accensione/spegnimento delle penne
- **Modifica:** Esportazione in PDF e SVG vettoriali e in PNG

`.hgl` `.hpg` `.hpgl` `.plt`

## Dati scientifici e tabellari (HDF5, NetCDF, Parquet, Arrow) (8)

- **Visualizza:** Struttura (gruppi, dataset, variabili, dimensioni, attributi, schema e metadati), anteprima dei dati a pagine con grafico per i valori numerici
- **Modifica:** Esportazione di tabelle, dataset e variabili in CSV ed Excel

`.arrow` `.feather` `.h5` `.hdf5` `.he5` `.nc` `.nc4` `.parquet`

## Autodesk Revit (4)

- **Visualizza:** Anteprima incorporata nel file e informazioni senza Revit: versione e build di Revit, file centrale/locale, condivisione, autore, percorso del modello centrale, identificativi; per le famiglie categoria, tipi e parametri dichiarati
- **Modifica:** Esportazione dell'anteprima in PNG e delle informazioni in TXT/JSON

`.rfa` `.rft` `.rte` `.rvt`

## Pratiche edilizie (MB Visual) (1)

- **Visualizza:** Anagrafica di commessa: committenti, immobile con dati catastali, tecnici, imprese, intervento; moduli generati e fascicolo
- **Modifica:** Finestra guidata dei dati (anche dalla visura catastale PDF), moduli unificati compilati (CILA, CILA-Superbonus, SCIA, SCIA alternativa, inizio e fine lavori, soggetti coinvolti, procura, delega, relazione tecnica, dichiarazione di conformita'), firma digitale, fascicolo PDF con indice e segnalibri

`.mbcomm`

## Qualsiasi altro file (byte grezzi)

- **Visualizza:** Editor esadecimale (anche file di molti GB), testo leggibile estratto, informazioni e tipo reale rilevato dal contenuto
- **Modifica:** Modifica dei byte e salvataggio

## Indice alfabetico

`.001` `.264` `.265` `.266` `.302` `.3dm` `.3ds` `.3fr` `.3g2` `.3ga` `.3gp` `.3mf` `.602` `.669` `.722` `.7z` `.8svx` `.a` `.aa` `.aa3` `.aab` `.aac` `.abap` `.abw` `.ac3` `.ac4` `.acm` `.ada` `.adb` `.adoc` `.adp` `.ads` `.adts` `.adx` `.aea` `.aes` `.afc` `.ahk` `.aif` `.aifc` `.aiff` `.aix` `.al` `.alaw` `.amf` `.amr` `.ams` `.amv` `.apc` `.ape` `.apk` `.apng` `.appx` `.appxbundle` `.apt` `.aptx` `.aptxhd` `.ar` `.arj` `.arrow` `.arw` `.asc` `.asciidoc` `.ascx` `.asf` `.asm` `.asmdot` `.asp` `.aspx` `.ass` `.ast` `.at3` `.atom` `.au` `.au3` `.av1` `.avc` `.avi` `.avif` `.avifs` `.avr` `.avs2` `.avs3` `.awb` `.awk` `.ay` `.azcli` `.babelrc` `.bas` `.bash` `.bat` `.bay` `.bcf` `.bcfzip` `.bcstm` `.bfstm` `.bib` `.bicep` `.bik` `.binka` `.blp` `.bmp` `.bmv` `.bonk` `.bowerrc` `.brep` `.brp` `.brstm` `.bst` `.bvh` `.bw` `.bwf` `.bz2` `.bzip2` `.c` `.c2` `.cab` `.caf` `.cake` `.cap` `.cb7` `.cbr` `.cbz` `.cc` `.cdg` `.cdr` `.cdxl` `.cer` `.cfg` `.chi` `.chm` `.cjs` `.clj` `.cljc` `.cljs` `.cls` `.cmake` `.cmd` `.cnc` `.coffee` `.conf` `.config` `.containerfile` `.cpio` `.cpp` `.cpy` `.cr2` `.cr3` `.cramfs` `.crl` `.crt` `.crw` `.cs` `.csh` `.cshtml` `.csp` `.csproj` `.csr` `.css` `.csv` `.csx` `.ctp` `.cts` `.cue` `.cui` `.cur` `.cxx` `.cyp` `.cypher` `.dae` `.dart` `.dat` `.dats` `.daud` `.dav` `.dax` `.db` `.db3` `.dbf` `.dbm` `.dcl` `.dcm` `.dcr` `.dcx` `.dds` `.deb` `.der` `.desktop` `.dff` `.dfpwm` `.dft` `.dib` `.dicom` `.dif` `.diff` `.digi` `.divx` `.diz` `.dmf` `.dmg` `.dng` `.doc` `.dockerfile` `.docm` `.docx` `.dot` `.dotm` `.dotx` `.dpr` `.drc` `.drwdot` `.dsf` `.dsm` `.dss` `.dtd` `.dtk` `.dts` `.dtshd` `.dv` `.dvr-ms` `.dwf` `.dwfx` `.dwg` `.dwt` `.dxb` `.dxf` `.e57` `.eac3` `.ear` `.ec3` `.ecl` `.editorconfig` `.edn` `.egg` `.eip` `.elm` `.emf` `.eml` `.emlx` `.env` `.epub` `.erb` `.erf` `.erl` `.es6` `.esd` `.eslintrc` `.et` `.evc` `.evo` `.ex` `.exs` `.f` `.f03` `.f4v` `.f90` `.f95` `.fap` `.far` `.fbx` `.feather` `.fff` `.fish` `.fit` `.fits` `.flac` `.flc` `.fli` `.flow` `.flv` `.fodg` `.fodp` `.fods` `.fodt` `.for` `.fpx` `.frm` `.fs` `.fsb` `.fsi` `.fsscript` `.fsx` `.ftc` `.ftl` `.ftlh` `.ftlx` `.fts` `.ftu` `.fwse` `.g722` `.g723_1` `.g729` `.gbr` `.gcode` `.gdm` `.gemspec` `.genh` `.geojson` `.gif` `.gifv` `.gitattributes` `.gitconfig` `.gitignore` `.gitmodules` `.glb` `.gltf` `.gml` `.go` `.gpkg` `.gpx` `.gql` `.gradle` `.graphql` `.groovy` `.gsm` `.gxf` `.gym` `.gyp` `.gypi` `.gz` `.gzip` `.h` `.h261` `.h264` `.h265` `.h266` `.h26l` `.h5` `.handlebars` `.har` `.hats` `.hbs` `.hca` `.hcl` `.hdf5` `.he5` `.heic` `.heics` `.heif` `.heifs` `.hevc` `.hfs` `.hfsx` `.hgl` `.hh` `.hif` `.hpg` `.hpgl` `.hpp` `.hrl` `.hs` `.htaccess` `.htm` `.html` `.hwp` `.hxx` `.i3` `.iam` `.iamf` `.ical` `.icalendar` `.icb` `.icns` `.ico` `.ics` `.idw` `.iecplc` `.iecst` `.ifb` `.ifc` `.iff` `.ifv` `.ig` `.iges` `.igs` `.iiq` `.im` `.imf` `.img` `.imx` `.inf` `.ini` `.ino` `.ipa` `.ipn` `.ipt` `.ipu` `.ipynb` `.ircam` `.ism` `.isma` `.ismv` `.iso` `.it` `.ivf` `.ivr` `.j2b` `.j2c` `.j2k` `.jade` `.jar` `.jav` `.java` `.jfif` `.jl` `.jp2` `.jpc` `.jpe` `.jpeg` `.jpf` `.jpg` `.jpx` `.js` `.jscsrc` `.jshintrc` `.jshtm` `.json` `.json5` `.jsonc` `.jsonl` `.jsp` `.jsx` `.jt` `.kar` `.kdc` `.key` `.kml` `.kmz` `.ksh` `.kt` `.kts` `.kux` `.las` `.latex` `.laz` `.lc3` `.lc3lib` `.ldif` `.less` `.lex` `.lha` `.lib` `.ligo` `.lin` `.liquid` `.lit` `.lock` `.log` `.lpr` `.lrc` `.lsp` `.lua` `.lvf` `.lwo` `.lwp` `.lzh` `.lzma` `.lzma86` `.m` `.m15` `.m1v` `.m2a` `.m2t` `.m2ts` `.m2v` `.m3` `.m3u` `.m3u8` `.m4a` `.m4b` `.m4r` `.m4v` `.m7m` `.mac` `.mak` `.makefile` `.manifest` `.markdown` `.mbcomm` `.mbox` `.mbpub` `.mbtiles` `.mbvid` `.mbx` `.mca` `.md` `.md2` `.mdl` `.mdoc` `.mdown` `.mdtext` `.mdtxt` `.mdwn` `.mdx` `.med` `.mediawiki` `.mef` `.mg` `.mht` `.mhtml` `.mic` `.mid` `.midi` `.mj2` `.mjpeg` `.mjpg` `.mjs` `.mk` `.mk3d` `.mka` `.mkd` `.mkdn` `.mkv` `.ml` `.mli` `.mligo` `.mlp` `.mm` `.mml` `.mnu` `.mo3` `.mod` `.mods` `.moflex` `.mos` `.mov` `.mp+` `.mp2` `.mp2v` `.mp3` `.mp4` `.mpa` `.mpc` `.mpe` `.mpeg` `.mpf` `.mpg` `.mpo` `.mpp` `.mptm` `.mpv` `.mrw` `.msbc` `.msdax` `.msf` `.msg` `.msi` `.msix` `.msp` `.msu` `.mt2` `.mtaf` `.mtm` `.mts` `.musx` `.mvi` `.mxf` `.mxg` `.nasm` `.nc` `.nc4` `.ndjson` `.nef` `.nfo` `.ngc` `.nist` `.nix` `.nmake` `.npmrc` `.nrw` `.nsf` `.nsis` `.nsp` `.nsv` `.numbers` `.nupkg` `.nuspec` `.nut` `.nvmrc` `.nwc` `.nwd` `.nwf` `.obj` `.obu` `.odf` `.odg` `.odp` `.ods` `.odt` `.oga` `.ogg` `.ogm` `.ogv` `.okt` `.oma` `.opf` `.opus` `.ora` `.orf` `.org` `.osq` `.otc` `.otf` `.otg` `.otp` `.ott` `.ova` `.oxps` `.p` `.p12` `.p21` `.p7b` `.p7c` `.p7m` `.p7s` `.p_b` `.p_t` `.paf` `.pages` `.par` `.parquet` `.pas` `.pat` `.patch` `.pbm` `.pcd` `.pcm` `.pcx` `.pdb` `.pdf` `.pef` `.pem` `.pfm` `.pfx` `.pgm` `.pgp` `.php` `.php4` `.php5` `.phtml` `.pjp` `.pjpeg` `.pkg` `.pl` `.pla` `.plist` `.plm` `.pls` `.plsql` `.plt` `.ply` `.pm` `.png` `.pnm` `.pod` `.pot` `.potm` `.potx` `.pp` `.ppkg` `.ppm` `.pps` `.ppsm` `.ppsx` `.ppt` `.pptm` `.pptx` `.pq` `.pqm` `.prc` `.prettierrc` `.prn` `.properties` `.props` `.proto` `.prtdot` `.ps1` `.psd` `.psd1` `.psm` `.psm1` `.psql` `.pt36` `.ptm` `.pts` `.ptx` `.pub` `.pug` `.pwd` `.pxr` `.py` `.pyi` `.pyw` `.qcow` `.qcow2` `.qcp` `.qoa` `.qoi` `.qpw` `.qs` `.qt` `.r` `.r00` `.ra` `.raf` `.ram` `.rar` `.ras` `.raw` `.rb` `.rbx` `.rcv` `.redis` `.reg` `.resx` `.rf64` `.rfa` `.rft` `.rgb` `.rgba` `.rhistory` `.rjs` `.rka` `.rkt` `.rlib` `.rm` `.rmd` `.rmvb` `.roq` `.rpm` `.rprofile` `.rpy` `.rq` `.rs` `.rsd` `.rso` `.rss` `.rst` `.rt` `.rte` `.rtf` `.rvt` `.rw2` `.rwl` `.rwz` `.s` `.s16le` `.s3db` `.s3m` `.sass` `.sats` `.sb` `.sbc` `.sbt` `.sbv` `.sc` `.scala` `.sch` `.scm` `.scr` `.scss` `.sd2` `.sdb` `.sds` `.sed` `.ser` `.service` `.sf` `.sgi` `.sh` `.shn` `.shp` `.shtml` `.shx` `.sig` `.skp` `.sl3` `.sldasm` `.slddrw` `.sldprt` `.slk` `.sln` `.smk` `.snd` `.sol` `.son` `.spc` `.spf` `.sph` `.spi` `.spx` `.sql` `.sqlite` `.sqlite3` `.squashfs` `.sr2` `.srf` `.srt` `.srw` `.ss` `.ss2` `.ssa` `.st` `.st26` `.step` `.stk` `.stl` `.stm` `.stp` `.stpz` `.str` `.sty` `.styl` `.sub` `.sum` `.sv` `.svag` `.svelte` `.svg` `.svgz` `.svh` `.svx` `.sw` `.swf` `.swift` `.swm` `.sxc` `.sxd` `.sxi` `.sxw` `.sylk` `.tak` `.tap` `.tar` `.targets` `.taz` `.tbz` `.tbz2` `.tcdut` `.tcgvl` `.tcio` `.tcl` `.tcpou` `.tex` `.text` `.textile` `.tf` `.tfvars` `.tga` `.tgz` `.thd` `.thrift` `.tif` `.tiff` `.tod` `.toml` `.topojson` `.tp` `.tpz` `.trp` `.truehd` `.ts` `.tsd` `.tsp` `.tsv` `.tsx` `.tta` `.ttc` `.ttf` `.twig` `.txt` `.txz` `.ty` `.ty+` `.u3d` `.ub` `.udf` `.ul` `.ulaw` `.ult` `.umx` `.usdz` `.usm` `.uw` `.v` `.vag` `.vb` `.vbproj` `.vbs` `.vc1` `.vcard` `.vcf` `.vcs` `.vcxproj` `.vda` `.vdi` `.vgm` `.vh` `.vhd` `.vhdl` `.viv` `.vmdk` `.vob` `.voc` `.vox` `.vp8` `.vp9` `.vpk` `.vqe` `.vqf` `.vql` `.vrml` `.vro` `.vsd` `.vsdm` `.vsdx` `.vsix` `.vst` `.vstm` `.vstx` `.vtk` `.vtp` `.vtt` `.vue` `.vvc` `.w2d` `.w64` `.war` `.wav` `.wave` `.webm` `.webp` `.wgsl` `.whl` `.wiki` `.wim` `.wk1` `.wk3` `.wks` `.wma` `.wmf` `.wmv` `.woff` `.woff2` `.wow` `.wpd` `.wps` `.wpt` `.wri` `.wrl` `.wsd` `.wtv` `.wv` `.wxi` `.wxl` `.wxs` `.x3f` `.x_b` `.x_t` `.xa` `.xaml` `.xapk` `.xar` `.xbm` `.xhtml` `.xip` `.xls` `.xlsb` `.xlsm` `.xlsx` `.xlt` `.xltm` `.xltx` `.xm` `.xmd` `.xml` `.xmp_bin` `.xmp_txt` `.xmt_bin` `.xmt_txt` `.xmv` `.xpi` `.xpk` `.xpm` `.xps` `.xsd` `.xsl` `.xslt` `.xspf` `.xvag` `.xvid` `.xyz` `.xz` `.y4m` `.yaml` `.yml` `.yop` `.yuv` `.z` `.z01` `.zabw` `.zip` `.zipx` `.zsh`
