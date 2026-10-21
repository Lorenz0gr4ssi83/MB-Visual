// Montaggio video: modello del progetto .mbvid, catalogo di effetti e transizioni, fotogrammi chiave, titoli.
// Le stesse regole valgono per l'anteprima (vidgl.js / vidplay.js) e per l'esportazione con FFmpeg (mbvisual/video.py).
//
// Progetto (JSON): { mbvid: 1, settings: { w, h, fps, bg }, media: [{ id, path, rel, name, kind: video|audio|image, dur, w, h, fps, audio }],
//   tracks: { v: [{ id, name, lock, hide }] (V1 = in basso), a: [{ id, name, lock, mute, solo, gain }] },
//   clips: [{ id, track, kind: video|image|title|color|audio, media, start, dur, in, speed, link, off, name,
//            motion: { x, y, scale, rot }, opacity, blend, fx: [{ type, on, p }], kf: { x|y|scale|rot|opacity|volume: [[t, v]] },
//            title: {...}, color, gain, volume }],
//   transitions: [{ id, track, a, b, type, dur }]  (a = clip in uscita, b = clip in entrata; una delle due puo' mancare)
//   markers: [{ t, name }], inPoint, outPoint, playhead, zoom }
// Tempi in secondi (multipli di un fotogramma); i fotogrammi chiave sono relativi all'inizio della clip in timeline.

export const EFFECTS = {
  color: { name: "Correzione colore", group: "Regolazione colore", params: [
    { k: "bright", n: "Luminosita'", min: -100, max: 100, d: 0 }, { k: "contrast", n: "Contrasto", min: -100, max: 100, d: 0 },
    { k: "gamma", n: "Gamma", min: 0.2, max: 3, d: 1, step: 0.01 }, { k: "sat", n: "Saturazione", min: 0, max: 300, d: 100, u: "%" },
    { k: "temp", n: "Temperatura", min: -100, max: 100, d: 0 }, { k: "tint", n: "Tinta", min: -100, max: 100, d: 0 }] },
  bw: { name: "Bianco e nero", group: "Regolazione colore", params: [] },
  lut: { name: "LUT colore (.cube)", group: "Regolazione colore", params: [{ k: "file", n: "File LUT", type: "file", d: "" }] },
  blur: { name: "Sfocatura gaussiana", group: "Sfocatura e nitidezza", params: [{ k: "sigma", n: "Sfocatura", min: 0, max: 60, d: 6, step: 0.1, u: "px" }] },
  sharpen: { name: "Nitidezza", group: "Sfocatura e nitidezza", params: [{ k: "amount", n: "Quantita'", min: 0, max: 2, d: 0.5, step: 0.1 }] },
  crop: { name: "Ritaglio", group: "Trasforma", params: [{ k: "l", n: "Sinistra", min: 0, max: 100, d: 0, u: "%" }, { k: "t", n: "In alto", min: 0, max: 100, d: 0, u: "%" },
    { k: "r", n: "Destra", min: 0, max: 100, d: 0, u: "%" }, { k: "b", n: "In basso", min: 0, max: 100, d: 0, u: "%" }] },
  mirror: { name: "Rifletti", group: "Trasforma", params: [{ k: "h", n: "Orizzontale", type: "bool", d: true }, { k: "v", n: "Verticale", type: "bool", d: false }] },
  chroma: { name: "Chiave colore (green screen)", group: "Incrustazione", params: [{ k: "color", n: "Colore chiave", type: "color", d: "#00ff00" },
    { k: "sim", n: "Somiglianza", min: 0, max: 100, d: 30 }, { k: "blend", n: "Fusione", min: 0, max: 100, d: 10 }] },
};
export const AUDIO_EFFECTS = {
  normalize: { name: "Normalizza (picco a -1 dB)", group: "Ampiezza" },
  gain: { name: "Guadagno...", group: "Ampiezza" },
};
// transizioni: stessi nomi e forme di xfade di FFmpeg
export const TRANSITIONS = {
  fade: { name: "Dissolvenza incrociata", group: "Dissolvenza" }, fadeblack: { name: "Dissolvenza al nero", group: "Dissolvenza" },
  fadewhite: { name: "Dissolvenza al bianco", group: "Dissolvenza" },
  wipeleft: { name: "Tendina verso sinistra", group: "Tendina" }, wiperight: { name: "Tendina verso destra", group: "Tendina" },
  wipeup: { name: "Tendina verso l'alto", group: "Tendina" }, wipedown: { name: "Tendina verso il basso", group: "Tendina" },
  slideleft: { name: "Scorrimento a sinistra", group: "Scorrimento" }, slideright: { name: "Scorrimento a destra", group: "Scorrimento" },
  slideup: { name: "Scorrimento in alto", group: "Scorrimento" }, slidedown: { name: "Scorrimento in basso", group: "Scorrimento" },
  zoomin: { name: "Zoom avanti", group: "Zoom e forme" }, circleopen: { name: "Cerchio che si apre", group: "Zoom e forme" },
  circleclose: { name: "Cerchio che si chiude", group: "Zoom e forme" },
};
export const TRANS_IDX = Object.fromEntries(Object.keys(TRANSITIONS).map((k, i) => [k, i]));
export const AUDIO_TRANSITIONS = { power: { name: "Potenza costante", group: "Dissolvenza incrociata" }, gain: { name: "Guadagno costante", group: "Dissolvenza incrociata" } };
export const BLENDS = { normal: "Normale", multiply: "Moltiplica", screen: "Scolora", overlay: "Sovrapponi", hardlight: "Luce intensa", darken: "Scurisci",
  lighten: "Schiarisci", difference: "Differenza", add: "Aggiungi" };
