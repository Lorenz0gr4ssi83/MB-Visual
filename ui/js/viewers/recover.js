// Recupero dei file danneggiati, illeggibili o di tipo sconosciuto (motore: mbvisual/recover.py, API recover).
// Si apre al posto del visualizzatore quando: il controllo veloce all'apertura trova il file danneggiato (ctx.recovery.mode
// "damaged"), il visualizzatore non riesce a mostrarlo ("error", da showRecovery) o l'estensione non e' nell'elenco ("unknown").
// Dice cosa e' successo, cosa si e' recuperato e propone: Apri il recuperato, Salva la copia riparata, Aprilo come X,
// file incorporati, testo leggibile, vista esadecimale. L'originale non si modifica mai (il motore lavora su copie in TEMP).
import { api, baseName, dirName, el, fileUrl, fmtSize, loadCss, pickSavePath, readBytes, toast, waitJob, WEB } from "../core.js";
import { t as tr, tn, fmtDateTime } from "../i18n.js";

const ICON = {
  warn: '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2zM12 10v5M12 18v.5"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v15H5zM8 3v6h8V3M8 21v-7h8v7"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M5 5h14M12 5v14M9 19h6"/></svg>',
  hex: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M4 4h16v12H4zM8 20h8M12 16v4"/></svg>',
};
const MAX_COPY = 1.5 * 1024 ** 3; // "aprilo come": oltre questa dimensione si apre l'originale col visualizzatore scelto

function btn(label, icon, onclick, primary = false) {
  const b = el("button", { class: "btn" + (primary ? " primary" : ""), type: "button" });
  if (icon) b.insertAdjacentHTML("beforeend", ICON[icon] || "");
  b.append(label);
  b.addEventListener("click", onclick);
  return b;
}

// visualizzatore che non riesce a mostrare il file: la stessa schermata, con il messaggio di errore
export async function showRecovery(ctx, error) {
  ctx.el.innerHTML = "";
  ctx.tb.innerHTML = "";
  ctx.recovery = { mode: "error", error: String(error?.message || error || ""), intended: ctx.tab?.viewer };
  return mount(ctx);
}

