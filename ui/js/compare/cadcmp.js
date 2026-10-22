// Confronto di due disegni DWG/DXF: entita' aggiunte (verde), eliminate (rosso), modificate (arancio; la versione
// vecchia tratteggiata in rosso), uguali in grigio; filtro per layer e per stato, elenco cliccabile, riquadri di revisione.
// Abbinamento: firma della geometria e delle proprieta' (uguali), poi handle (le revisioni salvate da AutoCAD li
// conservano), poi stessa posizione con stesso tipo e layer (testi riscritti, cerchi ridimensionati...).
import { button, el, extOf, toast } from "../core.js";
import { ACI, buildModel, readDrawing } from "../viewers/cad2d.js";
import { COL, KIND_IT, canvasJpeg, chipBox, csvBlob, diffList, footerNumbers, legend, pdfDoc, reportHeader, reportTable, saveXlsx } from "./common.js";
import { t as tr, LOCALE } from "../i18n.js";
import { pinchPan } from "../touch.js";

const TYPE_IT = { LINE: tr("cadcmp.linea"), CIRCLE: tr("cadcmp.cerchio"), ARC: tr("cadcmp.arco"), LWPOLYLINE: tr("cadcmp.polilinea"), POLYLINE2D: tr("cadcmp.polilinea"), POLYLINE3D: tr("cadcmp.polilinea_3d"), TEXT: tr("cadcmp.testo"), MTEXT: tr("cadcmp.testo_multilinea"),
  INSERT: tr("cadcmp.blocco"), DIMENSION: tr("cadcmp.quota"), HATCH: tr("cadcmp.retino"), SPLINE: tr("cadcmp.spline"), ELLIPSE: tr("cadcmp.ellisse"), POINT: tr("cadcmp.punto"), SOLID: tr("cadcmp.solido"), TRACE: tr("cadcmp.traccia"), LEADER: tr("cadcmp.direttrice"),
  ATTRIB: tr("cadcmp.attributo"), ATTDEF: tr("cadcmp.definizione_attributo"), "3DFACE": tr("cadcmp.faccia_3d"), RAY: tr("cadcmp.semiretta"), XLINE: tr("cadcmp.retta"), IMAGE: tr("cadcmp.immagine"), WIPEOUT: tr("cadcmp.mascheratura"), MLINE: tr("cadcmp.multilinea"), MULTILEADER: tr("cadcmp.direttrice_multipla") };
const KEY_IT = { startPoint: tr("cadcmp.punto_iniziale"), endPoint: tr("cadcmp.punto_finale"), center: tr("cadcmp.k_centro"), radius: tr("cadcmp.k_raggio"), text: tr("cadcmp.k_testo"), layer: tr("cadcmp.k_layer"), colorIndex: tr("cadcmp.k_colore"), color: tr("cadcmp.k_colore"),
  insertionPoint: tr("cadcmp.k_posizione"), position: tr("cadcmp.k_posizione"), vertices: tr("cadcmp.k_vertici"), name: tr("cadcmp.k_blocco"), rotation: tr("cadcmp.k_rotazione"), xScale: tr("cadcmp.k_scala_x"), yScale: tr("cadcmp.k_scala_y"), zScale: tr("cadcmp.k_scala_z"),
  lineType: tr("cadcmp.tipo_linea"), lineweight: tr("cadcmp.k_spessore"), height: tr("cadcmp.k_altezza"), textHeight: tr("cadcmp.k_altezza"), startAngle: tr("cadcmp.angolo_iniziale"), endAngle: tr("cadcmp.angolo_finale"), majorAxisEndPoint: tr("cadcmp.k_asse"),
  axisRatio: tr("cadcmp.rapporto_assi"), attribs: tr("cadcmp.k_attributi"), definitionPoint: tr("cadcmp.k_geometria"), boundaryPaths: tr("cadcmp.k_contorno"), patternName: tr("cadcmp.k_motivo"), controlPoints: tr("cadcmp.punti_controllo"),
  fitPoints: tr("cadcmp.k_punti"), lineTypeScale: tr("cadcmp.scala_tipo_linea"), contents: tr("cadcmp.k_testo"), flag: tr("cadcmp.k_chiusura"), closed: tr("cadcmp.k_chiusura"), width: tr("cadcmp.k_larghezza"), thickness: tr("cadcmp.k_spessore"), __block: tr("cadcmp.contenuto_blocco"),
  measurement: tr("cadcmp.k_misura"), textOverride: tr("cadcmp.testo_quota"), columnCount: tr("cadcmp.k_colonne"), rowCount: tr("cadcmp.k_righe"), halign: tr("cadcmp.k_allineamento"), valign: tr("cadcmp.k_allineamento"), styleName: tr("cadcmp.k_stile") };
const SKIP = /handle|softid|hardid|owner|reactor|xdict|^_|^isInPaperSpace$|^extensionData$|^objectId$|^id$|^xdata$|^appData$/i;