export const BLEND_IDX = Object.fromEntries(Object.keys(BLENDS).map((k, i) => [k, i]));
export const FONTS = ["Arial", "Arial Black", "Bahnschrift", "Calibri", "Cambria", "Candara", "Comic Sans MS", "Consolas", "Constantia", "Corbel", "Courier New",
  "Georgia", "Impact", "Segoe UI", "Segoe UI Black", "Segoe Script", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"];
export const PRESETS = [["HD 1080p", 1920, 1080], ["4K UHD", 3840, 2160], ["HD 720p", 1280, 720], ["Verticale 1080x1920 (social)", 1080, 1920],
  ["Quadrato 1080x1080", 1080, 1080], ["SD 854x480", 854, 480]];
export const RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

export const uid = p => p + Math.random().toString(36).slice(2, 9);
export const dbToLin = db => Math.pow(10, db / 20);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function newProject(o = {}) {
  return {
    mbvid: 1, settings: { w: o.w || 1920, h: o.h || 1080, fps: o.fps || 25, bg: "#000000" }, media: [],
    tracks: { v: [{ id: "V1", name: "Video 1" }, { id: "V2", name: "Video 2" }, { id: "V3", name: "Video 3" }],
      a: [{ id: "A1", name: "Audio 1", gain: 0 }, { id: "A2", name: "Audio 2", gain: 0 }, { id: "A3", name: "Audio 3", gain: 0 }] },
    clips: [], transitions: [], markers: [], inPoint: null, outPoint: null, playhead: 0, zoom: null,
  };
}

// fotogrammi chiave: interpolazione lineare, valori costanti prima del primo e dopo l'ultimo (come video.py)
export function kfAt(keys, t, def) {
  if (!keys || !keys.length) return def;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
    if (t < t1) return t1 > t0 ? v0 + (v1 - v0) * (t - t0) / (t1 - t0) : v1;
  }
  return keys[keys.length - 1][1];
}
// valore di una proprieta' animabile della clip al tempo tau (dalla testa della clip)
export function propAt(c, prop, tau) {
  const k = c.kf?.[prop];
  const def = prop === "opacity" ? c.opacity ?? 100 : prop === "volume" ? c.volume ?? 0 : c.motion?.[prop] ?? null;
  return k && k.length ? kfAt(k, tau, def) : def;
}

// timing delle transizioni (stessa logica di video._layout): meta' durata oltre il taglio per le coppie
export function layout(P) {
  const L = new Map();
  for (const c of P.clips) L.set(c.id, { pre: 0, post: 0, tin: null, tout: null });
  for (const tr of P.transitions) {
    const a = L.get(tr.a), b = L.get(tr.b), ca = P.clips.find(c => c.id === tr.a), cb = P.clips.find(c => c.id === tr.b);
    if (!(tr.dur > 0)) continue;
    if (a && b) { if (ca.off || cb.off) continue; a.post = b.pre = tr.dur / 2; a.tout = b.tin = { pair: true, tr }; }
    else if (a) a.tout = { pair: false, tr };
    else if (b) b.tin = { pair: false, tr };
  }
  return L;
}

// transizioni valide: le coppie devono essere sulla stessa traccia e adiacenti; durata limitata dalle clip
export function validateTransitions(P) {
  const fr = 1 / P.settings.fps;
  const byId = new Map(P.clips.map(c => [c.id, c]));
  const used = new Set();
  P.transitions = P.transitions.filter(tr => {
    const a = byId.get(tr.a), b = byId.get(tr.b);
    if (!a && !b) return false;
    if (a && b && (a.track !== b.track || Math.abs(a.start + a.dur - b.start) > fr / 2)) {
      // non piu' adiacenti: diventa una transizione sul lato rimasto solo se ha senso, altrimenti si toglie
      return false;
    }
    const keyA = a ? a.id + ":out" : null, keyB = b ? b.id + ":in" : null;
    if ((keyA && used.has(keyA)) || (keyB && used.has(keyB))) return false;
    if (keyA) used.add(keyA);
    if (keyB) used.add(keyB);
    const max = a && b ? Math.min(a.dur, b.dur) * 2 : (a || b).dur;
    tr.dur = Math.round(Math.max(fr, Math.min(tr.dur, max)) * 1e6) / 1e6;
    tr.track = (a || b).track;
    return true;
  });
}

