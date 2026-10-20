// Immagini (anche RAW, HEIC, PSD, TIFF...): zoom e modifica (ruota, rifletti, ritaglia, ridimensiona, regolazioni, disegno, testo).
import { api, askText, button, el, extOf, fileUrl, loading, modal, withExt } from "../core.js";

const NATIVE = new Set(["png", "apng", "jpg", "jpeg", "jpe", "jfif", "pjpeg", "pjp", "gif", "webp", "bmp", "dib", "ico", "cur", "avif"]);
const CLIENT_ENC = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", jfif: "image/jpeg", webp: "image/webp" };
const RAW = new Set(["cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "orf", "rw2", "raf", "dng", "pef", "ptx", "srw", "x3f", "3fr", "fff", "erf", "kdc", "dcr", "mos", "mef", "mrw", "rwl", "iiq", "raw", "rwz", "bay", "cap", "eip"]);

export async function mount(ctx) {
  const ld = loading(ctx.el, "Apertura dell'immagine");
  let src = fileUrl(ctx.path), meta = {};
  if (!NATIVE.has(ctx.ext)) {
    ld.set(0.3, RAW.has(ctx.ext) ? "Sviluppo del file RAW" : "Conversione dell'immagine");
    const r = await api("image", { path: ctx.path });
    src = fileUrl(r.path);
    meta = r.info;
  }
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Immagine non leggibile")); i.src = src; });
  ctx.el.innerHTML = "";

  // stato: canvas di lavoro + cronologia per annulla
  let work = document.createElement("canvas");
  work.width = img.naturalWidth; work.height = img.naturalHeight;
  work.getContext("2d").drawImage(img, 0, 0);
  const history = [];
  const snapshot = () => { const c = document.createElement("canvas"); c.width = work.width; c.height = work.height; c.getContext("2d").drawImage(work, 0, 0); history.push(c); if (history.length > 30) history.shift(); };
  let adj = { b: 100, c: 100, s: 100, g: 0 };

  const view = el("canvas", { style: { display: "block", margin: "auto", imageRendering: "auto", boxShadow: "0 1px 6px rgba(0,0,0,.25)", background: "repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 50% / 16px 16px" } });
  const stage = el("div", { style: { overflow: "auto", height: "100%", display: "grid", placeItems: "center", padding: "16px" } }, view);
  ctx.el.append(stage);
  ctx.fillBody(true);
  let zoom = 0, mode = null, color = "#ff3b30", penSize = 6;

  function filterStr() { return `brightness(${adj.b}%) contrast(${adj.c}%) saturate(${adj.s}%) grayscale(${adj.g}%)`; }
  function fitZoom() { const r = stage.getBoundingClientRect(); return Math.min(1, (r.width - 40) / work.width, (r.height - 40) / work.height); }
  function draw() {
    const z = zoom || fitZoom();
    view.width = work.width; view.height = work.height;
    view.style.width = work.width * z + "px"; view.style.height = work.height * z + "px";
    const g = view.getContext("2d");
    g.filter = filterStr();
    g.drawImage(work, 0, 0);
    g.filter = "none";
    if (cropRect) { g.fillStyle = "rgba(0,0,0,.45)"; const { x, y, w, h } = norm(cropRect); g.fillRect(0, 0, work.width, y); g.fillRect(0, y + h, work.width, work.height - y - h); g.fillRect(0, y, x, h); g.fillRect(x + w, y, work.width - x - w, h); g.strokeStyle = "#fff"; g.lineWidth = Math.max(1, 1.5 / z); g.strokeRect(x, y, w, h); }
    ctx.status(`${work.width} × ${work.height} px · zoom ${Math.round(z * 100)}%` + (meta.formato ? " · " + meta.formato : ""));
  }
  const norm = r => ({ x: Math.min(r.x0, r.x1), y: Math.min(r.y0, r.y1), w: Math.abs(r.x1 - r.x0), h: Math.abs(r.y1 - r.y0) });
  function bake() {
    if (adj.b === 100 && adj.c === 100 && adj.s === 100 && adj.g === 0) return;
    const c = document.createElement("canvas"); c.width = work.width; c.height = work.height;
    const g = c.getContext("2d"); g.filter = filterStr(); g.drawImage(work, 0, 0);
    work = c; adj = { b: 100, c: 100, s: 100, g: 0 };
    sliders.forEach(s => (s.value = s.dataset.def));
  }
  function transform(fn, w, h) {
    snapshot(); bake();
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    fn(c.getContext("2d"), work);
    work = c; ctx.setDirty(true); draw();
  }
  const rotate = deg => transform((g, s) => { g.translate(deg === 90 ? s.height : 0, deg === 90 ? 0 : s.width); g.rotate(deg * Math.PI / 180); g.drawImage(s, 0, 0); }, work.height, work.width);
  const flip = h => transform((g, s) => { g.translate(h ? s.width : 0, h ? 0 : s.height); g.scale(h ? -1 : 1, h ? 1 : -1); g.drawImage(s, 0, 0); }, work.width, work.height);

  // ritaglio / disegno / testo con il mouse
  let cropRect = null, drawing = false, last = null;
  const pt = e => { const r = view.getBoundingClientRect(); return [(e.clientX - r.left) * work.width / r.width, (e.clientY - r.top) * work.height / r.height]; };
  view.addEventListener("pointerdown", async e => {
    const [x, y] = pt(e);
    if (mode === "crop") { cropRect = { x0: x, y0: y, x1: x, y1: y }; drawing = true; view.setPointerCapture(e.pointerId); }
    else if (mode === "pen") { snapshot(); bake(); drawing = true; last = [x, y]; view.setPointerCapture(e.pointerId); }
    else if (mode === "text") {
      const t = await askText("Aggiungi testo", "Testo da inserire", "");
      if (!t) return;
      snapshot(); bake();
      const g = work.getContext("2d");
      g.fillStyle = color; g.font = `bold ${Math.max(14, Math.round(work.width / 30))}px Segoe UI, Arial`; g.textBaseline = "top";
      g.fillText(t, x, y); ctx.setDirty(true); draw();
    }
  });
  view.addEventListener("pointermove", e => {
    if (!drawing) return;
    const [x, y] = pt(e);
    if (mode === "crop") { cropRect.x1 = x; cropRect.y1 = y; draw(); }
    else if (mode === "pen") {
      const g = work.getContext("2d");
      g.strokeStyle = color; g.lineWidth = penSize * Math.max(1, work.width / 1200); g.lineCap = "round";
      g.beginPath(); g.moveTo(...last); g.lineTo(x, y); g.stroke(); last = [x, y]; ctx.setDirty(true); draw();
    }
  });
  view.addEventListener("pointerup", () => { drawing = false; if (mode === "crop" && cropRect) applyBtn.disabled = false; });
  stage.addEventListener("wheel", e => { if (!e.ctrlKey) return; e.preventDefault(); zoom = Math.max(0.05, Math.min(16, (zoom || fitZoom()) * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); draw(); }, { passive: false });

  const setMode = m => { mode = mode === m ? null : m; cropBtn.classList.toggle("on", mode === "crop"); penBtn.classList.toggle("on", mode === "pen"); txtBtn.classList.toggle("on", mode === "text"); view.style.cursor = mode ? "crosshair" : "default"; if (mode !== "crop") { cropRect = null; applyBtn.disabled = true; draw(); } };
  const cropBtn = button("Ritaglia", "crop", () => setMode("crop"));
  const applyBtn = button("Applica ritaglio", null, () => {
    const { x, y, w, h } = norm(cropRect);
    if (w < 2 || h < 2) return;
    transform((g, s) => g.drawImage(s, x, y, w, h, 0, 0, w, h), Math.round(w), Math.round(h));
    cropRect = null; applyBtn.disabled = true; setMode(null);
  });
  applyBtn.disabled = true;
  const penBtn = button("Disegna", "pen", () => setMode("pen"));
  const txtBtn = button("Testo", "text", () => setMode("text"));
  const colorIn = el("input", { type: "color", value: color, title: "Colore", id: "imgcol-" + ctx.tab.name, oninput: e => (color = e.target.value) });
  const mk = (label, key, min, max, def) => { const s = el("input", { type: "range", min, max, value: def, "data-def": def, title: label, id: `adj-${key}-${ctx.tab.name}` }); s.addEventListener("input", () => { adj[key] = +s.value; ctx.setDirty(true); draw(); }); return el("label", {}, label, s); };
  const adjBox = [mk("Luminosita'", "b", 0, 200, 100), mk("Contrasto", "c", 0, 200, 100), mk("Saturazione", "s", 0, 200, 100), mk("B/N", "g", 0, 100, 0)];
  const sliders = adjBox.map(l => l.querySelector("input"));
  ctx.tb.append(
    button("Adatta", "fit", () => { zoom = 0; draw(); }), button("100%", null, () => { zoom = 1; draw(); }),
    button("", "zoomIn", () => { zoom = (zoom || fitZoom()) * 1.25; draw(); }, { iconOnly: true, title: "Ingrandisci (anche Ctrl+rotella)" }),
    button("", "zoomOut", () => { zoom = (zoom || fitZoom()) / 1.25; draw(); }, { iconOnly: true, title: "Riduci" }),
    el("span", { class: "sep" }),
    button("", "rotateL", () => rotate(-90), { iconOnly: true, title: "Ruota a sinistra" }), button("", "rotate", () => rotate(90), { iconOnly: true, title: "Ruota a destra" }),
    button("", "flipH", () => flip(true), { iconOnly: true, title: "Rifletti orizzontalmente" }), button("", "flipV", () => flip(false), { iconOnly: true, title: "Rifletti verticalmente" }),
    cropBtn, applyBtn, button("Ridimensiona", null, async () => {
      const v = await askText("Ridimensiona", `Nuova larghezza in pixel (attuale ${work.width}); l'altezza segue le proporzioni`, String(work.width));
      const w = parseInt(v, 10);
      if (!w || w < 1) return;
      const h = Math.round(work.height * w / work.width);
      transform((g, s) => { g.imageSmoothingQuality = "high"; g.drawImage(s, 0, 0, w, h); }, w, h);
    }),
    el("span", { class: "sep" }), penBtn, txtBtn, colorIn, el("span", { class: "sep" }), ...adjBox,
    button("", "undo", () => { const h = history.pop(); if (h) { work = h; draw(); } }, { iconOnly: true, title: "Annulla" }),
    button("Info", null, () => showInfo()));
  async function showInfo() {
    const dl = el("dl", { class: "kv" });
    const add = (k, v) => v !== undefined && dl.append(el("dt", {}, k), el("dd", {}, String(v)));
    add("Dimensioni", `${img.naturalWidth} × ${img.naturalHeight} px`);
    add("Formato", meta.formato || ctx.ext.toUpperCase());
    add("Modalita' colore", meta.modalita);
    add("Pagine/fotogrammi", meta.pagine);
    for (const [k, v] of Object.entries(meta.exif || {})) add(k, v);
    await modal("Informazioni immagine", dl);
  }
  new ResizeObserver(() => draw()).observe(stage);
  draw();

  const outType = ext => CLIENT_ENC[ext];
  return {
    saveInPlace: !RAW.has(ctx.ext),
    saveAsName: () => (RAW.has(ctx.ext) ? withExt(ctx.name, "jpg") : ctx.name),
    async save(target) {
      bake();
      const ext = extOf(target);
      const type = outType(ext);
      const blob = await new Promise(r => work.toBlob(r, type || "image/png", 0.93));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (type) await api("save", { path: target }, { body: bytes });
      else await api("image_save", { path: target }, { body: bytes }); // conversione nel formato richiesto
      draw();
    },
    onShow() { draw(); },
  };
}
