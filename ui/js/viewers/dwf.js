// Autodesk DWF / DWFx (e XPS): elenco dei fogli e dei modelli, fogli 2D vettoriali (W2D e FixedPage XPS), modelli 3D
// (W3D/HSF) nel visualizzatore 3D, layer, proprieta' degli oggetti, marcature, ricerca dei testi, misure, esportazioni.
import { api, button, el, loading, readBytes, saveBlobAs, toast, withExt, WEB, dirName } from "../core.js";
import { openPackage } from "../dwfpkg.js";
import { prepareSheet, drawSheet, pick, snap, buildIndex, primBBox, primQuad } from "../dwfdraw.js";
import { sheetToPng, sheetToSvg, sheetsToPdf } from "../dwfexport.js";

const fmt = (v, d = 4) => (isFinite(v) ? v.toLocaleString("it-IT", { maximumFractionDigits: d }) : "-");
const UNIT_LABEL = { mm: "mm", in: "in", ft: "ft", m: "m", cm: "cm", ftin: "" };
// valore in pollici -> 12'-6 1/2"
function feetInches(v) {
  const neg = v < 0; v = Math.abs(v);
  let ft = Math.floor(v / 12), inch = v - ft * 12;
  let sixteenths = Math.round(inch * 16);
  if (sixteenths >= 192) { ft++; sixteenths -= 192; }
  const whole = Math.floor(sixteenths / 16), frac = sixteenths % 16;
  const g = (a, b) => (b ? g(b, a % b) : a), d = frac ? g(frac, 16) : 1;
  return `${neg ? "-" : ""}${ft}'-${whole}${frac ? ` ${frac / d}/${16 / d}` : ""}"`;
}
const fmtU = (v, u, d = 4) => (u?.name === "ftin" ? feetInches(v) : fmt(v, d));

