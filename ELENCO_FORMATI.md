# MB Desk - elenco completo dei formati

**2461 estensioni** in 48 categorie si aprono con un visualizzatore dedicato.
Questo elenco e' generato automaticamente dallo stesso registro (`ui/formats.json`) che l'app usa per decidere come aprire un file:
**se un'estensione non compare qui, il file si apre solo come byte grezzi nell'editor esadecimale.**

Nell'app lo stesso elenco e' consultabile dal pulsante **Formati**, con la ricerca per estensione.

## PDF (2)

- **Visualizza:** Pagine, miniature, ricerca testo, zoom, stampa, firme digitali PAdES (informazioni firmatario)
- **Modifica:** Testo libero, disegno a mano, evidenziatore, immagini/timbri, compilazione moduli; salvataggio nel PDF

`.ai` `.pdf`

## Firmati digitalmente (CAdES / PKCS#7) (6)

- **Visualizza:** Dati firmatario (nome, codice fiscale, ente certificatore, validita'), verifica integrita' firma, apertura del documento contenuto nel visualizzatore adatto (anche firme multiple annidate)
- **Modifica:** Estrazione del documento originale; il documento estratto si modifica col suo editor (la modifica invalida la firma: si salva come nuovo file)

`.m7m` `.p7c` `.p7m` `.p7s` `.spc` `.tsd`

## Documenti Word (4)

- **Visualizza:** Impaginazione fedele (testo, tabelle, immagini, intestazioni)
- **Modifica:** Editor testo formattato (grassetto, corsivo, titoli, elenchi, tabelle); salvataggio in DOCX

`.docm` `.docx` `.dotm` `.dotx`

## Fogli di calcolo (21)

- **Visualizza:** Tutti i fogli, celle, formule (valori calcolati)
- **Modifica:** Modifica celle e formule, aggiunta/rimozione righe e colonne; salvataggio nel formato originale (o XLSX)

`.csv` `.dbf` `.dif` `.et` `.fods` `.ods` `.prn` `.qpw` `.slk` `.sylk` `.tsv` `.wk1` `.wk3` `.wks` `.xls` `.xlsb` `.xlsm` `.xlsx` `.xlt` `.xltm` `.xltx`

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

## Piani di progetto (Microsoft Project, Primavera, GanttProject) (7)

- **Visualizza:** Gantt con collegamenti, percorso critico, linee di base, sequenza temporale; calendario, diagramma reticolare, risorse e uso delle risorse, confronto tra versioni
- **Modifica:** Editor in stile Project: attivita' con struttura, durate, collegamenti, vincoli, avanzamento, risorse e costi, calendari con festivi italiani, livellamento; salvataggio in XML di Project, MPX, GanttProject (MPP con Project installato), PDF, Excel

`.gan` `.mpp` `.mpt` `.mpx` `.pmxml` `.xer` `.xml`

## Altri documenti Office e OpenDocument (31)

> Richiede **LibreOffice** (gratuito) installato sul PC: https://www.libreoffice.org/download/download/

- **Visualizza:** Conversione in PDF e visualizzazione completa
- **Modifica:** Esportazione in PDF / DOCX / XLSX / PPTX, poi modifica con il rispettivo editor

`.602` `.abw` `.cdr` `.doc` `.dot` `.fodg` `.fodp` `.fodt` `.hwp` `.lwp` `.mml` `.odf` `.odg` `.odp` `.odt` `.otg` `.otp` `.ott` `.pot` `.pps` `.ppt` `.rtf` `.sxc` `.sxd` `.sxi` `.sxw` `.wpd` `.wps` `.wpt` `.wri` `.zabw`

## Testo e codice sorgente (1733)

- **Visualizza:** Editor professionale (Monaco, lo stesso di VS Code) con colorazione sintassi, ricerca, mappa
- **Modifica:** Modifica completa, trova/sostituisci, salvataggio mantenendo la codifica

`.1` `.1in` `.1km` `.1m` `.1x` `.2` `.2da` `.3` `.3dml` `.3in` `.3m` `.3p` `.3pm` `.3qt` `.3x` `.4` `.4dform` `.4dm` `.4dproject` `.4gl` `.4th` `.5` `.6` `.6pl` `.6pm` `.7` `.8` `.8xp` `.8xp.txt` `.9` `.a51` `.abap` `.abnf` `.ac` `.action` `.ada` `.adb` `.adml` `.admx` `.ado` `.adoc` `.ads` `.aes` `.afm` `.agc` `.agda` `.ah1` `.ah2` `.ahk` `.ahkl` `.aidl` `.aj` `.ak` `.aleo` `.alg` `.als` `.aml` `.ampl` `.angelscript` `.anim` `.ant` `.antlers.html` `.antlers.php` `.antlers.xml` `.apacheconf` `.apex` `.apib` `.apl` `.app` `.app.src` `.appcache` `.applescript` `.apt` `.aqt` `.arc` `.arpa` `.arr` `.as` `.asax` `.asc` `.asciidoc` `.ascx` `.asd` `.asddls` `.ash` `.ashx` `.asl` `.asm` `.asmx` `.asn` `.asn1` `.asp` `.aspx` `.ass` `.asset` `.astro` `.asy` `.atom` `.atomcat` `.atomdeleted` `.atomsvc` `.au3` `.aug` `.auk` `.automount` `.aux` `.avdl` `.avs` `.avsc` `.avsi` `.aw` `.awk` `.axaml` `.axd` `.axi` `.axi.erb` `.axml` `.axs` `.axs.erb` `.azcli` `.b` `.babelrc` `.bal` `.baml` `.bas` `.bash` `.bat` `.bats` `.bb` `.bbappend` `.bbclass` `.bbcode` `.bbx` `.bdf` `.bdo` `.bdy` `.be` `.befunge` `.bend` `.bf` `.bi` `.bib` `.bibtex` `.bicep` `.bicepparam` `.bison` `.blade` `.blade.php` `.bmml` `.bmx` `.bones` `.boo` `.boot` `.bowerrc` `.bpl` `.bqn` `.brd` `.bro` `.brs` `.bru` `.bs` `.bsl` `.bst` `.bsv` `.builder` `.builds` `.bzl` `.c` `.c++` `.c++-objdump` `.c++objdump` `.c-objdump` `.c3` `.cabal` `.caddyfile` `.cairo` `.cake` `.capnp` `.carbon` `.cats` `.cbl` `.cbx` `.cc` `.ccp` `.ccproj` `.ccxml` `.cdc` `.cdf` `.cdfx` `.cds` `.cdxml` `.ceylon` `.cfc` `.cfg` `.cfm` `.cfml` `.cgi` `.cginc` `.ch` `.chem` `.chpl` `.chs` `.cil` `.circom` `.cirru` `.cj` `.cjs` `.cjsx` `.ck` `.cl` `.cl2` `.clar` `.click` `.clixml` `.clj` `.cljc` `.cljs` `.cljs.hl` `.cljscm` `.cljx` `.clp` `.cls` `.clue` `.clw` `.cmake` `.cmake.in` `.cmd` `.cmp` `.cnc` `.cnf` `.cob` `.cobol` `.cocci` `.code-snippets` `.code-workspace` `.coffee` `.coffee.erb` `.coffee.md` `.com` `.command` `.conf` `.config` `.conll` `.conllu` `.container` `.containerfile` `.cook` `.coq` `.cp` `.cpl` `.cpp` `.cpp-objdump` `.cppm` `.cppobjdump` `.cproject` `.cps` `.cpy` `.cql` `.cr` `.crc32` `.creole` `.cs` `.cs.pp` `.csc` `.cscfg` `.csd` `.csdef` `.csh` `.cshtml` `.csl` `.cson` `.csp` `.csproj` `.css` `.csvs` `.csx` `.ct` `.ctl` `.ctp` `.cts` `.cu` `.cue` `.cuh` `.cui` `.curl` `.curry` `.cw` `.cwl` `.cxx` `.cxx-objdump` `.cy` `.cylc` `.cyp` `.cypher` `.d` `.d-objdump` `.d2` `.darcspatch` `.dart` `.das` `.dat` `.dats` `.davmount` `.dax` `.db2` `.dbk` `.dcl` `.dcmp` `.dcurl` `.dd2` `.ddf` `.ddl` `.decls` `.def` `.depproj` `.desktop` `.desktop.in` `.device` `.dfm` `.dfy` `.dgn` `.dhall` `.di` `.dic` `.diff` `.dircolors` `.dita` `.ditamap` `.ditaval` `.diz` `.djs` `.dll.config` `.dlm` `.dm` `.do` `.docbook` `.dockerfile` `.dof` `.doh` `.dotsettings` `.dpatch` `.dpr` `.druby` `.dsc` `.dsl` `.dsp` `.dsr` `.dtb` `.dtd` `.dtsi` `.dtx` `.duby` `.dwd` `.dwl` `.dyalog` `.dyl` `.dylan` `.dzn` `.e` `.eam.fs` `.eb` `.ebnf` `.ebuild` `.ec` `.ecl` `.eclass` `.eclxml` `.ecr` `.ect` `.edc` `.edge` `.edgeql` `.editorconfig` `.edn` `.eh` `.eif` `.ejs` `.ejs.t` `.el` `.eld` `.eliom` `.eliomi` `.elm` `.elv` `.em` `.emacs` `.emacs.desktop` `.emberscript` `.emma` `.emn` `.emotionml` `.emp` `.env` `.epj` `.eps` `.epsi` `.eq` `.erb` `.erb.deface` `.erl` `.es` `.es3` `.es6` `.escript` `.esdl` `.eslintrc` `.et3` `.ets` `.etx` `.ex` `.exs` `.eye` `.f` `.f03` `.f08` `.f77` `.f90` `.f95` `.factor` `.fan` `.fancypack` `.fasl` `.fb2` `.fbs` `.fcgi` `.fdt` `.fea` `.feature` `.filters` `.fir` `.fish` `.flex` `.flf` `.flix` `.flow` `.flux` `.flx` `.fly` `.fnc` `.fnl` `.fo` `.for` `.forth` `.fp` `.fpp` `.fppi` `.fr` `.frag` `.frg` `.frm` `.frt` `.fs` `.fsh` `.fshader` `.fsi` `.fsproj` `.fsscript` `.fst` `.fsti` `.fsx` `.fth` `.ftl` `.ftlh` `.ftlx` `.fun` `.fut` `.fx` `.fxh` `.fxml` `.fy` `.g` `.g4` `.gaml` `.gap` `.gawk` `.gbl` `.gbo` `.gbp` `.gbs` `.gco` `.gcode` `.gcrd` `.gd` `.gdb` `.gdbinit` `.gdnlib` `.gdns` `.gdshader` `.gdshaderinc` `.ged` `.gedcom` `.gemspec` `.geo` `.geo.json` `.geojson` `.geom` `.gf` `.ggr` `.gi` `.gitattributes` `.gitconfig` `.gitignore` `.gitmodules` `.gjs` `.gko` `.glade` `.gleam` `.glf` `.glsl` `.glslf` `.glslv` `.glyphs` `.gmi` `.gml` `.gms` `.gmx` `.gn` `.gni` `.gno` `.gnu` `.gnuplot` `.go` `.god` `.gohtml` `.golo` `.gotmpl` `.gp` `.gpb` `.gpl` `.gpt` `.gpx` `.gql` `.grace` `.gradle` `.gradle.kts` `.graphql` `.graphqls` `.groovy` `.grt` `.grxml` `.gs` `.gsc` `.gsh` `.gshader` `.gsp` `.gst` `.gsx` `.gtkrc` `.gtl` `.gto` `.gtp` `.gtpl` `.gts` `.gv` `.gvp` `.gvy` `.gx` `.gy` `.gyp` `.gypi` `.h` `.h++` `.h.in` `.ha` `.hack` `.hal` `.haml` `.haml.deface` `.handlebars` `.har` `.hats` `.hb` `.hbs` `.hc` `.hcl` `.heex` `.held` `.hexpat` `.hh` `.hhi` `.hic` `.hip` `.hlean` `.hlsl` `.hlsli` `.hocon` `.hoon` `.hp` `.hpp` `.hqf` `.hql` `.hrl` `.hs` `.hs-boot` `.hsc` `.hta` `.htaccess` `.htc` `.html.eex` `.html.hl` `.html.tmpl` `.http` `.hujson` `.hurl` `.hx` `.hxml` `.hxsl` `.hxx` `.hy` `.hzp` `.i` `.i3` `.i7x` `.ice` `.iced` `.icl` `.icls` `.idc` `.idf` `.idl` `.idr` `.iecplc` `.iecst` `.ig` `.ihlp` `.ijm` `.ijs` `.ik` `.il` `.ily` `.imba` `.ime` `.iml` `.imy` `.in` `.inc` `.inf` `.ini` `.ink` `.inkml` `.inl` `.ino` `.ins` `.intr` `.io` `.iol` `.ipf` `.ipp` `.iptables` `.ipynb` `.irclog` `.irp` `.isl` `.iso` `.ispc` `.iss` `.its` `.iuml` `.ivy` `.ixx` `.j` `.j2` `.jac` `.jad` `.jade` `.jai` `.jake` `.janet` `.jav` `.java` `.javascript` `.jbuilder` `.jcl` `.jelly` `.jflex` `.jinja` `.jinja2` `.jison` `.jisonlex` `.jl` `.jq` `.jrd` `.js` `.js.erb` `.jsb` `.jscad` `.jscsrc` `.jse` `.jsfl` `.jsh` `.jshintrc` `.jshtm` `.jslib` `.jsm` `.json` `.json-patch` `.json-tmlanguage` `.json.example` `.json5` `.jsonc` `.jsonl` `.jsonld` `.jsonml` `.jsonnet` `.jsp` `.jspre` `.jsproj` `.jss` `.jst` `.jsx` `.jte` `.just` `.k` `.kak` `.kbl` `.kdl` `.key` `.kicad_mod` `.kicad_pcb` `.kicad_sch` `.kicad_sym` `.kicad_wks` `.kid` `.kino` `.kit` `.kk` `.kml` `.kojo` `.kql` `.krl` `.ks` `.ksh` `.ksy` `.kt` `.ktm` `.kts` `.kv` `.l` `.lagda` `.langium` `.lark` `.las` `.lasso` `.lasso8` `.lasso9` `.lasxml` `.latex` `.latte` `.launch` `.lbe` `.lbx` `.lc3lib` `.ld` `.ldif` `.lds` `.lean` `.leex` `.lektorproject` `.leo` `.less` `.lex` `.lfe` `.lgr` `.lgt` `.lhs` `.libsonnet` `.lid` `.lidr` `.ligo` `.lin` `.link66` `.linq` `.liq` `.liquid` `.lisp` `.list` `.litcoffee` `.livecodescript` `.livemd` `.lkml` `.ll` `.lmi` `.lobster` `.lock` `.log` `.logtalk` `.lol` `.lookml` `.lostxml` `.lp` `.lpr` `.lrc` `.ls` `.lsl` `.lslp` `.lsp` `.ltx` `.lua` `.luau` `.lvclass` `.lvlib` `.lvproj` `.ly` `.m` `.m2` `.m3` `.m3u` `.m3u8` `.m4` `.ma` `.mads` `.maei` `.mak` `.make` `.makefile` `.mako` `.man` `.manifest` `.mao` `.map` `.marko` `.mask` `.mat` `.mata` `.matah` `.mathematica` `.mathml` `.matlab` `.mawk` `.maxhelp` `.maxpat` `.maxproj` `.mbt` `.mc` `.mc2` `.mcfunction` `.mch` `.mcmeta` `.mcr` `.mcurl` `.md4` `.md5` `.mdoc` `.mdpolicy` `.mdtext` `.mdtxt` `.mdwn` `.me` `.mediawiki` `.mermaid` `.meta` `.meta4` `.metal` `.metalink` `.mets` `.metta` `.mf` `.mg` `.minid` `.mint` `.mir` `.mirah` `.mjml` `.mjs` `.mk` `.mkdn` `.mkdown` `.mkfile` `.mkii` `.mkiv` `.mkvi` `.ml` `.ml4` `.mli` `.mligo` `.mlir` `.mll` `.mly` `.mm` `.mmd` `.mmk` `.mms` `.mnu` `.mo` `.moc` `.mod` `.mof` `.mojo` `.monkey` `.monkey2` `.moo` `.moon` `.mount` `.move` `.mp` `.mpd` `.mpf` `.mpkg` `.mpl` `.mps` `.mq4` `.mq5` `.mqh` `.mrc` `.mrcx` `.mrl` `.mrml` `.ms` `.mscml` `.msd` `.msdax` `.mspec` `.mss` `.mt` `.mtl` `.mtml` `.mu` `.mud` `.muf` `.mumps` `.mup` `.musd` `.muse` `.musicxml` `.mustache` `.mxml` `.mxt` `.mysql` `.myt` `.mzn` `.n` `.n3` `.nanorc` `.nas` `.nasl` `.nasm` `.natvis` `.nawk` `.nb` `.nbp` `.nc` `.ncl` `.ncx` `.ndjson` `.ndproj` `.ne` `.nearley` `.ned` `.neon` `.network` `.nf` `.nfo` `.ngc` `.nginx` `.nginxconf` `.ni` `.nim` `.nim.cfg` `.nimble` `.nimrod` `.nims` `.ninja` `.nit` `.nix` `.njk` `.njs` `.nl` `.nlogo` `.nmake` `.no` `.nomad` `.not` `.npmrc` `.nproj` `.nqp` `.nr` `.nse` `.nsh` `.nsi` `.nss` `.nu` `.numpy` `.numpyw` `.numsc` `.nuspec` `.nvmrc` `.ny` `.ob2` `.obgx` `.objdump` `.ocl` `.odd` `.odin` `.ol` `.omdoc` `.omgrofl` `.ooc` `.opa` `.opal` `.opencl` `.opf` `.opml` `.opy` `.orc` `.org` `.os` `.osfpvg` `.osm` `.outjob` `.overpassql` `.owl` `.owx` `.ox` `.oxh` `.oxo` `.oxygene` `.oz` `.p` `.p4` `.p6` `.p6l` `.p6m` `.p8` `.pac` `.pacscript` `.pact` `.pan` `.parrot` `.pas` `.pascal` `.pasm` `.pat` `.patch` `.path` `.pb` `.pbi` `.pbt` `.pbtxt` `.pc` `.pc.in` `.pcbdoc` `.pck` `.pcss` `.pd` `.pd_lua` `.pddl` `.pde` `.peggy` `.pegjs` `.pep` `.per` `.perl` `.pfa` `.pgp` `.pgsql` `.ph` `.php` `.php3` `.php4` `.php5` `.phps` `.phpt` `.phtml` `.pic` `.pig` `.pike` `.pir` `.pjs` `.pkb` `.pkgproj` `.pkl` `.pks` `.pl` `.pl6` `.pla` `.plantuml` `.plb` `.plist` `.plot` `.pls` `.plsql` `.pluginspec` `.plx` `.pm` `.pm6` `.pml` `.pmod` `.po` `.pod` `.pod6` `.podsl` `.podspec` `.pogo` `.polar` `.pony` `.postcss` `.pov` `.pp` `.pprx` `.pq` `.pqm` `.praat` `.prawn` `.prc` `.prefab` `.prefs` `.prettierrc` `.prg` `.pri` `.prisma` `.prjpcb` `.pro` `.proj` `.prolog` `.properties` `.props` `.proto` `.provx` `.prw` `.ps` `.ps1` `.ps1xml` `.psc` `.psc1` `.psd1` `.psgi` `.pskcxml` `.psm1` `.psql` `.pt` `.pub` `.pubxml` `.pug` `.puml` `.purs` `.pwn` `.pxd` `.pxi` `.py` `.py3` `.py3x` `.pyde` `.pyi` `.pyp` `.pyt` `.pytb` `.pyw` `.pyx` `.q` `.qasm` `.qbs` `.qc` `.qhelp` `.ql` `.qll` `.qmd` `.qml` `.qmlproject` `.qmltypes` `.qnt` `.qs` `.r` `.r2` `.r3` `.rabl` `.rake` `.raku` `.rakumod` `.ram` `.raml` `.rapd` `.rascript` `.razor` `.rb` `.rbbas` `.rbfrm` `.rbi` `.rbmnu` `.rbres` `.rbs` `.rbtbar` `.rbuild` `.rbuistate` `.rbw` `.rbx` `.rbxmx` `.rbxs` `.rchit` `.rd` `.rdf` `.rdfs` `.rdoc` `.re` `.reb` `.rebol` `.red` `.redis` `.reds` `.reek` `.reg` `.regex` `.regexp` `.rego` `.rei` `.rej` `.religo` `.relo` `.res` `.resi` `.resource` `.rest` `.rest.txt` `.resx` `.rex` `.rexx` `.rg` `.rhai` `.rhistory` `.rhtml` `.rif` `.ring` `.riot` `.rjs` `.rkt` `.rktd` `.rktl` `.rl` `.rld` `.rlib` `.rmd` `.rmiss` `.rng` `.rnh` `.rno` `.rnw` `.robot` `.roc` `.rockspec` `.roff` `.ron` `.ronn` `.ros` `.rpgle` `.rprofile` `.rpy` `.rq` `.rs` `.rs.in` `.rsat` `.rsc` `.rsh` `.rsheet` `.rss` `.rst` `.rst.txt` `.rsx` `.rt` `.rtx` `.ru` `.ruby` `.rusd` `.rviz` `.s` `.sage` `.sagews` `.sail` `.sarif` `.sas` `.sass` `.sats` `.sb` `.sbatch` `.sbml` `.sbt` `.sbv` `.sc` `.scad` `.scala` `.scaml` `.scc` `.scd` `.sce` `.scenic` `.sch` `.schdoc` `.sci` `.scm` `.sco` `.scope` `.scpt` `.scr` `.scrbl` `.scss` `.scurl` `.scxml` `.sd` `.sdc` `.sdkd` `.sdkm` `.sed` `.self` `.senmlx` `.sensmlx` `.service` `.sexp` `.sfd` `.sfproj` `.sfv` `.sgm` `.sgml` `.sh` `.sh-session` `.sh.in` `.sha1` `.sha2` `.sha224` `.sha256` `.sha256sum` `.sha3` `.sha384` `.sha512` `.shader` `.shen` `.shex` `.shf` `.shproj` `.shx` `.sieve` `.sig` `.sip` `.sj` `.sjs` `.sl` `.slang` `.sld` `.slice` `.slim` `.slint` `.slm` `.sln` `.slnlaunch` `.slnx` `.sls` `.slurm` `.sma` `.smali` `.smi` `.smil` `.smithy` `.sml` `.smt` `.smt2` `.snakefile` `.snap` `.snip` `.snippet` `.snippets` `.socket` `.sol` `.soy` `.sp` `.sparql` `.spdx` `.spec` `.spf` `.spin` `.spot` `.sps` `.sqf` `.sql` `.sqlrpgle` `.sra` `.srdf` `.srt` `.sru` `.srv` `.srx` `.ss` `.ssa` `.ssdl` `.ssjs` `.ssml` `.sss` `.st` `.stan` `.star` `.sthlp` `.ston` `.story` `.storyboard` `.stpx` `.sttheme` `.sty` `.styl` `.stylus` `.sub` `.sublime-build` `.sublime-color-scheme` `.sublime-commands` `.sublime-completions` `.sublime-keymap` `.sublime-macro` `.sublime-menu` `.sublime-mousemap` `.sublime-project` `.sublime-settings` `.sublime-snippet` `.sublime-syntax` `.sublime-theme` `.sublime-workspace` `.sublime_metrics` `.sublime_session` `.sum` `.surql` `.sv` `.svelte` `.svh` `.swap` `.swg` `.swidtag` `.swift` `.swig` `.syntax` `.systemverify` `.t` `.t2t` `.tab` `.tac` `.tact` `.tag` `.talon` `.tap` `.tape` `.target` `.targets` `.tcc` `.tcdut` `.tcgvl` `.tcio` `.tcl` `.tcl.in` `.tcpou` `.tcsh` `.td` `.te` `.tea` `.tei` `.teicorpus` `.templ` `.tesc` `.tese` `.tex` `.texi` `.texinfo` `.text` `.textgrid` `.textile` `.textproto` `.tf` `.tfi` `.tfstate` `.tfstate.backup` `.tftpl` `.tfvars` `.thor` `.thrift` `.thy` `.timer` `.tk` `.tl` `.tla` `.tlv` `.tm` `.tmac` `.tmcommand` `.tmdl` `.tml` `.tmlanguage` `.tmpl` `.tmpreferences` `.tmsnippet` `.tmtheme` `.tmux` `.toc` `.tofu` `.toit` `.tolk` `.toml` `.toml.example` `.tool` `.topojson` `.tpb` `.tpl` `.tpp` `.tps` `.tr` `.tres` `.trg` `.trigger` `.ts` `.tscn` `.tsconfig.json` `.tsp` `.tsrx` `.tst` `.tsx` `.ttl` `.ttml` `.tu` `.twig` `.txi` `.txl` `.txt` `.txtpb` `.txx` `.typ` `.ua` `.uc` `.udo` `.ui` `.uil` `.unity` `.uno` `.uo` `.uoml` `.upc` `.uplc` `.ur` `.urdf` `.uri` `.uris` `.url` `.urls` `.urs` `.uu` `.uue` `.uvt` `.uvvt` `.ux` `.v` `.vala` `.vapi` `.vark` `.vb` `.vba` `.vbe` `.vbhtml` `.vbproj` `.vbs` `.vcl` `.vct` `.vcxproj` `.vdf` `.vec` `.veo` `.verse` `.vert` `.vh` `.vhd` `.vhdl` `.vhf` `.vhi` `.vho` `.vhost` `.vhs` `.vht` `.vhw` `.vim` `.vimrc` `.viw` `.vmb` `.vmf` `.volt` `.vpy` `.vrx` `.vs` `.vsh` `.vshader` `.vsixmanifest` `.vssettings` `.vssm` `.vssx` `.vstemplate` `.vtl` `.vto` `.vtt` `.vue` `.vw` `.vxml` `.vy` `.w` `.wadl` `.wast` `.wat` `.watchr` `.wbs` `.wdl` `.webapp` `.webidl` `.webmanifest` `.weechatlog` `.wesl` `.wgsl` `.whiley` `.wif` `.wiki` `.wikitext` `.wisp` `.wit` `.wixproj` `.wl` `.wlk` `.wls` `.wlt` `.wlua` `.wml` `.wmls` `.workbook` `.workflow` `.wren` `.ws` `.wsdl` `.wsf` `.wsgi` `.wspolicy` `.wxi` `.wxl` `.wxs` `.x` `.x10` `.x3d` `.x3dz` `.x68` `.xacro` `.xaml` `.xav` `.xbl` `.xc` `.xca` `.xcs` `.xdc` `.xdcf` `.xdf` `.xdm` `.xdp` `.xdssc` `.xel` `.xenc` `.xht` `.xhtm` `.xhvml` `.xi` `.xib` `.xlf` `.xliff` `.xmi` `.xml` `.xml.dist` `.xmp` `.xns` `.xojo_code` `.xojo_menu` `.xojo_report` `.xojo_script` `.xojo_toolbar` `.xojo_window` `.xop` `.xpl` `.xproc` `.xproj` `.xpy` `.xq` `.xql` `.xqm` `.xquery` `.xqy` `.xrl` `.xs` `.xsd` `.xsf` `.xsh` `.xsjs` `.xsjslib` `.xsl` `.xslfo` `.xslt` `.xsm` `.xsp-config` `.xsp.metadata` `.xspec` `.xspf` `.xtend` `.xul` `.xvm` `.xvml` `.xzap` `.y` `.yacc` `.yaml` `.yaml-tmlanguage` `.yaml.sed` `.yang` `.yap` `.yar` `.yara` `.yasnippet` `.yin` `.yml` `.yml.mysql` `.ymp` `.yrl` `.yul` `.yy` `.yyp` `.z3` `.zap` `.zaz` `.zcml` `.zed` `.zeek` `.zep` `.zig` `.zig.zon` `.zil` `.zimpl` `.zmm` `.zmodel` `.zmpl` `.zone` `.zpl` `.zs` `.zsh` `.zsh-theme`

## Markdown (5)

- **Visualizza:** Anteprima formattata affiancata al testo
- **Modifica:** Modifica con anteprima in tempo reale

`.markdown` `.md` `.mdown` `.mdx` `.mkd`

## Pagine web (7)

- **Visualizza:** Anteprima della pagina (isolata, senza accesso alla rete) e sorgente
- **Modifica:** Modifica del sorgente con anteprima aggiornata

`.htm` `.html` `.mht` `.mhtml` `.shtml` `.svgz` `.xhtml`

## Immagini (75)

- **Visualizza:** Zoom, adatta, pixel reali, informazioni (dimensioni, EXIF)
- **Modifica:** Editor in stile Photoshop: livelli (opacita', metodi di fusione, maschere, regolazioni), strumenti di selezione, pittura, timbro clone, sfumatura, testo e forme, regolazioni (livelli, curve, tonalita'/saturazione, bilanciamento colore...), filtri, trasformazione libera, ritaglio, dimensione immagine e quadro; salvataggio in PSD e ORA con i livelli o in PNG/JPG/WEBP/TIFF/BMP/GIF

`.apng` `.avif` `.avifs` `.blp` `.bmp` `.bw` `.cur` `.dcx` `.dds` `.dib` `.emf` `.emz` `.fit` `.fits` `.flc` `.fli` `.fpx` `.ftc` `.fts` `.ftu` `.gbr` `.gif` `.heic` `.heics` `.heif` `.heifs` `.hif` `.icb` `.icns` `.ico` `.im` `.j2c` `.j2k` `.jfif` `.jp2` `.jpc` `.jpe` `.jpeg` `.jpf` `.jpg` `.jpx` `.kra` `.mic` `.mpo` `.msp` `.ora` `.pbm` `.pcx` `.pfm` `.pgm` `.pjp` `.pjpeg` `.png` `.pnm` `.ppm` `.psd` `.pxr` `.qoi` `.ras` `.rgb` `.rgba` `.sgi` `.spi` `.tga` `.tif` `.tiff` `.vda` `.vst` `.webp` `.wmf` `.wmz` `.xbm` `.xcf` `.xmind` `.xpm`

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

## Video (124)

- **Visualizza:** Riproduzione con barra, velocita', fotogrammi, schermo intero, tracce audio. I formati non nativi vengono convertiti automaticamente
- **Modifica:** Taglio inizio/fine, rotazione, rimozione audio, estrazione audio, cattura fotogramma, conversione in MP4/WEBM/MKV/AVI/MOV/GIF

`.264` `.265` `.266` `.3g2` `.3gp` `.3gp2` `.3gpp` `.3gpp2` `.amv` `.anm` `.asf` `.av1` `.avc` `.avi` `.avs2` `.avs3` `.bfi` `.bik` `.bmv` `.c93` `.cdg` `.cdxl` `.cmv` `.dav` `.dif` `.divx` `.drc` `.dv` `.dvr-ms` `.dxa` `.evo` `.f4v` `.flv` `.fmv` `.gifv` `.gxf` `.h261` `.h264` `.h265` `.h266` `.h26l` `.hevc` `.hnm` `.ifv` `.imx` `.ipu` `.ism` `.isma` `.ismv` `.ivf` `.ivr` `.kux` `.lvf` `.m1v` `.m2t` `.m2ts` `.m2v` `.m4v` `.mj2` `.mjpeg` `.mjpg` `.mk3d` `.mkv` `.mod` `.moflex` `.mov` `.mp2v` `.mp4` `.mpe` `.mpeg` `.mpg` `.mpv` `.mts` `.mtv` `.mvi` `.mxf` `.mxg` `.nsv` `.nut` `.obu` `.ogm` `.ogv` `.pva` `.qt` `.rcv` `.rm` `.rmvb` `.roq` `.rpl` `.ser` `.smk` `.sndanim` `.str` `.swf` `.tgq` `.thp` `.tmv` `.tod` `.tp` `.trec` `.trp` `.ts` `.txd` `.ty` `.ty+` `.usm` `.vc1` `.vob` `.vp6` `.vp8` `.vp9` `.vqa` `.vro` `.vvc` `.webm` `.wmv` `.wtv` `.wve` `.xmv` `.xvid` `.y4m` `.yop` `.yuv` `.znm`

## Audio (172)

- **Visualizza:** Riproduzione con forma d'onda, velocita', volume. I formati non nativi vengono convertiti automaticamente
- **Modifica:** Taglio inizio/fine, volume, conversione in MP3/WAV/FLAC/OGG/M4A/OPUS

`.302` `.3ga` `.669` `.722` `.8svx` `.aa` `.aa3` `.aac` `.ac3` `.adp` `.adts` `.adx` `.aea` `.afc` `.aif` `.aifc` `.aiff` `.aix` `.al` `.alaw` `.amr` `.ams` `.apc` `.ape` `.aptx` `.aptxhd` `.ast` `.at3` `.au` `.avr` `.awb` `.ay` `.bcstm` `.bfstm` `.bonk` `.brstm` `.bwf` `.c2` `.caf` `.cdata` `.daud` `.dbm` `.dff` `.dfpwm` `.digi` `.dmf` `.dsf` `.dsm` `.dss` `.dtk` `.dts` `.dtshd` `.eac3` `.ec3` `.f4a` `.f4b` `.fap` `.far` `.flac` `.fsb` `.fwse` `.g722` `.g723_1` `.g729` `.gdm` `.genh` `.gsm` `.gym` `.hca` `.iamf` `.iff` `.imf` `.ircam` `.it` `.j2b` `.lc3` `.m15` `.m2a` `.m4a` `.m4b` `.m4r` `.mac` `.mca` `.mdl` `.med` `.mka` `.mlp` `.mo3` `.mod` `.mods` `.mp+` `.mp2` `.mp3` `.mpa` `.mpc` `.mpp` `.mptm` `.msbc` `.msf` `.mt2` `.mtaf` `.mtm` `.musx` `.nist` `.nsf` `.nsp` `.oga` `.ogg` `.okt` `.oma` `.opus` `.osq` `.paf` `.pcm` `.plm` `.psm` `.pt36` `.ptm` `.qcp` `.qoa` `.ra` `.rf64` `.rka` `.rsd` `.rso` `.s16le` `.s3m` `.sbc` `.sd2` `.sds` `.sf` `.shn` `.sln` `.snd` `.son` `.sph` `.spx` `.ss2` `.st26` `.stk` `.stm` `.svag` `.svx` `.sw` `.tak` `.thd` `.truehd` `.tta` `.ub` `.ul` `.ulaw` `.ult` `.umx` `.uw` `.vag` `.voc` `.vpk` `.vqe` `.vqf` `.vql` `.w64` `.wav` `.wave` `.wma` `.wow` `.wsd` `.wv` `.xa` `.xm` `.xmd` `.xpk` `.xvag`

## MIDI e karaoke (4)

- **Visualizza:** Riproduzione con un sintetizzatore General MIDI incluso (suoni FluidR3, licenza MIT), durata, tracce, testo karaoke sincronizzato (.kar)
- **Modifica:** Salva con nome in WAV, MP3, OGG, FLAC o M4A

`.kar` `.mid` `.midi` `.rmi`

## Disegni CAD 2D (AutoCAD) (5)

- **Visualizza:** Disegno vettoriale con zoom/pan, layer, blocchi, quote, testi, misura distanze
- **Modifica:** Accensione/spegnimento layer, esportazione SVG/PNG/PDF; per DXF modifica diretta del contenuto testuale. Apertura in DWG TrueView se presente

`.dgn` `.dwg` `.dwt` `.dxb` `.dxf`

## Pubblicazioni Autodesk DWF / DWFx e documenti XPS (5)

- **Visualizza:** Elenco dei fogli con miniature, fogli 2D vettoriali (W2D e XPS) con zoom/pan, layer, testi e ricerca, proprieta' degli oggetti (AutoCAD, Revit, Inventor), marcature di revisione, misure di distanza e area in unita' del disegno, modelli 3D W3D nel visualizzatore 3D
- **Modifica:** Esportazione in PDF vettoriale (tutti i fogli), SVG e PNG del foglio aperto

`.dwf` `.dwfx` `.oxps` `.w2d` `.xps`

## Modelli CAD 3D (STEP, IGES, BREP) (8)

- **Visualizza:** Modello 3D navigabile (rotazione, pan, zoom), albero delle parti, nascondi/isola parti, sezioni, misure, vista filo di ferro
- **Modifica:** Colori e visibilita' delle parti, esportazione in STL / OBJ / GLB

`.brep` `.brp` `.iges` `.igs` `.p21` `.step` `.stp` `.stpz`

## Modelli 3D di MB Desk (.mbmod) (1)

- **Visualizza:** Modello 3D di solidi con la cronologia delle lavorazioni (sul telefono: anteprima navigabile)
- **Modifica:** Modellazione di solidi: schizzi con vincoli e quote, estrusione, rivoluzione, fori, raccordi, smussi, guscio, spingi/tira, booleane, sposta/ruota/scala/specchia, serie, accoppiamenti, parametri; salvataggio in STEP, IGES, BREP, STL, OBJ, glTF

`.mbmod`

## Modelli 3D e BIM (26)

- **Visualizza:** Modello 3D navigabile (rotazione, pan, zoom), albero oggetti, nascondi/isola, sezioni, misure, animazioni (dove presenti), proprieta' BIM per IFC
- **Modifica:** Colori, visibilita', trasformazioni, esportazione in STL / OBJ / GLB

`.3dm` `.3ds` `.3mf` `.amf` `.bvh` `.dae` `.fbx` `.glb` `.gltf` `.ifc` `.ifczip` `.kmz` `.lwo` `.md2` `.obj` `.off` `.pcd` `.pdb` `.ply` `.stl` `.usdz` `.vox` `.vrml` `.vtk` `.vtp` `.wrl`

## SketchUp (1)

- **Visualizza:** Modello 3D senza SketchUp installato (lettore OpenSKP): geometria con materiali, colori e texture, spigoli, gruppi e componenti ad albero con nomi e attributi, tag accendibili, scene salvate come viste. Provato con file da SketchUp 8 a 2026; alcuni file 2013-2020 e i modelli molto grandi (oltre circa 50 MB) possono non aprirsi
- **Modifica:** Visibilita', colori, sezioni e misure; Salva con nome in STEP, IFC, GLB/glTF, OBJ, STL, 3MF, DXF 3D, PLY, VRML, USDZ

`.skp`

## Nuvole di punti (laser scanner, LiDAR) (8)

- **Visualizza:** Nuvole anche di centinaia di milioni di punti (anche scansioni e progetti Autodesk ReCap) lette a blocchi con livelli di dettaglio e cache su disco; colori RGB, intensita', quota o classificazione; dimensione dei punti e dettaglio regolabili; misure con aggancio al punto (distanza, in pianta, dislivello); sezione; coordinate del punto; insieme a IFC e altri modelli 3D (modello federato, coordinate allineate)
- **Modifica:** Salva con nome in LAS, LAZ, E57, PLY, PTS, XYZ (tutti i punti o solo la parte visibile della sezione); classi nascondibili

`.e57` `.las` `.laz` `.pts` `.ptx` `.rcp` `.rcs` `.xyz`

## Segnalazioni BIM (BCF) (2)

- **Visualizza:** Segnalazioni BCF 2.0 / 2.1 / 3.0 (Revit, Navisworks, Solibri, BIMcollab, Archicad, Tekla): elenco con filtri, istantanee, commenti, punti di vista; sovrapposizione al modello IFC con ripristino di camera, elementi selezionati e visibili, colori e sezioni
- **Modifica:** Nuove segnalazioni dal visualizzatore 3D (titolo, descrizione, tipo, stato, priorita', assegnatario, scadenza, commenti, punto di vista e istantanea); salvataggio in .bcfzip BCF 2.1 o 3.0; report PDF ed Excel

`.bcf` `.bcfzip`

## Formati 3D di visualizzazione (JT, U3D) (2)

- **Visualizza:** JT (ISO 14306, versioni 8-10): assieme, parti, istanze, colori, proprieta' e metadati, geometria tassellata al livello di dettaglio piu' fine; U3D (ECMA-363), anche estratti dai PDF 3D (i modelli PRC dei PDF vengono elencati ma non ancora letti). Navigazione, albero, sezioni, misure come gli altri modelli 3D
- **Modifica:** Colori e visibilita' delle parti, esportazione in STL / OBJ / GLB. B-rep (Parasolid XT, JT B-rep), PMI e texture non vengono letti

`.jt` `.u3d`

## Tubazioni (.cii, CAESAR II .c2) (3)

- **Visualizza:** Linea in 3D con il diametro vero dei tubi, riduzioni, valvole, curve, nodi numerati, ancoraggi e vincoli disegnati; al clic i dati dell'elemento. Navigazione, sezioni e misure come gli altri modelli 3D
- **Modifica:** Il testo del file si modifica con Apri come -> Editor di testo; esportazione del modello in STL / OBJ / GLB

`.c2` `.cii` `.pcf`

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

- **Visualizza:** Formato proprietario Autodesk: si apre in Autodesk Navisworks Freedom (installato su questo PC) con un clic; in MB Desk: informazioni file e byte grezzi
- **Modifica:** Non modificabile fuori da Navisworks Manage/Simulate

`.nwc` `.nwd` `.nwf`

## SolidWorks, Solid Edge e Parasolid (19)

- **Visualizza:** Senza i programmi originali: anteprima incorporata, proprieta' (anche personalizzate e per configurazione), materiale, configurazioni, componenti degli assiemi e delle tavole; modello 3D esatto letto dal Parasolid contenuto nel file (assiemi SolidWorks composti dai file delle parti)
- **Modifica:** Esportazione in STEP esatto (B-rep), GLB, STL, OBJ, IFC; le tavole mostrano anteprima e proprieta'

`.asm` `.asmdot` `.dft` `.drwdot` `.p_b` `.p_t` `.par` `.prtdot` `.psm` `.pwd` `.sldasm` `.slddrw` `.sldprt` `.x_b` `.x_t` `.xmp_bin` `.xmp_txt` `.xmt_bin` `.xmt_txt`

## PTC Creo Parametric / Pro/ENGINEER (4)

- **Visualizza:** Anteprima salvata nel file (Creo 2.0 e successivi), tipo di modello, nome, versione di Creo che l'ha salvato, sezioni del file; anche i file con il numero di versione (pezzo.prt.3). Apertura con Creo Parametric o Creo View se installati
- **Modifica:** Nessuna (la geometria e' in un formato proprietario PTC: per il 3D esportare in STEP da Creo)

`.asm` `.drw` `.frm` `.prt`

## Archivi compressi e immagini disco (84)

> Richiede **7-Zip** (gratuito) installato sul PC: https://www.7-zip.org/

- **Visualizza:** Contenuto ad albero; ogni file interno si apre direttamente in MB Desk
- **Modifica:** Aggiunta (anche con trascinamento), eliminazione e rinomina di file per ZIP/7Z/TAR/WIM/JAR; estrazione di tutto o di singoli file per tutti

`.001` `.7z` `.a` `.aab` `.apk` `.appx` `.appxbundle` `.ar` `.arj` `.bz2` `.bzip2` `.cab` `.cb7` `.cbr` `.cbz` `.chi` `.chm` `.cpio` `.cramfs` `.deb` `.dmg` `.ear` `.egg` `.esd` `.gz` `.gzip` `.hfs` `.hfsx` `.img` `.ipa` `.iso` `.jar` `.kmz` `.lha` `.lib` `.lit` `.lz4` `.lzh` `.lzma` `.lzma86` `.msi` `.msix` `.msp` `.msu` `.nsis` `.nupkg` `.ova` `.pkg` `.ppkg` `.qcow` `.qcow2` `.r00` `.rar` `.rpm` `.squashfs` `.swm` `.tar` `.taz` `.tbz` `.tbz2` `.tgz` `.tlz4` `.tpz` `.txz` `.tzst` `.udf` `.vdi` `.vhd` `.vmdk` `.vsix` `.war` `.whl` `.wim` `.xapk` `.xar` `.xip` `.xpi` `.xz` `.z` `.z01` `.zip` `.zipx` `.zst` `.zstd`

## Email (7)

- **Visualizza:** Mittente, destinatari, data, corpo HTML/testo, allegati apribili direttamente in MB Desk
- **Modifica:** Estrazione e salvataggio degli allegati; il corpo si puo' esportare in HTML/TXT

`.eml` `.emlx` `.mbox` `.mbx` `.msg` `.ost` `.pst`

## eBook (1)

- **Visualizza:** Lettura a pagine con indice
- **Modifica:** Nessuna modifica (sola lettura)

`.epub`

## Caratteri (font) (6)

- **Visualizza:** Anteprima a piu' dimensioni, testo di prova personalizzabile, tutti i glifi, informazioni
- **Modifica:** Nessuna modifica (sola lettura)

`.otc` `.otf` `.ttc` `.ttf` `.woff` `.woff2`

## Database SQLite (13)

- **Visualizza:** Tabelle, viste, struttura, ricerca, query SQL
- **Modifica:** Modifica celle, inserimento/eliminazione righe, esecuzione SQL; salvataggio diretto

`.accdb` `.accde` `.db` `.db3` `.gpkg` `.mbtiles` `.mdb` `.mde` `.s3db` `.sdb` `.sl3` `.sqlite` `.sqlite3`

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

## Dati scientifici e tabellari (HDF5, NetCDF, Parquet, Arrow) (14)

- **Visualizza:** Struttura (gruppi, dataset, variabili, dimensioni, attributi, schema e metadati), anteprima dei dati a pagine con grafico per i valori numerici
- **Modifica:** Esportazione di tabelle, dataset e variabili in CSV ed Excel

`.arrow` `.dta` `.feather` `.h5` `.hdf5` `.he5` `.nc` `.nc4` `.parquet` `.por` `.sas7bdat` `.sav` `.xpt` `.zsav`

## Autodesk Revit (4)

- **Visualizza:** Anteprima incorporata nel file e informazioni senza Revit: versione e build di Revit, file centrale/locale, condivisione, autore, percorso del modello centrale, identificativi; per le famiglie categoria, tipi e parametri dichiarati
- **Modifica:** Esportazione dell'anteprima in PNG, delle informazioni in TXT/JSON e, per le famiglie, IFC con i soli dati (tipi e parametri, senza geometria)

`.rfa` `.rft` `.rte` `.rvt`

## Qualsiasi altro file (byte grezzi)

- **Visualizza:** Editor esadecimale (anche file di molti GB), testo leggibile estratto, informazioni e tipo reale rilevato dal contenuto
- **Modifica:** Modifica dei byte e salvataggio

## Indice alfabetico

`.001` `.1` `.1in` `.1km` `.1m` `.1x` `.2` `.264` `.265` `.266` `.2da` `.3` `.302` `.3dm` `.3dml` `.3ds` `.3fr` `.3g2` `.3ga` `.3gp` `.3gp2` `.3gpp` `.3gpp2` `.3in` `.3m` `.3mf` `.3p` `.3pm` `.3qt` `.3x` `.4` `.4dform` `.4dm` `.4dproject` `.4gl` `.4th` `.5` `.6` `.602` `.669` `.6pl` `.6pm` `.7` `.722` `.7z` `.8` `.8svx` `.8xp` `.8xp.txt` `.9` `.a` `.a51` `.aa` `.aa3` `.aab` `.aac` `.abap` `.abnf` `.abw` `.ac` `.ac3` `.accdb` `.accde` `.action` `.ada` `.adb` `.adml` `.admx` `.ado` `.adoc` `.adp` `.ads` `.adts` `.adx` `.aea` `.aes` `.afc` `.afm` `.agc` `.agda` `.ah1` `.ah2` `.ahk` `.ahkl` `.ai` `.aidl` `.aif` `.aifc` `.aiff` `.aix` `.aj` `.ak` `.al` `.alaw` `.aleo` `.alg` `.als` `.amf` `.aml` `.ampl` `.amr` `.ams` `.amv` `.angelscript` `.anim` `.anm` `.ant` `.antlers.html` `.antlers.php` `.antlers.xml` `.apacheconf` `.apc` `.ape` `.apex` `.apib` `.apk` `.apl` `.apng` `.app` `.app.src` `.appcache` `.applescript` `.appx` `.appxbundle` `.apt` `.aptx` `.aptxhd` `.aqt` `.ar` `.arc` `.arj` `.arpa` `.arr` `.arrow` `.arw` `.as` `.asax` `.asc` `.asciidoc` `.ascx` `.asd` `.asddls` `.asf` `.ash` `.ashx` `.asl` `.asm` `.asmdot` `.asmx` `.asn` `.asn1` `.asp` `.aspx` `.ass` `.asset` `.ast` `.astro` `.asy` `.at3` `.atom` `.atomcat` `.atomdeleted` `.atomsvc` `.au` `.au3` `.aug` `.auk` `.automount` `.aux` `.av1` `.avc` `.avdl` `.avi` `.avif` `.avifs` `.avr` `.avs` `.avs2` `.avs3` `.avsc` `.avsi` `.aw` `.awb` `.awk` `.axaml` `.axd` `.axi` `.axi.erb` `.axml` `.axs` `.axs.erb` `.ay` `.azcli` `.b` `.babelrc` `.bal` `.baml` `.bas` `.bash` `.bat` `.bats` `.bay` `.bb` `.bbappend` `.bbclass` `.bbcode` `.bbx` `.bcf` `.bcfzip` `.bcstm` `.bdf` `.bdo` `.bdy` `.be` `.befunge` `.bend` `.bf` `.bfi` `.bfstm` `.bi` `.bib` `.bibtex` `.bicep` `.bicepparam` `.bik` `.bison` `.blade` `.blade.php` `.blp` `.bmml` `.bmp` `.bmv` `.bmx` `.bones` `.bonk` `.boo` `.boot` `.bowerrc` `.bpl` `.bqn` `.brd` `.brep` `.bro` `.brp` `.brs` `.brstm` `.bru` `.bs` `.bsl` `.bst` `.bsv` `.builder` `.builds` `.bvh` `.bw` `.bwf` `.bz2` `.bzip2` `.bzl` `.c` `.c++` `.c++-objdump` `.c++objdump` `.c-objdump` `.c2` `.c3` `.c93` `.cab` `.cabal` `.caddyfile` `.caf` `.cairo` `.cake` `.cap` `.capnp` `.carbon` `.cats` `.cb7` `.cbl` `.cbr` `.cbx` `.cbz` `.cc` `.ccp` `.ccproj` `.ccxml` `.cdata` `.cdc` `.cdf` `.cdfx` `.cdg` `.cdr` `.cds` `.cdxl` `.cdxml` `.cer` `.ceylon` `.cfc` `.cfg` `.cfm` `.cfml` `.cgi` `.cginc` `.ch` `.chem` `.chi` `.chm` `.chpl` `.chs` `.cii` `.cil` `.circom` `.cirru` `.cj` `.cjs` `.cjsx` `.ck` `.cl` `.cl2` `.clar` `.click` `.clixml` `.clj` `.cljc` `.cljs` `.cljs.hl` `.cljscm` `.cljx` `.clp` `.cls` `.clue` `.clw` `.cmake` `.cmake.in` `.cmd` `.cmp` `.cmv` `.cnc` `.cnf` `.cob` `.cobol` `.cocci` `.code-snippets` `.code-workspace` `.coffee` `.coffee.erb` `.coffee.md` `.com` `.command` `.conf` `.config` `.conll` `.conllu` `.container` `.containerfile` `.cook` `.coq` `.cp` `.cpio` `.cpl` `.cpp` `.cpp-objdump` `.cppm` `.cppobjdump` `.cproject` `.cps` `.cpy` `.cql` `.cr` `.cr2` `.cr3` `.cramfs` `.crc32` `.creole` `.crl` `.crt` `.crw` `.cs` `.cs.pp` `.csc` `.cscfg` `.csd` `.csdef` `.csh` `.cshtml` `.csl` `.cson` `.csp` `.csproj` `.csr` `.css` `.csv` `.csvs` `.csx` `.ct` `.ctl` `.ctp` `.cts` `.cu` `.cue` `.cuh` `.cui` `.cur` `.curl` `.curry` `.cw` `.cwl` `.cxx` `.cxx-objdump` `.cy` `.cylc` `.cyp` `.cypher` `.d` `.d-objdump` `.d2` `.dae` `.darcspatch` `.dart` `.das` `.dat` `.dats` `.daud` `.dav` `.davmount` `.dax` `.db` `.db2` `.db3` `.dbf` `.dbk` `.dbm` `.dcl` `.dcm` `.dcmp` `.dcr` `.dcurl` `.dcx` `.dd2` `.ddf` `.ddl` `.dds` `.deb` `.decls` `.def` `.depproj` `.der` `.desktop` `.desktop.in` `.device` `.dff` `.dfm` `.dfpwm` `.dft` `.dfy` `.dgn` `.dhall` `.di` `.dib` `.dic` `.dicom` `.dif` `.diff` `.digi` `.dircolors` `.dita` `.ditamap` `.ditaval` `.divx` `.diz` `.djs` `.dll.config` `.dlm` `.dm` `.dmf` `.dmg` `.dng` `.do` `.doc` `.docbook` `.dockerfile` `.docm` `.docx` `.dof` `.doh` `.dot` `.dotm` `.dotsettings` `.dotx` `.dpatch` `.dpr` `.drc` `.druby` `.drw` `.drwdot` `.dsc` `.dsf` `.dsl` `.dsm` `.dsp` `.dsr` `.dss` `.dta` `.dtb` `.dtd` `.dtk` `.dts` `.dtshd` `.dtsi` `.dtx` `.duby` `.dv` `.dvr-ms` `.dwd` `.dwf` `.dwfx` `.dwg` `.dwl` `.dwt` `.dxa` `.dxb` `.dxf` `.dyalog` `.dyl` `.dylan` `.dzn` `.e` `.e57` `.eac3` `.eam.fs` `.ear` `.eb` `.ebnf` `.ebuild` `.ec` `.ec3` `.ecl` `.eclass` `.eclxml` `.ecr` `.ect` `.edc` `.edge` `.edgeql` `.editorconfig` `.edn` `.egg` `.eh` `.eif` `.eip` `.ejs` `.ejs.t` `.el` `.eld` `.eliom` `.eliomi` `.elm` `.elv` `.em` `.emacs` `.emacs.desktop` `.emberscript` `.emf` `.eml` `.emlx` `.emma` `.emn` `.emotionml` `.emp` `.emz` `.env` `.epj` `.eps` `.epsi` `.epub` `.eq` `.erb` `.erb.deface` `.erf` `.erl` `.es` `.es3` `.es6` `.escript` `.esd` `.esdl` `.eslintrc` `.et` `.et3` `.ets` `.etx` `.evo` `.ex` `.exs` `.eye` `.f` `.f03` `.f08` `.f4a` `.f4b` `.f4v` `.f77` `.f90` `.f95` `.factor` `.fan` `.fancypack` `.fap` `.far` `.fasl` `.fb2` `.fbs` `.fbx` `.fcgi` `.fdt` `.fea` `.feather` `.feature` `.fff` `.filters` `.fir` `.fish` `.fit` `.fits` `.flac` `.flc` `.flex` `.flf` `.fli` `.flix` `.flow` `.flux` `.flv` `.flx` `.fly` `.fmv` `.fnc` `.fnl` `.fo` `.fodg` `.fodp` `.fods` `.fodt` `.for` `.forth` `.fp` `.fpp` `.fppi` `.fpx` `.fr` `.frag` `.frg` `.frm` `.frt` `.fs` `.fsb` `.fsh` `.fshader` `.fsi` `.fsproj` `.fsscript` `.fst` `.fsti` `.fsx` `.ftc` `.fth` `.ftl` `.ftlh` `.ftlx` `.fts` `.ftu` `.fun` `.fut` `.fwse` `.fx` `.fxh` `.fxml` `.fy` `.g` `.g4` `.g722` `.g723_1` `.g729` `.gaml` `.gan` `.gap` `.gawk` `.gbl` `.gbo` `.gbp` `.gbr` `.gbs` `.gco` `.gcode` `.gcrd` `.gd` `.gdb` `.gdbinit` `.gdm` `.gdnlib` `.gdns` `.gdshader` `.gdshaderinc` `.ged` `.gedcom` `.gemspec` `.genh` `.geo` `.geo.json` `.geojson` `.geom` `.gf` `.ggr` `.gi` `.gif` `.gifv` `.gitattributes` `.gitconfig` `.gitignore` `.gitmodules` `.gjs` `.gko` `.glade` `.glb` `.gleam` `.glf` `.glsl` `.glslf` `.glslv` `.gltf` `.glyphs` `.gmi` `.gml` `.gms` `.gmx` `.gn` `.gni` `.gno` `.gnu` `.gnuplot` `.go` `.god` `.gohtml` `.golo` `.gotmpl` `.gp` `.gpb` `.gpkg` `.gpl` `.gpt` `.gpx` `.gql` `.grace` `.gradle` `.gradle.kts` `.graphql` `.graphqls` `.groovy` `.grt` `.grxml` `.gs` `.gsc` `.gsh` `.gshader` `.gsm` `.gsp` `.gst` `.gsx` `.gtkrc` `.gtl` `.gto` `.gtp` `.gtpl` `.gts` `.gv` `.gvp` `.gvy` `.gx` `.gxf` `.gy` `.gym` `.gyp` `.gypi` `.gz` `.gzip` `.h` `.h++` `.h.in` `.h261` `.h264` `.h265` `.h266` `.h26l` `.h5` `.ha` `.hack` `.hal` `.haml` `.haml.deface` `.handlebars` `.har` `.hats` `.hb` `.hbs` `.hc` `.hca` `.hcl` `.hdf5` `.he5` `.heex` `.heic` `.heics` `.heif` `.heifs` `.held` `.hevc` `.hexpat` `.hfs` `.hfsx` `.hgl` `.hh` `.hhi` `.hic` `.hif` `.hip` `.hlean` `.hlsl` `.hlsli` `.hnm` `.hocon` `.hoon` `.hp` `.hpg` `.hpgl` `.hpp` `.hqf` `.hql` `.hrl` `.hs` `.hs-boot` `.hsc` `.hta` `.htaccess` `.htc` `.htm` `.html` `.html.eex` `.html.hl` `.html.tmpl` `.http` `.hujson` `.hurl` `.hwp` `.hx` `.hxml` `.hxsl` `.hxx` `.hy` `.hzp` `.i` `.i3` `.i7x` `.iam` `.iamf` `.ical` `.icalendar` `.icb` `.ice` `.iced` `.icl` `.icls` `.icns` `.ico` `.ics` `.idc` `.idf` `.idl` `.idr` `.idw` `.iecplc` `.iecst` `.ifb` `.ifc` `.ifczip` `.iff` `.ifv` `.ig` `.iges` `.igs` `.ihlp` `.iiq` `.ijm` `.ijs` `.ik` `.il` `.ily` `.im` `.imba` `.ime` `.imf` `.img` `.iml` `.imx` `.imy` `.in` `.inc` `.inf` `.ini` `.ink` `.inkml` `.inl` `.ino` `.ins` `.intr` `.io` `.iol` `.ipa` `.ipf` `.ipn` `.ipp` `.ipt` `.iptables` `.ipu` `.ipynb` `.ircam` `.irclog` `.irp` `.isl` `.ism` `.isma` `.ismv` `.iso` `.ispc` `.iss` `.it` `.its` `.iuml` `.ivf` `.ivr` `.ivy` `.ixx` `.j` `.j2` `.j2b` `.j2c` `.j2k` `.jac` `.jad` `.jade` `.jai` `.jake` `.janet` `.jar` `.jav` `.java` `.javascript` `.jbuilder` `.jcl` `.jelly` `.jfif` `.jflex` `.jinja` `.jinja2` `.jison` `.jisonlex` `.jl` `.jp2` `.jpc` `.jpe` `.jpeg` `.jpf` `.jpg` `.jpx` `.jq` `.jrd` `.js` `.js.erb` `.jsb` `.jscad` `.jscsrc` `.jse` `.jsfl` `.jsh` `.jshintrc` `.jshtm` `.jslib` `.jsm` `.json` `.json-patch` `.json-tmlanguage` `.json.example` `.json5` `.jsonc` `.jsonl` `.jsonld` `.jsonml` `.jsonnet` `.jsp` `.jspre` `.jsproj` `.jss` `.jst` `.jsx` `.jt` `.jte` `.just` `.k` `.kak` `.kar` `.kbl` `.kdc` `.kdl` `.key` `.kicad_mod` `.kicad_pcb` `.kicad_sch` `.kicad_sym` `.kicad_wks` `.kid` `.kino` `.kit` `.kk` `.kml` `.kmz` `.kojo` `.kql` `.kra` `.krl` `.ks` `.ksh` `.ksy` `.kt` `.ktm` `.kts` `.kux` `.kv` `.l` `.lagda` `.langium` `.lark` `.las` `.lasso` `.lasso8` `.lasso9` `.lasxml` `.latex` `.latte` `.launch` `.laz` `.lbe` `.lbx` `.lc3` `.lc3lib` `.ld` `.ldif` `.lds` `.lean` `.leex` `.lektorproject` `.leo` `.less` `.lex` `.lfe` `.lgr` `.lgt` `.lha` `.lhs` `.lib` `.libsonnet` `.lid` `.lidr` `.ligo` `.lin` `.link66` `.linq` `.liq` `.liquid` `.lisp` `.list` `.lit` `.litcoffee` `.livecodescript` `.livemd` `.lkml` `.ll` `.lmi` `.lobster` `.lock` `.log` `.logtalk` `.lol` `.lookml` `.lostxml` `.lp` `.lpr` `.lrc` `.ls` `.lsl` `.lslp` `.lsp` `.ltx` `.lua` `.luau` `.lvclass` `.lvf` `.lvlib` `.lvproj` `.lwo` `.lwp` `.ly` `.lz4` `.lzh` `.lzma` `.lzma86` `.m` `.m15` `.m1v` `.m2` `.m2a` `.m2t` `.m2ts` `.m2v` `.m3` `.m3u` `.m3u8` `.m4` `.m4a` `.m4b` `.m4r` `.m4v` `.m7m` `.ma` `.mac` `.mads` `.maei` `.mak` `.make` `.makefile` `.mako` `.man` `.manifest` `.mao` `.map` `.markdown` `.marko` `.mask` `.mat` `.mata` `.matah` `.mathematica` `.mathml` `.matlab` `.mawk` `.maxhelp` `.maxpat` `.maxproj` `.mbmod` `.mbox` `.mbpub` `.mbt` `.mbtiles` `.mbvid` `.mbx` `.mc` `.mc2` `.mca` `.mcfunction` `.mch` `.mcmeta` `.mcr` `.mcurl` `.md` `.md2` `.md4` `.md5` `.mdb` `.mde` `.mdl` `.mdoc` `.mdown` `.mdpolicy` `.mdtext` `.mdtxt` `.mdwn` `.mdx` `.me` `.med` `.mediawiki` `.mef` `.mermaid` `.meta` `.meta4` `.metal` `.metalink` `.mets` `.metta` `.mf` `.mg` `.mht` `.mhtml` `.mic` `.mid` `.midi` `.minid` `.mint` `.mir` `.mirah` `.mj2` `.mjml` `.mjpeg` `.mjpg` `.mjs` `.mk` `.mk3d` `.mka` `.mkd` `.mkdn` `.mkdown` `.mkfile` `.mkii` `.mkiv` `.mkv` `.mkvi` `.ml` `.ml4` `.mli` `.mligo` `.mlir` `.mll` `.mlp` `.mly` `.mm` `.mmd` `.mmk` `.mml` `.mms` `.mnu` `.mo` `.mo3` `.moc` `.mod` `.mods` `.mof` `.moflex` `.mojo` `.monkey` `.monkey2` `.moo` `.moon` `.mos` `.mount` `.mov` `.move` `.mp` `.mp+` `.mp2` `.mp2v` `.mp3` `.mp4` `.mpa` `.mpc` `.mpd` `.mpe` `.mpeg` `.mpf` `.mpg` `.mpkg` `.mpl` `.mpo` `.mpp` `.mps` `.mpt` `.mptm` `.mpv` `.mpx` `.mq4` `.mq5` `.mqh` `.mrc` `.mrcx` `.mrl` `.mrml` `.mrw` `.ms` `.msbc` `.mscml` `.msd` `.msdax` `.msf` `.msg` `.msi` `.msix` `.msp` `.mspec` `.mss` `.msu` `.mt` `.mt2` `.mtaf` `.mtl` `.mtm` `.mtml` `.mts` `.mtv` `.mu` `.mud` `.muf` `.mumps` `.mup` `.musd` `.muse` `.musicxml` `.mustache` `.musx` `.mvi` `.mxf` `.mxg` `.mxml` `.mxt` `.mysql` `.myt` `.mzn` `.n` `.n3` `.nanorc` `.nas` `.nasl` `.nasm` `.natvis` `.nawk` `.nb` `.nbp` `.nc` `.nc4` `.ncl` `.ncx` `.ndjson` `.ndproj` `.ne` `.nearley` `.ned` `.nef` `.neon` `.network` `.nf` `.nfo` `.ngc` `.nginx` `.nginxconf` `.ni` `.nim` `.nim.cfg` `.nimble` `.nimrod` `.nims` `.ninja` `.nist` `.nit` `.nix` `.njk` `.njs` `.nl` `.nlogo` `.nmake` `.no` `.nomad` `.not` `.npmrc` `.nproj` `.nqp` `.nr` `.nrw` `.nse` `.nsf` `.nsh` `.nsi` `.nsis` `.nsp` `.nss` `.nsv` `.nu` `.numbers` `.numpy` `.numpyw` `.numsc` `.nupkg` `.nuspec` `.nut` `.nvmrc` `.nwc` `.nwd` `.nwf` `.ny` `.ob2` `.obgx` `.obj` `.objdump` `.obu` `.ocl` `.odd` `.odf` `.odg` `.odin` `.odp` `.ods` `.odt` `.off` `.oga` `.ogg` `.ogm` `.ogv` `.okt` `.ol` `.oma` `.omdoc` `.omgrofl` `.ooc` `.opa` `.opal` `.opencl` `.opf` `.opml` `.opus` `.opy` `.ora` `.orc` `.orf` `.org` `.os` `.osfpvg` `.osm` `.osq` `.ost` `.otc` `.otf` `.otg` `.otp` `.ott` `.outjob` `.ova` `.overpassql` `.owl` `.owx` `.ox` `.oxh` `.oxo` `.oxps` `.oxygene` `.oz` `.p` `.p12` `.p21` `.p4` `.p6` `.p6l` `.p6m` `.p7b` `.p7c` `.p7m` `.p7s` `.p8` `.p_b` `.p_t` `.pac` `.pacscript` `.pact` `.paf` `.pages` `.pan` `.par` `.parquet` `.parrot` `.pas` `.pascal` `.pasm` `.pat` `.patch` `.path` `.pb` `.pbi` `.pbm` `.pbt` `.pbtxt` `.pc` `.pc.in` `.pcbdoc` `.pcd` `.pcf` `.pck` `.pcm` `.pcss` `.pcx` `.pd` `.pd_lua` `.pdb` `.pddl` `.pde` `.pdf` `.pef` `.peggy` `.pegjs` `.pem` `.pep` `.per` `.perl` `.pfa` `.pfm` `.pfx` `.pgm` `.pgp` `.pgsql` `.ph` `.php` `.php3` `.php4` `.php5` `.phps` `.phpt` `.phtml` `.pic` `.pig` `.pike` `.pir` `.pjp` `.pjpeg` `.pjs` `.pkb` `.pkg` `.pkgproj` `.pkl` `.pks` `.pl` `.pl6` `.pla` `.plantuml` `.plb` `.plist` `.plm` `.plot` `.pls` `.plsql` `.plt` `.pluginspec` `.plx` `.ply` `.pm` `.pm6` `.pml` `.pmod` `.pmxml` `.png` `.pnm` `.po` `.pod` `.pod6` `.podsl` `.podspec` `.pogo` `.polar` `.pony` `.por` `.postcss` `.pot` `.potm` `.potx` `.pov` `.pp` `.ppkg` `.ppm` `.pprx` `.pps` `.ppsm` `.ppsx` `.ppt` `.pptm` `.pptx` `.pq` `.pqm` `.praat` `.prawn` `.prc` `.prefab` `.prefs` `.prettierrc` `.prg` `.pri` `.prisma` `.prjpcb` `.prn` `.pro` `.proj` `.prolog` `.properties` `.props` `.proto` `.provx` `.prt` `.prtdot` `.prw` `.ps` `.ps1` `.ps1xml` `.psc` `.psc1` `.psd` `.psd1` `.psgi` `.pskcxml` `.psm` `.psm1` `.psql` `.pst` `.pt` `.pt36` `.ptm` `.pts` `.ptx` `.pub` `.pubxml` `.pug` `.puml` `.purs` `.pva` `.pwd` `.pwn` `.pxd` `.pxi` `.pxr` `.py` `.py3` `.py3x` `.pyde` `.pyi` `.pyp` `.pyt` `.pytb` `.pyw` `.pyx` `.q` `.qasm` `.qbs` `.qc` `.qcow` `.qcow2` `.qcp` `.qhelp` `.ql` `.qll` `.qmd` `.qml` `.qmlproject` `.qmltypes` `.qnt` `.qoa` `.qoi` `.qpw` `.qs` `.qt` `.r` `.r00` `.r2` `.r3` `.ra` `.rabl` `.raf` `.rake` `.raku` `.rakumod` `.ram` `.raml` `.rapd` `.rar` `.ras` `.rascript` `.raw` `.razor` `.rb` `.rbbas` `.rbfrm` `.rbi` `.rbmnu` `.rbres` `.rbs` `.rbtbar` `.rbuild` `.rbuistate` `.rbw` `.rbx` `.rbxmx` `.rbxs` `.rchit` `.rcp` `.rcs` `.rcv` `.rd` `.rdf` `.rdfs` `.rdoc` `.re` `.reb` `.rebol` `.red` `.redis` `.reds` `.reek` `.reg` `.regex` `.regexp` `.rego` `.rei` `.rej` `.religo` `.relo` `.res` `.resi` `.resource` `.rest` `.rest.txt` `.resx` `.rex` `.rexx` `.rf64` `.rfa` `.rft` `.rg` `.rgb` `.rgba` `.rhai` `.rhistory` `.rhtml` `.rif` `.ring` `.riot` `.rjs` `.rka` `.rkt` `.rktd` `.rktl` `.rl` `.rld` `.rlib` `.rm` `.rmd` `.rmi` `.rmiss` `.rmvb` `.rng` `.rnh` `.rno` `.rnw` `.robot` `.roc` `.rockspec` `.roff` `.ron` `.ronn` `.roq` `.ros` `.rpgle` `.rpl` `.rpm` `.rprofile` `.rpy` `.rq` `.rs` `.rs.in` `.rsat` `.rsc` `.rsd` `.rsh` `.rsheet` `.rso` `.rss` `.rst` `.rst.txt` `.rsx` `.rt` `.rte` `.rtf` `.rtx` `.ru` `.ruby` `.rusd` `.rviz` `.rvt` `.rw2` `.rwl` `.rwz` `.s` `.s16le` `.s3db` `.s3m` `.sage` `.sagews` `.sail` `.sarif` `.sas` `.sas7bdat` `.sass` `.sats` `.sav` `.sb` `.sbatch` `.sbc` `.sbml` `.sbt` `.sbv` `.sc` `.scad` `.scala` `.scaml` `.scc` `.scd` `.sce` `.scenic` `.sch` `.schdoc` `.sci` `.scm` `.sco` `.scope` `.scpt` `.scr` `.scrbl` `.scss` `.scurl` `.scxml` `.sd` `.sd2` `.sdb` `.sdc` `.sdkd` `.sdkm` `.sds` `.sed` `.self` `.senmlx` `.sensmlx` `.ser` `.service` `.sexp` `.sf` `.sfd` `.sfproj` `.sfv` `.sgi` `.sgm` `.sgml` `.sh` `.sh-session` `.sh.in` `.sha1` `.sha2` `.sha224` `.sha256` `.sha256sum` `.sha3` `.sha384` `.sha512` `.shader` `.shen` `.shex` `.shf` `.shn` `.shp` `.shproj` `.shtml` `.shx` `.sieve` `.sig` `.sip` `.sj` `.sjs` `.skp` `.sl` `.sl3` `.slang` `.sld` `.sldasm` `.slddrw` `.sldprt` `.slice` `.slim` `.slint` `.slk` `.slm` `.sln` `.slnlaunch` `.slnx` `.sls` `.slurm` `.sma` `.smali` `.smi` `.smil` `.smithy` `.smk` `.sml` `.smt` `.smt2` `.snakefile` `.snap` `.snd` `.sndanim` `.snip` `.snippet` `.snippets` `.socket` `.sol` `.son` `.soy` `.sp` `.sparql` `.spc` `.spdx` `.spec` `.spf` `.sph` `.spi` `.spin` `.spot` `.sps` `.spx` `.sqf` `.sql` `.sqlite` `.sqlite3` `.sqlrpgle` `.squashfs` `.sr2` `.sra` `.srdf` `.srf` `.srt` `.sru` `.srv` `.srw` `.srx` `.ss` `.ss2` `.ssa` `.ssdl` `.ssjs` `.ssml` `.sss` `.st` `.st26` `.stan` `.star` `.step` `.sthlp` `.stk` `.stl` `.stm` `.ston` `.story` `.storyboard` `.stp` `.stpx` `.stpz` `.str` `.sttheme` `.sty` `.styl` `.stylus` `.sub` `.sublime-build` `.sublime-color-scheme` `.sublime-commands` `.sublime-completions` `.sublime-keymap` `.sublime-macro` `.sublime-menu` `.sublime-mousemap` `.sublime-project` `.sublime-settings` `.sublime-snippet` `.sublime-syntax` `.sublime-theme` `.sublime-workspace` `.sublime_metrics` `.sublime_session` `.sum` `.surql` `.sv` `.svag` `.svelte` `.svg` `.svgz` `.svh` `.svx` `.sw` `.swap` `.swf` `.swg` `.swidtag` `.swift` `.swig` `.swm` `.sxc` `.sxd` `.sxi` `.sxw` `.sylk` `.syntax` `.systemverify` `.t` `.t2t` `.tab` `.tac` `.tact` `.tag` `.tak` `.talon` `.tap` `.tape` `.tar` `.target` `.targets` `.taz` `.tbz` `.tbz2` `.tcc` `.tcdut` `.tcgvl` `.tcio` `.tcl` `.tcl.in` `.tcpou` `.tcsh` `.td` `.te` `.tea` `.tei` `.teicorpus` `.templ` `.tesc` `.tese` `.tex` `.texi` `.texinfo` `.text` `.textgrid` `.textile` `.textproto` `.tf` `.tfi` `.tfstate` `.tfstate.backup` `.tftpl` `.tfvars` `.tga` `.tgq` `.tgz` `.thd` `.thor` `.thp` `.thrift` `.thy` `.tif` `.tiff` `.timer` `.tk` `.tl` `.tla` `.tlv` `.tlz4` `.tm` `.tmac` `.tmcommand` `.tmdl` `.tml` `.tmlanguage` `.tmpl` `.tmpreferences` `.tmsnippet` `.tmtheme` `.tmux` `.tmv` `.toc` `.tod` `.tofu` `.toit` `.tolk` `.toml` `.toml.example` `.tool` `.topojson` `.tp` `.tpb` `.tpl` `.tpp` `.tps` `.tpz` `.tr` `.trec` `.tres` `.trg` `.trigger` `.trp` `.truehd` `.ts` `.tscn` `.tsconfig.json` `.tsd` `.tsp` `.tsrx` `.tst` `.tsv` `.tsx` `.tta` `.ttc` `.ttf` `.ttl` `.ttml` `.tu` `.twig` `.txd` `.txi` `.txl` `.txt` `.txtpb` `.txx` `.txz` `.ty` `.ty+` `.typ` `.tzst` `.u3d` `.ua` `.ub` `.uc` `.udf` `.udo` `.ui` `.uil` `.ul` `.ulaw` `.ult` `.umx` `.unity` `.uno` `.uo` `.uoml` `.upc` `.uplc` `.ur` `.urdf` `.uri` `.uris` `.url` `.urls` `.urs` `.usdz` `.usm` `.uu` `.uue` `.uvt` `.uvvt` `.uw` `.ux` `.v` `.vag` `.vala` `.vapi` `.vark` `.vb` `.vba` `.vbe` `.vbhtml` `.vbproj` `.vbs` `.vc1` `.vcard` `.vcf` `.vcl` `.vcs` `.vct` `.vcxproj` `.vda` `.vdf` `.vdi` `.vec` `.veo` `.verse` `.vert` `.vh` `.vhd` `.vhdl` `.vhf` `.vhi` `.vho` `.vhost` `.vhs` `.vht` `.vhw` `.vim` `.vimrc` `.viw` `.vmb` `.vmdk` `.vmf` `.vob` `.voc` `.volt` `.vox` `.vp6` `.vp8` `.vp9` `.vpk` `.vpy` `.vqa` `.vqe` `.vqf` `.vql` `.vrml` `.vro` `.vrx` `.vs` `.vsd` `.vsdm` `.vsdx` `.vsh` `.vshader` `.vsix` `.vsixmanifest` `.vssettings` `.vssm` `.vssx` `.vst` `.vstemplate` `.vstm` `.vstx` `.vtk` `.vtl` `.vto` `.vtp` `.vtt` `.vue` `.vvc` `.vw` `.vxml` `.vy` `.w` `.w2d` `.w64` `.wadl` `.war` `.wast` `.wat` `.watchr` `.wav` `.wave` `.wbs` `.wdl` `.webapp` `.webidl` `.webm` `.webmanifest` `.webp` `.weechatlog` `.wesl` `.wgsl` `.whiley` `.whl` `.wif` `.wiki` `.wikitext` `.wim` `.wisp` `.wit` `.wixproj` `.wk1` `.wk3` `.wks` `.wl` `.wlk` `.wls` `.wlt` `.wlua` `.wma` `.wmf` `.wml` `.wmls` `.wmv` `.wmz` `.woff` `.woff2` `.workbook` `.workflow` `.wow` `.wpd` `.wps` `.wpt` `.wren` `.wri` `.wrl` `.ws` `.wsd` `.wsdl` `.wsf` `.wsgi` `.wspolicy` `.wtv` `.wv` `.wve` `.wxi` `.wxl` `.wxs` `.x` `.x10` `.x3d` `.x3dz` `.x3f` `.x68` `.x_b` `.x_t` `.xa` `.xacro` `.xaml` `.xapk` `.xar` `.xav` `.xbl` `.xbm` `.xc` `.xca` `.xcf` `.xcs` `.xdc` `.xdcf` `.xdf` `.xdm` `.xdp` `.xdssc` `.xel` `.xenc` `.xer` `.xht` `.xhtm` `.xhtml` `.xhvml` `.xi` `.xib` `.xip` `.xlf` `.xliff` `.xls` `.xlsb` `.xlsm` `.xlsx` `.xlt` `.xltm` `.xltx` `.xm` `.xmd` `.xmi` `.xmind` `.xml` `.xml.dist` `.xmp` `.xmp_bin` `.xmp_txt` `.xmt_bin` `.xmt_txt` `.xmv` `.xns` `.xojo_code` `.xojo_menu` `.xojo_report` `.xojo_script` `.xojo_toolbar` `.xojo_window` `.xop` `.xpi` `.xpk` `.xpl` `.xpm` `.xproc` `.xproj` `.xps` `.xpt` `.xpy` `.xq` `.xql` `.xqm` `.xquery` `.xqy` `.xrl` `.xs` `.xsd` `.xsf` `.xsh` `.xsjs` `.xsjslib` `.xsl` `.xslfo` `.xslt` `.xsm` `.xsp-config` `.xsp.metadata` `.xspec` `.xspf` `.xtend` `.xul` `.xvag` `.xvid` `.xvm` `.xvml` `.xyz` `.xz` `.xzap` `.y` `.y4m` `.yacc` `.yaml` `.yaml-tmlanguage` `.yaml.sed` `.yang` `.yap` `.yar` `.yara` `.yasnippet` `.yin` `.yml` `.yml.mysql` `.ymp` `.yop` `.yrl` `.yul` `.yuv` `.yy` `.yyp` `.z` `.z01` `.z3` `.zabw` `.zap` `.zaz` `.zcml` `.zed` `.zeek` `.zep` `.zig` `.zig.zon` `.zil` `.zimpl` `.zip` `.zipx` `.zmm` `.zmodel` `.zmpl` `.znm` `.zone` `.zpl` `.zs` `.zsav` `.zsh` `.zsh-theme` `.zst` `.zstd`