export const isAudioTrack = id => id[0] === "A";
export const clipEnd = c => c.start + c.dur;
export function snapT(t, fps) { return Math.round(t * fps) / fps; }

// timecode HH:MM:SS:FF
export function tc(t, fps) {
  const neg = t < 0;
  t = Math.abs(t);
  const fr = Math.round(fps);
  const total = Math.round(t * fps);
  const f = total % fr, s = Math.floor(total / fr);
  const p = n => String(n).padStart(2, "0");
  return (neg ? "-" : "") + `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f)}`;
}
export function parseTc(str, fps) {
  const s = String(str).trim();
  if (/^-?\d+(\.\d+)?s$/.test(s)) return parseFloat(s);
  const parts = s.split(/[:;.]/).map(Number);
  if (parts.some(isNaN)) return null;
  while (parts.length < 4) parts.unshift(0);
  const [h, m, sec, f] = parts.slice(-4);
  return h * 3600 + m * 60 + sec + f / Math.round(fps);
}

// ------------------------------------------------------------------ titoli (grafica): testo disegnato su un canvas
export function defaultTitle() {
  return { text: "Titolo", font: "Arial", size: 96, color: "#ffffff", bold: true, italic: false, align: "center", lineH: 1.15,
    stroke: false, strokeColor: "#000000", strokeW: 4, shadow: true, shadowColor: "#000000", bg: false, bgColor: "#000000", bgOpacity: 60, pad: 24 };
}
// canvas della grandezza del testo (pixel della sequenza): la clip titolo non viene adattata (1 px = 1 px)
export function renderTitle(T, scale = 1) {
  const c = document.createElement("canvas");
  const g = c.getContext("2d");
  const size = T.size * scale;
  const font = `${T.italic ? "italic " : ""}${T.bold ? "bold " : ""}${size}px "${T.font}"`;
  g.font = font;
  const lines = String(T.text || " ").split("\n");
  const lh = size * (T.lineH || 1.15);
  const widths = lines.map(l => g.measureText(l || " ").width);
  const pad = (T.pad ?? 24) * scale + (T.stroke ? T.strokeW * scale : 0) + (T.shadow ? 8 * scale : 0);
  const w = Math.ceil(Math.max(...widths) + pad * 2), h = Math.ceil(lh * lines.length + pad * 2);
  c.width = Math.max(2, w); c.height = Math.max(2, h);
  g.font = font;
  g.textBaseline = "middle";
  if (T.bg) {
    g.globalAlpha = (T.bgOpacity ?? 60) / 100; g.fillStyle = T.bgColor; g.fillRect(0, 0, c.width, c.height); g.globalAlpha = 1;
  }
  lines.forEach((l, i) => {
    const y = pad + lh * (i + 0.5);
    const x = T.align === "left" ? pad : T.align === "right" ? c.width - pad - widths[i] : (c.width - widths[i]) / 2;
    if (T.shadow) { g.shadowColor = T.shadowColor || "#000"; g.shadowBlur = 6 * scale; g.shadowOffsetX = g.shadowOffsetY = 3 * scale; }
    if (T.stroke && T.strokeW > 0) { g.lineJoin = "round"; g.strokeStyle = T.strokeColor; g.lineWidth = T.strokeW * 2 * scale; g.strokeText(l, x, y); g.shadowColor = "transparent"; }
    g.fillStyle = T.color; g.fillText(l, x, y);
    g.shadowColor = "transparent";
  });
  return c;
}

// tabella LUT .cube -> { size, data: Float32Array RGB }
export function parseCube(text) {
  let size = 0;
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l[0] === "#") continue;
    if (/^LUT_3D_SIZE/i.test(l)) { size = parseInt(l.split(/\s+/)[1]); continue; }
    if (/^[A-Z_]/i.test(l)) continue;
    const p = l.split(/\s+/).map(Number);
    if (p.length >= 3 && !p.slice(0, 3).some(isNaN)) vals.push(p[0], p[1], p[2]);
  }
  if (!size || vals.length < size * size * size * 3) throw new Error("File LUT .cube non valido (serve una LUT 3D)");
  return { size, data: new Float32Array(vals.slice(0, size * size * size * 3)) };
}
