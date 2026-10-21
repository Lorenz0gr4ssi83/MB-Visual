// Montaggio video: compositore WebGL2 dell'anteprima (Monitor programma). Riproduce le formule del grafo FFmpeg di
// mbvisual/video.py: effetti alla risoluzione della sorgente (lutrgb + colorchannelmixer, gblur, convolution, colorkey,
// lut3d, hflip/vflip, crop+pad), opacita', trasformazione su una tela grande quanto la sequenza, transizioni come xfade,
// metodi di fusione come blend e sovrapposizione con alfa non premoltiplicato come overlay.
// Convenzione: in tutte le texture la riga 0 e' il bordo superiore dell'immagine (come FFmpeg); solo l'uscita sul canvas si capovolge.
import { TRANS_IDX, BLEND_IDX } from "./vidmodel.js";

const VS = `#version 300 es
in vec2 p; uniform mat3 m; out vec2 uv;
void main(){ uv = p; vec3 q = m * vec3(p, 1.0); gl_Position = vec4(q.xy, 0.0, 1.0); }`;
const HEAD = `#version 300 es
precision highp float; precision highp sampler3D; in vec2 uv; out vec4 o; uniform sampler2D t; uniform vec2 sz;
vec4 at(vec2 px){ return texture(t, (px + 0.5) / sz); }
float sstep(float a, float b, float x){ float k = clamp((x - a) / (b - a), 0.0, 1.0); return k * k * (3.0 - 2.0 * k); }
`;
const FS = {
  copy: `void main(){ o = texture(t, uv); }`,
  // Correzione colore: lutrgb (contrasto, luminosita', gamma) poi colorchannelmixer (saturazione, temperatura, tinta)
  color: `uniform float C, B, G; uniform mat3 M; uniform int useLut;
    void main(){ vec4 c = texture(t, uv); vec3 v = c.rgb;
      if (useLut == 1) v = clamp(pow(clamp((v - 0.5) * C + 0.5 + B, 0.0, 1.0), vec3(1.0 / G)), 0.0, 1.0);
      v = clamp(M * v, 0.0, 1.0); o = vec4(v, c.a); }`,
  blur: `uniform vec2 dir; uniform float sigma;
    void main(){ float r = ceil(sigma * 3.0); float st = max(1.0, r / 24.0); vec4 acc = vec4(0.0); float ws = 0.0;
      for (float i = -72.0; i <= 72.0; i += 1.0) { float x = i * st; if (abs(x) > r) continue; float w = exp(-x * x / (2.0 * sigma * sigma));
        acc += texture(t, uv + dir * x / sz) * w; ws += w; }
      o = acc / ws; }`,
  sharpen: `uniform float k;
    void main(){ vec2 d = 1.0 / sz; vec4 c = texture(t, uv);
      vec3 n = texture(t, uv + vec2(0.0, -d.y)).rgb + texture(t, uv + vec2(0.0, d.y)).rgb + texture(t, uv + vec2(-d.x, 0.0)).rgb + texture(t, uv + vec2(d.x, 0.0)).rgb;
      o = vec4(clamp(c.rgb * (1.0 + 4.0 * k) - k * n, 0.0, 1.0), c.a); }`,
  chroma: `uniform vec3 key; uniform float sim, bl;
    void main(){ vec4 c = texture(t, uv); vec3 d = c.rgb - key; float diff = sqrt(dot(d, d) / 3.0);
      float a = bl > 0.0001 ? clamp((diff - sim) / bl, 0.0, 1.0) : (diff > sim ? 1.0 : 0.0); o = vec4(c.rgb, a); }`,
  lut: `uniform sampler3D L; uniform float n;
    void main(){ vec4 c = texture(t, uv); vec3 q = c.rgb * (n - 1.0) / n + 0.5 / n; o = vec4(texture(L, q).rgb, c.a); }`,
  mirror: `uniform vec2 fl; void main(){ vec2 u = uv; if (fl.x > 0.5) u.x = 1.0 - u.x; if (fl.y > 0.5) u.y = 1.0 - u.y; o = texture(t, u); }`,
  crop: `uniform vec4 r; void main(){ vec2 px = uv * sz; vec4 c = texture(t, uv);
    o = (px.x < r.x || px.y < r.y || px.x > r.z || px.y > r.w) ? vec4(0.0) : c; }`,
  opacity: `uniform float a; void main(){ vec4 c = texture(t, uv); o = vec4(c.rgb, c.a * a); }`,
  // quadrilatero trasformato (lo shader di vertice porta i pixel della clip nella sequenza)
  xform: `void main(){ o = texture(t, uv); }`,
  // transizioni (A = t, B = tb); p va da 1 a 0 come in xfade
  trans: `uniform sampler2D tb; uniform float p; uniform int ty; uniform int alphaFade;
    vec4 A(vec2 px){ return texture(t, (px + 0.5) / sz); } vec4 Bc(vec2 px){ return texture(tb, (px + 0.5) / sz); }
    vec4 fm(vec4 a, vec4 b, float m){ return a * m + b * (1.0 - m); }
    void main(){ vec2 px = floor(uv * sz); float W = sz.x, H = sz.y; float x = px.x, y = px.y;
      vec4 a = A(px), b = Bc(px); vec4 bk = vec4(0.0, 0.0, 0.0, 1.0), wh = vec4(1.0);
      if (alphaFade == 1) { o = vec4(b.rgb, b.a * (1.0 - p)); return; }
      if (alphaFade == 2) { o = vec4(a.rgb, a.a * p); return; }
      if (ty == 0) o = fm(a, b, p);
      else if (ty == 1 || ty == 2) { vec4 c = ty == 1 ? bk : wh; vec4 f0 = fm(a, c, sstep(0.8, 1.0, p)); vec4 f1 = fm(c, b, sstep(0.2, 1.0, p)); o = fm(f0, f1, p); }
      else if (ty == 3) o = x > W * p ? b : a;
      else if (ty == 4) o = x > W * (1.0 - p) ? a : b;
      else if (ty == 5) o = y > H * p ? b : a;
      else if (ty == 6) o = y > H * (1.0 - p) ? a : b;
      else if (ty == 7) { float zx = x - p * W; o = (zx >= 0.0 && zx < W) ? Bc(vec2(zx, y)) : A(vec2(zx + W, y)); }
      else if (ty == 8) { float zx = x + p * W; o = (zx >= 0.0 && zx < W) ? Bc(vec2(zx, y)) : A(vec2(zx - W, y)); }
      else if (ty == 9) { float zy = y - p * H; o = (zy >= 0.0 && zy < H) ? Bc(vec2(x, zy)) : A(vec2(x, zy + H)); }
      else if (ty == 10) { float zy = y + p * H; o = (zy >= 0.0 && zy < H) ? Bc(vec2(x, zy)) : A(vec2(x, zy - H)); }
      else if (ty == 11) { float zf = sstep(0.5, 1.0, p); vec2 u = zf * (px / sz - 0.5) + 0.5; o = fm(texture(t, u), b, sstep(0.0, 0.5, p)); }
      else if (ty == 12 || ty == 13) { float z = length(vec2(W, H) * 0.5); float q = ((ty == 12 ? p : 1.0 - p) - 0.5) * 3.0;
        float s = length(px - vec2(W, H) * 0.5) / z + q; o = ty == 12 ? fm(a, b, sstep(0.0, 1.0, s)) : fm(b, a, sstep(0.0, 1.0, s)); }
      else o = fm(a, b, p); }`,
  // fusione del livello (tb) sopra la composizione (t), alfa del livello come in overlay
  blend: `uniform sampler2D tb; uniform int mode;
    float bm(float B, float A){ // A = sopra, B = sotto (formule di vf_blend)
      if (mode == 1) return A * B; if (mode == 2) return 1.0 - (1.0 - A) * (1.0 - B);
      if (mode == 3) return B < 0.5 ? 2.0 * A * B : 1.0 - 2.0 * (1.0 - A) * (1.0 - B);
      if (mode == 4) return A < 0.5 ? 2.0 * A * B : 1.0 - 2.0 * (1.0 - A) * (1.0 - B);
      if (mode == 5) return min(A, B); if (mode == 6) return max(A, B); if (mode == 7) return abs(A - B); if (mode == 8) return min(1.0, A + B); return A; }
    void main(){ vec4 d = texture(t, uv); vec4 s = texture(tb, uv);
      vec3 c = vec3(bm(d.r, s.r), bm(d.g, s.g), bm(d.b, s.b)); o = vec4(mix(d.rgb, c, s.a), 1.0); }`,
  present: `void main(){ o = vec4(texture(t, vec2(uv.x, 1.0 - uv.y)).rgb, 1.0); }`,
};

