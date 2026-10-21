// Montaggio video: riproduzione dell'anteprima. Un elemento <video>/<audio> per clip (creato quando la testina si
// avvicina), sincronizzato con l'orologio della sequenza; l'audio passa da Web Audio (guadagno di clip e traccia con
// fotogrammi chiave e dissolvenze come afade, mute/solo, misuratori). I fotogrammi si compongono con vidgl.js.
import { api, extOf, fileUrl, waitJob } from "./core.js";
import { clamp, dbToLin, layout, parseCube, propAt, renderTitle } from "./vidmodel.js";
import { Compositor } from "./vidgl.js";

const NATIVE_V = new Set(["mp4", "m4v", "webm", "ogv", "mov"]);
const NATIVE_A = new Set(["mp3", "wav", "wave", "flac", "ogg", "oga", "opus", "m4a", "aac", "mp4", "m4v", "webm", "mov"]);
const NATIVE_I = new Set(["png", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "avif", "ico", "svg"]);

export class Player {
  constructor(getP, canvas, cb = {}) {
    this.getP = getP;
    this.cb = cb;
    this.gl = new Compositor(canvas);
    this.canvas = canvas;
    this.urls = new Map();     // media id -> Promise<url>
    this.urlNow = new Map();   // media id -> url pronto
    this.imgs = new Map();
    this.titles = new Map();
    this.luts = new Map();
    this.els = new Map();      // clip id -> { el, kind, url, gain }
    this.t = 0;
    this.playing = false;
    this.rate = 1;
    this.q = 1;
    this.ac = null;
    this.busy = new Set();
    this.dirty = true;
  }

  // ------------------------------------------------------------ indirizzi riproducibili
  url(m) {
    if (!m || m.offline) return null;
    if (this.urlNow.has(m.id)) return this.urlNow.get(m.id);
    if (!this.urls.has(m.id)) {
      const p = this._resolve(m).then(u => { this.urlNow.set(m.id, u); this.busy.delete(m.id); this.dirty = true; this.cb.onReady?.(m); return u; })
        .catch(e => { this.urlNow.set(m.id, null); this.busy.delete(m.id); this.cb.onError?.(m, e); return null; });
      this.urls.set(m.id, p);
    }
    return undefined;
  }
  async _resolve(m) {
    const ext = extOf(m.path);
    if (m.kind === "image") {
      if (NATIVE_I.has(ext)) return fileUrl(m.path);
      const r = await api("image", { path: m.path });
      return fileUrl(r.path);
    }
    const natives = m.kind === "audio" ? NATIVE_A : NATIVE_V;
    if (natives.has(ext)) {
      const ok = await new Promise(res => {
        const t = document.createElement(m.kind === "audio" ? "audio" : "video");
        t.preload = "metadata";
        t.onloadedmetadata = () => res(m.kind === "audio" || t.videoWidth > 0);
        t.onerror = () => res(false);
        setTimeout(() => res(false), 8000);
        t.src = fileUrl(m.path);
      });
      if (ok) return fileUrl(m.path);
    }
    // formato non riproducibile dal motore del browser: copia di anteprima con FFmpeg (come il "conforming" di Premiere)
    this.busy.add(m.id);
    this.cb.onBusy?.(m);
    const j = await api("media_playable", { path: m.path });
    const r = await waitJob(j.job, p => this.cb.onProgress?.(m, p));
    return fileUrl(r.path);
  }
  forget(mediaId) { this.urls.delete(mediaId); this.urlNow.delete(mediaId); this.imgs.delete(mediaId); }

