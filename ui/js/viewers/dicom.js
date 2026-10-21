// Immagini mediche DICOM: serie della cartella (o DICOMDIR), finestra/livello, scorrimento tra le sezioni, cine,
// misure (distanza, angolo, ROI con media e deviazione), sonda del valore, tag DICOM in tabella con ricerca.
// I pixel arrivano grezzi da mbvisual/fx_dicom.py (valori reali, es. HU): la finestra si applica qui con una LUT.
import { api, button, el, loadCss, loading, pickFolder, pickSavePath, saveBytes, toast } from "../core.js";

const PRESETS = [
  ["Cervello", 40, 80], ["Tessuti molli", 40, 400], ["Addome", 60, 400], ["Fegato", 60, 160], ["Mediastino", 50, 350],
  ["Polmone", -600, 1500], ["Osso", 400, 1800], ["Vertebre", 530, 2300], ["Angio", 300, 600],
];
const TOOLS = [
  ["wl", "Finestra", "Trascina: orizzontale = ampiezza, verticale = livello (sempre anche col tasto destro)"],
  ["pan", "Sposta", "Trascina per spostare l'immagine (sempre anche col tasto centrale)"],
  ["zoom", "Zoom", "Trascina in verticale per ingrandire (anche Ctrl + rotella)"],
  ["line", "Distanza", "Clic sul primo e sul secondo punto"],
  ["angle", "Angolo", "Tre clic: estremo, vertice, estremo"],
  ["ellipse", "ROI ellisse", "Trascina: media, deviazione, min/max e area"],
  ["rect", "ROI rettangolo", "Trascina: media, deviazione, min/max e area"],
];