export class Compositor {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext("webgl2", { alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("WebGL2 non disponibile: l'anteprima del montaggio non puo' funzionare");
    this.progs = {};
    for (const [k, src] of Object.entries(FS)) this.progs[k] = this._prog(HEAD + src);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.pool = [];      // FBO liberi per dimensione
    this.srcTex = new Map();
    this.luts = new Map();
    this.W = this.H = 0;
  }
  _prog(fs) {
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "p");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const loc = new Map();
    return { p, u: n => { if (!loc.has(n)) loc.set(n, gl.getUniformLocation(p, n)); return loc.get(n); } };
  }
  _tex(w, h) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  }
  // FBO temporanei riutilizzati
  get(w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const i = this.pool.findIndex(f => f.w === w && f.h === h);
    if (i >= 0) return this.pool.splice(i, 1)[0];
    const gl = this.gl, tex = this._tex(w, h), fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { w, h, tex, fb };
  }
  put(f) { if (f && this.pool.length < 40) this.pool.push(f); else if (f) { this.gl.deleteTexture(f.tex); this.gl.deleteFramebuffer(f.fb); } }

  _run(name, target, src, uni = {}, mat = null) {
    const gl = this.gl, P = this.progs[name];
    gl.useProgram(P.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    const w = target ? target.w : this.canvas.width, h = target ? target.h : this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.uniform1i(P.u("t"), 0);
    gl.uniform2f(P.u("sz"), src.w, src.h);
    let unit = 1;
    for (const [k, v] of Object.entries(uni)) {
      const l = P.u(k);
      if (l === null) continue;
      if (v && v.tex) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, v.tex); gl.uniform1i(l, unit++); }
      else if (v && v.tex3) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_3D, v.tex3); gl.uniform1i(l, unit++); }
      else if (v && v.i !== undefined) gl.uniform1i(l, v.i);
      else if (v && v.m3) gl.uniformMatrix3fv(l, false, v.m3);
      else if (Array.isArray(v)) gl[`uniform${v.length}fv`](l, v);
      else gl.uniform1f(l, v);
    }
    // matrice: da coordinate 0..1 del quadrato a coordinate di ritaglio; di base copre tutto il bersaglio
    gl.uniformMatrix3fv(P.u("m"), false, mat || [2, 0, 0, 0, 2, 0, -1, -1, 1]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // texture di una sorgente (video, immagine, canvas): si ricarica a ogni fotogramma se `fresh`
  source(key, el, w, h, fresh = true) {
    const gl = this.gl;
    let s = this.srcTex.get(key);
    if (!s || s.w !== w || s.h !== h) { if (s) gl.deleteTexture(s.tex); s = { tex: this._tex(w, h), w, h, loaded: false }; this.srcTex.set(key, s); }
    if (fresh || !s.loaded) {
      gl.bindTexture(gl.TEXTURE_2D, s.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, el); s.loaded = true; } catch { /* fotogramma non pronto */ }
      if (el.videoWidth || el.naturalWidth || el.width) { s.w = el.videoWidth || el.naturalWidth || el.width; s.h = el.videoHeight || el.naturalHeight || el.height; }
    }
    return s;
  }
  dropSource(key) { const s = this.srcTex.get(key); if (s) { this.gl.deleteTexture(s.tex); this.srcTex.delete(key); } }
  colorSource(hex) {
    const key = "color:" + hex;
    let s = this.srcTex.get(key);
    if (!s) {
      const gl = this.gl, t = this._tex(1, 1);
      const n = parseInt(hex.slice(1), 16);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([n >> 16 & 255, n >> 8 & 255, n & 255, 255]));
      s = { tex: t, w: 1, h: 1 };
      this.srcTex.set(key, s);
    }
    return s;
  }
  lut(file, cube) {
    if (this.luts.has(file)) return this.luts.get(file);
    const gl = this.gl, t = gl.createTexture(), n = cube.size;
    gl.bindTexture(gl.TEXTURE_3D, t);
    const d = new Uint8Array(n * n * n * 4);
    for (let i = 0; i < n * n * n; i++) { d[i * 4] = Math.round(cube.data[i * 3] * 255); d[i * 4 + 1] = Math.round(cube.data[i * 3 + 1] * 255); d[i * 4 + 2] = Math.round(cube.data[i * 3 + 2] * 255); d[i * 4 + 3] = 255; }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, n, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    const r = { tex3: t, n };
    this.luts.set(file, r);
    return r;
  }

  // ---- composizione di un fotogramma
  begin(W, H, bg = "#000000") {
    this.W = W; this.H = H;
    this.comp = this.get(W, H);
    const gl = this.gl, n = parseInt(bg.slice(1), 16);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.comp.fb);
    gl.clearColor((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  // effetti alla risoluzione della sorgente (scala q per l'anteprima ridotta); restituisce un FBO
  effects(src, sw, sh, fx, opacity, q, ctxLut) {
    let w = Math.max(1, Math.round(sw * q)), h = Math.max(1, Math.round(sh * q));
    let cur = this.get(w, h);
    this._run("copy", cur, src);
    const pass = (name, uni) => { const nx = this.get(w, h); this._run(name, nx, cur, uni); this.put(cur); cur = nx; };
    for (const e of fx || []) {
      if (e.on === false) continue;
      const p = e.p || {};
      if (e.type === "color") {
        const C = 1 + (p.contrast ?? 0) / 100, B = (p.bright ?? 0) / 200, G = Math.max(0.1, p.gamma ?? 1);
        pass("color", { C, B, G, useLut: { i: Math.abs(C - 1) > 1e-4 || Math.abs(B) > 1e-4 || Math.abs(G - 1) > 1e-4 ? 1 : 0 }, M: { m3: mixer((p.sat ?? 100) / 100, [1 + 0.25 * (p.temp ?? 0) / 100, 1 - 0.25 * (p.tint ?? 0) / 100, 1 - 0.25 * (p.temp ?? 0) / 100]) } });
      } else if (e.type === "bw") pass("color", { C: 1, B: 0, G: 1, useLut: { i: 0 }, M: { m3: mixer(0, [1, 1, 1]) } });
      else if (e.type === "blur") { const s = (p.sigma ?? 6) * q; if (s > 0.05) { pass("blur", { dir: [1, 0], sigma: s }); pass("blur", { dir: [0, 1], sigma: s }); } }
      else if (e.type === "sharpen") { const k = Math.round((p.amount ?? 0.5) * 10) / 10; if (k) pass("sharpen", { k }); }
      else if (e.type === "chroma") { const n = parseInt((p.color || "#00ff00").slice(1), 16); pass("chroma", { key: [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255], sim: Math.max(0.001, (p.sim ?? 30) / 100), bl: (p.blend ?? 10) / 100 }); }
      else if (e.type === "lut") { const L = ctxLut?.(p.file); if (L) pass("lut", { L, n: L.n }); }
      else if (e.type === "mirror") pass("mirror", { fl: [p.h ?? true ? 1 : 0, p.v ? 1 : 0] });
      else if (e.type === "crop") {
        const l = (p.l || 0) / 100, t = (p.t || 0) / 100, r = (p.r || 0) / 100, b = (p.b || 0) / 100;
        pass("crop", { r: [Math.round(sw * l) * q, Math.round(sh * t) * q, (Math.round(sw * l) + Math.round(sw * (1 - l - r))) * q, (Math.round(sh * t) + Math.round(sh * (1 - t - b))) * q] });
      }
    }
    if (opacity < 0.9999) pass("opacity", { a: Math.max(0, opacity) });
    return cur;
  }
  // disegna la clip elaborata su un livello grande quanto la sequenza: centro (x,y) e grandezza (w,h) in pixel della sequenza
  layer(img, x, y, w, h, rot, q) {
    const L = this.get(this.W, this.H), gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, L.fb);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const W = this.W / q, H = this.H / q, c = Math.cos(rot), s = Math.sin(rot);
    // punto (u,v) del quadrato -> pixel della sequenza -> coordinate di ritaglio (y verso il basso = riga 0 in alto)
    const ax = w * c, ay = w * s, bx = -h * s, by = h * c, ox = x - (ax + bx) / 2, oy = y - (ay + by) / 2;
    const mat = [2 * ax / W, 2 * ay / H, 0, 2 * bx / W, 2 * by / H, 0, 2 * ox / W - 1, 2 * oy / H - 1, 1];
    this._run("xform", L, img, {}, mat);
    return L;
  }
  transition(a, b, type, p, alphaFade = 0) {
    const out = this.get(this.W, this.H);
    this._run("trans", out, a || this._blank(), { tb: b || this._blank(), p, ty: { i: TRANS_IDX[type] ?? 0 }, alphaFade: { i: alphaFade } });
    return out;
  }
  _blank() {
    if (!this.blankL || this.blankL.w !== this.W || this.blankL.h !== this.H) {
      this.blankL = this.get(this.W, this.H);
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.blankL.fb); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    }
    return this.blankL;
  }
  composite(layer, blend = "normal") {
    const nx = this.get(this.W, this.H);
    this._run("blend", nx, this.comp, { tb: layer, mode: { i: BLEND_IDX[blend] ?? 0 } });
    this.put(this.comp);
    this.comp = nx;
  }
  present() {
    this._run("present", null, this.comp);
    this.put(this.comp);
    this.comp = null;
  }
  // pixel del fotogramma attuale (per "Esporta fotogramma")
  snapshot() {
    const c = document.createElement("canvas");
    c.width = this.canvas.width; c.height = this.canvas.height;
    c.getContext("2d").drawImage(this.canvas, 0, 0);
    return c;
  }
}

// matrice di colorchannelmixer: saturazione (pesi Rec.709) e moltiplicatori dei canali (temperatura, tinta)
function mixer(s, mul) {
  const w = [0.2126, 0.7152, 0.0722];
  const rows = mul.map((k, i) => w.map((x, j) => ((1 - s) * x + (i === j ? s : 0)) * k));
  // mat3 di GLSL per colonne: v' = M * v
  return [rows[0][0], rows[1][0], rows[2][0], rows[0][1], rows[1][1], rows[2][1], rows[0][2], rows[1][2], rows[2][2]];
}