const num = v => { if (!isFinite(v)) return String(v); const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? "0" : String(r); };
function canon(v, depth = 0) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return num(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (depth > 8) return "";
  if (Array.isArray(v)) return "[" + v.map(x => canon(x, depth + 1)).join(",") + "]";
  if (typeof v === "object") {
    const ks = Object.keys(v).filter(k => !SKIP.test(k) && v[k] !== undefined && typeof v[k] !== "function").sort();
    return "{" + ks.map(k => k + ":" + canon(v[k], depth + 1)).join(",") + "}";
  }
  return "";
}

export async function mountCompare(env) {
  const { ctx, oldPath, newPath, body, tools, progress, info } = env;
  progress(0.05, tr("cadcmp.lettura_revisione_vecchia"));
  const dbA = await readDrawing(oldPath, extOf(oldPath), { set: (p, m) => progress(0.05 + p * 0.3, m) });
  progress(0.35, tr("cadcmp.lettura_revisione_nuova"));
  const dbB = await readDrawing(newPath, extOf(newPath), { set: (p, m) => progress(0.35 + p * 0.3, m) });
  progress(0.68, tr("cadcmp.confronto_entita"));
  await new Promise(r => setTimeout(r, 0));

  // ---- firme
  function signer(db) {
    const blocks = new Map((db.tables.BLOCK_RECORD?.entries || []).map(b => [b.name, b]));
    const memo = new Map(), busy = new Set();
    const blockSig = name => {
      if (memo.has(name)) return memo.get(name);
      if (busy.has(name)) return "";
      busy.add(name);
      const b = blocks.get(name);
      const s = b ? canon(b.basePoint) + "|" + (b.entities || []).map(sig).join(";") : "?";
      busy.delete(name);
      memo.set(name, s);
      return s;
    };
    // blocchi anonimi (*D quote, *U tabelle...): il nome cambia tra le revisioni, conta solo il contenuto
    const sig = e => {
      const c = { ...e };
      let extra = "";
      if (e.type === "INSERT" || e.type === "DIMENSION") {
        const bn = e.name || e.blockName;
        if (bn) { extra = "#" + hash(blockSig(bn)); if (/^\*/.test(bn)) { delete c.name; delete c.blockName; } }
      }
      return e.type + canon(c) + extra;
    };
    return { sig, blockSig };
  }
  const SA = signer(dbA), SB = signer(dbB);
  const inModel = db => db.entities.map((e, i) => i).filter(i => !db.entities[i].isInPaperSpace && db.entities[i].type !== "_skip");
  const IA = inModel(dbA), IB = inModel(dbB);
  const sigA = new Map(IA.map(i => [i, SA.sig(dbA.entities[i])])), sigB = new Map(IB.map(j => [j, SB.sig(dbB.entities[j])]));
  progress(0.75, tr("cadcmp.abbinamento_entita"));
  await new Promise(r => setTimeout(r, 0));
  const fullA = buildModel(dbA), fullB = buildModel(dbB);
  const bbOf = (M, k) => {
    const L = M.ents[k];
    if (!L || !L.length) return null;
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const i of L) { const q = M.items[i].bb; if (!q || !q.every(isFinite)) continue; b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[2]); b[3] = Math.max(b[3], q[3]); }
    return isFinite(b[0]) ? b : null;
  };
  const bbA = new Map(IA.map(i => [i, bbOf(fullA, i)])), bbB = new Map(IB.map(j => [j, bbOf(fullB, j)]));
  const ext = [Math.min(fullA.bbox[0], fullB.bbox[0]), Math.min(fullA.bbox[1], fullB.bbox[1]), Math.max(fullA.bbox[2], fullB.bbox[2]), Math.max(fullA.bbox[3], fullB.bbox[3])];
  const diag = Math.hypot(ext[2] - ext[0], ext[3] - ext[1]) || 1;

  // 1) uguali: stessa firma
  const pool = new Map();
  for (const j of IB) { const s = sigB.get(j); if (!pool.has(s)) pool.set(s, []); pool.get(s).push(j); }
  const same = [], restA = [];
  for (const i of IA) { const L = pool.get(sigA.get(i)); if (L && L.length) same.push([i, L.shift()]); else restA.push(i); }
  const usedB = new Set(same.map(p => p[1]));
  let restB = IB.filter(j => !usedB.has(j));
  // 2) stesso handle e stesso tipo, non troppo lontane
  const mods = [];
  const byHandle = new Map(restB.filter(j => dbB.entities[j].handle).map(j => [dbB.entities[j].handle, j]));
  const cen = b => (b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null);
  const dist = (a, b) => { const p = cen(a), q = cen(b); return p && q ? Math.hypot(p[0] - q[0], p[1] - q[1]) : Infinity; };
  const pairedA = new Set(), pairedB = new Set();
  for (const i of restA) {
    const ea = dbA.entities[i];
    const j = ea.handle ? byHandle.get(ea.handle) : undefined;
    if (j === undefined || pairedB.has(j)) continue;
    const eb = dbB.entities[j];
    if (eb.type !== ea.type) continue;
    if (eb.layer !== ea.layer && dist(bbA.get(i), bbB.get(j)) > diag * 0.25) continue;
    mods.push([i, j]); pairedA.add(i); pairedB.add(j);
  }
  // 3) stessa posizione, stesso tipo e layer
  const cand = new Map();
  for (const j of restB) { if (pairedB.has(j)) continue; const e = dbB.entities[j], k = e.type + "|" + e.layer; if (!cand.has(k)) cand.set(k, []); cand.get(k).push(j); }
  const near = [];
  for (const i of restA) {
    if (pairedA.has(i)) continue;
    const e = dbA.entities[i], L = cand.get(e.type + "|" + e.layer);
    if (!L) continue;
    const ba = bbA.get(i);
    for (const j of L) {
      const bb = bbB.get(j), d = dist(ba, bb);
      if (!ba || !bb || d > Math.max(diag * 0.004, 1e-6)) continue;
      const sa = Math.hypot(ba[2] - ba[0], ba[3] - ba[1]), sb = Math.hypot(bb[2] - bb[0], bb[3] - bb[1]);
      if (sa > 1e-9 && sb > 1e-9 && (sa / sb > 3 || sb / sa > 3)) continue;
      near.push([d, i, j]);
    }
  }
  near.sort((a, b) => a[0] - b[0]);
  for (const [, i, j] of near) if (!pairedA.has(i) && !pairedB.has(j)) { mods.push([i, j]); pairedA.add(i); pairedB.add(j); }
  const dels = restA.filter(i => !pairedA.has(i)), adds = restB.filter(j => !pairedB.has(j));

  // ---- dettaglio delle modifiche
  const changedKeys = (a, b, S1, S2) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter(k => !SKIP.test(k)));
    const out = [];
    for (const k of keys) if (canon(a[k]) !== canon(b[k])) { if (/^\*/.test(a.name || "") && (k === "name" || k === "blockName")) continue; out.push(k); }
    if ((a.type === "INSERT" || a.type === "DIMENSION") && (a.name || a.blockName) && hash(S1.blockSig(a.name || a.blockName)) !== hash(S2.blockSig(b.name || b.blockName))) out.push("__block");
    return out;
  };
  const textOf = e => String(e.text ?? e.contents ?? "").replace(/\\P/g, " ").replace(/\{\\[^;]*;|\}|\\[A-Za-z][^;]*;/g, "").trim();
  const fmtP = p => (p ? `${+(+p.x).toFixed(3)}; ${+(+p.y).toFixed(3)}` : "");
  const posOf = e => e.insertionPoint || e.position || e.center || e.startPoint || e.definitionPoint || (e.vertices && e.vertices[0]) || null;
  const items = [];
  const typeIt = e => TYPE_IT[e.type] || e.type;
  const blockName = e => (e.type === "INSERT" && e.name && !/^\*/.test(e.name) ? ` "${e.name}"` : "");
  for (const i of dels) { const e = dbA.entities[i]; items.push({ kind: "del", a: i, e, bb: bbA.get(i), layer: e.layer || "0", detail: e.type === "TEXT" || e.type === "MTEXT" ? `«${textOf(e)}»` : fmtP(posOf(e)) }); }
  for (const j of adds) { const e = dbB.entities[j]; items.push({ kind: "add", b: j, e, bb: bbB.get(j), layer: e.layer || "0", detail: e.type === "TEXT" || e.type === "MTEXT" ? `«${textOf(e)}»` : fmtP(posOf(e)) }); }
  for (const [i, j] of mods) {
    const ea = dbA.entities[i], eb = dbB.entities[j];
    const ks = changedKeys(ea, eb, SA, SB);
    // valori vecchio -> nuovo per punti, numeri e nomi (le liste di vertici restano solo nominate)
    const val = v => (v && typeof v === "object" && "x" in v ? fmtP(v) : typeof v === "number" ? String(+v.toFixed(4)) : typeof v === "string" && v.length < 40 ? v : null);
    let detail = ks.map(k => { const o = val(ea[k]), n = val(eb[k]); return (KEY_IT[k] || k) + (o !== null && n !== null && ks.length <= 3 ? ` ${o} → ${n}` : ""); })
      .filter((v, k, arr) => arr.indexOf(v) === k).join(", ");
    if ((ea.type === "TEXT" || ea.type === "MTEXT") && textOf(ea) !== textOf(eb)) detail = `«${textOf(ea)}» → «${textOf(eb)}»` + (ks.length > 1 ? " · " + detail : "");
    else if (ks.includes("layer")) detail = tr("cadcmp.layer_da_a", ea.layer, eb.layer) + (ks.length > 1 ? " · " + detail.replace(/(^|, )layer/, "") : "");
    const ba = bbA.get(i), bb = bbB.get(j);
    const u = ba && bb ? [Math.min(ba[0], bb[0]), Math.min(ba[1], bb[1]), Math.max(ba[2], bb[2]), Math.max(ba[3], bb[3])] : ba || bb;
    items.push({ kind: "mod", a: i, b: j, e: eb, eOld: ea, bb: u, layer: eb.layer || "0", layerOld: ea.layer || "0", detail: detail || tr("cadcmp.proprieta") });
  }
  items.forEach(it => { it.title = `${typeIt(it.eOld || it.e)}${blockName(it.e)}`; it.handle = (it.eOld || it.e).handle || ""; it.handleNew = it.kind === "mod" ? it.e.handle || "" : ""; });
  const order = { mod: 0, add: 1, del: 2 };
  items.sort((p, q) => order[p.kind] - order[q.kind] || p.layer.localeCompare(q.layer) || p.title.localeCompare(q.title));
  items.forEach((it, n) => (it.n = n + 1));

  // ---- modelli da disegnare
  progress(0.85, tr("cadcmp.preparazione_vista"));
  await new Promise(r => setTimeout(r, 0));
  const sub = (db, idx) => { const M = buildModel({ ...db, entities: idx.map(i => db.entities[i]) }); M.map = idx; return M; };
  const M = {
    same: sub(dbB, same.map(p => p[1])),
    modOld: sub(dbA, mods.map(p => p[0])),
    del: sub(dbA, dels),
    modNew: sub(dbB, mods.map(p => p[1])),
    add: sub(dbB, adds),
  };
  const itemOf = { del: new Map(), add: new Map(), modOld: new Map(), modNew: new Map() };
  for (const it of items) {
    if (it.kind === "del") itemOf.del.set(it.a, it);
    else if (it.kind === "add") itemOf.add.set(it.b, it);
    else { itemOf.modOld.set(it.a, it); itemOf.modNew.set(it.b, it); }
  }

  // ---- interfaccia
  const side = el("div", { class: "cmp-side" }), main = el("div", { class: "cmp-main" });
  body.append(side, main);
  const show = { add: true, del: true, mod: true, same: true, boxes: true };
  const layerOff = new Set();
  const counts = { add: adds.length, del: dels.length, mod: mods.length, same: same.length };
  const fAdd = chipBox(tr("cadcmp.aggiunte"), COL.add, true, v => { show.add = v; refresh(); }, counts.add);
  const fDel = chipBox(tr("cadcmp.eliminate"), COL.del, true, v => { show.del = v; refresh(); }, counts.del);
  const fMod = chipBox(tr("cadcmp.modificate"), COL.mod, true, v => { show.mod = v; refresh(); }, counts.mod);
  const fSame = chipBox(tr("cadcmp.uguali_grigio"), COL.same, true, v => { show.same = v; draw(); }, counts.same);
  const sum = el("div", { class: "cmp-sum" },
    ...[[counts.add, tr("cadcmp.n_aggiunte"), COL.add], [counts.del, tr("cadcmp.n_eliminate"), COL.del], [counts.mod, tr("cadcmp.n_modificate"), COL.mod], [counts.same, tr("cadcmp.n_uguali"), ""]].map(([n, t, c]) => el("div", {}, el("b", { style: { color: c } }, String(n)), el("span", {}, t))));
  // layer: unione dei due disegni, con il numero di differenze
  const layerNames = [...new Set([...fullA.layers.values(), ...fullB.layers.values()].filter(L => L.count).map(L => L.name))].sort((a, b) => a.localeCompare(b));
  const diffPerLayer = new Map();
  for (const it of items) { diffPerLayer.set(it.layer, (diffPerLayer.get(it.layer) || 0) + 1); if (it.layerOld && it.layerOld !== it.layer) diffPerLayer.set(it.layerOld, (diffPerLayer.get(it.layerOld) || 0) + 1); }
  const layerBox = el("div", { class: "cmp-layers" });
  const layerChecks = new Map();
  const lcolor = n => { const L = fullB.layers.get(n) || fullA.layers.get(n); const c = ACI[Math.abs(L?.aci ?? 7)] || ACI[7]; return `rgb(${c.join(",")})`; };
  for (const n of layerNames) {
    const c = chipBox(n, lcolor(n), true, v => { if (v) layerOff.delete(n); else layerOff.add(n); refresh(); }, diffPerLayer.get(n) || 0);
    layerChecks.set(n, c.input);
    layerBox.append(c);
  }
  const setLayers = fn => { for (const [n, cb] of layerChecks) { cb.checked = fn(n); if (cb.checked) layerOff.delete(n); else layerOff.add(n); } refresh(); };
  const list = diffList({ onPick: it => focus(it) });
  side.append(el("div", { class: "cmp-sec" }, el("h4", {}, tr("cadcmp.riepilogo")), sum),
    el("div", { class: "cmp-sec" }, el("h4", {}, tr("cadcmp.mostra")), fAdd, fDel, fMod, fSame),
    el("div", { class: "cmp-sec" }, el("h4", {}, tr("cadcmp.layer"), el("span", { class: "grow" }),
      el("button", { onclick: () => setLayers(() => true) }, tr("cadcmp.tutti")), el("button", { onclick: () => setLayers(n => diffPerLayer.has(n)) }, tr("cadcmp.differenze")), el("button", { onclick: () => setLayers(() => false) }, tr("cadcmp.nessuno"))), layerBox),
    list.el);
  const visible = it => show[it.kind] && (!layerOff.has(it.layer) || (it.layerOld && !layerOff.has(it.layerOld)));
  function refresh() {
    list.set(items.filter(visible).map(it => ({ ...it, color: COL[it.kind], where: it.layer, sub: `${KIND_IT[it.kind]}${it.detail ? " · " + it.detail : ""}`, tip: `${KIND_IT[it.kind]} · ${it.title} · ${tr("cadcmp.layer")} ${it.layer}${it.handle ? " · handle " + it.handle : ""}\n${it.detail || ""}`, ref: it })));
    if (!list.items.length) list.el.querySelector(".cmp-list-in").append(el("div", { class: "cmp-empty" }, items.length ? tr("cadcmp.nessuna_differenza_i_filtri_scelti") : tr("cadcmp.nessuna_differenza_i_due_disegni")));
    draw();
  }

  // ---- vista
  const bar = el("div", { class: "cmp-bar" }), stage = el("div", { class: "cmp-stage dark" });
  const canvas = el("canvas", { class: "fill", style: { touchAction: "none" } });
  const tip = el("div", { class: "cmp-tip", hidden: true });
  stage.append(canvas, tip);
  main.append(bar, stage);
  let dark = true;
  const bBg = button(tr("cadcmp.sfondo_chiaro"), "sun", () => { dark = !dark; stage.classList.toggle("dark", dark); bBg.lastChild.textContent = dark ? tr("cadcmp.sfondo_chiaro") : tr("cadcmp.sfondo_scuro"); draw(); });
  const bBox = button(tr("cadcmp.riquadri"), '<svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 13h7v7h-7z" stroke-dasharray="3 2"/></svg>', () => { show.boxes = !show.boxes; bBox.classList.toggle("on", show.boxes); draw(); }, { title: tr("cadcmp.riquadri_revisione_attorno_alle_differenze") });
  bBox.classList.add("on");
  let cur = 0;
  const step = d => { const L = list.items; if (!L.length) return; cur = (cur + d + L.length) % L.length; list.select(cur); focus(L[cur]); };
  bar.append(button(tr("cadcmp.adatta"), "fit", fit), button("", "zoomIn", () => zoomAt(1.4), { iconOnly: true, title: tr("cadcmp.ingrandisci") }), button("", "zoomOut", () => zoomAt(1 / 1.4), { iconOnly: true, title: tr("cadcmp.riduci") }),
    el("span", { class: "sep" }), button(tr("cadcmp.precedente"), '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>', () => step(-1), { title: tr("cadcmp.differenza_precedente") }),
    button(tr("cadcmp.successiva"), '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>', () => step(1), { title: tr("cadcmp.differenza_successiva") }),
    el("span", { class: "sep" }), bBox, bBg, el("span", { class: "grow" }),
    el("span", { class: "cmp-legend" }, ...[[COL.del, tr("cadcmp.l_eliminata")], [COL.add, tr("cadcmp.l_aggiunta")], [COL.mod, tr("cadcmp.modificata_nuova")], [COL.same, tr("cadcmp.l_uguale")]].map(([c, t]) => el("span", {}, el("i", { class: "cmp-chip", style: { background: c } }), t))));
  tools.append(el("span", { class: "note" }, tr("cadcmp.0_1_entita", IA.length.toLocaleString(LOCALE), IB.length.toLocaleString(LOCALE))));

  const view = { s: 1, tx: 0, ty: 0 };
  let selected = null, flashN = 0, flashTimer = 0;
  const g2 = canvas.getContext("2d");
  const dpr = () => devicePixelRatio || 1;
  function resize() { const r = canvas.getBoundingClientRect(); canvas.width = Math.max(1, r.width * dpr()); canvas.height = Math.max(1, r.height * dpr()); }
  function zoomBox(b, k = 0.9) {
    const W = canvas.width, H = canvas.height;
    const w = Math.max(b[2] - b[0], diag * 1e-4), h = Math.max(b[3] - b[1], diag * 1e-4);
    view.s = k * Math.min(W / w, H / h);
    view.tx = W / 2 - view.s * (b[0] + b[2]) / 2;
    view.ty = H / 2 + view.s * (b[1] + b[3]) / 2;
    draw();
  }
  function fit() { resize(); zoomBox(ext); }
  function zoomAt(f, px = canvas.width / 2, py = canvas.height / 2) { view.tx = px - (px - view.tx) * f; view.ty = py - (py - view.ty) * f; view.s *= f; draw(); }
  const toWorld = (px, py) => [(px - view.tx) / view.s, (view.ty - py) / view.s];

  function paintModel(g, Mx, color, s, o = {}) {
    g.globalAlpha = o.alpha ?? 1;
    g.strokeStyle = g.fillStyle = color;
    g.setLineDash(o.dash ? [6 / s, 4 / s] : []);
    g.lineWidth = (o.lw || 1) / s;
    for (const gr of Mx.groups) {
      if (layerOff.has(gr.layer)) continue;
      if (gr.fills.length) { g.globalAlpha = (o.alpha ?? 1) * 0.6; g.fill(gr.fillPath); g.globalAlpha = o.alpha ?? 1; }
      if (gr.lines.length) g.stroke(gr.path);
    }
    g.setLineDash([]);
    for (const t of Mx.texts) {
      if (layerOff.has(t.layer) || t.h * s < 2) continue;
      g.save();
      g.transform(...t.A);
      const k = t.F / 100;
      g.scale(k, -k);
      g.font = "100px Arial, sans-serif";
      for (const r of t.rows) g.fillText(r.s, r.x / k, -r.y / k);
      g.restore();
    }
    g.globalAlpha = 1;
  }
  function render(g, W, H, s, tx, ty, isDark, o = {}) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = isDark ? "#1e2021" : "#ffffff";
    g.fillRect(0, 0, W, H);
    g.setTransform(s, 0, 0, -s, tx, ty);
    g.lineJoin = g.lineCap = "round";
    const k = o.lineK || 1;
    if (show.same) paintModel(g, M.same, isDark ? "#8b8d98" : "#9a9ca3", s, { alpha: isDark ? 0.75 : 0.9, lw: k });
    if (show.mod) paintModel(g, M.modOld, COL.del, s, { dash: true, alpha: 0.75, lw: 1.2 * k });
    if (show.del) paintModel(g, M.del, COL.del, s, { lw: 1.8 * k });
    if (show.mod) paintModel(g, M.modNew, COL.mod, s, { lw: 1.8 * k });
    if (show.add) paintModel(g, M.add, COL.add, s, { lw: 1.8 * k });
    g.setTransform(1, 0, 0, 1, 0, 0);
    const box = (it, color, lw, pad) => {
      if (!it.bb) return;
      const x0 = it.bb[0] * s + tx - pad, y0 = ty - it.bb[3] * s - pad, x1 = it.bb[2] * s + tx + pad, y1 = ty - it.bb[1] * s + pad;
      g.strokeStyle = color; g.lineWidth = lw;
      g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    };
    if (show.boxes) { g.setLineDash([5 * (o.px || 1), 3 * (o.px || 1)]); for (const it of items) if (visible(it)) box(it, COL[it.kind], 1 * (o.px || 1), 6 * (o.px || 1)); g.setLineDash([]); }
    if (o.sel && selected) box(selected, isDark ? "#ffffff" : "#000000", 2 * (o.px || 1), 10 * (o.px || 1) + (flashN % 2) * 4);
  }
  function draw() {
    if (!canvas.width) return;
    render(g2, canvas.width, canvas.height, view.s, view.tx, view.ty, dark, { sel: true, px: dpr() });
  }
  function focus(row) {
    const it = row.ref || row;
    selected = it;
    cur = Math.max(0, list.items.findIndex(x => x.ref === it));
    if (it.bb) {
      const w = Math.max(it.bb[2] - it.bb[0], it.bb[3] - it.bb[1], diag * 0.01);
      const c = cen(it.bb);
      zoomBox([c[0] - w * 1.5, c[1] - w * 1.5, c[0] + w * 1.5, c[1] + w * 1.5], 0.95);
    } else { draw(); toast(tr("cadcmp.questa_entita_non_ha_geometria")); }
    clearInterval(flashTimer);
    flashN = 0;
    flashTimer = setInterval(() => { flashN++; draw(); if (flashN >= 6) clearInterval(flashTimer); }, 260);
    ctx.status(`${KIND_IT[it.kind]}: ${it.title} · ${tr("cadcmp.layer")} ${it.layer}${it.detail ? " · " + it.detail : ""}`);
  }
  // clic su una differenza nel disegno: la seleziona nell'elenco
  function hitTest(px, py) {
    const [x, y] = toWorld(px, py), tol = 6 * dpr() / view.s;
    const order = [["add", show.add], ["modNew", show.mod], ["del", show.del], ["modOld", show.mod]];
    let best = null;
    for (const [k, on] of order) {
      if (!on) continue;
      const Mx = M[k];
      for (const ii of Mx.query(x - tol, y - tol, x + tol, y + tol)) {
        const q = Mx.items[ii];
        if (layerOff.has(q.l)) continue;
        const it = itemOf[k].get(Mx.map[q.o]);
        if (!it) continue;
        const b = q.bb, d = Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3]));
        if (!best || d < best.d) best = { it, d };
      }
      if (best) break;
    }
    return best?.it || null;
  }
  let drag = null;
  const pos = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * dpr(), (e.clientY - r.top) * dpr()]; };
  canvas.addEventListener("pointerdown", e => { const [px, py] = pos(e); drag = { px, py, tx: view.tx, ty: view.ty, moved: false }; try { canvas.setPointerCapture(e.pointerId); } catch { /* */ } });
  canvas.addEventListener("pointermove", e => {
    const [px, py] = pos(e);
    if (drag) {
      if (Math.hypot(px - drag.px, py - drag.py) > 4) drag.moved = true;
      if (drag.moved) { view.tx = drag.tx + px - drag.px; view.ty = drag.ty + py - drag.py; draw(); }
      return;
    }
    const it = hitTest(px, py);
    const [wx, wy] = toWorld(px, py);
    if (it) {
      tip.hidden = false;
      tip.textContent = `${KIND_IT[it.kind]}: ${it.title} · ${it.layer}${it.detail ? " · " + it.detail : ""}`;
      tip.style.left = px / dpr() + 14 + "px"; tip.style.top = py / dpr() + 14 + "px";
    } else tip.hidden = true;
    ctx.status(`X ${wx.toLocaleString(LOCALE, { maximumFractionDigits: 3 })}  Y ${wy.toLocaleString(LOCALE, { maximumFractionDigits: 3 })}`);
  });
  // tablet: pizzico = zoom, due dita = sposta
  pinchPan(canvas, {
    onStart: () => { drag = null; tip.hidden = true; },
    onPan: (dx, dy) => { view.tx += dx * dpr(); view.ty += dy * dpr(); draw(); },
    onZoom: (f, cx, cy) => zoomAt(f, cx * dpr(), cy * dpr()),
  });
  canvas.addEventListener("pointerup", e => {
    const d = drag;
    drag = null;
    if (d && !d.moved && e.button === 0) {
      const it = hitTest(...pos(e));
      if (it) { const k = list.items.findIndex(x => x.ref === it); if (k >= 0) list.select(k); focus(it); }
    }
  });
  canvas.addEventListener("pointerleave", () => (tip.hidden = true));
  canvas.addEventListener("wheel", e => { e.preventDefault(); const [px, py] = pos(e); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, px, py); }, { passive: false });
  canvas.addEventListener("dblclick", fit);
  let fitted = false;
  new ResizeObserver(() => { const r = canvas.getBoundingClientRect(); if (!r.width) return; if (!fitted) { fitted = true; fit(); } else { const ow = canvas.width; resize(); if (ow) draw(); } }).observe(canvas);
  const onKey = e => {
    if (ctx.tab.view.hidden || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
    if (e.key === "F3" || (e.key === "ArrowDown" && e.altKey)) { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
  };
  window.addEventListener("keydown", onKey);
  refresh();

  // ---- report
  const KIND_ROW = { add: tr("cadcmp.aggiunta"), del: tr("cadcmp.eliminata"), mod: tr("cadcmp.modificata") };
  const rows = () => items.filter(visible).map(it => Object.assign([it.n, KIND_ROW[it.kind], it.title, it.layerOld && it.layerOld !== it.layer ? `${it.layerOld} → ${it.layer}` : it.layer, it.detail || "",
    it.handle, it.handleNew, it.bb ? +((it.bb[0] + it.bb[2]) / 2).toFixed(3) : "", it.bb ? +((it.bb[1] + it.bb[3]) / 2).toFixed(3) : ""], { kind: it.kind }));
  const HEAD = [tr("cmp.n"), tr("cadcmp.stato"), tr("cadcmp.tipo"), tr("cadcmp.layer"), tr("cadcmp.dettaglio"), tr("cadcmp.handle_vecchia"), tr("cadcmp.handle_nuova"), tr("cadcmp.x_centro"), tr("cadcmp.y_centro")];
  async function reportPdf() {
    const doc = pdfDoc();
    const p = doc.addPage(842, 595);
    const top = reportHeader(p, info, tr("cadcmp.confronto_disegni_dwg_dxf"));
    const lines = [tr("cadcmp.entita_modello_vecchia_0_nuova", IA.length, IB.length), tr("cadcmp.aggiunte_0_eliminate_1_modificate", counts.add, counts.del, counts.mod, counts.same),
      layerOff.size ? tr("cadcmp.layer_esclusi_report_0", [...layerOff].join(", ")) : tr("cadcmp.tutti_i_layer")];
    lines.forEach((l, i) => p.text(24, top + 8 + i * 13, l, 9.5, { bold: i === 1 }));
    legend(p, 24, top + 54, [[COL.del, tr("cadcmp.l_eliminata")], [COL.add, tr("cadcmp.l_aggiunta")], [COL.mod, tr("cadcmp.modificata_nuova")], [COL.del, tr("cadcmp.modificata_vecchia_tratteggio")], [COL.same, tr("cadcmp.l_uguale")]]);
    // disegno intero con le differenze, su fondo bianco
    const areaY = top + 66, areaH = p.h - areaY - 24, areaW = p.w - 48;
    const k = Math.min(4200 / (ext[2] - ext[0] || 1), 4200 / (ext[3] - ext[1] || 1));
    const c = document.createElement("canvas");
    c.width = Math.max(10, Math.ceil((ext[2] - ext[0]) * k * 1.06));
    c.height = Math.max(10, Math.ceil((ext[3] - ext[1]) * k * 1.06));
    const f = Math.min(areaW / c.width, areaH / c.height);
    render(c.getContext("2d"), c.width, c.height, k, c.width / 2 - k * (ext[0] + ext[2]) / 2, c.height / 2 + k * (ext[1] + ext[3]) / 2, false, { px: 1 / f * 0.9, lineK: 1 / f * 0.6 });
    p.rect((p.w - c.width * f) / 2, areaY, c.width * f, c.height * f, { stroke: "#bbbbbb" });
    p.image(await canvasJpeg(c, 0.9), c.width, c.height, (p.w - c.width * f) / 2, areaY, c.width * f, c.height * f);
    // dettaglio di ogni differenza (fino a 60 riquadri, 6 per pagina)
    const det = items.filter(visible).slice(0, 60);
    for (let s = 0; s < det.length; s += 6) {
      const pg = doc.addPage(842, 595);
      const t0 = reportHeader(pg, info, tr("cadcmp.dettaglio_differenze"));
      for (let q = 0; q < 6 && s + q < det.length; q++) {
        const it = det[s + q], cx = 24 + (q % 3) * 266, cy = t0 + 6 + Math.floor(q / 3) * 254, w = 254, h = 214;
        const cc = document.createElement("canvas");
        cc.width = 760; cc.height = 640;
        if (it.bb) {
          const sz = Math.max(it.bb[2] - it.bb[0], it.bb[3] - it.bb[1], diag * 0.01) * 1.6, ce = cen(it.bb);
          const kk = Math.min(cc.width, cc.height) / sz;
          const keep = selected;
          selected = it;
          render(cc.getContext("2d"), cc.width, cc.height, kk, cc.width / 2 - kk * ce[0], cc.height / 2 + kk * ce[1], false, { sel: true, px: 2, lineK: 2 });
          selected = keep;
        }
        pg.rect(cx, cy, w, h, { stroke: "#bbbbbb" });
        pg.image(await canvasJpeg(cc, 0.88), cc.width, cc.height, cx + 1, cy + 1, w - 2, h - 2);
        pg.rect(cx, cy + h + 4, 4, 22, { fill: COL[it.kind] });
        pg.text(cx + 9, cy + h + 12, `${it.n}. ${KIND_ROW[it.kind]} · ${it.title} · ${it.layer}`.slice(0, 70), 8, { bold: true });
        pg.text(cx + 9, cy + h + 23, (it.detail || "").slice(0, 80), 7.5, { color: "#555555" });
      }
    }
    reportTable(doc, info, tr("cadcmp.elenco_differenze"), [{ t: tr("cmp.n"), w: 30 }, { t: tr("cadcmp.stato"), w: 70 }, { t: tr("cadcmp.tipo"), w: 110 }, { t: tr("cadcmp.layer"), w: 110 }, { t: tr("cadcmp.dettaglio"), w: 300 }, { t: tr("cadcmp.handle"), w: 70 }, { t: "Centro X; Y", w: 104 }],
      rows().map(r => ({ color: COL[r.kind], cells: [r[0], r[1], r[2], r[3], r[4], r[5] + (r[6] && r[6] !== r[5] ? " → " + r[6] : ""), r[7] === "" ? "" : `${r[7]}; ${r[8]}`] })));
    footerNumbers(doc);
    return new Blob([doc.build(tr("cadcmp.confronto") + info.oldName + " - " + info.newName)], { type: "application/pdf" });
  }
  async function reportXlsx() {
    return saveXlsx(null, [
      { name: tr("cadcmp.riepilogo"), filter: false, widths: [30, 60], rows: [[tr("cadcmp.confronto_disegni_dwg_dxf"), ""], [tr("cadcmp.vecchia"), info.oldName], [tr("cadcmp.nuova"), info.newName], [tr("cadcmp.data"), info.date],
        [tr("cadcmp.entita_vecchia"), IA.length], [tr("cadcmp.entita_nuova"), IB.length], [tr("cadcmp.aggiunte"), counts.add], [tr("cadcmp.eliminate"), counts.del], [tr("cadcmp.modificate"), counts.mod], [tr("cadcmp.uguali"), counts.same]] },
      { name: tr("cadcmp.differenze_2"), widths: [6, 12, 22, 20, 60, 14, 14, 14, 14], rows: [HEAD, ...rows()] },
      { name: tr("cadcmp.layer"), widths: [30, 14], rows: [[tr("cadcmp.layer"), tr("cadcmp.differenze_2")], ...layerNames.map(n => [n, diffPerLayer.get(n) || 0])] },
    ]);
  }
  const reportCsv = async () => csvBlob([HEAD, ...rows()]);

  return {
    onShow() { resize(); draw(); },
    reportPdf, reportXlsx, reportCsv,
    _cc: { items, M, focus, list, view, counts, same, mods, dels, adds },
    dispose() { window.removeEventListener("keydown", onKey); },
  };
}

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + s.length.toString(36); }
