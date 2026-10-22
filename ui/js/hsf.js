// Lettore dei flussi HSF (HOOPS Stream Format, usato dai W3D dei DWF 3D), scritto da zero seguendo la specifica
// pubblicata nel DWF Toolkit ("HSF Opcode Definition"). Restituisce un albero di segmenti con matrici, colori,
// visibilita', chiavi e la geometria tassellata (shell/mesh/poligoni/linee).
import { inflate } from "./inflate.js";

export class HsfError extends Error {}

/**
 * @param {Uint8Array} bytes contenuto del .w3d
 * @param {{ onProgress?: (f:number)=>void }} opts
 */
export function parseHsf(bytes, opts = {}) {
  let buf = bytes, p = 0, dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const stats = new Map(), warnings = [];
  const root = { name: "", children: [], geo: [], attr: {}, parent: null, key: null };
  let seg = root;
  let last = null; // ultimo oggetto (per tag e chiavi)
  const ebDecode = opts.edgebreaker || null;
  const tagged = [];
  const images = [];
  const views = [];
  const textures = new Map(); // nome texture -> nome immagine
  let version = 0;

  const need = n => { if (p + n > buf.length) throw new RangeError("fine dei dati"); };
  const B = () => { need(1); return buf[p++]; };
  const W = () => { need(2); const v = dv.getUint16(p, true); p += 2; return v; };
  const SW = () => { need(2); const v = dv.getInt16(p, true); p += 2; return v; };
  const I = () => { need(4); const v = dv.getInt32(p, true); p += 4; return v; };
  const UI = () => { need(4); const v = dv.getUint32(p, true); p += 4; return v; };
  const F = () => { need(4); const v = dv.getFloat32(p, true); p += 4; return v; };
  const Fs = n => { need(4 * n); const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = dv.getFloat32(p + 4 * i, true); p += 4 * n; return a; };
  const str = n => { need(n); const s = new TextDecoder("latin1").decode(buf.subarray(p, p + n)); p += n; return s; };
  const skip = n => { need(n); p += n; };
  // maschera "Variable": 1 byte, se il bit alto e' acceso segue un secondo byte
  const geoMask = () => { let v = B(); if (v & 0x80) { v |= B() << 8; if (v & 0x8000) { v |= B() << 16; v |= B() << 24; } } return v >>> 0; };
  // lunghezza variabile: Byte, 254 -> segue Short, 255 -> segue Long
  const varLen = () => { const v = B(); return v === 254 ? W() : v === 255 ? UI() : v; };

  function newSeg(name) {
    const s = { name, children: [], geo: [], attr: {}, parent: seg, key: null, includes: [], style: [] };
    seg.children.push(s);
    return s;
  }

  // ---- colori: maschera geometria + rgb
  const GEO = { face: 0x01, edge: 0x02, line: 0x04, marker: 0x08, text: 0x10 };
  function setColor(mask, rgb) {
    if (mask & 0x01) seg.attr.face = rgb;
    if (mask & 0x02) seg.attr.edge = rgb;
    if (mask & 0x04) seg.attr.line = rgb;
    if (!(mask & 0x07)) seg.attr.other = rgb;
  }
  // canale di colore: rgb, oppure nome (colore con nome o texture definita con TKE_Texture)
  let lastNamed = null;
  const colorChannel = () => { const len = B(); if (len === 0) { lastNamed = null; return [B(), B(), B()]; } const s = str(len); lastNamed = s; return namedColor(s); };

  // ---- array di float quantizzati: campioni impacchettati in parole di 32 bit (little endian), dal bit piu' alto
  function unpackFloats(data, count, comps, bits, box) {
    const out = new Float32Array(count * comps);
    if (bits === 8 && comps === 3) { // forma a byte
      for (let i = 0; i < count * 3 && i < data.length; i++) { const c = i % 3, v = data[i]; out[i] = v === 255 ? box[c + 3] : box[c] + (box[c + 3] - box[c]) * v / 255; }
      return out;
    }
    const br = bitReader32(data);
    const max = bits >= 32 ? 0xffffffff : (2 ** bits) - 1;
    for (let i = 0; i < count; i++) for (let c = 0; c < comps; c++) {
      const v = br(bits);
      out[i * comps + c] = v === max ? box[c + comps] : box[c] + (box[c + comps] - box[c]) * v / max;
    }
    return out;
  }
  // punti della shell secondo lo schema: 4 = nessuna compressione, 1 = quantizzati
  function readShellPoints(scheme, sub2) {
    if (scheme === 4) { const n = I(); return Fs(3 * n); }
    if (scheme !== 1) throw new HsfError("Schema dei vertici non supportato: " + scheme);
    const n = I();
    if (!n) return new Float32Array(0);
    const box = sub2 & GLOBAL_Q ? globalBox() : Fs(6);
    const bits = B();
    const len = version >= 650 ? I() : 3 * n;
    need(len);
    const data = buf.subarray(p, p + len);
    p += len;
    return unpackFloats(data, n, 3, bits, box);
  }
  let gBox = null;
  const GLOBAL_Q = 0x0008;
  const globalBox = () => gBox || new Float32Array([0, 0, 0, 1, 1, 1]);

  // elenco delle facce: schema, lunghezza in byte, poi bit per valore (8/16/32) e valori little endian
  function readShellFaces(sub2) {
    B(); // schema (CS_TRIVIAL)
    const len = I();
    need(len);
    const start = p;
    const bits = buf[p];
    const size = Math.max(1, bits >> 3);
    const n = Math.floor((len - 1) / size);
    const out = new Int32Array(n);
    const neg = !!(sub2 & 0x0004);
    let q = p + 1;
    for (let i = 0; i < n; i++, q += size) {
      if (size === 1) out[i] = neg ? (buf[q] << 24) >> 24 : buf[q];
      else if (size === 2) out[i] = neg ? dv.getInt16(q, true) : dv.getUint16(q, true);
      else out[i] = dv.getInt32(q, true);
    }
    p = start + len;
    return out;
  }

  function readOptionals(shell, nPts) {
    for (;;) {
      const op = B();
      if (op === 0x00) return;
      if (op === 0x63) { // attributi del poliedro: opcode normali fino a TKE_Termination
        const saveSeg = seg;
        seg = { attr: {}, children: [], geo: [], parent: null };
        while (buf[p] !== 0x00) step();
        p++;
        if (seg.attr.face) shell.color = seg.attr.face;
        seg = saveSeg;
        continue;
      }
      if (op === 0x33) { // regioni delle facce
        const cs = B(), kind = cs & 7, size = cs & 0xf8;
        const rd = () => (size === 8 ? B() : size === 16 ? W() : I());
        if (kind === 0) { const n = shell.faceCount || 0; for (let i = 0; i < n; i++) rd(); }
        else if (kind === 1) { const n = I(); for (let i = 0; i < n; i++) rd(); }
        else if (kind === 2) { const n = I(); rd(); for (let i = 0; i < n; i++) rd(); }
        else if (kind === 3) { const n = I(); for (let i = 0; i < 2 * n; i++) rd(); }
        continue;
      }
      if (op === 0x01 || op === 0x11) { // normali di tutti i vertici: schema, bit, lunghezza, dati (si ricalcolano)
        const sc = B(); B(); const len = I(); skip(len); void sc; continue;
      }
      if (op === 0x1c) { // coordinate texture di tutti i vertici, non compresse: larghezza e float
        const w = B(); shell.uvs = Fs(nPts * w); shell.uvw = w; continue;
      }
      if (op === 0x03) { // coordinate texture di tutti i vertici: schema, limiti (u,v,w), bit, lunghezza, dati
        B(); const box = Fs(6); const bits = B(); const len = I(); need(len);
        shell.uvs = unpackFloats(buf.subarray(p, p + len), nPts, 3, bits, box); p += len; continue;
      }
      throw new HsfError("attributo di shell 0x" + op.toString(16) + " non gestito");
    }
  }

  function readShell() {
    const sub = B();
    if (sub & 0x20) { if (sub & 0x80) W(); B(); Fs(6); return null; } // solo ingombro
    const sub2 = sub & 0x80 ? W() : 0;
    if (!(sub & 0x10)) I(); // indice dell'oggetto di cui e' un raffinamento
    const lod = B();
    if (sub2 & 0x0002) return null; // shell nulla
    if (sub2 & 0x0001) { // collezione (livello di dettaglio alternativo): si legge e si scarta fino a Termination
      const saveSeg = seg;
      seg = { attr: {}, children: [], geo: [], parent: null, includes: [], style: [] };
      while (buf[p] !== 0x00) step();
      p++;
      seg = saveSeg;
      return null;
    }
    const scheme = sub & (0x01 | 0x40) ? B() : 4;
    const shell = { kind: "shell", lod, sub, sub2 };
    if (scheme === 5) { // edgebreaker
      const len = I();
      need(len);
      const blob = buf.subarray(p, p + len);
      p += len;
      const eb = decodeEdgebreakerBlob(blob, sub2);
      shell.eb = eb;
      if (!(sub & 0x01) && version >= 651 && eb.pcount) { shell.points = Fs(3 * eb.pcount); shell.rawPoints = true; }
      else shell.points = eb.points;
      shell.faces = eb.faces;
      shell.strips = eb.strips;
      stats.set("shell:edgebreaker", (stats.get("shell:edgebreaker") || 0) + 1);
    } else {
      shell.points = readShellPoints(scheme, sub2);
      shell.faces = readShellFaces(sub2);
      shell.strips = !!(sub & 0x04);
      stats.set("shell:normale", (stats.get("shell:normale") || 0) + 1);
    }
    shell.faceCount = shell.faces ? countFaces(shell.faces, shell.strips) : 0;
    if (sub & 0x08) readOptionals(shell, (shell.points?.length || 0) / 3);
    return lod === 0 ? shell : null;
  }

  // ---- edgebreaker: intestazione e sezioni; la ricostruzione e' in edgebreaker.js
  function decodeEdgebreakerBlob(blob, sub2) {
    const d = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const h = { scheme: blob[0], mscheme: blob[1], pscheme: blob[2], nscheme: blob[3], opslen: d.getInt32(4, true), mlen: d.getInt32(8, true), plen: d.getInt32(12, true), pcount: d.getInt32(16, true) };
    let q = 20;
    if (h.scheme >= 1) { h.nlen = d.getInt32(20, true); q = 24; } else h.nlen = 0;
    const pad = v => (v + 3) & ~3;
    h.ops = blob.subarray(q, q + h.opslen); q = pad(q + h.opslen);
    h.mt = blob.subarray(q, q + h.mlen); q = pad(q + h.mlen);
    h.pts = blob.subarray(q, q + h.plen); q = pad(q + h.plen);
    h.nrm = blob.subarray(q, q + h.nlen);
    h.global = sub2 & GLOBAL_Q ? globalBox() : null;
    const r = ebDecode ? ebDecode(h) : null;
    return { pcount: h.pcount, points: r?.points || null, faces: r?.faces || null, strips: !!r?.strips, header: h, error: r?.error };
  }

  function countFaces(f, strips) {
    let n = 0;
    for (let i = 0; i < f.length;) { const c = f[i]; const k = Math.abs(c); if (strips) n += Math.max(0, k - 2); else if (c > 0) n++; i += k + 1; }
    return n;
  }

  // dopo un opcode di formato incerto: si avanza fino a un opcode frequente (al massimo n byte)
  const STRONG = new Set([0x22, 0x28, 0x29, 0x53, 0x7e, 0x71, 0x55, 0x25, 0x3c, 0x7b, 0x56, 0x4c, 0x6c, 0x63, 0x48, 0x74, 0xe0]);
  function resync(n) { const q = p; while (p < buf.length && p - q < n && !STRONG.has(buf[p])) p++; if (!STRONG.has(buf[p])) p = q; }

  function addGeo(g) { if (g) { seg.geo.push(g); last = g; } }

  // ---- un opcode
  const trace = opts.debug ? [] : null;
  function step() {
    const op = B();
    if (trace) { trace.push((op >= 33 && op < 127 ? String.fromCharCode(op) : "0x" + op.toString(16)) + "@" + (p - 1)); if (trace.length > 40) trace.shift(); }
    stats.set(op, (stats.get(op) || 0) + 1);
    switch (op) {
      case 0x00: return "end"; // TKE_Termination
      case 0x3b: { // ; commento fino a "a capo"
        const s = p; while (p < buf.length && buf[p] !== 0x0a && buf[p] !== 0x00) p++; // "a capo" (o byte nullo nelle versioni recenti)
        const e = p; p = s;
        const c = str(e - s); p++;
        const m = /HSF V(\d+)\.(\d+)/.exec(c);
        if (m) version = +m[1] * 100 + +m[2];
        return;
      }
      case 0x49: I(); return; // File_Info
      case 0x5a: { // Z: il resto e' compresso con zlib
        const { data, end } = inflate(buf, p, true);
        const rest = buf.subarray(end);
        const nb = new Uint8Array(data.length + rest.length);
        nb.set(data); nb.set(rest, data.length);
        buf = nb; p = 0; dv = new DataView(buf.buffer);
        return;
      }
      case 0x7a: return; // z: fine della compressione
      case 0x28: { const n = B(); const name = str(n); seg = newSeg(name); last = seg; return; } // Open_Segment
      case 0x29: if (seg.parent) seg = seg.parent; last = seg; return; // Close_Segment
      case 0x73: { const i = I(); const s = tagged[i]; if (s && s.children) seg = s; return; } // Reopen_Segment
      case 0x71: if (last && last.tag === undefined) last.tag = tagged.length; tagged.push(last); return; // Tag
      case 0x4b: case 0x6b: { const k = I(); if (last) last.key = k; return; } // Renumber_Key
      case 0x3c: { const n = B(); seg.includes.push(str(n)); return; } // Include_Segment
      case 0x7b: { const n = B(); seg.style.push(str(n)); return; } // Style_Segment
      case 0x25: { const m = Fs(12); seg.attr.matrix = m; return; } // Modelling_Matrix
      case 0x22: { // Color
        const mask = geoMask();
        let ch = B(); if (ch & 0x80) ch |= B() << 8;
        let diffuse = null;
        let diffuseName = null;
        if (ch & 0x01) { diffuse = colorChannel(); diffuseName = lastNamed; }
        if (ch & 0x02) colorChannel();
        if (ch & 0x04) colorChannel();
        if (ch & 0x08) { const t = colorChannel(); seg.attr.transmission = t; }
        if (ch & 0x10) colorChannel();
        if (ch & 0x20) F();
        if (ch & 0x40) F();
        if (ch & 0x100) colorChannel();
        if (ch & 0x200) colorChannel();
        if (diffuse) setColor(mask, diffuse);
        if (mask & 0x01) seg.attr.faceTex = diffuseName || null;
        return;
      }
      case 0x7e: { const mask = geoMask(); setColor(mask, [B(), B(), B()]); return; } // Color_RGB
      case 0x08: { geoMask(); B(); return; } // Color_By_Index
      case 0x09: { geoMask(); W(); return; } // Color_By_Index_16
      case 0x0a: { geoMask(); F(); return; } // Color_By_FIndex
      case 0x0b: { const mask = geoMask(); const sp = B(); const v = Fs(3); if (sp === 1) setColor(mask, [v[0], v[1], v[2]].map(x => Math.round(x * 255))); return; } // Color_By_Value
      case 0x0c: { B(); const n = I(); skip(3 * n); return; } // Color_Map
      case 0x56: { // Visibility
        const mask = B(), val = B();
        let m = mask, v = val;
        if (mask & 0x80) { m |= W() << 8; v |= W() << 8; }
        if (m & 0x01) seg.attr.faceVis = !!(v & 0x01);
        if (m & 0x02) seg.attr.edgeVis = !!(v & 0x02);
        if (m & 0x04) seg.attr.lineVis = !!(v & 0x04);
        seg.attr.visMask = m; seg.attr.visVal = v;
        return;
      }
      case 0x5b: { const n = I(); skip(n); if (buf[p] === 0x5d) p++; return; } // User_Data ... ]
      case 0x5d: return;
      case 0x62: case 0x42: { const t = B(); if (t === 0) { const b = Fs(6); if (op === 0x42) gBox = b; } else Fs(4); return; } // Bounding / Bounding_Info (riquadro globale per la quantizzazione)
      case 0x01: return; // Pause
      case 0xe0: { const n = B(); const name = str(n); const w = I(), h = I(); B(); images.push({ name, w, h }); return; } // immagine W3D (texture dichiarata)
      case 0x44: { // Dictionary
        const fmt = B();
        if (fmt === 2) { const n = W(); skip(4 * n); }
        const count = I();
        for (let i = 0; i < count; i++) {
          I(); const pres = B();
          let bits = 0; for (let k = 0; k < 8; k++) if (pres & (1 << k)) bits++;
          skip(4 * bits);
          if (fmt >= 1) { const o = B(); if (o & 1) Fs(6); }
        }
        if (fmt === 1) I();
        I();
        return;
      }
      case 0x68: B(); return; // Handedness
      case 0x21: { const g = geoMask(); const two = g & 0x80; for (let i = 0; i < 5; i++) { B(); if (two) B(); } return; } // Selectability
      case 0x55: { let n = W(); if (n === 65535) n = UI(); const s = str(n); seg.attr.options = (seg.attr.options ? seg.attr.options + "," : "") + s; return; } // User_Options
      case 0x6e: { const n = I(); skip(8 * n); return; } // User_Index
      case 0x76: I(); return; // User_Value
      case 0x3d: case 0x0e: case 0x2b: { const w = F(); if (w < 0) B(); return; } // Line/Edge weight, Marker size
      case 0x2d: case 0x0d: { B(); B(); return; } // Line/Edge pattern
      case 0x50: case 0x40: case 0x70: case 0x23: case 0x2a: B(); return; // Face pattern, Marker symbol, Window pattern/frame, Text alignment
      case 0x46: { // Text_Font
        let mask = B(), val = B();
        if (mask & 0x80) { mask |= B() << 8; val |= B() << 8; }
        if (mask & 0x0001) { const n = B(); skip(n); }
        if (mask & 0x0002) { F(); B(); }
        if (mask & 0x0004) { F(); B(); }
        if (mask & 0x0008) B();
        if (mask & 0x0010) F();
        if (mask & 0x0020) F();
        if (mask & 0x0040) F();
        if (mask & 0x0100) { F(); B(); }
        if (mask & 0x0200) F();
        void val;
        return;
      }
      case 0x7c: Fs(3); return; // Text_Path
      case 0x20: F(); return; // Text_Spacing
      case 0x74: { // Texture: nome, immagine e opzioni
        const n1 = B(); const tname = str(n1); const n2 = B(); textures.set(tname, str(n2));
        const o = W();
        for (const bit of [0x0001, 0x0002, 0x0004, 0x0008, 0x0010, 0x0020, 0x0040, 0x0080, 0x0100, 0x0200]) if (o & bit) B();
        if (o & 0x0800) { B(); B(); }
        if (o & 0x0400) { const n = B(); skip(n); }
        return;
      }
      case 0x24: Fs(12); return; // Texture_Matrix
      case 0x57: { geoMask(); Fs(4); return; } // Window
      case 0x3e: { const pr = B(); Fs(11); if (pr & 4) F(); if (pr & 8) F(); return; } // Camera
      case 0x7d: { const pr = B(); const v = Fs(11); if (pr & 4) F(); if (pr & 8) F(); const n = B(); views.push({ name: str(n), pos: v.slice(0, 3), target: v.slice(3, 6), up: v.slice(6, 9), field: v.slice(9, 11), persp: !!(pr & 1) }); return; } // View
      case 0x6f: { B(); Fs(4); return; } // Clipping_Rectangle
      case 0x4f: { B(); const n = I(); Fs(3 * n); return; } // Clipping_Region
      case 0x48: { // Heuristics
        let mask = W(); let val = W();
        if (mask & 0x8000) { mask |= W() << 16; val |= W() << 16; }
        if (mask & val & 0x0040) I();
        if (mask & val & 0x0080) I();
        if (mask & val & 0x000c) B();
        if (mask & 0x10000) B();
        return;
      }
      case 0x07: { const n = W(); skip(n); return; } // Callback
      case 0x15: { const n = varLen(); skip(n); return; } // URL
      case 0x18: { const n = I(); skip(n); return; } // XML
      case 0x64: case 0x2e: Fs(3); return; // Distant/Local light
      case 0x5e: { Fs(6); const o = B(); if (o & 3) F(); if (o & 12) F(); if (o & 0x20) F(); return; } // Spot light
      case 0x61: { const n = I(); Fs(3 * n); B(); return; } // Area light
      case 0x2f: { geoMask(); Fs(4); return; } // Cutting plane
      case 0x6c: { const a = Fs(6); addGeo({ kind: "line", pts: a }); return; } // Line
      case 0x4c: { const n = I(); addGeo({ kind: "line", pts: Fs(3 * n) }); return; } // Polyline
      case 0x47: { const n = I(); addGeo({ kind: "polygon", pts: Fs(3 * n) }); return; } // Polygon
      case 0x43: case 0x63: case 0x45: { const a = Fs(9); if (version >= 1200) B(); if (op === 0x63) addGeo({ kind: "arc", pts: a }); return; } // Circle, Circular_Arc, Ellipse (dalla 12.00 con un byte di opzioni)
      case 0x65: { Fs(11); return; } // Elliptical_Arc
      case 0x58: Fs(3); return; // Marker
      case 0x54: { Fs(3); const n = varLen(); skip(n); return; } // Text
      case 0x78: { Fs(3); B(); const n = varLen(); skip(n); return; } // Text_With_Encoding
      case 0x53: addGeo(readShell()); return; // Shell
      case 0x1a: { B(); const c = Fs(3), r = F(); Fs(6); addGeo({ kind: "sphere", c, r }); return; } // Sphere: opzioni, centro, raggio, asse, direzione ortogonale
      case 0x4e: { // NURBS_Curve: si conserva il poligono di controllo come linea
        const o = B(), deg = B(), n = I(); const pts = Fs(3 * n);
        if (o & 1) Fs(n); if (o & 2) Fs(n + deg + 1); if (o & 4) F(); if (o & 8) F();
        addGeo({ kind: "line", pts }); return;
      }
      case 0x69: { Fs(3); const fmt = B(); if (fmt & 0x80) { const n = B(); skip(n); } const w = I(), h = I(); B(); const bpp = [1, 2, 3, 4, 4][fmt & 0x0f] || 4; skip(w * h * bpp); return; } // Image
      case 0x67: { B(); Fs(9); I(); I(); return; } // Grid
      case 0x5c: case 0x77: Fs(9); return; // Circular_Chord / Wedge
      case 0x16: { let n = W(); if (n === 65535) n = UI(); skip(2 * n); return; } // Unicode_Options
      case 0x12: { const n = varLen(); skip(n); return; } // External_Reference
      case 0x26: { I(); I(); I(); I(); B(); Fs(12); return; } // Repeat_Object
      case 0x66: { B(); let n = B(); skip(n); B(); n = B(); skip(n); n = B(); skip(n); return; } // Font
      case 0x52: { // Rendering_Options (campi secondo la specifica; poi riallineamento sul prossimo opcode plausibile)
        let mask = UI(), val = UI(), mx = 0, vx = 0;
        if (mask & 0x80000000) { mx = UI(); vx = UI(); }
        const on = b => mask & b;
        if (on(0x3000)) B();
        if (on(0xc0000)) B();
        if (on(0x00200000)) I();
        if (on(0x00100000)) { const lm = UI(); UI(); if (lm & 0x04) { UI(); UI(); } if (lm & 0x08000000) { UI(); UI(); } }
        if (on(0x00400000)) Fs(2);
        if (on(0x00020000)) I();
        if (on(0x40000000)) F();
        void val; void vx; void mx;
        resync(24);
        return;
      }
      case 0x59: { const a = Fs(6), r = F(), caps = B(); addGeo({ kind: "cylinder", a, r, caps }); return; } // Cylinder
      case 0x3a: { // attributi della geometria precedente: opcode di attributo fino a Termination
        const saveSeg = seg, target = last;
        seg = { attr: {}, children: [], geo: [], parent: null, includes: [], style: [] };
        while (p < buf.length && buf[p] !== 0x00) step();
        p++;
        if (target && seg.attr.face) target.color = seg.attr.face;
        seg = saveSeg;
        return;
      }
      case 0x4d: { // Mesh
        const sub = B(); const rows = I(), cols = I();
        const pts = readShellPoints(sub & 0x01 ? B() : 4, 0);
        const g = { kind: "mesh", rows, cols, points: pts };
        if (sub & 0x08) readOptionals(g, pts.length / 3);
        addGeo(g);
        return;
      }
      default:
        throw new HsfError(`opcode HSF 0x${op.toString(16)} non gestito alla posizione ${p - 1}`);
    }
  }

  let guard = 0;
  try {
    while (p < buf.length) {
      if (step() === "end") break;
      if ((++guard & 0x3fff) === 0 && opts.onProgress) opts.onProgress(p / buf.length);
    }
  } catch (e) {
    warnings.push(e instanceof RangeError ? "Flusso HSF troncato" : e.message);
    if (opts.debug) warnings.push("byte: " + Array.from(buf.subarray(Math.max(0, p - 24), p + 64)).map(v => v.toString(16).padStart(2, "0")).join(" "));
  }
  if (trace) warnings.push("ultimi opcode: " + trace.join(" "));
  return { root, version, stats, warnings, images, views, textures };
}

/** lettore di bit: parole di 32 bit little endian, lette dal bit piu' significativo */
export function bitReader32(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nw = data.length >> 2;
  let w = 0, cur = 0, left = 0;
  const word = () => { cur = w < nw ? dv.getUint32(4 * w, true) : 0; w++; left = 32; };
  return bits => {
    let v = 0;
    while (bits > 0) {
      if (!left) word();
      const take = Math.min(bits, left);
      const part = take === 32 ? cur >>> 0 : (cur >>> (left - take)) & ((1 << take) - 1);
      v = v * (2 ** take) + (part >>> 0);
      left -= take; bits -= take;
    }
    return v;
  };
}

const NAMED = { white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128] };
function namedColor(s) {
  const k = String(s).toLowerCase().trim();
  if (NAMED[k]) return NAMED[k];
  const m = /r\s*=\s*([\d.]+).*g\s*=\s*([\d.]+).*b\s*=\s*([\d.]+)/i.exec(k);
  if (m) return [m[1], m[2], m[3]].map(v => Math.round(+v * 255));
  return [200, 200, 200];
}
