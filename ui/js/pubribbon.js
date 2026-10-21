// Barra multifunzione dell'editor di pubblicazioni, con le stesse schede e gli stessi gruppi di Publisher:
// Home, Inserisci, Progettazione pagina, Mailing, Revisione, Visualizza e le schede contestuali "Formato"
// (casella di testo, immagine, disegno, WordArt, tabella) e "Pagina master". Qui anche menu, gallerie e finestre.
import { el, toast, modal, askText, pickFiles, readBytes, api, extOf, baseName, loadScript, confirmBox, WEB, fileUrl } from "./core.js";
import { pubIcon } from "./pubicons.js";
import { MM, CM, FIELD, S, COLOR_SCHEMES, FONT_SCHEMES, FONTS, PAGE_SIZES, color, fontName, newId, walk, allItems, cloneItems, textBox, imageBox, shapeBox, wordArt, tableBox, newPage, makeStory, storyText, charPart, paraPart, styleChars, copyStory } from "./pubmodel.js";
import { SHAPES, shapeCmds, computeLayouts, drawPage, CanvasPainter, aabb, isLine } from "./pubrender.js";
import { caretPos, paraBounds, insertText, deleteRange, setParaStyle } from "./pubtext.js";
import { TEMPLATES } from "./pubtemplates.js";
import { exportPdfFile, exportMergedPdf } from "./pubexport.js";
import { LOCALE } from "./i18n.js";

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const cm = v => +(v / CM).toFixed(2);
const fromCm = v => (parseFloat(String(v).replace(",", ".")) || 0) * CM;
const STD_COLORS = ["#c00000", "#ff0000", "#ffc000", "#ffff00", "#92d050", "#00b050", "#00b0f0", "#0070c0", "#002060", "#7030a0", "#ffffff", "#000000"];
const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72, 96, 120, 144];
const WEIGHTS = [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6];
const DASH_NAMES = [["solid", "Continua"], ["dash", "Tratteggiata"], ["dot", "Punteggiata"], ["dashdot", "Tratto punto"], ["long", "Tratto lungo"]];

// ------------------------------------------------------------------ menu e finestre a comparsa
let popEl = null, popClose = null;
export function closePop() { if (popEl) { popEl.remove(); popEl = null; document.removeEventListener("pointerdown", popOutside, true); document.removeEventListener("keydown", popKey, true); popClose?.(); popClose = null; } }
function popOutside(e) { if (popEl && !popEl.contains(e.target) && !e.target.closest?.(".pb-pop")) closePop(); }
function popKey(e) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePop(); } }
function popup(anchor, content, cls = "") {
  closePop();
  popEl = el("div", { class: "pb-pop " + cls });
  popEl.append(content);
  document.body.append(popEl);
  let x, y;
  if (anchor instanceof Element) { const r = anchor.getBoundingClientRect(); x = r.left; y = r.bottom + 2; }
  else { x = anchor.x; y = anchor.y; }
  const pr = popEl.getBoundingClientRect();
  popEl.style.left = clamp(x, 4, innerWidth - pr.width - 4) + "px";
  popEl.style.top = (y + pr.height > innerHeight - 4 ? Math.max(4, y - pr.height - (anchor instanceof Element ? anchor.getBoundingClientRect().height + 4 : 0)) : y) + "px";
  setTimeout(() => document.addEventListener("pointerdown", popOutside, true));
  document.addEventListener("keydown", popKey, true);
  return popEl;
}
export function menuEl(items, done) {
  const box = el("div", { class: "pb-menu" });
  for (const it of items) {
    if (!it) continue;
    if (it === "-") { box.append(el("div", { class: "pb-msep" })); continue; }
    if (it.title) { box.append(el("div", { class: "pb-mtitle" }, it.title)); continue; }
    if (it.el) { box.append(it.el); continue; }
    const dis = typeof it.dis === "function" ? it.dis() : it.dis;
    const chk = typeof it.checked === "function" ? it.checked() : it.checked;
    const b = el("button", { type: "button", class: "pb-mit" + (chk ? " on" : ""), disabled: !!dis });
    b.innerHTML = `<span class="pb-mico">${it.icon ? pubIcon(it.icon) : chk ? "✓" : ""}</span>`;
    const lab = el("span", { class: "pb-mlab" }, it.label);
    if (it.font) lab.style.fontFamily = `"${it.font}"`;
    if (it.style) Object.assign(lab.style, it.style);
    b.append(lab, el("span", { class: "pb-mkey" }, it.keys || (it.sub ? "›" : "")));
    if (it.sub) {
      b.addEventListener("pointerenter", () => {
        box.querySelectorAll(".pb-menu.sub").forEach(s => s.remove());
        const sub = menuEl(typeof it.sub === "function" ? it.sub() : it.sub, done);
        sub.classList.add("sub");
        b.append(sub);
      });
    } else b.addEventListener("click", ev => { ev.stopPropagation(); closePop(); it.run?.(); done?.(); });
    box.append(b);
  }
  return box;
}
function openMenu(anchor, items, done) { popup(anchor, menuEl(items, done)); }