export async function mount(ctx) {
  const ld = loading(ctx.el, "Lettura del file DWF");
  const bytes = await readBytes(ctx.path);
  const pkg = await openPackage(bytes, ctx.name);
  if (!pkg.sheets.length) throw new Error("Il file non contiene fogli o modelli visualizzabili");
  ctx.el.innerHTML = "";
  ctx.fillBody(true);

  // ---- interfaccia: pannello laterale a schede + area di disegno
  const tabsBar = el("div", { class: "seg", style: { margin: "8px 8px 4px", display: "flex" } });
  const panes = {};
  const TABS = [["fogli", "Fogli"], ["layer", "Layer"], ["oggetti", "Proprieta'"], ["marcature", "Marcature"], ["cerca", "Cerca"]];
  for (const [id, label] of TABS) {
    const b = el("button", { class: "btn", style: { flex: "1", justifyContent: "center", padding: "0 4px", fontSize: "12px" }, onclick: () => showPane(id) }, label);
    b.dataset.pane = id;
    tabsBar.append(b);
    panes[id] = el("div", { style: { display: "none", minHeight: 0, overflow: "auto", flex: "1 1 auto" } });
  }
  const sidePanel = el("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" } }, tabsBar, ...Object.values(panes));
  const canvas = el("canvas", { class: "fill", style: { touchAction: "none", display: "block", width: "100%", height: "100%" } });
  const stage = el("div", { style: { position: "relative", overflow: "hidden", minHeight: 0, minWidth: 0 } }, canvas);
  const host3d = el("div", { style: { display: "none", minHeight: 0, minWidth: 0, flexDirection: "column" } });
  const main = el("div", { style: { display: "grid", minHeight: 0, minWidth: 0 } }, stage, host3d);
  const wrap = el("div", { class: "side", style: { gridTemplateColumns: "290px 1fr" } }, sidePanel, main);
  ctx.el.append(wrap);
  let pane = "fogli";
  function showPane(id) {
    pane = id;
    for (const [k, p] of Object.entries(panes)) p.style.display = k === id ? "block" : "none";
    for (const b of tabsBar.children) b.classList.toggle("on", b.dataset.pane === id);
  }

  // ---- stato
  let sheet = null, prep = null, cur = null, api3d = null;
  const view = { s: 1, tx: 0, ty: 0 };
  const hiddenLayers = new Set();
  let showText = true, thinLines = false, dark = false, showMarkups = true;
  let mode = "sel"; // sel | dist | area
  let mpts = [], msnap = null, mouse = null;
  let highlight = new Set(), selIndex = null, raf = 0;
  const sheetCache = new Map();
  ctx.el.__dwf = { pkg, get sheet() { return sheet; }, get view() { return view; }, canvas: () => canvas, open: id => openSheet(pkg.sheets.find(s => s.id === id || s.title === id)), pick: (x, y) => pickAt(x, y) }; // per i collaudi

  // ---- barra degli strumenti (2D)
  const tb2d = [];
  const bFit = button("Adatta", "fit", () => fit());
  const bIn = button("", "zoomIn", () => zoomAt(1.4), { iconOnly: true, title: "Ingrandisci" });
  const bOut = button("", "zoomOut", () => zoomAt(1 / 1.4), { iconOnly: true, title: "Riduci" });
  const bSel = button("Seleziona", "", () => setMode("sel"), { title: "Clic su un elemento: proprieta' dell'oggetto" });
  const bDist = button("Distanza", "ruler", () => setMode("dist"), { title: "Distanza tra due punti (aggancio a estremi e punti medi)" });
  const bArea = button("Area", "", () => setMode("area"), { title: "Area e perimetro: clic sui vertici, doppio clic o Invio per chiudere" });
  const bText = button("Testi", "text", () => { showText = !showText; bText.classList.toggle("on", showText); draw(); });
  const bThin = button("Linee sottili", "", () => { thinLines = !thinLines; bThin.classList.toggle("on", thinLines); draw(); }, { title: "Mostra tutte le linee con lo spessore minimo" });
  const bMk = button("Marcature", "", () => { showMarkups = !showMarkups; bMk.classList.toggle("on", showMarkups); draw(); });
  const bDark = button("Sfondo scuro", "sun", () => { dark = !dark; bDark.lastChild.textContent = dark ? "Carta bianca" : "Sfondo scuro"; draw(); });
  const bPng = button("PNG", "download", () => exportCur("png"), { title: "Foglio come immagine PNG (200 dpi)" });
  const bSvg = button("SVG", "download", () => exportCur("svg"), { title: "Foglio in SVG vettoriale" });
  const bPdf = button("PDF", "download", () => exportCur("pdf"), { title: "Foglio in PDF vettoriale (Salva con nome: tutti i fogli)" });
  bText.classList.add("on"); bMk.classList.add("on");
  tb2d.push(bFit, bIn, bOut, el("span", { class: "sep" }), bSel, bDist, bArea, el("span", { class: "sep" }), bText, bThin, bMk, bDark, el("span", { class: "sep" }), bPng, bSvg, bPdf);
  const tbNote = el("span", { class: "note" }, "Rotella: zoom · trascina: sposta · doppio clic: adatta");
  const tb2dBox = el("span", { style: { display: "contents" } }, ...tb2d, el("span", { class: "grow" }), tbNote);
  const tb3dBox = el("span", { style: { display: "none" } });
  ctx.tb.append(tb2dBox, tb3dBox);
  function setMode(m) {
    mode = m; mpts = []; msnap = null;
    bSel.classList.toggle("on", m === "sel"); bDist.classList.toggle("on", m === "dist"); bArea.classList.toggle("on", m === "area");
    draw();
  }
  setMode("sel");

  // ---- elenco dei fogli
  const sheetList = el("div", { class: "tree" });
  panes.fogli.append(sheetList);
  const kindLabel = { "2d": "Foglio 2D", "3d": "Modello 3D", data: "Dati" };
  for (const s of pkg.sheets) {
    const img = el("img", { style: { width: "64px", height: "46px", objectFit: "contain", background: "#fff", border: "1px solid var(--line)", flex: "none" } });
    const row = el("div", { class: "node", style: { alignItems: "center", padding: "6px 10px", whiteSpace: "normal" }, onclick: () => openSheet(s) },
      img, el("div", { style: { minWidth: 0 } }, el("div", { style: { fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis" } }, s.title), el("div", { class: "note" }, kindLabel[s.kind] || s.kind)));
    row.dataset.id = s.id;
    sheetList.append(row);
    if (s.thumb) pkg.read(s.thumb).then(b => { if (b) img.src = URL.createObjectURL(new Blob([b], { type: /\.jpe?g$/i.test(s.thumb) ? "image/jpeg" : "image/png" })); }).catch(() => {});
    else img.style.visibility = "hidden";
  }
  if (pkg.props.length) {
    const dl = el("dl", { class: "kv", style: { padding: "8px 10px", fontSize: "12px" } });
    for (const p of pkg.props) dl.append(el("dt", {}, p.name), el("dd", { style: { margin: 0, overflowWrap: "anywhere" } }, p.value));
    panes.fogli.append(el("div", { style: { padding: "8px 10px 0", fontWeight: "600", borderTop: "1px solid var(--line)" } }, "Pubblicazione"), dl);
  }

  // ---- apertura di un foglio / modello
  async function openSheet(s) {
    if (!s) return;
    for (const r of sheetList.children) r.classList.toggle("sel", r.dataset.id === s.id);
    cur = s;
    if (s.kind === "3d") return open3d(s);
    if (s.kind === "data") { toast("Questa sezione contiene solo dati (struttura e proprieta'), senza grafica", false, 4000); return; }
    host3d.style.display = "none"; stage.style.display = "block"; tb2dBox.style.display = "contents"; tb3dBox.style.display = "none";
    const ov = el("div", { style: { position: "absolute", inset: "0", display: "grid", placeItems: "center", background: "rgba(0,0,0,.25)", color: "#fff", fontSize: "14px" } }, el("div", { style: { background: "rgba(0,0,0,.7)", padding: "10px 16px", borderRadius: "6px" } }, "Lettura del foglio \"" + s.title + "\"..."));
    stage.append(ov);
    await new Promise(r => setTimeout(r, 30));
    try {
      let sh = sheetCache.get(s.id);
      if (!sh) { sh = await s.load(); sheetCache.set(s.id, sh); }
      const pr = await prepareSheet(sh);
      buildIndex(sh);
      sheet = sh; prep = pr;
      for (const L of sheet.layers.values()) if (!L.on) hiddenLayers.add(L.name);
      highlight = new Set(); selIndex = null; mpts = [];
      renderLayers(); renderMarkups(); renderProps(null); searchBox.value = ""; renderSearch();
      tbNote.textContent = sheet.warnings.length ? "Lettura parziale: " + sheet.warnings[0] : "Rotella: zoom · trascina: sposta · doppio clic: adatta";
      bMk.style.display = sheet.markups.length ? "" : "none";
      ctx.status(`${s.title} · ${sheet.prims.length.toLocaleString("it-IT")} elementi${sheet.paper ? ` · carta ${fmt(sheet.paper.w, 1)} × ${fmt(sheet.paper.h, 1)} ${sheet.paper.units}` : ""}`);
      fit();
    } catch (e) {
      console.error(e);
      toast(`${s.title}: ${e.message}`, true, 7000);
    } finally { ov.remove(); }
  }

  // ---- layer
  function renderLayers() {
    const p = panes.layer;
    p.innerHTML = "";
    const list = [...sheet.layers.values()].filter(l => l.count).sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) { p.append(el("div", { class: "note", style: { padding: "12px" } }, "Il foglio non ha layer")); return; }
    p.append(el("div", { style: { padding: "6px 10px", display: "flex", gap: "6px", alignItems: "center" } }, el("b", {}, "Layer"), el("span", { class: "note" }, String(list.length)), el("span", { style: { flex: 1 } }),
      el("button", { class: "btn", onclick: () => { hiddenLayers.clear(); renderLayers(); draw(); } }, "Tutti"),
      el("button", { class: "btn", onclick: () => { list.forEach(l => hiddenLayers.add(l.name)); renderLayers(); draw(); } }, "Nessuno")));
    const tree = el("div", { class: "tree" });
    for (const L of list) {
      const cb = el("input", { type: "checkbox", checked: !hiddenLayers.has(L.name) });
      cb.addEventListener("change", () => { if (cb.checked) hiddenLayers.delete(L.name); else hiddenLayers.add(L.name); draw(); });
      tree.append(el("label", { class: "node" }, cb, el("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, L.name), el("span", { class: "note", style: { marginLeft: "auto" } }, String(L.count))));
    }
    p.append(tree);
  }

  // ---- proprieta' (oggetto selezionato, altrimenti foglio)
  function renderProps(idx) {
    const p = panes.oggetti;
    p.innerHTML = "";
    const dl = el("dl", { class: "kv", style: { padding: "8px 10px", fontSize: "12px" } });
    const add = (k, v) => { if (v === undefined || v === null || v === "") return; dl.append(el("dt", {}, k), el("dd", { style: { margin: 0, overflowWrap: "anywhere" } }, v)); };
    const group = (title, list) => {
      const cats = new Map();
      for (const pr of list) {
        if (pr.cat === "hidden" || String(pr.name).startsWith("_")) continue;
        const c = pr.cat || "Generale";
        if (!cats.has(c)) cats.set(c, []);
        cats.get(c).push(pr);
      }
      if (title) p.append(el("div", { style: { padding: "8px 10px 2px", fontWeight: "700" } }, title));
      for (const [c, items] of cats) {
        const d = el("dl", { class: "kv", style: { padding: "2px 10px 8px", fontSize: "12px" } });
        for (const it of items) d.append(el("dt", {}, it.name), el("dd", { style: { margin: 0, overflowWrap: "anywhere" } }, it.value || ""));
        p.append(el("details", { open: true, style: { borderTop: "1px solid var(--line)" } }, el("summary", { style: { padding: "5px 10px", cursor: "pointer", fontWeight: "600" } }, c), d));
      }
    };
    if (idx === null || idx === undefined || !sheet) {
      if (!sheet) return;
      p.append(el("div", { style: { padding: "8px 10px 0", fontWeight: "700" } }, sheet.title));
      if (sheet.paper) add("Carta", `${fmt(sheet.paper.w, 2)} × ${fmt(sheet.paper.h, 2)} ${sheet.paper.units}`);
      const u = sheet.units[0];
      if (u) add("Unita' del disegno", (UNIT_LABEL[u.name] || u.raw || "-") + (u.perPaper ? ` (1 ${sheet.paper?.units || "unita'"} di carta = ${fmt(u.perPaper)} ${UNIT_LABEL[u.name] || ""})` : ""));
      add("Oggetti con proprieta'", sheet.objects.size ? sheet.objects.size.toLocaleString("it-IT") : "");
      for (const [k, v] of Object.entries(sheet.meta || {})) add(k, v);
      p.append(dl);
      if (sheet.props.length) group("Proprieta' del foglio", sheet.props);
      p.append(el("div", { class: "note", style: { padding: "10px" } }, "Fai clic su un elemento del disegno per vederne le proprieta'."));
      return;
    }
    const pr = sheet.prims[idx];
    const obj = pr.obj ? sheet.objects.get(pr.obj) : null;
    p.append(el("div", { style: { padding: "8px 10px 0", fontWeight: "700" } }, obj ? obj.label : { p: pr.fill ? "Area piena" : "Linea / polilinea", x: "Testo", i: "Immagine", m: "Simbolo" }[pr.t]));
    if (pr.t === "x") add("Testo", pr.s);
    add("Layer", pr.layer);
    if (pr.color) add("Colore", `RGB ${pr.color[0]}, ${pr.color[1]}, ${pr.color[2]}`);
    if (pr.t === "p" && !pr.fill) add("Spessore", pr.lw ? fmt(pr.lw, 3) + " " + (sheet.paper?.units || "") : "minimo");
    if (pr.t === "x") add("Carattere", pr.font + (pr.bold ? " grassetto" : "") + (pr.italic ? " corsivo" : ""));
    if (obj) add("Elementi grafici dell'oggetto", String(obj.prims?.length || 1));
    p.append(dl);
    if (pr.url?.length) {
      const box = el("div", { style: { padding: "0 10px 8px" } }, el("b", {}, "Collegamenti"));
      for (const u of pr.url) box.append(el("div", {}, el("a", { href: "#", onclick: e => { e.preventDefault(); followLink(u.href); } }, u.name || u.href)));
      p.append(box);
    }
    if (obj?.props.length) group("Proprieta' dell'oggetto", obj.props);
    else if (!obj) p.append(el("div", { class: "note", style: { padding: "0 10px 10px" } }, "Questo elemento non ha proprieta' associate nel file."));
  }
  function followLink(href) {
    const m = /page='([^']+)'/.exec(href || "");
    if (m) { const s = pkg.sheets.find(x => x.title === m[1]); if (s) return openSheet(s); }
    if (/^https?:/i.test(href)) { if (WEB) window.open(href, "_blank", "noopener"); else api("open_external", { path: href }).catch(() => window.open(href, "_blank", "noopener")); return; }
    toast("Collegamento: " + href, false, 5000);
  }

  // ---- marcature
  function renderMarkups() {
    const p = panes.marcature;
    p.innerHTML = "";
    if (!sheet.markups.length) { p.append(el("div", { class: "note", style: { padding: "12px" } }, "Il foglio non contiene marcature (commenti di revisione)")); return; }
    const tree = el("div", { class: "tree" });
    for (const m of sheet.markups) {
      const get = n => m.props.find(x => x.name === n)?.value || "";
      const row = el("div", { class: "node", style: { flexDirection: "column", alignItems: "flex-start", whiteSpace: "normal", gap: "2px" }, onclick: () => {
        for (const r of tree.children) r.classList.toggle("sel", r === row);
        highlight = new Set(m.prims || []);
        if (m.bbox) zoomBox(m.bbox, 0.6); else draw();
        const pd = panes.oggetti;
        renderProps(m.prims?.[0] ?? null);
        if (!m.prims?.length) pd.innerHTML = "";
      } }, el("b", {}, m.label), el("span", { class: "note" }, [get("Author"), get("Status"), (get("Created") || "").replace("T", " ").slice(0, 16)].filter(v => v && v !== "<None>").join(" · ")));
      tree.append(row);
    }
    p.append(tree);
  }

  // ---- ricerca nei testi (anche quelli invisibili che AutoCAD affianca ai testi SHX)
  const searchBox = el("input", { type: "search", class: "field", placeholder: "Cerca testo nel foglio", style: { width: "calc(100% - 20px)", margin: "8px 10px" } });
  const searchRes = el("div", { class: "tree" });
  panes.cerca.append(searchBox, searchRes);
  searchBox.addEventListener("input", () => renderSearch());
  function renderSearch() {
    searchRes.innerHTML = "";
    const q = searchBox.value.trim().toLowerCase();
    if (!q || !sheet) return;
    let n = 0;
    const hits = [];
    sheet.prims.forEach((p, i) => { if (p.t === "x" && p.s.toLowerCase().includes(q)) hits.push(i); });
    // anche nelle proprieta' degli oggetti
    for (const o of sheet.objects.values()) if (o.prims?.length && (o.label.toLowerCase().includes(q) || o.props.some(p => String(p.value).toLowerCase().includes(q)))) hits.push(-1 - o.prims[0]);
    for (const h of hits.slice(0, 500)) {
      const i = h < 0 ? -1 - h : h, p = sheet.prims[i];
      const label = h < 0 ? sheet.objects.get(p.obj)?.label : p.s;
      searchRes.append(el("div", { class: "node", style: { whiteSpace: "normal" }, onclick: () => selectPrim(i, true) }, el("span", {}, label), h < 0 ? el("span", { class: "note" }, "oggetto") : null));
      n++;
    }
    searchRes.prepend(el("div", { class: "note", style: { padding: "0 10px 6px" } }, `${hits.length.toLocaleString("it-IT")} risultati${hits.length > 500 ? " (mostrati 500)" : ""}`));
  }

  // ---- vista
  const g2 = canvas.getContext("2d");
  const dpr = () => devicePixelRatio || 1;
  function resize() { const r = canvas.getBoundingClientRect(); canvas.width = Math.max(1, Math.round(r.width * dpr())); canvas.height = Math.max(1, Math.round(r.height * dpr())); }
  function zoomBox([x0, y0, x1, y1], k = 0.94) {
    resize();
    const W = canvas.width, H = canvas.height;
    view.s = k * Math.min(W / Math.max(x1 - x0, 1e-9), H / Math.max(y1 - y0, 1e-9));
    view.tx = W / 2 - view.s * (x0 + x1) / 2;
    view.ty = H / 2 + view.s * (y0 + y1) / 2;
    draw();
  }
  function fit() { if (sheet) zoomBox(sheet.bbox); }
  const toWorld = (px, py) => [(px - view.tx) / view.s, (view.ty - py) / view.s];
  const toScreen = (x, y) => [x * view.s + view.tx, view.ty - y * view.s];
  function zoomAt(f, px = canvas.width / 2, py = canvas.height / 2) { view.tx = px - (px - view.tx) * f; view.ty = py - (py - view.ty) * f; view.s *= f; draw(); }
  const isVisible = p => !(p.layer && hiddenLayers.has(p.layer)) && !(p.mk && !showMarkups) && !(p.t === "x" && !showText && !p.hidden);

  function draw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawNow(); }); }
  function drawNow() {
    if (!sheet || stage.style.display === "none") return;
    const r = canvas.getBoundingClientRect();
    if (Math.abs(canvas.width - r.width * dpr()) > 1.5 || Math.abs(canvas.height - r.height * dpr()) > 1.5) resize();
    drawSheet(g2, canvas.width, canvas.height, sheet, prep, view, { dark, showText, thinLines, hiddenLayers, showMarkups, dpr: dpr(), highlight });
    overlay();
  }
  function overlay() {
    g2.setTransform(1, 0, 0, 1, 0, 0);
    const D = dpr();
    if (mode !== "sel" && (mpts.length || msnap)) {
      const pts = [...mpts];
      const live = msnap ? [msnap.x, msnap.y] : mouse;
      g2.strokeStyle = "#ff8c1a"; g2.fillStyle = "rgba(255,140,26,.18)"; g2.lineWidth = 2 * D;
      const sp = (live && !(mode === "dist" && mpts.length === 2) ? [...pts, live] : pts).map(p => toScreen(p[0], p[1]));
      if (sp.length) {
        g2.beginPath(); sp.forEach(([x, y], k) => (k ? g2.lineTo(x, y) : g2.moveTo(x, y)));
        if (mode === "area" && sp.length > 2) { g2.closePath(); g2.fill(); }
        g2.stroke();
        g2.fillStyle = "#ff8c1a";
        for (const [x, y] of sp) { g2.beginPath(); g2.arc(x, y, 3.5 * D, 0, 7); g2.fill(); }
      }
      const label = measureLabel(live);
      if (label && sp.length >= 2) {
        const [mx, my] = sp[sp.length - 1];
        g2.font = `${12.5 * D}px Segoe UI, sans-serif`;
        const w = g2.measureText(label).width + 12 * D;
        g2.fillStyle = "rgba(0,0,0,.78)"; g2.fillRect(mx + 10 * D, my - 26 * D, w, 22 * D);
        g2.fillStyle = "#fff"; g2.fillText(label, mx + 16 * D, my - 10 * D);
      }
    }
    if (msnap && mode !== "sel") {
      const [x, y] = toScreen(msnap.x, msnap.y), r = 6 * D;
      g2.strokeStyle = "#22c55e"; g2.lineWidth = 2 * D; g2.beginPath();
      if (msnap.k === "end") g2.rect(x - r, y - r, 2 * r, 2 * r);
      else if (msnap.k === "mid") { g2.moveTo(x, y - r); g2.lineTo(x + r, y + r); g2.lineTo(x - r, y + r); g2.closePath(); }
      else if (msnap.k === "ins") { g2.moveTo(x - r, y); g2.lineTo(x, y - r); g2.lineTo(x + r, y); g2.lineTo(x, y + r); g2.closePath(); }
      else { g2.moveTo(x - r, y - r); g2.lineTo(x + r, y + r); g2.moveTo(x + r, y - r); g2.lineTo(x - r, y + r); }
      g2.stroke();
    }
  }

  // ---- misure in unita' del disegno (riquadro o foglio) e in unita' della carta
  function unitsAt(x, y) {
    const inRing = (r) => { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { if ((r[i + 1] > y) !== (r[j + 1] > y) && x < ((r[j] - r[i]) * (y - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c; } return c; };
    const reg = sheet.units.find(u => u.region?.some(inRing));
    if (reg) return reg;
    // DWFx: riquadro dell'elemento piu' vicino al punto
    if (sheet.vpUnits?.length) {
      const i = pick(sheet, x, y, 12 * dpr() / view.s, p => p.vp !== null && p.vp !== undefined && isVisible(p));
      const u = i !== null ? sheet.vpUnits[sheet.prims[i].vp] : null;
      if (u) return u;
    }
    return sheet.units.find(u => !u.region) || null;
  }
  function measureLabel(live) {
    const pts = [...mpts];
    if (live && !(mode === "dist" && mpts.length === 2)) pts.push(live);
    if (pts.length < 2) return "";
    const u = unitsAt(pts[0][0], pts[0][1]);
    const pu = sheet.paper?.units || "";
    const k = u ? u.perPaper : 1, un = u ? UNIT_LABEL[u.name] ?? u.raw ?? "" : pu;
    if (mode === "dist") {
      const d = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
      const ang = Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]) * 180 / Math.PI;
      return `${fmtU(d * k, u)} ${un}${u ? `  (carta ${fmt(d, 2)} ${pu})` : ""}  ∠ ${fmt(ang, 2)}°`;
    }
    let a = 0, per = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; if (i < pts.length - 1 || pts.length > 2) per += Math.hypot(q[0] - p[0], q[1] - p[1]); }
    const ar = Math.abs(a) / 2 * k * k;
    if (u?.name === "ftin") return `Area ${fmt(ar / 144, 2)} ft²  ·  perimetro ${feetInches(per * k)}`;
    return `Area ${fmt(ar)} ${un}²  ·  perimetro ${fmt(per * k)} ${un}`;
  }

  // ---- selezione
  function pickAt(px, py) {
    const [x, y] = toWorld(px, py);
    return pick(sheet, x, y, 5 * dpr() / view.s, isVisible);
  }
  function selectPrim(i, zoom = false) {
    selIndex = i;
    if (i === null) { highlight = new Set(); renderProps(null); draw(); return; }
    const p = sheet.prims[i];
    const obj = p.obj ? sheet.objects.get(p.obj) : null;
    highlight = new Set(obj?.prims?.length ? obj.prims : [i]);
    renderProps(i);
    if (pane !== "cerca" && pane !== "marcature") showPane("oggetti");
    if (zoom) {
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const k of highlight) { const bb = primBBox(sheet.prims[k]); a = Math.min(a, bb[0]); b = Math.min(b, bb[1]); c = Math.max(c, bb[2]); d = Math.max(d, bb[3]); }
      if (isFinite(a)) { const pad = Math.max(c - a, d - b) * 0.6 + 1e-6; zoomBox([a - pad, b - pad, c + pad, d + pad]); return; }
    }
    draw();
  }

  // ---- mouse
  let drag = null;
  const pos = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * dpr(), (e.clientY - r.top) * dpr()]; };
  canvas.addEventListener("pointerdown", e => {
    if (!sheet) return;
    const [px, py] = pos(e);
    drag = { px, py, tx: view.tx, ty: view.ty, moved: false, button: e.button };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* eventi simulati */ }
  });
  canvas.addEventListener("pointermove", e => {
    if (!sheet) return;
    const [px, py] = pos(e);
    if (drag) {
      if (Math.hypot(px - drag.px, py - drag.py) > 4 * dpr()) drag.moved = true;
      if (drag.moved) { view.tx = drag.tx + (px - drag.px); view.ty = drag.ty + (py - drag.py); draw(); }
      return;
    }
    const [x, y] = toWorld(px, py);
    mouse = [x, y];
    const u = unitsAt(x, y);
    if (u) { const [dx, dy] = applyM(u.toDrawing, x, y); ctx.status(`X ${fmtU(dx, u, 3)}  Y ${fmtU(dy, u, 3)} ${UNIT_LABEL[u.name] ?? u.raw ?? ""}${u.label ? " · " + u.label : ""}`); }
    else ctx.status(`X ${fmt(x, 2)}  Y ${fmt(y, 2)} ${sheet.paper?.units || ""}`);
    if (mode !== "sel") { msnap = snap(sheet, x, y, 8 * dpr() / view.s, isVisible); draw(); }
  });
  canvas.addEventListener("pointerup", e => {
    if (!drag || !sheet) { drag = null; return; }
    const d = drag;
    drag = null;
    if (d.moved || d.button !== 0) return;
    const [px, py] = pos(e);
    const [x, y] = toWorld(px, py);
    if (mode === "sel") { selectPrim(pickAt(px, py)); return; }
    const pt = msnap ? [msnap.x, msnap.y] : [x, y];
    if (mode === "dist") { if (mpts.length >= 2) mpts = []; mpts.push(pt); if (mpts.length === 2) ctx.status("Distanza: " + measureLabel(null)); }
    else mpts.push(pt);
    draw();
  });
  canvas.addEventListener("dblclick", () => {
    if (mode === "area" && mpts.length > 2) { mpts.pop(); ctx.status(measureLabel(null)); toast(measureLabel(null), false, 6000); mode = "area"; const done = [...mpts]; mpts = done; draw(); return; }
    if (mode === "sel") fit();
  });
  canvas.addEventListener("contextmenu", e => e.preventDefault());
  canvas.addEventListener("wheel", e => { e.preventDefault(); const [px, py] = pos(e); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, px, py); }, { passive: false });
  const onKey = e => {
    if (ctx.tab.view.hidden || stage.style.display === "none" || /input|textarea|select/i.test(document.activeElement?.tagName || "")) return;
    if (e.key === "Escape") { mpts = []; selectPrim(null); }
    else if (e.key === "Enter" && mode === "area" && mpts.length > 2) { toast(measureLabel(null), false, 6000); }
  };
  window.addEventListener("keydown", onKey);
  new ResizeObserver(() => { const w = canvas.width; resize(); if (w <= 1) fit(); else draw(); }).observe(canvas);

  // ---- 3D (sezioni eModel: W3D/HSF)
  async function open3d(s) {
    stage.style.display = "none"; host3d.style.display = "flex"; tb2dBox.style.display = "none"; tb3dBox.style.display = "contents";
    host3d.innerHTML = ""; tb3dBox.innerHTML = "";
    if (api3d?.dispose) { try { api3d.dispose(); } catch { /* */ } }
    api3d = null;
    const body = el("div", { class: "body fill", style: { flex: "1 1 auto", minHeight: 0, position: "relative" } });
    host3d.append(body);
    const sub = { ...ctx, el: body, tb: tb3dBox, ext: "w3d", name: s.title, info: { nome: s.title }, extraPaths: [], fillBody() {},
      preloaded: async ld2 => { const { loadW3dSection } = await import("../w3d.js"); return loadW3dSection(pkg, s, ld2); } };
    try {
      const mod = await import("./model3d.js");
      api3d = await mod.mount(sub);
    } catch (e) {
      console.error(e);
      body.innerHTML = "";
      body.append(el("div", { class: "center" }, el("div", { class: "panel", style: { maxWidth: "560px", textAlign: "left" } }, el("h3", { style: { marginTop: 0 } }, "Modello 3D non visualizzabile"), el("p", { class: "err" }, e.message))));
    }
  }

  // ---- esportazioni
  const opts = () => ({ hiddenLayers, showMarkups, showText, dark: false, title: sheet?.title });
  const baseName = () => (ctx.name.replace(/\.[^.]+$/, "") + (pkg.sheets.length > 1 && sheet ? " - " + sheet.title : "")).replace(/[\\/:*?"<>|]+/g, "_");
  async function exportCur(kind) {
    if (!sheet) return;
    try {
      const blob = kind === "png" ? await sheetToPng(sheet, opts()) : kind === "svg" ? await sheetToSvg(sheet, opts()) : await sheetsToPdf([sheet], opts());
      await saveBlobAs(baseName() + "." + kind, blob, dirName(ctx.path));
    } catch (e) { console.error(e); toast("Esportazione non riuscita: " + e.message, true, 6000); }
  }
  async function allSheets() {
    const list = [];
    for (const s of pkg.sheets.filter(x => x.kind === "2d")) {
      let sh = sheetCache.get(s.id);
      if (!sh) { try { sh = await s.load(); sheetCache.set(s.id, sh); } catch (e) { toast(`${s.title}: ${e.message}`, true, 5000); continue; } }
      list.push(sh);
    }
    return list;
  }

  showPane("fogli");
  const first = pkg.sheets.find(s => s.kind === "2d") || pkg.sheets[0];
  await openSheet(first);
  if (pkg.sheets.length > 1) showPane("fogli");

  return {
    onShow() { if (stage.style.display !== "none") { resize(); draw(); } else api3d?.onShow?.(); },
    onBack() { return false; },
    saveFormats: ["pdf", "png", "svg"],
    saveLabels: { pdf: "PDF vettoriale (tutti i fogli 2D)", png: "Immagine del foglio aperto", svg: "SVG vettoriale del foglio aperto" },
    saveAsName: () => withExt(ctx.name, "pdf"),
    async save(target) {
      const ext = target.split(".").pop().toLowerCase();
      if (cur?.kind === "3d" && api3d?.save && !["pdf", "png", "svg"].includes(ext)) return api3d.save(target);
      let blob;
      if (ext === "pdf") blob = await sheetsToPdf(await allSheets(), { ...opts(), title: pkg.title });
      else if (ext === "png") blob = await sheetToPng(sheet, opts());
      else if (ext === "svg") blob = await sheetToSvg(sheet, opts());
      else throw new Error("Formato non supportato per i DWF: " + ext);
      await api("save", { path: target }, { body: new Uint8Array(await blob.arrayBuffer()) });
      return { switchTo: false };
    },
    dispose() { window.removeEventListener("keydown", onKey); try { api3d?.dispose?.(); } catch { /* */ } },
  };
}
const applyM = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
