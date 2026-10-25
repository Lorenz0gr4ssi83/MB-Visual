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
import { t as _t, LOCALE } from "./i18n.js";

const RULER = 26;
const HEAD_W = 172;
const KIND_COLOR = { video: "#7d73c4", audio: "#4f9b5c", image: "#a86bb8", title: "#c46a8f", color: "#7f8a92" };
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "tif", "tiff", "avif", "heic", "heif", "psd", "ico", "svg"]);
const TOOLS = [
  ["select", _t("videdit.strumento_selezione"), "V"], ["trackfwd", _t("videdit.strumento_selezione_traccia_avanti"), "A"], ["ripple", _t("videdit.strumento_modifica_ripple"), "B"],
  ["rolling", _t("videdit.strumento_modifica_rullo"), "N"], ["rate", _t("videdit.strumento_allungamento_velocita"), "R"], ["razor", _t("videdit.strumento_lama_rasoio"), "C"],
  ["slip", _t("videdit.strumento_slittamento"), "Y"], ["slide", _t("videdit.strumento_scorrimento"), "U"], ["pen", _t("videdit.strumento_penna_fotogrammi_chiave"), "P"],
  ["hand", _t("videdit.strumento_mano"), "H"], ["zoom", _t("videdit.strumento_zoom"), "Z"], ["type", _t("videdit.strumento_testo"), "T"],
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
  const splitV = el("div", { class: "ve-split-v", title: _t("videdit.trascina_ridimensionare") });
  const prog = el("section", { class: "ve-panel ve-prog" });
  const splitH = el("div", { class: "ve-split-h", title: _t("videdit.trascina_ridimensionare") });
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
  const UL = tabGroup(tabsUL, bodyUL, [{ id: "source", name: _t("videdit.sorgente"), cls: "ve-src" }, { id: "ec", name: _t("videdit.controlli_effetti"), cls: "ve-ec", onShow: () => renderEC() }, { id: "mixer", name: _t("videdit.mixer_tracce_audio"), cls: "ve-mixer", onShow: () => renderMixer() }]);
  const LL = tabGroup(tabsLL, bodyLL, [{ id: "project", name: _t("videdit.progetto"), cls: "ve-proj" }, { id: "effects", name: _t("videdit.effetti"), cls: "ve-fxlib" }]);

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
  const undo = () => { if (hi > 0) { const l = history[hi].label; hi--; restore(history[hi].s); ctx.status(_t("videdit.annullato") + l); } };
  const redo = () => { if (hi < history.length - 1) { hi++; restore(history[hi].s); ctx.status(_t("videdit.ripetuto") + history[hi].label); } };

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
      if (!kind) { toast(_t("videdit.0_non_contiene_audio_video", baseName(path)), true); continue; }
      const m = { id: uid("m"), path, name: baseName(path), kind, dur: kind === "image" ? null : i.dur, w: i.w, h: i.h, fps: i.fps, audio: kind !== "image" && !!i.audio };
      P.media.push(m);
      added.push(m);
      loadMeta(m);
    }
    if (added.length && !silent) commit(_t("videdit.importa"));
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
  const progTc = el("span", { class: "ve-tc ve-tc-main", title: _t("videdit.posizione_testina_clic_digitare_timecode") });
  const progDur = el("span", { class: "ve-tc ve-tc-dur", title: _t("videdit.durata_sequenza_attacco_stacco") });
  const resSel = el("select", { class: "ve-sel", id: "ve-res-" + ctx.tab.name, title: _t("videdit.risoluzione_riproduzione"), onchange: () => { player.q = +resSel.value; player.dirty = true; player.idle(); } },
    ...[[1, _t("videdit.intera")], [0.5, "1/2"], [0.25, "1/4"]].map(([v, n]) => el("option", { value: v }, n)));
  const zoomSel = el("select", { class: "ve-sel", id: "ve-zoom-" + ctx.tab.name, title: _t("videdit.zoom_monitor"), onchange: () => fitMonitor() },
    ...[["fit", _t("videdit.adatta")], [0.25, "25%"], [0.5, "50%"], [1, "100%"]].map(([v, n]) => el("option", { value: v }, n)));
  const tbtn = (icon, title, fn, cls = "") => { const b = el("button", { class: "ve-tbtn " + cls, type: "button", title, onclick: fn }); b.innerHTML = vIcon(icon); return b; };
  const playBtn = tbtn("play", "Riproduci/Interrompi (Spazio)", () => { focus = "program"; togglePlay(); }, "ve-play");
  prog.append(el("div", { class: "ve-ptabs" }, el("span", { class: "ve-ptab on" }, _t("videdit.programma_sequenza"))), progStage,
    el("div", { class: "ve-mbar" }, progTc, el("span", { class: "grow" }), zoomSel, resSel, el("span", { class: "grow" }), progDur),
    el("div", { class: "ve-transport" },
      tbtn("marker", _t("videdit.aggiungi_marcatore_m"), () => addMarker()), tbtn("markIn", _t("videdit.contrassegna_attacco_i"), () => markIn()), tbtn("markOut", _t("videdit.contrassegna_stacco"), () => markOut()),
      el("span", { class: "ve-tsep" }),
      tbtn("goIn", _t("videdit.vai_ad_attacco_maiusc_i"), () => goto(P.inPoint ?? 0)), tbtn("stepBack", _t("videdit.indietro_fotogramma_freccia_sinistra"), () => step(-1)), playBtn,
      tbtn("stepFwd", _t("videdit.avanti_fotogramma_freccia_destra"), () => step(1)), tbtn("goOut", _t("videdit.vai_stacco_maiusc"), () => goto(P.outPoint ?? total())),
      el("span", { class: "ve-tsep" }),
      tbtn("lift", "Solleva (;)", () => liftInOut()), tbtn("extract", _t("videdit.estrai"), () => extractInOut()), tbtn("camera", _t("videdit.esporta_fotogramma_ctrl_maiusc"), () => exportFrame())));
  progStage.addEventListener("pointerdown", () => { focus = "program"; });
  progTc.addEventListener("click", async () => { const v = await askText(_t("videdit.vai_timecode"), "Timecode (hh:mm:ss:ff)", tc(player.t, fps)); const t = v && parseTc(v, fps); if (t !== null && t !== undefined && !isNaN(t)) goto(t); });

  let player;
  try {
    player = new Player(() => P, progCanvas, {
      onTime: (t, stopped) => { P.playhead = t; showTime(); followPlayhead(); if (stopped) { playBtn.innerHTML = vIcon("play"); drawOverlay(); } },
      onMeter: v => drawMeters(v),
      end: () => (P.outPoint !== null && P.outPoint !== undefined && player.t < P.outPoint ? P.outPoint : total()),
      onBusy: m => ctx.status(_t("videdit.conformazione_0_l_anteprima", m.name)),
      onProgress: (m, p) => ctx.status(_t("videdit.conformazione_0_1", m.name, Math.round(p * 100))),
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
    ctx.status(_t("videdit.riproduzione_0_1", shuttle > 0 ? "avanti" : "indietro", Math.abs(shuttle)));
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
    const up = () => { progStage.removeEventListener("pointermove", mv); progStage.removeEventListener("pointerup", up); commit(h === "rot" ? _t("videdit.rotazione") : h ? _t("videdit.scala") : _t("videdit.posizione")); };
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
  const srcEmpty = el("div", { class: "ve-empty" }, _t("videdit.fai_doppio_clic_elemento_pannello"));
  const srcStage = el("div", { class: "ve-stage" }, srcVideo, srcImg, srcWave, srcEmpty);
  const srcBar = el("canvas", { class: "ve-srcbar", title: _t("videdit.clic_trascina_scorrere_i_impostano") });
  const srcTc = el("span", { class: "ve-tc ve-tc-main" }), srcDur = el("span", { class: "ve-tc ve-tc-dur" });
  const srcName = el("span", { class: "ve-srcname" });
  const srcPlay = tbtn("play", "Riproduci/Interrompi (Spazio)", () => { focus = "source"; toggleSource(); }, "ve-play");
  const dragBtn = el("button", { class: "ve-tbtn ve-dragsrc", type: "button", title: _t("videdit.trascina_timeline_video_audio") });
  dragBtn.innerHTML = vIcon("film") + vIcon("audio");
  UL.body("source").append(el("div", { class: "ve-srchead" }, srcName), srcStage, srcBar,
    el("div", { class: "ve-mbar" }, srcTc, el("span", { class: "grow" }), dragBtn, el("span", { class: "grow" }), srcDur),
    el("div", { class: "ve-transport" },
      tbtn("markIn", _t("videdit.contrassegna_attacco_i"), () => { focus = "source"; srcMark("in"); }), tbtn("markOut", _t("videdit.contrassegna_stacco"), () => { focus = "source"; srcMark("out"); }),
      el("span", { class: "ve-tsep" }),
      tbtn("goIn", _t("videdit.vai_ad_attacco_maiusc_i"), () => srcSeek(src.in ?? 0)), tbtn("stepBack", _t("videdit.indietro_fotogramma"), () => srcSeek(srcVideo.currentTime - fr())), srcPlay,
      tbtn("stepFwd", _t("videdit.avanti_fotogramma"), () => srcSeek(srcVideo.currentTime + fr())), tbtn("goOut", _t("videdit.vai_stacco_maiusc"), () => srcSeek(src.out ?? srcLen())),
      el("span", { class: "ve-tsep" }),
      tbtn("insert", _t("videdit.inserisci"), () => fromSource(true)), tbtn("overwrite", _t("videdit.sovrascrivi"), () => fromSource(false))));
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
    if (!src.m) return toast(_t("videdit.apri_prima_elemento_monitor_sorgente"), true);
    const a = src.in ?? 0, b = src.out ?? srcLen();
    placeMedia(src.m, player.t, P.srcV, P.srcA, insert, { in: a, dur: b - a });
    goto(player.t + (b - a));
  }
  dragBtn.addEventListener("pointerdown", e => { if (src.m) startMediaDrag(e, src.m, { in: src.in ?? 0, dur: (src.out ?? srcLen()) - (src.in ?? 0) }); });

  // ------------------------------------------------------------------ pannello Progetto
  let projView = "icons";
  const projList = el("div", { class: "ve-projlist" });
  const projBar = el("div", { class: "ve-pfoot" },
    tbtn("list", _t("videdit.vista_elenco"), () => { projView = "list"; renderProject(); }), tbtn("icons", _t("videdit.vista_icone"), () => { projView = "icons"; renderProject(); }),
    el("span", { class: "grow" }),
    tbtn("import", _t("videdit.importa_ctrl_i"), doImport), tbtn("newItem", _t("videdit.nuovo_elemento_titolo_colore"), e => openMenuAt(e.currentTarget, [
      { label: _t("videdit.titolo"), keys: "Ctrl+T", run: () => newTitle() }, { label: _t("videdit.colore_tinta_unita"), run: () => newColor() }], "up")),
    tbtn("trash", _t("videdit.elimina_elementi_selezionati_canc"), () => deleteMedia()));
  const projSearch = el("input", { type: "search", class: "ve-search", id: "ve-psearch-" + ctx.tab.name, placeholder: _t("videdit.cerca_progetto"), oninput: () => renderProject() });
  LL.body("project").append(el("div", { class: "ve-phead" }, el("span", { class: "ve-projname" }, ctx.name), projSearch), projList, projBar);
  let projSel = new Set();
  function renderProject() {
    projList.innerHTML = "";
    projList.className = "ve-projlist " + (projView === "list" ? "list" : "icons");
    const q = projSearch.value.trim().toLowerCase();
    const items = P.media.filter(m => !q || m.name.toLowerCase().includes(q));
    if (!items.length) projList.append(el("div", { class: "ve-empty" }, q ? _t("videdit.nessun_elemento_corrisponde") : _t("videdit.importa_file_multimediali_ctrl_i")));
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
      const row = el("div", { class: "ve-pitem" + (projSel.has(m.id) ? " on" : "") + (m.offline ? " offline" : ""), title: m.path + (m.offline ? _t("videdit.supporto_non_linea_clic_destro") : "") },
        pic, el("span", { class: "ve-pname" }, m.name),
        el("span", { class: "ve-pmeta" }, (m.kind === "image" ? _t("videdit.immagine") : tc(m.dur || 0, fps)) + (m.w ? ` · ${m.w}×${m.h}` : "") + (m.fps && m.kind === "video" ? ` · ${m.fps} fps` : "") + (used ? _t("videdit.usato_0", used) : "")));
      row.addEventListener("pointerdown", e => {
        if (e.button === 2) return;
        if (e.ctrlKey) { projSel.has(m.id) ? projSel.delete(m.id) : projSel.add(m.id); } else if (!projSel.has(m.id)) projSel = new Set([m.id]);
        renderProject();
        startMediaDrag(e, m, null);
      });
      row.addEventListener("dblclick", () => openSource(m));
      row.addEventListener("contextmenu", e => { e.preventDefault(); projSel = new Set([m.id]); renderProject(); openMenuAt({ x: e.clientX, y: e.clientY }, [
        { label: _t("videdit.apri_monitor_sorgente"), run: () => openSource(m) }, { label: _t("videdit.aggiungi_timeline_testina"), run: () => placeMedia(m, player.t, P.srcV, P.srcA, false) },
        { label: _t("videdit.rinomina"), run: async () => { const n = await askText(_t("common.rinomina"), _t("common.nome"), m.name); if (n) { m.name = n; commit(_t("common.rinomina")); } } },
        { label: _t("videdit.collega_supporto"), run: () => relink(m) }, "-", { label: _t("common.elimina"), run: () => deleteMedia() }]); });
      projList.append(row);
    }
  }
  async function deleteMedia() {
    const ids = [...projSel];
    if (!ids.length) return;
    const used = P.clips.filter(c => ids.includes(c.media));
    if (used.length && !(await confirmBox(_t("videdit.elimina_progetto"), _t("videdit.elementi_sono_usati_0_clip", used.length), _t("common.elimina"), true))) return;
    used.forEach(removeClip);
    P.media = P.media.filter(m => !ids.includes(m.id));
    projSel.clear();
    commit(_t("videdit.elimina_elementi"));
  }
  async function relink(m) {
    const ps = await pickFiles();
    if (!ps?.length) return;
    m.path = ps[0]; m.name = baseName(ps[0]); delete m.offline;
    player.forget(m.id); wave.delete(m.id); thumbs.delete(m.id);
    loadMeta(m);
    commit(_t("videdit.collega_supporto_2"));
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
    if (m.offline) return toast(_t("videdit.supporto_non_linea_collegalo_prima"), true);
    if (m.kind === "video" && !P.clips.some(c => c.kind === "video") && m.w && (m.w !== P.settings.w || m.h !== P.settings.h || (m.fps && Math.abs(m.fps - fps) > 0.01))) {
      const r = await modal(_t("videdit.avviso_mancata_corrispondenza_clip"), el("p", {}, _t("videdit.clip_0_1_2_fps", m.w, m.h, m.fps, P.settings.w, P.settings.h, fps)),
        [{ label: _t("videdit.mantieni_impostazioni_attuali"), value: "keep" }, { label: _t("videdit.cambia_impostazioni_sequenza"), value: "change", primary: true }]);
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
    commit(insert ? _t("videdit.inserisci_2") : _t("videdit.sovrascrivi_2"));
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
    const c = { id: uid("c"), kind: "title", track: tid, start: t, dur: d, in: 0, speed: 1, name: _t("videdit.titolo"), title: defaultTitle(),
      motion: { x: x ?? P.settings.w / 2, y: y ?? P.settings.h * 0.8, scale: 100, rot: 0 }, opacity: 100, blend: "normal", fx: [], kf: {} };
    c.title.size = Math.round(P.settings.h / 11);
    P.clips.push(c);
    sel = new Set([c.id]); selTr = null;
    commit(_t("videdit.nuovo_titolo"));
    UL.show("ec");
    setTimeout(() => { const ta = UL.body("ec").querySelector("textarea"); ta?.focus(); ta?.select(); }, 30);
    setTool("select");
  }
  async function newColor() {
    const inp = el("input", { type: "color", value: "#1a4f8c", id: "ve-newcolor" });
    const v = await modal(_t("videdit.colore_tinta_unita_2"), el("label", { style: { display: "flex", gap: "10px", alignItems: "center" } }, _t("common.colore"), inp), [{ label: _t("common.annulla"), value: null }, { label: "OK", primary: true, value: () => inp.value }]);
    if (!v) return;
    const t = snapF(player.t), tid = freeVideoTrack(t, t + 5);
    const c = { id: uid("c"), kind: "color", track: tid, start: t, dur: 5, in: 0, speed: 1, name: _t("videdit.colore") + v, color: v, motion: defMotion(), opacity: 100, blend: "normal", fx: [], kf: {} };
    P.clips.push(c);
    sel = new Set([c.id]);
    commit(_t("videdit.colore_tinta_unita_2"));
  }

  // ------------------------------------------------------------------ pannello Effetti (libreria)
  const fxSearch = el("input", { type: "search", class: "ve-search", id: "ve-fxsearch-" + ctx.tab.name, placeholder: _t("videdit.cerca_effetti_transizioni"), oninput: () => renderFxLib() });
  const fxTree = el("div", { class: "ve-fxtree" });
  LL.body("effects").append(el("div", { class: "ve-phead" }, fxSearch), fxTree);
  const fxOpen = new Set([_t("videdit.effetti_video"), _t("videdit.transizioni_video"), _t("videdit.effetti_audio"), _t("videdit.transizioni_audio")]);
  function renderFxLib() {
    fxTree.innerHTML = "";
    const q = fxSearch.value.trim().toLowerCase();
    const sections = [
      [_t("videdit.effetti_video"), Object.entries(EFFECTS).map(([k, e]) => ({ kind: "vfx", k, name: e.name, group: e.group }))],
      [_t("videdit.transizioni_video"), Object.entries(TRANSITIONS).map(([k, e]) => ({ kind: "vtr", k, name: e.name, group: e.group }))],
      [_t("videdit.effetti_audio"), [{ kind: "afx", k: "normalize", name: _t("videdit.normalizza_picco_1_db"), group: _t("videdit.ampiezza") }, { kind: "afx", k: "gain", name: _t("videdit.guadagno_audio"), group: _t("videdit.ampiezza") }]],
      [_t("videdit.transizioni_audio"), Object.entries(AUDIO_TRANSITIONS).map(([k, e]) => ({ kind: "atr", k, name: e.name, group: e.group }))],
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
          const it = el("div", { class: "ve-fxitem", title: i.kind.endsWith("tr") ? _t("videdit.trascina_punto_modifica_estremita_clip") : _t("videdit.trascina_clip_doppio_clic_applica") });
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
    if (!targets.length) return toast(_t("videdit.seleziona_prima_clip_timeline"), true);
    if (i.kind === "vfx") {
      const vt = targets.filter(c => c.kind !== "audio");
      if (!vt.length) return toast(_t("videdit.effetti_video_vanno_clip_video"), true);
      for (const c of vt) { c.fx = c.fx || []; c.fx.push({ type: i.k, on: true, p: Object.fromEntries(EFFECTS[i.k].params.map(p => [p.k, p.d])) }); }
      sel = new Set(vt.map(c => c.id));
      commit(_t("videdit.applica") + i.name);
      UL.show("ec");
      if (i.k === "lut") pickLut(vt[0], vt[0].fx.length - 1);
    } else if (i.kind === "afx") {
      const at = targets.filter(c => c.kind === "audio");
      if (!at.length) return toast(_t("videdit.seleziona_clip_audio"), true);
      sel = new Set(at.map(c => c.id));
      if (i.k === "normalize") normalizeAudio(at, -1); else audioGainDialog();
    } else {
      const audio = i.kind === "atr";
      const ok = targets.filter(c => (c.kind === "audio") === audio);
      if (!ok.length) return toast(audio ? _t("videdit.transizioni_audio_vanno_sulle_clip") : _t("videdit.transizioni_video_vanno_sulle_clip"), true);
      for (const c of ok) addTransition(c, side || (clip ? "in" : nearSide(c)), i.k);
      commit(_t("videdit.applica") + i.name);
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
    if (done) commit(audio ? _t("videdit.applica_transizione_audio") : _t("videdit.applica_transizione_video")); else toast(_t("videdit.nessuna_clip_sulle_tracce_destinazione"), true);
  }

  // ------------------------------------------------------------------ Controlli effetti
  const ecBox = UL.body("ec");
  const ecRefs = [];
  function scrub(get, set, o = {}) {
    // valore trascinabile (come i numeri blu di Premiere): trascina a destra/sinistra, clic per digitare
    const s = el("span", { class: "ve-scrub", tabindex: "0", title: _t("videdit.trascina_cambiare_clic_digitare") + (o.title ? "\n" + o.title : "") });
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
    const watch = el("button", { class: "ve-watch" + (anim() ? " on" : ""), type: "button", title: _t("videdit.attiva_disattiva_animazione_fotogrammi_chiave") });
    watch.innerHTML = vIcon("watch", 15);
    watch.addEventListener("click", () => {
      c.kf = c.kf || {};
      const tau = clamp(snapF(player.t - c.start), 0, c.dur);
      if (anim()) { for (const p of props) { const v = propAt(c, p, tau); delete c.kf[p]; setProp(c, p, v); } commit(_t("videdit.animazione_disattivata")); }
      else { for (const p of props) c.kf[p] = [[tau, propAt(c, p, tau)]]; commit(_t("videdit.animazione_attivata")); }
      renderEC();
    });
    const nav = el("span", { class: "ve-kfnav" });
    if (anim()) {
      const times = () => [...new Set(props.flatMap(p => (c.kf?.[p] || []).map(k => k[0])))].sort((a, b) => a - b);
      const tau = () => player.t - c.start;
      const on = () => times().some(t => Math.abs(t - tau()) < fr() / 2);
      const kb = el("button", { class: "ve-kfbtn", type: "button", title: _t("videdit.aggiungi_rimuovi_fotogramma_chiave") });
      const paint = () => { kb.innerHTML = vIcon(on() ? "kf" : "kfOff", 13); };
      paint(); ecRefs.push(paint);
      kb.addEventListener("click", () => {
        const t = clamp(snapF(tau()), 0, c.dur);
        if (on()) for (const p of props) c.kf[p] = c.kf[p].filter(k => Math.abs(k[0] - t) >= fr() / 2);
        else for (const p of props) { const v = propAt(c, p, t); c.kf[p].push([t, v]); c.kf[p].sort((a, b) => a[0] - b[0]); }
        for (const p of props) if (!c.kf[p].length) { delete c.kf[p]; }
        commit(_t("videdit.fotogramma_chiave")); renderEC();
      });
      const go = d => { const ts = times(), cur = tau(); const t = d < 0 ? [...ts].reverse().find(x => x < cur - fr() / 2) : ts.find(x => x > cur + fr() / 2); if (t !== undefined) goto(c.start + t); };
      const pb = el("button", { class: "ve-kfbtn", type: "button", title: _t("videdit.vai_fotogramma_chiave_precedente"), onclick: () => go(-1) }); pb.innerHTML = vIcon("prev", 12);
      const nb = el("button", { class: "ve-kfbtn", type: "button", title: _t("videdit.vai_fotogramma_chiave_successivo"), onclick: () => go(1) }); nb.innerHTML = vIcon("next", 12);
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
  function propScrub(c, p, o) { return scrub(() => propAt(c, p, player.t - c.start) ?? 0, (v, done) => { setProp(c, p, v); if (done) commit(o.label || _t("videdit.modifica")); else live(); }, o); }
  function renderEC() {
    if (UL.cur !== "ec") return;
    ecBox.innerHTML = "";
    ecRefs.length = 0;
    const tr = selTr && P.transitions.find(t => t.id === selTr);
    if (tr) return renderTransitionEC(tr);
    const cs = [...sel].map(byId).filter(Boolean);
    const main = cs.length === 1 ? cs[0] : cs.length === 2 && cs[0].link && cs[0].link === cs[1].link ? cs.find(c => c.kind !== "audio") : null;
    if (!main) { ecBox.append(el("div", { class: "ve-empty" }, cs.length ? _t("videdit.0_clip_selezionate_selezionane_vederne", cs.length) : _t("videdit.seleziona_clip_timeline_vederne_effetti"))); return; }
    const c = main;
    ecBox.append(el("div", { class: "ve-ectop" }, el("b", {}, c.name || _t("videdit.clip")), el("span", { class: "ve-muted" }, ` · ${tc(c.start, fps)} - ${tc(end(c), fps)}`)));
    if (c.kind === "audio") {
      const [s, b] = ecSection(_t("videdit.volume"), [smallBtn("reset", _t("videdit.ripristina"), () => { c.volume = 0; delete c.kf?.volume; commit(_t("videdit.ripristina_volume")); renderEC(); })]);
      b.append(kfRow(c, _t("videdit.livello"), ["volume"], [propScrub(c, "volume", { min: -60, max: 15, step: 0.1, unit: " dB", label: _t("videdit.livello") })]));
      b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, _t("videdit.guadagno_clip")),
        el("span", { class: "ve-ecval" }, scrub(() => c.gain || 0, (v, d) => { c.gain = v; if (d) commit(_t("videdit.guadagno")); else live(); }, { min: -60, max: 30, step: 0.1, unit: " dB" }),
          el("button", { class: "ve-mini", type: "button", onclick: () => normalizeAudio([c], -1) }, _t("videdit.normalizza"))), el("span")));
      ecBox.append(s);
      ecBox.append(speedSection(c));
      return;
    }
    if (c.kind === "title") ecBox.append(titleSection(c));
    if (c.kind === "color") {
      const [s, b] = ecSection(_t("common.colore"));
      b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, _t("common.colore")), el("span", { class: "ve-ecval" },
        el("input", { type: "color", value: c.color, id: "ve-col-" + c.id, onchange: e => { c.color = e.target.value; c.name = _t("videdit.colore") + c.color; commit(_t("common.colore")); } })), el("span")));
      ecBox.append(s);
    }
    {
      const [s, b] = ecSection(_t("videdit.movimento"), [smallBtn("reset", _t("videdit.ripristina_posizione_scala_rotazione"), () => { c.motion = defMotion(); for (const p of ["x", "y", "scale", "rot"]) delete c.kf?.[p]; commit(_t("videdit.ripristina_movimento")); renderEC(); })]);
      b.append(kfRow(c, _t("videdit.posizione"), ["x", "y"], [propScrub(c, "x", { step: 1, label: _t("videdit.posizione"), fmt: v => Math.round(v * 10) / 10 }), propScrub(c, "y", { step: 1, label: _t("videdit.posizione"), fmt: v => Math.round(v * 10) / 10 })]));
      b.append(kfRow(c, _t("videdit.scala"), ["scale"], [propScrub(c, "scale", { min: 0, max: 1000, step: 0.5, label: _t("videdit.scala"), unit: "%" })]));
      b.append(kfRow(c, _t("videdit.rotazione"), ["rot"], [propScrub(c, "rot", { step: 0.5, label: _t("videdit.rotazione"), unit: "°" })]));
      b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }), el("span", { class: "ve-ecval" },
        el("button", { class: "ve-mini", type: "button", title: _t("videdit.scala_riempire_fotogramma_senza_bande"), onclick: () => { fillFrame(c); } }, _t("videdit.riempi_fotogramma")),
        el("button", { class: "ve-mini", type: "button", title: _t("videdit.riquadro_basso_destra_picture_picture"), onclick: () => { setProp(c, "scale", 35); setProp(c, "x", Math.round(P.settings.w * 0.78)); setProp(c, "y", Math.round(P.settings.h * 0.76)); commit(_t("videdit.picture_picture")); renderEC(); } }, "PiP")), el("span")));
      ecBox.append(s);
    }
    {
      const [s, b] = ecSection(_t("videdit.opacita"), [smallBtn("reset", _t("videdit.ripristina"), () => { c.opacity = 100; c.blend = "normal"; delete c.kf?.opacity; commit(_t("videdit.ripristina_opacita")); renderEC(); })]);
      b.append(kfRow(c, _t("videdit.opacita"), ["opacity"], [propScrub(c, "opacity", { min: 0, max: 100, step: 0.5, label: _t("videdit.opacita"), unit: "%" })]));
      b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, _t("videdit.metodo_fusione")), el("span", { class: "ve-ecval" },
        el("select", { class: "ve-sel", id: "ve-blend-" + c.id, onchange: e => { c.blend = e.target.value; commit(_t("videdit.metodo_fusione")); } }, ...Object.entries(BLENDS).map(([k, n]) => el("option", { value: k, selected: (c.blend || "normal") === k }, n)))), el("span")));
      ecBox.append(s);
    }
    if (c.kind === "video") ecBox.append(speedSection(c));
    (c.fx || []).forEach((e, i) => ecBox.append(fxSection(c, e, i)));
    ecBox.append(el("div", { class: "ve-ecnote" }, _t("videdit.aggiungi_effetti_pannello_effetti_trascinali")));
  }
  function speedSection(c) {
    const [s, b] = ecSection(_t("videdit.rimappatura_tempo"), [], false);
    b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, _t("videdit.velocita")), el("span", { class: "ve-ecval" },
      el("span", {}, Math.round((c.speed || 1) * 1000) / 10 + "%"), el("button", { class: "ve-mini", type: "button", onclick: () => speedDialog() }, _t("videdit.velocita_durata"))), el("span")));
    return s;
  }
  function fillFrame(c) {
    const m = mediaOf(c);
    const sw = m?.w || P.settings.w, sh = m?.h || P.settings.h;
    const f = Math.min(P.settings.w / sw, P.settings.h / sh), g = Math.max(P.settings.w / sw, P.settings.h / sh);
    setProp(c, "scale", Math.round(g / f * 1000) / 10);
    setProp(c, "x", P.settings.w / 2); setProp(c, "y", P.settings.h / 2);
    commit(_t("videdit.riempi_fotogramma")); renderEC();
  }
  function titleSection(c) {
    const T = c.title;
    const [s, b] = ecSection(_t("videdit.testo"));
    const upd = (k, v, done = true) => { T[k] = v; if (done) commit(_t("videdit.testo")); else live(); };
    const ta = el("textarea", { class: "ve-ta", id: "ve-ta-" + c.id, rows: 3 }, T.text);
    ta.addEventListener("input", () => { T.text = ta.value; c.name = ta.value.split("\n")[0].slice(0, 40) || _t("videdit.titolo"); live(); });
    ta.addEventListener("change", () => commit(_t("videdit.testo")));
    ta.addEventListener("keydown", e => e.stopPropagation());
    b.append(ta);
    const font = el("select", { class: "ve-sel", id: "ve-font-" + c.id, onchange: e => upd("font", e.target.value) }, ...FONTS.map(f => el("option", { value: f, selected: f === T.font, style: { fontFamily: f } }, f)));
    const tog = (k, label, title) => el("button", { class: "ve-mini" + (T[k] ? " on" : ""), type: "button", title, onclick: () => { upd(k, !T[k]); renderEC(); } }, label);
    const al = a => el("button", { class: "ve-mini" + (T.align === a ? " on" : ""), type: "button", title: { left: _t("videdit.allinea_sinistra"), center: _t("videdit.centra"), right: _t("videdit.allinea_destra") }[a], onclick: () => { upd("align", a); renderEC(); } }, { left: "⯇", center: "≡", right: "⯈" }[a]);
    const color = (k, id) => el("input", { type: "color", value: T[k], id: `ve-${id}-${c.id}`, oninput: e => upd(k, e.target.value, false), onchange: e => upd(k, e.target.value) });
    const row = (label, ...ctl) => el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, label), el("span", { class: "ve-ecval" }, ...ctl), el("span"));
    b.append(row(_t("videdit.carattere"), font), row(_t("videdit.dimensione"), scrub(() => T.size, (v, d) => upd("size", v, d), { min: 4, max: 1000, step: 1, unit: " px" }), tog("bold", "G", _t("videdit.grassetto")), tog("italic", "C", _t("videdit.corsivo"))),
      row(_t("videdit.allineamento"), al("left"), al("center"), al("right")), row(_t("videdit.riempimento"), color("color", "tc")),
      row(_t("videdit.traccia"), tog("stroke", _t("videdit.si"), _t("videdit.contorno_testo")), color("strokeColor", "sc"), scrub(() => T.strokeW, (v, d) => upd("strokeW", v, d), { min: 0, max: 60, step: 0.5, unit: " px" })),
      row(_t("videdit.ombra"), tog("shadow", _t("videdit.si"), _t("videdit.ombra_esterna")), color("shadowColor", "shc")),
      row(_t("videdit.sfondo"), tog("bg", _t("videdit.si"), _t("videdit.rettangolo_dietro_testo")), color("bgColor", "bc"), scrub(() => T.bgOpacity ?? 60, (v, d) => upd("bgOpacity", v, d), { min: 0, max: 100, step: 1, unit: "%" })));
    return s;
  }
  function fxSection(c, e, i) {
    const def = EFFECTS[e.type];
    const onBtn = el("button", { class: "ve-fxon" + (e.on === false ? "" : " on"), type: "button", title: _t("videdit.attiva_disattiva_effetto") });
    onBtn.innerHTML = vIcon("fx", 15);
    onBtn.addEventListener("click", () => { e.on = e.on === false; commit(_t("videdit.effetto_attivo_disattivo")); renderEC(); });
    const [s, b] = ecSection(def?.name || e.type, [
      smallBtn("prev", _t("videdit.sposta_sopra"), () => { if (i > 0) { [c.fx[i - 1], c.fx[i]] = [c.fx[i], c.fx[i - 1]]; commit(_t("videdit.ordine_effetti")); renderEC(); } }),
      smallBtn("next", _t("videdit.sposta_sotto"), () => { if (i < c.fx.length - 1) { [c.fx[i + 1], c.fx[i]] = [c.fx[i], c.fx[i + 1]]; commit(_t("videdit.ordine_effetti")); renderEC(); } }),
      smallBtn("reset", _t("videdit.ripristina"), () => { e.p = Object.fromEntries(def.params.map(p => [p.k, p.d])); commit(_t("videdit.ripristina_effetto")); renderEC(); }),
      smallBtn("trash", _t("videdit.elimina_effetto"), () => { c.fx.splice(i, 1); commit(_t("videdit.elimina_effetto")); renderEC(); })]);
    s.querySelector(".ve-echead").insertBefore(onBtn, s.querySelector(".ve-ectitle"));
    for (const p of def?.params || []) {
      let ctl;
      if (p.type === "bool") ctl = el("input", { type: "checkbox", id: `ve-fx-${c.id}-${i}-${p.k}`, checked: !!(e.p[p.k] ?? p.d), onchange: ev => { e.p[p.k] = ev.target.checked; commit(def.name); } });
      else if (p.type === "color") ctl = el("input", { type: "color", id: `ve-fx-${c.id}-${i}-${p.k}`, value: e.p[p.k] ?? p.d, oninput: ev => { e.p[p.k] = ev.target.value; live(); }, onchange: () => commit(def.name) });
      else if (p.type === "file") ctl = el("span", {}, el("span", { class: "ve-muted" }, e.p.file ? baseName(e.p.file) : _t("videdit.nessun_file")), el("button", { class: "ve-mini", type: "button", onclick: () => pickLut(c, i) }, _t("videdit.scegli")));
      else ctl = scrub(() => e.p[p.k] ?? p.d, (v, d) => { e.p[p.k] = v; if (d) commit(def.name); else live(); }, { min: p.min, max: p.max, step: p.step || 1, unit: p.u ? " " + p.u : "" });
      if (p.type !== "file" && p.type !== "bool" && p.type !== "color") {
        const sl = el("input", { type: "range", class: "ve-range", id: `ve-fxr-${c.id}-${i}-${p.k}`, min: p.min, max: p.max, step: p.step || 1, value: e.p[p.k] ?? p.d });
        sl.addEventListener("input", () => { e.p[p.k] = +sl.value; ecRefs.forEach(f => f()); live(); });
        sl.addEventListener("change", () => commit(def.name));
        ecRefs.push(() => { sl.value = e.p[p.k] ?? p.d; });
        b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, p.n), el("span", { class: "ve-ecval" }, ctl, sl), el("span")));
      } else b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, p.n), el("span", { class: "ve-ecval" }, ctl), el("span")));
    }
    if (e.type === "chroma") b.append(el("div", { class: "ve-ecnote" }, _t("videdit.suggerimento_metti_clip_sfondo_verde")));
    return s;
  }
  async function pickLut(c, i) {
    const ps = await pickFiles();
    if (!ps?.length) return;
    if (extOf(ps[0]) !== "cube") return toast(_t("videdit.serve_file_lut_3d_cube"), true);
    c.fx[i].p.file = ps[0];
    commit("LUT");
    renderEC();
  }
  function renderTransitionEC(tr) {
    const audio = isA(tr.track);
    const lib = audio ? AUDIO_TRANSITIONS : TRANSITIONS;
    const a = byId(tr.a), b2 = byId(tr.b);
    ecBox.append(el("div", { class: "ve-ectop" }, el("b", {}, lib[tr.type]?.name || tr.type), el("span", { class: "ve-muted" }, _t("videdit.transizione") + (a && b2 ? _t("videdit.tra_due_clip_centro_taglio") : a ? _t("videdit.fine_clip") : _t("videdit.all_inizio_clip")))));
    const [s, b] = ecSection(_t("videdit.transizione_2"));
    b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, _t("videdit.tipo")), el("span", { class: "ve-ecval" },
      el("select", { class: "ve-sel", id: "ve-trtype-" + tr.id, onchange: e => { tr.type = e.target.value; commit(_t("videdit.tipo_transizione")); } }, ...Object.entries(lib).map(([k, v]) => el("option", { value: k, selected: k === tr.type }, v.name)))), el("span")));
    b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }, _t("videdit.durata")), el("span", { class: "ve-ecval" },
      scrub(() => tr.dur, (v, d) => { tr.dur = Math.max(fr(), snapF(v)); if (d) { commit(_t("videdit.durata_transizione")); renderEC(); } else live(); }, { min: fr(), max: 60, step: fr(), fmt: v => tc(v, fps), parse: s2 => parseTc(s2, fps) })), el("span")));
    b.append(el("div", { class: "ve-ecrow" }, el("span", { class: "ve-watch" }), el("span", { class: "ve-eclab" }), el("span", { class: "ve-ecval" },
      el("button", { class: "ve-mini", type: "button", onclick: () => { P.transitions = P.transitions.filter(x => x !== tr); selTr = null; commit(_t("videdit.elimina_transizione")); } }, _t("videdit.elimina_transizione"))), el("span")));
    ecBox.append(s);
    if (a && b2) ecBox.append(el("div", { class: "ve-ecnote" }, _t("videdit.se_clip_non_hanno_materiale")));
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
      sl.addEventListener("change", () => commit(_t("videdit.volume_traccia")));
      sl.addEventListener("dblclick", () => { setDb(0); sl.value = 0; show(); commit(_t("videdit.volume_traccia")); });
      return el("div", { class: "ve-strip" }, el("div", { class: "ve-mxname" }, name), extra || el("div", { class: "ve-mxbtns" }), sl, val);
    };
    for (const t of P.tracks.a) {
      const ms = el("div", { class: "ve-mxbtns" },
        el("button", { class: "ve-ms" + (t.mute ? " on m" : ""), type: "button", title: _t("videdit.disattiva_audio_traccia"), onclick: () => { t.mute = !t.mute; commit(_t("videdit.mute")); } }, "M"),
        el("button", { class: "ve-ms" + (t.solo ? " on s" : ""), type: "button", title: _t("videdit.assolo"), onclick: () => { t.solo = !t.solo; commit(_t("videdit.solo")); } }, "S"));
      box.append(strip(t.name || t.id, () => t.gain || 0, v => { t.gain = v <= -60 ? -120 : v; }, ms));
    }
    box.append(strip(_t("videdit.master"), () => P.settings.master || 0, v => { P.settings.master = v; if (player.master) player.master.gain.value = dbToLin(v); }));
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
    select: _t("videdit.clic_seleziona_trascina_sposta_alt"),
    trackfwd: _t("videdit.clic_seleziona_tutte_clip_traccia"),
    ripple: _t("videdit.trascina_bordo_taglia_sposta_clip"), rolling: _t("videdit.trascina_punto_modifica_tra_due"),
    rate: _t("videdit.trascina_bordo_cambiare_velocita"), razor: _t("videdit.clic_dividere_clip_maiusc_tutte"),
    slip: _t("videdit.trascina_clip_cambiare_attacco_stacco"), slide: _t("videdit.trascina_clip_tra_due_vicine"),
    pen: _t("videdit.clic_linea_opacita_volume_aggiungere"), hand: _t("videdit.trascina_scorrere_timeline"),
    zoom: _t("videdit.clic_ingrandire_alt_clic_ridurre"), type: "clic sul monitor programma per scrivere un titolo",
  };

  // ------------------------------------------------------------------ timeline
  const tlTc = el("span", { class: "ve-tc ve-tc-tl", title: _t("videdit.posizione_testina") });
  const snapBtn = el("button", { class: "ve-tlbtn on", type: "button", title: _t("videdit.aggancia_timeline_s"), onclick: () => toggleSnap() });
  snapBtn.innerHTML = vIcon("snap", 16);
  const linkBtn = el("button", { class: "ve-tlbtn on", type: "button", title: _t("videdit.selezione_collegata"), onclick: () => { linkedSel = !linkedSel; linkBtn.classList.toggle("on", linkedSel); } });
  linkBtn.innerHTML = vIcon("link", 16);
  const mkBtn = el("button", { class: "ve-tlbtn", type: "button", title: _t("videdit.aggiungi_marcatore_m"), onclick: () => addMarker() });
  mkBtn.innerHTML = vIcon("marker", 16);
  const setBtn = el("button", { class: "ve-tlbtn", type: "button", title: _t("videdit.impostazioni_visualizzazione_timeline"), onclick: e => openMenuAt(e.currentTarget, MENUS.Visualizza()) });
  setBtn.innerHTML = vIcon("wrench", 16);
  const zoomRange = el("input", { type: "range", class: "ve-tlzoom", id: "ve-tlz-" + ctx.tab.name, min: 0, max: 100, step: 0.5, title: _t("videdit.zoom_timeline") });
  zoomRange.addEventListener("input", () => setZoom(Math.pow(10, -1 + zoomRange.value / 100 * 3.6), player.t));
  const headCol = el("div", { class: "ve-heads" });
  const headInner = el("div", { class: "ve-headsin" });
  headCol.append(el("div", { class: "ve-headruler" }), headInner);
  const tlCanvas = el("canvas", { class: "ve-tlcv" });
  const tlOver = el("canvas", { class: "ve-tlov" });
  const tlArea = el("div", { class: "ve-tlarea" }, tlCanvas, tlOver);
  const hsb = el("div", { class: "ve-hsb" }), hthumb = el("div", { class: "ve-hthumb" });
  hsb.append(hthumb);
  tlPanel.append(el("div", { class: "ve-ptabs" }, el("span", { class: "ve-ptab on" }, _t("videdit.timeline_sequenza"))),
    el("div", { class: "ve-tlhead" }, tlTc, snapBtn, linkBtn, mkBtn, setBtn, el("span", { class: "grow" }), zoomRange),
    el("div", { class: "ve-tlbody" }, headCol, tlArea), el("div", { class: "ve-hsbrow" }, el("div", { style: { width: HEAD_W + "px", flex: "none" } }), hsb));
  const tRows = { showThumbs: true, showWaves: true };
  function toggleSnap() { snapOn = !snapOn; snapBtn.classList.toggle("on", snapOn); ctx.status(_t("videdit.aggancio") + (snapOn ? "attivo" : "disattivato")); }

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
      const patch = el("button", { class: "ve-patch" + ((isV ? P.srcV : P.srcA) === t.id ? " on" : ""), type: "button", title: _t("videdit.traccia_destinazione_inserisci_sovrascrivi_transizioni"),
        onclick: () => { if (isV) P.srcV = t.id; else P.srcA = t.id; renderHeads(); } }, isV ? "V" : "A");
      const row = el("div", { class: "ve-head " + (isV ? "v" : "a"), style: { top: r.y + "px", height: r.h + "px" } },
        patch, ib(t.lock ? "lock" : "unlock", _t("videdit.attiva_disattiva_blocco_traccia"), t.lock, () => { t.lock = !t.lock; commit(_t("videdit.blocco_traccia")); }),
        isV ? ib(t.hide ? "eyeOff" : "eye", _t("videdit.attiva_disattiva_output_traccia"), !t.hide, () => { t.hide = !t.hide; commit(_t("videdit.output_traccia")); }, "eyeb")
          : el("span", { class: "ve-ms2" }, ib("<b>M</b>", _t("videdit.disattiva_audio_traccia_2"), t.mute, () => { t.mute = !t.mute; commit(_t("videdit.mute")); }, "m"), ib("<b>S</b>", _t("videdit.assolo_traccia"), t.solo, () => { t.solo = !t.solo; commit(_t("videdit.solo")); }, "s")),
        el("span", { class: "ve-hname", title: _t("videdit.doppio_clic_altezza_traccia") }, t.id));
      row.addEventListener("dblclick", e => { if (e.target.closest("button")) return; t.h = trackH(t) > 60 ? 56 : 100; commit(); });
      row.addEventListener("contextmenu", e => { e.preventDefault(); openMenuAt({ x: e.clientX, y: e.clientY }, [
        { label: _t("videdit.rinomina_traccia"), run: async () => { const n = await askText(_t("videdit.rinomina_traccia_2"), _t("common.nome"), t.name || t.id); if (n) { t.name = n; commit(_t("videdit.rinomina_traccia_2")); } } },
        { label: _t("videdit.aggiungi_traccia"), run: () => { addTrack(r.type); commit(_t("videdit.aggiungi_traccia")); } },
        { label: _t("videdit.elimina_traccia"), run: () => deleteTrack(t, r.type), disabled: () => (isV ? P.tracks.v : P.tracks.a).length < 2 },
        "-", { label: trackH(t) > 60 ? _t("videdit.riduci_altezza") : _t("videdit.espandi_altezza"), run: () => { t.h = trackH(t) > 60 ? 56 : 100; commit(); } }]); });
      row.title = t.name || t.id;
      headInner.append(row);
    }
  }
  function addTrack(type) {
    const list = type === "v" ? P.tracks.v : P.tracks.a;
    const p = type === "v" ? "V" : "A";
    let n = list.length + 1;
    while (list.some(t => t.id === p + n)) n++;
    const t = { id: p + n, name: (type === "v" ? _t("videdit.video") : _t("videdit.audio")) + n };
    if (type === "a") t.gain = 0;
    list.push(t);
    return t.id;
  }
  async function deleteTrack(t, type) {
    const cs = clipsOn(t.id);
    if (cs.length && !(await confirmBox(_t("videdit.elimina_traccia"), _t("videdit.traccia_0_contiene_1_clip", t.id, cs.length), _t("common.elimina"), true))) return;
    cs.forEach(removeClip);
    if (type === "v") P.tracks.v = P.tracks.v.filter(x => x !== t); else P.tracks.a = P.tracks.a.filter(x => x !== t);
    if (P.srcV === t.id) P.srcV = P.tracks.v[0]?.id; if (P.srcA === t.id) P.srcA = P.tracks.a[0]?.id;
    commit(_t("videdit.elimina_traccia"));
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
    if (m?.offline) label = _t("videdit.supporto_non_linea") + label;
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
      g.fillStyle = "#fff"; g.font = "11px Segoe UI"; g.fillText(drop.insert ? _t("videdit.inserisci_sposta_clip_successive") : _t("videdit.sovrascrivi_tieni_premuto_ctrl_inserire"), tToX(drop.t) + 4, RULER + 12);
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
    else if (h?.tr) { selTr = h.tr.id; sel.clear(); refreshSel(); openMenuAt({ x: e.clientX, y: e.clientY }, [{ label: _t("videdit.elimina_transizione"), run: () => { P.transitions = P.transitions.filter(t => t !== h.tr); selTr = null; commit(_t("videdit.elimina_transizione")); } }]); }
    else if (h?.row) {
      const gap = gapAt(h.row.tr.id, xToT(e.clientX - r.left));
      if (gap) { selGap = gap; drawTL(); openMenuAt({ x: e.clientX, y: e.clientY }, [{ label: _t("videdit.elimina_ripple"), run: () => rippleDeleteGap() }]); }
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
        return { move: ev => { tr.dur = Math.max(fr(), snapF(d0 + (h.edge === "b" ? 1 : -1) * (ev.clientX - x0) / pps * (tr.a && tr.b ? 2 : 1))); validateTransitions(P); drawTL(); player.dirty = true; player.idle(); }, up: () => commit(_t("videdit.durata_transizione")) };
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
      if (locked(c.track)) { toast(_t("videdit.traccia_bloccata"), true); return null; }
      selGap = null; selTr = null; selKf = null;
      // Ctrl+clic sulla linea: fotogramma chiave (come lo strumento Penna)
      if (e.ctrlKey && !h.edge && y > rowY(h.row) + 15) return TOOL_DOWN.pen(e, h, x, y, r);
      if (h.onLine && !h.edge && !e.shiftKey && !e.altKey) {
        // trascinare la linea di opacita'/volume senza fotogrammi chiave cambia il valore fisso
        const prop = h.prop, y0 = e.clientY, v0 = prop === "volume" ? c.volume || 0 : c.opacity ?? 100, H = h.row.h - 6;
        if (!sel.has(c.id)) { sel = withLinked([c.id]); refreshSel(); }
        return { move: ev => { const dv = -(ev.clientY - y0) / H * (prop === "volume" ? 46 : 100); const v = prop === "volume" ? clamp(Math.round((v0 + dv) * 10) / 10, -60, 6) : clamp(Math.round(v0 + dv), 0, 100); c[prop] = v; ctx.status(prop === "volume" ? `Volume ${v} dB` : _t("videdit.opacita_0", v)); drawTL(); player.dirty = true; player.idle(); }, up: () => commit(prop === "volume" ? _t("videdit.volume") : _t("videdit.opacita")) };
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
          ctx.status(_t("videdit.modifica_rullo") + (d >= 0 ? "+" : "") + tc(d, fps));
          drawTL(); goto(B.start);
        },
        up: () => commit(_t("videdit.modifica_rullo_2")),
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
          ctx.status(_t("videdit.velocita_0", Math.round(h.clip.speed * 1000) / 10));
          drawTL();
        },
        up: () => commit(_t("videdit.allungamento_velocita")),
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
          ctx.status(_t("videdit.slittamento_attacco_sorgente") + tc(h.clip.in, fps));
          if (h.clip.kind === "video") { player.seek(clamp(player.t, h.clip.start, end(h.clip) - fr())); }
          drawTL();
        },
        up: () => commit(_t("videdit.slittamento")),
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
        up: () => commit(_t("videdit.scorrimento")),
      };
    },
    pen(e, h, x, y, r) {
      if (!h?.clip) return null;
      if (h.kf !== undefined) return dragKf(h, r);
      const c = h.clip, ry = rowY(h.row), H = h.row.h;
      if (H < 40) { toast(_t("videdit.espandi_traccia_doppio_clic_sull"), true); return null; }
      const prop = c.kind === "audio" ? "volume" : "opacity";
      const tau = clamp(snapF(xToT(x) - c.start), 0, c.dur);
      const v = c.kind === "audio" ? Math.round((((1 - (y - ry - 3) / (H - 6)) * 46) - 40) * 10) / 10 : Math.round((1 - (y - ry - 3) / (H - 6)) * 100);
      c.kf = c.kf || {};
      if (!c.kf[prop]?.length) c.kf[prop] = [];
      c.kf[prop].push([tau, clamp(v, prop === "volume" ? -60 : 0, prop === "volume" ? 6 : 100)]);
      c.kf[prop].sort((a, b) => a[0] - b[0]);
      sel = withLinked([c.id]);
      selKf = { c: c.id, prop, i: c.kf[prop].findIndex(k => k[0] === tau) };
      commit(_t("videdit.fotogramma_chiave"));
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
        ctx.status(prop === "volume" ? `Volume ${k[1]} dB a ${tc(c.start + k[0], fps)}` : _t("videdit.opacita_0_1", k[1], tc(c.start + k[0], fps)));
        drawTL(); player.dirty = true; player.idle();
      },
      up: () => { if (moved) commit(_t("videdit.sposta_fotogramma_chiave")); else drawTL(); },
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
        ctx.status((mode === "ripple" ? _t("videdit.ripple") : _t("videdit.taglio")) + (side === "in" ? _t("videdit.testa") : _t("videdit.coda")) + (d >= 0 ? "+" : "") + tc(d, fps) + _t("videdit.durata_2") + tc(c.dur, fps));
        drawTL();
        if (c.kind !== "audio") player.seek(side === "in" ? c.start : Math.max(c.start, end(c) - fr()));
      },
      up: () => commit(mode === "ripple" ? _t("videdit.modifica_ripple") : _t("common.taglia")),
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
        ctx.status(_t("videdit.sposta_0_1_2", d >= 0 ? "+" : "", tc(d, fps), ev.ctrlKey ? _t("videdit.inserisci_3") : _t("videdit.sovrascrivi_ctrl_inserire")));
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
        commit(dup ? _t("videdit.duplica") : ev.ctrlKey ? _t("videdit.sposta_inserisci") : _t("videdit.sposta"));
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
    if (done.length) commit(_t("videdit.lama_rasoio")); else ctx.status(_t("videdit.niente_dividere_questo_punto"));
  }
  function addEdit(all) {
    const t = snapF(player.t);
    let targets = all ? P.clips : [...sel].map(byId).filter(c => c && c.start < t && end(c) > t);
    if (!targets.length) targets = P.clips.filter(c => c.start < t - EPS && end(c) > t + EPS && (c.track === P.srcV || c.track === P.srcA || all));
    if (!targets.length) targets = P.clips.filter(c => c.start < t - EPS && end(c) > t + EPS);
    razorAt(t, targets.filter(c => c.start < t - EPS && end(c) > t + EPS));
  }
  function clearSel() {
    if (selKf) { const c = byId(selKf.c); if (c?.kf?.[selKf.prop]) { c.kf[selKf.prop].splice(selKf.i, 1); if (!c.kf[selKf.prop].length) delete c.kf[selKf.prop]; } selKf = null; commit(_t("videdit.elimina_fotogramma_chiave")); return; }
    if (selTr) { P.transitions = P.transitions.filter(t => t.id !== selTr); selTr = null; commit(_t("videdit.elimina_transizione")); return; }
    if (selGap) return rippleDeleteGap();
    const cs = [...sel].map(byId).filter(c => c && !locked(c.track));
    if (!cs.length) return;
    cs.forEach(removeClip);
    commit(_t("videdit.cancella"));
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
    commit(_t("videdit.elimina_ripple"));
  }
  function rippleDeleteGap() {
    const g = selGap;
    if (!g) return;
    const tracks = syncTracks(g.a, g.b, [g.track]).filter(tid => !clipsOn(tid).some(z => z.start < g.b - EPS && end(z) > g.a + EPS));
    closeRange(g.a, g.b, tracks);
    selGap = null;
    commit(_t("videdit.elimina_spazio_ripple"));
  }
  // Q / W: taglio con ripple della modifica precedente/successiva fino alla testina
  function rippleTrimTo(prevEdit) {
    const t = snapF(player.t);
    const under = P.clips.filter(c => c.start < t - EPS && end(c) > t + EPS && !locked(c.track));
    if (!under.length) return ctx.status(_t("videdit.nessuna_clip_sotto_testina"));
    if (prevEdit) { const a = Math.max(...under.map(c => c.start)); extractRange(a, t, unlockedTracks()); goto(a); }
    else { const b = Math.min(...under.map(end)); extractRange(t, b, unlockedTracks()); }
    commit(prevEdit ? _t("videdit.taglio_ripple_modifica_precedente") : _t("videdit.taglio_ripple_modifica_successiva"));
  }
  function hasIO() { return P.inPoint !== null && P.inPoint !== undefined && P.outPoint !== null && P.outPoint !== undefined && P.outPoint > P.inPoint; }
  function liftInOut() { if (!hasIO()) return toast(_t("videdit.imposta_prima_attacco_i_stacco"), true); for (const tid of unlockedTracks()) liftRange(tid, P.inPoint, P.outPoint); commit(_t("videdit.solleva")); }
  function extractInOut() { if (!hasIO()) return toast(_t("videdit.imposta_prima_attacco_i_stacco"), true); extractRange(P.inPoint, P.outPoint, unlockedTracks()); const a = P.inPoint; P.outPoint = null; commit(_t("videdit.estrai_2")); goto(a); }
  function markIn() { if (focus === "source") return srcMark("in"); P.inPoint = snapF(player.t); if (P.outPoint !== null && P.outPoint !== undefined && P.outPoint <= P.inPoint) P.outPoint = null; commit(_t("videdit.contrassegna_attacco")); }
  function markOut() { if (focus === "source") return srcMark("out"); P.outPoint = snapF(player.t); if (P.inPoint !== null && P.inPoint !== undefined && P.inPoint >= P.outPoint) P.inPoint = null; commit(_t("videdit.contrassegna_stacco_2")); }
  function markClip() {
    const c = [...sel].map(byId).find(Boolean) || P.clips.filter(x => x.start <= player.t && end(x) > player.t).sort((a, b) => a.track.localeCompare(b.track))[0];
    if (!c) return;
    P.inPoint = c.start; P.outPoint = end(c); commit(_t("videdit.contrassegna_clip"));
  }
  function addMarker() {
    const t = snapF(player.t);
    if (P.markers.some(m => Math.abs(m.t - t) < fr() / 2)) return;
    P.markers.push({ t, name: "" });
    P.markers.sort((a, b) => a.t - b.t);
    commit(_t("videdit.aggiungi_marcatore"));
  }
  async function editMarker(m) {
    const n = await askText(_t("videdit.marcatore"), _t("videdit.nome_commento"), m.name || "");
    if (n === null) return;
    m.name = n; commit(_t("videdit.marcatore"));
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
  function toggleEnable() { const cs = [...sel].map(byId).filter(Boolean); if (!cs.length) return; const v = !cs[0].off; cs.forEach(c => { c.off = v; }); commit(v ? _t("videdit.disattiva_clip") : _t("videdit.attiva_clip")); }
  function toggleLink() {
    const cs = [...sel].map(byId).filter(Boolean);
    if (!cs.length) return;
    if (cs.some(c => c.link)) { cs.forEach(c => { c.link = null; }); commit(_t("videdit.scollega")); toast(_t("videdit.audio_video_scollegati")); }
    else { const vs = cs.filter(c => c.kind !== "audio"), as = cs.filter(c => c.kind === "audio"); if (!vs.length || !as.length) return toast(_t("videdit.seleziona_clip_video_audio_collegare"), true); const l = uid("l"); cs.forEach(c => { c.link = l; }); commit(_t("videdit.collega")); toast(_t("videdit.audio_video_collegati")); }
  }
  function copySel(cut) {
    const cs = [...sel].map(byId).filter(Boolean);
    if (!cs.length) return;
    const t0 = Math.min(...cs.map(c => c.start));
    clipboard = cs.map(c => ({ ...structuredClone(c), off0: c.start - t0 }));
    if (cut) { cs.forEach(removeClip); commit(_t("common.taglia")); }
    ctx.status(_t("videdit.0_clip_negli_appunti", cs.length));
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
    commit(insert ? _t("videdit.incolla_inserimento") : _t("common.incolla"));
    goto(t + span);
  }
  async function pasteAttributes() {
    if (!clipboard?.length) return toast(_t("videdit.copia_prima_clip_ctrl_c"), true);
    const src0 = clipboard.find(c => c.kind !== "audio") || clipboard[0];
    const boxes = [["motion", _t("videdit.movimento")], ["opacity", _t("videdit.opacita_fusione")], ["fx", _t("videdit.effetti")], ["volume", _t("videdit.volume")]].map(([k, n]) => [k, el("input", { type: "checkbox", checked: true, id: "ve-pa-" + k }), n]);
    const ok = await modal(_t("videdit.incolla_attributi"), el("div", { style: { display: "grid", gap: "6px" } }, ...boxes.map(([, b, n]) => el("label", { style: { display: "flex", gap: "8px" } }, b, n))), [{ label: _t("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
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
    commit(_t("videdit.incolla_attributi"));
  }
  async function speedDialog() {
    const cs = [...sel].map(byId).filter(c => c && c.kind !== "title" && c.kind !== "color" && c.kind !== "image");
    if (!cs.length) return toast(_t("videdit.seleziona_clip_video_audio"), true);
    const c = cs[0];
    const sp = el("input", { type: "number", class: "field", id: "ve-sp", value: Math.round((c.speed || 1) * 1000) / 10, min: 10, max: 1600, step: 1 });
    const du = el("input", { type: "text", class: "field", id: "ve-du", value: tc(c.dur, fps) });
    const rip = el("input", { type: "checkbox", id: "ve-rip" });
    sp.addEventListener("input", () => { du.value = tc(c.dur * (c.speed || 1) / (+sp.value / 100), fps); });
    du.addEventListener("input", () => { const d = parseTc(du.value, fps); if (d > 0) sp.value = Math.round(c.dur * (c.speed || 1) / d * 1000) / 10; });
    const ok = await modal(_t("videdit.velocita_durata_clip"), el("div", { style: { display: "grid", gap: "10px" } },
      el("label", { style: { display: "grid", gap: "4px" } }, _t("videdit.velocita_2"), sp), el("label", { style: { display: "grid", gap: "4px" } }, _t("videdit.durata"), du),
      el("label", { style: { display: "flex", gap: "8px" } }, rip, _t("videdit.modifica_ripple_sposta_clip_successive")),
      el("p", { class: "note", style: { margin: 0 } }, _t("videdit.l_intonazione_dell_audio_resta"))), [{ label: _t("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
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
    commit(_t("videdit.velocita_durata_2"));
    renderEC();
  }
  async function normalizeAudio(cs, target) {
    cs = cs.filter(c => c.kind === "audio");
    if (!cs.length) return toast(_t("videdit.seleziona_piu_clip_audio"), true);
    ctx.status(_t("videdit.analisi_volume"));
    for (const c of cs) {
      const m = mediaOf(c);
      try {
        const r = await api("video_peak", { path: m.path }, { json: { start: c.in || 0, dur: c.dur * (c.speed || 1) } });
        if (r.max === null) continue;
        c.gain = Math.round((target - r.max) * 10) / 10;
      } catch (e) { toast(e.message, true); }
    }
    commit(_t("videdit.normalizza_audio"));
    ctx.status(_t("videdit.normalizzate_0_clip_1_db", cs.length, target));
    renderEC();
  }
  async function audioGainDialog() {
    const cs = [...sel].map(byId).filter(c => c?.kind === "audio");
    if (!cs.length) return toast(_t("videdit.seleziona_piu_clip_audio"), true);
    const mode = el("select", { class: "field", id: "ve-gm" }, el("option", { value: "set" }, _t("videdit.imposta_guadagno_db")), el("option", { value: "adj" }, _t("videdit.regola_guadagno_db")), el("option", { value: "norm" }, _t("videdit.normalizza_picco_massimo_db")));
    const val = el("input", { type: "number", class: "field", id: "ve-gv", value: 0, step: 0.5 });
    mode.addEventListener("change", () => { val.value = mode.value === "norm" ? -1 : 0; });
    const ok = await modal(_t("videdit.guadagno_audio_2"), el("div", { style: { display: "grid", gap: "10px" } }, mode, val), [{ label: _t("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok) return;
    const v = +val.value;
    if (mode.value === "norm") return normalizeAudio(cs, v);
    cs.forEach(c => { c.gain = mode.value === "set" ? v : (c.gain || 0) + v; });
    commit(_t("videdit.guadagno_audio_2"));
  }
  async function stabilizeClip() {
    if (WEB) return toast(_t("videdit.stabilizzazione_disponibile_nell_app_pc"), true);
    const c = [...sel].map(byId).find(x => x?.kind === "video");
    if (!c) return toast(_t("videdit.seleziona_clip_video"), true);
    const m = mediaOf(c);
    const ok = await confirmBox(_t("videdit.stabilizza"), _t("videdit.viene_creata_copia_stabilizzata_0", m.name), _t("videdit.stabilizza"));
    if (!ok) return;
    let out = m.path.replace(/(\.[^.\\/]+)?$/, "_stabilizzato.mp4");
    try { out = (await api("temp_path", { name: baseName(out) })).path; } catch { /* */ }
    const bar = progressBox(_t("videdit.stabilizzazione") + m.name);
    try {
      const j = await api("video_stabilize", { path: m.path }, { json: { out } });
      await waitJob(j.job, (p, msg) => bar.set(p, msg));
      bar.close();
      const [nm] = await importPaths([out], true);
      for (const z of [c, ...partners(c)]) if (z.kind === "video") z.media = nm.id;
      commit(_t("videdit.stabilizza"));
      toast(_t("videdit.clip_stabilizzata"));
    } catch (e) { bar.close(); toast(_t("videdit.stabilizzazione_non_riuscita") + e.message, true, 8000); }
  }
  function progressBox(title) {
    const back = document.getElementById("modal"), body = document.getElementById("modal-body");
    const fill = el("span"), msg = el("p", {}, _t("videdit.avvio"));
    body.innerHTML = "";
    body.append(el("h3", {}, title), msg, el("div", { class: "progress" }, fill));
    back.hidden = false;
    return { set(p, m) { fill.style.width = Math.round(p * 100) + "%"; msg.textContent = (m || _t("videdit.corso")) + ` · ${Math.round(p * 100)}%`; }, close() { back.hidden = true; } };
  }

  // ------------------------------------------------------------------ impostazioni della sequenza
  async function sequenceSettings() {
    const pre = el("select", { class: "field", id: "ve-pre" }, el("option", { value: "" }, _t("videdit.personalizzata")), ...PRESETS.map(([n, w, h]) => el("option", { value: `${w}x${h}`, selected: w === P.settings.w && h === P.settings.h }, `${n} (${w}×${h})`)));
    const w = el("input", { type: "number", class: "field", id: "ve-sw", value: P.settings.w, min: 16, max: 8192 });
    const h = el("input", { type: "number", class: "field", id: "ve-sh", value: P.settings.h, min: 16, max: 8192 });
    const f = el("select", { class: "field", id: "ve-sf" }, ...RATES.map(r => el("option", { value: r, selected: r === fps }, r + " fps")));
    const bg = el("input", { type: "color", id: "ve-sbg", value: P.settings.bg || "#000000" });
    pre.addEventListener("change", () => { if (pre.value) { const [a, b] = pre.value.split("x"); w.value = a; h.value = b; } });
    const ok = await modal(_t("videdit.impostazioni_sequenza"), el("div", { style: { display: "grid", gap: "10px" } },
      el("label", { style: { display: "grid", gap: "4px" } }, _t("videdit.formato"), pre),
      el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, _t("videdit.dimensione_fotogramma"), w, "×", h),
      el("label", { style: { display: "grid", gap: "4px" } }, _t("videdit.base_temporale"), f),
      el("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, _t("videdit.colore_sfondo"), bg)), [{ label: _t("common.annulla"), value: false }, { label: "OK", value: true, primary: true }]);
    if (!ok) return;
    const nw = Math.round(+w.value / 2) * 2, nh = Math.round(+h.value / 2) * 2;
    const sx = nw / P.settings.w, sy = nh / P.settings.h;
    for (const c of P.clips) { if (c.motion) { c.motion.x *= sx; c.motion.y *= sy; } if (c.kf?.x) c.kf.x.forEach(k => { k[1] *= sx; }); if (c.kf?.y) c.kf.y.forEach(k => { k[1] *= sy; }); }
    P.settings.w = nw; P.settings.h = nh; P.settings.fps = fps = +f.value; P.settings.bg = bg.value;
    for (const c of P.clips) { c.start = snapF(c.start); c.dur = Math.max(fr(), snapF(c.dur)); }
    commit(_t("videdit.impostazioni_sequenza"));
    fitMonitor();
  }

  // ------------------------------------------------------------------ esportazione (FFmpeg, mbvisual/video.py)
  async function exportDialog() {
    if (WEB) return toast(_t("videdit.l_esportazione_video_disponibile_nell"), true, 6000);
    if (!P.clips.length) return toast(_t("videdit.sequenza_vuota"), true);
    const fmtSel = el("select", { class: "field", id: "ve-xf" },
      ...[["h264", _t("videdit.h_264_mp4_consigliato")], ["h265", _t("videdit.hevc_h_265_mp4_file")], ["webm", _t("videdit.webm_vp9_opus_web")], ["prores", _t("videdit.quicktime_mov_prores_422_altri")],
        ["mp3", _t("videdit.solo_audio_mp3")], ["wav", _t("videdit.solo_audio_wav")], ["m4a", _t("videdit.solo_audio_aac_m4a")]].map(([v, n]) => el("option", { value: v }, n)));
    const resSel2 = el("select", { class: "field", id: "ve-xr" }, el("option", { value: "" }, _t("videdit.come_sequenza_0_1", P.settings.w, P.settings.h)),
      ...[[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720], [854, 480]].filter(([a]) => a !== P.settings.w).map(([a, b]) => { const hh = Math.round(a * P.settings.h / P.settings.w / 2) * 2; return el("option", { value: `${a}x${P.settings.w >= P.settings.h ? hh : b}` }, `${a}×${P.settings.w >= P.settings.h ? hh : b}`); }));
    const fpsSel = el("select", { class: "field", id: "ve-xfps" }, el("option", { value: "" }, _t("videdit.come_sequenza_0_fps", fps)), ...RATES.filter(r => r !== fps).map(r => el("option", { value: r }, r + " fps")));
    const qSel = el("select", { class: "field", id: "ve-xq" }, el("option", { value: "alta" }, _t("videdit.alta")), el("option", { value: "media" }, _t("videdit.media")), el("option", { value: "bassa" }, _t("videdit.bassa_file_piccolo")));
    const rng = el("select", { class: "field", id: "ve-xrange" }, el("option", { value: "all" }, _t("videdit.intera_sequenza")), hasIO() ? el("option", { value: "io", selected: true }, _t("videdit.attacco_stacco_0", tc(P.outPoint - P.inPoint, fps))) : null);
    const loud = el("input", { type: "checkbox", id: "ve-xl" });
    const open = el("input", { type: "checkbox", id: "ve-xo", checked: true });
    const ok = await modal(_t("videdit.impostazioni_esportazione"), el("div", { class: "ve-xgrid" },
      el("label", {}, _t("videdit.formato"), fmtSel), el("label", {}, _t("videdit.risoluzione"), resSel2), el("label", {}, _t("videdit.fotogrammi_secondo"), fpsSel), el("label", {}, _t("videdit.qualita"), qSel), el("label", {}, _t("videdit.intervallo"), rng),
      el("label", { class: "chk" }, loud, _t("videdit.normalizza_volume_generale_ebu_r128")), el("label", { class: "chk" }, open, _t("videdit.apri_file_termine")),
      el("p", { class: "note" }, _t("videdit.l_esportazione_usa_ffmpeg_stessi"))),
    [{ label: _t("common.annulla"), value: false }, { label: _t("videdit.esporta"), value: true, primary: true }]);
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
    const bar = progressBox(_t("videdit.esportazione") + baseName(out));
    try {
      // i titoli si disegnano qui (stesso aspetto dell'anteprima) e passano a FFmpeg come immagini PNG
      o.titles = {};
      for (const c of P.clips.filter(z => z.kind === "title" && !z.off)) {
        bar.set(0, _t("videdit.preparazione_titoli"));
        const cv = renderTitle(c.title);
        const blob = await new Promise(r => cv.toBlob(r, "image/png"));
        const p = (await api("temp_path", { name: `titolo_${c.id}.png` })).path;
        await saveBytes(p, new Uint8Array(await blob.arrayBuffer()));
        o.titles[c.id] = { path: p, w: cv.width, h: cv.height };
      }
      const proj = JSON.parse(snapState());
      proj.tracks.a.forEach(t => { t.gain = (t.gain || 0) + (P.settings.master || 0); });
      const j = await api("video_export", {}, { json: { project: proj, out, opts: o } });
      await waitJob(j.job, (p, m) => bar.set(p, m || _t("videdit.esportazione_2")));
      bar.close();
      toast(_t("videdit.esportato") + baseName(out), false, 5000);
      if (open.checked) ctx.openFile(out);
    } catch (e) {
      bar.close();
      await modal(_t("videdit.esportazione_non_riuscita"), el("div", {}, el("p", {}, e.message), el("p", { class: "note" }, _t("videdit.i_dettagli_comando_sono_temp"))));
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
    toast(_t("videdit.fotogramma_esportato") + baseName(out));
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
      { label: _t("videdit.importa_2"), keys: "Ctrl+I", run: doImport }, "-",
      { label: _t("videdit.esporta_media"), keys: "Ctrl+M", run: exportDialog }, { label: _t("videdit.esporta_fotogramma"), keys: "Ctrl+Shift+E", run: exportFrame }, "-",
      { label: _t("videdit.impostazioni_sequenza_2"), run: sequenceSettings },
    ],
    Modifica: () => [
      { label: _t("common.annulla_op") + (hi > 0 ? " " + history[hi].label : ""), keys: "Ctrl+Z", run: undo, disabled: () => hi <= 0 },
      { label: _t("common.ripeti"), keys: "Ctrl+Shift+Z", run: redo, disabled: () => hi >= history.length - 1 }, "-",
      { label: _t("common.taglia"), keys: "Ctrl+X", run: () => copySel(true), disabled: noSel }, { label: _t("common.copia"), keys: "Ctrl+C", run: () => copySel(false), disabled: noSel },
      { label: _t("common.incolla"), keys: "Ctrl+V", run: () => paste(false), disabled: () => !clipboard }, { label: _t("videdit.incolla_inserimento"), keys: "Ctrl+Shift+V", run: () => paste(true), disabled: () => !clipboard },
      { label: _t("videdit.incolla_attributi_2"), keys: "Ctrl+Alt+V", run: pasteAttributes, disabled: () => !clipboard || !sel.size }, "-",
      { label: _t("videdit.cancella"), keys: "Delete", run: clearSel }, { label: _t("videdit.elimina_ripple"), keys: "Shift+Delete", run: rippleDelete }, "-",
      { label: _t("videdit.seleziona_tutto"), keys: "Ctrl+A", run: selectAll }, { label: _t("videdit.deseleziona_tutto"), keys: "Ctrl+Shift+A", run: deselect },
    ],
    Clip: () => [
      { label: _t("videdit.velocita_durata"), keys: "Ctrl+R", run: speedDialog, disabled: noSel },
      { label: _t("videdit.opzioni_audio"), sub: () => [{ label: _t("videdit.guadagno_audio"), keys: "G", run: audioGainDialog }, { label: _t("videdit.normalizza_picco_1_db"), run: () => normalizeAudio([...sel].map(byId).filter(Boolean), -1) }] },
      { label: _t("videdit.stabilizza_analisi_movimento"), run: stabilizeClip, disabled: () => ![...sel].some(id => byId(id)?.kind === "video") },
      { label: _t("videdit.riempi_fotogramma"), run: () => { const c = [...sel].map(byId).find(x => x && x.kind !== "audio"); if (c) fillFrame(c); }, disabled: noSel }, "-",
      { label: _t("videdit.abilita"), keys: "Shift+E", run: toggleEnable, disabled: noSel, checked: () => sel.size && ![...sel].map(byId)[0]?.off },
      { label: _t("videdit.collega_scollega"), keys: "Ctrl+L", run: toggleLink, disabled: noSel },
      { label: _t("videdit.rinomina"), run: async () => { const c = byId([...sel][0]); if (!c) return; const n = await askText(_t("videdit.rinomina_clip"), _t("common.nome"), c.name || ""); if (n) { c.name = n; commit(_t("common.rinomina")); } }, disabled: noSel },
      { label: _t("videdit.mostra_monitor_sorgente"), run: () => { const m = mediaOf(byId([...sel][0])); if (m) openSource(m); }, disabled: noSel },
    ],
    Sequenza: () => [
      { label: _t("videdit.impostazioni_sequenza_2"), run: sequenceSettings }, "-",
      { label: _t("videdit.aggiungi_modifica"), keys: "Ctrl+K", run: () => addEdit(false) }, { label: _t("videdit.aggiungi_modifica_tutte_tracce"), keys: "Ctrl+Shift+K", run: () => addEdit(true) },
      { label: _t("videdit.taglio_ripple_modifica_precedente_fino"), keys: "Q", run: () => rippleTrimTo(true) },
      { label: _t("videdit.taglio_ripple_modifica_successiva_fino"), keys: "W", run: () => rippleTrimTo(false) }, "-",
      { label: _t("videdit.applica_transizione_video"), keys: "Ctrl+D", run: () => defaultTransition(false) }, { label: _t("videdit.applica_transizione_audio"), keys: "Ctrl+Shift+D", run: () => defaultTransition(true) }, "-",
      { label: _t("videdit.solleva"), keys: ";", run: liftInOut }, { label: _t("videdit.estrai_2"), keys: "'", run: extractInOut }, "-",
      { label: _t("videdit.aggancia_timeline"), keys: "S", run: toggleSnap, checked: () => snapOn }, { label: _t("videdit.selezione_collegata"), run: () => { linkedSel = !linkedSel; linkBtn.classList.toggle("on", linkedSel); }, checked: () => linkedSel }, "-",
      { label: _t("videdit.aggiungi_traccia_video"), run: () => { addTrack("v"); commit(_t("videdit.aggiungi_traccia")); } }, { label: _t("videdit.aggiungi_traccia_audio"), run: () => { addTrack("a"); commit(_t("videdit.aggiungi_traccia")); } },
    ],
    Marcatori: () => [
      { label: _t("videdit.contrassegna_attacco"), keys: "I", run: markIn }, { label: _t("videdit.contrassegna_stacco_2"), keys: "O", run: markOut }, { label: _t("videdit.contrassegna_clip"), keys: "X", run: markClip }, "-",
      { label: _t("videdit.vai_ad_attacco"), keys: "Shift+I", run: () => goto(P.inPoint ?? 0) }, { label: _t("videdit.vai_stacco"), keys: "Shift+O", run: () => goto(P.outPoint ?? total()) }, "-",
      { label: _t("videdit.cancella_attacco"), keys: "Ctrl+Shift+I", run: () => { P.inPoint = null; commit(_t("videdit.cancella_attacco")); } }, { label: _t("videdit.cancella_stacco"), keys: "Ctrl+Shift+O", run: () => { P.outPoint = null; commit(_t("videdit.cancella_stacco")); } },
      { label: _t("videdit.cancella_attacco_stacco"), keys: "Ctrl+Shift+X", run: () => { P.inPoint = P.outPoint = null; commit(_t("videdit.cancella_attacco_stacco")); } }, "-",
      { label: _t("videdit.aggiungi_marcatore"), keys: "M", run: addMarker }, { label: _t("videdit.vai_marcatore_successivo"), keys: "Shift+M", run: () => gotoMarker(1) }, { label: _t("videdit.vai_marcatore_precedente"), keys: "Ctrl+Shift+M", run: () => gotoMarker(-1) },
      { label: _t("videdit.cancella_marcatore_selezionato"), keys: "Ctrl+Alt+M", run: () => { P.markers = P.markers.filter(m => Math.abs(m.t - player.t) >= fr() / 2); commit(_t("videdit.cancella_marcatore")); } },
      { label: _t("videdit.cancella_tutti_i_marcatori"), keys: "Ctrl+Alt+Shift+M", run: () => { P.markers = []; commit(_t("videdit.cancella_marcatori")); } },
    ],
    Grafica: () => [{ label: _t("videdit.nuovo_livello_testo"), keys: "Ctrl+T", run: () => newTitle() }, { label: _t("videdit.colore_tinta_unita"), run: newColor }],
    Visualizza: () => [
      { label: _t("videdit.zoom_avanti_timeline"), keys: "Plus", run: () => setZoom(pps * 1.5) }, { label: _t("videdit.zoom_indietro_timeline"), keys: "Minus", run: () => setZoom(pps / 1.5) },
      { label: _t("videdit.adatta_sequenza_finestra"), keys: "\\", run: zoomFit }, "-",
      { label: _t("videdit.risoluzione_riproduzione_2"), sub: () => [[1, _t("videdit.intera")], [0.5, "1/2"], [0.25, "1/4"]].map(([v, n]) => ({ label: n, checked: () => player.q === v, run: () => { player.q = v; resSel.value = v; player.dirty = true; player.idle(); } })) },
      { label: _t("videdit.mostra_miniature_video"), checked: () => tRows.showThumbs, run: () => { tRows.showThumbs = !tRows.showThumbs; drawTL(); } },
      { label: _t("videdit.mostra_forme_d_onda_audio"), checked: () => tRows.showWaves, run: () => { tRows.showWaves = !tRows.showWaves; drawTL(); } },
      { label: _t("videdit.espandi_tutte_tracce"), run: () => { allTracks().forEach(t => { t.h = 100; }); drawTL(); } }, { label: _t("videdit.riduci_tutte_tracce"), run: () => { allTracks().forEach(t => { t.h = 56; }); drawTL(); } },
    ],
    Finestra: () => [
      { label: _t("videdit.progetto"), keys: "Shift+1", run: () => LL.show("project") }, { label: _t("videdit.sorgente"), keys: "Shift+2", run: () => UL.show("source") },
      { label: _t("videdit.programma_timeline"), keys: "Shift+3", run: () => { focus = "program"; root.focus(); } }, { label: _t("videdit.controlli_effetti"), keys: "Shift+5", run: () => UL.show("ec") },
      { label: _t("videdit.mixer_tracce_audio"), keys: "Shift+6", run: () => UL.show("mixer") }, { label: _t("videdit.effetti"), keys: "Shift+7", run: () => LL.show("effects") },
    ],
  };
  for (const name of Object.keys(MENUS)) {
    const b = el("button", { class: "ps-mbtn", type: "button" }, _t("videdit.menu_" + name.toLowerCase()));
    b.addEventListener("click", () => (menuEl && menuEl.dataset.m === name ? closeMenu() : (openMenuAt(b, MENUS[name]()), (menuEl.dataset.m = name))));
    b.addEventListener("pointerenter", () => { if (menuEl && menuEl.dataset.m && menuEl.dataset.m !== name) { openMenuAt(b, MENUS[name]()); menuEl.dataset.m = name; } });
    ctx.tb.append(b);
  }
  const tbBtn = (icon, label, title, fn) => { const b = el("button", { type: "button", title, onclick: fn }); b.innerHTML = vIcon(icon, 16); b.append(label); return b; };
  ctx.tb.append(el("span", { class: "sep" }), tbBtn("undo", "", _t("videdit.annulla_ctrl_z"), undo), tbBtn("redo", "", _t("videdit.ripeti_ctrl_maiusc_z"), redo), el("span", { class: "grow" }),
    tbBtn("import", _t("videdit.importa"), _t("videdit.importa_file_multimediali_ctrl_i_2"), doImport), tbBtn("export", _t("videdit.esporta_2"), _t("videdit.esporta_video_ffmpeg_ctrl_m"), exportDialog));

  // ------------------------------------------------------------------ tasti di Premiere Pro
  const free = () => !menuEl;
  keymap(ctx, "Premiere Pro", [
    { keys: "Space", desc: _t("videdit.riproduci_interrompi"), run: togglePlay, group: _t("videdit.riproduzione") },
    { keys: "L", desc: _t("videdit.riproduci_avanti_premuto_piu_volte"), run: () => jkl("L"), group: _t("videdit.riproduzione") },
    { keys: "K", desc: _t("videdit.interrompi"), run: () => jkl("K"), group: _t("videdit.riproduzione") },
    { keys: "J", desc: _t("videdit.riproduci_indietro_premuto_piu_volte"), run: () => jkl("J"), group: _t("videdit.riproduzione") },
    { keys: "ArrowLeft", desc: _t("videdit.indietro_fotogramma"), run: () => (focus === "source" ? srcSeek(srcVideo.currentTime - fr()) : step(-1)), group: _t("videdit.riproduzione") },
    { keys: "ArrowRight", desc: _t("videdit.avanti_fotogramma"), run: () => (focus === "source" ? srcSeek(srcVideo.currentTime + fr()) : step(1)), group: _t("videdit.riproduzione") },
    { keys: "Shift+ArrowLeft", desc: _t("videdit.indietro_5_fotogrammi"), run: () => step(-5), group: _t("videdit.riproduzione") },
    { keys: "Shift+ArrowRight", desc: _t("videdit.avanti_5_fotogrammi"), run: () => step(5), group: _t("videdit.riproduzione") },
    { keys: "ArrowUp", desc: _t("videdit.vai_punto_modifica_precedente"), run: () => gotoEdit(-1), group: _t("videdit.riproduzione") },
    { keys: "ArrowDown", desc: _t("videdit.vai_punto_modifica_successivo"), run: () => gotoEdit(1), group: _t("videdit.riproduzione") },
    { keys: "Home", desc: _t("videdit.vai_all_inizio"), run: () => goto(0), group: _t("videdit.riproduzione") },
    { keys: "End", desc: _t("videdit.vai_fine"), run: () => goto(total()), group: _t("videdit.riproduzione") },
    { keys: "I", desc: _t("videdit.contrassegna_attacco"), run: markIn, group: _t("videdit.marcatori") },
    { keys: "O", desc: _t("videdit.contrassegna_stacco_2"), run: markOut, group: _t("videdit.marcatori") },
    { keys: "X", desc: _t("videdit.contrassegna_clip"), run: markClip, group: _t("videdit.marcatori") },
    { keys: "Shift+I", desc: _t("videdit.vai_ad_attacco"), run: () => (focus === "source" ? srcSeek(src.in ?? 0) : goto(P.inPoint ?? 0)), group: _t("videdit.marcatori") },
    { keys: "Shift+O", desc: _t("videdit.vai_stacco"), run: () => (focus === "source" ? srcSeek(src.out ?? srcLen()) : goto(P.outPoint ?? total())), group: _t("videdit.marcatori") },
    { keys: "Ctrl+Shift+I", desc: _t("videdit.cancella_attacco"), run: () => { P.inPoint = null; commit(_t("videdit.cancella_attacco")); }, group: _t("videdit.marcatori") },
    { keys: "Ctrl+Shift+O", desc: _t("videdit.cancella_stacco"), run: () => { P.outPoint = null; commit(_t("videdit.cancella_stacco")); }, group: _t("videdit.marcatori") },
    { keys: "Ctrl+Shift+X", desc: _t("videdit.cancella_attacco_stacco"), run: () => { if (focus === "source") { src.in = src.out = null; drawSrc(); } else { P.inPoint = P.outPoint = null; commit(_t("videdit.cancella_attacco_stacco")); } }, group: _t("videdit.marcatori") },
    { keys: "M", desc: _t("videdit.aggiungi_marcatore"), run: addMarker, group: _t("videdit.marcatori") },
    { keys: "Shift+M", desc: _t("videdit.vai_marcatore_successivo"), run: () => gotoMarker(1), group: _t("videdit.marcatori") },
    { keys: "Ctrl+Shift+M", desc: _t("videdit.vai_marcatore_precedente"), run: () => gotoMarker(-1), group: _t("videdit.marcatori") },
    ...TOOLS.map(([id, name, key]) => ({ keys: key, desc: name, run: () => setTool(id), group: _t("videdit.strumenti"), when: free })),
    { keys: "Ctrl+K", desc: _t("videdit.aggiungi_modifica_dividi_testina"), run: () => addEdit(false), group: _t("videdit.montaggio") },
    { keys: "Ctrl+Shift+K", desc: _t("videdit.aggiungi_modifica_tutte_tracce"), run: () => addEdit(true), group: _t("videdit.montaggio") },
    { keys: "Q", desc: _t("videdit.taglio_ripple_modifica_precedente_fino"), run: () => rippleTrimTo(true), group: _t("videdit.montaggio") },
    { keys: "W", desc: _t("videdit.taglio_ripple_modifica_successiva_fino"), run: () => rippleTrimTo(false), group: _t("videdit.montaggio") },
    { keys: "Delete|Backspace", desc: _t("videdit.cancella_clip_transizione_fotogramma_chiave"), run: clearSel, group: _t("videdit.montaggio") },
    { keys: "Shift+Delete|Shift+Backspace|Alt+Backspace", desc: _t("videdit.elimina_ripple"), run: rippleDelete, group: _t("videdit.montaggio") },
    { keys: ",", desc: _t("videdit.inserisci_monitor_sorgente"), run: () => fromSource(true), group: _t("videdit.montaggio") },
    { keys: ".", desc: _t("videdit.sovrascrivi_monitor_sorgente"), run: () => fromSource(false), group: _t("videdit.montaggio") },
    { keys: ";", desc: _t("videdit.solleva_attacco_stacco"), run: liftInOut, group: _t("videdit.montaggio") },
    { keys: "'", desc: _t("videdit.estrai_attacco_stacco_ripple"), run: extractInOut, group: _t("videdit.montaggio") },
    { keys: "Ctrl+D", desc: _t("videdit.applica_transizione_video_predefinita_dissolvenza"), run: () => defaultTransition(false), group: _t("videdit.montaggio") },
    { keys: "Ctrl+Shift+D", desc: _t("videdit.applica_transizione_audio_predefinita_potenza"), run: () => defaultTransition(true), group: _t("videdit.montaggio") },
    { keys: "Shift+D", desc: _t("videdit.applica_transizioni_predefinite_selezione"), run: () => { defaultTransition(false); defaultTransition(true); }, group: _t("videdit.montaggio") },
    { keys: "Ctrl+L", desc: _t("videdit.collega_scollega_audio_video"), run: toggleLink, group: _t("videdit.montaggio") },
    { keys: "Ctrl+R", desc: _t("videdit.velocita_durata_clip"), run: speedDialog, group: _t("videdit.montaggio") },
    { keys: "G", desc: _t("videdit.guadagno_audio_2"), run: audioGainDialog, group: _t("videdit.montaggio") },
    { keys: "Shift+E", desc: _t("videdit.abilita_disabilita_clip"), run: toggleEnable, group: _t("videdit.montaggio") },
    { keys: "S", desc: _t("videdit.aggancia_timeline"), run: toggleSnap, group: _t("videdit.montaggio") },
    { keys: "Ctrl+Z", desc: _t("common.annulla_op"), run: undo, group: _t("videdit.modifica") },
    { keys: "Ctrl+Shift+Z|Ctrl+Y", desc: _t("common.ripeti"), run: redo, group: _t("videdit.modifica") },
    { keys: "Ctrl+C", desc: _t("common.copia"), run: () => copySel(false), group: _t("videdit.modifica") },
    { keys: "Ctrl+X", desc: _t("common.taglia"), run: () => copySel(true), group: _t("videdit.modifica") },
    { keys: "Ctrl+V", desc: _t("common.incolla"), run: () => paste(false), group: _t("videdit.modifica") },
    { keys: "Ctrl+Shift+V", desc: _t("videdit.incolla_inserimento"), run: () => paste(true), group: _t("videdit.modifica") },
    { keys: "Ctrl+Alt+V", desc: _t("videdit.incolla_attributi"), run: pasteAttributes, group: _t("videdit.modifica") },
    { keys: "Ctrl+A", desc: _t("videdit.seleziona_tutto"), run: selectAll, group: _t("videdit.modifica") },
    { keys: "Ctrl+Shift+A|Escape", desc: _t("videdit.deseleziona_tutto"), run: deselect, group: _t("videdit.modifica") },
    { keys: "Plus|=", desc: _t("videdit.zoom_avanti_timeline_2"), run: () => setZoom(pps * 1.5), group: _t("videdit.visualizza") },
    { keys: "Minus", desc: _t("videdit.zoom_indietro_timeline_2"), run: () => setZoom(pps / 1.5), group: _t("videdit.visualizza") },
    { keys: "\\", desc: _t("videdit.adatta_sequenza_finestra"), run: zoomFit, group: _t("videdit.visualizza") },
    { keys: "Shift+1", desc: _t("videdit.pannello_progetto"), run: () => LL.show("project"), group: _t("videdit.finestra") },
    { keys: "Shift+2", desc: _t("videdit.monitor_sorgente"), run: () => UL.show("source"), group: _t("videdit.finestra") },
    { keys: "Shift+5", desc: _t("videdit.controlli_effetti"), run: () => UL.show("ec"), group: _t("videdit.finestra") },
    { keys: "Shift+6", desc: _t("videdit.mixer_tracce_audio"), run: () => UL.show("mixer"), group: _t("videdit.finestra") },
    { keys: "Shift+7", desc: _t("videdit.pannello_effetti"), run: () => LL.show("effects"), group: _t("videdit.finestra") },
    { keys: "Ctrl+I", desc: _t("videdit.importa"), run: doImport, group: _t("videdit.file") },
    { keys: "Ctrl+M", desc: _t("videdit.esporta_media_2"), run: exportDialog, group: _t("videdit.file") },
    { keys: "Ctrl+Shift+E", desc: _t("videdit.esporta_fotogramma_2"), run: exportFrame, group: _t("videdit.file") },
    { keys: "Ctrl+T", desc: _t("videdit.nuovo_titolo"), run: () => newTitle(), group: _t("videdit.grafica") },
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
    ctx.status(_t("videdit.sequenza_0_1_2_fps", P.settings.w, P.settings.h, fps, tc(total(), fps), n) + (sel.size ? _t("videdit.0_selezionate", sel.size) : ""));
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
  history = [{ label: _t("videdit.apri"), s: snapState() }]; hi = 0;
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
    out.app = "MB Desk";
    out.playhead = player.t; out.zoom = pps;
    for (const m of out.media) { delete m.offline; m.rel = relPath(dir, m.path); }
    return JSON.stringify(out, null, 1);
  }
  return {
    saveFormats: ["mbvid"],
    saveLabels: { mbvid: _t("videdit.progetto_video_mb_visual") },
    saveNote: _t("videdit.creare_file_video_usa_esporta"),
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