// ------------------------------------------------------------------ barra multifunzione
export function buildRibbon(E, ctx, host) {
  const doc = () => E.doc();
  let active = "home";
  const updaters = [];
  const sel = () => E.sel();
  const one = () => (sel().length === 1 ? sel()[0] : null);
  const edit = () => E.edit();
  const kind = () => {
    const ed = edit();
    if (ed) return ed.kind === "cell" ? "table" : "text";
    const s = sel();
    if (!s.length) return null;
    const t = new Set(s.map(o => (o.type === "shape" ? "shape" : o.type)));
    return t.size === 1 ? [...t][0] : "mixed";
  };
  const after = () => { E.focus(); };
  const hasText = () => !!edit() || sel().some(o => o.type === "text" || o.type === "table" || o.type === "wordart");

  // --------------------------------------------- controlli
  function big(icon, label, run, o = {}) {
    const b = el("button", { type: "button", class: "pb-big" + (o.menu ? " drop" : ""), title: o.tip || label + (o.keys ? ` (${o.keys})` : "") });
    b.innerHTML = pubIcon(icon);
    b.append(el("span", {}, label));
    if (o.menu && !run) b.insertAdjacentHTML("beforeend", `<i class="pb-caret">${pubIcon("caret")}</i>`);
    b.addEventListener("pointerdown", e => e.preventDefault());
    b.addEventListener("click", () => { if (run) { run(); after(); } else openMenu(b, o.menu(), after); });
    if (o.menu && run) {
      // pulsante diviso: sopra l'azione, sotto il menu
      const wrap = el("div", { class: "pb-split" }, b);
      const dd = el("button", { type: "button", class: "pb-splitdd", title: label + ": altre opzioni" });
      dd.innerHTML = pubIcon("caret");
      dd.addEventListener("pointerdown", e => e.preventDefault());
      dd.addEventListener("click", () => openMenu(wrap, o.menu(), after));
      wrap.append(dd);
      reg(() => { const d = o.dis?.(); b.disabled = !!d; dd.disabled = !!d; b.classList.toggle("on", !!o.on?.()); });
      return wrap;
    }
    reg(() => { b.disabled = !!o.dis?.(); b.classList.toggle("on", !!o.on?.()); });
    return b;
  }
  function sm(icon, label, run, o = {}) {
    const b = el("button", { type: "button", class: "pb-sm" + (label ? "" : " io"), title: o.tip || (label || o.title || "") + (o.keys ? ` (${o.keys})` : "") });
    b.innerHTML = icon ? pubIcon(icon) : "";
    if (label) b.append(el("span", {}, label));
    if (o.menu) b.insertAdjacentHTML("beforeend", `<i class="pb-caret">${pubIcon("caret")}</i>`);
    b.addEventListener("pointerdown", e => e.preventDefault());
    b.addEventListener("click", () => { if (o.menu) openMenu(b, o.menu(), after); else { run(); after(); } });
    reg(() => { b.disabled = !!o.dis?.(); b.classList.toggle("on", !!o.on?.()); });
    return b;
  }
  function colorBtn(icon, title, get, set, o = {}) {
    const wrap = el("div", { class: "pb-split sm" });
    const b = el("button", { type: "button", class: "pb-sm io", title });
    b.innerHTML = pubIcon(icon);
    const dd = el("button", { type: "button", class: "pb-splitdd sm", title: title + ": colori" });
    dd.innerHTML = pubIcon("caret");
    let last = o.def || "s1";
    b.addEventListener("pointerdown", e => e.preventDefault());
    dd.addEventListener("pointerdown", e => e.preventDefault());
    b.addEventListener("click", () => { set(last); after(); });
    dd.addEventListener("click", () => colorMenu(wrap, get(), v => { last = v; set(v); after(); }, o));
    wrap.append(b, dd);
    reg(() => {
      const v = get(), sw = b.querySelector(".pb-swatch");
      const c = color(doc(), v || last);
      if (sw) sw.setAttribute("fill", c || "transparent");
      const d = !!o.dis?.(); b.disabled = d; dd.disabled = d;
    });
    return wrap;
  }
  function colorMenu(anchor, current, set, o = {}) {
    const box = el("div", { class: "pb-colors" });
    const D = doc();
    box.append(el("div", { class: "pb-mtitle" }, "Colori della combinazione"));
    const grid = el("div", { class: "pb-cgrid" });
    const levels = [null, 80, 60, 40, 20, -25, -50];
    for (const lv of levels) for (let k = 0; k < 6; k++) {
      const v = lv === null ? "s" + k : `s${k}:${lv}`;
      const c = color(D, v);
      const b = el("button", { type: "button", class: "pb-cell" + (current === v ? " on" : ""), title: `Colore ${k === 0 ? "principale" : "accento " + k}${lv === null ? "" : lv > 0 ? `, tinta ${lv}%` : `, piu' scuro ${-lv}%`}`, style: { background: c } });
      b.addEventListener("click", () => { closePop(); set(v); });
      grid.append(b);
    }
    box.append(grid, el("div", { class: "pb-mtitle" }, "Colori standard"));
    const std = el("div", { class: "pb-cgrid std" });
    for (const c of STD_COLORS) { const b = el("button", { type: "button", class: "pb-cell" + (current === c ? " on" : ""), title: c, style: { background: c } }); b.addEventListener("click", () => { closePop(); set(c); }); std.append(b); }
    box.append(std);
    if (o.none !== false) box.append(el("button", { type: "button", class: "pb-mit", onclick: () => { closePop(); set("none"); } }, el("span", { class: "pb-mico" }, current === "none" ? "✓" : ""), el("span", {}, o.noneLabel || "Nessun colore"), el("span")));
    const inp = el("input", { type: "color", value: /^#/.test(current || "") ? current : color(D, current || "s1") || "#000000" });
    inp.addEventListener("change", () => { closePop(); set(inp.value); });
    box.append(el("label", { class: "pb-mit more" }, el("span", { class: "pb-mico" }), el("span", {}, "Altri colori..."), inp));
    popup(anchor, box);
  }
  function selectCtl(options, get, set, o = {}) {
    const s = el("select", { class: "pb-sel", title: o.title || "", style: { width: (o.width || 120) + "px" } });
    const fill = () => { s.innerHTML = ""; for (const [v, label, font] of options()) { const op = el("option", { value: v }, label); if (font) op.style.fontFamily = `"${font}"`; s.append(op); } };
    fill();
    s.addEventListener("change", () => { set(s.value); after(); });
    reg(() => { if (document.activeElement === s) return; const v = get(); if (v !== undefined && v !== null) { if (![...s.options].some(op => op.value === String(v))) { fill(); s.append(el("option", { value: v }, String(v))); } s.value = String(v); } else s.selectedIndex = -1; s.disabled = !!o.dis?.(); });
    return s;
  }
  function comboNum(list, get, set, o = {}) {
    const id = "pbl" + Math.random().toString(36).slice(2, 7);
    const dl = el("datalist", { id }, ...list.map(v => el("option", { value: String(v) })));
    const inp = el("input", { type: "text", class: "pb-num", list: id, title: o.title || "", style: { width: (o.width || 52) + "px" } });
    const apply = () => { const v = parseFloat(inp.value.replace(",", ".")); if (isFinite(v) && v > 0) set(v); after(); };
    inp.addEventListener("change", apply);
    inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(); } if (e.key === "Escape") after(); });
    reg(() => { if (document.activeElement === inp) return; const v = get(); inp.value = v === null || v === undefined ? "" : String(+(+v).toFixed(1)).replace(".", ","); inp.disabled = !!o.dis?.(); });
    return el("span", { class: "pb-combo" }, inp, dl);
  }
  function numField(label, get, set, o = {}) {
    const inp = el("input", { type: "text", class: "pb-num", style: { width: (o.width || 58) + "px" }, title: o.title || label });
    const apply = () => { set(inp.value); after(); };
    inp.addEventListener("change", apply);
    inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(); } if (e.key === "Escape") after(); });
    reg(() => { if (document.activeElement === inp) return; const v = get(); inp.value = v === null || v === undefined ? "" : String(v).replace(".", ","); inp.disabled = !!o.dis?.(); });
    return el("label", { class: "pb-field" }, el("span", {}, label), inp, o.unit ? el("small", {}, o.unit) : null);
  }
  function check(label, get, set) {
    const c = el("input", { type: "checkbox" });
    c.addEventListener("change", () => { set(c.checked); after(); });
    reg(() => { c.checked = !!get(); });
    return el("label", { class: "pb-check" }, c, el("span", {}, label));
  }
  const col = (...rows) => el("div", { class: "pb-col" }, ...rows.map(r => el("div", { class: "pb-row" }, ...(Array.isArray(r) ? r : [r]))));
  const groupEl = (label, ...cols) => el("div", { class: "pb-group" }, el("div", { class: "pb-gbody" }, ...cols), el("div", { class: "pb-glabel" }, label));
  function reg(fn) { updaters.push(fn); }

  // --------------------------------------------- comandi condivisi
  const disNoSel = () => !sel().length;
  const firstLine = () => sel().find(o => o.line || o.type === "shape") || null;
  const propSet = (patch, label) => { for (const o of sel()) Object.assign(o, typeof patch === "function" ? patch(o) : patch); E.commit(label); };
  const arrangeGroup = () => groupEl("Disponi",
    big("wrap", "Disponi testo", null, { menu: wrapMenu, dis: disNoSel }),
    big("bringFwd", "Porta avanti", () => E.order("fwd"), { menu: () => [{ label: "Porta avanti", icon: "bringFwd", run: () => E.order("fwd") }, { label: "Porta in primo piano", icon: "bringFront", run: () => E.order("front") }], dis: disNoSel }),
    big("sendBack", "Porta indietro", () => E.order("back"), { menu: () => [{ label: "Porta indietro", icon: "sendBack", run: () => E.order("back") }, { label: "Porta in secondo piano", icon: "sendBackmost", run: () => E.order("backmost") }], dis: disNoSel }),
    col(sm("align", "Allinea", null, { menu: alignMenu, dis: disNoSel }), sm("group", "Raggruppa", () => E.group(), { keys: "Ctrl+G", dis: () => sel().length < 2 }), sm("ungroup", "Separa", () => E.ungroup(), { keys: "Ctrl+Maiusc+G", dis: () => !sel().some(o => o.type === "group") })),
    col(sm("rotate", "Ruota", null, { menu: rotateMenu, dis: disNoSel })));
  const wrapMenu = () => {
    const cur = one()?.wrap;
    return [
      { label: "Nessuno (davanti al testo)", checked: cur === "none", run: () => propSet({ wrap: "none" }, "Disponi testo") },
      { label: "Quadrato", checked: cur === "square", run: () => propSet({ wrap: "square" }, "Disponi testo") },
      { label: "Ravvicinato", checked: cur === "tight", run: () => propSet({ wrap: "square", wrapDist: 2 }, "Disponi testo") },
      { label: "Sopra e sotto", checked: cur === "topbottom", run: () => propSet({ wrap: "topbottom" }, "Disponi testo") },
      { label: "Dietro al testo", run: () => { propSet({ wrap: "none" }, "Disponi testo"); E.order("backmost"); } },
      "-", { label: "Altre opzioni di disposizione...", run: wrapDlg },
    ];
  };
  async function wrapDlg() {
    const o = one();
    if (!o) return;
    const d = el("input", { type: "text", class: "field", value: String(cm(o.wrapDist ?? 6)).replace(".", ",") });
    const ok = await modal("Disposizione testo", el("label", { class: "pb-dlgrow" }, "Distanza dal testo (cm)", d), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) propSet({ wrapDist: fromCm(d.value) }, "Disposizione testo");
    after();
  }
  let relMargins = false;
  const alignMenu = () => [
    { label: "Allinea a sinistra", icon: "alignObjL", run: () => E.align("l", relMargins) }, { label: "Allinea al centro", icon: "alignObjC", run: () => E.align("c", relMargins) },
    { label: "Allinea a destra", icon: "alignObjR", run: () => E.align("r", relMargins) }, "-",
    { label: "Allinea in alto", icon: "alignObjT", run: () => E.align("t", relMargins) }, { label: "Allinea al centro verticale", icon: "alignObjM", run: () => E.align("m", relMargins) },
    { label: "Allinea in basso", icon: "alignObjB", run: () => E.align("b", relMargins) }, "-",
    { label: "Distribuisci orizzontalmente", icon: "distH", run: () => E.distribute("h") }, { label: "Distribuisci verticalmente", icon: "distV", run: () => E.distribute("v") }, "-",
    { label: "Rispetto alle guide dei margini", checked: relMargins, run: () => { relMargins = !relMargins; } },
  ];
  const rotateMenu = () => [
    { label: "Ruota a destra di 90°", icon: "rotateR", run: () => E.rotate(90) }, { label: "Ruota a sinistra di 90°", icon: "rotateL", run: () => E.rotate(-90) },
    { label: "Capovolgi verticalmente", icon: "flipV", run: () => E.rotate("flipV") }, { label: "Capovolgi orizzontalmente", icon: "flipH", run: () => E.rotate("flipH") }, "-",
    { label: "Altre opzioni di rotazione...", run: rotateDlg },
  ];
  async function rotateDlg() {
    const o = one();
    const v = await askText("Rotazione", "Angolo in gradi (senso orario)", String(Math.round(o?.rot || 0)));
    if (v === null) return;
    const a = parseFloat(v.replace(",", "."));
    if (!isFinite(a)) return;
    for (const x of sel()) if (x.type !== "group") x.rot = ((a % 360) + 360) % 360;
    E.commit("Ruota");
  }
  const sizeGroup = () => groupEl("Dimensioni",
    col(numField("Alt.", () => (one() ? cm(one().h) : ""), v => setGeom({ h: fromCm(v) }), { unit: "cm", dis: () => !one() }),
      numField("Larg.", () => (one() ? cm(one().w) : ""), v => setGeom({ w: fromCm(v) }), { unit: "cm", dis: () => !one() })),
    col(numField("X", () => (one() ? cm(one().x) : ""), v => setGeom({ x: fromCm(v) }), { unit: "cm", dis: () => !one() }),
      numField("Y", () => (one() ? cm(one().y) : ""), v => setGeom({ y: fromCm(v) }), { unit: "cm", dis: () => !one() })),
    col(numField("Rot.", () => (one() ? Math.round(one().rot || 0) : ""), v => setGeom({ rot: ((parseFloat(String(v).replace(",", ".")) || 0) % 360 + 360) % 360 }), { unit: "°", dis: () => !one() || one().type === "group" })));
  function setGeom(p) {
    const o = one();
    if (!o) return;
    if (p.w !== undefined || p.h !== undefined) {
      const w = p.w ?? o.w, h = p.h ?? o.h;
      if (o.type === "table") { o.colW = o.colW.map(c => c * w / o.w); o.rowH = o.rowH.map(r => r * h / o.h); }
      if (o.type === "group") {
        const b0 = { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h }, b1 = { x0: o.x, y0: o.y, x1: o.x + w, y1: o.y + h };
        const sc = (x) => { const cx = x.x + x.w / 2, cy = x.y + x.h / 2, sx = (b1.x1 - b1.x0) / (b0.x1 - b0.x0), sy = (b1.y1 - b1.y0) / (b0.y1 - b0.y0); x.w *= sx; x.h *= sy; x.x = b1.x0 + (cx - b0.x0) * sx - x.w / 2; x.y = b1.y0 + (cy - b0.y0) * sy - x.h / 2; if (x.type === "group") x.items.forEach(sc); };
        o.items.forEach(sc);
      }
      o.w = Math.max(1, w); o.h = Math.max(isLine(o) ? 0 : 1, h);
    }
    if (p.x !== undefined) E.moveObj(o, p.x - o.x, 0);
    if (p.y !== undefined) E.moveObj(o, 0, p.y - o.y);
    if (p.rot !== undefined) o.rot = p.rot;
    E.fixParents(o);
    E.commit("Dimensioni");
  }
  const lineGet = () => firstLine()?.line?.c || "none";
  const fillGroup = (lineOnly = false) => groupEl("Stili forma",
    col(lineOnly ? null : colorBtn("fill", "Riempimento forma", () => one()?.fill, v => propSet({ fill: v }, "Riempimento"), { dis: disNoSel, noneLabel: "Nessun riempimento" }),
      colorBtn("outline", "Contorno forma", lineGet, v => propSet(o => ({ line: { w: 0.75, dash: "solid", ...(o.line || {}), c: v } }), "Contorno"), { dis: disNoSel, noneLabel: "Nessun contorno", def: "s0" }),
      sm("outline", "Spessore", null, { menu: weightMenu, dis: disNoSel })),
    col(sm(null, "Tratteggio", null, { menu: dashMenu, dis: disNoSel }), lineOnly ? sm(null, "Frecce", null, { menu: arrowMenu, dis: () => !sel().some(isLine) }) : null,
      sm("shadow", "Ombra", () => propSet(o => ({ shadow: !o.shadow }), "Ombra"), { on: () => !!one()?.shadow, dis: disNoSel })),
    col(sm(null, "Trasparenza", null, { menu: () => [0, 25, 50, 75].map(t => ({ label: t + "%", checked: Math.round((1 - (one()?.opacity ?? 1)) * 100) === t, run: () => propSet({ opacity: 1 - t / 100 }, "Trasparenza") })), dis: disNoSel })));
  const weightMenu = () => [...WEIGHTS.map(w => ({ label: String(w).replace(".", ",") + " pt", checked: firstLine()?.line?.w === w, run: () => propSet(o => ({ line: { c: o.line?.c && o.line.c !== "none" ? o.line.c : "s0", dash: o.line?.dash || "solid", w } }), "Spessore contorno") })),
    "-", { label: "Nessun contorno", run: () => propSet({ line: null }, "Contorno") }];
  const dashMenu = () => DASH_NAMES.map(([d, n]) => ({ label: n, checked: (firstLine()?.line?.dash || "solid") === d, run: () => propSet(o => ({ line: { c: o.line?.c && o.line.c !== "none" ? o.line.c : "s0", w: o.line?.w || 1, dash: d } }), "Tratteggio") }));
  const arrowMenu = () => [["line", "Nessuna freccia"], ["arrow", "Freccia alla fine"], ["darrow", "Frecce alle due estremita'"]].map(([s, n]) => ({ label: n, checked: one()?.shape === s, run: () => { for (const o of sel()) if (isLine(o)) o.shape = s; E.commit("Frecce"); } }));

  // --------------------------------------------- schede
  const TABS = [
    { id: "home", label: "Home", build: tabHome },
    { id: "insert", label: "Inserisci", build: tabInsert },
    { id: "design", label: "Progettazione pagina", build: tabDesign },
    { id: "mail", label: "Mailing", build: tabMail },
    { id: "review", label: "Revisione", build: tabReview },
    { id: "view", label: "Visualizza", build: tabView },
    { id: "master", label: "Pagina master", ctx: "Pagine master", color: "#b0612a", when: () => !!E.masterId(), build: tabMaster },
    { id: "fmtText", label: "Formato", ctx: "Strumenti casella di testo", color: "#7b4fb0", when: () => kind() === "text", build: tabFmtText },
    { id: "fmtPic", label: "Formato", ctx: "Strumenti immagine", color: "#1f8a5c", when: () => kind() === "image", build: tabFmtPic },
    { id: "fmtDraw", label: "Formato", ctx: "Strumenti disegno", color: "#c0702a", when: () => kind() === "shape" || kind() === "mixed" || kind() === "group", build: tabFmtDraw },
    { id: "fmtWa", label: "Formato", ctx: "Strumenti WordArt", color: "#2f75c8", when: () => kind() === "wordart", build: tabFmtWordArt },
    { id: "tblDesign", label: "Progettazione", ctx: "Strumenti tabella", color: "#a33b6b", when: () => kind() === "table", build: tabTableDesign },
    { id: "tblLayout", label: "Layout", ctx: "Strumenti tabella", color: "#a33b6b", when: () => kind() === "table", build: tabTableLayout },
  ];
  const strip = el("div", { class: "pb-tabs" });
  const panel = el("div", { class: "pb-panel" });
  host.append(panel);
  // barra di accesso rapido e schede nella barra del visualizzatore (come la barra del titolo di Office)
  const qUndo = el("button", { type: "button", class: "pb-q", title: "Annulla (Ctrl+Z)", onclick: () => { E.undo(); after(); } });
  qUndo.innerHTML = pubIcon("undo");
  const qRedo = el("button", { type: "button", class: "pb-q", title: "Ripeti (Ctrl+Y)", onclick: () => { E.redo(); after(); } });
  qRedo.innerHTML = pubIcon("redo");
  ctx.tb.classList.add("pb-tb");
  ctx.tb.append(qUndo, qRedo, el("span", { class: "sep" }), strip);
  let lastSig = "";
  function renderStrip() {
    const vis = TABS.filter(t => !t.when || t.when());
    const sig = vis.map(t => t.id).join(",") + "|" + active;
    if (sig === lastSig) return false;
    lastSig = sig;
    strip.innerHTML = "";
    let lastCtx = null;
    for (const t of vis) {
      if (t.ctx && t.ctx !== lastCtx) { strip.append(el("span", { class: "pb-ctxlab", style: { color: t.color } }, t.ctx)); lastCtx = t.ctx; }
      const b = el("button", { type: "button", class: "pb-tab" + (t.id === active ? " on" : "") + (t.ctx ? " ctx" : ""), style: t.ctx ? { "--ctx": t.color } : {} }, t.label);
      b.addEventListener("pointerdown", e => e.preventDefault());
      b.addEventListener("click", () => { active = t.id; render(); after(); });
      b.addEventListener("dblclick", () => { host.classList.toggle("collapsed"); E.schedule(); });
      strip.append(b);
    }
    return true;
  }
  let lastKind = null;
  function render() {
    const vis = TABS.filter(t => !t.when || t.when());
    if (!vis.find(t => t.id === active)) active = "home";
    renderStrip();
    updaters.length = 0;
    panel.innerHTML = "";
    const t = TABS.find(x => x.id === active);
    panel.append(...t.build().filter(Boolean));
    lastKind = kind() + "|" + !!E.masterId();
    refresh();
  }
  function refresh() {
    const k = kind() + "|" + !!E.masterId();
    // nuova scheda contestuale disponibile: si apre da sola (come in Publisher quando si inserisce un oggetto)
    if (k !== lastKind) {
      const before = lastKind;
      lastKind = k;
      const ctxTab = TABS.find(t => t.ctx && t.when && t.when());
      if (active !== "home" && TABS.find(t => t.id === active)?.ctx && !TABS.find(t => t.id === active).when()) active = ctxTab ? ctxTab.id : "home";
      void before;
      renderStrip();
      const tdef = TABS.find(x => x.id === active);
      if (!tdef.when || tdef.when()) { updaters.length = 0; panel.innerHTML = ""; panel.append(...tdef.build().filter(Boolean)); }
    } else renderStrip();
    qUndo.disabled = !E.canUndo(); qRedo.disabled = !E.canRedo();
    qUndo.title = "Annulla " + E.undoLabel() + " (Ctrl+Z)";
    for (const u of updaters) { try { u(); } catch (e) { console.warn(e); } }
  }

  // --------------------------------------------- Home
  function fontGroup() {
    const cs = () => E.charStyle();
    const fontOpts = () => [["+t", `${doc().fonts.t} (Titoli)`, doc().fonts.t], ["+b", `${doc().fonts.b} (Corpo)`, doc().fonts.b], ...FONTS.map(f => [f, f, f])];
    return groupEl("Carattere",
      col([selectCtl(fontOpts, () => cs()?.f || (one()?.type === "wordart" ? one().font : null), v => E.applyChar({ f: v }, "Carattere"), { width: 150, title: "Tipo di carattere", dis: () => !hasText() }),
        comboNum(SIZES, () => cs()?.z, v => E.applyChar({ z: v }, "Dimensione carattere"), { title: "Dimensione carattere", dis: () => !hasText() }),
        sm("grow", null, () => E.growFont(1), { title: "Aumenta dimensione carattere", keys: "Ctrl+Maiusc+>", dis: () => !hasText() }),
        sm("shrink", null, () => E.growFont(-1), { title: "Riduci dimensione carattere", keys: "Ctrl+<", dis: () => !hasText() }),
        sm("clearFmt", null, () => E.clearFormat(), { title: "Cancella formattazione", keys: "Ctrl+Spazio", dis: () => !hasText() })],
      [sm("bold", null, () => E.toggleChar("b", "Grassetto"), { title: "Grassetto", keys: "Ctrl+B", on: () => !!cs()?.b, dis: () => !hasText() }),
        sm("italic", null, () => E.toggleChar("i", "Corsivo"), { title: "Corsivo", keys: "Ctrl+I", on: () => !!cs()?.i, dis: () => !hasText() }),
        sm("underline", null, () => E.toggleChar("u", "Sottolineato"), { title: "Sottolineato", keys: "Ctrl+U", on: () => !!cs()?.u, dis: () => !hasText() }),
        sm(null, "Aa", null, { title: "Maiuscole/minuscole (Maiusc+F3)", menu: () => [["Tutto maiuscolo", "up"], ["tutto minuscolo", "low"], ["Iniziali Maiuscole", "cap"], ["Tipo frase.", "sent"]].map(([l, m]) => ({ label: l, run: () => E.changeCase(m) })), dis: () => !hasText() }),
        sm(null, "Spaziatura", null, { title: "Spaziatura caratteri", menu: () => [[-1, "Molto stretta"], [-0.5, "Stretta"], [0, "Normale"], [1, "Ampia"], [2, "Molto ampia"]].map(([k, l]) => ({ label: l, checked: (cs()?.k || 0) === k, run: () => E.applyChar({ k: k || undefined }, "Spaziatura caratteri") })), dis: () => !hasText() }),
        colorBtn("fontColor", "Colore carattere", () => cs()?.c, v => E.applyChar({ c: v === "none" ? "s0" : v }, "Colore carattere"), { dis: () => !hasText(), none: false, def: "s1" })]),
    );
  }
  function paraGroup() {
    const ps = () => E.paraStyle();
    const al = a => () => ps()?.a === a || (!ps()?.a && a === "l");
    return groupEl("Paragrafo",
      col([sm("bullets", null, () => E.applyPara(p => ({ bu: p.bu && !/\d/.test(p.bu) ? undefined : "•" }), "Elenco puntato"), { title: "Elenco puntato", on: () => !!ps()?.bu && !/\d/.test(ps().bu), dis: () => !hasText() }),
        sm(null, null, null, { title: "Simbolo dell'elenco", menu: () => ["•", "◦", "▪", "–", "✓", "➢", "★"].map(b => ({ label: b + "  elenco", run: () => E.applyPara({ bu: b }, "Elenco puntato") })), dis: () => !hasText() }),
        sm("numbering", null, () => E.applyPara(p => ({ bu: p.bu && /\d/.test(p.bu) ? undefined : "1." }), "Elenco numerato"), { title: "Numerazione", on: () => /\d/.test(ps()?.bu || ""), dis: () => !hasText() }),
        sm("indentDec", null, () => E.applyPara(p => ({ li: Math.max(0, (p.li || 0) - 18) }), "Riduci rientro"), { title: "Riduci rientro", dis: () => !hasText() }),
        sm("indentInc", null, () => E.applyPara(p => ({ li: (p.li || 0) + 18 }), "Aumenta rientro"), { title: "Aumenta rientro", dis: () => !hasText() }),
        sm("paraMarks", null, () => E.toggleShow("marks"), { title: "Mostra caratteri speciali (Ctrl+Maiusc+Y)", on: () => E.show.marks })],
      [sm("alignL", null, () => E.applyPara({ a: "l" }, "Allinea a sinistra"), { title: "Allinea testo a sinistra", keys: "Ctrl+L", on: al("l"), dis: () => !hasText() }),
        sm("alignC", null, () => E.applyPara({ a: "c" }, "Centra"), { title: "Centra", keys: "Ctrl+E", on: al("c"), dis: () => !hasText() }),
        sm("alignR", null, () => E.applyPara({ a: "r" }, "Allinea a destra"), { title: "Allinea testo a destra", keys: "Ctrl+R", on: al("r"), dis: () => !hasText() }),
        sm("alignJ", null, () => E.applyPara({ a: "j" }, "Giustifica"), { title: "Giustifica", keys: "Ctrl+J", on: al("j"), dis: () => !hasText() }),
        sm("lineSpacing", null, null, { title: "Interlinea", menu: () => [...[1, 1.15, 1.5, 2, 2.5, 3].map(v => ({ label: String(v).replace(".", ","), checked: (ps()?.lh || 1) === v, run: () => E.applyPara({ lh: v }, "Interlinea") })), "-", { label: "Opzioni paragrafo...", run: paraDlg }], dis: () => !hasText() }),
        sm(null, "...", paraDlg, { title: "Paragrafo: rientri e spaziatura", dis: () => !hasText() })]));
  }
  function tabHome() {
    return [
      groupEl("Appunti", big("paste", "Incolla", () => E.pasteFromSystem(), { menu: () => [{ label: "Incolla", icon: "paste", keys: "Ctrl+V", run: () => E.pasteFromSystem() }, { label: "Incolla formato", keys: "Ctrl+Maiusc+V", run: () => E.pasteFormat() }] }),
        col(sm("cut", "Taglia", () => E.cutSel(), { keys: "Ctrl+X", dis: () => !sel().length && !(edit() && edit().caret !== edit().anchor) }), sm("copy", "Copia", () => E.copySel(), { keys: "Ctrl+C", dis: () => !sel().length && !(edit() && edit().caret !== edit().anchor) }),
          sm("painter", "Copia formato", () => E.copyFormat(), { keys: "Ctrl+Maiusc+C", on: () => !!E.fmtClip, dis: () => !sel().length && !edit() }))),
      fontGroup(),
      paraGroup(),
      groupEl("Stili", big("styles", "Stili", null, { menu: stylesMenu, dis: () => !hasText() })),
      groupEl("Oggetti", big("textbox", "Disegna casella di testo", () => E.setTool("text"), { on: () => E.tool() === "text" }),
        col(sm("table", "Tabella", null, { menu: tableMenu }), sm("picture", "Immagini", () => E.insertPicture()), sm("shapes", "Forme", null, { menu: shapesMenu }))),
      arrangeGroup(),
      groupEl("Modifica", col(sm("find", "Trova", () => E.openFind(false), { keys: "Ctrl+F" }), sm("replace", "Sostituisci", () => E.openFind(true), { keys: "Ctrl+H" }),
        sm("select", "Seleziona", null, { menu: () => [{ label: "Seleziona tutto il testo nella casella", run: () => { const o = one(); if (o?.type === "text") { E.beginEdit(o, 0); const st = doc().stories[o.story]; E.edit().anchor = 0; E.edit().caret = st.chars.length - 1; E.refresh(); } }, dis: () => one()?.type !== "text" }, { label: "Seleziona tutti gli oggetti", keys: "Ctrl+A", run: () => E.setSel(E.items().slice()) }, { label: "Seleziona oggetti", run: () => E.setTool(null) }] }))),
    ];
  }
  const stylesMenu = () => {
    const ps = E.paraStyle();
    const D = doc();
    return [...Object.entries(D.styles).map(([n, s]) => ({ label: n, checked: ps?.st === n, font: fontName(D, s.f), style: { fontSize: clamp(s.z || 10, 10, 18) + "px", fontWeight: s.b ? "700" : "400", fontStyle: s.i ? "italic" : "normal", color: color(D, s.c || "s0") }, run: () => E.applyStyle(n) })),
      "-", { label: "Nuovo stile dalla selezione...", run: newStyleDlg }, { label: "Modifica stile...", run: () => editStyleDlg(ps?.st || "Normale") }];
  };
  const tableMenu = () => {
    const box = el("div", { class: "pb-tgrid" });
    const lab = el("div", { class: "pb-mtitle" }, "Inserisci tabella");
    const grid = el("div", { class: "pb-tcells" });
    for (let r = 0; r < 8; r++) for (let c = 0; c < 10; c++) {
      const cell = el("button", { type: "button", class: "pb-tc" });
      cell.addEventListener("pointerenter", () => { grid.querySelectorAll(".pb-tc").forEach((x, k) => x.classList.toggle("on", Math.floor(k / 10) <= r && k % 10 <= c)); lab.textContent = `Tabella ${c + 1}x${r + 1}`; });
      cell.addEventListener("click", () => { closePop(); E.insertTable(r + 1, c + 1); });
      grid.append(cell);
    }
    box.append(lab, grid);
    return [{ el: box }, "-", { label: "Inserisci tabella...", icon: "table", run: tableDlg }];
  };
  const shapesMenu = () => {
    const box = el("div", { class: "pb-shapes" });
    let g = null;
    for (const [id, name, grp] of SHAPES) {
      if (grp !== g) { box.append(el("div", { class: "pb-mtitle" }, grp)); g = grp; }
      const b = el("button", { type: "button", class: "pb-shp", title: name });
      const W = 20, H = 16;
      const d = shapeCmds(id, W, H).map(c => (c[0] === "Z" ? "Z" : c[0] + c.slice(1).map(v => v.toFixed(1)).join(" "))).join(" ");
      b.innerHTML = `<svg viewBox="-2 -2 24 20"><path d="${d}" ${/line|arrow/.test(id) ? "" : 'fill="currentColor" fill-opacity=".18"'}/>${id === "arrow" || id === "darrow" ? '<path d="M20 16l-5-1 3-3z" fill="currentColor"/>' : ""}</svg>`;
      b.addEventListener("click", () => { closePop(); E.setTool("shape:" + id); });
      box.append(b);
    }
    return [{ el: box }];
  };

  // --------------------------------------------- Inserisci
  function tabInsert() {
    return [
      groupEl("Pagine", big("page", "Pagina", () => E.addPage(false), { menu: () => [{ label: "Inserisci pagina vuota", icon: "page", keys: "Ctrl+Maiusc+N", run: () => E.addPage(false) }, { label: "Inserisci pagina duplicata", icon: "pageDup", keys: "Ctrl+Maiusc+U", run: () => E.addPage(true) }, { label: "Inserisci pagina...", run: insertPagesDlg }] })),
      groupEl("Tabelle", big("table", "Tabella", null, { menu: tableMenu })),
      groupEl("Illustrazioni", big("picture", "Immagini", () => E.insertPicture()), col(sm("placeholder", "Segnaposto immagine", () => E.insertPlaceholder()), sm("shapes", "Forme", null, { menu: shapesMenu }))),
      groupEl("Blocchi predefiniti", col(sm("blocks", "Parti di pagina", null, { menu: () => blockMenu("parti") }), sm("calendar", "Calendari", null, { menu: () => blockMenu("calendari") })),
        col(sm("borderArt", "Bordi e accenti", null, { menu: () => blockMenu("bordi") }), sm("blocks", "Pubblicita'", null, { menu: () => blockMenu("pubblicita") }))),
      groupEl("Testo", big("textbox", "Disegna casella di testo", () => E.setTool("text"), { on: () => E.tool() === "text" }),
        big("wordart", "WordArt", null, { menu: wordArtMenu }),
        col(sm("insertFile", "Inserisci file", () => E.insertTextFile()), sm("symbol", "Simbolo", null, { menu: symbolMenu }), sm("dateTime", "Data e ora", null, { menu: dateMenu }))),
      groupEl("Collegamenti", big("hyperlink", "Collegamento", () => E.hyperlink(), { keys: "Ctrl+K", dis: () => !edit() })),
      groupEl("Intestazione e piè di pagina", col(sm("headerFooter", "Intestazione", () => E.headerFooter("h")), sm("headerFooter", "Piè di pagina", () => E.headerFooter("f")), sm("pageNumber", "Numero di pagina", null, { menu: pageNumMenu }))),
    ];
  }
  const wordArtMenu = () => {
    const styles = [
      { label: "Tinta unita", form: "piatto", fill: "s1", outline: "s0", ow: 0, shadow: false },
      { label: "Con contorno", form: "piatto", fill: "s5", outline: "s1", ow: 2, shadow: false },
      { label: "Con ombra", form: "piatto", fill: "s1", outline: "s0", ow: 0, shadow: true },
      { label: "Arco", form: "arco", fill: "s1", outline: "s0", ow: 0, shadow: false },
      { label: "Arco in giu'", form: "arcoGiu", fill: "s2", outline: "s0", ow: 0, shadow: false },
      { label: "Onda", form: "onda", fill: "s3", outline: "s0", ow: 0, shadow: true },
    ];
    return styles.map(st => ({ label: st.label, icon: "wordart", run: () => E.insertWordArt(st) }));
  };
  const symbolMenu = () => {
    const box = el("div", { class: "pb-symbols" });
    for (const ch of "©®™€£¥$§¶•…–—«»“”‘’°±×÷½¼¾²³µ→←↑↓↔✓✔✗★☆♥♦♣♠☎✉✈☀☂♪✿❖◆■□●○▲►◄▼αβγδΩπΣ∞≈≠≤≥√") {
      const b = el("button", { type: "button", class: "pb-sym" }, ch);
      b.addEventListener("click", () => { closePop(); if (!edit()) return toast("Fai clic nel testo dove inserire il simbolo", true); E.typeText(ch); after(); });
      box.append(b);
    }
    return [{ el: box }];
  };
  const dateMenu = () => {
    const d = new Date();
    const fm = [d.toLocaleDateString(LOCALE), d.toLocaleDateString(LOCALE, { day: "numeric", month: "long", year: "numeric" }), d.toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric" }), d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })];
    return [...fm.map(t => ({ label: t, run: () => (edit() ? E.typeText(t) : toast("Fai clic nel testo dove inserire la data", true)) })), "-", { label: "Campo data (si aggiorna da solo)", run: () => E.insertField("date") }];
  };
  const pageNumMenu = () => [
    { label: "Inserisci numero di pagina nel testo", keys: "Alt+Maiusc+P", run: () => E.insertField("page"), dis: () => !edit() },
    { label: "Inserisci numero totale di pagine nel testo", run: () => E.insertField("pages"), dis: () => !edit() }, "-",
    ...[["In basso a destra", "br"], ["In basso al centro", "bc"], ["In basso a sinistra", "bl"], ["In alto a destra", "tr"], ["In alto al centro", "tc"]].map(([l, pos]) => ({ label: l + " (pagina master)", run: () => E.pageNumberOnMaster(pos) })),
  ];

  // --------------------------------------------- Progettazione pagina
  function tabDesign() {
    const D = doc();
    const schemeGallery = el("div", { class: "pb-gallery" });
    const vis = COLOR_SCHEMES.slice(0, 6);
    const curName = D.scheme.name;
    for (const s of [vis.find(x => x.name === curName) ? null : D.scheme, ...vis].filter(Boolean)) schemeGallery.append(schemeChip(s));
    const more = el("button", { type: "button", class: "pb-galmore", title: "Altre combinazioni di colori" });
    more.innerHTML = pubIcon("caret");
    more.addEventListener("click", () => openMenu(more, [...COLOR_SCHEMES.map(s => ({ el: schemeRow(s) })), "-", { label: "Crea nuova combinazione colori...", run: schemeDlg }], after));
    return [
      groupEl("Modello", big("template", "Cambia modello", () => E.templatesDlg(true))),
      groupEl("Imposta pagina", col(sm("margins", "Margini", null, { menu: marginsMenu }), sm("orientation", "Orientamento", null, { menu: () => [{ label: "Verticale", checked: D.h >= D.w, run: () => E.setOrientation("v") }, { label: "Orizzontale", checked: D.w > D.h, run: () => E.setOrientation("o") }] }),
        sm("size", "Dimensioni", null, { menu: sizeMenu }))),
      groupEl("Layout", col(sm("guides", "Guide", null, { menu: guidesMenu }), check("Allinea alle guide", () => E.snapOpt.guides, v => { E.snapOpt.guides = v; }), check("Allinea agli oggetti", () => E.snapOpt.objects, v => { E.snapOpt.objects = v; }))),
      groupEl("Pagine", col(sm("pageDel", "Elimina", () => E.deletePage(E.cur()), { dis: () => doc().pages.length < 2 || !!E.masterId() }), sm("pageMove", "Sposta", () => movePageDlg(), { dis: () => doc().pages.length < 2 }), sm("master", "Pagine master", null, { menu: masterMenu }))),
      groupEl("Combinazioni", schemeGallery, more, col(sm("fontScheme", "Caratteri", null, { menu: fontsMenu }))),
      groupEl("Sfondo pagina", big("background", "Sfondo", null, { menu: bgMenu })),
    ];
  }
  function schemeChip(s) {
    const b = el("button", { type: "button", class: "pb-scheme" + (doc().scheme.name === s.name ? " on" : ""), title: s.name });
    for (const c of s.c.slice(1, 5)) b.append(el("i", { style: { background: c } }));
    b.addEventListener("click", () => { E.setScheme(s); after(); });
    return b;
  }
  function schemeRow(s) {
    const b = el("button", { type: "button", class: "pb-mit pb-schemerow" + (doc().scheme.name === s.name ? " on" : "") });
    const sw = el("span", { class: "pb-sw" });
    for (const c of s.c) sw.append(el("i", { style: { background: c } }));
    b.append(sw, el("span", {}, s.name));
    b.addEventListener("click", () => { closePop(); E.setScheme(s); after(); });
    return b;
  }
  const marginsMenu = () => [["Sottili", 1.27], ["Moderati", 1.9], ["Normali", 2.54], ["Larghi", 3.8], ["Nessuno", 0]].map(([l, v]) => ({ label: `${l} (${String(v).replace(".", ",")} cm)`, checked: Math.abs(doc().margins.l - v * CM) < 0.5, run: () => E.setMargins(v * CM) })).concat(["-", { label: "Margini personalizzati...", run: marginsDlg }]);
  const sizeMenu = () => [...PAGE_SIZES.map(([n, w, h]) => ({ label: `${n} (${String(w / 10).replace(".", ",")} x ${String(h / 10).replace(".", ",")} cm)`, checked: Math.abs(doc().w - w * MM) < 1 && Math.abs(doc().h - h * MM) < 1 || Math.abs(doc().w - h * MM) < 1 && Math.abs(doc().h - w * MM) < 1, run: () => E.setPageSize(w * MM, h * MM) })), "-", { label: "Dimensioni pagina personalizzate...", run: pageSizeDlg }];
  const guidesMenu = () => [
    { title: "Guide del layout" },
    ...[[1, 1, "Nessuna"], [2, 1, "2 colonne"], [3, 1, "3 colonne"], [4, 1, "4 colonne"], [2, 2, "Griglia 2x2"], [3, 3, "Griglia 3x3"], [1, 2, "2 righe"]].map(([c, r, l]) => ({ label: l, checked: (doc().grid.cols || 1) === c && (doc().grid.rows || 1) === r, run: () => E.setGrid(c, r) })),
    "-", { label: "Aggiungi guida orizzontale", run: () => E.addGuide("h") }, { label: "Aggiungi guida verticale", run: () => E.addGuide("v") },
    { label: "Elimina tutte le guide del righello", run: () => E.clearGuides() }, "-", { label: "Guide di griglia e linea di base...", run: guidesDlg },
  ];
  E.guidesDlg = guidesDlg;
  const masterMenu = () => [
    ...doc().masters.map(m => ({ label: `Applica ${m.name}`, checked: E.page()?.master === m.id, run: () => E.applyMaster(m.id) })),
    { label: "Nessuna pagina master", checked: !E.page()?.master, run: () => E.applyMaster(null) }, "-",
    { label: "Modifica pagine master", icon: "master", keys: "Ctrl+M", run: () => E.toggleMaster() },
  ];
  const fontsMenu = () => [...FONT_SCHEMES.map(f => ({ el: fontRow(f) })), "-", { label: "Crea nuova combinazione caratteri...", run: fontSchemeDlg }];
  function fontRow(f) {
    const b = el("button", { type: "button", class: "pb-mit pb-fontrow" + (doc().fonts.name === f.name ? " on" : "") });
    b.append(el("span", { class: "pb-mico" }, doc().fonts.name === f.name ? "✓" : ""), el("span", {}, el("b", {}, f.name), el("span", { style: { fontFamily: `"${f.t}"`, fontSize: "15px" } }, f.t), el("span", { style: { fontFamily: `"${f.b}"` } }, f.b)));
    b.addEventListener("click", () => { closePop(); E.setFonts(f); after(); });
    return b;
  }
  const bgMenu = () => {
    const D = doc();
    const box = el("div", { class: "pb-bgs" });
    for (const v of [null, "s5", "s1:20", "s2:20", "s3:20", "s1:40", "s1", "s2", "s3", "s4"]) {
      const b = el("button", { type: "button", class: "pb-bgc", title: v ? "Sfondo a tinta unita" : "Nessuno sfondo", style: { background: v ? color(D, v) : "#fff" } }, v ? "" : "∅");
      b.addEventListener("click", () => { closePop(); E.setBackground(v ? { c: v } : null); after(); });
      box.append(b);
    }
    return [{ title: "Sfondo a tinta unita" }, { el: box }, "-", { label: "Altro colore...", run: () => { const inp = el("input", { type: "color", value: "#ffffff" }); inp.addEventListener("change", () => E.setBackground({ c: inp.value })); inp.click(); } },
      { label: "Immagine di sfondo...", icon: "picture", run: () => E.backgroundImage() }, { label: "Applica a tutte le pagine", run: () => E.backgroundAll() }, { label: "Rimuovi sfondo", run: () => E.setBackground(null) }];
  };

  // --------------------------------------------- Mailing
  function tabMail() {
    const M = () => doc().merge;
    const st = () => E.mergeState();
    const recLabel = el("span", { class: "pb-rec" });
    reg(() => { recLabel.textContent = M()?.rows?.length ? `${st().idx + 1} di ${M().rows.length}` : "-"; });
    return [
      groupEl("Avvia", big("recipients", "Seleziona destinatari", null, { menu: () => [{ label: "Usa elenco esistente (CSV, Excel)...", run: () => E.loadRecipients() }, { label: "Modifica elenco destinatari...", run: recipientsDlg, dis: () => !M() }, { label: "Rimuovi elenco", run: () => { doc().merge = null; E.setMerge(0, false); E.commit("Rimuovi elenco"); }, dis: () => !M() }] })),
      groupEl("Scrivi e inserisci campi", big("mergeField", "Inserisci campo unione", null, { menu: () => (M()?.fields || []).map(f => ({ label: f, run: () => E.insertField("merge:" + f) })).concat(M() ? [] : [{ label: "Seleziona prima i destinatari", dis: true }]), dis: () => !M() })),
      groupEl("Anteprima risultati", big("preview", "Anteprima risultati", () => E.setMerge(st().idx, !st().preview), { on: () => st().preview, dis: () => !M() }),
        col([sm("first", null, () => E.setMerge(0, true), { title: "Primo record", dis: () => !M() }), sm("prev", null, () => E.setMerge(Math.max(0, st().idx - 1), true), { title: "Record precedente", dis: () => !M() }), recLabel,
          sm("next", null, () => E.setMerge(Math.min((M()?.rows.length || 1) - 1, st().idx + 1), true), { title: "Record successivo", dis: () => !M() }), sm("last", null, () => E.setMerge((M()?.rows.length || 1) - 1, true), { title: "Ultimo record", dis: () => !M() })])),
      groupEl("Fine", big("finish", "Completa e unisci", null, { menu: () => [{ label: "Unisci in un PDF (una copia per destinatario)...", icon: "exportPdf", run: () => mergeToPdf() }], dis: () => !M() })),
    ];
  }

  // --------------------------------------------- Revisione
  function tabReview() {
    return [
      groupEl("Strumento di correzione", big("spell", "Controllo ortografia", () => E.spell(), { keys: "F7" }), col(sm("wordcount", "Conteggio parole", () => wordCountDlg()), sm("thesaurus", "Trova", () => E.openFind(false)))),
      groupEl("Lingua", big("language", "Lingua", () => toast("Il controllo ortografico usa la lingua italiana di Windows (dizionario di WebView2)", false, 5000))),
    ];
  }

  // --------------------------------------------- Visualizza
  function tabView() {
    return [
      groupEl("Visualizzazioni", big("singlePage", "Normale", () => E.masterId() && E.toggleMaster(), { on: () => !E.masterId() }), big("master", "Pagina master", () => E.toggleMaster(), { on: () => !!E.masterId(), keys: "Ctrl+M" })),
      groupEl("Layout", col(sm("singlePage", "Pagina singola", () => E.setSpread(false), { on: () => !E.spread() }), sm("twoPage", "Pagine affiancate", () => E.setSpread(true), { on: () => E.spread() }))),
      groupEl("Mostra", col(check("Limiti", () => E.show.bounds, () => E.toggleShow("bounds")), check("Guide", () => E.show.guides, () => E.toggleShow("guides")), check("Caratteri speciali", () => E.show.marks, () => E.toggleShow("marks"))),
        col(check("Righelli", () => E.show.rulers, () => E.toggleShow("rulers")), check("Navigazione pagine", () => E.show.pages, () => E.toggleShow("pages")))),
      groupEl("Zoom", col(comboNum([10, 25, 33, 50, 66, 75, 100, 150, 200, 400], () => E.zoomPct(), v => E.setZoomPct(v), { title: "Zoom (%)", width: 58 }), sm("zoom100", "100%", () => E.zoom100(), { keys: "F9" })),
        col(sm("zoomPage", "Pagina intera", () => E.fitPage(), { keys: "Ctrl+Maiusc+L" }), sm("zoomWidth", "Larghezza pagina", () => E.fitWidth()), sm("zoomSel", "Oggetti selezionati", () => E.zoomSel(), { dis: disNoSel }))),
    ];
  }

  // --------------------------------------------- Pagina master
  function tabMaster() {
    return [
      groupEl("Pagina master", col(sm("page", "Aggiungi pagina master", () => E.addMaster()), sm("pageDup", "Duplica", () => E.addMaster(true)), sm(null, "Rinomina", () => renameMasterDlg())),
        col(sm("pageDel", "Elimina", () => E.deleteMaster(), { dis: () => doc().masters.length < 2 }), sm("headerFooter", "Intestazione", () => E.headerFooter("h")), sm("headerFooter", "Piè di pagina", () => E.headerFooter("f")))),
      groupEl("Chiudi", big("master", "Chiudi pagina master", () => E.toggleMaster())),
    ];
  }

  // --------------------------------------------- Formato: casella di testo
  function tabFmtText() {
    const tb = () => (edit()?.kind === "frame" ? edit().o : one()?.type === "text" ? one() : null);
    const setF = (patch, label) => { const o = tb(); if (!o) return; Object.assign(o, patch); E.commit(label); };
    return [
      groupEl("Testo", big("fitText", "Adatta testo", null, { menu: () => [["best", "Adattamento ottimale"], ["shrink", "Riduci testo in eccesso"], ["grow", "Aumenta casella per adattarla al testo"], ["none", "Non adattare il testo"]].map(([v, l]) => ({ label: l, checked: (tb()?.fit || "none") === v, run: () => setF({ fit: v }, "Adatta testo") })) }),
        col(sm(null, "Interlinea", null, { menu: () => [1, 1.15, 1.5, 2].map(v => ({ label: String(v).replace(".", ","), run: () => E.applyPara({ lh: v }, "Interlinea") })) }), sm(null, "Capolettera", () => E.dropCap(), { dis: () => !tb() }))),
      groupEl("Allineamento", col([sm("valignT", null, () => setF({ valign: "t" }, "Allinea in alto"), { title: "Allinea in alto", on: () => (tb()?.valign || "t") === "t" }), sm("valignM", null, () => setF({ valign: "m" }, "Allinea al centro"), { title: "Allinea al centro verticalmente", on: () => tb()?.valign === "m" }), sm("valignB", null, () => setF({ valign: "b" }, "Allinea in basso"), { title: "Allinea in basso", on: () => tb()?.valign === "b" })],
        [sm("boxMargins", "Margini", null, { menu: () => [["Nessuno", 0], ["Stretti", 4], ["Moderati", 7.2], ["Larghi", 14.4]].map(([l, v]) => ({ label: l, checked: (tb()?.pad?.[0] ?? 4) === v, run: () => setF({ pad: [v, v, v, v] }, "Margini casella") })).concat(["-", { label: "Margini personalizzati...", run: () => boxMarginsDlg(tb()) }]) }),
          sm("columns", "Colonne", null, { menu: () => [1, 2, 3, 4].map(n => ({ label: n === 1 ? "1 colonna" : n + " colonne", checked: (tb()?.cols || 1) === n, run: () => setF({ cols: n }, "Colonne") })).concat(["-", { label: "Altre colonne...", run: () => columnsDlg(tb()) }]) })])),
      groupEl("Collegamento", big("link", "Crea collegamento", () => E.linkStart(), { dis: () => !tb() }), col(sm("unlink", "Interrompi", () => E.unlink(), { dis: () => !tb()?.next }), sm("nextBox", "Avanti", () => E.gotoLinked("next"), { dis: () => !tb()?.next }), sm("prevBox", "Indietro", () => E.gotoLinked("prev"), { dis: () => !tb() || !allItems(doc()).some(x => x.next === tb().id) }))),
      fillGroup(),
      arrangeGroup(),
      sizeGroup(),
    ];
  }
  // --------------------------------------------- Formato: immagine
  function tabFmtPic() {
    const im = () => (one()?.type === "image" ? one() : null);
    const fx = patch => { for (const o of sel()) if (o.type === "image") o.fx = { ...(o.fx || {}), ...patch }; E.commit("Regola immagine"); };
    return [
      groupEl("Inserisci", big("changePic", "Cambia immagine", () => E.changePicture(), { dis: () => !im() })),
      groupEl("Regola", col(sm("brightness", "Correzioni", null, { menu: () => [{ title: "Luminosita'" }, ...[-40, -20, 0, 20, 40].map(v => ({ label: (v > 0 ? "+" : "") + v + "%", checked: (im()?.fx?.bright || 0) === v, run: () => fx({ bright: v || undefined }) })), { title: "Contrasto" }, ...[-40, -20, 0, 20, 40].map(v => ({ label: (v > 0 ? "+" : "") + v + "%", checked: (im()?.fx?.contrast || 0) === v, run: () => fx({ contrast: v || undefined }) }))], dis: () => !im() }),
        sm("recolor", "Ricolora", null, { menu: () => [{ label: "Nessuna ricolorazione", run: () => fx({ gray: undefined, sepia: undefined, wash: undefined }) }, { label: "Scala di grigi", checked: !!im()?.fx?.gray, run: () => fx({ gray: true, sepia: undefined }) }, { label: "Seppia", checked: !!im()?.fx?.sepia, run: () => fx({ sepia: true, gray: undefined }) }, { label: "Sbiadito (filigrana)", checked: !!im()?.fx?.wash, run: () => fx({ wash: !im()?.fx?.wash }) }], dis: () => !im() }),
        sm("resetPic", "Reimposta immagine", () => E.resetPicture(), { dis: () => !im()?.img }))),
      groupEl("Stili immagine", col(colorBtn("outline", "Bordo immagine", lineGet, v => propSet(o => ({ line: { w: o.line?.w || 1.5, dash: "solid", c: v } }), "Bordo immagine"), { dis: disNoSel, noneLabel: "Nessun bordo", def: "s0" }),
        sm("outline", "Spessore bordo", null, { menu: weightMenu, dis: disNoSel }), sm("shadow", "Ombra", () => propSet(o => ({ shadow: !o.shadow }), "Ombra"), { on: () => !!one()?.shadow, dis: disNoSel }))),
      arrangeGroup(),
      groupEl("Ritaglia", big("crop", "Ritaglia", () => E.cropToggle(), { on: () => !!E.crop(), dis: () => !im()?.img }), col(sm(null, "Adatta", () => E.fitPicture("fit"), { dis: () => !im()?.img, title: "L'immagine intera entra nella cornice" }), sm(null, "Riempi", () => E.fitPicture("fill"), { dis: () => !im()?.img, title: "L'immagine riempie la cornice (ritaglio centrato)" }), sm(null, "Togli ritaglio", () => E.fitPicture("none"), { dis: () => !im()?.img }))),
      sizeGroup(),
    ];
  }
  // --------------------------------------------- Formato: disegno
  function tabFmtDraw() {
    return [
      groupEl("Inserisci forme", big("shapes", "Forme", null, { menu: shapesMenu }), big("textbox", "Casella di testo", () => E.setTool("text"))),
      fillGroup(sel().length > 0 && sel().every(isLine)),
      arrangeGroup(),
      sizeGroup(),
    ];
  }
  // --------------------------------------------- Formato: WordArt
  function tabFmtWordArt() {
    const wa = () => (one()?.type === "wordart" ? one() : null);
    const setW = (p, l) => { for (const o of sel()) if (o.type === "wordart") Object.assign(o, p); E.commit(l); };
    return [
      groupEl("Testo", big("editText", "Modifica testo", () => E.editWordArt()), col(selectCtl(() => [["+t", `${doc().fonts.t} (Titoli)`, doc().fonts.t], ["+b", `${doc().fonts.b} (Corpo)`, doc().fonts.b], ...FONTS.map(f => [f, f, f])], () => wa()?.font, v => setW({ font: v }, "Carattere WordArt"), { width: 140 }),
        [sm("bold", null, () => setW({ b: !wa()?.b }, "Grassetto"), { on: () => !!wa()?.b, title: "Grassetto" }), sm("italic", null, () => setW({ i: !wa()?.i }, "Corsivo"), { on: () => !!wa()?.i, title: "Corsivo" })])),
      groupEl("Stili WordArt", col(colorBtn("fill", "Riempimento", () => wa()?.fill, v => setW({ fill: v }, "Riempimento WordArt"), { none: false }), colorBtn("outline", "Contorno", () => wa()?.outline, v => setW({ outline: v, ow: wa()?.ow || 1.5 }, "Contorno WordArt"), { none: false, def: "s0" }),
        sm("outline", "Spessore contorno", null, { menu: () => [0, 0.75, 1.5, 2.25, 3, 4.5].map(w => ({ label: w ? String(w).replace(".", ",") + " pt" : "Nessuno", checked: (wa()?.ow || 0) === w, run: () => setW({ ow: w }, "Contorno WordArt") })) }))),
      groupEl("Effetti", big("wordartForm", "Forma", null, { menu: () => [["piatto", "Diritto"], ["arco", "Arco"], ["arcoGiu", "Arco in giu'"], ["onda", "Onda"]].map(([f, l]) => ({ label: l, checked: (wa()?.form || "piatto") === f, run: () => setW({ form: f }, "Forma WordArt") })) }),
        big("shadow", "Ombra", () => setW({ shadow: !wa()?.shadow }, "Ombra"), { on: () => !!wa()?.shadow })),
      arrangeGroup(),
      sizeGroup(),
    ];
  }
  // --------------------------------------------- Tabella
  const tbl = () => (edit()?.kind === "cell" ? edit().o : one()?.type === "table" ? one() : null);
  const cells = () => {
    const t = tbl();
    if (!t) return [];
    if (edit()?.kind === "cell") return [t.cells[edit().r][edit().c]];
    return t.cells.flat();
  };
  function tabTableDesign() {
    return [
      groupEl("Formati tabella", ...[["Griglia", "grid"], ["Intestazione", "header"], ["Righe alterne", "banded"], ["Semplice", "plain"]].map(([l, p]) => big("table", l, () => E.tableStyle(p)))),
      groupEl("Riempimento", col(colorBtn("cellFill", "Riempimento cella", () => cells()[0]?.fill, v => { for (const c of cells()) c.fill = v; E.commit("Riempimento cella"); }, { noneLabel: "Nessun riempimento" }))),
      groupEl("Bordi", col(colorBtn("borders", "Colore bordi", () => tbl()?.border?.c, v => { tbl().border = { w: 0.75, ...(tbl().border || {}), c: v }; E.commit("Bordi"); }, { noneLabel: "Nessun bordo", def: "s0" }),
        sm("outline", "Spessore", null, { menu: () => [0, 0.5, 0.75, 1, 1.5, 2.25, 3].map(w => ({ label: w ? String(w).replace(".", ",") + " pt" : "Nessun bordo", run: () => { tbl().border = { c: tbl().border?.c || "s0", w }; E.commit("Bordi"); } })) }))),
      arrangeGroup(),
      sizeGroup(),
    ];
  }
  function tabTableLayout() {
    const ce = () => edit()?.kind === "cell";
    return [
      groupEl("Righe e colonne", col(sm("rowAbove", "Inserisci sopra", () => E.tableOp("rowAbove")), sm("rowBelow", "Inserisci sotto", () => E.tableOp("rowBelow"))), col(sm("colLeft", "Inserisci a sinistra", () => E.tableOp("colLeft")), sm("colRight", "Inserisci a destra", () => E.tableOp("colRight"))),
        col(sm("delRow", "Elimina righe", () => E.tableOp("delRow"), { dis: () => !ce() }), sm("delCol", "Elimina colonne", () => E.tableOp("delCol"), { dis: () => !ce() }), sm("delTable", "Elimina tabella", () => E.tableOp("delTable")))),
      groupEl("Dimensioni cella", col(numField("Larghezza", () => (ce() ? cm(tbl().colW[edit().c]) : ""), v => E.tableOp("colW", fromCm(v)), { unit: "cm", dis: () => !ce() }), numField("Altezza", () => (ce() ? cm(tbl().rowH[edit().r]) : ""), v => E.tableOp("rowH", fromCm(v)), { unit: "cm", dis: () => !ce() })),
        col(sm("distRows", "Distribuisci righe", () => E.tableOp("distRows")), sm("distCols", "Distribuisci colonne", () => E.tableOp("distCols")))),
      groupEl("Allineamento", col([sm("valignT", null, () => E.tableOp("valign", "t"), { title: "Allinea in alto" }), sm("valignM", null, () => E.tableOp("valign", "m"), { title: "Allinea al centro" }), sm("valignB", null, () => E.tableOp("valign", "b"), { title: "Allinea in basso" })],
        [sm("alignL", null, () => E.applyPara({ a: "l" }), { title: "A sinistra" }), sm("alignC", null, () => E.applyPara({ a: "c" }), { title: "Al centro" }), sm("alignR", null, () => E.applyPara({ a: "r" }), { title: "A destra" })])),
      sizeGroup(),
    ];
  }

  // --------------------------------------------- blocchi predefiniti
  function blockMenu(kind) {
    const D = doc();
    const B = {
      parti: [["Titolo con linea", () => [textBox(D, 0, 0, 300, 40, [["Titolo della sezione", "Titolo 1", { sb: 0 }]]), shapeBox(D, "rect", 0, 42, 300, 2.5, "s3", null, { wrap: "none" })]],
        ["Barra laterale", () => [shapeBox(D, "rect", 0, 0, 150, 260, "s1:15", null, { wrap: "none" }), textBox(D, 8, 8, 134, 244, [["In evidenza", "Titolo 2", { sb: 0 }], ["Primo punto", "Elenco puntato"], ["Secondo punto", "Elenco puntato"], ["Terzo punto", "Elenco puntato"]])]],
        ["Citazione", () => [shapeBox(D, "round", 0, 0, 220, 110, "s1", null, { wrap: "none" }), textBox(D, 10, 10, 200, 90, [["“Una frase che merita attenzione.”", "Citazione", { c: "s5" }]], { valign: "m" })]],
        ["Articolo a due colonne", () => [textBox(D, 0, 0, 360, 36, [["Titolo dell'articolo", "Titolo 1", { sb: 0 }]]), textBox(D, 0, 40, 360, 220, [["Scrivete qui il testo dell'articolo. Il testo si distribuisce sulle due colonne della casella.", "Corpo del testo"], ["Aggiungete paragrafi, elenchi e immagini: il testo gira attorno agli oggetti che hanno la disposizione \"Quadrato\".", "Corpo del testo"]], { cols: 2, gap: 12 })]],
        ["Informazioni di contatto", () => [textBox(D, 0, 0, 200, 80, [["Azienda Esempio S.r.l.", "Indirizzo", { b: true }], ["Via Esempio 1 · 00000 Citta'", "Indirizzo"], ["Tel. +39 000 000 0000", "Indirizzo"], ["info@azienda.it · www.azienda.it", "Indirizzo"]])]]],
      calendari: [0, 1, 2].map(k => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + k); return [d.toLocaleDateString(LOCALE, { month: "long", year: "numeric" }), () => calendar(D, d)]; }),
      bordi: [["Barra di accento", () => [shapeBox(D, "rect", 0, 0, 360, 8, "s1", null, { wrap: "none" })]],
        ["Doppia linea", () => [shapeBox(D, "line", 0, 0, 360, 0, "none", { c: "s1", w: 2.25 }, { wrap: "none" }), shapeBox(D, "line", 0, 5, 360, 0, "none", { c: "s1", w: 0.75 }, { wrap: "none" })]],
        ["Cornice pagina", () => { const M = D.margins; return [shapeBox(D, "rect", M.l, M.t, D.w - M.l - M.r, D.h - M.t - M.b, "none", { c: "s1", w: 2.25 }, { wrap: "none" })]; }],
        ["Angoli decorativi", () => [shapeBox(D, "rtriangle", 0, 0, 60, 60, "s1", null, { wrap: "none", rot: 90 }), shapeBox(D, "rtriangle", 300, 140, 60, 60, "s1", null, { wrap: "none", rot: 270 })]],
        ["Fascia con punti", () => [shapeBox(D, "rect", 0, 0, 360, 30, "s1", null, { wrap: "none" }), ...[0, 1, 2, 3, 4].map(k => shapeBox(D, "ellipse", 140 + k * 18, 11, 8, 8, "s5", null, { wrap: "none" }))]]],
      pubblicita: [["Coupon", () => [shapeBox(D, "rect", 0, 0, 220, 120, "s5", { c: "s1", w: 1.5, dash: "dash" }, { wrap: "none" }), textBox(D, 10, 10, 200, 100, [["BUONO SCONTO", "Titolo 3", { a: "c", sb: 0 }], ["-10%", "Titolo", { a: "c", z: 34 }], ["Valido fino al 31/12", "Didascalia", { a: "c" }]], { valign: "m" })]],
        ["Offerta speciale", () => [shapeBox(D, "burst", 0, 0, 140, 140, "s3", null, { wrap: "none" }), textBox(D, 25, 45, 90, 50, [["OFFERTA", "Testo in evidenza", { c: "s0" }], ["speciale", "Normale", { a: "c" }]], { valign: "m" })]],
        ["Annuncio", () => [shapeBox(D, "rect", 0, 0, 260, 150, "s1", null, { wrap: "none" }), textBox(D, 12, 12, 236, 126, [["Titolo dell'annuncio", "Titolo 2", { c: "s5", sb: 0 }], ["Descrivete in breve l'offerta, il prodotto o l'evento.", "Normale", { c: "s5" }], ["Chiamate ora: 000 000 0000", "Normale", { c: "s5", b: true }]])]]],
    };
    return (B[kind] || []).map(([label, make]) => ({ label, run: () => E.insertBlock(make(), label) }));
  }
  function calendar(D, d) {
    const y = d.getFullYear(), mo = d.getMonth();
    const first = (new Date(y, mo, 1).getDay() + 6) % 7, days = new Date(y, mo + 1, 0).getDate();
    const rows = Math.ceil((first + days) / 7) + 1;
    const t = tableBox(D, 0, 30, rows, 7, 7 * 40, 22);
    const set = (r, c, txt, o = {}) => { const st = D.stories[t.cells[r][c].story]; const s = S({ ...st.chars[0].s, ...o }); st.chars = [...Array.from(txt).map(ch => ({ c: ch, s })), { ...st.chars[st.chars.length - 1], s, p: S({ ...(st.chars[st.chars.length - 1].p || {}), a: "c" }) }]; };
    ["L", "M", "M", "G", "V", "S", "D"].forEach((n, c) => set(0, c, n, { b: true, c: "s5" }));
    for (let k = 0; k < days; k++) { const pos = first + k; set(1 + Math.floor(pos / 7), pos % 7, String(k + 1), (pos % 7) === 6 ? { c: "s1", b: true } : {}); }
    for (let r = 1; r < rows; r++) for (let c = 0; c < 7; c++) t.cells[r][c].fill = "none";
    const title = textBox(D, 0, 0, 280, 28, [[d.toLocaleDateString(LOCALE, { month: "long", year: "numeric" }).replace(/^./, x => x.toUpperCase()), "Titolo 2", { a: "c", sb: 0 }]]);
    return [title, t];
  }

  // --------------------------------------------- finestre di dialogo
  const row = (label, input) => el("label", { class: "pb-dlgrow" }, el("span", {}, label), input);
  const inText = v => el("input", { type: "text", class: "field", value: String(v).replace(".", ",") });
  async function paraDlg() {
    const p = E.paraStyle() || {};
    const f = { a: el("select", { class: "field" }, ...[["l", "Sinistra"], ["c", "Centrato"], ["r", "Destra"], ["j", "Giustificato"]].map(([v, l]) => el("option", { value: v, selected: (p.a || "l") === v }, l))),
      li: inText(cm(p.li || 0)), fi: inText(cm(p.fi || 0)), ri: inText(cm(p.ri || 0)), sb: inText(p.sb || 0), sa: inText(p.sa || 0), lh: inText(p.lh || 1) };
    const ok = await modal("Paragrafo", el("div", { class: "pb-dlg" }, row("Allineamento", f.a), row("Rientro sinistro (cm)", f.li), row("Prima riga (cm)", f.fi), row("Rientro destro (cm)", f.ri), row("Spazio prima (pt)", f.sb), row("Spazio dopo (pt)", f.sa), row("Interlinea (righe)", f.lh)),
      [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok) return after();
    const n = x => parseFloat(String(x.value).replace(",", ".")) || 0;
    E.applyPara({ a: f.a.value, li: fromCm(f.li.value) || undefined, fi: fromCm(f.fi.value) || undefined, ri: fromCm(f.ri.value) || undefined, sb: n(f.sb), sa: n(f.sa), lh: n(f.lh) || 1 }, "Paragrafo");
    after();
  }
  function styleForm(st) {
    const D = doc();
    const f = {
      f: el("select", { class: "field" }, ...[["+t", `${D.fonts.t} (Titoli)`], ["+b", `${D.fonts.b} (Corpo)`], ...FONTS.map(x => [x, x])].map(([v, l]) => el("option", { value: v, selected: st.f === v }, l))),
      z: inText(st.z || 10), b: el("input", { type: "checkbox", checked: !!st.b }), i: el("input", { type: "checkbox", checked: !!st.i }),
      c: el("select", { class: "field" }, ...["s0", "s1", "s2", "s3", "s4", "s5"].map((v, k) => el("option", { value: v, selected: st.c === v }, k ? "Accento " + k : "Principale"))),
      a: el("select", { class: "field" }, ...[["l", "Sinistra"], ["c", "Centrato"], ["r", "Destra"], ["j", "Giustificato"]].map(([v, l]) => el("option", { value: v, selected: (st.a || "l") === v }, l))),
      sb: inText(st.sb || 0), sa: inText(st.sa || 0), lh: inText(st.lh || 1),
    };
    const body = el("div", { class: "pb-dlg" }, row("Carattere", f.f), row("Dimensione (pt)", f.z), row("Grassetto", f.b), row("Corsivo", f.i), row("Colore", f.c), row("Allineamento", f.a), row("Spazio prima (pt)", f.sb), row("Spazio dopo (pt)", f.sa), row("Interlinea", f.lh));
    const read = () => { const n = x => parseFloat(String(x.value).replace(",", ".")) || 0; return { f: f.f.value, z: n(f.z) || 10, b: f.b.checked || undefined, i: f.i.checked || undefined, c: f.c.value, a: f.a.value, sb: n(f.sb), sa: n(f.sa), lh: n(f.lh) || 1 }; };
    return { body, read };
  }
  async function newStyleDlg() {
    const cs = E.charStyle() || {}, ps = E.paraStyle() || {};
    const name = el("input", { type: "text", class: "field", value: "Stile " + (Object.keys(doc().styles).length + 1) });
    const form = styleForm({ ...cs, ...ps });
    const ok = await modal("Nuovo stile", el("div", {}, row("Nome", name), form.body), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok || !name.value.trim()) return after();
    doc().styles[name.value.trim()] = form.read();
    E.applyStyle(name.value.trim());
    after();
  }
  async function editStyleDlg(name) {
    const D = doc();
    const st = D.styles[name];
    if (!st) return;
    const form = styleForm(st);
    const ok = await modal("Modifica stile: " + name, form.body, [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok) return after();
    D.styles[name] = form.read();
    // il nuovo stile vale per tutti i paragrafi che lo usano
    const def = D.styles[name];
    for (const story of Object.values(D.stories)) {
      let start = 0;
      story.chars.forEach((ch, k) => {
        if (ch.c !== "\n") return;
        if (ch.p?.st === name) { for (let q = start; q <= k; q++) story.chars[q] = { ...story.chars[q], s: S(charPart(def)) }; story.chars[k] = { ...story.chars[k], p: S(paraPart(def, name)) }; }
        start = k + 1;
      });
    }
    E.commit("Modifica stile " + name);
    after();
  }
  async function tableDlg() {
    const r = inText(4), c = inText(3);
    const ok = await modal("Inserisci tabella", el("div", { class: "pb-dlg" }, row("Numero di righe", r), row("Numero di colonne", c)), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) E.insertTable(clamp(parseInt(r.value) || 1, 1, 100), clamp(parseInt(c.value) || 1, 1, 30));
    after();
  }
  async function insertPagesDlg() {
    const n = inText(1);
    const where = el("select", { class: "field" }, el("option", { value: "after" }, "Dopo la pagina corrente"), el("option", { value: "before" }, "Prima della pagina corrente"));
    const what = el("select", { class: "field" }, el("option", { value: "blank" }, "Pagine vuote"), el("option", { value: "text" }, "Una casella di testo in ogni pagina"), el("option", { value: "dup" }, "Duplica tutti gli oggetti della pagina corrente"));
    const ok = await modal("Inserisci pagina", el("div", { class: "pb-dlg" }, row("Numero di nuove pagine", n), row("Posizione", where), row("Opzioni", what)), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) E.insertPages(clamp(parseInt(n.value) || 1, 1, 200), where.value, what.value);
    after();
  }
  async function movePageDlg() {
    const D = doc();
    const to = el("select", { class: "field" }, ...D.pages.map((_, k) => el("option", { value: k, selected: k === E.cur() }, "Pagina " + (k + 1))));
    const pos = el("select", { class: "field" }, el("option", { value: "before" }, "Prima della pagina"), el("option", { value: "after" }, "Dopo la pagina"));
    const ok = await modal("Sposta pagina " + (E.cur() + 1), el("div", { class: "pb-dlg" }, row("Posizione", pos), row("Pagina", to)), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok) return after();
    let t = +to.value + (pos.value === "after" ? 1 : 0);
    if (t > E.cur()) t--;
    E.movePage(E.cur(), t);
    after();
  }
  async function marginsDlg() {
    const M = doc().margins;
    const f = { l: inText(cm(M.l)), r: inText(cm(M.r)), t: inText(cm(M.t)), b: inText(cm(M.b)) };
    const ok = await modal("Guide dei margini", el("div", { class: "pb-dlg" }, row("Sinistro (cm)", f.l), row("Destro (cm)", f.r), row("Superiore (cm)", f.t), row("Inferiore (cm)", f.b)), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) { doc().margins = { l: fromCm(f.l.value), r: fromCm(f.r.value), t: fromCm(f.t.value), b: fromCm(f.b.value) }; E.commit("Margini"); }
    after();
  }
  async function pageSizeDlg() {
    const w = inText(cm(doc().w)), h = inText(cm(doc().h));
    const ok = await modal("Dimensioni pagina personalizzate", el("div", { class: "pb-dlg" }, row("Larghezza (cm)", w), row("Altezza (cm)", h)), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) E.setPageSize(Math.max(CM, fromCm(w.value)), Math.max(CM, fromCm(h.value)));
    after();
  }
  async function guidesDlg() {
    const G = doc().grid;
    const f = { c: inText(G.cols || 1), r: inText(G.rows || 1), g: inText(cm(G.gap || 0)) };
    const ok = await modal("Guide del layout", el("div", { class: "pb-dlg" }, row("Colonne", f.c), row("Righe", f.r), row("Spazio fra colonne e righe (cm)", f.g)), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) { doc().grid = { cols: clamp(parseInt(f.c.value) || 1, 1, 24), rows: clamp(parseInt(f.r.value) || 1, 1, 24), gap: fromCm(f.g.value) }; E.commit("Guide del layout"); }
    after();
  }
  async function schemeDlg() {
    const s = doc().scheme;
    const names = ["Principale", "Accento 1", "Accento 2", "Accento 3", "Accento 4", "Accento 5"];
    const ins = s.c.map(c => el("input", { type: "color", value: c }));
    const name = el("input", { type: "text", class: "field", value: "Personalizzata" });
    const ok = await modal("Crea nuova combinazione colori", el("div", { class: "pb-dlg" }, row("Nome", name), ...ins.map((x, k) => row(names[k], x))), [{ label: "Annulla", value: false }, { label: "Salva", value: true, primary: true }]);
    if (ok) E.setScheme({ name: name.value || "Personalizzata", c: ins.map(x => x.value) });
    after();
  }
  async function fontSchemeDlg() {
    const mk = v => el("select", { class: "field" }, ...FONTS.map(f => el("option", { value: f, selected: f === v }, f)));
    const t = mk(doc().fonts.t), b = mk(doc().fonts.b);
    const ok = await modal("Crea nuova combinazione caratteri", el("div", { class: "pb-dlg" }, row("Carattere titoli", t), row("Carattere corpo", b)), [{ label: "Annulla", value: false }, { label: "Salva", value: true, primary: true }]);
    if (ok) E.setFonts({ name: "Personalizzata", t: t.value, b: b.value });
    after();
  }
  async function boxMarginsDlg(o) {
    if (!o) return;
    const p = o.pad || [4, 4, 4, 4];
    const f = p.map(v => inText(cm(v)));
    const ok = await modal("Margini della casella di testo", el("div", { class: "pb-dlg" }, row("Sinistro (cm)", f[0]), row("Superiore (cm)", f[1]), row("Destro (cm)", f[2]), row("Inferiore (cm)", f[3])), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) { o.pad = f.map(x => fromCm(x.value)); E.commit("Margini casella"); }
    after();
  }
  async function columnsDlg(o) {
    if (!o) return;
    const n = inText(o.cols || 1), g = inText(cm(o.gap ?? 12));
    const ok = await modal("Colonne", el("div", { class: "pb-dlg" }, row("Numero di colonne", n), row("Spaziatura (cm)", g)), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) { o.cols = clamp(parseInt(n.value) || 1, 1, 12); o.gap = fromCm(g.value); E.commit("Colonne"); }
    after();
  }
  async function renameMasterDlg() {
    const m = doc().masters.find(x => x.id === E.masterId());
    if (!m) return;
    const v = await askText("Rinomina pagina master", "Descrizione", m.name);
    if (v) { m.name = v; E.commit("Rinomina pagina master"); E.renderThumbs(); }
    after();
  }
  async function recipientsDlg() {
    const M = doc().merge;
    if (!M) return;
    const tbl = el("table", { class: "pb-rtable" });
    tbl.append(el("tr", {}, el("th", {}, "✓"), ...M.fields.map(f => el("th", {}, f))));
    M.rows.forEach(r => {
      const c = el("input", { type: "checkbox", checked: !r._x });
      c.addEventListener("change", () => { r._x = !c.checked || undefined; });
      tbl.append(el("tr", {}, el("td", {}, c), ...M.fields.map(f => el("td", {}, String(r[f] ?? "")))));
    });
    await modal(`Destinatari (${M.source || ""})`, el("div", { class: "pb-rwrap" }, tbl), [{ label: "OK", value: true, primary: true }]);
    E.commit("Modifica destinatari");
    after();
  }
  async function wordCountDlg() {
    const D = doc();
    const cnt = t => ({ w: (t.match(/[\p{L}\p{N}]+/gu) || []).length, c: t.replace(/\s/g, "").length, cs: t.length, p: t.split("\n").filter(x => x.trim()).length });
    const ed = edit();
    const story = ed ? cnt(storyText(D.stories[ed.story])) : null;
    const used = new Set();
    for (const o of allItems(D)) { if (o.story) used.add(o.story); if (o.cells) for (const r of o.cells) for (const c of r) used.add(c.story); }
    const all = cnt([...used].map(id => (D.stories[id] ? storyText(D.stories[id]) : "")).join("\n"));
    const t = el("table", { class: "pb-rtable" }, el("tr", {}, el("th", {}, ""), story ? el("th", {}, "Storia corrente") : null, el("th", {}, "Pubblicazione")),
      ...[["Parole", "w"], ["Caratteri (spazi esclusi)", "c"], ["Caratteri (spazi inclusi)", "cs"], ["Paragrafi", "p"]].map(([l, k]) => el("tr", {}, el("td", {}, l), story ? el("td", {}, String(story[k])) : null, el("td", {}, String(all[k])))),
      el("tr", {}, el("td", {}, "Pagine"), story ? el("td", {}, "") : null, el("td", {}, String(D.pages.length))));
    await modal("Conteggio parole", t);
    after();
  }
  async function mergeToPdf() {
    const M = doc().merge;
    if (!M) return;
    const path = await (await import("./core.js")).pickSavePath(baseName(ctx.tab.name).replace(/\.[^.]+$/, "") + " - unione.pdf", "");
    if (!path) return after();
    try {
      toast("Creazione del PDF unito...", false, 60000);
      await exportMergedPdf(E, path, M.rows.filter(r => !r._x));
      toast("PDF creato: " + baseName(path));
    } catch (e) { console.error(e); toast("Unione non riuscita: " + e.message, true, 8000); }
    after();
  }

  // --------------------------------------------- menu contestuale (tasto destro) e menu delle pagine
  E.contextMenu = (x, y, hit) => {
    const items = hit ? [
      { label: "Taglia", icon: "cut", keys: "Ctrl+X", run: () => E.cutSel() }, { label: "Copia", icon: "copy", keys: "Ctrl+C", run: () => E.copySel() }, { label: "Incolla", icon: "paste", keys: "Ctrl+V", run: () => E.pasteFromSystem() },
      { label: "Elimina oggetto", keys: "Canc", run: () => E.deleteSel() }, { label: "Duplica", keys: "Ctrl+D", run: () => E.dup() }, "-",
      sel().length > 1 ? { label: "Raggruppa", icon: "group", keys: "Ctrl+G", run: () => E.group() } : null,
      sel().some(o => o.type === "group") ? { label: "Separa", icon: "ungroup", keys: "Ctrl+Maiusc+G", run: () => E.ungroup() } : null,
      { label: "Disponi", sub: () => [{ label: "Porta in primo piano", icon: "bringFront", run: () => E.order("front") }, { label: "Porta avanti", icon: "bringFwd", run: () => E.order("fwd") }, { label: "Porta indietro", icon: "sendBack", run: () => E.order("back") }, { label: "Porta in secondo piano", icon: "sendBackmost", run: () => E.order("backmost") }] },
      { label: "Disponi testo", sub: wrapMenu }, { label: "Allinea", sub: alignMenu }, { label: "Ruota o capovolgi", sub: rotateMenu }, "-",
      hit.type === "image" ? { label: hit.img ? "Cambia immagine..." : "Inserisci immagine...", icon: "changePic", run: () => E.changePicture() } : null,
      hit.type === "image" && hit.img ? { label: "Ritaglia", icon: "crop", run: () => E.cropToggle() } : null,
      hit.type === "text" ? { label: "Crea collegamento (testo che continua)", icon: "link", run: () => E.linkStart() } : null,
      hit.type === "wordart" ? { label: "Modifica testo WordArt...", icon: "editText", run: () => E.editWordArt() } : null,
      hit.type === "text" ? { label: "Paragrafo...", run: paraDlg } : null,
      { label: "Salva come immagine (PNG)...", run: () => E.saveSelectionImage() },
    ] : [
      { label: "Incolla", icon: "paste", keys: "Ctrl+V", run: () => E.pasteFromSystem() }, "-",
      { label: "Inserisci pagina", icon: "page", run: () => E.addPage(false) }, { label: "Inserisci pagina duplicata", icon: "pageDup", run: () => E.addPage(true) },
      { label: "Guide", sub: guidesMenu }, { label: "Sfondo pagina", sub: bgMenu },
      { label: "Zoom", sub: () => [{ label: "Pagina intera", run: () => E.fitPage() }, { label: "Larghezza pagina", run: () => E.fitWidth() }, { label: "100%", run: () => E.zoom100() }] },
    ];
    popup({ x, y }, menuEl(items, after));
  };
  E.pageMenu = (x, y, pi) => {
    popup({ x, y }, menuEl([
      { label: "Inserisci pagina", icon: "page", run: () => E.addPage(false) }, { label: "Inserisci pagina duplicata", icon: "pageDup", run: () => E.addPage(true) }, { label: "Inserisci pagine...", run: insertPagesDlg },
      { label: "Elimina pagina", icon: "pageDel", run: () => E.deletePage(pi), dis: () => doc().pages.length < 2 }, { label: "Sposta pagina...", icon: "pageMove", run: movePageDlg }, "-",
      { label: "Pagine master", sub: masterMenu },
    ], after));
  };

  render();
  return { refresh, render, menuEl, colorMenu };
}
