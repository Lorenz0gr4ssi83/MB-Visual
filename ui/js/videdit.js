// Montaggio video e audio con la disposizione di Adobe Premiere Pro (area di lavoro "Montaggio"):
//   in alto a sinistra Sorgente / Controlli effetti / Mixer tracce audio, in alto a destra Monitor programma,
//   in basso Progetto / Effetti, barra strumenti verticale, Timeline multitraccia e misuratori audio.
// Stessi strumenti e tasti di Premiere (V, A, B, N, R, C, Y, U, P, H, Z, T; J/K/L, I/O, Ctrl+K, Q/W, Maiusc+Canc,
// virgola/punto, ; e ', Ctrl+D, Ctrl+M...). Il progetto si salva in .mbvid (JSON, vidmodel.js); l'anteprima e' in
// tempo reale nel browser (vidplay.js + vidgl.js), l'esportazione definitiva la fa FFmpeg (mbvisual/video.py).
import { api, baseName, confirmBox, dirName, el, extOf, fileUrl, loadCss, modal, pickFiles, pickSavePath, saveBytes, toast, waitJob, WEB, askText } from "./core.js";
import { keymap } from "./shortcuts.js";
import { vIcon } from "./vidicons.js";
import { Player } from "./vidplay.js";
import {
  AUDIO_TRANSITIONS, BLENDS, EFFECTS, FONTS, PRESETS, RATES, TRANSITIONS, clamp, dbToLin, defaultTitle, layout,
  parseTc, propAt, renderTitle, tc, uid, validateTransitions,
} from "./vidmodel.js";
import { LOCALE } from "./i18n.js";

const RULER = 26;
const HEAD_W = 172;
const KIND_COLOR = { video: "#7d73c4", audio: "#4f9b5c", image: "#a86bb8", title: "#c46a8f", color: "#7f8a92" };
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "tif", "tiff", "avif", "heic", "heif", "psd", "ico", "svg"]);
const TOOLS = [
  ["select", "Strumento Selezione", "V"], ["trackfwd", "Strumento Selezione traccia in avanti", "A"], ["ripple", "Strumento Modifica con ripple", "B"],
  ["rolling", "Strumento Modifica con rullo", "N"], ["rate", "Strumento Allungamento velocita'", "R"], ["razor", "Strumento Lama di rasoio", "C"],
  ["slip", "Strumento Slittamento", "Y"], ["slide", "Strumento Scorrimento", "U"], ["pen", "Strumento Penna (fotogrammi chiave)", "P"],
  ["hand", "Strumento Mano", "H"], ["zoom", "Strumento Zoom", "Z"], ["type", "Strumento Testo", "T"],
];
const EPS = 1e-6;