export async function mount(ctx) {
  loadCss("css/recover.css");
  const R = ctx.recovery || { mode: "unknown" };
  const mode = R.mode;
  ctx.fillBody(false);
  const page = el("div", { class: "rc" });
  ctx.el.append(page);

  // ---- intestazione: cosa e' successo
  const chip = { damaged: ["warn", tr("rec.chip_danneggiato")], error: ["bad", tr("rec.chip_non_aperto")], unknown: ["mute", tr("rec.chip_sconosciuto")], manual: ["mute", tr("rec.chip_analisi")] }[mode];
  const title = { damaged: tr("rec.titolo_danneggiato"), error: tr("rec.titolo_errore"), unknown: tr("rec.titolo_sconosciuto"), manual: tr("rec.titolo_analisi") }[mode];
  const what = mode === "damaged" ? (R.check?.motivo || "") : mode === "error" ? R.error : mode === "manual" ? tr("rec.nessun_danno_rilevato")
    : tr("rec.estensione_non_in_elenco", ctx.ext ? "." + ctx.ext : tr("rec.nessuna_estensione"));
  const head = el("section", { class: "rc-head" },
    el("div", { class: "rc-ico" + (mode === "unknown" ? " mute" : ""), html: mode === "unknown" ? ICON.file : ICON.warn }),
    el("div", { class: "rc-headtxt" },
      el("div", { class: "rc-line" }, el("span", { class: "chip " + chip[0] }, chip[1]), el("span", { class: "rc-meta" }, `${fmtSize(ctx.info.size)} · ${fmtDateTime(new Date(ctx.info.modificato * 1000))}`)),
      el("h2", {}, title),
      el("p", { class: "rc-name" }, ctx.name),
      what ? el("p", { class: mode === "unknown" || mode === "manual" ? "rc-what" : "rc-what err" }, what) : null,
      el("p", { class: "rc-safe" }, tr("rec.originale_intatto"))));
  page.append(head);

  // ---- riconoscimento dal contenuto
  const idBox = el("section", { class: "rc-card" }, el("h3", {}, tr("rec.riconoscimento")), el("p", { class: "note" }, tr("rec.analisi_contenuto")));
  page.append(idBox);
  // ---- recupero
  const recBox = el("section", { class: "rc-card", hidden: true });
  page.append(recBox);
  // ---- file incorporati
  const carveBox = el("section", { class: "rc-card", hidden: true });
  page.append(carveBox);
  // ---- altre strade
  const more = el("section", { class: "rc-card" }, el("h3", {}, tr("rec.altre_strade")));
  const moreBtns = el("div", { class: "rc-btns" });
  more.append(moreBtns);
  page.append(more);

  if (WEB) { // nella web app il motore di recupero non c'e': restano le strade del browser
    idBox.hidden = true;
    moreBtns.append(btn(tr("rec.vista_esadecimale"), "hex", () => ctx.openAs("hex"), true), btn(tr("rec.apri_come_testo"), "text", () => ctx.openAs("text")));
    return {};
  }

  if ((mode === "damaged" || mode === "manual") && R.intended) moreBtns.append(btn(tr("rec.apri_originale_comunque"), "open", () => ctx.openAs(R.intended)));
  moreBtns.append(
    btn(tr("rec.cerca_incorporati"), "search", () => runCarve()),
    btn(tr("rec.estrai_testo"), "text", async () => {
      try { const r = await api("recover", { op: "text", path: ctx.path }); if (!r.righe) return toast(tr("rec.nessun_testo"), true); ctx.openFile(r.path); }
      catch (e) { toast(e.message, true); }
    }),
    btn(tr("rec.vista_esadecimale"), "hex", () => ctx.openAs("hex")),
    btn(tr("rec.apri_programma_windows"), "ext", () => api("open_external", { path: ctx.path }).catch(e => toast(e.message, true))));

  // ---- riconoscimento
  let ident = null;
  try { ident = await api("recover", { op: "identify", path: ctx.path }); } catch (e) { idBox.querySelector(".note").textContent = e.message; }
  if (ident) renderIdent(ident);

  function renderIdent(r) {
    idBox.innerHTML = "";
    idBox.append(el("h3", {}, tr("rec.riconoscimento")));
    const g = r.guesses || [];
    if (!g.length) { idBox.append(el("p", { class: "note" }, tr("rec.nessuna_firma"))); return; }
    const list = el("div", { class: "rc-list" });
    for (const x of g) {
      const same = x.ext === ctx.ext;
      const { cat } = window.MB.resolveCategory("x." + x.ext, null);
      const row = el("div", { class: "rc-row" },
        el("span", { class: "rc-badge" }, x.ext.toUpperCase().slice(0, 5)),
        el("div", { class: "rc-rowtxt" }, el("b", {}, x.descr), el("span", { class: "note" }, tr("rec.certezza_" + x.certezza) + (same ? " · " + tr("rec.stessa_estensione") : ""))));
      if (cat && (!same || mode === "unknown") && !x.offset) row.append(btn(tr("rec.aprilo_come", x.label), "open", () => openAsExt(x.ext, cat.viewer), mode === "unknown" && x === g[0]));
      else if (x.offset) row.append(btn(tr("rec.cerca_incorporati"), "search", () => runCarve()));
      list.append(row);
    }
    idBox.append(list);
  }

  async function openAsExt(ext, viewer) {
    try {
      if (ctx.info.size > MAX_COPY) return ctx.openAs(viewer);
      const r = await api("recover", { op: "as_ext", path: ctx.path, ext });
      toast(tr("rec.aperta_copia"), false, 4000);
      ctx.openFile(r.path);
    } catch (e) { toast(e.message, true); }
  }

  // ---- recupero automatico se il file e' danneggiato o non si e' aperto
  if (mode !== "unknown") runRecover();
  // file sconosciuto senza una firma certa in testa: subito la ricerca dei file incorporati
  else if (!(ident?.guesses || []).some(g => !g.offset && g.certezza !== "bassa" && window.MB.resolveCategory("x." + g.ext, null).cat)) runCarve(true);

  async function runRecover() {
    recBox.hidden = false;
    recBox.innerHTML = "";
    const bar = el("div", { class: "progress" }, el("span"));
    const msg = el("p", { class: "note" }, tr("rec.recupero_in_corso"));
    recBox.append(el("h3", {}, tr("rec.recupero")), msg, bar);
    let res;
    try {
      const { job } = await api("recover", { op: "start", path: ctx.path, fam: R.check?.famiglia || "" });
      res = await waitJob(job, p => (bar.firstChild.style.width = Math.round(p * 100) + "%"));
    } catch (e) { msg.textContent = e.message; msg.classList.add("err"); bar.remove(); return; }
    if (res.dwg) {
      msg.textContent = tr("rec.dwg_rilettura");
      try { await dwgTolerant(res); } catch (e) { res.messaggi.push(tr("rec.dwg_non_riletto", e.message)); }
    }
    bar.remove();
    renderResult(res);
  }

  // DWG: libredwg senza fermarsi agli errori (anche dati incompleti), poi con il file allungato di zeri per le sezioni
  // troncate; il disegno letto diventa un DXF nella cartella di recupero (motore ezdxf, come la stampa)
  async function dwgTolerant(res) {
    const { normalize } = await import("./cad2d.js");
    const m = await import("/vendor/libredwg/dist/libredwg-web.js");
    const bytes = await readBytes(ctx.path);
    let got = null;
    for (const pad of [0, 0.3, 1.5]) {
      const buf = pad ? new Uint8Array(bytes.length + Math.round(bytes.length * pad)) : bytes;
      if (pad) buf.set(bytes);
      let lib = await m.LibreDwg.create("/vendor/libredwg/wasm");
      try {
        const W = lib.wasmInstance;
        W.FS.writeFile("recupero.dwg", buf);
        const r = W.dwg_read_file("recupero.dwg");
        try { W.FS.unlink("recupero.dwg"); } catch { /* */ }
        if (r && r.data) {
          const db = lib.convert(r.data);
          if (db?.entities?.length) { got = { db, code: r.error, pad }; break; }
        }
      } catch (e) { console.warn("libredwg", pad, e); }
      lib = null;
    }
    if (!got) { res.messaggi.push(tr("rec.dwg_nessuna_entita")); return; }
    const db = got.db;
    normalize(db, "dwg");
    const plain = (k, v) => (typeof v === "bigint" ? Number(v) : k === "xdata" ? undefined : v);
    const ltypes = (db.tables?.LTYPE?.entries || []).map(t => ({ name: t.name, pattern: (t.pattern || []).map(p => +p.elementLength || 0), description: t.description || "" }));
    const edits = JSON.parse(JSON.stringify({ source: "dwg", layers: [], ltypes, db: { header: db.header, tables: { LAYER: db.tables?.LAYER, DIMSTYLE: db.tables?.DIMSTYLE, BLOCK_RECORD: db.tables?.BLOCK_RECORD }, entities: db.entities } }, plain));
    const { path: out } = await api("recover", { op: "out", path: ctx.path, name: ctx.name.replace(/\.[^.]+$/, "") + " (recuperato).dxf" });
    await api("cad_save", { path: ctx.path }, { json: { out, edits } });
    res.copia = { path: out, nome: baseName(out), ext: "dxf" };
    res.messaggi.unshift(tn("rec.dwg_entita", db.entities.length));
    if (got.pad) res.messaggi.push(tr("rec.dwg_troncato"));
    res.esito = got.code || got.pad ? "parziale" : "riparato";
  }

  function renderResult(res) {
    recBox.innerHTML = "";
    const es = { riparato: ["ok", tr("rec.esito_riparato")], parziale: ["warn", tr("rec.esito_parziale")], nulla: ["bad", tr("rec.esito_nulla")] }[res.esito] || ["mute", res.esito];
    recBox.append(el("div", { class: "rc-line" }, el("h3", {}, tr("rec.recupero")), el("span", { class: "chip " + es[0] }, es[1])));
    if (res.messaggi?.length) recBox.append(el("ul", { class: "rc-msgs" }, ...res.messaggi.map(m => el("li", {}, m))));
    if (res.anteprima) recBox.append(el("figure", { class: "rc-prev" }, el("img", { src: fileUrl(res.anteprima, "&v=" + Date.now()), alt: "" }), el("figcaption", { class: "note" }, res.famiglia === "dwg" ? tr("rec.anteprima_incorporata") : tr("rec.parte_recuperata"))));
    const c = res.copia;
    if (c) {
      recBox.append(el("div", { class: "rc-copy" },
        el("span", { class: "rc-badge" }, (c.ext || "?").toUpperCase().slice(0, 5)),
        el("div", { class: "rc-rowtxt" }, el("b", {}, c.nome), el("span", { class: "note" }, c.size ? fmtSize(c.size) : "")),
        el("div", { class: "rc-btns" },
          btn(tr("rec.apri_recuperato"), "open", () => ctx.openFile(c.path), true),
          btn(tr("rec.salva_copia"), "save", () => saveCopy(c.path, c.nome)))));
    }
    if (res.alternative?.length) {
      recBox.append(el("h4", {}, tr("rec.copie_sicurezza")));
      const list = el("div", { class: "rc-list" });
      for (const a of res.alternative) list.append(el("div", { class: "rc-row" },
        el("span", { class: "rc-badge" }, a.tipo.toUpperCase()),
        el("div", { class: "rc-rowtxt" }, el("b", {}, a.nome), el("span", { class: "note" }, `${fmtSize(a.size)} · ${fmtDateTime(new Date(a.data * 1000))} · ${a.origine}`)),
        el("div", { class: "rc-btns" }, btn(tr("rec.apri"), "open", () => ctx.openFile(a.path), true), btn(tr("rec.salva_dwg"), "save", () => saveCopy(a.path, a.nome.replace(/\.(bak|sv\$)$/i, "") + ".dwg")))));
      recBox.append(list);
    }
    if (res.elementi?.length) renderItems(recBox, res.elementi, res.famiglia === "email" ? tr("rec.allegati") : tr("rec.file_incorporati"));
  }

  function renderItems(box, items, label) {
    box.append(el("h4", {}, label + " · " + items.length));
    const list = el("div", { class: "rc-list" });
    for (const x of items.slice(0, 300)) list.append(el("div", { class: "rc-row" },
      el("span", { class: "rc-badge" }, (x.ext || "?").toUpperCase().slice(0, 5)),
      el("div", { class: "rc-rowtxt" }, el("b", {}, x.nome), el("span", { class: "note" }, fmtSize(x.size) + (x.offset !== undefined ? " · " + tr("rec.offset", "0x" + x.offset.toString(16).toUpperCase()) : ""))),
      el("div", { class: "rc-btns" }, btn(tr("rec.apri"), "open", () => ctx.openFile(x.path)), btn(tr("rec.salva"), "save", () => saveCopy(x.path, x.nome)))));
    box.append(list);
  }

  async function runCarve(auto = false) {
    carveBox.hidden = false;
    carveBox.innerHTML = "";
    const bar = el("div", { class: "progress" }, el("span"));
    carveBox.append(el("h3", {}, tr("rec.file_incorporati")), el("p", { class: "note" }, tr("rec.ricerca_incorporati")), bar);
    try {
      const { job } = await api("recover", { op: "carve", path: ctx.path });
      const r = await waitJob(job, p => (bar.firstChild.style.width = Math.round(p * 100) + "%"));
      carveBox.innerHTML = "";
      carveBox.append(el("h3", {}, tr("rec.file_incorporati")));
      if (!r.elementi.length) {
        if (auto) { carveBox.hidden = true; return; }
        carveBox.append(el("p", { class: "note" }, tr("rec.nessun_incorporato")));
      } else renderItems(carveBox, r.elementi, tr("rec.trovati"));
      if (r.troncato) carveBox.append(el("p", { class: "note" }, tr("rec.letto_solo_inizio", fmtSize(r.letti))));
    } catch (e) { carveBox.append(el("p", { class: "err" }, e.message)); }
  }

  // la copia va dove sceglie l'utente, mai sopra l'originale (controllato anche dal motore)
  async function saveCopy(src, name) {
    const target = await pickSavePath(name, dirName(ctx.path));
    if (!target) return;
    if (target.toLowerCase() === ctx.path.toLowerCase()) return toast(tr("rec.mai_sopra_originale"), true, 6000);
    try {
      await api("recover", { op: "save", path: ctx.path }, { json: { src, out: target } });
      toast(tr("rec.salvato_in", target), false, 5000);
    } catch (e) { toast(e.message, true, 6000); }
  }

  return { noConvert: true };
}
