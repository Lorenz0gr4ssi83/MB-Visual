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
import { t as tr, LOCALE, has as trHas } from "./i18n.js";

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const cm = v => +(v / CM).toFixed(2);
const fromCm = v => (parseFloat(String(v).replace(",", ".")) || 0) * CM;
const STD_COLORS = ["#c00000", "#ff0000", "#ffc000", "#ffff00", "#92d050", "#00b050", "#00b0f0", "#0070c0", "#002060", "#7030a0", "#ffffff", "#000000"];
const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72, 96, 120, 144];
const WEIGHTS = [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6];
const DASH_NAMES = [["solid", tr("pubribbon.continua")], ["dash", tr("pubribbon.tratteggiata")], ["dot", tr("pubribbon.punteggiata")], ["dashdot", tr("pubribbon.tratto_punto")], ["long", tr("pubribbon.tratto_lungo")]];

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
      const dd = el("button", { type: "button", class: "pb-splitdd", title: label + tr("pubribbon.altre_opzioni") });
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
    const dd = el("button", { type: "button", class: "pb-splitdd sm", title: title + tr("pubribbon.colori") });
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
    box.append(el("div", { class: "pb-mtitle" }, tr("pubribbon.colori_combinazione")));
    const grid = el("div", { class: "pb-cgrid" });
    const levels = [null, 80, 60, 40, 20, -25, -50];
    for (const lv of levels) for (let k = 0; k < 6; k++) {
      const v = lv === null ? "s" + k : `s${k}:${lv}`;
      const c = color(D, v);
      const b = el("button", { type: "button", class: "pb-cell" + (current === v ? " on" : ""), title: tr("pubribbon.colore_0_1", k === 0 ? "principale" : "accento " + k, lv === null ? "" : lv > 0 ? `, tinta ${lv}%` : tr("pubribbon.piu_scuro_0", -lv)), style: { background: c } });
      b.addEventListener("click", () => { closePop(); set(v); });
      grid.append(b);
    }
    box.append(grid, el("div", { class: "pb-mtitle" }, tr("pubribbon.colori_standard")));
    const std = el("div", { class: "pb-cgrid std" });
    for (const c of STD_COLORS) { const b = el("button", { type: "button", class: "pb-cell" + (current === c ? " on" : ""), title: c, style: { background: c } }); b.addEventListener("click", () => { closePop(); set(c); }); std.append(b); }
    box.append(std);
    if (o.none !== false) box.append(el("button", { type: "button", class: "pb-mit", onclick: () => { closePop(); set("none"); } }, el("span", { class: "pb-mico" }, current === "none" ? "✓" : ""), el("span", {}, o.noneLabel || tr("pubribbon.nessun_colore")), el("span")));
    const inp = el("input", { type: "color", value: /^#/.test(current || "") ? current : color(D, current || "s1") || "#000000" });
    inp.addEventListener("change", () => { closePop(); set(inp.value); });
    box.append(el("label", { class: "pb-mit more" }, el("span", { class: "pb-mico" }), el("span", {}, tr("pubribbon.altri_colori")), inp));
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
  const arrangeGroup = () => groupEl(tr("pubribbon.disponi"),
    big("wrap", tr("pubribbon.disponi_testo"), null, { menu: wrapMenu, dis: disNoSel }),
    big("bringFwd", tr("pubribbon.porta_avanti"), () => E.order("fwd"), { menu: () => [{ label: tr("pubribbon.porta_avanti"), icon: "bringFwd", run: () => E.order("fwd") }, { label: tr("pubribbon.porta_primo_piano"), icon: "bringFront", run: () => E.order("front") }], dis: disNoSel }),
    big("sendBack", tr("pubribbon.porta_indietro"), () => E.order("back"), { menu: () => [{ label: tr("pubribbon.porta_indietro"), icon: "sendBack", run: () => E.order("back") }, { label: tr("pubribbon.porta_secondo_piano"), icon: "sendBackmost", run: () => E.order("backmost") }], dis: disNoSel }),
    col(sm("align", tr("pubribbon.allinea"), null, { menu: alignMenu, dis: disNoSel }), sm("group", tr("pubribbon.raggruppa"), () => E.group(), { keys: "Ctrl+G", dis: () => sel().length < 2 }), sm("ungroup", tr("pubribbon.separa"), () => E.ungroup(), { keys: "Ctrl+Maiusc+G", dis: () => !sel().some(o => o.type === "group") })),
    col(sm("rotate", tr("pubribbon.ruota"), null, { menu: rotateMenu, dis: disNoSel })));
  const wrapMenu = () => {
    const cur = one()?.wrap;
    return [
      { label: tr("pubribbon.nessuno_davanti_testo"), checked: cur === "none", run: () => propSet({ wrap: "none" }, tr("pubribbon.disponi_testo")) },
      { label: tr("pubribbon.quadrato"), checked: cur === "square", run: () => propSet({ wrap: "square" }, tr("pubribbon.disponi_testo")) },
      { label: tr("pubribbon.ravvicinato"), checked: cur === "tight", run: () => propSet({ wrap: "square", wrapDist: 2 }, tr("pubribbon.disponi_testo")) },
      { label: tr("pubribbon.sopra_sotto"), checked: cur === "topbottom", run: () => propSet({ wrap: "topbottom" }, tr("pubribbon.disponi_testo")) },
      { label: tr("pubribbon.dietro_testo"), run: () => { propSet({ wrap: "none" }, tr("pubribbon.disponi_testo")); E.order("backmost"); } },
      "-", { label: tr("pubribbon.altre_opzioni_disposizione"), run: wrapDlg },
    ];
  };
  async function wrapDlg() {
    const o = one();
    if (!o) return;
    const d = el("input", { type: "text", class: "field", value: String(cm(o.wrapDist ?? 6)).replace(".", ",") });
    const ok = await modal(tr("pubribbon.disposizione_testo"), el("label", { class: "pb-dlgrow" }, tr("pubribbon.distanza_testo_cm"), d), [{ label: tr("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) propSet({ wrapDist: fromCm(d.value) }, tr("pubribbon.disposizione_testo"));
    after();
  }
  let relMargins = false;
  const alignMenu = () => [
    { label: tr("pubribbon.allinea_sinistra"), icon: "alignObjL", run: () => E.align("l", relMargins) }, { label: tr("pubribbon.allinea_centro"), icon: "alignObjC", run: () => E.align("c", relMargins) },
    { label: tr("pubribbon.allinea_destra"), icon: "alignObjR", run: () => E.align("r", relMargins) }, "-",
    { label: tr("pubribbon.allinea_alto"), icon: "alignObjT", run: () => E.align("t", relMargins) }, { label: tr("pubribbon.allinea_centro_verticale"), icon: "alignObjM", run: () => E.align("m", relMargins) },
    { label: tr("pubribbon.allinea_basso"), icon: "alignObjB", run: () => E.align("b", relMargins) }, "-",
    { label: tr("pubribbon.distribuisci_orizzontalmente"), icon: "distH", run: () => E.distribute("h") }, { label: tr("pubribbon.distribuisci_verticalmente"), icon: "distV", run: () => E.distribute("v") }, "-",
    { label: tr("pubribbon.rispetto_alle_guide_margini"), checked: relMargins, run: () => { relMargins = !relMargins; } },
  ];
  const rotateMenu = () => [
    { label: tr("pubribbon.ruota_destra_90"), icon: "rotateR", run: () => E.rotate(90) }, { label: tr("pubribbon.ruota_sinistra_90"), icon: "rotateL", run: () => E.rotate(-90) },
    { label: tr("pubribbon.capovolgi_verticalmente"), icon: "flipV", run: () => E.rotate("flipV") }, { label: tr("pubribbon.capovolgi_orizzontalmente"), icon: "flipH", run: () => E.rotate("flipH") }, "-",
    { label: tr("pubribbon.altre_opzioni_rotazione"), run: rotateDlg },
  ];
  async function rotateDlg() {
    const o = one();
    const v = await askText(tr("pubribbon.rotazione"), tr("pubribbon.angolo_gradi_senso_orario"), String(Math.round(o?.rot || 0)));
    if (v === null) return;
    const a = parseFloat(v.replace(",", "."));
    if (!isFinite(a)) return;
    for (const x of sel()) if (x.type !== "group") x.rot = ((a % 360) + 360) % 360;
    E.commit(tr("pubribbon.ruota"));
  }
  const sizeGroup = () => groupEl(tr("pubribbon.dimensioni"),
    col(numField(tr("pubribbon.alt"), () => (one() ? cm(one().h) : ""), v => setGeom({ h: fromCm(v) }), { unit: "cm", dis: () => !one() }),
      numField(tr("pubribbon.larg"), () => (one() ? cm(one().w) : ""), v => setGeom({ w: fromCm(v) }), { unit: "cm", dis: () => !one() })),
    col(numField("X", () => (one() ? cm(one().x) : ""), v => setGeom({ x: fromCm(v) }), { unit: "cm", dis: () => !one() }),
      numField("Y", () => (one() ? cm(one().y) : ""), v => setGeom({ y: fromCm(v) }), { unit: "cm", dis: () => !one() })),
    col(numField(tr("pubribbon.rot"), () => (one() ? Math.round(one().rot || 0) : ""), v => setGeom({ rot: ((parseFloat(String(v).replace(",", ".")) || 0) % 360 + 360) % 360 }), { unit: "°", dis: () => !one() || one().type === "group" })));
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
    E.commit(tr("pubribbon.dimensioni"));
  }
  const lineGet = () => firstLine()?.line?.c || "none";
  const fillGroup = (lineOnly = false) => groupEl(tr("pubribbon.stili_forma"),
    col(lineOnly ? null : colorBtn("fill", tr("pubribbon.riempimento_forma"), () => one()?.fill, v => propSet({ fill: v }, tr("pubribbon.riempimento")), { dis: disNoSel, noneLabel: tr("pubribbon.nessun_riempimento") }),
      colorBtn("outline", tr("pubribbon.contorno_forma"), lineGet, v => propSet(o => ({ line: { w: 0.75, dash: "solid", ...(o.line || {}), c: v } }), tr("pubribbon.contorno")), { dis: disNoSel, noneLabel: tr("pubribbon.nessun_contorno"), def: "s0" }),
      sm("outline", tr("pubribbon.spessore"), null, { menu: weightMenu, dis: disNoSel })),
    col(sm(null, tr("pubribbon.tratteggio"), null, { menu: dashMenu, dis: disNoSel }), lineOnly ? sm(null, tr("pubribbon.frecce"), null, { menu: arrowMenu, dis: () => !sel().some(isLine) }) : null,
      sm("shadow", tr("pubribbon.ombra"), () => propSet(o => ({ shadow: !o.shadow }), tr("pubribbon.ombra")), { on: () => !!one()?.shadow, dis: disNoSel })),
    col(sm(null, tr("pubribbon.trasparenza"), null, { menu: () => [0, 25, 50, 75].map(t => ({ label: t + "%", checked: Math.round((1 - (one()?.opacity ?? 1)) * 100) === t, run: () => propSet({ opacity: 1 - t / 100 }, tr("pubribbon.trasparenza")) })), dis: disNoSel })));
  const weightMenu = () => [...WEIGHTS.map(w => ({ label: String(w).replace(".", ",") + " pt", checked: firstLine()?.line?.w === w, run: () => propSet(o => ({ line: { c: o.line?.c && o.line.c !== "none" ? o.line.c : "s0", dash: o.line?.dash || "solid", w } }), tr("pubribbon.spessore_contorno")) })),
    "-", { label: tr("pubribbon.nessun_contorno"), run: () => propSet({ line: null }, tr("pubribbon.contorno")) }];
  const dashMenu = () => DASH_NAMES.map(([d, n]) => ({ label: n, checked: (firstLine()?.line?.dash || "solid") === d, run: () => propSet(o => ({ line: { c: o.line?.c && o.line.c !== "none" ? o.line.c : "s0", w: o.line?.w || 1, dash: d } }), tr("pubribbon.tratteggio")) }));
  const arrowMenu = () => [["line", tr("pubribbon.nessuna_freccia")], ["arrow", tr("pubribbon.freccia_fine")], ["darrow", tr("pubribbon.frecce_alle_due_estremita")]].map(([s, n]) => ({ label: n, checked: one()?.shape === s, run: () => { for (const o of sel()) if (isLine(o)) o.shape = s; E.commit(tr("pubribbon.frecce")); } }));

  // --------------------------------------------- schede
  const TABS = [
    { id: "home", label: tr("pubribbon.home"), build: tabHome },
    { id: "insert", label: tr("pubribbon.inserisci"), build: tabInsert },
    { id: "design", label: tr("pubribbon.progettazione_pagina"), build: tabDesign },
    { id: "mail", label: tr("pubribbon.mailing"), build: tabMail },
    { id: "review", label: tr("pubribbon.revisione"), build: tabReview },
    { id: "view", label: tr("pubribbon.visualizza"), build: tabView },
    { id: "master", label: tr("pubribbon.pagina_master"), ctx: tr("pubribbon.pagine_master"), color: "#b0612a", when: () => !!E.masterId(), build: tabMaster },
    { id: "fmtText", label: tr("pubribbon.formato"), ctx: tr("pubribbon.strumenti_casella_testo"), color: "#7b4fb0", when: () => kind() === "text", build: tabFmtText },
    { id: "fmtPic", label: tr("pubribbon.formato"), ctx: tr("pubribbon.strumenti_immagine"), color: "#1f8a5c", when: () => kind() === "image", build: tabFmtPic },
    { id: "fmtDraw", label: tr("pubribbon.formato"), ctx: tr("pubribbon.strumenti_disegno"), color: "#c0702a", when: () => kind() === "shape" || kind() === "mixed" || kind() === "group", build: tabFmtDraw },
    { id: "fmtWa", label: tr("pubribbon.formato"), ctx: tr("pubribbon.strumenti_wordart"), color: "#2f75c8", when: () => kind() === "wordart", build: tabFmtWordArt },
    { id: "tblDesign", label: tr("pubribbon.progettazione"), ctx: tr("pubribbon.strumenti_tabella"), color: "#a33b6b", when: () => kind() === "table", build: tabTableDesign },
    { id: "tblLayout", label: tr("pubribbon.layout"), ctx: tr("pubribbon.strumenti_tabella"), color: "#a33b6b", when: () => kind() === "table", build: tabTableLayout },
  ];
  const strip = el("div", { class: "pb-tabs" });
  const panel = el("div", { class: "pb-panel" });
  host.append(panel);
  // barra di accesso rapido e schede nella barra del visualizzatore (come la barra del titolo di Office)
  const qUndo = el("button", { type: "button", class: "pb-q", title: tr("pubribbon.annulla_ctrl_z"), onclick: () => { E.undo(); after(); } });
  qUndo.innerHTML = pubIcon("undo");
  const qRedo = el("button", { type: "button", class: "pb-q", title: tr("pubribbon.ripeti_ctrl_y"), onclick: () => { E.redo(); after(); } });
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
    qUndo.title = tr("pubribbon.annulla") + E.undoLabel() + " (Ctrl+Z)";
    for (const u of updaters) { try { u(); } catch (e) { console.warn(e); } }
  }

  // --------------------------------------------- Home
  function fontGroup() {
    const cs = () => E.charStyle();
    const fontOpts = () => [["+t", `${doc().fonts.t} (Titoli)`, doc().fonts.t], ["+b", `${doc().fonts.b} (Corpo)`, doc().fonts.b], ...FONTS.map(f => [f, f, f])];
    return groupEl(tr("pubribbon.carattere"),
      col([selectCtl(fontOpts, () => cs()?.f || (one()?.type === "wordart" ? one().font : null), v => E.applyChar({ f: v }, tr("pubribbon.carattere")), { width: 150, title: tr("pubribbon.tipo_carattere"), dis: () => !hasText() }),
        comboNum(SIZES, () => cs()?.z, v => E.applyChar({ z: v }, tr("pubribbon.dimensione_carattere")), { title: tr("pubribbon.dimensione_carattere"), dis: () => !hasText() }),
        sm("grow", null, () => E.growFont(1), { title: tr("pubribbon.aumenta_dimensione_carattere"), keys: "Ctrl+Maiusc+>", dis: () => !hasText() }),
        sm("shrink", null, () => E.growFont(-1), { title: tr("pubribbon.riduci_dimensione_carattere"), keys: "Ctrl+<", dis: () => !hasText() }),
        sm("clearFmt", null, () => E.clearFormat(), { title: tr("pubribbon.cancella_formattazione"), keys: "Ctrl+Spazio", dis: () => !hasText() })],
      [sm("bold", null, () => E.toggleChar("b", tr("pubribbon.grassetto")), { title: tr("pubribbon.grassetto"), keys: "Ctrl+B", on: () => !!cs()?.b, dis: () => !hasText() }),
        sm("italic", null, () => E.toggleChar("i", tr("pubribbon.corsivo")), { title: tr("pubribbon.corsivo"), keys: "Ctrl+I", on: () => !!cs()?.i, dis: () => !hasText() }),
        sm("underline", null, () => E.toggleChar("u", tr("pubribbon.sottolineato")), { title: tr("pubribbon.sottolineato"), keys: "Ctrl+U", on: () => !!cs()?.u, dis: () => !hasText() }),
        sm(null, tr("pubribbon.aa"), null, { title: tr("pubribbon.maiuscole_minuscole_maiusc_f3"), menu: () => [[tr("pubribbon.tutto_maiuscolo"), "up"], [tr("pubribbon.tutto_minuscolo"), "low"], [tr("pubribbon.iniziali_maiuscole"), "cap"], [tr("pubribbon.tipo_frase"), "sent"]].map(([l, m]) => ({ label: l, run: () => E.changeCase(m) })), dis: () => !hasText() }),
        sm(null, tr("pubribbon.spaziatura"), null, { title: tr("pubribbon.spaziatura_caratteri"), menu: () => [[-1, tr("pubribbon.molto_stretta")], [-0.5, tr("pubribbon.stretta")], [0, tr("pubribbon.normale")], [1, tr("pubribbon.ampia")], [2, tr("pubribbon.molto_ampia")]].map(([k, l]) => ({ label: l, checked: (cs()?.k || 0) === k, run: () => E.applyChar({ k: k || undefined }, tr("pubribbon.spaziatura_caratteri")) })), dis: () => !hasText() }),
        colorBtn("fontColor", tr("pubribbon.colore_carattere"), () => cs()?.c, v => E.applyChar({ c: v === "none" ? "s0" : v }, tr("pubribbon.colore_carattere")), { dis: () => !hasText(), none: false, def: "s1" })]),
    );
  }
  function paraGroup() {
    const ps = () => E.paraStyle();
    const al = a => () => ps()?.a === a || (!ps()?.a && a === "l");
    return groupEl(tr("pubribbon.paragrafo"),
      col([sm("bullets", null, () => E.applyPara(p => ({ bu: p.bu && !/\d/.test(p.bu) ? undefined : "•" }), tr("pubribbon.elenco_puntato")), { title: tr("pubribbon.elenco_puntato"), on: () => !!ps()?.bu && !/\d/.test(ps().bu), dis: () => !hasText() }),
        sm(null, null, null, { title: tr("pubribbon.simbolo_dell_elenco"), menu: () => ["•", "◦", "▪", "–", "✓", "➢", "★"].map(b => ({ label: b + "  elenco", run: () => E.applyPara({ bu: b }, tr("pubribbon.elenco_puntato")) })), dis: () => !hasText() }),
        sm("numbering", null, () => E.applyPara(p => ({ bu: p.bu && /\d/.test(p.bu) ? undefined : "1." }), tr("pubribbon.elenco_numerato")), { title: tr("pubribbon.numerazione"), on: () => /\d/.test(ps()?.bu || ""), dis: () => !hasText() }),
        sm("indentDec", null, () => E.applyPara(p => ({ li: Math.max(0, (p.li || 0) - 18) }), tr("pubribbon.riduci_rientro")), { title: tr("pubribbon.riduci_rientro"), dis: () => !hasText() }),
        sm("indentInc", null, () => E.applyPara(p => ({ li: (p.li || 0) + 18 }), tr("pubribbon.aumenta_rientro")), { title: tr("pubribbon.aumenta_rientro"), dis: () => !hasText() }),
        sm("paraMarks", null, () => E.toggleShow("marks"), { title: tr("pubribbon.mostra_caratteri_speciali_ctrl_maiusc"), on: () => E.show.marks })],
      [sm("alignL", null, () => E.applyPara({ a: "l" }, tr("pubribbon.allinea_sinistra")), { title: tr("pubribbon.allinea_testo_sinistra"), keys: "Ctrl+L", on: al("l"), dis: () => !hasText() }),
        sm("alignC", null, () => E.applyPara({ a: "c" }, tr("pubribbon.centra")), { title: tr("pubribbon.centra"), keys: "Ctrl+E", on: al("c"), dis: () => !hasText() }),
        sm("alignR", null, () => E.applyPara({ a: "r" }, tr("pubribbon.allinea_destra")), { title: tr("pubribbon.allinea_testo_destra"), keys: "Ctrl+R", on: al("r"), dis: () => !hasText() }),
        sm("alignJ", null, () => E.applyPara({ a: "j" }, tr("pubribbon.giustifica")), { title: tr("pubribbon.giustifica"), keys: "Ctrl+J", on: al("j"), dis: () => !hasText() }),
        sm("lineSpacing", null, null, { title: tr("pubribbon.interlinea"), menu: () => [...[1, 1.15, 1.5, 2, 2.5, 3].map(v => ({ label: String(v).replace(".", ","), checked: (ps()?.lh || 1) === v, run: () => E.applyPara({ lh: v }, tr("pubribbon.interlinea")) })), "-", { label: tr("pubribbon.opzioni_paragrafo"), run: paraDlg }], dis: () => !hasText() }),
        sm(null, "...", paraDlg, { title: tr("pubribbon.paragrafo_rientri_spaziatura"), dis: () => !hasText() })]));
  }
  function tabHome() {
    return [
      groupEl(tr("pubribbon.appunti"), big("paste", tr("common.incolla"), () => E.pasteFromSystem(), { menu: () => [{ label: tr("common.incolla"), icon: "paste", keys: "Ctrl+V", run: () => E.pasteFromSystem() }, { label: tr("pubribbon.incolla_formato"), keys: "Ctrl+Maiusc+V", run: () => E.pasteFormat() }] }),
        col(sm("cut", tr("common.taglia"), () => E.cutSel(), { keys: "Ctrl+X", dis: () => !sel().length && !(edit() && edit().caret !== edit().anchor) }), sm("copy", tr("common.copia"), () => E.copySel(), { keys: "Ctrl+C", dis: () => !sel().length && !(edit() && edit().caret !== edit().anchor) }),
          sm("painter", tr("pubribbon.copia_formato"), () => E.copyFormat(), { keys: "Ctrl+Maiusc+C", on: () => !!E.fmtClip, dis: () => !sel().length && !edit() }))),
      fontGroup(),
      paraGroup(),
      groupEl(tr("pubribbon.stili"), big("styles", tr("pubribbon.stili"), null, { menu: stylesMenu, dis: () => !hasText() })),
      groupEl(tr("pubribbon.oggetti"), big("textbox", tr("pubribbon.disegna_casella_testo"), () => E.setTool("text"), { on: () => E.tool() === "text" }),
        col(sm("table", tr("pubribbon.tabella"), null, { menu: tableMenu }), sm("picture", tr("pubribbon.immagini"), () => E.insertPicture()), sm("shapes", tr("pubribbon.forme"), null, { menu: shapesMenu }))),
      arrangeGroup(),
      groupEl(tr("pubribbon.modifica"), col(sm("find", tr("pubribbon.trova"), () => E.openFind(false), { keys: "Ctrl+F" }), sm("replace", tr("pubribbon.sostituisci"), () => E.openFind(true), { keys: "Ctrl+H" }),
        sm("select", tr("pubribbon.seleziona"), null, { menu: () => [{ label: tr("pubribbon.seleziona_tutto_testo_casella"), run: () => { const o = one(); if (o?.type === "text") { E.beginEdit(o, 0); const st = doc().stories[o.story]; E.edit().anchor = 0; E.edit().caret = st.chars.length - 1; E.refresh(); } }, dis: () => one()?.type !== "text" }, { label: tr("pubribbon.seleziona_tutti_oggetti"), keys: "Ctrl+A", run: () => E.setSel(E.items().slice()) }, { label: tr("pubribbon.seleziona_oggetti"), run: () => E.setTool(null) }] }))),
    ];
  }
  // nomi degli stili predefiniti (chiavi nel documento, in italiano) mostrati nella lingua scelta
  const styleLabel = n => { const k = "pubstyle." + n.toLowerCase().replace(/[^a-z0-9]+/g, "_"); return trHas(k) ? tr(k) : n; };
  const stylesMenu = () => {
    const ps = E.paraStyle();
    const D = doc();
    return [...Object.entries(D.styles).map(([n, s]) => ({ label: styleLabel(n), checked: ps?.st === n, font: fontName(D, s.f), style: { fontSize: clamp(s.z || 10, 10, 18) + "px", fontWeight: s.b ? "700" : "400", fontStyle: s.i ? "italic" : "normal", color: color(D, s.c || "s0") }, run: () => E.applyStyle(n) })),
      "-", { label: tr("pubribbon.nuovo_stile_selezione"), run: newStyleDlg }, { label: tr("pubribbon.modifica_stile"), run: () => editStyleDlg(ps?.st || "Normale") }];
  };
  const tableMenu = () => {
    const box = el("div", { class: "pb-tgrid" });
    const lab = el("div", { class: "pb-mtitle" }, tr("pubribbon.inserisci_tabella"));
    const grid = el("div", { class: "pb-tcells" });
    for (let r = 0; r < 8; r++) for (let c = 0; c < 10; c++) {
      const cell = el("button", { type: "button", class: "pb-tc" });
      cell.addEventListener("pointerenter", () => { grid.querySelectorAll(".pb-tc").forEach((x, k) => x.classList.toggle("on", Math.floor(k / 10) <= r && k % 10 <= c)); lab.textContent = tr("pubribbon.tabella_0_x_1", c + 1, r + 1); });
      cell.addEventListener("click", () => { closePop(); E.insertTable(r + 1, c + 1); });
      grid.append(cell);
    }
    box.append(lab, grid);
    return [{ el: box }, "-", { label: tr("pubribbon.inserisci_tabella_2"), icon: "table", run: tableDlg }];
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
      groupEl(tr("pubribbon.pagine"), big("page", tr("pubribbon.pagina"), () => E.addPage(false), { menu: () => [{ label: tr("pubribbon.inserisci_pagina_vuota"), icon: "page", keys: "Ctrl+Maiusc+N", run: () => E.addPage(false) }, { label: tr("pubribbon.inserisci_pagina_duplicata"), icon: "pageDup", keys: "Ctrl+Maiusc+U", run: () => E.addPage(true) }, { label: tr("pubribbon.inserisci_pagina"), run: insertPagesDlg }] })),
      groupEl(tr("pubribbon.tabelle"), big("table", tr("pubribbon.tabella"), null, { menu: tableMenu })),
      groupEl(tr("pubribbon.illustrazioni"), big("picture", tr("pubribbon.immagini"), () => E.insertPicture()), col(sm("placeholder", tr("pubribbon.segnaposto_immagine"), () => E.insertPlaceholder()), sm("shapes", tr("pubribbon.forme"), null, { menu: shapesMenu }))),
      groupEl(tr("pubribbon.blocchi_predefiniti"), col(sm("blocks", tr("pubribbon.parti_pagina"), null, { menu: () => blockMenu("parti") }), sm("calendar", tr("pubribbon.calendari"), null, { menu: () => blockMenu("calendari") })),
        col(sm("borderArt", tr("pubribbon.bordi_accenti"), null, { menu: () => blockMenu("bordi") }), sm("blocks", tr("pubribbon.pubblicita"), null, { menu: () => blockMenu("pubblicita") }))),
      groupEl(tr("pubribbon.testo"), big("textbox", tr("pubribbon.disegna_casella_testo"), () => E.setTool("text"), { on: () => E.tool() === "text" }),
        big("wordart", "WordArt", null, { menu: wordArtMenu }),
        col(sm("insertFile", tr("pubribbon.inserisci_file"), () => E.insertTextFile()), sm("symbol", tr("pubribbon.simbolo"), null, { menu: symbolMenu }), sm("dateTime", tr("pubribbon.data_ora"), null, { menu: dateMenu }))),
      groupEl(tr("pubribbon.collegamenti"), big("hyperlink", tr("pubribbon.collegamento"), () => E.hyperlink(), { keys: "Ctrl+K", dis: () => !edit() })),
      groupEl(tr("pubribbon.intestazione_pie_pagina"), col(sm("headerFooter", tr("pubribbon.intestazione"), () => E.headerFooter("h")), sm("headerFooter", tr("pubribbon.pie_pagina"), () => E.headerFooter("f")), sm("pageNumber", tr("pubribbon.numero_pagina"), null, { menu: pageNumMenu }))),
    ];
  }
  const wordArtMenu = () => {
    const styles = [
      { label: tr("pubribbon.tinta_unita"), form: "piatto", fill: "s1", outline: "s0", ow: 0, shadow: false },
      { label: tr("pubribbon.contorno_2"), form: "piatto", fill: "s5", outline: "s1", ow: 2, shadow: false },
      { label: tr("pubribbon.ombra_2"), form: "piatto", fill: "s1", outline: "s0", ow: 0, shadow: true },
      { label: tr("pubribbon.arco"), form: "arco", fill: "s1", outline: "s0", ow: 0, shadow: false },
      { label: tr("pubribbon.arco_giu"), form: "arcoGiu", fill: "s2", outline: "s0", ow: 0, shadow: false },
      { label: tr("pubribbon.onda"), form: "onda", fill: "s3", outline: "s0", ow: 0, shadow: true },
    ];
    return styles.map(st => ({ label: st.label, icon: "wordart", run: () => E.insertWordArt(st) }));
  };
  const symbolMenu = () => {
    const box = el("div", { class: "pb-symbols" });
    for (const ch of "©®™€£¥$§¶•…–—«»“”‘’°±×÷½¼¾²³µ→←↑↓↔✓✔✗★☆♥♦♣♠☎✉✈☀☂♪✿❖◆■□●○▲►◄▼αβγδΩπΣ∞≈≠≤≥√") {
      const b = el("button", { type: "button", class: "pb-sym" }, ch);
      b.addEventListener("click", () => { closePop(); if (!edit()) return toast(tr("pubribbon.fai_clic_testo_dove_inserire"), true); E.typeText(ch); after(); });
      box.append(b);
    }
    return [{ el: box }];
  };
  const dateMenu = () => {
    const d = new Date();
    const fm = [d.toLocaleDateString(LOCALE), d.toLocaleDateString(LOCALE, { day: "numeric", month: "long", year: "numeric" }), d.toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric" }), d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })];
    return [...fm.map(t => ({ label: t, run: () => (edit() ? E.typeText(t) : toast(tr("pubribbon.fai_clic_testo_dove_inserire_2"), true)) })), "-", { label: tr("pubribbon.campo_data_si_aggiorna_solo"), run: () => E.insertField("date") }];
  };
  const pageNumMenu = () => [
    { label: tr("pubribbon.inserisci_numero_pagina_testo"), keys: "Alt+Maiusc+P", run: () => E.insertField("page"), dis: () => !edit() },
    { label: tr("pubribbon.inserisci_numero_totale_pagine_testo"), run: () => E.insertField("pages"), dis: () => !edit() }, "-",
    ...[[tr("pubribbon.basso_destra"), "br"], [tr("pubribbon.basso_centro"), "bc"], [tr("pubribbon.basso_sinistra"), "bl"], [tr("pubribbon.alto_destra"), "tr"], [tr("pubribbon.alto_centro"), "tc"]].map(([l, pos]) => ({ label: l + tr("pubribbon.pagina_master_2"), run: () => E.pageNumberOnMaster(pos) })),
  ];

  // --------------------------------------------- Progettazione pagina
  function tabDesign() {
    const D = doc();
    const schemeGallery = el("div", { class: "pb-gallery" });
    const vis = COLOR_SCHEMES.slice(0, 6);
    const curName = D.scheme.name;
    for (const s of [vis.find(x => x.name === curName) ? null : D.scheme, ...vis].filter(Boolean)) schemeGallery.append(schemeChip(s));
    const more = el("button", { type: "button", class: "pb-galmore", title: tr("pubribbon.altre_combinazioni_colori") });
    more.innerHTML = pubIcon("caret");
    more.addEventListener("click", () => openMenu(more, [...COLOR_SCHEMES.map(s => ({ el: schemeRow(s) })), "-", { label: tr("pubribbon.crea_nuova_combinazione_colori"), run: schemeDlg }], after));
    return [
      groupEl(tr("pubribbon.modello"), big("template", tr("pubribbon.cambia_modello"), () => E.templatesDlg(true))),
      groupEl(tr("pubribbon.imposta_pagina"), col(sm("margins", tr("pubribbon.margini"), null, { menu: marginsMenu }), sm("orientation", tr("pubribbon.orientamento"), null, { menu: () => [{ label: tr("pubribbon.verticale"), checked: D.h >= D.w, run: () => E.setOrientation("v") }, { label: tr("pubribbon.orizzontale"), checked: D.w > D.h, run: () => E.setOrientation("o") }] }),
        sm("size", tr("pubribbon.dimensioni"), null, { menu: sizeMenu }))),
      groupEl(tr("pubribbon.layout"), col(sm("guides", tr("pubribbon.guide"), null, { menu: guidesMenu }), check(tr("pubribbon.allinea_alle_guide"), () => E.snapOpt.guides, v => { E.snapOpt.guides = v; }), check(tr("pubribbon.allinea_agli_oggetti"), () => E.snapOpt.objects, v => { E.snapOpt.objects = v; }))),
      groupEl(tr("pubribbon.pagine"), col(sm("pageDel", tr("common.elimina"), () => E.deletePage(E.cur()), { dis: () => doc().pages.length < 2 || !!E.masterId() }), sm("pageMove", tr("pubribbon.sposta"), () => movePageDlg(), { dis: () => doc().pages.length < 2 }), sm("master", tr("pubribbon.pagine_master"), null, { menu: masterMenu }))),
      groupEl(tr("pubribbon.combinazioni"), schemeGallery, more, col(sm("fontScheme", tr("pubribbon.caratteri"), null, { menu: fontsMenu }))),
      groupEl(tr("pubribbon.sfondo_pagina"), big("background", tr("pubribbon.sfondo"), null, { menu: bgMenu })),
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
  const marginsMenu = () => [[tr("pubribbon.sottili"), 1.27], [tr("pubribbon.moderati"), 1.9], [tr("pubribbon.normali"), 2.54], [tr("pubribbon.larghi"), 3.8], [tr("pubribbon.nessuno"), 0]].map(([l, v]) => ({ label: `${l} (${String(v).replace(".", ",")} cm)`, checked: Math.abs(doc().margins.l - v * CM) < 0.5, run: () => E.setMargins(v * CM) })).concat(["-", { label: tr("pubribbon.margini_personalizzati"), run: marginsDlg }]);
  const sizeMenu = () => [...PAGE_SIZES.map(([n, w, h]) => ({ label: `${n} (${String(w / 10).replace(".", ",")} x ${String(h / 10).replace(".", ",")} cm)`, checked: Math.abs(doc().w - w * MM) < 1 && Math.abs(doc().h - h * MM) < 1 || Math.abs(doc().w - h * MM) < 1 && Math.abs(doc().h - w * MM) < 1, run: () => E.setPageSize(w * MM, h * MM) })), "-", { label: tr("pubribbon.dimensioni_pagina_personalizzate"), run: pageSizeDlg }];
  const guidesMenu = () => [
    { title: tr("pubribbon.guide_layout") },
    ...[[1, 1, tr("pubribbon.nessuna")], [2, 1, "2 colonne"], [3, 1, "3 colonne"], [4, 1, "4 colonne"], [2, 2, tr("pubribbon.griglia_2x2")], [3, 3, tr("pubribbon.griglia_3x3")], [1, 2, "2 righe"]].map(([c, r, l]) => ({ label: l, checked: (doc().grid.cols || 1) === c && (doc().grid.rows || 1) === r, run: () => E.setGrid(c, r) })),
    "-", { label: tr("pubribbon.aggiungi_guida_orizzontale"), run: () => E.addGuide("h") }, { label: tr("pubribbon.aggiungi_guida_verticale"), run: () => E.addGuide("v") },
    { label: tr("pubribbon.elimina_tutte_guide_righello"), run: () => E.clearGuides() }, "-", { label: tr("pubribbon.guide_griglia_linea_base"), run: guidesDlg },
  ];
  E.guidesDlg = guidesDlg;
  const masterMenu = () => [
    ...doc().masters.map(m => ({ label: tr("pubribbon.applica_0", m.name), checked: E.page()?.master === m.id, run: () => E.applyMaster(m.id) })),
    { label: tr("pubribbon.nessuna_pagina_master"), checked: !E.page()?.master, run: () => E.applyMaster(null) }, "-",
    { label: tr("pubribbon.modifica_pagine_master"), icon: "master", keys: "Ctrl+M", run: () => E.toggleMaster() },
  ];
  const fontsMenu = () => [...FONT_SCHEMES.map(f => ({ el: fontRow(f) })), "-", { label: tr("pubribbon.crea_nuova_combinazione_caratteri"), run: fontSchemeDlg }];
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
      const b = el("button", { type: "button", class: "pb-bgc", title: v ? tr("pubribbon.sfondo_tinta_unita") : tr("pubribbon.nessuno_sfondo"), style: { background: v ? color(D, v) : "#fff" } }, v ? "" : "∅");
      b.addEventListener("click", () => { closePop(); E.setBackground(v ? { c: v } : null); after(); });
      box.append(b);
    }
    return [{ title: tr("pubribbon.sfondo_tinta_unita") }, { el: box }, "-", { label: tr("pubribbon.altro_colore"), run: () => { const inp = el("input", { type: "color", value: "#ffffff" }); inp.addEventListener("change", () => E.setBackground({ c: inp.value })); inp.click(); } },
      { label: tr("pubribbon.immagine_sfondo"), icon: "picture", run: () => E.backgroundImage() }, { label: tr("pubribbon.applica_tutte_pagine"), run: () => E.backgroundAll() }, { label: tr("pubribbon.rimuovi_sfondo"), run: () => E.setBackground(null) }];
  };

  // --------------------------------------------- Mailing
  function tabMail() {
    const M = () => doc().merge;
    const st = () => E.mergeState();
    const recLabel = el("span", { class: "pb-rec" });
    reg(() => { recLabel.textContent = M()?.rows?.length ? `${st().idx + 1} di ${M().rows.length}` : "-"; });
    return [
      groupEl(tr("pubribbon.avvia"), big("recipients", tr("pubribbon.seleziona_destinatari"), null, { menu: () => [{ label: tr("pubribbon.usa_elenco_esistente_csv_excel"), run: () => E.loadRecipients() }, { label: tr("pubribbon.modifica_elenco_destinatari"), run: recipientsDlg, dis: () => !M() }, { label: tr("pubribbon.rimuovi_elenco"), run: () => { doc().merge = null; E.setMerge(0, false); E.commit(tr("pubribbon.rimuovi_elenco")); }, dis: () => !M() }] })),
      groupEl(tr("pubribbon.scrivi_inserisci_campi"), big("mergeField", tr("pubribbon.inserisci_campo_unione"), null, { menu: () => (M()?.fields || []).map(f => ({ label: f, run: () => E.insertField("merge:" + f) })).concat(M() ? [] : [{ label: tr("pubribbon.seleziona_prima_i_destinatari"), dis: true }]), dis: () => !M() })),
      groupEl(tr("pubribbon.anteprima_risultati"), big("preview", tr("pubribbon.anteprima_risultati"), () => E.setMerge(st().idx, !st().preview), { on: () => st().preview, dis: () => !M() }),
        col([sm("first", null, () => E.setMerge(0, true), { title: tr("pubribbon.primo_record"), dis: () => !M() }), sm("prev", null, () => E.setMerge(Math.max(0, st().idx - 1), true), { title: tr("pubribbon.record_precedente"), dis: () => !M() }), recLabel,
          sm("next", null, () => E.setMerge(Math.min((M()?.rows.length || 1) - 1, st().idx + 1), true), { title: tr("pubribbon.record_successivo"), dis: () => !M() }), sm("last", null, () => E.setMerge((M()?.rows.length || 1) - 1, true), { title: tr("pubribbon.ultimo_record"), dis: () => !M() })])),
      groupEl(tr("pubribbon.fine"), big("finish", tr("pubribbon.completa_unisci"), null, { menu: () => [{ label: tr("pubribbon.unisci_pdf_copia_destinatario"), icon: "exportPdf", run: () => mergeToPdf() }], dis: () => !M() })),
    ];
  }

  // --------------------------------------------- Revisione
  function tabReview() {
    return [
      groupEl(tr("pubribbon.strumento_correzione"), big("spell", tr("pubribbon.controllo_ortografia"), () => E.spell(), { keys: "F7" }), col(sm("wordcount", tr("pubribbon.conteggio_parole"), () => wordCountDlg()), sm("thesaurus", tr("pubribbon.trova"), () => E.openFind(false)))),
      groupEl(tr("pubribbon.lingua"), big("language", tr("pubribbon.lingua"), () => toast(tr("pubribbon.controllo_ortografico_usa_lingua_italiana"), false, 5000))),
    ];
  }

  // --------------------------------------------- Visualizza
  function tabView() {
    return [
      groupEl(tr("pubribbon.visualizzazioni"), big("singlePage", tr("pubribbon.normale"), () => E.masterId() && E.toggleMaster(), { on: () => !E.masterId() }), big("master", tr("pubribbon.pagina_master"), () => E.toggleMaster(), { on: () => !!E.masterId(), keys: "Ctrl+M" })),
      groupEl(tr("pubribbon.layout"), col(sm("singlePage", tr("pubribbon.pagina_singola"), () => E.setSpread(false), { on: () => !E.spread() }), sm("twoPage", tr("pubribbon.pagine_affiancate"), () => E.setSpread(true), { on: () => E.spread() }))),
      groupEl(tr("pubribbon.mostra"), col(check(tr("pubribbon.limiti"), () => E.show.bounds, () => E.toggleShow("bounds")), check(tr("pubribbon.guide"), () => E.show.guides, () => E.toggleShow("guides")), check(tr("pubribbon.caratteri_speciali"), () => E.show.marks, () => E.toggleShow("marks"))),
        col(check(tr("pubribbon.righelli"), () => E.show.rulers, () => E.toggleShow("rulers")), check(tr("pubribbon.navigazione_pagine"), () => E.show.pages, () => E.toggleShow("pages")))),
      groupEl(tr("pubribbon.zoom"), col(comboNum([10, 25, 33, 50, 66, 75, 100, 150, 200, 400], () => E.zoomPct(), v => E.setZoomPct(v), { title: "Zoom (%)", width: 58 }), sm("zoom100", "100%", () => E.zoom100(), { keys: "F9" })),
        col(sm("zoomPage", tr("pubribbon.pagina_intera"), () => E.fitPage(), { keys: "Ctrl+Maiusc+L" }), sm("zoomWidth", tr("pubribbon.larghezza_pagina"), () => E.fitWidth()), sm("zoomSel", tr("pubribbon.oggetti_selezionati"), () => E.zoomSel(), { dis: disNoSel }))),
    ];
  }

  // --------------------------------------------- Pagina master
  function tabMaster() {
    return [
      groupEl(tr("pubribbon.pagina_master"), col(sm("page", tr("pubribbon.aggiungi_pagina_master"), () => E.addMaster()), sm("pageDup", tr("pubribbon.duplica"), () => E.addMaster(true)), sm(null, tr("common.rinomina"), () => renameMasterDlg())),
        col(sm("pageDel", tr("common.elimina"), () => E.deleteMaster(), { dis: () => doc().masters.length < 2 }), sm("headerFooter", tr("pubribbon.intestazione"), () => E.headerFooter("h")), sm("headerFooter", tr("pubribbon.pie_pagina"), () => E.headerFooter("f")))),
      groupEl(tr("common.chiudi"), big("master", tr("pubribbon.chiudi_pagina_master"), () => E.toggleMaster())),
    ];
  }

  // --------------------------------------------- Formato: casella di testo
  function tabFmtText() {
    const tb = () => (edit()?.kind === "frame" ? edit().o : one()?.type === "text" ? one() : null);
    const setF = (patch, label) => { const o = tb(); if (!o) return; Object.assign(o, patch); E.commit(label); };
    return [
      groupEl(tr("pubribbon.testo"), big("fitText", tr("pubribbon.adatta_testo"), null, { menu: () => [["best", tr("pubribbon.adattamento_ottimale")], ["shrink", tr("pubribbon.riduci_testo_eccesso")], ["grow", tr("pubribbon.aumenta_casella_adattarla_testo")], ["none", tr("pubribbon.non_adattare_testo")]].map(([v, l]) => ({ label: l, checked: (tb()?.fit || "none") === v, run: () => setF({ fit: v }, tr("pubribbon.adatta_testo")) })) }),
        col(sm(null, tr("pubribbon.interlinea"), null, { menu: () => [1, 1.15, 1.5, 2].map(v => ({ label: String(v).replace(".", ","), run: () => E.applyPara({ lh: v }, tr("pubribbon.interlinea")) })) }), sm(null, tr("pubribbon.capolettera"), () => E.dropCap(), { dis: () => !tb() }))),
      groupEl(tr("pubribbon.allineamento"), col([sm("valignT", null, () => setF({ valign: "t" }, tr("pubribbon.allinea_alto")), { title: tr("pubribbon.allinea_alto"), on: () => (tb()?.valign || "t") === "t" }), sm("valignM", null, () => setF({ valign: "m" }, tr("pubribbon.allinea_centro")), { title: tr("pubribbon.allinea_centro_verticalmente"), on: () => tb()?.valign === "m" }), sm("valignB", null, () => setF({ valign: "b" }, tr("pubribbon.allinea_basso")), { title: tr("pubribbon.allinea_basso"), on: () => tb()?.valign === "b" })],
        [sm("boxMargins", tr("pubribbon.margini"), null, { menu: () => [[tr("pubribbon.nessuno"), 0], [tr("pubribbon.stretti"), 4], [tr("pubribbon.moderati"), 7.2], [tr("pubribbon.larghi"), 14.4]].map(([l, v]) => ({ label: l, checked: (tb()?.pad?.[0] ?? 4) === v, run: () => setF({ pad: [v, v, v, v] }, tr("pubribbon.margini_casella")) })).concat(["-", { label: tr("pubribbon.margini_personalizzati"), run: () => boxMarginsDlg(tb()) }]) }),
          sm("columns", tr("pubribbon.colonne"), null, { menu: () => [1, 2, 3, 4].map(n => ({ label: n === 1 ? "1 colonna" : n + " colonne", checked: (tb()?.cols || 1) === n, run: () => setF({ cols: n }, tr("pubribbon.colonne")) })).concat(["-", { label: tr("pubribbon.altre_colonne"), run: () => columnsDlg(tb()) }]) })])),
      groupEl(tr("pubribbon.collegamento"), big("link", tr("pubribbon.crea_collegamento"), () => E.linkStart(), { dis: () => !tb() }), col(sm("unlink", tr("pubribbon.interrompi"), () => E.unlink(), { dis: () => !tb()?.next }), sm("nextBox", tr("common.avanti"), () => E.gotoLinked("next"), { dis: () => !tb()?.next }), sm("prevBox", tr("common.indietro"), () => E.gotoLinked("prev"), { dis: () => !tb() || !allItems(doc()).some(x => x.next === tb().id) }))),
      fillGroup(),
      arrangeGroup(),
      sizeGroup(),
    ];
  }
  // --------------------------------------------- Formato: immagine
  function tabFmtPic() {
    const im = () => (one()?.type === "image" ? one() : null);
    const fx = patch => { for (const o of sel()) if (o.type === "image") o.fx = { ...(o.fx || {}), ...patch }; E.commit(tr("pubribbon.regola_immagine")); };
    return [
      groupEl(tr("pubribbon.inserisci"), big("changePic", tr("pubribbon.cambia_immagine"), () => E.changePicture(), { dis: () => !im() })),
      groupEl(tr("pubribbon.regola"), col(sm("brightness", tr("pubribbon.correzioni"), null, { menu: () => [{ title: tr("pubribbon.luminosita") }, ...[-40, -20, 0, 20, 40].map(v => ({ label: (v > 0 ? "+" : "") + v + "%", checked: (im()?.fx?.bright || 0) === v, run: () => fx({ bright: v || undefined }) })), { title: tr("pubribbon.contrasto") }, ...[-40, -20, 0, 20, 40].map(v => ({ label: (v > 0 ? "+" : "") + v + "%", checked: (im()?.fx?.contrast || 0) === v, run: () => fx({ contrast: v || undefined }) }))], dis: () => !im() }),
        sm("recolor", tr("pubribbon.ricolora"), null, { menu: () => [{ label: tr("pubribbon.nessuna_ricolorazione"), run: () => fx({ gray: undefined, sepia: undefined, wash: undefined }) }, { label: tr("pubribbon.scala_grigi"), checked: !!im()?.fx?.gray, run: () => fx({ gray: true, sepia: undefined }) }, { label: tr("pubribbon.seppia"), checked: !!im()?.fx?.sepia, run: () => fx({ sepia: true, gray: undefined }) }, { label: tr("pubribbon.sbiadito_filigrana"), checked: !!im()?.fx?.wash, run: () => fx({ wash: !im()?.fx?.wash }) }], dis: () => !im() }),
        sm("resetPic", tr("pubribbon.reimposta_immagine"), () => E.resetPicture(), { dis: () => !im()?.img }))),
      groupEl(tr("pubribbon.stili_immagine"), col(colorBtn("outline", tr("pubribbon.bordo_immagine"), lineGet, v => propSet(o => ({ line: { w: o.line?.w || 1.5, dash: "solid", c: v } }), tr("pubribbon.bordo_immagine")), { dis: disNoSel, noneLabel: tr("pubribbon.nessun_bordo"), def: "s0" }),
        sm("outline", tr("pubribbon.spessore_bordo"), null, { menu: weightMenu, dis: disNoSel }), sm("shadow", tr("pubribbon.ombra"), () => propSet(o => ({ shadow: !o.shadow }), tr("pubribbon.ombra")), { on: () => !!one()?.shadow, dis: disNoSel }))),
      arrangeGroup(),
      groupEl(tr("pubribbon.ritaglia"), big("crop", tr("pubribbon.ritaglia"), () => E.cropToggle(), { on: () => !!E.crop(), dis: () => !im()?.img }), col(sm(null, tr("pubribbon.adatta"), () => E.fitPicture("fit"), { dis: () => !im()?.img, title: tr("pubribbon.l_immagine_intera_entra_cornice") }), sm(null, tr("pubribbon.riempi"), () => E.fitPicture("fill"), { dis: () => !im()?.img, title: tr("pubribbon.l_immagine_riempie_cornice_ritaglio") }), sm(null, tr("pubribbon.togli_ritaglio"), () => E.fitPicture("none"), { dis: () => !im()?.img }))),
      sizeGroup(),
    ];
  }
  // --------------------------------------------- Formato: disegno
  function tabFmtDraw() {
    return [
      groupEl(tr("pubribbon.inserisci_forme"), big("shapes", tr("pubribbon.forme"), null, { menu: shapesMenu }), big("textbox", tr("pubribbon.casella_testo"), () => E.setTool("text"))),
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
      groupEl(tr("pubribbon.testo"), big("editText", tr("pubribbon.modifica_testo"), () => E.editWordArt()), col(selectCtl(() => [["+t", `${doc().fonts.t} (Titoli)`, doc().fonts.t], ["+b", `${doc().fonts.b} (Corpo)`, doc().fonts.b], ...FONTS.map(f => [f, f, f])], () => wa()?.font, v => setW({ font: v }, tr("pubribbon.carattere_wordart")), { width: 140 }),
        [sm("bold", null, () => setW({ b: !wa()?.b }, tr("pubribbon.grassetto")), { on: () => !!wa()?.b, title: tr("pubribbon.grassetto") }), sm("italic", null, () => setW({ i: !wa()?.i }, tr("pubribbon.corsivo")), { on: () => !!wa()?.i, title: tr("pubribbon.corsivo") })])),
      groupEl(tr("pubribbon.stili_wordart"), col(colorBtn("fill", tr("pubribbon.riempimento"), () => wa()?.fill, v => setW({ fill: v }, tr("pubribbon.riempimento_wordart")), { none: false }), colorBtn("outline", tr("pubribbon.contorno"), () => wa()?.outline, v => setW({ outline: v, ow: wa()?.ow || 1.5 }, tr("pubribbon.contorno_wordart")), { none: false, def: "s0" }),
        sm("outline", tr("pubribbon.spessore_contorno"), null, { menu: () => [0, 0.75, 1.5, 2.25, 3, 4.5].map(w => ({ label: w ? String(w).replace(".", ",") + " pt" : tr("pubribbon.nessuno"), checked: (wa()?.ow || 0) === w, run: () => setW({ ow: w }, tr("pubribbon.contorno_wordart")) })) }))),
      groupEl(tr("pubribbon.effetti"), big("wordartForm", tr("pubribbon.forma"), null, { menu: () => [["piatto", tr("pubribbon.diritto")], ["arco", tr("pubribbon.arco")], ["arcoGiu", tr("pubribbon.arco_giu")], ["onda", tr("pubribbon.onda")]].map(([f, l]) => ({ label: l, checked: (wa()?.form || "piatto") === f, run: () => setW({ form: f }, tr("pubribbon.forma_wordart")) })) }),
        big("shadow", tr("pubribbon.ombra"), () => setW({ shadow: !wa()?.shadow }, tr("pubribbon.ombra")), { on: () => !!wa()?.shadow })),
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
      groupEl(tr("pubribbon.formati_tabella"), ...[[tr("pubribbon.griglia"), "grid"], [tr("pubribbon.intestazione"), "header"], [tr("pubribbon.righe_alterne"), "banded"], [tr("pubribbon.semplice"), "plain"]].map(([l, p]) => big("table", l, () => E.tableStyle(p)))),
      groupEl(tr("pubribbon.riempimento"), col(colorBtn("cellFill", tr("pubribbon.riempimento_cella"), () => cells()[0]?.fill, v => { for (const c of cells()) c.fill = v; E.commit(tr("pubribbon.riempimento_cella")); }, { noneLabel: tr("pubribbon.nessun_riempimento") }))),
      groupEl(tr("pubribbon.bordi"), col(colorBtn("borders", tr("pubribbon.colore_bordi"), () => tbl()?.border?.c, v => { tbl().border = { w: 0.75, ...(tbl().border || {}), c: v }; E.commit(tr("pubribbon.bordi")); }, { noneLabel: tr("pubribbon.nessun_bordo"), def: "s0" }),
        sm("outline", tr("pubribbon.spessore"), null, { menu: () => [0, 0.5, 0.75, 1, 1.5, 2.25, 3].map(w => ({ label: w ? String(w).replace(".", ",") + " pt" : tr("pubribbon.nessun_bordo"), run: () => { tbl().border = { c: tbl().border?.c || "s0", w }; E.commit(tr("pubribbon.bordi")); } })) }))),
      arrangeGroup(),
      sizeGroup(),
    ];
  }
  function tabTableLayout() {
    const ce = () => edit()?.kind === "cell";
    return [
      groupEl(tr("pubribbon.righe_colonne"), col(sm("rowAbove", tr("pubribbon.inserisci_sopra"), () => E.tableOp("rowAbove")), sm("rowBelow", tr("pubribbon.inserisci_sotto"), () => E.tableOp("rowBelow"))), col(sm("colLeft", tr("pubribbon.inserisci_sinistra"), () => E.tableOp("colLeft")), sm("colRight", tr("pubribbon.inserisci_destra"), () => E.tableOp("colRight"))),
        col(sm("delRow", tr("pubribbon.elimina_righe"), () => E.tableOp("delRow"), { dis: () => !ce() }), sm("delCol", tr("pubribbon.elimina_colonne"), () => E.tableOp("delCol"), { dis: () => !ce() }), sm("delTable", tr("pubribbon.elimina_tabella"), () => E.tableOp("delTable")))),
      groupEl(tr("pubribbon.dimensioni_cella"), col(numField(tr("common.larghezza"), () => (ce() ? cm(tbl().colW[edit().c]) : ""), v => E.tableOp("colW", fromCm(v)), { unit: "cm", dis: () => !ce() }), numField(tr("common.altezza"), () => (ce() ? cm(tbl().rowH[edit().r]) : ""), v => E.tableOp("rowH", fromCm(v)), { unit: "cm", dis: () => !ce() })),
        col(sm("distRows", tr("pubribbon.distribuisci_righe"), () => E.tableOp("distRows")), sm("distCols", tr("pubribbon.distribuisci_colonne"), () => E.tableOp("distCols")))),
      groupEl(tr("pubribbon.allineamento"), col([sm("valignT", null, () => E.tableOp("valign", "t"), { title: tr("pubribbon.allinea_alto") }), sm("valignM", null, () => E.tableOp("valign", "m"), { title: tr("pubribbon.allinea_centro") }), sm("valignB", null, () => E.tableOp("valign", "b"), { title: tr("pubribbon.allinea_basso") })],
        [sm("alignL", null, () => E.applyPara({ a: "l" }), { title: tr("pubribbon.sinistra") }), sm("alignC", null, () => E.applyPara({ a: "c" }), { title: tr("pubribbon.centro") }), sm("alignR", null, () => E.applyPara({ a: "r" }), { title: tr("pubribbon.destra") })])),
      sizeGroup(),
    ];
  }

  // --------------------------------------------- blocchi predefiniti
  function blockMenu(kind) {
    const D = doc();
    const B = {
      parti: [[tr("pubribbon.titolo_linea"), () => [textBox(D, 0, 0, 300, 40, [[tr("pubribbon.titolo_sezione"), "Titolo 1", { sb: 0 }]]), shapeBox(D, "rect", 0, 42, 300, 2.5, "s3", null, { wrap: "none" })]],
        [tr("pubribbon.barra_laterale"), () => [shapeBox(D, "rect", 0, 0, 150, 260, "s1:15", null, { wrap: "none" }), textBox(D, 8, 8, 134, 244, [[tr("pubribbon.evidenza"), "Titolo 2", { sb: 0 }], [tr("pubribbon.primo_punto"), "Elenco puntato"], [tr("pubribbon.secondo_punto"), "Elenco puntato"], [tr("pubribbon.terzo_punto"), "Elenco puntato"]])]],
        [tr("pubribbon.citazione"), () => [shapeBox(D, "round", 0, 0, 220, 110, "s1", null, { wrap: "none" }), textBox(D, 10, 10, 200, 90, [[tr("pubribbon.frase_che_merita_attenzione"), "Citazione", { c: "s5" }]], { valign: "m" })]],
        [tr("pubribbon.articolo_due_colonne"), () => [textBox(D, 0, 0, 360, 36, [[tr("pubribbon.titolo_dell_articolo"), tr("pubribbon.titolo_1"), { sb: 0 }]]), textBox(D, 0, 40, 360, 220, [[tr("pubribbon.scrivete_qui_testo_dell_articolo"), "Corpo del testo"], [tr("pubribbon.aggiungete_paragrafi_elenchi_immagini_testo"), "Corpo del testo"]], { cols: 2, gap: 12 })]],
        [tr("pubribbon.informazioni_contatto"), () => [textBox(D, 0, 0, 200, 80, [[tr("pubribbon.azienda_esempio_s_r_l"), "Indirizzo", { b: true }], [tr("pubribbon.via_esempio_1_00000_citta"), "Indirizzo"], ["Tel. +39 000 000 0000", "Indirizzo"], ["info@azienda.it · www.azienda.it", "Indirizzo"]])]]],
      calendari: [0, 1, 2].map(k => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + k); return [d.toLocaleDateString(LOCALE, { month: "long", year: "numeric" }), () => calendar(D, d)]; }),
      bordi: [[tr("pubribbon.barra_accento"), () => [shapeBox(D, "rect", 0, 0, 360, 8, "s1", null, { wrap: "none" })]],
        [tr("pubribbon.doppia_linea"), () => [shapeBox(D, "line", 0, 0, 360, 0, "none", { c: "s1", w: 2.25 }, { wrap: "none" }), shapeBox(D, "line", 0, 5, 360, 0, "none", { c: "s1", w: 0.75 }, { wrap: "none" })]],
        [tr("pubribbon.cornice_pagina"), () => { const M = D.margins; return [shapeBox(D, "rect", M.l, M.t, D.w - M.l - M.r, D.h - M.t - M.b, "none", { c: "s1", w: 2.25 }, { wrap: "none" })]; }],
        [tr("pubribbon.angoli_decorativi"), () => [shapeBox(D, "rtriangle", 0, 0, 60, 60, "s1", null, { wrap: "none", rot: 90 }), shapeBox(D, "rtriangle", 300, 140, 60, 60, "s1", null, { wrap: "none", rot: 270 })]],
        [tr("pubribbon.fascia_punti"), () => [shapeBox(D, "rect", 0, 0, 360, 30, "s1", null, { wrap: "none" }), ...[0, 1, 2, 3, 4].map(k => shapeBox(D, "ellipse", 140 + k * 18, 11, 8, 8, "s5", null, { wrap: "none" }))]]],
      pubblicita: [[tr("pubribbon.coupon"), () => [shapeBox(D, "rect", 0, 0, 220, 120, "s5", { c: "s1", w: 1.5, dash: "dash" }, { wrap: "none" }), textBox(D, 10, 10, 200, 100, [["BUONO SCONTO", "Titolo 3", { a: "c", sb: 0 }], ["-10%", "Titolo", { a: "c", z: 34 }], [tr("pubribbon.valido_fino_31_12"), "Didascalia", { a: "c" }]], { valign: "m" })]],
        [tr("pubribbon.offerta_speciale"), () => [shapeBox(D, "burst", 0, 0, 140, 140, "s3", null, { wrap: "none" }), textBox(D, 25, 45, 90, 50, [["OFFERTA", "Testo in evidenza", { c: "s0" }], ["speciale", "Normale", { a: "c" }]], { valign: "m" })]],
        [tr("pubribbon.annuncio"), () => [shapeBox(D, "rect", 0, 0, 260, 150, "s1", null, { wrap: "none" }), textBox(D, 12, 12, 236, 126, [[tr("pubribbon.titolo_dell_annuncio"), "Titolo 2", { c: "s5", sb: 0 }], [tr("pubribbon.descrivete_breve_l_offerta_prodotto"), "Normale", { c: "s5" }], [tr("pubribbon.chiamate_ora_000_000_0000"), "Normale", { c: "s5", b: true }]])]]],
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
    const f = { a: el("select", { class: "field" }, ...[["l", tr("pubribbon.sinistra_2")], ["c", tr("pubribbon.centrato")], ["r", tr("pubribbon.destra_2")], ["j", tr("pubribbon.giustificato")]].map(([v, l]) => el("option", { value: v, selected: (p.a || "l") === v }, l))),
      li: inText(cm(p.li || 0)), fi: inText(cm(p.fi || 0)), ri: inText(cm(p.ri || 0)), sb: inText(p.sb || 0), sa: inText(p.sa || 0), lh: inText(p.lh || 1) };
    const ok = await modal(tr("pubribbon.paragrafo"), el("div", { class: "pb-dlg" }, row(tr("pubribbon.allineamento"), f.a), row(tr("pubribbon.rientro_sinistro_cm"), f.li), row(tr("pubribbon.prima_riga_cm"), f.fi), row(tr("pubribbon.rientro_destro_cm"), f.ri), row(tr("pubribbon.spazio_prima_pt"), f.sb), row(tr("pubribbon.spazio_dopo_pt"), f.sa), row(tr("pubribbon.interlinea_righe"), f.lh)),
      [{ label: tr("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok) return after();
    const n = x => parseFloat(String(x.value).replace(",", ".")) || 0;
    E.applyPara({ a: f.a.value, li: fromCm(f.li.value) || undefined, fi: fromCm(f.fi.value) || undefined, ri: fromCm(f.ri.value) || undefined, sb: n(f.sb), sa: n(f.sa), lh: n(f.lh) || 1 }, tr("pubribbon.paragrafo"));
    after();
  }
  function styleForm(st) {
    const D = doc();
    const f = {
      f: el("select", { class: "field" }, ...[["+t", `${D.fonts.t} (Titoli)`], ["+b", `${D.fonts.b} (Corpo)`], ...FONTS.map(x => [x, x])].map(([v, l]) => el("option", { value: v, selected: st.f === v }, l))),
      z: inText(st.z || 10), b: el("input", { type: "checkbox", checked: !!st.b }), i: el("input", { type: "checkbox", checked: !!st.i }),
      c: el("select", { class: "field" }, ...["s0", "s1", "s2", "s3", "s4", "s5"].map((v, k) => el("option", { value: v, selected: st.c === v }, k ? tr("pubribbon.accento") + k : tr("pubribbon.principale")))),
      a: el("select", { class: "field" }, ...[["l", tr("pubribbon.sinistra_2")], ["c", tr("pubribbon.centrato")], ["r", tr("pubribbon.destra_2")], ["j", tr("pubribbon.giustificato")]].map(([v, l]) => el("option", { value: v, selected: (st.a || "l") === v }, l))),
      sb: inText(st.sb || 0), sa: inText(st.sa || 0), lh: inText(st.lh || 1),
    };
    const body = el("div", { class: "pb-dlg" }, row(tr("pubribbon.carattere"), f.f), row(tr("pubribbon.dimensione_pt"), f.z), row(tr("pubribbon.grassetto"), f.b), row(tr("pubribbon.corsivo"), f.i), row(tr("common.colore"), f.c), row(tr("pubribbon.allineamento"), f.a), row(tr("pubribbon.spazio_prima_pt"), f.sb), row(tr("pubribbon.spazio_dopo_pt"), f.sa), row(tr("pubribbon.interlinea"), f.lh));
    const read = () => { const n = x => parseFloat(String(x.value).replace(",", ".")) || 0; return { f: f.f.value, z: n(f.z) || 10, b: f.b.checked || undefined, i: f.i.checked || undefined, c: f.c.value, a: f.a.value, sb: n(f.sb), sa: n(f.sa), lh: n(f.lh) || 1 }; };
    return { body, read };
  }
  async function newStyleDlg() {
    const cs = E.charStyle() || {}, ps = E.paraStyle() || {};
    const name = el("input", { type: "text", class: "field", value: tr("pubribbon.stile_0", Object.keys(doc().styles).length + 1) });
    const form = styleForm({ ...cs, ...ps });
    const ok = await modal(tr("pubribbon.nuovo_stile"), el("div", {}, row(tr("common.nome"), name), form.body), [{ label: tr("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
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
    const ok = await modal(tr("pubribbon.modifica_stile_2") + name, form.body, [{ label: tr("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
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
    E.commit(tr("pubribbon.modifica_stile_3") + name);
    after();
  }
  async function tableDlg() {
    const r = inText(4), c = inText(3);
    const ok = await modal(tr("pubribbon.inserisci_tabella"), el("div", { class: "pb-dlg" }, row(tr("pubribbon.numero_righe"), r), row(tr("pubribbon.numero_colonne"), c)), [{ label: tr("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) E.insertTable(clamp(parseInt(r.value) || 1, 1, 100), clamp(parseInt(c.value) || 1, 1, 30));
    after();
  }
  async function insertPagesDlg() {
    const n = inText(1);
    const where = el("select", { class: "field" }, el("option", { value: "after" }, tr("pubribbon.dopo_pagina_corrente")), el("option", { value: "before" }, tr("pubribbon.prima_pagina_corrente")));
    const what = el("select", { class: "field" }, el("option", { value: "blank" }, tr("pubribbon.pagine_vuote")), el("option", { value: "text" }, tr("pubribbon.casella_testo_ogni_pagina")), el("option", { value: "dup" }, tr("pubribbon.duplica_tutti_oggetti_pagina_corrente")));
    const ok = await modal(tr("pubribbon.inserisci_pagina_2"), el("div", { class: "pb-dlg" }, row(tr("pubribbon.numero_nuove_pagine"), n), row(tr("pubribbon.posizione"), where), row(tr("pubribbon.opzioni"), what)), [{ label: tr("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) E.insertPages(clamp(parseInt(n.value) || 1, 1, 200), where.value, what.value);
    after();
  }
  async function movePageDlg() {
    const D = doc();
    const to = el("select", { class: "field" }, ...D.pages.map((_, k) => el("option", { value: k, selected: k === E.cur() }, tr("pubribbon.pagina_2") + (k + 1))));
    const pos = el("select", { class: "field" }, el("option", { value: "before" }, tr("pubribbon.prima_pagina")), el("option", { value: "after" }, tr("pubribbon.dopo_pagina")));
    const ok = await modal(tr("pubribbon.sposta_pagina") + (E.cur() + 1), el("div", { class: "pb-dlg" }, row(tr("pubribbon.posizione"), pos), row(tr("pubribbon.pagina"), to)), [{ label: tr("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok) return after();
    let t = +to.value + (pos.value === "after" ? 1 : 0);
    if (t > E.cur()) t--;
    E.movePage(E.cur(), t);
    after();
  }
  async function marginsDlg() {
    const M = doc().margins;
    const f = { l: inText(cm(M.l)), r: inText(cm(M.r)), t: inText(cm(M.t)), b: inText(cm(M.b)) };
    const ok = await modal(tr("pubribbon.guide_margini"), el("div", { class: "pb-dlg" }, row(tr("pubribbon.sinistro_cm"), f.l), row(tr("pubribbon.destro_cm"), f.r), row(tr("pubribbon.superiore_cm"), f.t), row(tr("pubribbon.inferiore_cm"), f.b)), [{ label: tr("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) { doc().margins = { l: fromCm(f.l.value), r: fromCm(f.r.value), t: fromCm(f.t.value), b: fromCm(f.b.value) }; E.commit(tr("pubribbon.margini")); }
    after();
  }
  async function pageSizeDlg() {
    const w = inText(cm(doc().w)), h = inText(cm(doc().h));
    const ok = await modal(tr("pubribbon.dimensioni_pagina_personalizzate_2"), el("div", { class: "pb-dlg" }, row(tr("pubribbon.larghezza_cm"), w), row(tr("pubribbon.altezza_cm"), h)), [{ label: tr("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) E.setPageSize(Math.max(CM, fromCm(w.value)), Math.max(CM, fromCm(h.value)));
    after();
  }
  async function guidesDlg() {
    const G = doc().grid;
    const f = { c: inText(G.cols || 1), r: inText(G.rows || 1), g: inText(cm(G.gap || 0)) };
    const ok = await modal(tr("pubribbon.guide_layout"), el("div", { class: "pb-dlg" }, row(tr("pubribbon.colonne"), f.c), row(tr("pubribbon.righe"), f.r), row(tr("pubribbon.spazio_fra_colonne_righe_cm"), f.g)), [{ label: tr("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) { doc().grid = { cols: clamp(parseInt(f.c.value) || 1, 1, 24), rows: clamp(parseInt(f.r.value) || 1, 1, 24), gap: fromCm(f.g.value) }; E.commit(tr("pubribbon.guide_layout")); }
    after();
  }
  async function schemeDlg() {
    const s = doc().scheme;
    const names = [tr("pubribbon.principale"), tr("pubribbon.accento_1"), tr("pubribbon.accento_2"), tr("pubribbon.accento_3"), tr("pubribbon.accento_4"), tr("pubribbon.accento_5")];
    const ins = s.c.map(c => el("input", { type: "color", value: c }));
    const name = el("input", { type: "text", class: "field", value: "Personalizzata" });
    const ok = await modal(tr("pubribbon.crea_nuova_combinazione_colori_2"), el("div", { class: "pb-dlg" }, row(tr("common.nome"), name), ...ins.map((x, k) => row(names[k], x))), [{ label: tr("common.annulla"), value: false }, { label: tr("common.salva"), value: true, primary: true }]);
    if (ok) E.setScheme({ name: name.value || tr("pubribbon.personalizzata"), c: ins.map(x => x.value) });
    after();
  }
  async function fontSchemeDlg() {
    const mk = v => el("select", { class: "field" }, ...FONTS.map(f => el("option", { value: f, selected: f === v }, f)));
    const t = mk(doc().fonts.t), b = mk(doc().fonts.b);
    const ok = await modal(tr("pubribbon.crea_nuova_combinazione_caratteri_2"), el("div", { class: "pb-dlg" }, row(tr("pubribbon.carattere_titoli"), t), row(tr("pubribbon.carattere_corpo"), b)), [{ label: tr("common.annulla"), value: false }, { label: tr("common.salva"), value: true, primary: true }]);
    if (ok) E.setFonts({ name: tr("pubribbon.personalizzata"), t: t.value, b: b.value });
    after();
  }
  async function boxMarginsDlg(o) {
    if (!o) return;
    const p = o.pad || [4, 4, 4, 4];
    const f = p.map(v => inText(cm(v)));
    const ok = await modal(tr("pubribbon.margini_casella_testo"), el("div", { class: "pb-dlg" }, row(tr("pubribbon.sinistro_cm"), f[0]), row(tr("pubribbon.superiore_cm"), f[1]), row(tr("pubribbon.destro_cm"), f[2]), row(tr("pubribbon.inferiore_cm"), f[3])), [{ label: tr("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) { o.pad = f.map(x => fromCm(x.value)); E.commit(tr("pubribbon.margini_casella")); }
    after();
  }
  async function columnsDlg(o) {
    if (!o) return;
    const n = inText(o.cols || 1), g = inText(cm(o.gap ?? 12));
    const ok = await modal(tr("pubribbon.colonne"), el("div", { class: "pb-dlg" }, row(tr("pubribbon.numero_colonne"), n), row(tr("pubribbon.spaziatura_cm"), g)), [{ label: tr("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
    if (ok) { o.cols = clamp(parseInt(n.value) || 1, 1, 12); o.gap = fromCm(g.value); E.commit(tr("pubribbon.colonne")); }
    after();
  }
  async function renameMasterDlg() {
    const m = doc().masters.find(x => x.id === E.masterId());
    if (!m) return;
    const v = await askText(tr("pubribbon.rinomina_pagina_master"), tr("pubribbon.descrizione"), m.name);
    if (v) { m.name = v; E.commit(tr("pubribbon.rinomina_pagina_master")); E.renderThumbs(); }
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
    await modal(tr("pubribbon.destinatari_0", M.source || ""), el("div", { class: "pb-rwrap" }, tbl), [{ label: "OK", value: true, primary: true }]);
    E.commit(tr("pubribbon.modifica_destinatari"));
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
    const t = el("table", { class: "pb-rtable" }, el("tr", {}, el("th", {}, ""), story ? el("th", {}, tr("pubribbon.storia_corrente")) : null, el("th", {}, tr("pubribbon.pubblicazione"))),
      ...[[tr("pubribbon.parole"), "w"], [tr("pubribbon.caratteri_spazi_esclusi"), "c"], [tr("pubribbon.caratteri_spazi_inclusi"), "cs"], [tr("pubribbon.paragrafi"), "p"]].map(([l, k]) => el("tr", {}, el("td", {}, l), story ? el("td", {}, String(story[k])) : null, el("td", {}, String(all[k])))),
      el("tr", {}, el("td", {}, tr("pubribbon.pagine")), story ? el("td", {}, "") : null, el("td", {}, String(D.pages.length))));
    await modal(tr("pubribbon.conteggio_parole"), t);
    after();
  }
  async function mergeToPdf() {
    const M = doc().merge;
    if (!M) return;
    const path = await (await import("./core.js")).pickSavePath(baseName(ctx.tab.name).replace(/\.[^.]+$/, "") + " - unione.pdf", "");
    if (!path) return after();
    try {
      toast(tr("pubribbon.creazione_pdf_unito"), false, 60000);
      await exportMergedPdf(E, path, M.rows.filter(r => !r._x));
      toast(tr("pubribbon.pdf_creato") + baseName(path));
    } catch (e) { console.error(e); toast(tr("pubribbon.unione_non_riuscita") + e.message, true, 8000); }
    after();
  }

  // --------------------------------------------- menu contestuale (tasto destro) e menu delle pagine
  E.contextMenu = (x, y, hit) => {
    const items = hit ? [
      { label: tr("common.taglia"), icon: "cut", keys: "Ctrl+X", run: () => E.cutSel() }, { label: tr("common.copia"), icon: "copy", keys: "Ctrl+C", run: () => E.copySel() }, { label: tr("common.incolla"), icon: "paste", keys: "Ctrl+V", run: () => E.pasteFromSystem() },
      { label: tr("pubribbon.elimina_oggetto"), keys: "Canc", run: () => E.deleteSel() }, { label: tr("pubribbon.duplica"), keys: "Ctrl+D", run: () => E.dup() }, "-",
      sel().length > 1 ? { label: tr("pubribbon.raggruppa"), icon: "group", keys: "Ctrl+G", run: () => E.group() } : null,
      sel().some(o => o.type === "group") ? { label: tr("pubribbon.separa"), icon: "ungroup", keys: "Ctrl+Maiusc+G", run: () => E.ungroup() } : null,
      { label: tr("pubribbon.disponi"), sub: () => [{ label: tr("pubribbon.porta_primo_piano"), icon: "bringFront", run: () => E.order("front") }, { label: tr("pubribbon.porta_avanti"), icon: "bringFwd", run: () => E.order("fwd") }, { label: tr("pubribbon.porta_indietro"), icon: "sendBack", run: () => E.order("back") }, { label: tr("pubribbon.porta_secondo_piano"), icon: "sendBackmost", run: () => E.order("backmost") }] },
      { label: tr("pubribbon.disponi_testo"), sub: wrapMenu }, { label: tr("pubribbon.allinea"), sub: alignMenu }, { label: tr("pubribbon.ruota_capovolgi"), sub: rotateMenu }, "-",
      hit.type === "image" ? { label: hit.img ? tr("pubribbon.cambia_immagine_2") : tr("pubribbon.inserisci_immagine"), icon: "changePic", run: () => E.changePicture() } : null,
      hit.type === "image" && hit.img ? { label: tr("pubribbon.ritaglia"), icon: "crop", run: () => E.cropToggle() } : null,
      hit.type === "text" ? { label: tr("pubribbon.crea_collegamento_testo_che_continua"), icon: "link", run: () => E.linkStart() } : null,
      hit.type === "wordart" ? { label: tr("pubribbon.modifica_testo_wordart"), icon: "editText", run: () => E.editWordArt() } : null,
      hit.type === "text" ? { label: tr("pubribbon.paragrafo_2"), run: paraDlg } : null,
      { label: tr("pubribbon.salva_come_immagine_png"), run: () => E.saveSelectionImage() },
    ] : [
      { label: tr("common.incolla"), icon: "paste", keys: "Ctrl+V", run: () => E.pasteFromSystem() }, "-",
      { label: tr("pubribbon.inserisci_pagina_2"), icon: "page", run: () => E.addPage(false) }, { label: tr("pubribbon.inserisci_pagina_duplicata"), icon: "pageDup", run: () => E.addPage(true) },
      { label: tr("pubribbon.guide"), sub: guidesMenu }, { label: tr("pubribbon.sfondo_pagina"), sub: bgMenu },
      { label: tr("pubribbon.zoom"), sub: () => [{ label: tr("pubribbon.pagina_intera"), run: () => E.fitPage() }, { label: tr("pubribbon.larghezza_pagina"), run: () => E.fitWidth() }, { label: "100%", run: () => E.zoom100() }] },
    ];
    popup({ x, y }, menuEl(items, after));
  };
  E.pageMenu = (x, y, pi) => {
    popup({ x, y }, menuEl([
      { label: tr("pubribbon.inserisci_pagina_2"), icon: "page", run: () => E.addPage(false) }, { label: tr("pubribbon.inserisci_pagina_duplicata"), icon: "pageDup", run: () => E.addPage(true) }, { label: tr("pubribbon.inserisci_pagine"), run: insertPagesDlg },
      { label: tr("pubribbon.elimina_pagina"), icon: "pageDel", run: () => E.deletePage(pi), dis: () => doc().pages.length < 2 }, { label: tr("pubribbon.sposta_pagina_2"), icon: "pageMove", run: movePageDlg }, "-",
      { label: tr("pubribbon.pagine_master"), sub: masterMenu },
    ], after));
  };

  render();
  return { refresh, render, menuEl, colorMenu };
}