export async function mount(ctx) {
  loadCss("css/formati.css");
  const ld = loading(ctx.el, "Lettura della serie DICOM");
  let S = await api("fx", { op: "dicom_open", path: ctx.path });
  ctx.el.innerHTML = "";
  ctx.fillBody(true);

  // ---------------------------------------------------------------- stato
  const cache = new Map();          // indice fotogramma -> {w,h,c,data,min,max} | Promise
  const meas = new Map();           // indice -> [misure]
  let idx = S.indice ? S.fotogrammi.findIndex(f => f.s === S.indice) : 0;
  if (idx < 0) idx = 0;
  let wc = null, ww = null, invert = false, tool = "wl", zoom = 1, panX = 0, panY = 0, fitted = true;
  let drawing = null, hover = null, playing = null, tagsShown = false, tagRows = null, tagsFor = null;
  let lut = null, lutKey = "", cur = null; // cur = fotogramma mostrato
  ld.set(0.2);

  // ---------------------------------------------------------------- interfaccia
  const stage = el("div", { class: "dcm-stage", tabindex: "0" });
  const cv = el("canvas");
  const ovTL = el("div", { class: "dcm-ov tl" }), ovTR = el("div", { class: "dcm-ov tr" });
  const ovBL = el("div", { class: "dcm-ov bl" }), ovBR = el("div", { class: "dcm-ov br" });
  const ovErr = el("div", { class: "dcm-ov err", hidden: true });
  const slider = el("input", { type: "range", class: "dcm-slider", min: 0, max: Math.max(0, S.fotogrammi.length - 1), value: idx, title: "Sezione" });
  stage.append(cv, ovTL, ovTR, ovBL, ovBR, ovErr, slider);
  slider.hidden = S.fotogrammi.length < 2;

  const tagSearch = el("input", { type: "search", class: "field", placeholder: "Cerca tag, nome o valore" });
  const tagBox = el("div", { class: "scroll" });
  const tagPane = el("div", { class: "fx-pane" }, el("div", { class: "head" }, "Tag DICOM", tagSearch,
    button("", "download", () => exportTagsCsv(), { iconOnly: true, title: "Esporta i tag in CSV" })), tagBox);
  const seriesBox = el("div", { class: "scroll" });
  const leftPane = el("div", { class: "fx-pane left" }, el("div", { class: "head" }, "Studio e serie"), seriesBox);
  const split = el("div", { class: "fx-split with-left" }, leftPane, stage, tagPane);
  tagPane.hidden = true;
  ctx.el.append(split);

  // barra comandi
  const toolBtns = {};
  for (const [id, label, tip] of TOOLS) {
    toolBtns[id] = button(label, null, () => setTool(id), { title: tip });
  }
  const presetSel = el("select", { title: "Finestre predefinite" }, el("option", { value: "" }, "Finestra..."));
  const fillPresets = () => {
    presetSel.innerHTML = "";
    presetSel.append(el("option", { value: "" }, "Finestra..."));
    (S.immagine.finestre || []).forEach((f, i) => presetSel.append(el("option", { value: "f" + i }, `Del file${f.nome ? " - " + f.nome : ""} (${fmt(f.c)}/${fmt(f.w)})`)));
    presetSel.append(el("option", { value: "auto" }, "Automatica (min/max)"));
    if (S.riepilogo.modalita === "CT") PRESETS.forEach(([n, c, w], i) => presetSel.append(el("option", { value: "p" + i }, `${n} (${c}/${w})`)));
  };
  presetSel.addEventListener("change", () => {
    const v = presetSel.value;
    if (v.startsWith("f")) { const f = S.immagine.finestre[+v.slice(1)]; wc = f.c; ww = f.w; }
    else if (v.startsWith("p")) { [, wc, ww] = PRESETS[+v.slice(1)]; }
    else if (v === "auto") autoWindow(true);
    presetSel.value = "";
    render();
  });
  const playBtn = button("Riproduci", "play", () => togglePlay(), { title: "Scorre le sezioni in sequenza (barra spaziatrice)" });
  const fps = el("input", { type: "number", min: 1, max: 60, value: 10, title: "Sezioni al secondo" });
  ctx.tb.append(...Object.values(toolBtns), el("span", { class: "sep" }), presetSel,
    button("Inverti", null, () => { invert = !invert; render(); }, { title: "Inverte i grigi (I)" }),
    button("", "fit", () => { fitted = true; render(); }, { iconOnly: true, title: "Adatta alla finestra (R ripristina tutto)" }),
    button("Cancella misure", "trash", () => { meas.delete(idx); render(); }, { title: "Toglie le misure di questa sezione (Ctrl+Z toglie l'ultima)" }),
    el("span", { class: "sep" }), playBtn, el("label", {}, "fps", fps),
    el("span", { class: "grow" }),
    button("Tag DICOM", "table", () => toggleTags(), { title: "Mostra tutti i tag del file (T)" }),
    button("Esporta sezioni", "download", () => exportAll(), { title: "Salva tutte le sezioni in PNG con la finestra attuale" }));
  setTool("wl");

  // ---------------------------------------------------------------- serie
  function renderSeries() {
    const r = S.riepilogo;
    seriesBox.innerHTML = "";
    const dl = el("dl", { class: "kv stack", style: { padding: "10px 12px", fontSize: "12.5px" } });
    const add = (k, v) => { if (v) dl.append(el("dt", {}, k), el("dd", {}, v)); };
    add("Paziente", r.paziente); add("ID", r.id_paziente);
    add("Nascita / sesso / eta'", [r.nascita, r.sesso, r.eta].filter(Boolean).join(" · "));
    add("Studio", r.studio); add("Data", r.data); add("Modalita'", [r.modalita, r.parte].filter(Boolean).join(" · "));
    add("Serie", [r.numero_serie && "n. " + r.numero_serie, r.serie].filter(Boolean).join(" - "));
    add("Istituto", r.istituto); add("Apparecchio", r.apparecchio); add("Tipo", r.sop); add("Codifica", r.sintassi);
    const im = S.immagine;
    add("Immagine", `${im.colonne} x ${im.righe} px · ${im.bit} bit${im.campioni > 1 ? " · colore" : ""}`);
    if (im.spaziatura) add("Pixel", `${fmt(im.spaziatura[1])} x ${fmt(im.spaziatura[0])} mm`);
    if (im.spessore) add("Spessore sezione", fmt(im.spessore) + " mm");
    add("Sezioni", `${S.fotogrammi.length}${S.sezioni.length !== S.fotogrammi.length ? ` (in ${S.sezioni.length} file)` : ""}`);
    seriesBox.append(dl);
    if (S.serie.length > 1 || S.dicomdir) {
      seriesBox.append(el("div", { style: { padding: "4px 12px", fontWeight: 600, fontSize: "12.5px" } }, S.dicomdir ? "Serie nel DICOMDIR" : "Altre serie nella cartella"));
      const t = el("div", { class: "tree" });
      for (const s of S.serie) t.append(el("div", { class: "node" + (s.uid === S.uid ? " sel" : ""), title: s.uid, onclick: () => switchSeries(s.uid) },
        el("span", {}, `${s.modalita || "?"} ${s.numero ? "#" + s.numero : ""} ${s.descrizione || "(senza descrizione)"}`), el("span", { class: "note", style: { marginLeft: "auto" } }, s.n)));
      seriesBox.append(t);
    }
  }

  async function switchSeries(uid) {
    if (uid === S.uid) return;
    stopPlay();
    const lp = loading(stage, "Apertura della serie");
    try {
      S = await api("fx", { op: "dicom_open", path: ctx.path, uid });
    } catch (e) { toast(e.message, true); }
    lp.set(1);
    stage.innerHTML = "";
    stage.append(cv, ovTL, ovTR, ovBL, ovBR, ovErr, slider);
    cache.clear(); meas.clear(); idx = 0; wc = ww = null; fitted = true; tagsFor = null;
    slider.max = Math.max(0, S.fotogrammi.length - 1); slider.hidden = S.fotogrammi.length < 2;
    fillPresets(); renderSeries(); await go(0);
    if (tagsShown) loadTags();
  }

  // ---------------------------------------------------------------- pixel
  function frameOf(i) {
    const f = S.fotogrammi[i];
    if (!f) return Promise.reject(new Error("Sezione inesistente"));
    if (cache.has(i)) return Promise.resolve(cache.get(i));
    const p = (async () => {
      const r = await api("fx", { op: "dicom_frame", path: S.sezioni[f.s].path, frame: f.f }, { raw: true });
      if (!r.ok) { let m = "Immagine non decodificabile"; try { m = (await r.json()).errore || m; } catch { /* */ } throw new Error(m); }
      const buf = await r.arrayBuffer();
      const w = +r.headers.get("X-W"), h = +r.headers.get("X-H"), c = +r.headers.get("X-C"), t = r.headers.get("X-T");
      const data = t === "u8" ? new Uint8Array(buf) : t === "i16" ? new Int16Array(buf) : new Float32Array(buf);
      let min = Infinity, max = -Infinity;
      if (c === 1) for (let k = 0; k < data.length; k++) { const v = data[k]; if (v < min) min = v; if (v > max) max = v; }
      const fr = { w, h, c, t, data, min, max };
      cache.set(i, fr);
      return fr;
    })();
    cache.set(i, p);
    p.catch(() => cache.delete(i));
    return p;
  }
  let prefetching = false;
  async function prefetch() {
    if (prefetching) return;
    prefetching = true;
    try {
      // le sezioni vicine prima, poi le altre (al massimo 1500 in memoria)
      const order = [];
      for (let d = 1; d < S.fotogrammi.length && order.length < 1500; d++) { if (idx + d < S.fotogrammi.length) order.push(idx + d); if (idx - d >= 0) order.push(idx - d); }
      for (const i of order) { if (!cache.has(i)) { try { await frameOf(i); } catch { /* */ } } if (ctx.tab.view.hidden && !playing) break; }
    } finally { prefetching = false; }
  }

  function autoWindow(force) {
    const fr = cache.get(idx);
    if (!fr || fr instanceof Promise || fr.c !== 1) return;
    if (!force && wc !== null) return;
    const f0 = S.immagine.finestre?.[0];
    if (!force && f0) { wc = f0.c; ww = f0.w; return; }
    // 1-99 percentile su un campione: niente valori estremi (bordo dello scanner) che appiattiscono i grigi
    const n = fr.data.length, step = Math.max(1, Math.floor(n / 20000)), sm = [];
    for (let k = 0; k < n; k += step) sm.push(fr.data[k]);
    sm.sort((a, b) => a - b);
    const lo = sm[Math.floor(sm.length * 0.01)], hi = sm[Math.floor(sm.length * 0.99)];
    ww = Math.max(1, hi - lo); wc = lo + ww / 2;
    if (!isFinite(ww) || ww <= 1) { ww = Math.max(1, fr.max - fr.min); wc = fr.min + ww / 2; }
  }

  const img = document.createElement("canvas");
  function paintImage(fr) {
    img.width = fr.w; img.height = fr.h;
    const g = img.getContext("2d");
    const id = g.createImageData(fr.w, fr.h);
    const out = id.data, d = fr.data;
    const mono1 = /MONOCHROME1/i.test(S.immagine.fotometria);
    const inv = invert !== mono1;
    if (fr.c === 3) {
      for (let k = 0, j = 0; k < d.length; k += 3, j += 4) {
        out[j] = inv ? 255 - d[k] : d[k]; out[j + 1] = inv ? 255 - d[k + 1] : d[k + 1]; out[j + 2] = inv ? 255 - d[k + 2] : d[k + 2]; out[j + 3] = 255;
      }
    } else {
      const lo = wc - 0.5 - (ww - 1) / 2, sc = 255 / Math.max(1e-6, ww - 1);
      if (fr.t === "i16") {
        const key = `${wc}|${ww}|${inv}`;
        if (key !== lutKey) {
          lut = new Uint8ClampedArray(65536);
          for (let v = -32768; v < 32768; v++) { let y = (v - lo) * sc; y = y < 0 ? 0 : y > 255 ? 255 : y; lut[v + 32768] = inv ? 255 - y : y; }
          lutKey = key;
        }
        for (let k = 0, j = 0; k < d.length; k++, j += 4) { const y = lut[d[k] + 32768]; out[j] = out[j + 1] = out[j + 2] = y; out[j + 3] = 255; }
      } else {
        for (let k = 0, j = 0; k < d.length; k++, j += 4) { let y = (d[k] - lo) * sc; y = y < 0 ? 0 : y > 255 ? 255 : y; if (inv) y = 255 - y; out[j] = out[j + 1] = out[j + 2] = y; out[j + 3] = 255; }
      }
    }
    g.putImageData(id, 0, 0);
  }

  // ---------------------------------------------------------------- disegno

  function view() {
    const r = stage.getBoundingClientRect();
    const W = Math.max(1, r.width), H = Math.max(1, r.height);
    if (cur && fitted) {
      const sp = S.immagine.spaziatura, ar = sp ? sp[0] / sp[1] : 1; // pixel non quadrati
      zoom = Math.min(W / cur.w, H / (cur.h * ar)) * 0.96; panX = panY = 0;
    }
    return { W, H };
  }
  function aspect() { const sp = S.immagine.spaziatura; return sp && sp[1] ? sp[0] / sp[1] : 1; }
  function toScreen(x, y) {
    const { W, H } = view();
    return [W / 2 + panX + (x - cur.w / 2) * zoom, H / 2 + panY + (y - cur.h / 2) * zoom * aspect()];
  }
  function toImage(sx, sy) {
    const { W, H } = view();
    return [(sx - W / 2 - panX) / zoom + cur.w / 2, (sy - H / 2 - panY) / (zoom * aspect()) + cur.h / 2];
  }

  function render() {
    const dpr = window.devicePixelRatio || 1;
    const { W, H } = view();
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
    if (!cur) return overlays();
    paintImage(cur);
    const [x0, y0] = toScreen(0, 0);
    g.imageSmoothingEnabled = zoom < 3;
    g.drawImage(img, x0, y0, cur.w * zoom, cur.h * zoom * aspect());
    drawMeasures(g, meas.get(idx) || [], drawing);
    overlays();
  }

  function mm(dx, dy) {
    const sp = S.immagine.spaziatura;
    return sp ? Math.hypot(dx * sp[1], dy * sp[0]) : null;
  }
  function stats(m) {
    const [a, b] = m.pts, x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]))), x1 = Math.min(cur.w - 1, Math.ceil(Math.max(a[0], b[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]))), y1 = Math.min(cur.h - 1, Math.ceil(Math.max(a[1], b[1])));
    const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, rx = Math.abs(a[0] - b[0]) / 2 || 0.5, ry = Math.abs(a[1] - b[1]) / 2 || 0.5;
    let n = 0, s = 0, s2 = 0, mn = Infinity, mx = -Infinity;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (m.type === "ellipse" && ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 > 1) continue;
      const k = y * cur.w + x;
      const v = cur.c === 1 ? cur.data[k] : (cur.data[k * 3] + cur.data[k * 3 + 1] + cur.data[k * 3 + 2]) / 3;
      n++; s += v; s2 += v * v; if (v < mn) mn = v; if (v > mx) mx = v;
    }
    const mean = n ? s / n : 0, sd = n ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) : 0;
    const sp = S.immagine.spaziatura;
    const area = m.type === "ellipse" ? Math.PI * rx * ry : (2 * rx) * (2 * ry);
    return { n, mean, sd, mn, mx, area: sp ? area * sp[0] * sp[1] : area, mmq: !!sp };
  }
  function label(m) {
    const u = S.immagine.unita ? " " + S.immagine.unita : "";
    if (m.type === "line") { const d = mm(m.pts[1][0] - m.pts[0][0], m.pts[1][1] - m.pts[0][1]); return d !== null ? fmt(d) + " mm" : fmt(Math.hypot(m.pts[1][0] - m.pts[0][0], m.pts[1][1] - m.pts[0][1])) + " px"; }
    if (m.type === "angle") {
      if (m.pts.length < 3) return "";
      const sp = S.immagine.spaziatura || [1, 1];
      const v1 = [(m.pts[0][0] - m.pts[1][0]) * sp[1], (m.pts[0][1] - m.pts[1][1]) * sp[0]], v2 = [(m.pts[2][0] - m.pts[1][0]) * sp[1], (m.pts[2][1] - m.pts[1][1]) * sp[0]];
      const a = Math.abs(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1])) * 180 / Math.PI;
      return fmt(a) + "°";
    }
    const st = stats(m);
    return `Media ${fmt(st.mean)}${u}  DS ${fmt(st.sd)}\nMin ${fmt(st.mn)}  Max ${fmt(st.mx)}\nArea ${fmt(st.area)} ${st.mmq ? "mm²" : "px²"}`;
  }
  function drawMeasures(g, list, extra) {
    g.save();
    g.lineWidth = 1.5; g.font = "12px " + getComputedStyle(document.body).getPropertyValue("--ui");
    for (const m of extra ? [...list, extra] : list) {
      const P = m.pts.map(p => toScreen(p[0], p[1]));
      g.strokeStyle = "#ffd23f"; g.fillStyle = "#ffd23f";
      g.beginPath();
      if (m.type === "line" || m.type === "angle") { P.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke(); }
      else if (m.type === "rect") { g.strokeRect(P[0][0], P[0][1], P[1][0] - P[0][0], P[1][1] - P[0][1]); }
      else if (m.type === "ellipse") { g.ellipse((P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2, Math.abs(P[1][0] - P[0][0]) / 2, Math.abs(P[1][1] - P[0][1]) / 2, 0, 0, Math.PI * 2); g.stroke(); }
      for (const p of P) { g.fillRect(p[0] - 2.5, p[1] - 2.5, 5, 5); }
      const txt = m.pts.length >= (m.type === "angle" ? 3 : 2) ? label(m) : "";
      if (txt) {
        const at = m.type === "angle" ? P[1] : [Math.max(P[0][0], P[1][0]) + 8, Math.min(P[0][1], P[1][1])];
        const lines = txt.split("\n");
        const w = Math.max(...lines.map(l => g.measureText(l).width)) + 10;
        // l'etichetta resta dentro l'immagine visibile (a sinistra della misura se a destra non c'e' spazio)
        const sc = g.getTransform().a || 1, cw = g.canvas.width / sc, ch = g.canvas.height / sc, hgt = lines.length * 15 + 6;
        let lx = at[0] + 6, ly = at[1] - 4;
        if (lx + w > cw - 4) lx = Math.max(4, Math.min(...P.map(p => p[0])) - w - 8);
        ly = Math.max(4, Math.min(ly, ch - hgt - 4));
        g.fillStyle = "rgba(0,0,0,.62)"; g.fillRect(lx, ly, w, hgt);
        g.fillStyle = "#ffd23f"; lines.forEach((l, i) => g.fillText(l, lx + 5, ly + 14 + i * 15));
      }
    }
    g.restore();
  }

  function overlays() {
    const r = S.riepilogo;
    ovTL.textContent = [r.paziente, r.id_paziente && "ID " + r.id_paziente, [r.nascita, r.sesso].filter(Boolean).join(" "), ].filter(Boolean).join("\n");
    ovTR.textContent = [r.istituto, r.studio, r.data, [r.modalita, r.serie].filter(Boolean).join(" · ")].filter(Boolean).join("\n");
    const f = S.fotogrammi[idx];
    const pos = f && S.sezioni[f.s]?.posizione;
    ovBL.textContent = [`Sezione ${idx + 1} / ${S.fotogrammi.length}`, pos ? `Posizione ${pos.map(v => fmt(v)).join(", ")}` : "",
      cur && cur.c === 1 && wc !== null ? `F ${fmt(ww)}  L ${fmt(wc)}${invert ? "  (invertita)" : ""}` : ""].filter(Boolean).join("\n");
    let probe = "";
    if (hover && cur) {
      const [x, y] = hover.map(Math.floor);
      if (x >= 0 && y >= 0 && x < cur.w && y < cur.h) {
        const k = y * cur.w + x;
        probe = `x ${x}  y ${y}  ` + (cur.c === 1 ? `${fmt(cur.data[k])}${S.immagine.unita ? " " + S.immagine.unita : ""}` : `RGB ${cur.data[k * 3]},${cur.data[k * 3 + 1]},${cur.data[k * 3 + 2]}`);
      }
    }
    ovBR.textContent = [probe, cur ? `Zoom ${Math.round(zoom * 100)}%  ${cur.w}x${cur.h}` : ""].filter(Boolean).join("\n");
    ctx.status(`Sezione ${idx + 1}/${S.fotogrammi.length}${wc !== null && cur?.c === 1 ? ` · F ${fmt(ww)} L ${fmt(wc)}` : ""}`);
  }

  async function go(i) {
    if (!S.fotogrammi.length) {
      ovErr.hidden = false; ovErr.textContent = "Il file DICOM non contiene immagini: i dati sono nella tabella dei tag."; cur = null; render();
      if (!tagsShown) toggleTags();
      return;
    }
    idx = Math.max(0, Math.min(S.fotogrammi.length - 1, i));
    slider.value = idx;
    try {
      const fr = await frameOf(idx);
      if (+slider.value !== idx) return; // nel frattempo si e' andati altrove
      cur = fr; ovErr.hidden = true;
      autoWindow(false);
    } catch (e) {
      cur = null; ovErr.hidden = false; ovErr.textContent = "Sezione non visualizzabile: " + e.message;
    }
    render();
    if (tagsShown && tagsFor !== S.sezioni[S.fotogrammi[idx].s].path) loadTags();
    prefetch();
  }

  // ---------------------------------------------------------------- strumenti e mouse
  function setTool(id) {
    tool = id;
    for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle("on", k === id);
    drawing = null;
    if (cur) render();
  }
  let drag = null;
  stage.addEventListener("contextmenu", e => e.preventDefault());
  stage.addEventListener("pointerdown", e => {
    if (e.target === slider || !cur) return;
    stage.focus();
    try { stage.setPointerCapture(e.pointerId); } catch { /* */ }
    const r = stage.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    const mode = e.button === 2 ? "wl" : e.button === 1 ? "pan" : tool;
    const ip = toImage(sx, sy);
    if (mode === "line" || mode === "angle") {
      if (!drawing) drawing = { type: mode, pts: [ip, ip] };
      else if (mode === "angle" && drawing.pts.length === 2) drawing.pts.push(ip);
      else finishDrawing();
      render();
      return;
    }
    if (mode === "ellipse" || mode === "rect") { drawing = { type: mode, pts: [ip, ip] }; drag = { mode, sx, sy }; return; }
    drag = { mode, sx, sy, wc, ww, zoom, panX, panY };
    if (mode === "zoom" || mode === "pan") fitted = false;
  });
  stage.addEventListener("pointermove", e => {
    if (!cur) return;
    const r = stage.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    hover = toImage(sx, sy);
    if (drawing && (!drag || drag.mode === "ellipse" || drag.mode === "rect")) {
      drawing.pts[drawing.pts.length - 1] = hover;
      return render();
    }
    if (!drag) return overlays();
    const dx = sx - drag.sx, dy = sy - drag.sy;
    if (drag.mode === "wl" && cur.c === 1) {
      const k = Math.max(0.5, (drag.ww || 400) / 400);
      ww = Math.max(1, drag.ww + dx * k * 2); wc = drag.wc + dy * k;
    } else if (drag.mode === "pan") { panX = drag.panX + dx; panY = drag.panY + dy; }
    else if (drag.mode === "zoom") { zoom = Math.max(0.05, Math.min(40, drag.zoom * Math.exp(-dy / 150))); }
    render();
  });
  stage.addEventListener("pointerup", () => {
    if (drag && (drag.mode === "ellipse" || drag.mode === "rect")) finishDrawing();
    drag = null;
  });
  stage.addEventListener("pointerleave", () => { hover = null; if (cur) overlays(); });
  function finishDrawing() {
    if (!drawing) return;
    const list = meas.get(idx) || [];
    const p = drawing.pts;
    if (Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) > 0.5) list.push(drawing);
    meas.set(idx, list);
    drawing = null; drag = null;
    render();
  }
  stage.addEventListener("wheel", e => {
    e.preventDefault();
    if (e.ctrlKey) {
      const r = stage.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      const before = toImage(sx, sy);
      fitted = false;
      zoom = Math.max(0.05, Math.min(40, zoom * Math.exp(-e.deltaY / 300)));
      const after = toScreen(before[0], before[1]);
      panX += sx - after[0]; panY += sy - after[1];
      return render();
    }
    go(idx + (e.deltaY > 0 ? 1 : -1));
  }, { passive: false });
  slider.addEventListener("input", () => go(+slider.value));
  new ResizeObserver(() => { if (!ctx.tab.view.hidden) render(); }).observe(stage);

  function onKey(e) {
    if (ctx.tab.view.hidden || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "") || document.querySelector("#modal:not([hidden])")) return;
    const k = e.key;
    if (k === "ArrowDown" || k === "ArrowRight" || k === "PageDown") { go(idx + (k === "PageDown" ? 10 : 1)); e.preventDefault(); }
    else if (k === "ArrowUp" || k === "ArrowLeft" || k === "PageUp") { go(idx - (k === "PageUp" ? 10 : 1)); e.preventDefault(); }
    else if (k === "Home") go(0);
    else if (k === "End") go(S.fotogrammi.length - 1);
    else if (k === " ") { togglePlay(); e.preventDefault(); }
    else if (k === "Escape") { drawing = null; render(); }
    else if (k.toLowerCase() === "i" && !e.ctrlKey) { invert = !invert; render(); }
    else if (k.toLowerCase() === "r" && !e.ctrlKey) { fitted = true; wc = ww = null; autoWindow(false); render(); }
    else if (k.toLowerCase() === "t" && !e.ctrlKey) toggleTags();
    else if (e.ctrlKey && k.toLowerCase() === "z") { const l = meas.get(idx); if (l?.length) { l.pop(); render(); } e.preventDefault(); }
  }
  window.addEventListener("keydown", onKey);

  function togglePlay() { if (playing) stopPlay(); else if (S.fotogrammi.length > 1) { playBtn.classList.add("on"); tick(); } }
  function stopPlay() { if (playing) clearTimeout(playing); playing = null; playBtn.classList.remove("on"); }
  async function tick() {
    playing = setTimeout(async () => {
      await go((idx + 1) % S.fotogrammi.length);
      if (playing) tick();
    }, 1000 / Math.max(1, Math.min(60, +fps.value || 10)));
  }

  // ---------------------------------------------------------------- tag
  function toggleTags() {
    tagsShown = !tagsShown;
    tagPane.hidden = !tagsShown;
    split.classList.toggle("with-right", tagsShown);
    if (tagsShown) loadTags();
    requestAnimationFrame(render);
  }
  async function loadTags() {
    const f = S.fotogrammi[idx];
    const p = f ? S.sezioni[f.s].path : ctx.path;
    tagsFor = p;
    tagBox.innerHTML = "";
    tagBox.append(el("div", { class: "fx-empty" }, "Lettura dei tag..."));
    try { tagRows = (await api("fx", { op: "dicom_tags", path: p })).tag; } catch (e) { tagBox.innerHTML = ""; tagBox.append(el("p", { class: "err", style: { padding: "10px" } }, e.message)); return; }
    renderTags();
  }
  function renderTags() {
    const q = tagSearch.value.trim().toLowerCase();
    const t = el("table", { class: "fx-table dcm-tags" }, el("thead", {}, el("tr", {}, el("th", {}, "Tag"), el("th", {}, "Nome"), el("th", {}, "VR"), el("th", {}, "Valore"))));
    const tb = el("tbody");
    let n = 0;
    for (const r of tagRows || []) {
      if (q && !`${r.tag} ${r.nome} ${r.valore}`.toLowerCase().includes(q)) continue;
      if (++n > 5000) break;
      tb.append(el("tr", { class: (r.privato ? "priv" : "") + (r.voce ? " item" : "") }, el("td", { class: "mono" }, r.tag),
        el("td", { class: "lvl" + Math.min(4, r.livello) }, r.nome || (r.privato ? "(privato)" : "")), el("td", { class: "mono" }, r.vr), el("td", { style: { overflowWrap: "anywhere" } }, r.valore)));
    }
    t.append(tb);
    tagBox.innerHTML = "";
    tagBox.append(t);
  }
  tagSearch.addEventListener("input", renderTags);

  function tagsCsv() {
    const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    return "﻿" + ["Tag;Nome;VR;Livello;Valore", ...(tagRows || []).map(r => [r.tag, r.nome, r.vr, r.livello, r.valore].map(esc).join(";"))].join("\r\n");
  }
  async function exportTagsCsv() {
    if (!tagRows) await loadTags();
    const p = await pickSavePath(ctx.name.replace(/\.[^.]+$/, "") + "_tag.csv", ctx.path.replace(/[\\/][^\\/]*$/, ""));
    if (!p) return;
    await saveBytes(p, new TextEncoder().encode(tagsCsv()));
    toast("Tag esportati: " + p);
  }

  // ---------------------------------------------------------------- esportazione
  function snapshot(fr, i) {
    paintImage(fr);
    const ar = aspect();
    const c = document.createElement("canvas");
    c.width = fr.w; c.height = Math.round(fr.h * ar);
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0, c.width, c.height);
    // misure alla scala dell'immagine
    const saved = { zoom, panX, panY, fitted, cur };
    const list = meas.get(i) || [];
    if (list.length) {
      cur = fr; fitted = false; zoom = 1;
      const { W, H } = view();
      panX = c.width / 2 - W / 2; panY = c.height / 2 - H / 2;
      drawMeasures(g, list, null);
    }
    zoom = saved.zoom; panX = saved.panX; panY = saved.panY; fitted = saved.fitted; cur = saved.cur;
    return c;
  }
  async function canvasBytes(c, type) {
    const b = await new Promise(r => c.toBlob(r, type, 0.92));
    return new Uint8Array(await b.arrayBuffer());
  }
  async function exportAll() {
    const dir = await pickFolder();
    if (!dir) return;
    const base = ctx.name.replace(/\.[^.]+$/, "");
    const n = S.fotogrammi.length, digits = String(n).length;
    for (let i = 0; i < n; i++) {
      ctx.status(`Esportazione ${i + 1}/${n}`);
      try {
        const fr = await frameOf(i);
        await saveBytes(`${dir}\\${base}_${String(i + 1).padStart(digits, "0")}.png`, await canvasBytes(snapshot(fr, i), "image/png"));
      } catch (e) { toast(`Sezione ${i + 1}: ${e.message}`, true); }
    }
    render();
    toast(`${n} sezioni salvate in ${dir}`);
  }

  fillPresets();
  renderSeries();
  await go(idx);
  return {
    saveInPlace: false,
    saveFormats: ["png", "jpg", "csv"],
    saveLabels: { png: "Sezione attuale come immagine (con misure)", jpg: "Sezione attuale come immagine (con misure)", csv: "Tag DICOM in tabella" },
    saveNote: "Le immagini si salvano con la finestra/livello attuale. Per tutte le sezioni usa \"Esporta sezioni\".",
    async save(target) {
      const ext = target.split(".").pop().toLowerCase();
      if (ext === "csv") { if (!tagRows) await loadTags(); await saveBytes(target, new TextEncoder().encode(tagsCsv())); return { switchTo: false }; }
      if (!cur) throw new Error("Nessuna immagine da salvare");
      await saveBytes(target, await canvasBytes(snapshot(cur, idx), ext === "png" ? "image/png" : "image/jpeg"));
      render();
      return { switchTo: false };
    },
    onShow() { render(); },
    dispose() { stopPlay(); window.removeEventListener("keydown", onKey); cache.clear(); },
  };
}

function fmt(v) {
  if (v === null || v === undefined || !isFinite(v)) return "-";
  const a = Math.abs(v);
  return (a >= 100 || Number.isInteger(v) ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100).toLocaleString("it-IT");
}