export function createVideoEditor(ctx, P, opts = {}) {
  loadCss("css/videdit.css");
  // ------------------------------------------------------------------ stato
  let fps = P.settings.fps;
  const fr = () => 1 / fps;
  const snapF = t => Math.round(t * fps) / fps;
  let sel = new Set(), selTr = null, selGap = null, selKf = null;
  let tool = "select", snapOn = true, linkedSel = true;
  let focus = "program"; // monitor che riceve Spazio, J/K/L, I/O
  let pps = 60, scrollT = 0, scrollY = 0;
  let clipboard = null;
  let history = [], hi = -1;
  const wave = new Map(), thumbs = new Map();
  P.srcV = P.srcV || "V1"; P.srcA = P.srcA || "A1";
  const src = { m: null, in: null, out: null };

  // ------------------------------------------------------------------ interfaccia
  ctx.el.innerHTML = "";
  ctx.fillBody(true);
  const root = el("div", { class: "ve-root", tabindex: "-1" });
  ctx.el.append(root);
  const tabsUL = el("div", { class: "ve-ptabs" }), bodyUL = el("div", { class: "ve-pbody" });
  const panelUL = el("section", { class: "ve-panel ve-ul" }, tabsUL, bodyUL);
  const splitV = el("div", { class: "ve-split-v", title: "Trascina per ridimensionare" });
  const prog = el("section", { class: "ve-panel ve-prog" });
  const splitH = el("div", { class: "ve-split-h", title: "Trascina per ridimensionare" });
  const lower = el("div", { class: "ve-lower" });
  root.append(panelUL, splitV, prog, splitH, lower);
  const tabsLL = el("div", { class: "ve-ptabs" }), bodyLL = el("div", { class: "ve-pbody" });
  const panelLL = el("section", { class: "ve-panel ve-ll" }, tabsLL, bodyLL);
  const toolsBar = el("div", { class: "ve-tools" });
  const tlPanel = el("section", { class: "ve-panel ve-tl" });
  const meterBox = el("div", { class: "ve-meters" });
  lower.append(panelLL, toolsBar, tlPanel, meterBox);

  for (const [bar, key, def] of [[splitV, "--ve-left", 0.42], [splitH, "--ve-top", 0.5]]) {
    root.style.setProperty(key, def * 100 + "%");
    bar.addEventListener("pointerdown", e => {
      bar.setPointerCapture(e.pointerId);
      const r = root.getBoundingClientRect();
      const mv = ev => { const f = key === "--ve-left" ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height; root.style.setProperty(key, clamp(f, 0.15, 0.85) * 100 + "%"); fitMonitor(); drawTL(); };
      const up = () => { bar.removeEventListener("pointermove", mv); bar.removeEventListener("pointerup", up); };
      bar.addEventListener("pointermove", mv); bar.addEventListener("pointerup", up);
    });
  }
  // gruppi di pannelli a schede (come i gruppi di pannelli di Premiere)
  function tabGroup(tabsEl, bodyEl, defs) {
    const g = { cur: null, show(id) { g.cur = id; for (const d of defs) { d.tab.classList.toggle("on", d.id === id); d.body.hidden = d.id !== id; } defs.find(d => d.id === id)?.onShow?.(); } };
    for (const d of defs) {
      d.tab = el("button", { class: "ve-ptab", type: "button", onclick: () => g.show(d.id) }, d.name);
      d.body = el("div", { class: "ve-pcontent " + (d.cls || "") });
      tabsEl.append(d.tab); bodyEl.append(d.body);
    }
    g.defs = defs;
    g.body = id => defs.find(d => d.id === id).body;
    return g;
  }
  const UL = tabGroup(tabsUL, bodyUL, [{ id: "source", name: "Sorgente", cls: "ve-src" }, { id: "ec", name: "Controlli effetti", cls: "ve-ec", onShow: () => renderEC() }, { id: "mixer", name: "Mixer tracce audio", cls: "ve-mixer", onShow: () => renderMixer() }]);
  const LL = tabGroup(tabsLL, bodyLL, [{ id: "project", name: "Progetto", cls: "ve-proj" }, { id: "effects", name: "Effetti", cls: "ve-fxlib" }]);

  // ------------------------------------------------------------------ cronologia
  const snapState = () => JSON.stringify({ settings: P.settings, media: P.media, tracks: P.tracks, clips: P.clips, transitions: P.transitions, markers: P.markers, inPoint: P.inPoint, outPoint: P.outPoint, srcV: P.srcV, srcA: P.srcA });
  function commit(label) {
    validateTransitions(P);
    history = history.slice(0, hi + 1);
    history.push({ label, s: snapState() });
    if (history.length > 120) history.shift();
    hi = history.length - 1;
    if (label) ctx.setDirty(true);
    refresh();
  }
  function restore(s) {
    const o = JSON.parse(s);
    Object.assign(P, o);
    fps = P.settings.fps;
    sel = new Set([...sel].filter(id => P.clips.some(c => c.id === id)));
    selTr = null; selGap = null; selKf = null;
    ctx.setDirty(true);
    refresh();
  }
  const undo = () => { if (hi > 0) { const l = history[hi].label; hi--; restore(history[hi].s); ctx.status("Annullato: " + l); } };
  const redo = () => { if (hi < history.length - 1) { hi++; restore(history[hi].s); ctx.status("Ripetuto: " + history[hi].label); } };

  // ------------------------------------------------------------------ utilita' del modello
  const byId = id => P.clips.find(c => c.id === id);
  const mediaOf = c => P.media.find(m => m.id === c?.media);
  const allTracks = () => [...P.tracks.v, ...P.tracks.a];
  const trackOf = id => allTracks().find(t => t.id === id);
  const isA = id => id?.[0] === "A";
  const clipsOn = tid => P.clips.filter(c => c.track === tid).sort((a, b) => a.start - b.start);
  const end = c => c.start + c.dur;
  const total = () => Math.max(0, ...P.clips.map(end));
  const partners = c => (c.link ? P.clips.filter(x => x.link === c.link && x !== c) : []);
  const withLinked = ids => { const s = new Set(ids); if (linkedSel) for (const id of ids) { const c = byId(id); if (c) partners(c).forEach(p => s.add(p.id)); } return s; };
  const maxSrc = c => { const m = mediaOf(c); return c.kind === "video" || c.kind === "audio" ? (m?.dur ?? Infinity) : Infinity; };
  const locked = tid => !!trackOf(tid)?.lock;
  function shiftKf(c, d) { if (!c.kf) return; for (const k of Object.keys(c.kf)) c.kf[k] = c.kf[k].map(([t, v]) => [t - d, v]); }
  function removeClip(c) {
    P.clips = P.clips.filter(x => x !== c);
    P.transitions = P.transitions.filter(t => t.a !== c.id && t.b !== c.id);
    sel.delete(c.id);
  }
  // divide la clip al tempo t: restituisce la parte destra (nuova clip)
  function splitClip(c, t, linkKey) {
    if (t <= c.start + EPS || t >= end(c) - EPS) return null;
    const r = structuredClone(c);
    r.id = uid("c");
    const d = t - c.start;
    r.start = t; r.dur = end(c) - t; r.in = (c.in || 0) + d * (c.speed || 1);
    shiftKf(r, d);
    c.dur = d;
    r.link = c.link ? (linkKey || c.link + "_" + Math.round(t * 1000)) : null;
    for (const tr of P.transitions) if (tr.a === c.id) tr.a = r.id;
    P.clips.push(r);
    return r;
  }
  // libera l'intervallo [a,b] su una traccia (sovrascrittura)
  function liftRange(tid, a, b, except = new Set()) {
    for (const c of clipsOn(tid)) {
      if (except.has(c.id)) continue;
      const e = end(c);
      if (e <= a + EPS || c.start >= b - EPS) continue;
      if (c.start >= a - EPS && e <= b + EPS) removeClip(c);
      else if (c.start < a && e > b) { splitClip(c, b); c.dur = a - c.start; }
      else if (c.start < a) c.dur = a - c.start;
      else { const d = b - c.start; c.in = (c.in || 0) + d * (c.speed || 1); c.start = b; c.dur -= d; shiftKf(c, d); }
    }
  }
  function insertSpace(t, d, tracks, except = new Set()) {
    for (const tid of tracks) {
      for (const c of clipsOn(tid)) if (!except.has(c.id) && c.start < t - EPS && end(c) > t + EPS) splitClip(c, t);
      for (const c of clipsOn(tid)) if (!except.has(c.id) && c.start >= t - EPS) c.start += d;
    }
  }
  const unlockedTracks = () => allTracks().filter(t => !t.lock).map(t => t.id);
  // tracce che possono scorrere senza rompere clip a cavallo (come il blocco di sincronizzazione di Premiere)
  const syncTracks = (a, b, base) => unlockedTracks().filter(tid => base.includes(tid) || !clipsOn(tid).some(c => c.start < b - EPS && end(c) > a + EPS && !(c.start >= a - EPS)));
  function closeRange(a, b, tracks) {
    const d = b - a;
    for (const tid of tracks) for (const c of clipsOn(tid)) if (c.start >= b - EPS) c.start -= d;
    for (const m of P.markers) if (m.t >= b) m.t -= d;
  }
  function extractRange(a, b, tracks) { for (const tid of tracks) liftRange(tid, a, b); closeRange(a, b, tracks); }

  // ------------------------------------------------------------------ media (pannello Progetto)
  async function probe(path) {
    try { return await api("video_info", { path }); } catch {
      // web app: metadati dal motore del browser
      const ext = extOf(path);
      if (IMAGE_EXT.has(ext)) return await new Promise(res => { const i = new Image(); i.onload = () => res({ video: true, still: true, w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => res({}); i.src = fileUrl(path); });
      return await new Promise(res => { const v = document.createElement("video"); v.preload = "metadata"; v.onloadedmetadata = () => res({ dur: v.duration, w: v.videoWidth || null, h: v.videoHeight || null, video: v.videoWidth > 0, audio: true, fps: 30 }); v.onerror = () => res({}); v.src = fileUrl(path); });
    }
  }
  async function importPaths(paths, silent = false) {
    const added = [];
    for (const path of paths) {
      const ex = P.media.find(m => m.path === path);
      if (ex) { added.push(ex); continue; }
      const i = await probe(path);
      const ext = extOf(path);
      const kind = i.still || (IMAGE_EXT.has(ext) && !i.dur) ? "image" : i.video ? "video" : i.audio ? "audio" : null;
      if (!kind) { toast(`"${baseName(path)}" non contiene audio o video utilizzabili`, true); continue; }
      const m = { id: uid("m"), path, name: baseName(path), kind, dur: kind === "image" ? null : i.dur, w: i.w, h: i.h, fps: i.fps, audio: kind !== "image" && !!i.audio };
      P.media.push(m);
      added.push(m);
      loadMeta(m);
    }
    if (added.length && !silent) commit("Importa");
    renderProject();
    return added;
  }
  function loadMeta(m) {
    if (WEB || m.offline) return;
    if (m.audio && !wave.has(m.id)) { wave.set(m.id, null); api("video_waveform", { path: m.path, rate: 100 }).then(r => { wave.set(m.id, r); drawTL(); }).catch(() => { }); }
    if (m.kind === "video" && !thumbs.has(m.id)) {
      thumbs.set(m.id, null);
      api("video_thumbs", { path: m.path, h: 54 }).then(j => waitJob(j.job)).then(r => {
        const img = new Image();
        img.onload = () => { thumbs.set(m.id, { ...r, img }); drawTL(); renderProject(); };
        img.src = fileUrl(r.path);
      }).catch(() => { });
    }
  }
  async function doImport() {
    const ps = await pickFiles();
    if (ps?.length) await importPaths(ps);
  }

  // ------------------------------------------------------------------ monitor programma
  const progCanvas = el("canvas", { class: "ve-canvas" });
  const progOverlay = el("div", { class: "ve-overlay" });
  const progStage = el("div", { class: "ve-stage" }, progCanvas, progOverlay);
  const progTc = el("span", { class: "ve-tc ve-tc-main", title: "Posizione della testina (clic per digitare un timecode)" });
  const progDur = el("span", { class: "ve-tc ve-tc-dur", title: "Durata della sequenza (o da attacco a stacco)" });
  const resSel = el("select", { class: "ve-sel", id: "ve-res-" + ctx.tab.name, title: "Risoluzione di riproduzione", onchange: () => { player.q = +resSel.value; player.dirty = true; player.idle(); } },
    ...[[1, "Intera"], [0.5, "1/2"], [0.25, "1/4"]].map(([v, n]) => el("option", { value: v }, n)));
  const zoomSel = el("select", { class: "ve-sel", id: "ve-zoom-" + ctx.tab.name, title: "Zoom del monitor", onchange: () => fitMonitor() },
    ...[["fit", "Adatta"], [0.25, "25%"], [0.5, "50%"], [1, "100%"]].map(([v, n]) => el("option", { value: v }, n)));
  const tbtn = (icon, title, fn, cls = "") => { const b = el("button", { class: "ve-tbtn " + cls, type: "button", title, onclick: fn }); b.innerHTML = vIcon(icon); return b; };
  const playBtn = tbtn("play", "Riproduci/Interrompi (Spazio)", () => { focus = "program"; togglePlay(); }, "ve-play");
  prog.append(el("div", { class: "ve-ptabs" }, el("span", { class: "ve-ptab on" }, "Programma: sequenza")), progStage,
    el("div", { class: "ve-mbar" }, progTc, el("span", { class: "grow" }), zoomSel, resSel, el("span", { class: "grow" }), progDur),
    el("div", { class: "ve-transport" },
      tbtn("marker", "Aggiungi marcatore (M)", () => addMarker()), tbtn("markIn", "Contrassegna attacco (I)", () => markIn()), tbtn("markOut", "Contrassegna stacco (O)", () => markOut()),
      el("span", { class: "ve-tsep" }),
      tbtn("goIn", "Vai ad attacco (Maiusc+I)", () => goto(P.inPoint ?? 0)), tbtn("stepBack", "Indietro di un fotogramma (Freccia sinistra)", () => step(-1)), playBtn,
      tbtn("stepFwd", "Avanti di un fotogramma (Freccia destra)", () => step(1)), tbtn("goOut", "Vai a stacco (Maiusc+O)", () => goto(P.outPoint ?? total())),
      el("span", { class: "ve-tsep" }),
      tbtn("lift", "Solleva (;)", () => liftInOut()), tbtn("extract", "Estrai (')", () => extractInOut()), tbtn("camera", "Esporta fotogramma (Ctrl+Maiusc+E)", () => exportFrame())));
  progStage.addEventListener("pointerdown", () => { focus = "program"; });
  progTc.addEventListener("click", async () => { const v = await askText("Vai al timecode", "Timecode (hh:mm:ss:ff)", tc(player.t, fps)); const t = v && parseTc(v, fps); if (t !== null && t !== undefined && !isNaN(t)) goto(t); });

  let player;
  try {
    player = new Player(() => P, progCanvas, {
      onTime: (t, stopped) => { P.playhead = t; showTime(); followPlayhead(); if (stopped) { playBtn.innerHTML = vIcon("play"); drawOverlay(); } },
      onMeter: v => drawMeters(v),
      end: () => (P.outPoint !== null && P.outPoint !== undefined && player.t < P.outPoint ? P.outPoint : total()),
      onBusy: m => ctx.status(`Conformazione di ${m.name} per l'anteprima...`),
      onProgress: (m, p) => ctx.status(`Conformazione di ${m.name}: ${Math.round(p * 100)}%`),
      onReady: () => { status(); drawTL(); },
      onError: (m, e) => toast(`${m.name}: ${e.message}`, true, 6000),
    });
  } catch (e) {
    ctx.el.innerHTML = "";
    throw e;
  }
  player.q = P.settings.w > 1920 ? 0.5 : 1;
  resSel.value = player.q;
  player.t = P.playhead || 0;

  function fitMonitor() {
    const r = progStage.getBoundingClientRect();
    const { w: W, h: H } = P.settings;
    const z = zoomSel.value === "fit" ? Math.min((r.width - 8) / W, (r.height - 8) / H) : +zoomSel.value;
    progCanvas.style.width = W * z + "px";
    progCanvas.style.height = H * z + "px";
    drawMonitorOverlay();
  }
  function showTime() {
    progTc.textContent = tc(player.t, fps);
    const hasIO = P.inPoint !== null && P.inPoint !== undefined && P.outPoint !== null && P.outPoint !== undefined;
    progDur.textContent = tc(hasIO ? P.outPoint - P.inPoint : total(), fps);
    tlTc.textContent = tc(player.t, fps);
    drawOverlay();
    if (!player.playing) { drawMonitorOverlay(); if (UL.cur === "ec") updateECValues(); }
  }
  function goto(t) {
    t = Math.max(0, snapF(t));
    P.playhead = t;
    player.seek(t);
    showTime();
    followPlayhead(true);
  }
  const step = n => { if (player.playing) stopPlay(); goto(player.t + n * fr()); };
  function togglePlay() {
    if (focus === "source") return toggleSource();
    if (player.playing) stopPlay();
    else { if (player.t >= total() - fr() / 2) goto(0); player.play(1); playBtn.innerHTML = vIcon("pause"); }
  }
  function stopPlay() { player.stop(); playBtn.innerHTML = vIcon("play"); goto(player.t); }
  let shuttle = 0;
  function jkl(k) {
    if (focus === "source") return srcJKL(k);
    if (k === "K") { shuttle = 0; if (player.playing) stopPlay(); return; }
    const dir = k === "L" ? 1 : -1;
    shuttle = Math.sign(shuttle) === dir ? clamp(shuttle * 2, -8, 8) : dir;
    player.play(shuttle);
    playBtn.innerHTML = vIcon("pause");
    ctx.status(`Riproduzione ${shuttle > 0 ? "avanti" : "indietro"} ${Math.abs(shuttle)}×`);
  }

  // riquadro di trasformazione sul monitor (doppio clic su una clip in Premiere: qui basta selezionarla)
  function monitorClip() {
    if (sel.size !== 1) return null;
    const c = byId([...sel][0]);
    if (!c || c.kind === "audio" || player.t < c.start || player.t >= end(c)) return null;
    return c;
  }
  function clipBox(c) {
    const { w: W, h: H } = P.settings;
    const tau = player.t - c.start;
    let sw, sh;
    if (c.kind === "title") { const cv = renderTitle(c.title); sw = cv.width; sh = cv.height; }
    else if (c.kind === "color") { sw = W; sh = H; }
    else { const m = mediaOf(c); sw = m?.w || W; sh = m?.h || H; }
    const f = c.kind === "title" ? 1 : Math.min(W / sw, H / sh);
    const S = propAt(c, "scale", tau) ?? 100;
    return { x: propAt(c, "x", tau) ?? W / 2, y: propAt(c, "y", tau) ?? H / 2, w: sw * f * S / 100, h: sh * f * S / 100, rot: (propAt(c, "rot", tau) || 0) * Math.PI / 180, S };
  }
  function drawMonitorOverlay() {
    progOverlay.innerHTML = "";
    const c = monitorClip();
    const cr = progCanvas.getBoundingClientRect(), sr = progStage.getBoundingClientRect();
    progOverlay.style.left = cr.left - sr.left + "px"; progOverlay.style.top = cr.top - sr.top + "px";
    progOverlay.style.width = cr.width + "px"; progOverlay.style.height = cr.height + "px";
    if (!c || player.playing || !cr.width) return;
    const k = cr.width / P.settings.w;
    const b = clipBox(c);
    const cs = Math.cos(b.rot), sn = Math.sin(b.rot);
    const pt = (dx, dy) => [(b.x + dx * cs - dy * sn) * k, (b.y + dx * sn + dy * cs) * k];
    const pts = [pt(-b.w / 2, -b.h / 2), pt(b.w / 2, -b.h / 2), pt(b.w / 2, b.h / 2), pt(-b.w / 2, b.h / 2)];
    const rotH = pt(0, -b.h / 2 - 28 / k), topM = pt(0, -b.h / 2);
    progOverlay.innerHTML = `<svg width="${cr.width}" height="${cr.height}"><polygon points="${pts.map(p => p.join(",")).join(" ")}" class="ve-box"/>
      <line x1="${topM[0]}" y1="${topM[1]}" x2="${rotH[0]}" y2="${rotH[1]}" class="ve-box"/><circle cx="${rotH[0]}" cy="${rotH[1]}" r="5" class="ve-hrot" data-h="rot"/>
      ${pts.map((p, i) => `<rect x="${p[0] - 4}" y="${p[1] - 4}" width="8" height="8" class="ve-handle" data-h="s${i}"/>`).join("")}
      <circle cx="${b.x * k}" cy="${b.y * k}" r="4" class="ve-anchor"/></svg>`;
  }
  progStage.addEventListener("pointerdown", e => {
    const cr = progCanvas.getBoundingClientRect();
    const k = cr.width / P.settings.w;
    const px = (e.clientX - cr.left) / k, py = (e.clientY - cr.top) / k;
    if (tool === "type") { e.preventDefault(); newTitle(px, py); return; }
    const c = monitorClip();
    if (!c || player.playing) {
      // clic sul monitor: seleziona la clip visibile piu' in alto sotto il puntatore
      const hit = [...P.tracks.v].reverse().map(t => P.clips.find(x => x.track === t.id && !x.off && !t.hide && x.kind !== "audio" && player.t >= x.start && player.t < end(x))).find(x => {
        if (!x) return false;
        const b = clipBox(x), dx = px - b.x, dy = py - b.y, u = dx * Math.cos(-b.rot) - dy * Math.sin(-b.rot), v = dx * Math.sin(-b.rot) + dy * Math.cos(-b.rot);
        return Math.abs(u) <= b.w / 2 && Math.abs(v) <= b.h / 2;
      });
      if (hit) { sel = withLinked([hit.id]); selTr = null; refreshSel(); }
      return;
    }
    const h = e.target.dataset?.h;
    const b = clipBox(c);
    const st = { x: b.x, y: b.y, S: b.S, rot: b.rot, d0: Math.hypot(px - b.x, py - b.y) || 1, a0: Math.atan2(py - b.y, px - b.x), px, py };
    const inside = (() => { const dx = px - b.x, dy = py - b.y, u = dx * Math.cos(-b.rot) - dy * Math.sin(-b.rot), v = dx * Math.sin(-b.rot) + dy * Math.cos(-b.rot); return Math.abs(u) <= b.w / 2 && Math.abs(v) <= b.h / 2; })();
    if (!h && !inside) return;
    e.preventDefault();
    progStage.setPointerCapture(e.pointerId);
    const mv = ev => {
      const qx = (ev.clientX - cr.left) / k, qy = (ev.clientY - cr.top) / k;
      if (h === "rot") { let a = Math.atan2(qy - st.y, qx - st.x) * 180 / Math.PI + 90; if (ev.shiftKey) a = Math.round(a / 15) * 15; setProp(c, "rot", Math.round(a * 10) / 10); }
      else if (h) setProp(c, "scale", Math.max(1, Math.round(st.S * Math.hypot(qx - st.x, qy - st.y) / st.d0 * 10) / 10));
      else { let dx = qx - st.px, dy = qy - st.py; if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; } setProp(c, "x", Math.round(st.x + dx)); setProp(c, "y", Math.round(st.y + dy)); }
      player.dirty = true; player.idle(); drawMonitorOverlay(); updateECValues();
    };
    const up = () => { progStage.removeEventListener("pointermove", mv); progStage.removeEventListener("pointerup", up); commit(h === "rot" ? "Rotazione" : h ? "Scala" : "Posizione"); };
    progStage.addEventListener("pointermove", mv); progStage.addEventListener("pointerup", up);
  });

  // valore di una proprieta' animabile: con fotogrammi chiave si crea/aggiorna quello alla testina
  function setProp(c, prop, v) {
    const keys = c.kf?.[prop];
    if (keys && keys.length) {
      const tau = clamp(snapF(player.t - c.start), 0, c.dur);
      const i = keys.findIndex(k => Math.abs(k[0] - tau) < fr() / 2);
      if (i >= 0) keys[i][1] = v; else { keys.push([tau, v]); keys.sort((a, b) => a[0] - b[0]); }
    } else if (["x", "y", "scale", "rot"].includes(prop)) { c.motion = c.motion || defMotion(c); c.motion[prop] = v; }
    else c[prop] = v;
  }
  const defMotion = () => ({ x: P.settings.w / 2, y: P.settings.h / 2, scale: 100, rot: 0 });

  // ------------------------------------------------------------------ monitor sorgente
  const srcVideo = el("video", { class: "ve-srcmedia", preload: "auto", playsinline: true, hidden: true });
  const srcImg = el("img", { class: "ve-srcmedia", hidden: true });
  const srcWave = el("canvas", { class: "ve-srcwave", hidden: true });
  const srcEmpty = el("div", { class: "ve-empty" }, "Fai doppio clic su un elemento del pannello Progetto per aprirlo nel monitor Sorgente");
  const srcStage = el("div", { class: "ve-stage" }, srcVideo, srcImg, srcWave, srcEmpty);
  const srcBar = el("canvas", { class: "ve-srcbar", title: "Clic o trascina per scorrere; I e O impostano attacco e stacco" });
  const srcTc = el("span", { class: "ve-tc ve-tc-main" }), srcDur = el("span", { class: "ve-tc ve-tc-dur" });
  const srcName = el("span", { class: "ve-srcname" });
  const srcPlay = tbtn("play", "Riproduci/Interrompi (Spazio)", () => { focus = "source"; toggleSource(); }, "ve-play");
  const dragBtn = el("button", { class: "ve-tbtn ve-dragsrc", type: "button", title: "Trascina nella timeline (video e audio)" });
  dragBtn.innerHTML = vIcon("film") + vIcon("audio");
  UL.body("source").append(el("div", { class: "ve-srchead" }, srcName), srcStage, srcBar,
    el("div", { class: "ve-mbar" }, srcTc, el("span", { class: "grow" }), dragBtn, el("span", { class: "grow" }), srcDur),
    el("div", { class: "ve-transport" },
      tbtn("markIn", "Contrassegna attacco (I)", () => { focus = "source"; srcMark("in"); }), tbtn("markOut", "Contrassegna stacco (O)", () => { focus = "source"; srcMark("out"); }),
      el("span", { class: "ve-tsep" }),
      tbtn("goIn", "Vai ad attacco (Maiusc+I)", () => srcSeek(src.in ?? 0)), tbtn("stepBack", "Indietro di un fotogramma", () => srcSeek(srcVideo.currentTime - fr())), srcPlay,
      tbtn("stepFwd", "Avanti di un fotogramma", () => srcSeek(srcVideo.currentTime + fr())), tbtn("goOut", "Vai a stacco (Maiusc+O)", () => srcSeek(src.out ?? srcLen())),
      el("span", { class: "ve-tsep" }),
      tbtn("insert", "Inserisci (,)", () => fromSource(true)), tbtn("overwrite", "Sovrascrivi (.)", () => fromSource(false))));
  UL.body("source").addEventListener("pointerdown", () => { focus = "source"; });
  const srcLen = () => (src.m?.kind === "image" ? 5 : src.m?.dur || srcVideo.duration || 0);
  async function openSource(m) {
    src.m = m; src.in = null; src.out = null;
    UL.show("source");
    focus = "source";
    srcName.textContent = m.name;
    srcEmpty.hidden = true;
    srcImg.hidden = m.kind !== "image";
    srcVideo.hidden = m.kind !== "video";
    srcWave.hidden = m.kind !== "audio";
    srcVideo.pause();
    const url = await player._resolve(m).catch(e => { toast(e.message, true); return null; });
    if (!url || src.m !== m) return;
    if (m.kind === "image") srcImg.src = url;
    else { srcVideo.src = url; srcVideo.currentTime = 0; }
    drawSrc();
  }
  function srcSeek(t) { if (!src.m || src.m.kind === "image") return; srcVideo.currentTime = clamp(t, 0, srcLen()); drawSrc(); }
  function toggleSource() {
    if (!src.m || src.m.kind === "image") return;
    if (srcVideo.paused) { srcVideo.playbackRate = 1; srcVideo.play(); srcPlay.innerHTML = vIcon("pause"); } else { srcVideo.pause(); srcPlay.innerHTML = vIcon("play"); }
  }
  let srcShuttle = 0, srcRev = 0;
  function srcJKL(k) {
    if (!src.m || src.m.kind === "image") return;
    clearInterval(srcRev);
    if (k === "K") { srcShuttle = 0; srcVideo.pause(); srcPlay.innerHTML = vIcon("play"); return; }
    const dir = k === "L" ? 1 : -1;
    srcShuttle = Math.sign(srcShuttle) === dir ? clamp(srcShuttle * 2, -8, 8) : dir;
    if (srcShuttle > 0) { srcVideo.playbackRate = srcShuttle; srcVideo.play(); }
    else { srcVideo.pause(); srcRev = setInterval(() => { if (srcVideo.currentTime <= 0) clearInterval(srcRev); srcVideo.currentTime = Math.max(0, srcVideo.currentTime + srcShuttle * 0.1); }, 100); }
    srcPlay.innerHTML = vIcon("pause");
  }
  function srcMark(which) {
    if (!src.m) return;
    const t = src.m.kind === "image" ? 0 : snapF(srcVideo.currentTime);
    if (which === "in") { src.in = t; if (src.out !== null && src.out <= t) src.out = null; } else { src.out = t; if (src.in !== null && src.in >= t) src.in = null; }
    drawSrc();
  }
  srcVideo.addEventListener("timeupdate", () => drawSrc());
  srcVideo.addEventListener("ended", () => { srcPlay.innerHTML = vIcon("play"); });
  function drawSrc() {
    const len = srcLen();
    srcTc.textContent = tc(src.m?.kind === "image" ? 0 : srcVideo.currentTime || 0, fps);
    srcDur.textContent = tc((src.out ?? len) - (src.in ?? 0), fps);
    const W = srcBar.clientWidth, H = srcBar.clientHeight;
    if (!W) return;
    srcBar.width = W * devicePixelRatio; srcBar.height = H * devicePixelRatio;
    const g = srcBar.getContext("2d");
    g.scale(devicePixelRatio, devicePixelRatio);
    g.fillStyle = "#1b1c1e"; g.fillRect(0, 0, W, H);
    if (!len) return;
    const x = t => t / len * W;
    if (src.in !== null || src.out !== null) { g.fillStyle = "rgba(120,150,190,.35)"; g.fillRect(x(src.in ?? 0), 0, x(src.out ?? len) - x(src.in ?? 0), H); }
    g.fillStyle = "#2d8ceb"; g.fillRect(x(srcVideo.currentTime || 0) - 1, 0, 2, H);
    if (src.m?.kind === "audio") {
      const wv = wave.get(src.m.id);
      const cw = srcWave.clientWidth, ch = srcWave.clientHeight;
      if (wv && cw) {
        srcWave.width = cw; srcWave.height = ch;
        const gg = srcWave.getContext("2d");
        gg.fillStyle = "#111"; gg.fillRect(0, 0, cw, ch);
        gg.fillStyle = "#6fcf7f";
        for (let i = 0; i < cw; i++) {
          const a = Math.floor(i / cw * wv.peaks.length), b2 = Math.max(a + 1, Math.floor((i + 1) / cw * wv.peaks.length));
          let mx = 0; for (let j = a; j < b2; j++) mx = Math.max(mx, wv.peaks[j] || 0);
          gg.fillRect(i, ch / 2 - mx * ch / 2, 1, Math.max(1, mx * ch));
        }
        gg.fillStyle = "#2d8ceb"; gg.fillRect((srcVideo.currentTime || 0) / len * cw, 0, 2, ch);
      }
    }
  }
  srcBar.addEventListener("pointerdown", e => {
    focus = "source";
    srcBar.setPointerCapture(e.pointerId);
    const mv = ev => { const r = srcBar.getBoundingClientRect(); srcSeek((ev.clientX - r.left) / r.width * srcLen()); };
    mv(e);
    const up = () => { srcBar.removeEventListener("pointermove", mv); srcBar.removeEventListener("pointerup", up); };
    srcBar.addEventListener("pointermove", mv); srcBar.addEventListener("pointerup", up);
  });
  srcWave.addEventListener("pointerdown", e => { const r = srcWave.getBoundingClientRect(); srcSeek((e.clientX - r.left) / r.width * srcLen()); });
  // inserisci / sovrascrivi alla testina sulle tracce di destinazione (V1/A1 evidenziate nelle intestazioni)
  function fromSource(insert) {
    if (!src.m) return toast("Apri prima un elemento nel monitor Sorgente", true);
    const a = src.in ?? 0, b = src.out ?? srcLen();
    placeMedia(src.m, player.t, P.srcV, P.srcA, insert, { in: a, dur: b - a });
    goto(player.t + (b - a));
  }
  dragBtn.addEventListener("pointerdown", e => { if (src.m) startMediaDrag(e, src.m, { in: src.in ?? 0, dur: (src.out ?? srcLen()) - (src.in ?? 0) }); });

  // ------------------------------------------------------------------ pannello Progetto
  let projView = "icons";
  const projList = el("div", { class: "ve-projlist" });
  const projBar = el("div", { class: "ve-pfoot" },
    tbtn("list", "Vista elenco", () => { projView = "list"; renderProject(); }), tbtn("icons", "Vista icone", () => { projView = "icons"; renderProject(); }),
    el("span", { class: "grow" }),
    tbtn("import", "Importa... (Ctrl+I)", doImport), tbtn("newItem", "Nuovo elemento: titolo o colore", e => openMenuAt(e.currentTarget, [
      { label: "Titolo", keys: "Ctrl+T", run: () => newTitle() }, { label: "Colore a tinta unita...", run: () => newColor() }], "up")),
    tbtn("trash", "Elimina gli elementi selezionati (Canc)", () => deleteMedia()));
  const projSearch = el("input", { type: "search", class: "ve-search", id: "ve-psearch-" + ctx.tab.name, placeholder: "Cerca nel progetto", oninput: () => renderProject() });
  LL.body("project").append(el("div", { class: "ve-phead" }, el("span", { class: "ve-projname" }, ctx.name), projSearch), projList, projBar);
  let projSel = new Set();
  function renderProject() {
    projList.innerHTML = "";
    projList.className = "ve-projlist " + (projView === "list" ? "list" : "icons");
    const q = projSearch.value.trim().toLowerCase();
    const items = P.media.filter(m => !q || m.name.toLowerCase().includes(q));
    if (!items.length) projList.append(el("div", { class: "ve-empty" }, q ? "Nessun elemento corrisponde" : "Importa file multimediali: Ctrl+I, pulsante Importa o trascinali qui da Esplora risorse"));
    for (const m of items) {
      const th = thumbs.get(m.id);
      const pic = el("div", { class: "ve-ppic" });
      if (m.kind === "video" && th?.img) {
        const c = el("canvas", { width: th.tw, height: th.th });
        c.getContext("2d").drawImage(th.img, Math.min(th.count - 1, Math.floor(th.count / 3)) * th.tw, 0, th.tw, th.th, 0, 0, th.tw, th.th);
        pic.append(c);
      } else if (m.kind === "image" && !m.offline) pic.append(el("img", { src: fileUrl(m.path), loading: "lazy" }));
      else pic.innerHTML = vIcon(m.kind === "audio" ? "audio" : m.kind === "image" ? "image" : "film", 30);
      const used = P.clips.filter(c => c.media === m.id).length;
      const row = el("div", { class: "ve-pitem" + (projSel.has(m.id) ? " on" : "") + (m.offline ? " offline" : ""), title: m.path + (m.offline ? "\nSupporto non in linea: clic destro > Collega supporto" : "") },
        pic, el("span", { class: "ve-pname" }, m.name),
        el("span", { class: "ve-pmeta" }, (m.kind === "image" ? "Immagine" : tc(m.dur || 0, fps)) + (m.w ? ` · ${m.w}×${m.h}` : "") + (m.fps && m.kind === "video" ? ` · ${m.fps} fps` : "") + (used ? ` · usato ${used}×` : "")));
      row.addEventListener("pointerdown", e => {
        if (e.button === 2) return;
        if (e.ctrlKey) { projSel.has(m.id) ? projSel.delete(m.id) : projSel.add(m.id); } else if (!projSel.has(m.id)) projSel = new Set([m.id]);
        renderProject();
        startMediaDrag(e, m, null);
      });
      row.addEventListener("dblclick", () => openSource(m));
      row.addEventListener("contextmenu", e => { e.preventDefault(); projSel = new Set([m.id]); renderProject(); openMenuAt({ x: e.clientX, y: e.clientY }, [
        { label: "Apri nel monitor Sorgente", run: () => openSource(m) }, { label: "Aggiungi alla timeline (alla testina)", run: () => placeMedia(m, player.t, P.srcV, P.srcA, false) },
        { label: "Rinomina...", run: async () => { const n = await askText("Rinomina", "Nome", m.name); if (n) { m.name = n; commit("Rinomina"); } } },
        { label: "Collega supporto...", run: () => relink(m) }, "-", { label: "Elimina", run: () => deleteMedia() }]); });
      projList.append(row);
    }
  }
  async function deleteMedia() {
    const ids = [...projSel];
    if (!ids.length) return;
    const used = P.clips.filter(c => ids.includes(c.media));
    if (used.length && !(await confirmBox("Elimina dal progetto", `Gli elementi sono usati da ${used.length} clip nella timeline: verranno tolte anche quelle. Continuare?`, "Elimina", true))) return;
    used.forEach(removeClip);
    P.media = P.media.filter(m => !ids.includes(m.id));
    projSel.clear();
    commit("Elimina elementi");
  }
  async function relink(m) {
    const ps = await pickFiles();
    if (!ps?.length) return;
    m.path = ps[0]; m.name = baseName(ps[0]); delete m.offline;
    player.forget(m.id); wave.delete(m.id); thumbs.delete(m.id);
    loadMeta(m);
    commit("Collega supporto");
  }

  // trascinamento di un elemento (pannello Progetto o Sorgente) nella timeline
  let drop = null;
  function startMediaDrag(e, m, range) {
    const x0 = e.clientX, y0 = e.clientY;
    let ghost = null;
    const mv = ev => {
      if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      if (!ghost) { ghost = el("div", { class: "ve-ghost" }, m.name); document.body.append(ghost); }
      ghost.style.left = ev.clientX + 12 + "px"; ghost.style.top = ev.clientY + 8 + "px";
      const r = tlCanvas.getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top + RULER && ev.clientY <= r.bottom) {
        const row = rowAt(ev.clientY - r.top);
        let t = Math.max(0, xToT(ev.clientX - r.left));
        const dur = range ? range.dur : m.kind === "image" ? 5 : m.dur || 5;
        t = snapTime(t, null, [dur]).t;
        let vt = P.srcV, at = P.srcA;
        if (row) { if (row.type === "v") vt = row.tr.id; else at = row.tr.id; }
        drop = { t, vt: m.kind === "audio" ? null : vt, at: m.audio ? at : null, dur, insert: ev.ctrlKey };
      } else drop = null;
      drawOverlay();
    };
    const up = ev => {
      document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", up);
      ghost?.remove();
      if (drop) { const d = drop; drop = null; placeMedia(m, d.t, d.vt || P.srcV, d.at || P.srcA, ev.ctrlKey, range); }
      drawOverlay();
    };
    document.addEventListener("pointermove", mv); document.addEventListener("pointerup", up);
  }
  // mette un elemento in timeline: clip video (o immagine) + clip audio collegata
  async function placeMedia(m, t, vt, at, insert, range = null) {
    if (m.offline) return toast("Supporto non in linea: collegalo prima (clic destro > Collega supporto)", true);
    if (m.kind === "video" && !P.clips.some(c => c.kind === "video") && m.w && (m.w !== P.settings.w || m.h !== P.settings.h || (m.fps && Math.abs(m.fps - fps) > 0.01))) {
      const r = await modal("Avviso di mancata corrispondenza della clip", el("p", {}, `La clip (${m.w}×${m.h}, ${m.fps} fps) non corrisponde alle impostazioni della sequenza (${P.settings.w}×${P.settings.h}, ${fps} fps). Vuoi adattare la sequenza alla clip?`),
        [{ label: "Mantieni impostazioni attuali", value: "keep" }, { label: "Cambia impostazioni sequenza", value: "change", primary: true }]);
      if (r === "change") { P.settings.w = m.w; P.settings.h = m.h; if (m.fps) P.settings.fps = fps = nearestRate(m.fps); fitMonitor(); }
    }
    t = snapF(Math.max(0, t));
    const dur = snapF(range ? range.dur : m.kind === "image" ? 5 : m.dur || 5);
    const inP = range ? range.in : 0;
    const link = m.kind === "video" && m.audio ? uid("l") : null;
    const made = [];
    if (m.kind === "video" || m.kind === "image") {
      if (!P.tracks.v.some(x => x.id === vt)) vt = P.tracks.v[0].id;
      made.push({ id: uid("c"), kind: m.kind, track: vt, media: m.id, start: t, dur, in: inP, speed: 1, link, name: m.name, motion: defMotion(), opacity: 100, blend: "normal", fx: [], kf: {} });
    }
    if (m.audio && (m.kind === "audio" || m.kind === "video")) {
      if (!P.tracks.a.some(x => x.id === at)) at = P.tracks.a[0].id;
      made.push({ id: uid("c"), kind: "audio", track: at, media: m.id, start: t, dur, in: inP, speed: 1, link, name: m.name, volume: 0, gain: 0, fx: [], kf: {} });
    }
    const tracks = made.map(c => c.track);
    if (insert) insertSpace(t, dur, syncTracks(t, t + EPS, tracks));
    else for (const c of made) liftRange(c.track, t, t + dur);
    P.clips.push(...made);
    sel = new Set(made.map(c => c.id)); selTr = null;
    commit(insert ? "Inserisci" : "Sovrascrivi");
  }
  const nearestRate = f => RATES.reduce((b, r) => (Math.abs(r - f) < Math.abs(b - f) ? r : b), RATES[0]);

  function freeVideoTrack(a, b) {
    for (const t of [...P.tracks.v].reverse()) if (!t.lock && !clipsOn(t.id).some(c => c.start < b && end(c) > a)) {
      // la piu' in alto libera, purche' sopra tutte quelle occupate
      return t.id;
    }
    return addTrack("v");
  }
  function newTitle(x, y) {
    const t = snapF(player.t), d = 5;
    const top = [...P.tracks.v].reverse().find(tr => clipsOn(tr.id).some(c => c.start < t + d && end(c) > t));
    let tid = top ? P.tracks.v[P.tracks.v.indexOf(top) + 1]?.id : P.tracks.v[0].id;
    if (!tid || clipsOn(tid).some(c => c.start < t + d && end(c) > t)) tid = freeVideoTrack(t, t + d);
    const c = { id: uid("c"), kind: "title", track: tid, start: t, dur: d, in: 0, speed: 1, name: "Titolo", title: defaultTitle(),
      motion: { x: x ?? P.settings.w / 2, y: y ?? P.settings.h * 0.8, scale: 100, rot: 0 }, opacity: 100, blend: "normal", fx: [], kf: {} };
    c.title.size = Math.round(P.settings.h / 11);
    P.clips.push(c);
    sel = new Set([c.id]); selTr = null;
    commit("Nuovo titolo");
    UL.show("ec");
    setTimeout(() => { const ta = UL.body("ec").querySelector("textarea"); ta?.focus(); ta?.select(); }, 30);
    setTool("select");
  }
  async function newColor() {
    const inp = el("input", { type: "color", value: "#1a4f8c", id: "ve-newcolor" });
    const v = await modal("Colore a tinta unita", el("label", { style: { display: "flex", gap: "10px", alignItems: "center" } }, "Colore", inp), [{ label: "Annulla", value: null }, { label: "OK", primary: true, value: () => inp.value }]);
    if (!v) return;
    const t = snapF(player.t), tid = freeVideoTrack(t, t + 5);
    const c = { id: uid("c"), kind: "color", track: tid, start: t, dur: 5, in: 0, speed: 1, name: "Colore " + v, color: v, motion: defMotion(), opacity: 100, blend: "normal", fx: [], kf: {} };
    P.clips.push(c);
    sel = new Set([c.id]);
    commit("Colore a tinta unita");
  }

  // ------------------------------------------------------------------ pannello Effetti (libreria)
  const fxSearch = el("input", { type: "search", class: "ve-search", id: "ve-fxsearch-" + ctx.tab.name, placeholder: "Cerca effetti e transizioni", oninput: () => renderFxLib() });
  const fxTree = el("div", { class: "ve-fxtree" });
  LL.body("effects").append(el("div", { class: "ve-phead" }, fxSearch), fxTree);
  const fxOpen = new Set(["Effetti video", "Transizioni video", "Effetti audio", "Transizioni audio"]);
  function renderFxLib() {
    fxTree.innerHTML = "";
    const q = fxSearch.value.trim().toLowerCase();
    const sections = [
      ["Effetti video", Object.entries(EFFECTS).map(([k, e]) => ({ kind: "vfx", k, name: e.name, group: e.group }))],
      ["Transizioni video", Object.entries(TRANSITIONS).map(([k, e]) => ({ kind: "vtr", k, name: e.name, group: e.group }))],
      ["Effetti audio", [{ kind: "afx", k: "normalize", name: "Normalizza (picco a -1 dB)", group: "Ampiezza" }, { kind: "afx", k: "gain", name: "Guadagno audio...", group: "Ampiezza" }]],
      ["Transizioni audio", Object.entries(AUDIO_TRANSITIONS).map(([k, e]) => ({ kind: "atr", k, name: e.name, group: e.group }))],
    ];
    for (const [title, items] of sections) {
      const vis = items.filter(i => !q || i.name.toLowerCase().includes(q));
      if (!vis.length) continue;
      const open = q || fxOpen.has(title);
      fxTree.append(el("button", { class: "ve-fxsec", type: "button", onclick: () => { fxOpen.has(title) ? fxOpen.delete(title) : fxOpen.add(title); renderFxLib(); } }, (open ? "▾ " : "▸ ") + title));
      if (!open) continue;
      const groups = {};
      for (const i of vis) (groups[i.group] ||= []).push(i);
      for (const [gname, list] of Object.entries(groups)) {
        fxTree.append(el("div", { class: "ve-fxgrp" }, gname));
        for (const i of list) {
          const it = el("div", { class: "ve-fxitem", title: i.kind.endsWith("tr") ? "Trascina su un punto di modifica o su un'estremita' della clip; doppio clic = applica alla clip selezionata" : "Trascina sulla clip; doppio clic = applica alle clip selezionate" });
          it.innerHTML = vIcon(i.kind.endsWith("tr") ? "transition" : "fx", 16);
          it.append(el("span", {}, i.name));
          it.addEventListener("dblclick", () => applyLibItem(i, null));
          it.addEventListener("pointerdown", e => startFxDrag(e, i));
          fxTree.append(it);
        }
      }
    }
  }
  function startFxDrag(e, item) {
    const x0 = e.clientX, y0 = e.clientY;
    let ghost = null;
    const mv = ev => {
      if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      if (!ghost) { ghost = el("div", { class: "ve-ghost" }, item.name); document.body.append(ghost); }
      ghost.style.left = ev.clientX + 12 + "px"; ghost.style.top = ev.clientY + 8 + "px";
      const r = tlCanvas.getBoundingClientRect();
      const hit = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top ? hitClip(ev.clientX - r.left, ev.clientY - r.top) : null;
      drop = hit?.clip ? { fxTarget: hit.clip, side: xToT(ev.clientX - r.left) < hit.clip.start + hit.clip.dur / 2 ? "in" : "out" } : null;
      drawOverlay();
    };
    const up = () => {
      document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", up);
      ghost?.remove();
      if (drop?.fxTarget) applyLibItem(item, drop.fxTarget, drop.side);
      drop = null; drawOverlay();
    };
    document.addEventListener("pointermove", mv); document.addEventListener("pointerup", up);
  }
  function applyLibItem(i, clip, side) {
    const targets = clip ? [clip] : [...sel].map(byId).filter(Boolean);
    if (!targets.length) return toast("Seleziona prima una clip nella timeline", true);
    if (i.kind === "vfx") {
      const vt = targets.filter(c => c.kind !== "audio");
      if (!vt.length) return toast("Gli effetti video vanno su clip video, immagini, titoli o colori", true);
      for (const c of vt) { c.fx = c.fx || []; c.fx.push({ type: i.k, on: true, p: Object.fromEntries(EFFECTS[i.k].params.map(p => [p.k, p.d])) }); }
      sel = new Set(vt.map(c => c.id));
      commit("Applica " + i.name);
      UL.show("ec");
      if (i.k === "lut") pickLut(vt[0], vt[0].fx.length - 1);
    } else if (i.kind === "afx") {
      const at = targets.filter(c => c.kind === "audio");
      if (!at.length) return toast("Seleziona una clip audio", true);
      sel = new Set(at.map(c => c.id));
      if (i.k === "normalize") normalizeAudio(at, -1); else audioGainDialog();
    } else {
      const audio = i.kind === "atr";
      const ok = targets.filter(c => (c.kind === "audio") === audio);
      if (!ok.length) return toast(audio ? "Le transizioni audio vanno sulle clip audio" : "Le transizioni video vanno sulle clip video", true);
      for (const c of ok) addTransition(c, side || (clip ? "in" : nearSide(c)), i.k);
      commit("Applica " + i.name);
    }
  }
  const nearSide = c => (Math.abs(player.t - c.start) < Math.abs(player.t - end(c)) ? "in" : "out");
  function addTransition(c, side, type, dur = 1) {
    const prev = clipsOn(c.track).find(x => x !== c && Math.abs(end(x) - c.start) < fr() / 2);
    const next = clipsOn(c.track).find(x => x !== c && Math.abs(x.start - end(c)) < fr() / 2);
    let a = null, b = null;
    if (side === "in") { b = c.id; if (prev) a = prev.id; } else { a = c.id; if (next) b = next.id; }
    P.transitions = P.transitions.filter(t => !((a && t.a === a) || (b && t.b === b)));
    const d = snapF(Math.min(dur, c.dur, ...(a && b ? [byId(a).dur * 2, byId(b).dur * 2] : [])));
    const tr = { id: uid("t"), track: c.track, a, b, type, dur: Math.max(fr(), d) };
    P.transitions.push(tr);
    selTr = tr.id;
    return tr;
  }
  // Ctrl+D / Ctrl+Maiusc+D: transizione predefinita al punto di modifica piu' vicino alla testina sulle tracce di destinazione
  function defaultTransition(audio) {
    const tids = audio ? [P.srcA] : [P.srcV];
    let done = 0;
    const targets = sel.size ? [...sel].map(byId).filter(c => c && (c.kind === "audio") === audio) : null;
    if (targets?.length) { for (const c of targets) { addTransition(c, "in", audio ? "power" : "fade"); addTransition(c, "out", audio ? "power" : "fade"); done++; } }
    else for (const tid of tids) {
      const cs = clipsOn(tid);
      let best = null, bd = Infinity;
      for (const c of cs) for (const side of ["in", "out"]) { const t = side === "in" ? c.start : end(c); const d = Math.abs(t - player.t); if (d < bd) { bd = d; best = [c, side]; } }
      if (best) { addTransition(best[0], best[1], audio ? "power" : "fade"); done++; }
    }
    if (done) commit(audio ? "Applica transizione audio" : "Applica transizione video"); else toast("Nessuna clip sulle tracce di destinazione", true);
  }

  // ------------------------------------------------------------------ Controlli effetti
  const ecBox = UL.body("ec");
  const ecRefs = [];
  function scrub(get, set, o = {}) {
    // valore trascinabile (come i numeri blu di Premiere): trascina a destra/sinistra, clic per digitare
    const s = el("span", { class: "ve-scrub", tabindex: "0", title: "Trascina per cambiare, clic per digitare" + (o.title ? "\n" + o.title : "") });
    const fmt = v => (o.fmt ? o.fmt(v) : (Math.round(v * 100) / 100).toLocaleString(LOCALE)) + (o.unit || "");
    const show = () => { s.textContent = fmt(get()); };
    show();
    s.addEventListener("pointerdown", e => {
      if (o.disabled?.()) return;
      e.preventDefault();
      s.setPointerCapture(e.pointerId);
      const x0 = e.clientX, v0 = get();
      let moved = false;
      const mv = ev => {
        const dx = ev.clientX - x0;
        if (Math.abs(dx) > 2) moved = true;
        if (!moved) return;
        const v = clamp(v0 + dx * (o.step || 1) * (ev.shiftKey ? 10 : ev.ctrlKey ? 0.1 : 1), o.min ?? -Infinity, o.max ?? Infinity);
        set(Math.round(v / (o.step || 1)) * (o.step || 1), false);
        show();
      };
      const up = async () => {
        s.removeEventListener("pointermove", mv); s.removeEventListener("pointerup", up);
        if (moved) { set(get(), true); return; }
        const inp = el("input", { class: "ve-scrubin", value: o.fmt ? o.fmt(get()) : String(Math.round(get() * 1000) / 1000), id: "ve-scrubin" });
        s.replaceWith(inp); inp.focus(); inp.select();
        const finish = ok => { if (ok) { const v = o.parse ? o.parse(inp.value) : parseFloat(inp.value.replace(",", ".")); if (v !== null && !isNaN(v)) set(clamp(v, o.min ?? -Infinity, o.max ?? Infinity), true); } inp.replaceWith(s); show(); };
        inp.addEventListener("keydown", ev => { if (ev.key === "Enter") finish(true); if (ev.key === "Escape") finish(false); ev.stopPropagation(); });
        inp.addEventListener("blur", () => finish(true), { once: true });
      };
      s.addEventListener("pointermove", mv); s.addEventListener("pointerup", up);
    });
    ecRefs.push(show);
    return s;
  }
  const live = () => { player.dirty = true; player.idle(); drawMonitorOverlay(); drawTL(); };
  // riga di proprieta' animabile: cronometro, nome, valore, navigatore dei fotogrammi chiave
  function kfRow(c, label, props, controls) {
    const anim = () => props.some(p => c.kf?.[p]?.length);
    const watch = el("button", { class: "ve-watch" + (anim() ? " on" : ""), type: "button", title: "Attiva/disattiva animazione (fotogrammi chiave)" });
    watch.innerHTML = vIcon("watch", 15);
    watch.addEventListener("click", () => {
      c.kf = c.kf || {};
      const tau = clamp(snapF(player.t - c.start), 0, c.dur);
      if (anim()) { for (const p of props) { const v = propAt(c, p, tau); delete c.kf[p]; setProp(c, p, v); } commit("Animazione disattivata"); }
      else { for (const p of props) c.kf[p] = [[tau, propAt(c, p, tau)]]; commit("Animazione attivata"); }
      renderEC();
    });
    const nav = el("span", { class: "ve-kfnav" });
    if (anim()) {
      const times = () => [...new Set(props.flatMap(p => (c.kf?.[p] || []).map(k => k[0])))].sort((a, b) => a - b);
      const tau = () => player.t - c.start;
      const on = () => times().some(t => Math.abs(t - tau()) < fr() / 2);
      const kb = el("button", { class: "ve-kfbtn", type: "button", title: "Aggiungi/rimuovi fotogramma chiave" });
      const paint = () => { kb.innerHTML = vIcon(on() ? "kf" : "kfOff", 13); };
      paint(); ecRefs.push(paint);
      kb.addEventListener("click", () => {
        const t = clamp(snapF(tau()), 0, c.dur);
        if (on()) for (const p of props) c.kf[p] = c.kf[p].filter(k => Math.abs(k[0] - t) >= fr() / 2);
        else for (const p of props) { const v = propAt(c, p, t); c.kf[p].push([t, v]); c.kf[p].sort((a, b) => a[0] - b[0]); }
        for (const p of props) if (!c.kf[p].length) { delete c.kf[p]; }
        commit("Fotogramma chiave"); renderEC();
      });
      const go = d => { const ts = times(), cur = tau(); const t = d < 0 ? [...ts].reverse().find(x => x < cur - fr() / 2) : ts.find(x => x > cur + fr() / 2); if (t !== undefined) goto(c.start + t); };
      const pb = el("button", { class: "ve-kfbtn", type: "button", title: "Vai al fotogramma chiave precedente", onclick: () => go(-1) }); pb.innerHTML = vIcon("prev", 12);
      const nb = el("button", { class: "ve-kfbtn", type: "button", title: "Vai al fotogramma chiave successivo", onclick: () => go(1) }); nb.innerHTML = vIcon("next", 12);
      nav.append(pb, kb, nb);
    }
    return el("div", { class: "ve-ecrow" }, watch, el("span", { class: "ve-eclab" }, label), el("span", { class: "ve-ecval" }, ...controls), nav);
  }
  const ecSection = (title, extra = [], open = true) => {
    const body = el("div", { class: "ve-ecbody", hidden: !open });
    const head = el("div", { class: "ve-echead" }, el("button", { type: "button", class: "ve-ectog", onclick: () => { body.hidden = !body.hidden; head.firstChild.textContent = body.hidden ? "▸" : "▾"; } }, open ? "▾" : "▸"), el("span", { class: "ve-ectitle" }, title), el("span", { class: "grow" }), ...extra);
    return [el("div", { class: "ve-ecsec" }, head, body), body];
  };
  const smallBtn = (icon, title, fn) => { const b = el("button", { class: "ve-kfbtn", type: "button", title, onclick: fn }); b.innerHTML = vIcon(icon, 14); return b; };
  function propScrub(c, p, o) { return scrub(() => propAt(c, p, player.t - c.start) ?? 0, (v, done) => { setProp(c, p, v); if (done) commit(o.label || "Modifica"); else live(); }, o); }
  function renderEC() {
    if (UL.cur !== "ec") return;
    ecBox.innerHTML = "";
    ecRefs.length = 0;
    const tr = selTr && P.transitions.find(t => t.id === selTr);
    if (tr) return renderTransitionEC(tr);
    const cs = [...sel].map(byId).filter(Boolean);
    const main = cs.length === 1 ? cs[0] : cs.length === 2 && cs[0].link && cs[0].link === cs[1].link ? cs.find(c => c.kind !== "audio") : null;
    if (!main) { ecBox.append(el("div", { class: "ve-empty" }, cs.length ? `${cs.length} clip selezionate: selezionane una per vederne gli effetti` : "Seleziona una clip nella timeline per vederne gli effetti")); return; }
    const c = main;
    ecBox.append(el("div", { class: "ve-ectop" }, el("b", {}, c.name || "Clip"), el("span", { class: "ve-muted" }, ` · ${tc(c.start, fps)} - ${tc(end(c), fps)}`)));
    if (c.kind === "audio") {
      const [s, b] = ecSection("Volume", [smallBtn("reset", "Ripristina", () => { c.volume = 0; delete c.kf?.volume; commit("Ripristina volume"); renderEC(); })]);
      b.append(kfRow(c, "Livello", ["volume"], [propScrub(c, "volume", { min: -60, max: 15, step: 0.1, unit: " dB", label: "Livello" })]));
      b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, "Guadagno clip"),
        el("span", { class: "ve-ecval" }, scrub(() => c.gain || 0, (v, d) => { c.gain = v; if (d) commit("Guadagno"); else live(); }, { min: -60, max: 30, step: 0.1, unit: " dB" }),
          el("button", { class: "ve-mini", type: "button", onclick: () => normalizeAudio([c], -1) }, "Normalizza")), el("span")));
      ecBox.append(s);
      ecBox.append(speedSection(c));
      return;
    }
    if (c.kind === "title") ecBox.append(titleSection(c));
    if (c.kind === "color") {
      const [s, b] = ecSection("Colore");
      b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, "Colore"), el("span", { class: "ve-ecval" },
        el("input", { type: "color", value: c.color, id: "ve-col-" + c.id, onchange: e => { c.color = e.target.value; c.name = "Colore " + c.color; commit("Colore"); } })), el("span")));
      ecBox.append(s);
    }
    {
      const [s, b] = ecSection("Movimento", [smallBtn("reset", "Ripristina posizione, scala e rotazione", () => { c.motion = defMotion(); for (const p of ["x", "y", "scale", "rot"]) delete c.kf?.[p]; commit("Ripristina movimento"); renderEC(); })]);
      b.append(kfRow(c, "Posizione", ["x", "y"], [propScrub(c, "x", { step: 1, label: "Posizione", fmt: v => Math.round(v * 10) / 10 }), propScrub(c, "y", { step: 1, label: "Posizione", fmt: v => Math.round(v * 10) / 10 })]));
      b.append(kfRow(c, "Scala", ["scale"], [propScrub(c, "scale", { min: 0, max: 1000, step: 0.5, label: "Scala", unit: "%" })]));
      b.append(kfRow(c, "Rotazione", ["rot"], [propScrub(c, "rot", { step: 0.5, label: "Rotazione", unit: "°" })]));
      b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }), el("span", { class: "ve-ecval" },
        el("button", { class: "ve-mini", type: "button", title: "Scala per riempire il fotogramma (senza bande nere)", onclick: () => { fillFrame(c); } }, "Riempi fotogramma"),
        el("button", { class: "ve-mini", type: "button", title: "Riquadro in basso a destra (picture-in-picture)", onclick: () => { setProp(c, "scale", 35); setProp(c, "x", Math.round(P.settings.w * 0.78)); setProp(c, "y", Math.round(P.settings.h * 0.76)); commit("Picture-in-picture"); renderEC(); } }, "PiP")), el("span")));
      ecBox.append(s);
    }
    {
      const [s, b] = ecSection("Opacita'", [smallBtn("reset", "Ripristina", () => { c.opacity = 100; c.blend = "normal"; delete c.kf?.opacity; commit("Ripristina opacita'"); renderEC(); })]);
      b.append(kfRow(c, "Opacita'", ["opacity"], [propScrub(c, "opacity", { min: 0, max: 100, step: 0.5, label: "Opacita'", unit: "%" })]));
      b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, "Metodo di fusione"), el("span", { class: "ve-ecval" },
        el("select", { class: "ve-sel", id: "ve-blend-" + c.id, onchange: e => { c.blend = e.target.value; commit("Metodo di fusione"); } }, ...Object.entries(BLENDS).map(([k, n]) => el("option", { value: k, selected: (c.blend || "normal") === k }, n)))), el("span")));
      ecBox.append(s);
    }
    if (c.kind === "video") ecBox.append(speedSection(c));
    (c.fx || []).forEach((e, i) => ecBox.append(fxSection(c, e, i)));
    ecBox.append(el("div", { class: "ve-ecnote" }, "Aggiungi effetti dal pannello Effetti (trascinali sulla clip o doppio clic)."));
  }
  function speedSection(c) {
    const [s, b] = ecSection("Rimappatura tempo", [], false);
    b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, "Velocita'"), el("span", { class: "ve-ecval" },
      el("span", {}, Math.round((c.speed || 1) * 1000) / 10 + "%"), el("button", { class: "ve-mini", type: "button", onclick: () => speedDialog() }, "Velocita'/Durata...")), el("span")));
    return s;
  }
  function fillFrame(c) {
    const m = mediaOf(c);
    const sw = m?.w || P.settings.w, sh = m?.h || P.settings.h;
    const f = Math.min(P.settings.w / sw, P.settings.h / sh), g = Math.max(P.settings.w / sw, P.settings.h / sh);
    setProp(c, "scale", Math.round(g / f * 1000) / 10);
    setProp(c, "x", P.settings.w / 2); setProp(c, "y", P.settings.h / 2);
    commit("Riempi fotogramma"); renderEC();
  }
  function titleSection(c) {
    const T = c.title;
    const [s, b] = ecSection("Testo");
    const upd = (k, v, done = true) => { T[k] = v; if (done) commit("Testo"); else live(); };
    const ta = el("textarea", { class: "ve-ta", id: "ve-ta-" + c.id, rows: 3 }, T.text);
    ta.addEventListener("input", () => { T.text = ta.value; c.name = ta.value.split("\n")[0].slice(0, 40) || "Titolo"; live(); });
    ta.addEventListener("change", () => commit("Testo"));
    ta.addEventListener("keydown", e => e.stopPropagation());
    b.append(ta);
    const font = el("select", { class: "ve-sel", id: "ve-font-" + c.id, onchange: e => upd("font", e.target.value) }, ...FONTS.map(f => el("option", { value: f, selected: f === T.font, style: { fontFamily: f } }, f)));
    const tog = (k, label, title) => el("button", { class: "ve-mini" + (T[k] ? " on" : ""), type: "button", title, onclick: () => { upd(k, !T[k]); renderEC(); } }, label);
    const al = a => el("button", { class: "ve-mini" + (T.align === a ? " on" : ""), type: "button", title: { left: "Allinea a sinistra", center: "Centra", right: "Allinea a destra" }[a], onclick: () => { upd("align", a); renderEC(); } }, { left: "⯇", center: "≡", right: "⯈" }[a]);
    const color = (k, id) => el("input", { type: "color", value: T[k], id: `ve-${id}-${c.id}`, oninput: e => upd(k, e.target.value, false), onchange: e => upd(k, e.target.value) });
    const row = (label, ...ctl) => el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, label), el("span", { class: "ve-ecval" }, ...ctl), el("span"));
    b.append(row("Carattere", font), row("Dimensione", scrub(() => T.size, (v, d) => upd("size", v, d), { min: 4, max: 1000, step: 1, unit: " px" }), tog("bold", "G", "Grassetto"), tog("italic", "C", "Corsivo")),
      row("Allineamento", al("left"), al("center"), al("right")), row("Riempimento", color("color", "tc")),
      row("Traccia", tog("stroke", "Si'", "Contorno del testo"), color("strokeColor", "sc"), scrub(() => T.strokeW, (v, d) => upd("strokeW", v, d), { min: 0, max: 60, step: 0.5, unit: " px" })),
      row("Ombra", tog("shadow", "Si'", "Ombra esterna"), color("shadowColor", "shc")),
      row("Sfondo", tog("bg", "Si'", "Rettangolo dietro il testo"), color("bgColor", "bc"), scrub(() => T.bgOpacity ?? 60, (v, d) => upd("bgOpacity", v, d), { min: 0, max: 100, step: 1, unit: "%" })));
    return s;
  }
  function fxSection(c, e, i) {
    const def = EFFECTS[e.type];
    const onBtn = el("button", { class: "ve-fxon" + (e.on === false ? "" : " on"), type: "button", title: "Attiva/disattiva effetto" });
    onBtn.innerHTML = vIcon("fx", 15);
    onBtn.addEventListener("click", () => { e.on = e.on === false; commit("Effetto attivo/disattivo"); renderEC(); });
    const [s, b] = ecSection(def?.name || e.type, [
      smallBtn("prev", "Sposta sopra", () => { if (i > 0) { [c.fx[i - 1], c.fx[i]] = [c.fx[i], c.fx[i - 1]]; commit("Ordine effetti"); renderEC(); } }),
      smallBtn("next", "Sposta sotto", () => { if (i < c.fx.length - 1) { [c.fx[i + 1], c.fx[i]] = [c.fx[i], c.fx[i + 1]]; commit("Ordine effetti"); renderEC(); } }),
      smallBtn("reset", "Ripristina", () => { e.p = Object.fromEntries(def.params.map(p => [p.k, p.d])); commit("Ripristina effetto"); renderEC(); }),
      smallBtn("trash", "Elimina effetto", () => { c.fx.splice(i, 1); commit("Elimina effetto"); renderEC(); })]);
    s.querySelector(".ve-echead").insertBefore(onBtn, s.querySelector(".ve-ectitle"));
    for (const p of def?.params || []) {
      let ctl;
      if (p.type === "bool") ctl = el("input", { type: "checkbox", id: `ve-fx-${c.id}-${i}-${p.k}`, checked: !!(e.p[p.k] ?? p.d), onchange: ev => { e.p[p.k] = ev.target.checked; commit(def.name); } });
      else if (p.type === "color") ctl = el("input", { type: "color", id: `ve-fx-${c.id}-${i}-${p.k}`, value: e.p[p.k] ?? p.d, oninput: ev => { e.p[p.k] = ev.target.value; live(); }, onchange: () => commit(def.name) });
      else if (p.type === "file") ctl = el("span", {}, el("span", { class: "ve-muted" }, e.p.file ? baseName(e.p.file) : "nessun file"), el("button", { class: "ve-mini", type: "button", onclick: () => pickLut(c, i) }, "Scegli..."));
      else ctl = scrub(() => e.p[p.k] ?? p.d, (v, d) => { e.p[p.k] = v; if (d) commit(def.name); else live(); }, { min: p.min, max: p.max, step: p.step || 1, unit: p.u ? " " + p.u : "" });
      if (p.type !== "file" && p.type !== "bool" && p.type !== "color") {
        const sl = el("input", { type: "range", class: "ve-range", id: `ve-fxr-${c.id}-${i}-${p.k}`, min: p.min, max: p.max, step: p.step || 1, value: e.p[p.k] ?? p.d });
        sl.addEventListener("input", () => { e.p[p.k] = +sl.value; ecRefs.forEach(f => f()); live(); });
        sl.addEventListener("change", () => commit(def.name));
        ecRefs.push(() => { sl.value = e.p[p.k] ?? p.d; });
        b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, p.n), el("span", { class: "ve-ecval" }, ctl, sl), el("span")));
      } else b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, p.n), el("span", { class: "ve-ecval" }, ctl), el("span")));
    }
    if (e.type === "chroma") b.append(el("div", { class: "ve-ecnote" }, "Suggerimento: metti la clip con lo sfondo verde sulla traccia sopra quella dello sfondo nuovo."));
    return s;
  }
  async function pickLut(c, i) {
    const ps = await pickFiles();
    if (!ps?.length) return;
    if (extOf(ps[0]) !== "cube") return toast("Serve un file LUT 3D .cube", true);
    c.fx[i].p.file = ps[0];
    commit("LUT");
    renderEC();
  }
  function renderTransitionEC(tr) {
    const audio = isA(tr.track);
    const lib = audio ? AUDIO_TRANSITIONS : TRANSITIONS;
    const a = byId(tr.a), b2 = byId(tr.b);
    ecBox.append(el("div", { class: "ve-ectop" }, el("b", {}, lib[tr.type]?.name || tr.type), el("span", { class: "ve-muted" }, " · transizione " + (a && b2 ? "tra due clip (al centro del taglio)" : a ? "alla fine della clip" : "all'inizio della clip"))));
    const [s, b] = ecSection("Transizione");
    b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, "Tipo"), el("span", { class: "ve-ecval" },
      el("select", { class: "ve-sel", id: "ve-trtype-" + tr.id, onchange: e => { tr.type = e.target.value; commit("Tipo di transizione"); } }, ...Object.entries(lib).map(([k, v]) => el("option", { value: k, selected: k === tr.type }, v.name)))), el("span")));
    b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, "Durata"), el("span", { class: "ve-ecval" },
      scrub(() => tr.dur, (v, d) => { tr.dur = Math.max(fr(), snapF(v)); if (d) { commit("Durata transizione"); renderEC(); } else live(); }, { min: fr(), max: 60, step: fr(), fmt: v => tc(v, fps), parse: s2 => parseTc(s2, fps) })), el("span")));
    b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }), el("span", { class: "ve-ecval" },
      el("button", { class: "ve-mini", type: "button", onclick: () => { P.transitions = P.transitions.filter(x => x !== tr); selTr = null; commit("Elimina transizione"); } }, "Elimina transizione")), el("span")));
    ecBox.append(s);
    if (a && b2) ecBox.append(el("div", { class: "ve-ecnote" }, "Se le clip non hanno materiale oltre il taglio, durante la transizione si ripete l'ultimo/primo fotogramma (come in Premiere)."));
  }
  function updateECValues() { ecRefs.forEach(f => f()); }

  // ------------------------------------------------------------------ Mixer tracce audio
  function renderMixer() {
    const box = UL.body("mixer");
    box.innerHTML = "";
    const strip = (name, getDb, setDb, extra) => {
      const val = el("span", { class: "ve-mxval" });
      const sl = el("input", { type: "range", class: "ve-fader", min: -60, max: 12, step: 0.1, value: getDb(), id: "ve-fader-" + name.replace(/\W/g, "") });
      const show = () => { val.textContent = (getDb() <= -60 ? "-∞" : (Math.round(getDb() * 10) / 10).toLocaleString(LOCALE)) + " dB"; };
      show();
      sl.addEventListener("input", () => { setDb(+sl.value); show(); player.dirty = true; });
      sl.addEventListener("change", () => commit("Volume traccia"));
      sl.addEventListener("dblclick", () => { setDb(0); sl.value = 0; show(); commit("Volume traccia"); });
      return el("div", { class: "ve-strip" }, el("div", { class: "ve-mxname" }, name), extra || el("div", { class: "ve-mxbtns" }), sl, val);
    };
    for (const t of P.tracks.a) {
      const ms = el("div", { class: "ve-mxbtns" },
        el("button", { class: "ve-ms" + (t.mute ? " on m" : ""), type: "button", title: "Disattiva audio della traccia", onclick: () => { t.mute = !t.mute; commit("Mute"); } }, "M"),
        el("button", { class: "ve-ms" + (t.solo ? " on s" : ""), type: "button", title: "Assolo", onclick: () => { t.solo = !t.solo; commit("Solo"); } }, "S"));
      box.append(strip(t.name || t.id, () => t.gain || 0, v => { t.gain = v <= -60 ? -120 : v; }, ms));
    }
    box.append(strip("Master", () => P.settings.master || 0, v => { P.settings.master = v; if (player.master) player.master.gain.value = dbToLin(v); }));
  }

  // ------------------------------------------------------------------ misuratori audio
  const meterCv = el("canvas", { class: "ve-metercv" });
  meterBox.append(meterCv, el("div", { class: "ve-meterlab" }, "L  R"));
  let peakHold = [0, 0], peakT = [0, 0];
  function drawMeters(v) {
    const W = meterCv.clientWidth, H = meterCv.clientHeight;
    if (!W || !H) return;
    if (meterCv.width !== W) { meterCv.width = W; meterCv.height = H; }
    const g = meterCv.getContext("2d");
    g.fillStyle = "#151617"; g.fillRect(0, 0, W, H);
    const yOf = db => clamp(1 - (db + 60) / 60, 0, 1) * (H - 4) + 2;
    g.fillStyle = "#777"; g.font = "9px Segoe UI";
    for (const db of [0, -6, -12, -18, -24, -36, -48]) { const y = yOf(db); g.fillRect(0, y, 4, 1); g.fillText(String(db), 5, y + 3); }
    const bw = 7, x0 = W - 2 * bw - 6;
    const now = performance.now();
    v.forEach((a, i) => {
      const db = a > 0 ? 20 * Math.log10(a) : -100;
      const x = x0 + i * (bw + 2);
      g.fillStyle = "#222"; g.fillRect(x, 2, bw, H - 4);
      const grad = g.createLinearGradient(0, H, 0, 0);
      grad.addColorStop(0, "#2fb34a"); grad.addColorStop(0.75, "#c8c43a"); grad.addColorStop(0.92, "#e0782c"); grad.addColorStop(1, "#e33b2f");
      g.fillStyle = grad;
      const y = yOf(db);
      g.fillRect(x, y, bw, H - 2 - y);
      if (db > peakHold[i] || now - peakT[i] > 1500) { peakHold[i] = db; peakT[i] = now; }
      if (peakHold[i] > -60) { g.fillStyle = peakHold[i] > -0.1 ? "#ff3b30" : "#ddd"; g.fillRect(x, yOf(peakHold[i]), bw, 2); }
    });
  }

  // ------------------------------------------------------------------ strumenti
  const toolBtns = {};
  for (const [id, name, key] of TOOLS) {
    const b = el("button", { class: "ve-tool", type: "button", title: `${name} (${key})`, onclick: () => setTool(id) });
    b.innerHTML = vIcon(id, 19);
    toolBtns[id] = b;
    toolsBar.append(b);
    if (["select", "trackfwd", "rolling", "razor", "slide", "pen", "zoom"].includes(id)) toolsBar.append(el("span", { class: "ve-toolsep" }));
  }
  function setTool(id) {
    tool = id;
    for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle("on", k === id);
    const n = TOOLS.find(x => x[0] === id);
    ctx.status(n[1] + " · " + toolHint[id]);
  }
  const toolHint = {
    select: "clic seleziona, trascina sposta (Alt duplica, Ctrl inserisce), trascina i bordi per tagliare; Ctrl+clic sulla linea = fotogramma chiave",
    trackfwd: "clic seleziona tutte le clip della traccia da quel punto in poi (Maiusc: tutte le tracce)",
    ripple: "trascina un bordo: taglia e sposta le clip successive", rolling: "trascina un punto di modifica tra due clip",
    rate: "trascina un bordo per cambiare la velocita'", razor: "clic per dividere la clip (Maiusc: tutte le tracce)",
    slip: "trascina la clip per cambiare attacco e stacco del sorgente", slide: "trascina la clip tra le due vicine",
    pen: "clic sulla linea di opacita'/volume per aggiungere fotogrammi chiave, trascinali per cambiarli", hand: "trascina per scorrere la timeline",
    zoom: "clic per ingrandire, Alt+clic per ridurre", type: "clic sul monitor programma per scrivere un titolo",
  };

  // ------------------------------------------------------------------ timeline
  const tlTc = el("span", { class: "ve-tc ve-tc-tl", title: "Posizione della testina" });
  const snapBtn = el("button", { class: "ve-tlbtn on", type: "button", title: "Aggancia in timeline (S)", onclick: () => toggleSnap() });
  snapBtn.innerHTML = vIcon("snap", 16);
  const linkBtn = el("button", { class: "ve-tlbtn on", type: "button", title: "Selezione collegata", onclick: () => { linkedSel = !linkedSel; linkBtn.classList.toggle("on", linkedSel); } });
  linkBtn.innerHTML = vIcon("link", 16);
  const mkBtn = el("button", { class: "ve-tlbtn", type: "button", title: "Aggiungi marcatore (M)", onclick: () => addMarker() });
  mkBtn.innerHTML = vIcon("marker", 16);
  const setBtn = el("button", { class: "ve-tlbtn", type: "button", title: "Impostazioni di visualizzazione della timeline", onclick: e => openMenuAt(e.currentTarget, MENUS.Visualizza()) });
  setBtn.innerHTML = vIcon("wrench", 16);
  const zoomRange = el("input", { type: "range", class: "ve-tlzoom", id: "ve-tlz-" + ctx.tab.name, min: 0, max: 100, step: 0.5, title: "Zoom della timeline (+ / -)" });
  zoomRange.addEventListener("input", () => setZoom(Math.pow(10, -1 + zoomRange.value / 100 * 3.6), player.t));
  const headCol = el("div", { class: "ve-heads" });
  const headInner = el("div", { class: "ve-headsin" });
  headCol.append(el("div", { class: "ve-headruler" }), headInner);
  const tlCanvas = el("canvas", { class: "ve-tlcv" });
  const tlOver = el("canvas", { class: "ve-tlov" });
  const tlArea = el("div", { class: "ve-tlarea" }, tlCanvas, tlOver);
  const hsb = el("div", { class: "ve-hsb" }), hthumb = el("div", { class: "ve-hthumb" });
  hsb.append(hthumb);
  tlPanel.append(el("div", { class: "ve-ptabs" }, el("span", { class: "ve-ptab on" }, "Timeline: sequenza")),
    el("div", { class: "ve-tlhead" }, tlTc, snapBtn, linkBtn, mkBtn, setBtn, el("span", { class: "grow" }), zoomRange),
    el("div", { class: "ve-tlbody" }, headCol, tlArea), el("div", { class: "ve-hsbrow" }, el("div", { style: { width: HEAD_W + "px", flex: "none" } }), hsb));
  const tRows = { showThumbs: true, showWaves: true };
  function toggleSnap() { snapOn = !snapOn; snapBtn.classList.toggle("on", snapOn); ctx.status("Aggancio " + (snapOn ? "attivo" : "disattivato")); }

  const trackH = t => t.h || 56;
  function rows() {
    const out = [];
    let y = 0;
    for (const t of [...P.tracks.v].reverse()) { out.push({ tr: t, type: "v", y, h: trackH(t) }); y += trackH(t); }
    y += 6;
    for (const t of P.tracks.a) { out.push({ tr: t, type: "a", y, h: trackH(t) }); y += trackH(t); }
    return { list: out, h: y };
  }
  const tToX = t => (t - scrollT) * pps;
  const xToT = x => x / pps + scrollT;
  function rowAt(y) { const R = rows(); const cy = y - RULER + scrollY; return R.list.find(r => cy >= r.y && cy < r.y + r.h) || null; }
  const rowOf = tid => rows().list.find(r => r.tr.id === tid);
  const rowY = r => RULER + r.y - scrollY;
  function setZoom(z, anchorT) {
    const W = tlArea.clientWidth || 800;
    const ax = tToX(anchorT ?? player.t);
    pps = clamp(z, 0.1, 400);
    scrollT = Math.max(0, (anchorT ?? player.t) - ax / pps);
    if (ax < 0 || ax > W) scrollT = Math.max(0, (anchorT ?? player.t) - W / 2 / pps);
    zoomRange.value = (Math.log10(pps) + 1) / 3.6 * 100;
    drawTL();
  }
  function zoomFit() {
    const W = (tlArea.clientWidth || 800) - 20;
    pps = clamp(W / Math.max(5, total() * 1.03), 0.1, 400);
    scrollT = 0;
    zoomRange.value = (Math.log10(pps) + 1) / 3.6 * 100;
    drawTL();
  }
  function followPlayhead(center = false) {
    const W = tlArea.clientWidth;
    const x = tToX(player.t);
    if (x < 0 || x > W - 10) { scrollT = Math.max(0, center ? player.t - W / 2 / pps : player.t - 10 / pps); drawTL(); }
  }

  // intestazioni delle tracce (DOM)
  function renderHeads() {
    headInner.innerHTML = "";
    const R = rows();
    headInner.style.height = R.h + "px";
    headInner.style.transform = `translateY(${-scrollY}px)`;
    for (const r of R.list) {
      const t = r.tr;
      const ib = (icon, title, on, fn, cls = "") => { const b = el("button", { class: "ve-hb " + cls + (on ? " on" : ""), type: "button", title, onclick: fn }); b.innerHTML = icon.startsWith("<") ? icon : vIcon(icon, 14); return b; };
      const isV = r.type === "v";
      const patch = el("button", { class: "ve-patch" + ((isV ? P.srcV : P.srcA) === t.id ? " on" : ""), type: "button", title: "Traccia di destinazione per Inserisci/Sovrascrivi e per le transizioni predefinite",
        onclick: () => { if (isV) P.srcV = t.id; else P.srcA = t.id; renderHeads(); } }, isV ? "V" : "A");
      const row = el("div", { class: "ve-head " + (isV ? "v" : "a"), style: { top: r.y + "px", height: r.h + "px" } },
        patch, ib(t.lock ? "lock" : "unlock", "Attiva/disattiva blocco traccia", t.lock, () => { t.lock = !t.lock; commit("Blocco traccia"); }),
        isV ? ib(t.hide ? "eyeOff" : "eye", "Attiva/disattiva output traccia", !t.hide, () => { t.hide = !t.hide; commit("Output traccia"); }, "eyeb")
          : el("span", { class: "ve-ms2" }, ib("<b>M</b>", "Disattiva audio traccia", t.mute, () => { t.mute = !t.mute; commit("Mute"); }, "m"), ib("<b>S</b>", "Assolo traccia", t.solo, () => { t.solo = !t.solo; commit("Solo"); }, "s")),
        el("span", { class: "ve-hname", title: "Doppio clic: altezza della traccia" }, t.id));
      row.addEventListener("dblclick", e => { if (e.target.closest("button")) return; t.h = trackH(t) > 60 ? 56 : 100; commit(); });
      row.addEventListener("contextmenu", e => { e.preventDefault(); openMenuAt({ x: e.clientX, y: e.clientY }, [
        { label: "Rinomina traccia...", run: async () => { const n = await askText("Rinomina traccia", "Nome", t.name || t.id); if (n) { t.name = n; commit("Rinomina traccia"); } } },
        { label: "Aggiungi traccia", run: () => { addTrack(r.type); commit("Aggiungi traccia"); } },
        { label: "Elimina traccia", run: () => deleteTrack(t, r.type), disabled: () => (isV ? P.tracks.v : P.tracks.a).length < 2 },
        "-", { label: trackH(t) > 60 ? "Riduci altezza" : "Espandi altezza", run: () => { t.h = trackH(t) > 60 ? 56 : 100; commit(); } }]); });
      row.title = t.name || t.id;
      headInner.append(row);
    }
  }
  function addTrack(type) {
    const list = type === "v" ? P.tracks.v : P.tracks.a;
    const p = type === "v" ? "V" : "A";
    let n = list.length + 1;
    while (list.some(t => t.id === p + n)) n++;
    const t = { id: p + n, name: (type === "v" ? "Video " : "Audio ") + n };
    if (type === "a") t.gain = 0;
    list.push(t);
    return t.id;
  }
  async function deleteTrack(t, type) {
    const cs = clipsOn(t.id);
    if (cs.length && !(await confirmBox("Elimina traccia", `La traccia ${t.id} contiene ${cs.length} clip che verranno eliminate. Continuare?`, "Elimina", true))) return;
    cs.forEach(removeClip);
    if (type === "v") P.tracks.v = P.tracks.v.filter(x => x !== t); else P.tracks.a = P.tracks.a.filter(x => x !== t);
    if (P.srcV === t.id) P.srcV = P.tracks.v[0]?.id; if (P.srcA === t.id) P.srcA = P.tracks.a[0]?.id;
    commit("Elimina traccia");
  }

  // disegno della timeline
  let tlW = 0, tlH = 0;
  function sizeCanvases() {
    const r = tlArea.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    tlW = r.width; tlH = r.height;
    for (const c of [tlCanvas, tlOver]) { c.width = Math.max(1, r.width * dpr); c.height = Math.max(1, r.height * dpr); }
  }
  function niceStep(minSec) {
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    return steps.find(s => s >= minSec) || 3600;
  }
  function drawTL() {
    if (!tlArea.isConnected) return;
    sizeCanvases();
    const g = tlCanvas.getContext("2d"), dpr = devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#1d1e20"; g.fillRect(0, 0, tlW, tlH);
    const R = rows();
    const maxScroll = Math.max(0, R.h - (tlH - RULER) + 20);
    scrollY = clamp(scrollY, 0, maxScroll);
    const L = layout(P);
    g.save();
    g.beginPath(); g.rect(0, RULER, tlW, tlH - RULER); g.clip();
    // righe delle tracce
    for (const r of R.list) {
      const y = rowY(r);
      g.fillStyle = r.type === "v" ? "#232427" : "#222624";
      g.fillRect(0, y, tlW, r.h - 1);
      g.fillStyle = "#18191a"; g.fillRect(0, y + r.h - 1, tlW, 1);
    }
    // intervallo attacco/stacco
    if (P.inPoint !== null && P.inPoint !== undefined || P.outPoint !== null && P.outPoint !== undefined) {
      const a = tToX(P.inPoint ?? 0), b = tToX(P.outPoint ?? total());
      g.fillStyle = "rgba(120,150,200,.08)"; g.fillRect(a, RULER, b - a, tlH);
    }
    // spazio vuoto selezionato
    if (selGap) { const r = rowOf(selGap.track); if (r) { g.fillStyle = "rgba(45,140,235,.25)"; g.fillRect(tToX(selGap.a), rowY(r), (selGap.b - selGap.a) * pps, r.h - 1); } }
    const t0 = scrollT, t1 = xToT(tlW);
    for (const c of P.clips) {
      if (end(c) < t0 || c.start > t1) continue;
      const r = rowOf(c.track);
      if (!r) continue;
      drawClip(g, c, rowY(r), r.h, L);
    }
    // transizioni
    for (const tr of P.transitions) {
      const r = rowOf(tr.track);
      if (!r) continue;
      const a = byId(tr.a), b = byId(tr.b);
      let ta, tb;
      if (a && b) { ta = b.start - tr.dur / 2; tb = b.start + tr.dur / 2; } else if (b) { ta = b.start; tb = b.start + tr.dur; } else if (a) { ta = end(a) - tr.dur; tb = end(a); } else continue;
      const x = tToX(ta), w = (tb - ta) * pps, y = rowY(r) + 1, h = Math.min(22, r.h * 0.45);
      g.fillStyle = selTr === tr.id ? "rgba(90,160,255,.95)" : "rgba(170,175,190,.85)";
      g.fillRect(x, y, w, h);
      g.strokeStyle = "rgba(20,20,30,.6)"; g.beginPath(); g.moveTo(x, y + h); g.lineTo(x + w, y); g.stroke();
      if (w > 40) { g.fillStyle = "#111"; g.font = "10px Segoe UI"; g.fillText((isA(tr.track) ? AUDIO_TRANSITIONS : TRANSITIONS)[tr.type]?.name || tr.type, x + 4, y + 11, w - 8); }
    }
    g.restore();
    // separatore video/audio
    const sep = R.list.find(r => r.type === "a");
    if (sep) { g.fillStyle = "#0f1011"; g.fillRect(0, RULER + sep.y - 6 - scrollY, tlW, 6); }
    drawRuler(g);
    drawOverlay();
    renderHeads();
    // barra di scorrimento orizzontale
    const span = Math.max(total() + 10, xToT(tlW));
    const hw = hsb.clientWidth;
    hthumb.style.width = Math.max(20, (tlW / pps) / span * hw) + "px";
    hthumb.style.left = scrollT / span * hw + "px";
  }
  function drawRuler(g) {
    g.fillStyle = "#26272a"; g.fillRect(0, 0, tlW, RULER);
    g.fillStyle = "#3a3b3e"; g.fillRect(0, RULER - 1, tlW, 1);
    const major = niceStep(110 / pps), minor = niceStep(12 / pps);
    g.fillStyle = "#8f9296"; g.font = "10px Segoe UI";
    const start = Math.floor(scrollT / minor) * minor;
    for (let t = start; t < xToT(tlW); t += minor) {
      const x = Math.round(tToX(t)) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      g.fillRect(x, isMajor ? 12 : 19, 1, isMajor ? RULER - 13 : RULER - 20);
      if (isMajor) g.fillText(tc(t, fps), x + 3, 10);
    }
    if (P.inPoint !== null && P.inPoint !== undefined || P.outPoint !== null && P.outPoint !== undefined) {
      const a = tToX(P.inPoint ?? 0), b = tToX(P.outPoint ?? total());
      g.fillStyle = "rgba(140,170,220,.45)"; g.fillRect(a, RULER - 7, b - a, 6);
    }
    for (const m of P.markers) {
      const x = tToX(m.t);
      g.fillStyle = m.color || "#4caf50";
      g.beginPath(); g.moveTo(x - 5, 13); g.lineTo(x + 5, 13); g.lineTo(x + 5, 19); g.lineTo(x, 24); g.lineTo(x - 5, 19); g.closePath(); g.fill();
      if (m.name && pps > 20) { g.fillStyle = "#cfd"; g.fillText(m.name, x + 7, 22); }
    }
  }
  function clipColor(c) { return KIND_COLOR[c.kind] || "#888"; }
  function rubberY(c, v, y, h) {
    if (c.kind === "audio") return y + 3 + (1 - clamp((v + 40) / 46, 0, 1)) * (h - 6);
    return y + 3 + (1 - clamp(v / 100, 0, 1)) * (h - 6);
  }
  function drawClip(g, c, y, h, L) {
    const x0 = tToX(c.start), x1 = tToX(end(c));
    const w = Math.max(1, x1 - x0);
    const selected = sel.has(c.id);
    const base = clipColor(c);
    g.save();
    g.beginPath(); g.rect(x0, y + 1, w, h - 2); g.clip();
    g.fillStyle = c.off ? "#4a4c50" : base;
    g.globalAlpha = c.off ? 0.6 : 1;
    g.fillRect(x0, y + 1, w, h - 2);
    g.globalAlpha = 1;
    const m = mediaOf(c);
    const bodyY = y + 15, bodyH = h - 17;
    if (c.kind === "video" && tRows.showThumbs && bodyH > 18 && thumbs.get(c.media)?.img) {
      const th = thumbs.get(c.media);
      const tw = th.tw * bodyH / th.th;
      for (let x = Math.max(x0, Math.floor((0 - x0) / tw) * tw + x0); x < Math.min(x1, tlW); x += tw) {
        const st = (c.in || 0) + (xToT(x) - c.start) * (c.speed || 1);
        const idx = clamp(Math.floor(st / th.step), 0, th.count - 1);
        g.drawImage(th.img, idx * th.tw, 0, th.tw, th.th, x, bodyY, tw, bodyH);
      }
      g.fillStyle = "rgba(0,0,0,.18)"; g.fillRect(x0, bodyY, w, bodyH);
    }
    if (c.kind === "audio" && tRows.showWaves && wave.get(c.media)?.peaks) {
      const wv = wave.get(c.media), mid = bodyY + bodyH / 2, sc = dbToLin((c.gain || 0) + (c.volume || 0));
      g.fillStyle = "rgba(8,44,18,.8)";
      const xa = Math.max(x0, 0), xb = Math.min(x1, tlW);
      for (let x = Math.floor(xa); x < xb; x++) {
        const sa = ((c.in || 0) + (xToT(x) - c.start) * (c.speed || 1)) * wv.rate, sb = ((c.in || 0) + (xToT(x + 1) - c.start) * (c.speed || 1)) * wv.rate;
        let mx = 0;
        for (let i = Math.floor(sa); i <= Math.min(Math.floor(sb), wv.peaks.length - 1); i++) mx = Math.max(mx, wv.peaks[i] || 0);
        const hh = Math.min(1, mx * sc) * bodyH / 2;
        g.fillRect(x, mid - hh, 1, hh * 2 || 1);
      }
    }
    if (c.kind === "title" && bodyH > 10) { g.fillStyle = "rgba(255,255,255,.85)"; g.font = "italic 11px Segoe UI"; g.fillText("T  " + (c.title?.text || "").split("\n")[0], x0 + 6, bodyY + Math.min(16, bodyH - 2)); }
    // linea di opacita'/volume (elastico) e fotogrammi chiave
    const prop = c.kind === "audio" ? "volume" : "opacity";
    const keys = c.kf?.[prop];
    if (h >= 40) {
      g.strokeStyle = c.kind === "audio" ? "#f2f2a0" : "#f0f0f0"; g.lineWidth = 1;
      g.beginPath();
      if (keys?.length) {
        g.moveTo(x0, rubberY(c, keys[0][1], y, h));
        for (const [t, v] of keys) g.lineTo(tToX(c.start + t), rubberY(c, v, y, h));
        g.lineTo(x1, rubberY(c, keys[keys.length - 1][1], y, h));
      } else { const yy = rubberY(c, c.kind === "audio" ? c.volume || 0 : c.opacity ?? 100, y, h); g.moveTo(x0, yy); g.lineTo(x1, yy); }
      g.stroke();
      for (const [i, [t, v]] of (keys || []).entries()) {
        const kx = tToX(c.start + t), ky = rubberY(c, v, y, h);
        g.fillStyle = selKf && selKf.c === c.id && selKf.i === i ? "#2d8ceb" : "#f4f4f4";
        g.beginPath(); g.moveTo(kx, ky - 4); g.lineTo(kx + 4, ky); g.lineTo(kx, ky + 4); g.lineTo(kx - 4, ky); g.closePath(); g.fill();
        g.strokeStyle = "#222"; g.stroke();
      }
    }
    // intestazione della clip
    g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(x0, y + 1, w, 14);
    g.fillStyle = "#fff"; g.font = "11px Segoe UI";
    let label = (c.fx?.length ? "fx " : "") + (c.name || m?.name || c.kind) + ((c.speed || 1) !== 1 ? ` [${Math.round(c.speed * 100)}%]` : "") + (c.link ? "" : (m?.audio && c.kind === "video" ? " (V)" : ""));
    if (m?.offline) label = "SUPPORTO NON IN LINEA · " + label;
    g.fillText(label, Math.max(x0, 0) + 4, y + 12, Math.max(10, w - 8));
    g.restore();
    g.strokeStyle = selected ? "#ffffff" : "rgba(0,0,0,.55)";
    g.lineWidth = selected ? 2 : 1;
    g.strokeRect(x0 + 0.5, y + 1.5, w - 1, h - 3);
    if (m?.offline) { g.strokeStyle = "#e33"; g.strokeRect(x0 + 1.5, y + 2.5, w - 3, h - 5); }
  }
  function drawOverlay(snapX = null) {
    const g = tlOver.getContext("2d"), dpr = devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, tlW, tlH);
    // anteprima del trascinamento dal pannello Progetto
    if (drop && !drop.fxTarget) {
      for (const [tid, kind] of [[drop.vt, "video"], [drop.at, "audio"]]) {
        if (!tid) continue;
        const r = rowOf(tid); if (!r) continue;
        g.fillStyle = kind === "video" ? "rgba(125,115,196,.6)" : "rgba(79,155,92,.6)";
        g.fillRect(tToX(drop.t), rowY(r) + 1, drop.dur * pps, r.h - 2);
        g.strokeStyle = "#fff"; g.strokeRect(tToX(drop.t) + 0.5, rowY(r) + 1.5, drop.dur * pps - 1, r.h - 3);
      }
      g.fillStyle = "#fff"; g.font = "11px Segoe UI"; g.fillText(drop.insert ? "Inserisci (sposta le clip successive)" : "Sovrascrivi · tieni premuto Ctrl per inserire", tToX(drop.t) + 4, RULER + 12);
    }
    if (drop?.fxTarget) {
      const c = drop.fxTarget, r = rowOf(c.track);
      if (r) { g.strokeStyle = "#2d8ceb"; g.lineWidth = 2; g.strokeRect(tToX(c.start) + 1, rowY(r) + 2, c.dur * pps - 2, r.h - 4); g.lineWidth = 1; g.fillStyle = "rgba(45,140,235,.5)"; const x = drop.side === "in" ? tToX(c.start) : tToX(end(c)) - 14; g.fillRect(x, rowY(r) + 2, 14, r.h - 4); }
    }
    if (marquee) { g.strokeStyle = "#ddd"; g.setLineDash([4, 3]); g.strokeRect(Math.min(marquee.x0, marquee.x1) + 0.5, Math.min(marquee.y0, marquee.y1) + 0.5, Math.abs(marquee.x1 - marquee.x0), Math.abs(marquee.y1 - marquee.y0)); g.setLineDash([]); }
    if (hoverEdge) { const r = rowOf(hoverEdge.track); if (r) { g.fillStyle = hoverEdge.color || "#f5c84b"; g.fillRect(tToX(hoverEdge.t) - (hoverEdge.side === "in" ? 0 : 3), rowY(r) + 1, 3, r.h - 2); } }
    if (snapX !== null || snapLine !== null) {
      const x = snapX ?? tToX(snapLine);
      g.fillStyle = "#fff"; g.fillRect(x - 0.5, RULER, 1, tlH);
      g.beginPath(); g.moveTo(x - 5, RULER); g.lineTo(x + 5, RULER); g.lineTo(x, RULER + 6); g.fill();
    }
    if (razorX !== null) { g.strokeStyle = "#ff5a5a"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(razorX + 0.5, RULER); g.lineTo(razorX + 0.5, tlH); g.stroke(); g.setLineDash([]); }
    // testina (blu come in Premiere)
    const x = Math.round(tToX(player.t)) + 0.5;
    if (x >= -10 && x <= tlW + 10) {
      g.strokeStyle = "#2d8ceb"; g.lineWidth = 1; g.beginPath(); g.moveTo(x, 6); g.lineTo(x, tlH); g.stroke();
      g.fillStyle = "#2d8ceb"; g.beginPath(); g.moveTo(x - 6, 0); g.lineTo(x + 6, 0); g.lineTo(x + 6, 10); g.lineTo(x, 16); g.lineTo(x - 6, 10); g.closePath(); g.fill();
    }
  }
  let marquee = null, hoverEdge = null, snapLine = null, razorX = null;

  // ------------------------------------------------------------------ interazione con la timeline
  function hitClip(x, y) {
    const r = rowAt(y);
    if (!r || y < RULER) return null;
    const t = xToT(x);
    const ry = rowY(r);
    // fotogrammi chiave
    for (const c of clipsOn(r.tr.id)) {
      if (t < c.start - 4 / pps || t > end(c) + 4 / pps) continue;
      const prop = c.kind === "audio" ? "volume" : "opacity";
      const keys = c.kf?.[prop];
      if (keys && r.h >= 40) for (let i = 0; i < keys.length; i++) if (Math.abs(tToX(c.start + keys[i][0]) - x) <= 5 && Math.abs(rubberY(c, keys[i][1], ry, r.h) - y) <= 5) return { row: r, clip: c, kf: i, prop };
    }
    // transizioni (fascia in alto)
    if (y - ry < Math.min(22, r.h * 0.45) + 1) {
      for (const tr of P.transitions.filter(z => z.track === r.tr.id)) {
        const a = byId(tr.a), b = byId(tr.b);
        let ta, tb;
        if (a && b) { ta = b.start - tr.dur / 2; tb = b.start + tr.dur / 2; } else if (b) { ta = b.start; tb = b.start + tr.dur; } else if (a) { ta = end(a) - tr.dur; tb = end(a); }
        if (t >= ta && t <= tb) return { row: r, tr, edge: Math.abs(x - tToX(ta)) < 5 ? "a" : Math.abs(x - tToX(tb)) < 5 ? "b" : null };
      }
    }
    const cs = clipsOn(r.tr.id);
    for (const c of cs) {
      const x0 = tToX(c.start), x1 = tToX(end(c));
      if (x < x0 - 1 || x > x1 + 1) continue;
      const ew = Math.min(8, (x1 - x0) / 3);
      let edge = null;
      if (x - x0 <= ew) edge = "in"; else if (x1 - x <= ew) edge = "out";
      const prop = c.kind === "audio" ? "volume" : "opacity";
      const onLine = r.h >= 40 && !(c.kf?.[prop]?.length) && Math.abs(y - rubberY(c, c.kind === "audio" ? c.volume || 0 : c.opacity ?? 100, ry, r.h)) <= 3 && y > ry + 15;
      return { row: r, clip: c, edge, onLine, prop };
    }
    return { row: r, clip: null, t };
  }
  // aggancio: bordi delle clip, testina, marcatori, attacco/stacco
  function snapTime(t, exclude, offsets = [0]) {
    if (!snapOn) return { t: snapF(t), snapped: null };
    const cands = [0, player.t, ...P.markers.map(m => m.t)];
    if (P.inPoint !== null && P.inPoint !== undefined) cands.push(P.inPoint);
    if (P.outPoint !== null && P.outPoint !== undefined) cands.push(P.outPoint);
    for (const c of P.clips) if (!exclude?.has(c.id)) cands.push(c.start, end(c));
    let best = null, bd = 8 / pps;
    for (const off of offsets) for (const k of cands) { const d = Math.abs(t + off - k); if (d < bd) { bd = d; best = { t: k - off, line: k }; } }
    return best ? { t: snapF(best.t), snapped: best.line } : { t: snapF(t), snapped: null };
  }

  tlArea.addEventListener("wheel", e => {
    e.preventDefault();
    if (e.altKey || e.ctrlKey) { const r = tlArea.getBoundingClientRect(); setZoom(pps * (e.deltaY < 0 ? 1.25 : 0.8), xToT(e.clientX - r.left)); return; }
    if (e.shiftKey) { scrollY += e.deltaY; drawTL(); return; }
    scrollT = Math.max(0, scrollT + (e.deltaY + e.deltaX) / pps * 0.8);
    drawTL();
  }, { passive: false });
  headCol.addEventListener("wheel", e => { e.preventDefault(); scrollY += e.deltaY; drawTL(); }, { passive: false });
  hthumb.addEventListener("pointerdown", e => {
    hthumb.setPointerCapture(e.pointerId);
    const x0 = e.clientX, s0 = scrollT, span = Math.max(total() + 10, xToT(tlW)), hw = hsb.clientWidth;
    const mv = ev => { scrollT = Math.max(0, s0 + (ev.clientX - x0) / hw * span); drawTL(); };
    const up = () => { hthumb.removeEventListener("pointermove", mv); hthumb.removeEventListener("pointerup", up); };
    hthumb.addEventListener("pointermove", mv); hthumb.addEventListener("pointerup", up);
  });

  tlArea.addEventListener("pointermove", e => {
    if (e.buttons) return;
    const r = tlArea.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const h = hitClip(x, y);
    let he = null;
    razorX = null;
    if (tool === "razor" && h?.clip) { const s = snapTime(xToT(x)); razorX = tToX(s.t); }
    if (h?.clip && h.edge && ["select", "ripple", "rolling", "rate"].includes(tool)) he = { track: h.clip.track, t: h.edge === "in" ? h.clip.start : end(h.clip), side: h.edge, color: { select: "#f5c84b", ripple: "#f5c84b", rolling: "#e88", rate: "#8ce" }[tool] };
    hoverEdge = he;
    drawOverlay();
  });
  tlArea.addEventListener("pointerleave", () => { hoverEdge = null; razorX = null; drawOverlay(); });
  tlArea.addEventListener("dblclick", e => {
    const r = tlArea.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (y < RULER) {
      const m = P.markers.find(mk => Math.abs(tToX(mk.t) - x) < 6);
      if (m) editMarker(m);
      return;
    }
    const h = hitClip(x, y);
    if (h?.clip && h.clip.kind !== "audio") { const m = mediaOf(h.clip); if (m) openSource(m); else UL.show("ec"); }
  });
  tlArea.addEventListener("contextmenu", e => {
    e.preventDefault();
    const r = tlArea.getBoundingClientRect();
    const h = hitClip(e.clientX - r.left, e.clientY - r.top);
    if (h?.clip) { if (!sel.has(h.clip.id)) { sel = withLinked([h.clip.id]); selTr = null; refreshSel(); } openMenuAt({ x: e.clientX, y: e.clientY }, MENUS.Clip()); }
    else if (h?.tr) { selTr = h.tr.id; sel.clear(); refreshSel(); openMenuAt({ x: e.clientX, y: e.clientY }, [{ label: "Elimina transizione", run: () => { P.transitions = P.transitions.filter(t => t !== h.tr); selTr = null; commit("Elimina transizione"); } }]); }
    else if (h?.row) {
      const gap = gapAt(h.row.tr.id, xToT(e.clientX - r.left));
      if (gap) { selGap = gap; drawTL(); openMenuAt({ x: e.clientX, y: e.clientY }, [{ label: "Elimina con ripple", run: () => rippleDeleteGap() }]); }
    }
  });
  function gapAt(tid, t) {
    const cs = clipsOn(tid);
    let a = 0;
    for (const c of cs) { if (t < c.start) return c.start - a > fr() / 2 ? { track: tid, a, b: c.start } : null; a = Math.max(a, end(c)); }
    return null;
  }

  tlArea.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    focus = "program";
    root.focus({ preventScroll: true });
    const r = tlArea.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    tlArea.setPointerCapture(e.pointerId);
    let move = null, up = null;
    const bind = (m, u) => { move = m; up = u; };
    const t = xToT(x);
    if (y < RULER) { // righello: sposta la testina
      if (player.playing) stopPlay();
      const mv = ev => { let tt = xToT(ev.clientX - r.left); if (ev.shiftKey) tt = snapTime(tt).t; goto(Math.max(0, tt)); };
      mv(e);
      bind(mv, () => { });
    } else if (tool === "hand") {
      const x0 = e.clientX, y0 = e.clientY, s0 = scrollT, sy0 = scrollY;
      bind(ev => { scrollT = Math.max(0, s0 - (ev.clientX - x0) / pps); scrollY = sy0 - (ev.clientY - y0); drawTL(); }, () => { });
    } else if (tool === "zoom") {
      setZoom(pps * (e.altKey ? 0.5 : 2), t);
    } else {
      const h = hitClip(x, y);
      const fn = TOOL_DOWN[tool] || TOOL_DOWN.select;
      const res = fn(e, h, x, y, r);
      if (res) bind(res.move, res.up);
    }
    const mv = ev => move?.(ev);
    const upf = ev => { tlArea.removeEventListener("pointermove", mv); tlArea.removeEventListener("pointerup", upf); tlArea.removeEventListener("pointercancel", upf); up?.(ev); snapLine = null; marquee = null; drawOverlay(); };
    tlArea.addEventListener("pointermove", mv); tlArea.addEventListener("pointerup", upf); tlArea.addEventListener("pointercancel", upf);
  });
  const evT = (ev, r) => xToT(ev.clientX - r.left);

  // copia degli stati delle clip all'inizio di un trascinamento (per ripartire sempre dagli originali)
  const keep = cs => new Map(cs.map(c => [c.id, { start: c.start, dur: c.dur, in: c.in || 0, speed: c.speed || 1, track: c.track, kf: c.kf ? structuredClone(c.kf) : null }]));
  const back = (c, o) => { c.start = o.start; c.dur = o.dur; c.in = o.in; c.speed = o.speed; c.track = o.track; c.kf = o.kf ? structuredClone(o.kf) : c.kf; };
  const prevOf = c => clipsOn(c.track).filter(x => x !== c && end(x) <= c.start + EPS).pop();
  const nextOf = c => clipsOn(c.track).find(x => x !== c && x.start >= end(c) - EPS);
  // limiti di un taglio normale (senza ripple): materiale del sorgente e clip vicine
  function trimLimits(c, side) {
    const sp = c.speed || 1, mx = maxSrc(c);
    if (side === "in") {
      const p = prevOf(c);
      return { min: Math.max(p ? end(p) - c.start : -Infinity, -(c.in || 0) / sp), max: c.dur - fr() };
    }
    const n = nextOf(c);
    return { min: -(c.dur - fr()), max: Math.min(n ? n.start - end(c) : Infinity, (mx - (c.in || 0)) / sp - c.dur) };
  }
  function applyTrim(c, o, side, d) {
    back(c, o);
    if (side === "in") { c.start = o.start + d; c.in = o.in + d * o.speed; c.dur = o.dur - d; shiftKf(c, d); }
    else c.dur = o.dur + d;
  }

  const TOOL_DOWN = {
    select(e, h, x, y, r) {
      if (!h) return null;
      if (h.kf !== undefined) return dragKf(h, r);
      if (h.tr) {
        selTr = h.tr.id; sel.clear(); selGap = null; refreshSel();
        if (!h.edge) return null;
        const tr = h.tr, d0 = tr.dur, x0 = e.clientX;
        return { move: ev => { tr.dur = Math.max(fr(), snapF(d0 + (h.edge === "b" ? 1 : -1) * (ev.clientX - x0) / pps * (tr.a && tr.b ? 2 : 1))); validateTransitions(P); drawTL(); player.dirty = true; player.idle(); }, up: () => commit("Durata transizione") };
      }
      if (!h.clip) {
        // spazio vuoto: riquadro di selezione, oppure selezione dello spazio tra due clip
        if (!e.shiftKey) { sel.clear(); selTr = null; }
        selGap = null; selKf = null;
        marquee = { x0: x, y0: y, x1: x, y1: y };
        refreshSel();
        return {
          move: ev => { marquee.x1 = ev.clientX - r.left; marquee.y1 = ev.clientY - r.top; drawOverlay(); },
          up: () => {
            const m = marquee;
            if (Math.abs(m.x1 - m.x0) < 3 && Math.abs(m.y1 - m.y0) < 3) { selGap = h.row ? gapAt(h.row.tr.id, h.t) : null; drawTL(); return; }
            const ta = xToT(Math.min(m.x0, m.x1)), tb = xToT(Math.max(m.x0, m.x1));
            const ya = Math.min(m.y0, m.y1), yb = Math.max(m.y0, m.y1);
            for (const c of P.clips) { const rr = rowOf(c.track); if (!rr) continue; const cy = rowY(rr); if (c.start < tb && end(c) > ta && cy < yb && cy + rr.h > ya && !locked(c.track)) sel.add(c.id); }
            sel = withLinked([...sel]);
            refreshSel();
          },
        };
      }
      const c = h.clip;
      if (locked(c.track)) { toast("La traccia e' bloccata", true); return null; }
      selGap = null; selTr = null; selKf = null;
      // Ctrl+clic sulla linea: fotogramma chiave (come lo strumento Penna)
      if (e.ctrlKey && !h.edge && y > rowY(h.row) + 15) return TOOL_DOWN.pen(e, h, x, y, r);
      if (h.onLine && !h.edge && !e.shiftKey && !e.altKey) {
        // trascinare la linea di opacita'/volume senza fotogrammi chiave cambia il valore fisso
        const prop = h.prop, y0 = e.clientY, v0 = prop === "volume" ? c.volume || 0 : c.opacity ?? 100, H = h.row.h - 6;
        if (!sel.has(c.id)) { sel = withLinked([c.id]); refreshSel(); }
        return { move: ev => { const dv = -(ev.clientY - y0) / H * (prop === "volume" ? 46 : 100); const v = prop === "volume" ? clamp(Math.round((v0 + dv) * 10) / 10, -60, 6) : clamp(Math.round(v0 + dv), 0, 100); c[prop] = v; ctx.status(prop === "volume" ? `Volume ${v} dB` : `Opacita' ${v}%`); drawTL(); player.dirty = true; player.idle(); }, up: () => commit(prop === "volume" ? "Volume" : "Opacita'") };
      }
      if (h.edge) return trimDrag(e, c, h.edge, e.altKey ? "solo" : "normal", r);
      // selezione
      if (e.shiftKey) { if (sel.has(c.id)) { sel.delete(c.id); if (linkedSel && !e.altKey) partners(c).forEach(p => sel.delete(p.id)); } else sel = new Set([...sel, ...(e.altKey ? [c.id] : withLinked([c.id]))]); refreshSel(); return null; }
      if (!sel.has(c.id)) { sel = e.altKey ? new Set([c.id]) : withLinked([c.id]); refreshSel(); }
      return moveDrag(e, r, e.altKey);
    },
    trackfwd(e, h) {
      if (!h?.row) return null;
      const t = xToT(e.clientX - tlArea.getBoundingClientRect().left);
      sel = new Set(P.clips.filter(c => (e.shiftKey || c.track === h.row.tr.id) && end(c) > t && !locked(c.track)).map(c => c.id));
      sel = withLinked([...sel]);
      refreshSel();
      return moveDrag(e, tlArea.getBoundingClientRect(), false);
    },
    ripple(e, h, x, y, r) {
      if (!h?.clip || !h.edge) return TOOL_DOWN.select(e, h, x, y, r);
      return trimDrag(e, h.clip, h.edge, "ripple", r);
    },
    rolling(e, h, x, y, r) {
      if (!h?.clip || !h.edge) return TOOL_DOWN.select(e, h, x, y, r);
      const A = h.edge === "out" ? h.clip : prevOf(h.clip), B = h.edge === "out" ? nextOf(h.clip) : h.clip;
      if (!A || !B || Math.abs(end(A) - B.start) > fr() / 2) return trimDrag(e, h.clip, h.edge, "normal", r);
      const pairs = [[A, B]];
      if (linkedSel && !e.altKey) for (const pa of partners(A)) { const pb = partners(B).find(z => z.track === pa.track); if (pb && Math.abs(end(pa) - pb.start) < fr() / 2) pairs.push([pa, pb]); }
      const all = pairs.flat(), O = keep(all);
      const x0 = e.clientX;
      return {
        move: ev => {
          let d = (ev.clientX - x0) / pps;
          const s = snapTime(B.start + d, new Set(all.map(z => z.id)));
          d = s.t - O.get(B.id).start; snapLine = s.snapped;
          for (const [a, b] of pairs) {
            const oa = O.get(a.id), ob = O.get(b.id);
            d = clamp(d, -(oa.dur - fr()), Math.min(ob.dur - fr(), (maxSrc(a) - oa.in) / oa.speed - oa.dur));
            d = Math.max(d, -ob.in / ob.speed);
          }
          for (const [a, b] of pairs) { applyTrim(a, O.get(a.id), "out", d); applyTrim(b, O.get(b.id), "in", d); }
          ctx.status("Modifica con rullo: " + (d >= 0 ? "+" : "") + tc(d, fps));
          drawTL(); goto(B.start);
        },
        up: () => commit("Modifica con rullo"),
      };
    },
    rate(e, h, x, y, r) {
      if (!h?.clip || !h.edge) return TOOL_DOWN.select(e, h, x, y, r);
      const cs = [h.clip, ...(linkedSel && !e.altKey ? partners(h.clip) : [])], O = keep(cs), x0 = e.clientX;
      return {
        move: ev => {
          let d = (ev.clientX - x0) / pps;
          for (const c of cs) {
            const o = O.get(c.id);
            const lim = h.edge === "out" ? (nextOf(c) ? nextOf(c).start - o.start - o.dur : Infinity) : (prevOf(c) ? o.start - end(prevOf(c)) : o.start);
            const nd = snapF(clamp(o.dur + (h.edge === "out" ? d : -d), Math.max(fr(), o.dur * o.speed / 16), Math.min(o.dur * o.speed / 0.1, o.dur + lim)));
            back(c, o);
            c.speed = Math.round(o.speed * o.dur / nd * 10000) / 10000;
            if (h.edge === "in") c.start = o.start + o.dur - nd;
            c.dur = nd;
          }
          ctx.status(`Velocita' ${Math.round(h.clip.speed * 1000) / 10}%`);
          drawTL();
        },
        up: () => commit("Allungamento velocita'"),
      };
    },
    razor(e, h) {
      if (!h?.clip && !e.shiftKey) return null;
      const t = snapTime(xToT(e.clientX - tlArea.getBoundingClientRect().left)).t;
      const targets = e.shiftKey ? P.clips.filter(c => c.start < t - EPS && end(c) > t + EPS && !locked(c.track)) : [h.clip, ...(linkedSel && !e.altKey ? partners(h.clip) : [])];
      razorAt(t, targets);
      return null;
    },
    slip(e, h, x, y, r) {
      if (!h?.clip) return TOOL_DOWN.select(e, h, x, y, r);
      const cs = [h.clip, ...(linkedSel && !e.altKey ? partners(h.clip) : [])], O = keep(cs), x0 = e.clientX;
      sel = new Set(cs.map(c => c.id)); refreshSel();
      return {
        move: ev => {
          const d = (ev.clientX - x0) / pps;
          for (const c of cs) { const o = O.get(c.id); c.in = clamp(o.in - d * o.speed, 0, Math.max(0, maxSrc(c) - o.dur * o.speed)); }
          ctx.status("Slittamento: attacco sorgente " + tc(h.clip.in, fps));
          if (h.clip.kind === "video") { player.seek(clamp(player.t, h.clip.start, end(h.clip) - fr())); }
          drawTL();
        },
        up: () => commit("Slittamento"),
      };
    },
    slide(e, h, x, y, r) {
      if (!h?.clip) return TOOL_DOWN.select(e, h, x, y, r);
      const cs = [h.clip, ...(linkedSel && !e.altKey ? partners(h.clip) : [])];
      const groups = cs.map(c => ({ c, p: prevOf(c), n: nextOf(c) }));
      const all = groups.flatMap(g => [g.c, g.p, g.n]).filter(Boolean), O = keep(all), x0 = e.clientX;
      sel = new Set(cs.map(c => c.id)); refreshSel();
      return {
        move: ev => {
          let d = snapF((ev.clientX - x0) / pps);
          for (const { c, p, n } of groups) {
            const oc = O.get(c.id);
            const adjP = p && Math.abs(end(O.get(p.id)) - oc.start) < fr() / 2, adjN = n && Math.abs(O.get(n.id).start - (oc.start + oc.dur)) < fr() / 2;
            let lo = -oc.start, hi = Infinity;
            if (p) lo = adjP ? Math.max(lo, -(O.get(p.id).dur - fr())) : Math.max(lo, end(O.get(p.id)) - oc.start);
            if (adjP) hi = Math.min(hi, (maxSrc(p) - O.get(p.id).in) / O.get(p.id).speed - O.get(p.id).dur);
            if (n) { const on = O.get(n.id); hi = Math.min(hi, adjN ? on.dur - fr() : on.start - (oc.start + oc.dur)); if (adjN) lo = Math.max(lo, -on.in / on.speed); }
            d = clamp(d, lo, hi);
          }
          for (const { c, p, n } of groups) {
            const oc = O.get(c.id);
            back(c, oc); c.start = oc.start + d;
            if (p && Math.abs(end(O.get(p.id)) - oc.start) < fr() / 2) applyTrim(p, O.get(p.id), "out", d);
            if (n && Math.abs(O.get(n.id).start - (oc.start + oc.dur)) < fr() / 2) applyTrim(n, O.get(n.id), "in", d);
          }
          drawTL();
        },
        up: () => commit("Scorrimento"),
      };
    },
    pen(e, h, x, y, r) {
      if (!h?.clip) return null;
      if (h.kf !== undefined) return dragKf(h, r);
      const c = h.clip, ry = rowY(h.row), H = h.row.h;
      if (H < 40) { toast("Espandi la traccia (doppio clic sull'intestazione) per modificare i fotogrammi chiave", true); return null; }
      const prop = c.kind === "audio" ? "volume" : "opacity";
      const tau = clamp(snapF(xToT(x) - c.start), 0, c.dur);
      const v = c.kind === "audio" ? Math.round((((1 - (y - ry - 3) / (H - 6)) * 46) - 40) * 10) / 10 : Math.round((1 - (y - ry - 3) / (H - 6)) * 100);
      c.kf = c.kf || {};
      if (!c.kf[prop]?.length) c.kf[prop] = [];
      c.kf[prop].push([tau, clamp(v, prop === "volume" ? -60 : 0, prop === "volume" ? 6 : 100)]);
      c.kf[prop].sort((a, b) => a[0] - b[0]);
      sel = withLinked([c.id]);
      selKf = { c: c.id, prop, i: c.kf[prop].findIndex(k => k[0] === tau) };
      commit("Fotogramma chiave");
      return dragKf({ clip: c, kf: selKf.i, prop, row: h.row }, r);
    },
  };
  function dragKf(h, r) {
    const c = h.clip, prop = h.prop, keys = c.kf[prop], k = keys[h.kf], ry = rowY(h.row), H = h.row.h;
    selKf = { c: c.id, prop, i: h.kf };
    sel = withLinked([c.id]); refreshSel();
    let moved = false;
    return {
      move: ev => {
        moved = true;
        const tau = clamp(snapF(evT(ev, r) - c.start), 0, c.dur);
        const fy = clamp(1 - (ev.clientY - r.top - ry - 3) / (H - 6), 0, 1);
        k[0] = tau;
        k[1] = prop === "volume" ? Math.round((fy * 46 - 40) * 10) / 10 : Math.round(fy * 100);
        keys.sort((a, b) => a[0] - b[0]);
        selKf.i = keys.indexOf(k);
        ctx.status(prop === "volume" ? `Volume ${k[1]} dB a ${tc(c.start + k[0], fps)}` : `Opacita' ${k[1]}% a ${tc(c.start + k[0], fps)}`);
        drawTL(); player.dirty = true; player.idle();
      },
      up: () => { if (moved) commit("Sposta fotogramma chiave"); else drawTL(); },
    };
  }
  // taglio di un bordo: normale (limitato dalle vicine), ripple (sposta le successive), solo (senza la clip collegata)
  function trimDrag(e, c, side, mode, r) {
    const cs = [c, ...(mode !== "solo" && linkedSel ? partners(c) : [])];
    const tracks = [...new Set(cs.map(z => z.track))];
    const oldEnd = end(c);
    const after = mode === "ripple" ? P.clips.filter(z => !cs.includes(z) && z.start >= oldEnd - EPS && syncTracks(oldEnd, oldEnd + EPS, tracks).includes(z.track)) : [];
    const O = keep([...cs, ...after]);
    const x0 = e.clientX;
    sel = new Set(cs.map(z => z.id)); refreshSel();
    return {
      move: ev => {
        let d = (ev.clientX - x0) / pps;
        const edgeT = (side === "in" ? O.get(c.id).start : O.get(c.id).start + O.get(c.id).dur) + d;
        const s = snapTime(edgeT, new Set(cs.map(z => z.id)));
        d = s.t - (side === "in" ? O.get(c.id).start : O.get(c.id).start + O.get(c.id).dur);
        snapLine = s.snapped;
        for (const z of cs) {
          let lim;
          if (mode === "ripple") {
            const o = O.get(z.id), sp = o.speed;
            lim = side === "in" ? { min: -o.in / sp, max: o.dur - fr() } : { min: -(o.dur - fr()), max: (maxSrc(z) - o.in) / sp - o.dur };
          } else { back(z, O.get(z.id)); lim = trimLimits(z, side); }
          d = clamp(d, lim.min, lim.max);
        }
        for (const z of cs) {
          const o = O.get(z.id);
          if (mode === "ripple" && side === "in") { back(z, o); z.in = o.in + d * o.speed; z.dur = o.dur - d; shiftKf(z, d); }
          else applyTrim(z, o, side, d);
        }
        if (mode === "ripple") { const delta = side === "in" ? -d : d; for (const z of after) { back(z, O.get(z.id)); z.start = O.get(z.id).start + delta; } }
        ctx.status((mode === "ripple" ? "Ripple " : "Taglio ") + (side === "in" ? "in testa: " : "in coda: ") + (d >= 0 ? "+" : "") + tc(d, fps) + " · durata " + tc(c.dur, fps));
        drawTL();
        if (c.kind !== "audio") player.seek(side === "in" ? c.start : Math.max(c.start, end(c) - fr()));
      },
      up: () => commit(mode === "ripple" ? "Modifica con ripple" : "Taglia"),
    };
  }
  // spostamento delle clip selezionate (Alt = duplica, Ctrl al rilascio = inserisci)
  function moveDrag(e, r, dup) {
    let moving = [...sel].map(byId).filter(c => c && !locked(c.track));
    if (!moving.length) return null;
    const x0 = e.clientX, y0 = e.clientY;
    let O = keep(moving), started = false, rowsDelta = 0;
    const vOrder = P.tracks.v.map(t => t.id), aOrder = P.tracks.a.map(t => t.id);
    const startRow = rowAt(e.clientY - r.top);
    return {
      move: ev => {
        if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        if (!started) {
          started = true;
          if (dup) {
            const lmap = new Map();
            const copies = moving.map(c => { const k = structuredClone(c); k.id = uid("c"); if (c.link) { if (!lmap.has(c.link)) lmap.set(c.link, uid("l")); k.link = lmap.get(c.link); } P.clips.push(k); return k; });
            moving = copies; sel = new Set(copies.map(c => c.id)); O = keep(moving);
          }
        }
        let d = (ev.clientX - x0) / pps;
        const ids = new Set(moving.map(c => c.id));
        const minStart = Math.min(...moving.map(c => O.get(c.id).start));
        const lead = moving.reduce((a, c) => (O.get(c.id).start < O.get(a.id).start ? c : a));
        const lo = O.get(lead.id), span = Math.max(...moving.map(c => O.get(c.id).start + O.get(c.id).dur)) - minStart;
        const s = snapTime(lo.start + d, ids, [0, span]);
        d = Math.max(-minStart, s.t - lo.start);
        snapLine = s.snapped;
        // cambio di traccia (video tra video, audio tra audio)
        const row = rowAt(ev.clientY - r.top);
        if (row && startRow && row.type === startRow.type) {
          const order = row.type === "v" ? vOrder : aOrder;
          rowsDelta = order.indexOf(row.tr.id) - order.indexOf(startRow.tr.id);
        }
        for (const c of moving) {
          const o = O.get(c.id);
          c.start = snapF(o.start + d);
          if (rowsDelta && c.kind !== "audio" === (startRow.type === "v")) {
            const order = startRow.type === "v" ? vOrder : aOrder;
            const ni = clamp(order.indexOf(o.track) + rowsDelta, 0, order.length - 1);
            c.track = order[ni];
          } else c.track = o.track;
        }
        ctx.status(`Sposta: ${d >= 0 ? "+" : ""}${tc(d, fps)}${ev.ctrlKey ? " · Inserisci" : " · Sovrascrivi (Ctrl per inserire)"}`);
        drawTL();
      },
      up: ev => {
        if (!started) {
          // clic senza trascinare: seleziona solo questa clip (e le collegate)
          const h = hitClip(ev.clientX - r.left, ev.clientY - r.top);
          if (h?.clip && !ev.shiftKey) { sel = ev.altKey ? new Set([h.clip.id]) : withLinked([h.clip.id]); refreshSel(); }
          return;
        }
        const ids = new Set(moving.map(c => c.id));
        if (ev.ctrlKey) {
          const a = Math.min(...moving.map(c => c.start)), b = Math.max(...moving.map(end));
          // la clip spostata lascia un vuoto all'origine e si inserisce alla destinazione
          insertSpace(a, b - a, syncTracks(a, a + EPS, [...new Set(moving.map(c => c.track))]), ids);
        } else for (const c of moving) liftRange(c.track, c.start, end(c), ids);
        commit(dup ? "Duplica" : ev.ctrlKey ? "Sposta e inserisci" : "Sposta");
      },
    };
  }

  // ------------------------------------------------------------------ comandi di montaggio
  function razorAt(t, targets) {
    const done = [];
    const lk = new Map();
    for (const c of targets) {
      if (!c || c.start >= t - EPS || end(c) <= t + EPS || locked(c.track)) continue;
      const key = c.link ? (lk.get(c.link) || (lk.set(c.link, uid("l")), lk.get(c.link))) : null;
      const rr = splitClip(c, t, key);
      if (rr) done.push(rr);
    }
    if (done.length) commit("Lama di rasoio"); else ctx.status("Niente da dividere in questo punto");
  }
  function addEdit(all) {
    const t = snapF(player.t);
    let targets = all ? P.clips : [...sel].map(byId).filter(c => c && c.start < t && end(c) > t);
    if (!targets.length) targets = P.clips.filter(c => c.start < t - EPS && end(c) > t + EPS && (c.track === P.srcV || c.track === P.srcA || all));
    if (!targets.length) targets = P.clips.filter(c => c.start < t - EPS && end(c) > t + EPS);
    razorAt(t, targets.filter(c => c.start < t - EPS && end(c) > t + EPS));
  }
  function clearSel() {
    if (selKf) { const c = byId(selKf.c); if (c?.kf?.[selKf.prop]) { c.kf[selKf.prop].splice(selKf.i, 1); if (!c.kf[selKf.prop].length) delete c.kf[selKf.prop]; } selKf = null; commit("Elimina fotogramma chiave"); return; }
    if (selTr) { P.transitions = P.transitions.filter(t => t.id !== selTr); selTr = null; commit("Elimina transizione"); return; }
    if (selGap) return rippleDeleteGap();
    const cs = [...sel].map(byId).filter(c => c && !locked(c.track));
    if (!cs.length) return;
    cs.forEach(removeClip);
    commit("Cancella");
  }
  function rippleDelete() {
    if (selGap) return rippleDeleteGap();
    const cs = [...sel].map(byId).filter(c => c && !locked(c.track)).sort((a, b) => b.start - a.start);
    if (!cs.length) return;
    for (const c of cs) {
      if (!P.clips.includes(c)) continue;
      const a = c.start, b = end(c), tr = c.track;
      removeClip(c);
      // clip ancora presenti nello stesso intervallo su altre tracce selezionate vengono rimosse insieme (es. collegate)
      const tracks = syncTracks(a, b, [tr]).filter(tid => !clipsOn(tid).some(z => z.start < b - EPS && end(z) > a + EPS));
      closeRange(a, b, tracks);
    }
    commit("Elimina con ripple");
  }
  function rippleDeleteGap() {
    const g = selGap;
    if (!g) return;
    const tracks = syncTracks(g.a, g.b, [g.track]).filter(tid => !clipsOn(tid).some(z => z.start < g.b - EPS && end(z) > g.a + EPS));
    closeRange(g.a, g.b, tracks);
    selGap = null;
    commit("Elimina spazio con ripple");
  }
  // Q / W: taglio con ripple della modifica precedente/successiva fino alla testina
  function rippleTrimTo(prevEdit) {
    const t = snapF(player.t);
    const under = P.clips.filter(c => c.start < t - EPS && end(c) > t + EPS && !locked(c.track));
    if (!under.length) return ctx.status("Nessuna clip sotto la testina");
    if (prevEdit) { const a = Math.max(...under.map(c => c.start)); extractRange(a, t, unlockedTracks()); goto(a); }
    else { const b = Math.min(...under.map(end)); extractRange(t, b, unlockedTracks()); }
    commit(prevEdit ? "Taglio con ripple della modifica precedente" : "Taglio con ripple della modifica successiva");
  }
  function hasIO() { return P.inPoint !== null && P.inPoint !== undefined && P.outPoint !== null && P.outPoint !== undefined && P.outPoint > P.inPoint; }
  function liftInOut() { if (!hasIO()) return toast("Imposta prima attacco (I) e stacco (O) nella sequenza", true); for (const tid of unlockedTracks()) liftRange(tid, P.inPoint, P.outPoint); commit("Solleva"); }
  function extractInOut() { if (!hasIO()) return toast("Imposta prima attacco (I) e stacco (O) nella sequenza", true); extractRange(P.inPoint, P.outPoint, unlockedTracks()); const a = P.inPoint; P.outPoint = null; commit("Estrai"); goto(a); }
  function markIn() { if (focus === "source") return srcMark("in"); P.inPoint = snapF(player.t); if (P.outPoint !== null && P.outPoint !== undefined && P.outPoint <= P.inPoint) P.outPoint = null; commit("Contrassegna attacco"); }
  function markOut() { if (focus === "source") return srcMark("out"); P.outPoint = snapF(player.t); if (P.inPoint !== null && P.inPoint !== undefined && P.inPoint >= P.outPoint) P.inPoint = null; commit("Contrassegna stacco"); }
  function markClip() {
    const c = [...sel].map(byId).find(Boolean) || P.clips.filter(x => x.start <= player.t && end(x) > player.t).sort((a, b) => a.track.localeCompare(b.track))[0];
    if (!c) return;
    P.inPoint = c.start; P.outPoint = end(c); commit("Contrassegna clip");
  }
  function addMarker() {
    const t = snapF(player.t);
    if (P.markers.some(m => Math.abs(m.t - t) < fr() / 2)) return;
    P.markers.push({ t, name: "" });
    P.markers.sort((a, b) => a.t - b.t);
    commit("Aggiungi marcatore");
  }
  async function editMarker(m) {
    const n = await askText("Marcatore", "Nome / commento", m.name || "");
    if (n === null) return;
    m.name = n; commit("Marcatore");
  }
  function gotoMarker(dir) {
    const t = player.t;
    const m = dir > 0 ? P.markers.find(x => x.t > t + fr() / 2) : [...P.markers].reverse().find(x => x.t < t - fr() / 2);
    if (m) goto(m.t);
  }
  function gotoEdit(dir) {
    const t = player.t;
    const edits = [...new Set(P.clips.filter(c => !locked(c.track)).flatMap(c => [c.start, end(c)]))].sort((a, b) => a - b);
    const e = dir > 0 ? edits.find(x => x > t + fr() / 2) : [...edits].reverse().find(x => x < t - fr() / 2);
    if (e !== undefined) goto(e);
  }
  function selectAll() { sel = new Set(P.clips.filter(c => !locked(c.track)).map(c => c.id)); selTr = null; refreshSel(); }
  function deselect() { sel.clear(); selTr = null; selGap = null; selKf = null; refreshSel(); }
  function toggleEnable() { const cs = [...sel].map(byId).filter(Boolean); if (!cs.length) return; const v = !cs[0].off; cs.forEach(c => { c.off = v; }); commit(v ? "Disattiva clip" : "Attiva clip"); }
  function toggleLink() {
    const cs = [...sel].map(byId).filter(Boolean);
    if (!cs.length) return;
    if (cs.some(c => c.link)) { cs.forEach(c => { c.link = null; }); commit("Scollega"); toast("Audio e video scollegati"); }
    else { const vs = cs.filter(c => c.kind !== "audio"), as = cs.filter(c => c.kind === "audio"); if (!vs.length || !as.length) return toast("Seleziona una clip video e una audio da collegare", true); const l = uid("l"); cs.forEach(c => { c.link = l; }); commit("Collega"); toast("Audio e video collegati"); }
  }
  function copySel(cut) {
    const cs = [...sel].map(byId).filter(Boolean);
    if (!cs.length) return;
    const t0 = Math.min(...cs.map(c => c.start));
    clipboard = cs.map(c => ({ ...structuredClone(c), off0: c.start - t0 }));
    if (cut) { cs.forEach(removeClip); commit("Taglia"); }
    ctx.status(`${cs.length} clip negli appunti`);
  }
  function paste(insert) {
    if (!clipboard) return;
    const t = snapF(player.t);
    const lmap = new Map();
    const made = clipboard.map(c => { const k = structuredClone(c); k.id = uid("c"); k.start = t + c.off0; delete k.off0; if (c.link) { if (!lmap.has(c.link)) lmap.set(c.link, uid("l")); k.link = lmap.get(c.link); } return k; });
    const span = Math.max(...made.map(end)) - t;
    if (insert) insertSpace(t, span, syncTracks(t, t + EPS, [...new Set(made.map(c => c.track))]));
    else for (const c of made) liftRange(c.track, c.start, end(c));
    P.clips.push(...made);
    sel = new Set(made.map(c => c.id));
    commit(insert ? "Incolla inserimento" : "Incolla");
    goto(t + span);
  }
  async function pasteAttributes() {
    if (!clipboard?.length) return toast("Copia prima una clip (Ctrl+C)", true);
    const src0 = clipboard.find(c => c.kind !== "audio") || clipboard[0];
    const boxes = [["motion", "Movimento"], ["opacity", "Opacita' e fusione"], ["fx", "Effetti"], ["volume", "Volume"]].map(([k, n]) => [k, el("input", { type: "checkbox", checked: true, id: "ve-pa-" + k }), n]);
    const ok = await modal("Incolla attributi", el("div", { style: { display: "grid", gap: "6px" } }, ...boxes.map(([, b, n]) => el("label", { style: { display: "flex", gap: "8px" } }, b, n))), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok) return;
    const on = Object.fromEntries(boxes.map(([k, b]) => [k, b.checked]));
    for (const c of [...sel].map(byId).filter(Boolean)) {
      c.kf = c.kf || {};
      if (c.kind !== "audio") {
        if (on.motion && src0.motion) { c.motion = structuredClone(src0.motion); for (const p of ["x", "y", "scale", "rot"]) { if (src0.kf?.[p]) c.kf[p] = structuredClone(src0.kf[p]); else delete c.kf[p]; } }
        if (on.opacity) { c.opacity = src0.opacity ?? 100; c.blend = src0.blend || "normal"; if (src0.kf?.opacity) c.kf.opacity = structuredClone(src0.kf.opacity); else delete c.kf.opacity; }
        if (on.fx) c.fx = structuredClone(src0.fx || []);
      } else if (on.volume) { const a = clipboard.find(x => x.kind === "audio"); if (a) { c.volume = a.volume || 0; c.gain = a.gain || 0; if (a.kf?.volume) c.kf.volume = structuredClone(a.kf.volume); else delete c.kf.volume; } }
    }
    commit("Incolla attributi");
  }
  async function speedDialog() {
    const cs = [...sel].map(byId).filter(c => c && c.kind !== "title" && c.kind !== "color" && c.kind !== "image");
    if (!cs.length) return toast("Seleziona una clip video o audio", true);
    const c = cs[0];
    const sp = el("input", { type: "number", class: "field", id: "ve-sp", value: Math.round((c.speed || 1) * 1000) / 10, min: 10, max: 1600, step: 1 });
    const du = el("input", { type: "text", class: "field", id: "ve-du", value: tc(c.dur, fps) });
    const rip = el("input", { type: "checkbox", id: "ve-rip" });
    sp.addEventListener("input", () => { du.value = tc(c.dur * (c.speed || 1) / (+sp.value / 100), fps); });
    du.addEventListener("input", () => { const d = parseTc(du.value, fps); if (d > 0) sp.value = Math.round(c.dur * (c.speed || 1) / d * 1000) / 10; });
    const ok = await modal("Velocita'/Durata clip", el("div", { style: { display: "grid", gap: "10px" } },
      el("label", { style: { display: "grid", gap: "4px" } }, "Velocita' (%)", sp), el("label", { style: { display: "grid", gap: "4px" } }, "Durata", du),
      el("label", { style: { display: "flex", gap: "8px" } }, rip, "Modifica con ripple, sposta le clip successive"),
      el("p", { class: "note", style: { margin: 0 } }, "L'intonazione dell'audio resta invariata.")), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok) return;
    const ns = clamp(+sp.value / 100, 0.1, 16);
    for (const z of new Set([...cs, ...cs.flatMap(partners)])) {
      const oldEnd = end(z), nd = snapF(z.dur * (z.speed || 1) / ns);
      z.speed = ns;
      const maxD = (maxSrc(z) - (z.in || 0)) / ns;
      z.dur = Math.max(fr(), Math.min(nd, maxD));
      const delta = end(z) - oldEnd;
      if (rip.checked) { for (const o of P.clips) if (o !== z && o.track === z.track && o.start >= oldEnd - EPS) o.start += delta; }
      else { const n = clipsOn(z.track).find(o => o !== z && o.start >= oldEnd - EPS); if (n && end(z) > n.start) z.dur = n.start - z.start; }
    }
    commit("Velocita'/Durata");
    renderEC();
  }
  async function normalizeAudio(cs, target) {
    cs = cs.filter(c => c.kind === "audio");
    if (!cs.length) return toast("Seleziona una o piu' clip audio", true);
    ctx.status("Analisi del volume...");
    for (const c of cs) {
      const m = mediaOf(c);
      try {
        const r = await api("video_peak", { path: m.path }, { json: { start: c.in || 0, dur: c.dur * (c.speed || 1) } });
        if (r.max === null) continue;
        c.gain = Math.round((target - r.max) * 10) / 10;
      } catch (e) { toast(e.message, true); }
    }
    commit("Normalizza audio");
    ctx.status(`Normalizzate ${cs.length} clip a ${target} dB di picco`);
    renderEC();
  }
  async function audioGainDialog() {
    const cs = [...sel].map(byId).filter(c => c?.kind === "audio");
    if (!cs.length) return toast("Seleziona una o piu' clip audio", true);
    const mode = el("select", { class: "field", id: "ve-gm" }, el("option", { value: "set" }, "Imposta guadagno a (dB)"), el("option", { value: "adj" }, "Regola guadagno di (dB)"), el("option", { value: "norm" }, "Normalizza picco massimo a (dB)"));
    const val = el("input", { type: "number", class: "field", id: "ve-gv", value: 0, step: 0.5 });
    mode.addEventListener("change", () => { val.value = mode.value === "norm" ? -1 : 0; });
    const ok = await modal("Guadagno audio", el("div", { style: { display: "grid", gap: "10px" } }, mode, val), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok) return;
    const v = +val.value;
    if (mode.value === "norm") return normalizeAudio(cs, v);
    cs.forEach(c => { c.gain = mode.value === "set" ? v : (c.gain || 0) + v; });
    commit("Guadagno audio");
  }
  async function stabilizeClip() {
    if (WEB) return toast("La stabilizzazione e' disponibile nell'app per PC", true);
    const c = [...sel].map(byId).find(x => x?.kind === "video");
    if (!c) return toast("Seleziona una clip video", true);
    const m = mediaOf(c);
    const ok = await confirmBox("Stabilizza", `Viene creata una copia stabilizzata di "${m.name}" (analisi del movimento in due passate, puo' richiedere alcuni minuti). La clip usera' la copia: puoi tornare all'originale con Annulla.`, "Stabilizza");
    if (!ok) return;
    let out = m.path.replace(/(\.[^.\\/]+)?$/, "_stabilizzato.mp4");
    try { out = (await api("temp_path", { name: baseName(out) })).path; } catch { /* */ }
    const bar = progressBox("Stabilizzazione di " + m.name);
    try {
      const j = await api("video_stabilize", { path: m.path }, { json: { out } });
      await waitJob(j.job, (p, msg) => bar.set(p, msg));
      bar.close();
      const [nm] = await importPaths([out], true);
      for (const z of [c, ...partners(c)]) if (z.kind === "video") z.media = nm.id;
      commit("Stabilizza");
      toast("Clip stabilizzata");
    } catch (e) { bar.close(); toast("Stabilizzazione non riuscita: " + e.message, true, 8000); }
  }
  function progressBox(title) {
    const back = document.getElementById("modal"), body = document.getElementById("modal-body");
    const fill = el("span"), msg = el("p", {}, "Avvio...");
    body.innerHTML = "";
    body.append(el("h3", {}, title), msg, el("div", { class: "progress" }, fill));
    back.hidden = false;
    return { set(p, m) { fill.style.width = Math.round(p * 100) + "%"; msg.textContent = (m || "In corso") + ` · ${Math.round(p * 100)}%`; }, close() { back.hidden = true; } };
  }

  // ------------------------------------------------------------------ impostazioni della sequenza
  async function sequenceSettings() {
    const pre = el("select", { class: "field", id: "ve-pre" }, el("option", { value: "" }, "Personalizzata"), ...PRESETS.map(([n, w, h]) => el("option", { value: `${w}x${h}`, selected: w === P.settings.w && h === P.settings.h }, `${n} (${w}×${h})`)));
    const w = el("input", { type: "number", class: "field", id: "ve-sw", value: P.settings.w, min: 16, max: 8192 });
    const h = el("input", { type: "number", class: "field", id: "ve-sh", value: P.settings.h, min: 16, max: 8192 });
    const f = el("select", { class: "field", id: "ve-sf" }, ...RATES.map(r => el("option", { value: r, selected: r === fps }, r + " fps")));
    const bg = el("input", { type: "color", id: "ve-sbg", value: P.settings.bg || "#000000" });
    pre.addEventListener("change", () => { if (pre.value) { const [a, b] = pre.value.split("x"); w.value = a; h.value = b; } });
    const ok = await modal("Impostazioni sequenza", el("div", { style: { display: "grid", gap: "10px" } },
      el("label", { style: { display: "grid", gap: "4px" } }, "Formato", pre),
      el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, "Dimensione fotogramma", w, "×", h),
      el("label", { style: { display: "grid", gap: "4px" } }, "Base temporale", f),
      el("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, "Colore di sfondo", bg)), [{ label: "Annulla", value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok) return;
    const nw = Math.round(+w.value / 2) * 2, nh = Math.round(+h.value / 2) * 2;
    const sx = nw / P.settings.w, sy = nh / P.settings.h;
    for (const c of P.clips) { if (c.motion) { c.motion.x *= sx; c.motion.y *= sy; } if (c.kf?.x) c.kf.x.forEach(k => { k[1] *= sx; }); if (c.kf?.y) c.kf.y.forEach(k => { k[1] *= sy; }); }
    P.settings.w = nw; P.settings.h = nh; P.settings.fps = fps = +f.value; P.settings.bg = bg.value;
    for (const c of P.clips) { c.start = snapF(c.start); c.dur = Math.max(fr(), snapF(c.dur)); }
    commit("Impostazioni sequenza");
    fitMonitor();
  }

  // ------------------------------------------------------------------ esportazione (FFmpeg, mbvisual/video.py)
  async function exportDialog() {
    if (WEB) return toast("L'esportazione video e' disponibile nell'app per PC (usa FFmpeg)", true, 6000);
    if (!P.clips.length) return toast("La sequenza e' vuota", true);
    const fmtSel = el("select", { class: "field", id: "ve-xf" },
      ...[["h264", "H.264 (MP4) - consigliato"], ["h265", "HEVC H.265 (MP4) - file piu' piccoli"], ["webm", "WebM (VP9 + Opus) - web"], ["prores", "QuickTime (MOV ProRes 422) - per altri montaggi"],
        ["mp3", "Solo audio MP3"], ["wav", "Solo audio WAV"], ["m4a", "Solo audio AAC (M4A)"]].map(([v, n]) => el("option", { value: v }, n)));
    const resSel2 = el("select", { class: "field", id: "ve-xr" }, el("option", { value: "" }, `Come la sequenza (${P.settings.w}×${P.settings.h})`),
      ...[[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720], [854, 480]].filter(([a]) => a !== P.settings.w).map(([a, b]) => { const hh = Math.round(a * P.settings.h / P.settings.w / 2) * 2; return el("option", { value: `${a}x${P.settings.w >= P.settings.h ? hh : b}` }, `${a}×${P.settings.w >= P.settings.h ? hh : b}`); }));
    const fpsSel = el("select", { class: "field", id: "ve-xfps" }, el("option", { value: "" }, `Come la sequenza (${fps} fps)`), ...RATES.filter(r => r !== fps).map(r => el("option", { value: r }, r + " fps")));
    const qSel = el("select", { class: "field", id: "ve-xq" }, el("option", { value: "alta" }, "Alta"), el("option", { value: "media" }, "Media"), el("option", { value: "bassa" }, "Bassa (file piccolo)"));
    const rng = el("select", { class: "field", id: "ve-xrange" }, el("option", { value: "all" }, "Intera sequenza"), hasIO() ? el("option", { value: "io", selected: true }, `Da attacco a stacco (${tc(P.outPoint - P.inPoint, fps)})`) : null);
    const loud = el("input", { type: "checkbox", id: "ve-xl" });
    const open = el("input", { type: "checkbox", id: "ve-xo", checked: true });
    const ok = await modal("Impostazioni di esportazione", el("div", { class: "ve-xgrid" },
      el("label", {}, "Formato", fmtSel), el("label", {}, "Risoluzione", resSel2), el("label", {}, "Fotogrammi al secondo", fpsSel), el("label", {}, "Qualita'", qSel), el("label", {}, "Intervallo", rng),
      el("label", { class: "chk" }, loud, "Normalizza il volume generale (EBU R128, -14 LUFS: YouTube, social)"), el("label", { class: "chk" }, open, "Apri il file al termine"),
      el("p", { class: "note" }, "L'esportazione usa FFmpeg con gli stessi effetti, transizioni e fotogrammi chiave dell'anteprima.")),
    [{ label: "Annulla", value: false }, { label: "Esporta...", value: true, primary: true }]);
    if (!ok) return;
    const f = fmtSel.value;
    const ext = { h264: "mp4", h265: "mp4", webm: "webm", prores: "mov", mp3: "mp3", wav: "wav", m4a: "m4a" }[f];
    const name = ctx.name.replace(/\.[^.]+$/, "") + "." + ext;
    const out = await pickSavePath(name, ctx.untitled ? "" : dirName(ctx.path));
    if (!out) return;
    const o = { format: f, quality: qSel.value, loudnorm: loud.checked };
    if (resSel2.value) { const [a, b] = resSel2.value.split("x").map(Number); o.w = a; o.h = b; }
    if (fpsSel.value) o.fps = +fpsSel.value;
    if (rng.value === "io") { o.start = P.inPoint; o.end = P.outPoint; }
    const bar = progressBox("Esportazione: " + baseName(out));
    try {
      // i titoli si disegnano qui (stesso aspetto dell'anteprima) e passano a FFmpeg come immagini PNG
      o.titles = {};
      for (const c of P.clips.filter(z => z.kind === "title" && !z.off)) {
        bar.set(0, "Preparazione dei titoli");
        const cv = renderTitle(c.title);
        const blob = await new Promise(r => cv.toBlob(r, "image/png"));
        const p = (await api("temp_path", { name: `titolo_${c.id}.png` })).path;
        await saveBytes(p, new Uint8Array(await blob.arrayBuffer()));
        o.titles[c.id] = { path: p, w: cv.width, h: cv.height };
      }
      const proj = JSON.parse(snapState());
      proj.tracks.a.forEach(t => { t.gain = (t.gain || 0) + (P.settings.master || 0); });
      const j = await api("video_export", {}, { json: { project: proj, out, opts: o } });
      await waitJob(j.job, (p, m) => bar.set(p, m || "Esportazione"));
      bar.close();
      toast("Esportato: " + baseName(out), false, 5000);
      if (open.checked) ctx.openFile(out);
    } catch (e) {
      bar.close();
      await modal("Esportazione non riuscita", el("div", {}, el("p", {}, e.message), el("p", { class: "note" }, "I dettagli del comando sono in %TEMP%\\MBVisual\\video\\ultima_esportazione.")));
    }
  }
  async function exportFrame() {
    const q0 = player.q;
    player.q = 1;
    player.seek(player.t);
    for (let i = 0; i < 60 && !player.settled(); i++) await new Promise(r => setTimeout(r, 40));
    player.sync(player.t, false); player.render(player.t);
    const cv = player.gl.snapshot();
    player.q = q0; player.dirty = true; player.idle();
    const blob = await new Promise(r => cv.toBlob(r, "image/png"));
    const name = ctx.name.replace(/\.[^.]+$/, "") + "_" + tc(player.t, fps).replace(/:/g, ".") + ".png";
    const out = await pickSavePath(name, ctx.untitled ? "" : dirName(ctx.path));
    if (!out) return;
    await saveBytes(out, new Uint8Array(await blob.arrayBuffer()));
    toast("Fotogramma esportato: " + baseName(out));
  }

  // ------------------------------------------------------------------ menu (come la barra dei menu di Premiere)
  let menuEl = null;
  function closeMenu() { menuEl?.remove(); menuEl = null; document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", menuKey, true); }
  const menuKey = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); } };
  const outside = e => { if (menuEl && !menuEl.contains(e.target) && !e.target.closest?.(".ps-mbtn")) closeMenu(); };
  const prettyKeys = k => (k ? k.split("|")[0].replace(/Shift/g, "Maiusc").replace(/Escape/g, "Esc").replace(/Delete/g, "Canc").replace(/Plus/g, "+").replace(/Minus/g, "-").replace(/ArrowLeft/g, "←").replace(/ArrowRight/g, "→").replace(/ArrowUp/g, "↑").replace(/ArrowDown/g, "↓") : "");
  function buildMenu(items, sub) {
    const m = el("div", { class: "ps-menu" + (sub ? " sub" : "") });
    for (const it of items) {
      if (it === "-") { m.append(el("div", { class: "ps-msep" })); continue; }
      const b = el("button", { type: "button", class: "ps-mit", disabled: it.disabled?.() }, el("span", { class: "ps-mchk" }, it.checked?.() ? "✓" : ""), el("span", { class: "ps-mlab" }, it.label), el("span", { class: "ps-mkey" }, it.sub ? "▸" : prettyKeys(it.keys)));
      if (it.sub) b.addEventListener("pointerenter", () => { m.querySelectorAll(".ps-menu.sub").forEach(x => x.remove()); const sm = buildMenu(it.sub(), true); m.append(sm); sm.style.top = b.offsetTop - 4 + "px"; });
      else { b.addEventListener("pointerenter", () => m.querySelectorAll(":scope > .ps-menu.sub").forEach(x => x.remove())); b.addEventListener("click", () => { closeMenu(); it.run(); }); }
      m.append(b);
    }
    return m;
  }
  function openMenuAt(anchor, items, dir) {
    closeMenu();
    menuEl = buildMenu(items);
    document.body.append(menuEl);
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    menuEl.style.left = Math.min(r.left, innerWidth - 280) + "px";
    if (dir === "up") menuEl.style.bottom = innerHeight - r.top + 2 + "px";
    else { menuEl.style.top = r.bottom + 2 + "px"; const mh = menuEl.offsetHeight; if (r.bottom + mh > innerHeight - 8) menuEl.style.top = Math.max(8, innerHeight - mh - 8) + "px"; }
    setTimeout(() => document.addEventListener("pointerdown", outside, true));
    document.addEventListener("keydown", menuKey, true);
  }
  const noSel = () => !sel.size;
  const MENUS = {
    File: () => [
      { label: "Importa...", keys: "Ctrl+I", run: doImport }, "-",
      { label: "Esporta media...", keys: "Ctrl+M", run: exportDialog }, { label: "Esporta fotogramma...", keys: "Ctrl+Shift+E", run: exportFrame }, "-",
      { label: "Impostazioni sequenza...", run: sequenceSettings },
    ],
    Modifica: () => [
      { label: "Annulla" + (hi > 0 ? " " + history[hi].label : ""), keys: "Ctrl+Z", run: undo, disabled: () => hi <= 0 },
      { label: "Ripeti", keys: "Ctrl+Shift+Z", run: redo, disabled: () => hi >= history.length - 1 }, "-",
      { label: "Taglia", keys: "Ctrl+X", run: () => copySel(true), disabled: noSel }, { label: "Copia", keys: "Ctrl+C", run: () => copySel(false), disabled: noSel },
      { label: "Incolla", keys: "Ctrl+V", run: () => paste(false), disabled: () => !clipboard }, { label: "Incolla inserimento", keys: "Ctrl+Shift+V", run: () => paste(true), disabled: () => !clipboard },
      { label: "Incolla attributi...", keys: "Ctrl+Alt+V", run: pasteAttributes, disabled: () => !clipboard || !sel.size }, "-",
      { label: "Cancella", keys: "Delete", run: clearSel }, { label: "Elimina con ripple", keys: "Shift+Delete", run: rippleDelete }, "-",
      { label: "Seleziona tutto", keys: "Ctrl+A", run: selectAll }, { label: "Deseleziona tutto", keys: "Ctrl+Shift+A", run: deselect },
    ],
    Clip: () => [
      { label: "Velocita'/Durata...", keys: "Ctrl+R", run: speedDialog, disabled: noSel },
      { label: "Opzioni audio", sub: () => [{ label: "Guadagno audio...", keys: "G", run: audioGainDialog }, { label: "Normalizza (picco a -1 dB)", run: () => normalizeAudio([...sel].map(byId).filter(Boolean), -1) }] },
      { label: "Stabilizza (analisi del movimento)...", run: stabilizeClip, disabled: () => ![...sel].some(id => byId(id)?.kind === "video") },
      { label: "Riempi fotogramma", run: () => { const c = [...sel].map(byId).find(x => x && x.kind !== "audio"); if (c) fillFrame(c); }, disabled: noSel }, "-",
      { label: "Abilita", keys: "Shift+E", run: toggleEnable, disabled: noSel, checked: () => sel.size && ![...sel].map(byId)[0]?.off },
      { label: "Collega / Scollega", keys: "Ctrl+L", run: toggleLink, disabled: noSel },
      { label: "Rinomina...", run: async () => { const c = byId([...sel][0]); if (!c) return; const n = await askText("Rinomina clip", "Nome", c.name || ""); if (n) { c.name = n; commit("Rinomina"); } }, disabled: noSel },
      { label: "Mostra nel monitor Sorgente", run: () => { const m = mediaOf(byId([...sel][0])); if (m) openSource(m); }, disabled: noSel },
    ],
    Sequenza: () => [
      { label: "Impostazioni sequenza...", run: sequenceSettings }, "-",
      { label: "Aggiungi modifica", keys: "Ctrl+K", run: () => addEdit(false) }, { label: "Aggiungi modifica a tutte le tracce", keys: "Ctrl+Shift+K", run: () => addEdit(true) },
      { label: "Taglio con ripple della modifica precedente fino alla testina", keys: "Q", run: () => rippleTrimTo(true) },
      { label: "Taglio con ripple della modifica successiva fino alla testina", keys: "W", run: () => rippleTrimTo(false) }, "-",
      { label: "Applica transizione video", keys: "Ctrl+D", run: () => defaultTransition(false) }, { label: "Applica transizione audio", keys: "Ctrl+Shift+D", run: () => defaultTransition(true) }, "-",
      { label: "Solleva", keys: ";", run: liftInOut }, { label: "Estrai", keys: "'", run: extractInOut }, "-",
      { label: "Aggancia in timeline", keys: "S", run: toggleSnap, checked: () => snapOn }, { label: "Selezione collegata", run: () => { linkedSel = !linkedSel; linkBtn.classList.toggle("on", linkedSel); }, checked: () => linkedSel }, "-",
      { label: "Aggiungi traccia video", run: () => { addTrack("v"); commit("Aggiungi traccia"); } }, { label: "Aggiungi traccia audio", run: () => { addTrack("a"); commit("Aggiungi traccia"); } },
    ],
    Marcatori: () => [
      { label: "Contrassegna attacco", keys: "I", run: markIn }, { label: "Contrassegna stacco", keys: "O", run: markOut }, { label: "Contrassegna clip", keys: "X", run: markClip }, "-",
      { label: "Vai ad attacco", keys: "Shift+I", run: () => goto(P.inPoint ?? 0) }, { label: "Vai a stacco", keys: "Shift+O", run: () => goto(P.outPoint ?? total()) }, "-",
      { label: "Cancella attacco", keys: "Ctrl+Shift+I", run: () => { P.inPoint = null; commit("Cancella attacco"); } }, { label: "Cancella stacco", keys: "Ctrl+Shift+O", run: () => { P.outPoint = null; commit("Cancella stacco"); } },
      { label: "Cancella attacco e stacco", keys: "Ctrl+Shift+X", run: () => { P.inPoint = P.outPoint = null; commit("Cancella attacco e stacco"); } }, "-",
      { label: "Aggiungi marcatore", keys: "M", run: addMarker }, { label: "Vai al marcatore successivo", keys: "Shift+M", run: () => gotoMarker(1) }, { label: "Vai al marcatore precedente", keys: "Ctrl+Shift+M", run: () => gotoMarker(-1) },
      { label: "Cancella marcatore selezionato", keys: "Ctrl+Alt+M", run: () => { P.markers = P.markers.filter(m => Math.abs(m.t - player.t) >= fr() / 2); commit("Cancella marcatore"); } },
      { label: "Cancella tutti i marcatori", keys: "Ctrl+Alt+Shift+M", run: () => { P.markers = []; commit("Cancella marcatori"); } },
    ],
    Grafica: () => [{ label: "Nuovo livello: testo", keys: "Ctrl+T", run: () => newTitle() }, { label: "Colore a tinta unita...", run: newColor }],
    Visualizza: () => [
      { label: "Zoom avanti (timeline)", keys: "Plus", run: () => setZoom(pps * 1.5) }, { label: "Zoom indietro (timeline)", keys: "Minus", run: () => setZoom(pps / 1.5) },
      { label: "Adatta la sequenza alla finestra", keys: "\\", run: zoomFit }, "-",
      { label: "Risoluzione riproduzione", sub: () => [[1, "Intera"], [0.5, "1/2"], [0.25, "1/4"]].map(([v, n]) => ({ label: n, checked: () => player.q === v, run: () => { player.q = v; resSel.value = v; player.dirty = true; player.idle(); } })) },
      { label: "Mostra miniature video", checked: () => tRows.showThumbs, run: () => { tRows.showThumbs = !tRows.showThumbs; drawTL(); } },
      { label: "Mostra forme d'onda audio", checked: () => tRows.showWaves, run: () => { tRows.showWaves = !tRows.showWaves; drawTL(); } },
      { label: "Espandi tutte le tracce", run: () => { allTracks().forEach(t => { t.h = 100; }); drawTL(); } }, { label: "Riduci tutte le tracce", run: () => { allTracks().forEach(t => { t.h = 56; }); drawTL(); } },
    ],
    Finestra: () => [
      { label: "Progetto", keys: "Shift+1", run: () => LL.show("project") }, { label: "Sorgente", keys: "Shift+2", run: () => UL.show("source") },
      { label: "Programma / Timeline", keys: "Shift+3", run: () => { focus = "program"; root.focus(); } }, { label: "Controlli effetti", keys: "Shift+5", run: () => UL.show("ec") },
      { label: "Mixer tracce audio", keys: "Shift+6", run: () => UL.show("mixer") }, { label: "Effetti", keys: "Shift+7", run: () => LL.show("effects") },
    ],
  };
  for (const name of Object.keys(MENUS)) {
    const b = el("button", { class: "ps-mbtn", type: "button" }, name);
    b.addEventListener("click", () => (menuEl && menuEl.dataset.m === name ? closeMenu() : (openMenuAt(b, MENUS[name]()), (menuEl.dataset.m = name))));
    b.addEventListener("pointerenter", () => { if (menuEl && menuEl.dataset.m && menuEl.dataset.m !== name) { openMenuAt(b, MENUS[name]()); menuEl.dataset.m = name; } });
    ctx.tb.append(b);
  }
  const tbBtn = (icon, label, title, fn) => { const b = el("button", { type: "button", title, onclick: fn }); b.innerHTML = vIcon(icon, 16); b.append(label); return b; };
  ctx.tb.append(el("span", { class: "sep" }), tbBtn("undo", "", "Annulla (Ctrl+Z)", undo), tbBtn("redo", "", "Ripeti (Ctrl+Maiusc+Z)", redo), el("span", { class: "grow" }),
    tbBtn("import", "Importa", "Importa file multimediali (Ctrl+I)", doImport), tbBtn("export", "Esporta", "Esporta il video con FFmpeg (Ctrl+M)", exportDialog));

  // ------------------------------------------------------------------ tasti di Premiere Pro
  const free = () => !menuEl;
  keymap(ctx, "Premiere Pro", [
    { keys: "Space", desc: "Riproduci / interrompi", run: togglePlay, group: "Riproduzione" },
    { keys: "L", desc: "Riproduci avanti (premuto piu' volte: piu' veloce)", run: () => jkl("L"), group: "Riproduzione" },
    { keys: "K", desc: "Interrompi", run: () => jkl("K"), group: "Riproduzione" },
    { keys: "J", desc: "Riproduci indietro (premuto piu' volte: piu' veloce)", run: () => jkl("J"), group: "Riproduzione" },
    { keys: "ArrowLeft", desc: "Indietro di un fotogramma", run: () => (focus === "source" ? srcSeek(srcVideo.currentTime - fr()) : step(-1)), group: "Riproduzione" },
    { keys: "ArrowRight", desc: "Avanti di un fotogramma", run: () => (focus === "source" ? srcSeek(srcVideo.currentTime + fr()) : step(1)), group: "Riproduzione" },
    { keys: "Shift+ArrowLeft", desc: "Indietro di 5 fotogrammi", run: () => step(-5), group: "Riproduzione" },
    { keys: "Shift+ArrowRight", desc: "Avanti di 5 fotogrammi", run: () => step(5), group: "Riproduzione" },
    { keys: "ArrowUp", desc: "Vai al punto di modifica precedente", run: () => gotoEdit(-1), group: "Riproduzione" },
    { keys: "ArrowDown", desc: "Vai al punto di modifica successivo", run: () => gotoEdit(1), group: "Riproduzione" },
    { keys: "Home", desc: "Vai all'inizio", run: () => goto(0), group: "Riproduzione" },
    { keys: "End", desc: "Vai alla fine", run: () => goto(total()), group: "Riproduzione" },
    { keys: "I", desc: "Contrassegna attacco", run: markIn, group: "Marcatori" },
    { keys: "O", desc: "Contrassegna stacco", run: markOut, group: "Marcatori" },
    { keys: "X", desc: "Contrassegna clip", run: markClip, group: "Marcatori" },
    { keys: "Shift+I", desc: "Vai ad attacco", run: () => (focus === "source" ? srcSeek(src.in ?? 0) : goto(P.inPoint ?? 0)), group: "Marcatori" },
    { keys: "Shift+O", desc: "Vai a stacco", run: () => (focus === "source" ? srcSeek(src.out ?? srcLen()) : goto(P.outPoint ?? total())), group: "Marcatori" },
    { keys: "Ctrl+Shift+I", desc: "Cancella attacco", run: () => { P.inPoint = null; commit("Cancella attacco"); }, group: "Marcatori" },
    { keys: "Ctrl+Shift+O", desc: "Cancella stacco", run: () => { P.outPoint = null; commit("Cancella stacco"); }, group: "Marcatori" },
    { keys: "Ctrl+Shift+X", desc: "Cancella attacco e stacco", run: () => { if (focus === "source") { src.in = src.out = null; drawSrc(); } else { P.inPoint = P.outPoint = null; commit("Cancella attacco e stacco"); } }, group: "Marcatori" },
    { keys: "M", desc: "Aggiungi marcatore", run: addMarker, group: "Marcatori" },
    { keys: "Shift+M", desc: "Vai al marcatore successivo", run: () => gotoMarker(1), group: "Marcatori" },
    { keys: "Ctrl+Shift+M", desc: "Vai al marcatore precedente", run: () => gotoMarker(-1), group: "Marcatori" },
    ...TOOLS.map(([id, name, key]) => ({ keys: key, desc: name, run: () => setTool(id), group: "Strumenti", when: free })),
    { keys: "Ctrl+K", desc: "Aggiungi modifica (dividi alla testina)", run: () => addEdit(false), group: "Montaggio" },
    { keys: "Ctrl+Shift+K", desc: "Aggiungi modifica a tutte le tracce", run: () => addEdit(true), group: "Montaggio" },
    { keys: "Q", desc: "Taglio con ripple della modifica precedente fino alla testina", run: () => rippleTrimTo(true), group: "Montaggio" },
    { keys: "W", desc: "Taglio con ripple della modifica successiva fino alla testina", run: () => rippleTrimTo(false), group: "Montaggio" },
    { keys: "Delete|Backspace", desc: "Cancella (clip, transizione, fotogramma chiave, spazio vuoto)", run: clearSel, group: "Montaggio" },
    { keys: "Shift+Delete|Shift+Backspace|Alt+Backspace", desc: "Elimina con ripple", run: rippleDelete, group: "Montaggio" },
    { keys: ",", desc: "Inserisci (dal monitor Sorgente)", run: () => fromSource(true), group: "Montaggio" },
    { keys: ".", desc: "Sovrascrivi (dal monitor Sorgente)", run: () => fromSource(false), group: "Montaggio" },
    { keys: ";", desc: "Solleva (da attacco a stacco)", run: liftInOut, group: "Montaggio" },
    { keys: "'", desc: "Estrai (da attacco a stacco, con ripple)", run: extractInOut, group: "Montaggio" },
    { keys: "Ctrl+D", desc: "Applica transizione video predefinita (dissolvenza incrociata)", run: () => defaultTransition(false), group: "Montaggio" },
    { keys: "Ctrl+Shift+D", desc: "Applica transizione audio predefinita (potenza costante)", run: () => defaultTransition(true), group: "Montaggio" },
    { keys: "Shift+D", desc: "Applica transizioni predefinite alla selezione", run: () => { defaultTransition(false); defaultTransition(true); }, group: "Montaggio" },
    { keys: "Ctrl+L", desc: "Collega / scollega audio e video", run: toggleLink, group: "Montaggio" },
    { keys: "Ctrl+R", desc: "Velocita'/Durata clip", run: speedDialog, group: "Montaggio" },
    { keys: "G", desc: "Guadagno audio", run: audioGainDialog, group: "Montaggio" },
    { keys: "Shift+E", desc: "Abilita / disabilita clip", run: toggleEnable, group: "Montaggio" },
    { keys: "S", desc: "Aggancia in timeline", run: toggleSnap, group: "Montaggio" },
    { keys: "Ctrl+Z", desc: "Annulla", run: undo, group: "Modifica" },
    { keys: "Ctrl+Shift+Z|Ctrl+Y", desc: "Ripeti", run: redo, group: "Modifica" },
    { keys: "Ctrl+C", desc: "Copia", run: () => copySel(false), group: "Modifica" },
    { keys: "Ctrl+X", desc: "Taglia", run: () => copySel(true), group: "Modifica" },
    { keys: "Ctrl+V", desc: "Incolla", run: () => paste(false), group: "Modifica" },
    { keys: "Ctrl+Shift+V", desc: "Incolla inserimento", run: () => paste(true), group: "Modifica" },
    { keys: "Ctrl+Alt+V", desc: "Incolla attributi", run: pasteAttributes, group: "Modifica" },
    { keys: "Ctrl+A", desc: "Seleziona tutto", run: selectAll, group: "Modifica" },
    { keys: "Ctrl+Shift+A|Escape", desc: "Deseleziona tutto", run: deselect, group: "Modifica" },
    { keys: "Plus|=", desc: "Zoom avanti della timeline", run: () => setZoom(pps * 1.5), group: "Visualizza" },
    { keys: "Minus", desc: "Zoom indietro della timeline", run: () => setZoom(pps / 1.5), group: "Visualizza" },
    { keys: "\\", desc: "Adatta la sequenza alla finestra", run: zoomFit, group: "Visualizza" },
    { keys: "Shift+1", desc: "Pannello Progetto", run: () => LL.show("project"), group: "Finestra" },
    { keys: "Shift+2", desc: "Monitor Sorgente", run: () => UL.show("source"), group: "Finestra" },
    { keys: "Shift+5", desc: "Controlli effetti", run: () => UL.show("ec"), group: "Finestra" },
    { keys: "Shift+6", desc: "Mixer tracce audio", run: () => UL.show("mixer"), group: "Finestra" },
    { keys: "Shift+7", desc: "Pannello Effetti", run: () => LL.show("effects"), group: "Finestra" },
    { keys: "Ctrl+I", desc: "Importa", run: doImport, group: "File" },
    { keys: "Ctrl+M", desc: "Esporta media", run: exportDialog, group: "File" },
    { keys: "Ctrl+Shift+E", desc: "Esporta fotogramma", run: exportFrame, group: "File" },
    { keys: "Ctrl+T", desc: "Nuovo titolo", run: () => newTitle(), group: "Grafica" },
  ]);

  // ------------------------------------------------------------------ aggiornamento dell'interfaccia
  function refreshSel() { drawTL(); renderEC(); drawMonitorOverlay(); status(); }
  function refresh() {
    renderProject(); drawTL(); renderEC(); if (UL.cur === "mixer") renderMixer(); showTime();
    player.dirty = true; player.idle();
    status();
  }
  function status() {
    const n = P.clips.length;
    ctx.status(`Sequenza ${P.settings.w}×${P.settings.h} · ${fps} fps · durata ${tc(total(), fps)} · ${n} clip` + (sel.size ? ` · ${sel.size} selezionate` : ""));
  }
  const ro = new ResizeObserver(() => { fitMonitor(); drawTL(); drawSrc(); });
  ro.observe(root);
  const idleTimer = setInterval(() => { if (root.isConnected && !ctx.tab.view.hidden) player.idle(); }, 120);

  // ------------------------------------------------------------------ avvio
  UL.show("source");
  LL.show("project");
  setTool("select");
  for (const m of P.media) loadMeta(m);
  renderFxLib();
  history = [{ label: "Apri", s: snapState() }]; hi = 0;
  requestAnimationFrame(() => {
    fitMonitor();
    if (P.zoom) { pps = P.zoom; zoomRange.value = (Math.log10(pps) + 1) / 3.6 * 100; } else zoomFit();
    refresh();
    player.seek(player.t);
    status();
    if (opts.openSourceFirst && P.media[0]) openSource(P.media[0]);
  });

  // ------------------------------------------------------------------ interfaccia verso app.js
  function serialize(target) {
    const dir = dirName(target);
    const out = JSON.parse(snapState());
    out.mbvid = 1;
    out.app = "MB Visual";
    out.playhead = player.t; out.zoom = pps;
    for (const m of out.media) { delete m.offline; m.rel = relPath(dir, m.path); }
    return JSON.stringify(out, null, 1);
  }
  return {
    saveFormats: ["mbvid"],
    saveLabels: { mbvid: "Progetto video MB Visual" },
    saveNote: "Per creare il file video usa Esporta (Ctrl+M): qui si salva il progetto di montaggio.",
    async save(target) {
      await saveBytes(target, new TextEncoder().encode(serialize(target)));
      return {};
    },
    async acceptDrop(paths) { await importPaths(paths); return true; },
    onShow() { setTimeout(() => { fitMonitor(); drawTL(); player.dirty = true; player.idle(); }, 0); },
    onBack() { if (sel.size || selTr) { deselect(); return true; } return false; },
    dispose() { clearInterval(idleTimer); ro.disconnect(); player.dispose(); srcVideo.pause(); srcVideo.removeAttribute("src"); closeMenu(); },
    _ve: { P, player, importPaths, placeMedia, addTransition, razorAt, commit, setTool, goto, exportDialog, newTitle, get sel() { return sel; }, set sel(v) { sel = v; refreshSel(); }, drawTL, rippleDelete, addEdit, normalizeAudio, undo, redo },
  };
}

// percorso relativo (per ritrovare i file se la cartella del progetto viene spostata)
export function relPath(fromDir, p) {
  const a = fromDir.replace(/\//g, "\\").split("\\").filter(Boolean), b = p.replace(/\//g, "\\").split("\\").filter(Boolean);
  if (!a.length || !b.length || a[0].toLowerCase() !== b[0].toLowerCase()) return null;
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("\\");
}