  // ------------------------------------------------------------ audio
  audio() {
    if (!this.ac) {
      const ac = this.ac = new AudioContext({ latencyHint: "interactive" });
      this.master = ac.createGain();
      // le sorgenti mono vanno su entrambi i canali (come aformat=stereo nell'esportazione)
      Object.assign(this.master, { channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers" });
      const sp = ac.createChannelSplitter(2);
      this.an = [ac.createAnalyser(), ac.createAnalyser()];
      this.an.forEach((a, i) => { a.fftSize = 1024; sp.connect(a, i); });
      this.master.connect(sp);
      this.master.connect(ac.destination);
      this.tg = new Map();
    }
    return this.ac;
  }
  trackGain(id) {
    this.audio();
    if (!this.tg.has(id)) { const g = this.ac.createGain(); Object.assign(g, { channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers" }); g.connect(this.master); this.tg.set(id, g); }
    return this.tg.get(id);
  }
  meters() {
    if (!this.an) return [0, 0];
    const buf = new Float32Array(1024);
    return this.an.map(a => { a.getFloatTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v)); return m; });
  }

  // ------------------------------------------------------------ elementi per clip
  _el(c, m) {
    let r = this.els.get(c.id);
    const url = this.url(m);
    if (!url) return null;
    if (r && r.url === url) return r;
    if (r) this._drop(c.id);
    const audio = c.kind === "audio";
    const el = document.createElement(audio ? "audio" : "video");
    el.preload = "auto";
    el.muted = !audio;
    el.playsInline = true;
    el.preservesPitch = true;
    el.src = url;
    r = { el, url, audio };
    el.addEventListener("seeked", () => { this.dirty = true; });
    el.addEventListener("loadeddata", () => { this.dirty = true; });
    if (audio) {
      const ac = this.audio();
      r.src = ac.createMediaElementSource(el);
      r.gain = ac.createGain();
      r.gain.gain.value = 0;
      r.src.connect(r.gain);
      r.gain.connect(this.trackGain(c.track));
    }
    this.els.set(c.id, r);
    return r;
  }
  _drop(id) {
    const r = this.els.get(id);
    if (!r) return;
    try { r.el.pause(); r.el.removeAttribute("src"); r.el.load(); r.gain?.disconnect(); r.src?.disconnect(); } catch { /* */ }
    this.els.delete(id);
    this.gl.dropSource("v:" + id);
  }
  dispose() {
    this.stop();
    for (const id of [...this.els.keys()]) this._drop(id);
    try { this.ac?.close(); } catch { /* */ }
  }

  srcTime(c, m, t) {
    const sp = c.speed || 1;
    const x = (c.in || 0) + (t - c.start) * sp;
    return x;
  }

  // ------------------------------------------------------------ sincronizzazione (a ogni fotogramma)
  sync(t, playing) {
    const P = this.getP();
    const L = this.lay = layout(P);
    const fps = P.settings.fps;
    const media = new Map(P.media.map(m => [m.id, m]));
    const keep = new Set();
    const vhide = new Set(P.tracks.v.filter(x => x.hide).map(x => x.id));
    const solo = P.tracks.a.some(x => x.solo);
    if (this.master) this.master.gain.value = dbToLin(P.settings.master || 0);
    for (const tr of P.tracks.a) {
      const g = this.ac ? this.trackGain(tr.id) : null;
      if (g) g.gain.setTargetAtTime(tr.mute || (solo && !tr.solo) ? 0 : dbToLin(tr.gain || 0), this.ac.currentTime, 0.015);
    }
    for (const c of P.clips) {
      if (c.kind !== "video" && c.kind !== "audio") continue;
      const lay = L.get(c.id);
      const a = c.start - lay.pre, b = c.start + c.dur + lay.post;
      if (c.off || b < t - 3 || a > t + (playing ? 4 : 1.5) || (c.kind === "video" && vhide.has(c.track))) continue;
      const m = media.get(c.media);
      if (!m) continue;
      const r = this._el(c, m);
      if (!r) continue;
      keep.add(c.id);
      const el = r.el;
      const mdur = m.dur || el.duration || 1e9;
      const want = this.srcTime(c, m, t);
      const inside = t >= a && t < b;
      const inMedia = want >= 0 && want < mdur - 0.5 / fps;
      if (r.audio) {
        // guadagno: livello (dB, animabile) + guadagno clip + dissolvenze (afade tri / qsin)
        let g = 0;
        if (inside && inMedia && playing && Math.abs(this.rate) <= 2.01) {
          const tau = t - c.start, Lt = tau + lay.pre, len = lay.pre + c.dur + lay.post;
          g = dbToLin((propAt(c, "volume", tau) || 0) + (c.gain || 0));
          const curve = (tr, x) => (x = clamp(x, 0, 1), tr.type === "power" ? Math.sin(x * Math.PI / 2) : x);
          if (lay.tin) g *= curve(lay.tin.tr, Lt / Math.min(lay.tin.tr.dur, len));
          if (lay.tout) { const d = Math.min(lay.tout.tr.dur, len); g *= curve(lay.tout.tr, (len - Lt) / d); }
        }
        r.gain.gain.setTargetAtTime(g, this.ac.currentTime, 0.012);
      }
      const target = clamp(want, 0, Math.max(0, mdur - 0.5 / fps));
      if (playing && this.rate > 0 && inside && inMedia) {
        el.playbackRate = clamp(this.rate * (c.speed || 1), 0.0625, 16);
        if (el.paused) { el.currentTime = target; el.play().catch(() => { }); }
        else if (Math.abs(el.currentTime - target) > 0.2 * Math.max(1, this.rate)) el.currentTime = target;
      } else {
        if (!el.paused) el.pause();
        // in pausa (o fuori dalla clip): fotogramma esatto per l'anteprima, prossimo inizio pronto
        const goal = inside ? target : clamp((c.in || 0) - lay.pre * (c.speed || 1), 0, mdur);
        if (!r.audio && Math.abs(el.currentTime - goal) > 0.4 / fps && !el.seeking) el.currentTime = goal + 0.0005;
      }
    }
    for (const id of [...this.els.keys()]) if (!keep.has(id)) this._drop(id);
  }

  // true quando tutti i video da mostrare hanno il fotogramma giusto (per l'anteprima in pausa e l'esportazione del fotogramma)
  settled() { for (const r of this.els.values()) if (!r.audio && (r.el.seeking || r.el.readyState < 2)) return false; return true; }

  // ------------------------------------------------------------ composizione
  render(t) {
    const P = this.getP();
    const { w: W, h: H, fps } = P.settings;
    const L = this.lay || layout(P);
    const q = this.q;
    const G = this.gl;
    const cw = Math.max(2, Math.round(W * q)), ch = Math.max(2, Math.round(H * q));
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    this.incomplete = false;
    G.begin(cw, ch, P.settings.bg || "#000000");
    const media = new Map(P.media.map(m => [m.id, m]));
    const byId = new Map(P.clips.map(c => [c.id, c]));
    for (const tr of P.tracks.v) {
      if (tr.hide) continue;
      const act = P.clips.filter(c => c.track === tr.id && c.kind !== "audio" && !c.off && t >= c.start - L.get(c.id).pre && t < c.start + c.dur + L.get(c.id).post)
        .sort((a, b) => a.start - b.start);
      if (!act.length) continue;
      const first = c => { let x = c; for (let i = 0; i < 500; i++) { const l = L.get(x.id); if (l.tin?.pair && byId.get(l.tin.tr.a)) x = byId.get(l.tin.tr.a); else break; } return x; };
      if (act.length >= 2 && L.get(act[1].id).tin?.pair) {
        const A = act[0], B = act[1], tr2 = L.get(B.id).tin.tr, d = tr2.dur;
        const p = clamp(1 - (t - (B.start - d / 2)) / d, 0, 1);
        const la = this._clip(A, t, media, W, H, fps), lb = this._clip(B, t, media, W, H, fps);
        const mixed = G.transition(la || G._blank(), lb || G._blank(), tr2.type, p);
        G.put(la); G.put(lb);
        G.composite(mixed, first(A).blend || "normal");
        G.put(mixed);
        continue;
      }
      const c = act[act.length - 1];
      let lay = this._clip(c, t, media, W, H, fps);
      if (!lay) continue;
      const l = L.get(c.id), len = l.pre + c.dur + l.post, Lt = t - c.start + l.pre;
      if (l.tin && !l.tin.pair) {
        const d = Math.min(l.tin.tr.dur, len);
        if (Lt < d) { const p = 1 - Lt / d; const o = l.tin.tr.type === "fade" ? G.transition(null, lay, "fade", p, 1) : G.transition(G._blank(), lay, l.tin.tr.type, p); G.put(lay); lay = o; }
      }
      if (l.tout && !l.tout.pair) {
        const d = Math.min(l.tout.tr.dur, len);
        if (Lt >= len - d) { const p = 1 - (Lt - (len - d)) / d; const o = l.tout.tr.type === "fade" ? G.transition(lay, null, "fade", p, 2) : G.transition(lay, G._blank(), l.tout.tr.type, p); G.put(lay); lay = o; }
      }
      G.composite(lay, first(c).blend || "normal");
      G.put(lay);
    }
    G.present();
    this.dirty = false;
  }

  // livello (FBO grande quanto l'anteprima) di una clip al tempo t
  _clip(c, t, media, W, H, fps) {
    const G = this.gl, q = this.q;
    let src, sw, sh;
    if (c.kind === "video") {
      const r = this.els.get(c.id);
      if (!r || r.el.readyState < 2 || !r.el.videoWidth || r.el.seeking) { this.incomplete = true; if (!r || r.el.readyState < 2 || !r.el.videoWidth) return null; }
      sw = r.el.videoWidth; sh = r.el.videoHeight;
      src = G.source("v:" + c.id, r.el, sw, sh, true);
    } else if (c.kind === "image") {
      const m = media.get(c.media);
      const url = this.url(m);
      if (!url) return null;
      let im = this.imgs.get(m.id);
      if (!im || im.src !== new URL(url, location.href).href) { im = new Image(); im.onload = () => { this.dirty = true; }; im.src = url; this.imgs.set(m.id, im); }
      if (!im.complete || !im.naturalWidth) { this.incomplete = true; return null; }
      sw = im.naturalWidth; sh = im.naturalHeight;
      src = G.source("img:" + m.id, im, sw, sh, false);
    } else if (c.kind === "title") {
      const key = JSON.stringify(c.title);
      let tt = this.titles.get(c.id);
      if (!tt || tt.key !== key) { tt = { key, cv: renderTitle(c.title), fresh: true }; this.titles.set(c.id, tt); }
      sw = tt.cv.width; sh = tt.cv.height;
      src = G.source("title:" + c.id, tt.cv, sw, sh, tt.fresh);
      tt.fresh = false;
    } else if (c.kind === "color") {
      sw = W; sh = H;
      src = G.colorSource(c.color || "#000000");
      src = { tex: src.tex, w: 1, h: 1 };
    } else return null;
    const tau = t - c.start;
    const f = c.kind === "title" ? 1 : Math.min(W / sw, H / sh);
    const S = propAt(c, "scale", tau) ?? 100;
    const qe = clamp(f * q * Math.max(1, S / 100), 0.05, 1);
    const fx = G.effects(src, sw, sh, c.fx, (propAt(c, "opacity", tau) ?? 100) / 100, qe, file => this._lut(file));
    const x = propAt(c, "x", tau) ?? W / 2, y = propAt(c, "y", tau) ?? H / 2, rot = (propAt(c, "rot", tau) || 0) * Math.PI / 180;
    const layer = G.layer(fx, x, y, sw * f * S / 100, sh * f * S / 100, rot, q);
    G.put(fx);
    return layer;
  }
  _lut(file) {
    if (!file) return null;
    const e = this.luts.get(file);
    if (e === undefined) {
      this.luts.set(file, null);
      fetch(fileUrl(file)).then(r => r.text()).then(tx => { this.luts.set(file, this.gl.lut(file, parseCube(tx))); this.dirty = true; })
        .catch(err => this.cb.onError?.({ name: file }, err));
      return null;
    }
    return e;
  }

  // ------------------------------------------------------------ trasporto
  play(rate = 1) {
    this.rate = rate;
    if (this.ac?.state === "suspended" || !this.ac) this.audio().resume();
    if (this.playing) { this.t0 = this.t; this.w0 = performance.now(); return; }
    this.playing = true;
    this.t0 = this.t; this.w0 = performance.now();
    const tick = () => {
      if (!this.playing) return;
      const now = performance.now();
      let t = this.t0 + (now - this.w0) / 1000 * this.rate;
      const end = this.cb.end?.() ?? Infinity;
      if (t >= end && this.rate > 0) { t = end; this.t = t; this.stop(); this.sync(t, false); this.render(t); this.cb.onTime?.(t, true); return; }
      if (t <= 0 && this.rate < 0) { t = 0; this.t = 0; this.stop(); this.sync(0, false); this.render(0); this.cb.onTime?.(0, true); return; }
      this.t = t;
      this.sync(t, this.rate > 0);
      this.render(t);
      this.cb.onTime?.(t, false);
      this.cb.onMeter?.(this.meters());
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const r of this.els.values()) { try { r.el.pause(); if (r.gain) r.gain.gain.value = 0; } catch { /* */ } }
    this.cb.onMeter?.([0, 0]);
  }
  // posizionamento in pausa: aspetta i fotogrammi giusti e ridisegna
  seek(t) {
    this.t = t;
    if (this.playing) { this.t0 = t; this.w0 = performance.now(); return; }
    this.sync(t, false);
    this.render(t);
    clearTimeout(this._st);
    const again = (n = 0) => { this._st = setTimeout(() => { if (this.playing || this.t !== t) return; this.sync(t, false); this.render(t); if (!this.settled() && n < 40) again(n + 1); }, 30); };
    again();
  }
  // ridisegna se qualcosa e' cambiato (chiamata periodica dall'editor quando e' in pausa)
  idle() { if (!this.playing && (this.dirty || this.incomplete)) { this.sync(this.t, false); this.render(this.t); } }
}
