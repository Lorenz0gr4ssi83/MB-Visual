// Scansione di documenti con la fotocamera (app per telefono), tutto nel dispositivo:
// fotocamera con rilevamento dei bordi del foglio in tempo reale e scatto automatico, ritaglio con i 4 angoli,
// correzione della prospettiva, filtri (colore migliorato, scala di grigi, bianco e nero, originale), piu' pagine
// (ordine, rotazione, eliminazione), PDF con testo ricercabile (OCR italiano) da condividere, salvare o aprire.
// Librerie (ui/vendor, scaricate da tools/build_web.py): OpenCV.js 4.10 (Apache 2.0), Tesseract.js 6 (Apache 2.0)
// con i dati "ita" di tessdata (Apache 2.0), pdf-lib (MIT).
import { el, loadCss, loadScript, toast } from "./core.js";
import { t as tr, tn, LOCALE } from "./i18n.js";

const V = p => (window.MBV_ROOT || "/") + "vendor/" + p;
const MAX_SRC = 3200;   // lato lungo massimo della foto conservata
const MAX_OUT = 2480;   // lato lungo massimo della pagina raddrizzata (A4 a 300 dpi)
const FILTERS = [["color", tr("scanner.colore_migliorato")], ["gray", tr("scanner.scala_grigi")], ["bw", tr("scanner.bianco_nero")], ["orig", tr("scanner.originale")]];
const SIZES = { a4: [595.28, 841.89, "A4"], letter: [612, 792, tr("scanner.lettera")], fit: [0, 0, tr("scanner.come_foglio_fotografato")] };

// ---------------------------------------------------------------- OpenCV
let cvPromise = null;
export function loadCV() {
  if (!cvPromise) cvPromise = (async () => {
    await loadScript(V("opencv/opencv.js"));
    // il modulo di Emscripten ha un metodo then che risolve con se stesso: "await cv" non finirebbe mai.
    // Si aspetta che compaia cv.Mat (runtime WebAssembly pronto).
    const cv = window.cv;
    if (cv instanceof Promise) { const m = await cv; window.cv = m; return m; }
    for (let i = 0; !cv.Mat; i++) {
      if (i > 600) throw new Error(tr("scanner.opencv_non_si_avviato"));
      await new Promise(r => setTimeout(r, 50));
    }
    delete cv.then; // altrimenti anche restituirlo da una funzione async non finirebbe mai
    return cv;
  })();
  cvPromise.catch(() => { cvPromise = null; });
  return cvPromise;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// angoli in ordine: alto-sinistra, alto-destra, basso-destra, basso-sinistra
function orderQuad(pts) {
  const s = pts.map(p => p[0] + p[1]), d = pts.map(p => p[0] - p[1]);
  const tl = pts[s.indexOf(Math.min(...s))], br = pts[s.indexOf(Math.max(...s))];
  const tr = pts[d.indexOf(Math.max(...d))], bl = pts[d.indexOf(Math.min(...d))];
  const q = [tl, tr, br, bl];
  return new Set(q).size === 4 ? q : null;
}
const polyArea = q => Math.abs(q.reduce((a, p, i) => { const n = q[(i + 1) % q.length]; return a + p[0] * n[1] - n[0] * p[1]; }, 0)) / 2;
function convex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(z) < 1e-9) return false;
    if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

// Bordi del foglio in un'immagine piccola (lato lungo ~500 px): due strade (contorni di Canny e soglia di Otsu,
// il foglio di solito e' piu' chiaro del piano) e si sceglie il quadrilatero convesso piu' grande.
// Restituisce i 4 angoli nelle coordinate dell'immagine o null.
export function detectQuad(cv, canvas) {
  const W = canvas.width, H = canvas.height, minArea = W * H * 0.12;
  const mats = [];
  const M = m => (mats.push(m), m);
  const best = { q: null, a: 0 };
  try {
    const src = M(cv.imread(canvas));
    const gray = M(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const kernel = M(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const look = bin => {
      const contours = new cv.MatVector(), hier = new cv.Mat();
      cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        if (cv.contourArea(c) >= minArea) {
          const hull = new cv.Mat(), ap = new cv.Mat();
          cv.convexHull(c, hull, false, true);
          const peri = cv.arcLength(hull, true);
          for (const eps of [0.02, 0.035, 0.05]) {
            cv.approxPolyDP(hull, ap, eps * peri, true);
            if (ap.rows === 4) break;
          }
          if (ap.rows === 4) {
            const d = ap.data32S;
            const q = orderQuad([[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]]);
            const a = q ? polyArea(q) : 0;
            // un foglio non occupa tutta l'inquadratura fino ai bordi esatti (sarebbe il contorno dell'immagine)
            if (q && convex(q) && a > best.a && a < W * H * 0.985) { best.q = q; best.a = a; }
          }
          hull.delete(); ap.delete();
        }
        c.delete();
      }
      contours.delete(); hier.delete();
    };
    // 1) contorni (soglie dalla mediana dei grigi)
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.data.length; i += 7) hist[gray.data[i]]++;
    let acc = 0, med = 127; const half = gray.data.length / 14;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= half) { med = v; break; } }
    const edges = M(new cv.Mat());
    cv.Canny(gray, edges, Math.max(10, 0.5 * med), Math.min(255, 1.2 * med + 20));
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);
    look(edges);
    // 2) foglio chiaro su fondo piu' scuro
    const th = M(new cv.Mat());
    cv.threshold(gray, th, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(th, th, cv.MORPH_OPEN, kernel, new cv.Point(-1, -1), 2);
    look(th);
  } finally { mats.forEach(m => m.delete()); }
  return best.q;
}

// Raddrizza il foglio: dimensioni dalla media dei lati opposti, al massimo MAX_OUT px sul lato lungo
export function warp(cv, srcCanvas, q) {
  let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const k = Math.min(1, MAX_OUT / Math.max(w, h));
  w = Math.max(16, Math.round(w * k)); h = Math.max(16, Math.round(h * k));
  const src = cv.imread(srcCanvas), dst = new cv.Mat();
  const a = cv.matFromArray(4, 1, cv.CV_32FC2, q.flat());
  // rifilo dello 0,6% per lato: il bordo del foglio (e un filo di piano) non deve restare come riga scura
  const m = 0.006 * Math.max(w, h);
  const b = cv.matFromArray(4, 1, cv.CV_32FC2, [-m, -m, w + m, -m, w + m, h + m, -m, h + m]);
  const T = cv.getPerspectiveTransform(a, b);
  cv.warpPerspective(src, dst, T, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
  [src, a, b, T].forEach(m => m.delete());
  return dst; // RGBA
}

// sfondo (carta) stimato su una copia ridotta: dilatazione (toglie il testo) + mediana, riportato alla grandezza piena
function background(cv, ch) {
  const k = Math.min(1, 700 / Math.max(ch.cols, ch.rows));
  const small = new cv.Mat(), bg = new cv.Mat();
  cv.resize(ch, small, new cv.Size(Math.round(ch.cols * k), Math.round(ch.rows * k)), 0, 0, cv.INTER_AREA);
  const ker = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
  cv.dilate(small, small, ker);
  cv.medianBlur(small, small, 21);
  cv.resize(small, bg, new cv.Size(ch.cols, ch.rows), 0, 0, cv.INTER_LINEAR);
  small.delete(); ker.delete();
  return bg;
}
function flatten(cv, ch) { // divisione per lo sfondo: ombre e carta ingiallita diventano bianco uniforme
  const bg = background(cv, ch), out = new cv.Mat();
  cv.divide(ch, bg, out, 255);
  bg.delete();
  return out;
}

// filtri su un'immagine RGBA raddrizzata; restituisce una Mat nuova (RGBA o grigi)
export function applyFilter(cv, rgba, mode) {
  if (mode === "orig") return rgba.clone();
  if (mode === "color") {
    const rgb = new cv.Mat(); cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    const chs = new cv.MatVector(); cv.split(rgb, chs);
    const outs = new cv.MatVector();
    for (let i = 0; i < 3; i++) {
      const c = chs.get(i), f = flatten(cv, c);
      f.convertTo(f, -1, 1.12, -22); // un po' di contrasto: inchiostro piu' deciso
      outs.push_back(f); f.delete(); c.delete();
    }
    const out = new cv.Mat(); cv.merge(outs, out);
    rgb.delete(); chs.delete(); outs.delete();
    return out;
  }
  const gray = new cv.Mat(); cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  const flat = flatten(cv, gray);
  gray.delete();
  if (mode === "gray") { flat.convertTo(flat, -1, 1.2, -45); return flat; }
  const bw = new cv.Mat();
  let block = Math.round(Math.max(flat.cols, flat.rows) / 60) | 1;
  block = Math.max(15, block);
  cv.adaptiveThreshold(flat, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 14);
  flat.delete();
  return bw;
}

// ---------------------------------------------------------------- utilita' immagini
const canvasOf = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const toBlob = (c, type = "image/jpeg", q = 0.88) => new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error(tr("scanner.immagine_non_creata")))), type, q));
async function blobToCanvas(blob, maxSide = Infinity) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = canvasOf(Math.round(bmp.width * k), Math.round(bmp.height * k));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}
function scaled(src, maxSide) {
  const w = src.videoWidth || src.width, h = src.videoHeight || src.height; // anche un <video>
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = canvasOf(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return [c, k];
}
function rotated(src, rot) {
  if (!rot) return src;
  const swap = rot % 180 !== 0;
  const c = canvasOf(swap ? src.height : src.width, swap ? src.width : src.height);
  const g = c.getContext("2d");
  g.translate(c.width / 2, c.height / 2);
  g.rotate(rot * Math.PI / 180);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}
const fullQuad = (w, h) => { const m = Math.round(Math.min(w, h) * 0.02); return [[m, m], [w - m, m], [w - m, h - m], [m, h - m]]; };
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`; };

// ---------------------------------------------------------------- OCR (Tesseract.js, italiano)
let ocrWorker = null;
async function getOcr(onProgress) {
  if (!ocrWorker) {
    ocrWorker = (async () => {
      await loadScript(V("tesseract/tesseract.min.js"));
      return window.Tesseract.createWorker("ita", 1, {
        workerPath: V("tesseract/worker.min.js"), corePath: V("tesseract/"), langPath: V("tesseract/"),
        gzip: true, workerBlobURL: false, cacheMethod: "none",
        logger: m => onProgress?.(m),
      });
    })();
    ocrWorker.catch(() => { ocrWorker = null; });
  }
  return ocrWorker;
}

// ---------------------------------------------------------------- PDF (pdf-lib) con testo invisibile sotto le immagini
async function buildPdf(pages, { size, ocr, title }, progress) {
  await loadScript(V("pdf-lib/pdf-lib.min.js"));
  const { PDFDocument, StandardFonts, pushGraphicsState, popGraphicsState, setTextRenderingMode, TextRenderingMode } = window.PDFLib;
  const doc = await PDFDocument.create();
  doc.setTitle(title); doc.setCreator("MB Visual"); doc.setProducer("MB Visual - scansione"); doc.setCreationDate(new Date());
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let worker = null, texts = [];
  if (ocr) {
    progress(0, tr("scanner.preparazione_riconoscimento_testo_prima_volta"));
    let cur = 0;
    worker = await getOcr(m => { if (m.status === "recognizing text") progress((cur + m.progress) / pages.length, tr("scanner.riconoscimento_testo_pagina_0_1", cur + 1, pages.length)); });
    for (; cur < pages.length; cur++) {
      progress(cur / pages.length, tr("scanner.riconoscimento_testo_pagina_0_1", cur + 1, pages.length));
      const r = await worker.recognize(await pages[cur].final(), {}, { blocks: true, text: true });
      texts.push(r.data);
    }
  }
  for (let i = 0; i < pages.length; i++) {
    progress(i / pages.length, tr("scanner.creazione_pdf_pagina_0_1", i + 1, pages.length));
    const pg = pages[i];
    const blob = await pg.final();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const img = blob.type === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const iw = img.width, ih = img.height, land = iw > ih;
    let [pw, ph] = SIZES[size] || SIZES.a4;
    if (!pw) { pw = land ? 841.89 : 595.28; ph = pw * ih / iw; } else if (land) [pw, ph] = [ph, pw];
    const k = Math.min(pw / iw, ph / ih), w = iw * k, h = ih * k, x0 = (pw - w) / 2, y0 = (ph - h) / 2;
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: x0, y: y0, width: w, height: h });
    const data = texts[i];
    if (data?.blocks) {
      page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
      for (const b of data.blocks) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const wd of l.words || []) {
        let t = (wd.text || "").trim();
        if (!t) continue;
        const bb = wd.bbox, bw = (bb.x1 - bb.x0) * k, bh = (bb.y1 - bb.y0) * k;
        let unit;
        try { unit = font.widthOfTextAtSize(t, 1); } catch {
          t = t.replace(/[^\x20-\x7e\xa0-\xff€’‘“”–—…]/g, "?");
          try { unit = font.widthOfTextAtSize(t, 1); } catch { continue; }
        }
        if (!unit || bw <= 0) continue;
        const fs = Math.max(1, Math.min(bw / unit, bh * 1.6));
        page.drawText(t, { x: x0 + bb.x0 * k, y: y0 + h - bb.y1 * k + bh * 0.18, size: fs, font });
      }
      page.pushOperators(popGraphicsState());
    }
  }
  progress(1, tr("scanner.salvataggio_pdf"));
  const pdf = await doc.save();
  const text = texts.map((d, i) => (texts.length > 1 ? `--- ${tr("scanner.pagina_0_2", i + 1)} ---\n` : "") + (d.text || "").trim()).join("\n\n");
  return { pdf, text };
}

// ---------------------------------------------------------------- pagina scansionata
// src: Blob JPEG della foto (lato lungo <= MAX_SRC); quad: angoli nella foto; filter; rot (gradi); out: Blob elaborato
class Page {
  constructor(src, w, h, quad) { Object.assign(this, { src, w, h, quad, filter: "color", rot: 0, out: null, thumb: "" }); }
  async process(cv) {
    const c = await blobToCanvas(this.src);
    const flat = warp(cv, c, this.quad);
    const f = applyFilter(cv, flat, this.filter);
    const out = canvasOf(f.cols, f.rows);
    cv.imshow(out, f);
    flat.delete(); f.delete();
    // bianco e nero in PNG (piu' nitido e leggero), il resto in JPEG
    this.out = this.filter === "bw" ? await toBlob(out, "image/png") : await toBlob(out, "image/jpeg", 0.85);
    this.outCanvas = null;
    await this.makeThumb(out);
    return out;
  }
  async makeThumb(out) {
    out = out || await blobToCanvas(this.out, 400);
    const [t] = scaled(rotated(out, this.rot), 300);
    this.thumb = t.toDataURL("image/jpeg", 0.7);
  }
  async final() { // immagine definitiva con la rotazione
    if (!this.rot) return this.out;
    const c = rotated(await blobToCanvas(this.out), this.rot);
    return this.filter === "bw" ? toBlob(c, "image/png") : toBlob(c, "image/jpeg", 0.85);
  }
}

// ---------------------------------------------------------------- interfaccia
export async function openScanner({ openPdf } = {}) {
  loadCss("css/scanner.css");
  const root = el("div", { class: "scn-root" });
  document.body.append(root);
  document.documentElement.classList.add("scn-open");
  const pages = [];
  let cv = null, stream = null, screen = null, closed = false;
  const cvReady = loadCV().then(c => (cv = c));
  cvReady.catch(e => toast(tr("scanner.motore_scansione_non_caricato") + e.message, true, 8000));

  const icon = d => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.innerHTML = `<path d="${d}"/>`; return s; };
  const btn = (label, fn, cls = "", ic = null) => {
    const b = el("button", { type: "button", class: "scn-btn " + cls, title: label });
    if (ic) b.append(icon(ic));
    if (label) b.append(el("span", {}, label));
    b.addEventListener("click", e => { e.stopPropagation(); fn(e); });
    return b;
  };
  const busy = (text) => {
    const b = el("div", { class: "scn-busy" }, el("div", { class: "spinner" }), el("div", { class: "scn-busy-t" }, text), el("div", { class: "progress" }, el("span")));
    root.append(b);
    return { set(p, t) { if (t) b.querySelector(".scn-busy-t").textContent = t; b.querySelector(".progress > span").style.width = Math.round((p || 0) * 100) + "%"; }, done() { b.remove(); } };
  };
  const show = (name, node) => { screen = name; root.querySelector(".scn-screen")?.remove(); node.classList.add("scn-screen"); root.prepend(node); };

  function close(force = false) {
    if (!force && pages.length && !confirm(tr("scanner.chiudere_scansione_pagine_non_salvate"))) return true;
    closed = true;
    stopCamera();
    root.remove();
    document.documentElement.classList.remove("scn-open");
    if (window.MBV_BACK === back) window.MBV_BACK = null;
    return true;
  }
  // tasto indietro del telefono: torna alla schermata precedente
  function back() {
    if (root.querySelector(".scn-busy")) return true;
    if (screen === "camera") return pages.length ? (showPages(), true) : close();
    if (screen === "crop" || screen === "filter") return (pages.length ? showPages() : showCamera()), true;
    if (screen === "result") return showPages(), true;
    return close();
  }
  window.MBV_BACK = back;

  // ------------------------------------------------ fotocamera
  function stopCamera() { stream?.getTracks().forEach(t => t.stop()); stream = null; }
  async function startCamera(video) {
    if (stream) { video.srcObject = stream; await video.play().catch(() => {}); return; }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(tr("scanner.questo_browser_non_accesso_fotocamera"));
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
    video.srcObject = stream;
    await video.play().catch(() => {});
  }

  let auto = true;
  try { auto = localStorage.getItem("mbv-scan-auto") !== "0"; } catch { /* */ }

  async function showCamera() {
    const video = el("video", { playsinline: "", muted: "", autoplay: "" });
    video.muted = true; video.playsInline = true;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "scn-live");
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    svg.append(poly);
    const hint = el("div", { class: "scn-hint" }, tr("scanner.avvio_fotocamera"));
    const count = el("span", { class: "scn-count" });
    const thumbBtn = el("button", { type: "button", class: "scn-thumb", title: tr("scanner.pagine_acquisite"), onclick: () => pages.length && showPages() }, count);
    const flash = el("div", { class: "scn-flash" });
    const autoBtn = btn(tr("scanner.auto"), () => { auto = !auto; autoBtn.classList.toggle("on", auto); try { localStorage.setItem("mbv-scan-auto", auto ? "1" : "0"); } catch { /* */ } stable = 0; }, "chip" + (auto ? " on" : ""));
    autoBtn.title = tr("scanner.scatto_automatico_quando_foglio_fermo");
    let torch = false;
    const torchBtn = btn("", async () => {
      torch = !torch;
      try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch }] }); torchBtn.classList.toggle("on", torch); } catch { toast(tr("scanner.torcia_non_disponibile"), true); }
    }, "round", "M9 2h6l-1 7h3l-7 13 1-9H7z");
    torchBtn.title = tr("scanner.torcia");
    torchBtn.hidden = true;
    const fileInp = el("input", { type: "file", accept: "image/*", multiple: "", hidden: "" });
    fileInp.addEventListener("change", () => { const fs = [...fileInp.files]; fileInp.value = ""; importFiles(fs); });
    const shutter = el("button", { type: "button", class: "scn-shutter", title: tr("scanner.scatta"), onclick: () => capture(false) });
    const node = el("div", { class: "scn-camera" },
      el("div", { class: "scn-view" }, video, svg, flash),
      el("div", { class: "scn-top" }, btn("", () => back(), "round", "M6 6l12 12M18 6L6 18"), el("span", { class: "grow" }), autoBtn, torchBtn),
      hint,
      el("div", { class: "scn-bottom" },
        btn(tr("scanner.importa"), () => fileInp.click(), "side", "M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M15 9h.01"),
        shutter, thumbBtn, fileInp));
    show("camera", node);
    const updCount = () => {
      count.textContent = pages.length || "";
      thumbBtn.style.backgroundImage = pages.length ? `url(${pages[pages.length - 1].thumb})` : "";
      thumbBtn.classList.toggle("has", pages.length > 0);
    };
    updCount();

    try { await startCamera(video); } catch (e) {
      hint.textContent = (e.name === "NotAllowedError" ? tr("scanner.accesso_fotocamera_negato_consentilo_nelle") : tr("scanner.fotocamera_non_disponibile") + e.message) + tr("scanner.puoi_importare_foto_gia_scattate");
      shutter.disabled = true;
      return;
    }
    try { torchBtn.hidden = !stream.getVideoTracks()[0].getCapabilities?.().torch; } catch { /* */ }
    hint.textContent = tr("scanner.inquadra_foglio_piano_colore_diverso");
    await cvReady.catch(() => {});

    // rilevamento in tempo reale su una copia piccola del fotogramma (circa 7 volte al secondo)
    let quad = null, prev = null, stable = 0, waitChange = false, lastRun = 0, capturing = false;
    const small = canvasOf(1, 1), sg = small.getContext("2d", { willReadFrequently: true });
    const toView = q => {
      const vw = video.videoWidth, vh = video.videoHeight, r = video.getBoundingClientRect();
      const k = Math.min(r.width / vw, r.height / vh), ox = (r.width - vw * k) / 2, oy = (r.height - vh * k) / 2;
      svg.setAttribute("viewBox", `0 0 ${r.width} ${r.height}`);
      return q.map(p => `${ox + p[0] * k},${oy + p[1] * k}`).join(" ");
    };
    const loop = t => {
      if (closed || screen !== "camera" || !node.isConnected) return;
      requestAnimationFrame(loop);
      if (!cv || !video.videoWidth || t - lastRun < 140 || capturing) return;
      lastRun = t;
      const vw = video.videoWidth, vh = video.videoHeight, k = Math.min(1, 480 / Math.max(vw, vh));
      if (small.width !== Math.round(vw * k)) { small.width = Math.round(vw * k); small.height = Math.round(vh * k); }
      sg.drawImage(video, 0, 0, small.width, small.height);
      let q = null;
      try { q = detectQuad(cv, small); } catch { /* fotogramma non valido */ }
      q = q && q.map(p => [p[0] / k, p[1] / k]);
      const diag = Math.hypot(vw, vh);
      if (q && quad) q = q.map((p, i) => [quad[i][0] * 0.4 + p[0] * 0.6, quad[i][1] * 0.4 + p[1] * 0.6]); // movimento piu' morbido
      const moved = q && prev ? Math.max(...q.map((p, i) => dist(p, prev[i]))) / diag : 1;
      if (waitChange && (!q || moved > 0.08)) waitChange = false;
      stable = q && moved < 0.012 ? stable + 1 : 0;
      prev = q || prev;
      quad = q;
      poly.setAttribute("points", q ? toView(q) : "");
      svg.classList.toggle("ok", !!q && stable >= 3);
      if (!q) hint.textContent = tr("scanner.inquadra_foglio_piano_colore_diverso");
      else if (auto && !waitChange) hint.textContent = stable >= 3 ? tr("scanner.tieni_fermo") : tr("scanner.foglio_trovato");
      else hint.textContent = waitChange ? tr("scanner.pagina_acquisita_inquadra_successiva") : tr("scanner.foglio_trovato_scatta");
      if (auto && !waitChange && stable >= 8) { waitChange = true; stable = 0; capture(true); }
    };
    requestAnimationFrame(loop);

    async function capture(isAuto) {
      if (!video.videoWidth || capturing) return;
      capturing = true;
      try {
        const [c, k] = scaled(video, MAX_SRC);
        flash.classList.remove("go"); void flash.offsetWidth; flash.classList.add("go");
        const blob = await toBlob(c, "image/jpeg", 0.92);
        // bordi ricalcolati sulla foto (piu' precisi del fotogramma piccolo)
        let q = null;
        if (cv) {
          const [d, kd] = scaled(c, 800);
          q = detectQuad(cv, d);
          q = q && q.map(p => [p[0] / kd, p[1] / kd]);
        }
        if (!q && quad) q = quad.map(p => [p[0] * k, p[1] * k]);
        const page = new Page(blob, c.width, c.height, q || fullQuad(c.width, c.height));
        if (isAuto && cv) {
          await page.process(cv);
          pages.push(page);
          updCount();
          if (navigator.vibrate) navigator.vibrate(40);
        } else showCrop(page, true, c);
      } catch (e) { toast(tr("scanner.scatto_non_riuscito") + e.message, true); }
      finally { capturing = false; }
    }
  }

  async function importFiles(files) {
    if (!files.length) return;
    const b = busy(tr("scanner.lettura_foto"));
    try {
      const c0 = await cvReady;
      const added = [];
      for (let i = 0; i < files.length; i++) {
        b.set(i / files.length, tr("scanner.foto_0_1", i + 1, files.length));
        const c = await blobToCanvas(files[i], MAX_SRC);
        const [d, kd] = scaled(c, 800);
        let q = detectQuad(c0, d);
        q = q ? q.map(p => [p[0] / kd, p[1] / kd]) : fullQuad(c.width, c.height);
        const page = new Page(await toBlob(c, "image/jpeg", 0.92), c.width, c.height, q);
        if (files.length === 1) { b.done(); return showCrop(page, true, c); }
        await page.process(c0);
        added.push(page);
      }
      pages.push(...added);
      b.done();
      showPages();
    } catch (e) { b.done(); toast(tr("scanner.importazione_non_riuscita") + e.message, true, 6000); }
  }

  // ------------------------------------------------ ritaglio con i 4 angoli (lente d'ingrandimento durante il trascinamento)
  async function showCrop(page, isNew, srcCanvas = null) {
    stopCamera();
    const src = srcCanvas || await blobToCanvas(page.src);
    const [view] = scaled(src, 1400);
    const kv = view.width / src.width;
    const box = el("div", { class: "scn-cropbox" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${view.width} ${view.height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    const shade = document.createElementNS("http://www.w3.org/2000/svg", "path");
    shade.setAttribute("class", "shade"); shade.setAttribute("fill-rule", "evenodd");
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    svg.append(shade, poly);
    view.className = "scn-cropimg";
    const handles = [0, 1, 2, 3].map(() => el("div", { class: "scn-handle" }));
    const loupe = canvasOf(140, 140); loupe.className = "scn-loupe"; loupe.hidden = true;
    const stage = el("div", { class: "scn-cropstage" }, view, svg, ...handles, loupe);
    box.append(stage);
    let q = page.quad.map(p => [p[0] * kv, p[1] * kv]);
    const draw = () => {
      poly.setAttribute("points", q.map(p => p.join(",")).join(" "));
      shade.setAttribute("d", `M0 0H${view.width}V${view.height}H0Z M${q.map(p => p.join(" ")).join(" L")}Z`);
      const r = stage.getBoundingClientRect(), k = r.width / view.width;
      handles.forEach((h, i) => { h.style.left = q[i][0] * k + "px"; h.style.top = q[i][1] * k + "px"; });
      const ok = convex(q);
      poly.classList.toggle("bad", !ok);
      nextBtn.disabled = !ok;
    };
    const fitStage = () => {
      const r = box.getBoundingClientRect();
      const k = Math.min((r.width - 24) / view.width, (r.height - 24) / view.height);
      stage.style.width = view.width * k + "px"; stage.style.height = view.height * k + "px";
      draw();
    };
    handles.forEach((h, i) => {
      h.addEventListener("pointerdown", e => {
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        const r = stage.getBoundingClientRect(), k = r.width / view.width;
        const start = [e.clientX, e.clientY], q0 = [...q[i]];
        const lg = loupe.getContext("2d");
        const move = ev => {
          q[i] = [Math.min(view.width, Math.max(0, q0[0] + (ev.clientX - start[0]) / k)), Math.min(view.height, Math.max(0, q0[1] + (ev.clientY - start[1]) / k))];
          draw();
          // lente: zona attorno all'angolo ingrandita, sopra il dito
          loupe.hidden = false;
          const z = 2.5 * k, sz = 140 / z;
          lg.fillStyle = "#000"; lg.fillRect(0, 0, 140, 140);
          lg.drawImage(src, (q[i][0] - sz / 2) / kv, (q[i][1] - sz / 2) / kv, sz / kv, sz / kv, 0, 0, 140, 140);
          lg.strokeStyle = "#2c9bf0"; lg.lineWidth = 1.5;
          lg.beginPath(); lg.moveTo(70, 0); lg.lineTo(70, 140); lg.moveTo(0, 70); lg.lineTo(140, 70); lg.stroke();
          loupe.style.left = Math.min(r.width - 150, Math.max(0, q[i][0] * k - 70)) + "px";
          loupe.style.top = Math.max(-60, q[i][1] * k - 190) + "px";
        };
        const up = () => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); h.removeEventListener("pointercancel", up); loupe.hidden = true; };
        h.addEventListener("pointermove", move); h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
      });
    });
    const nextBtn = btn(tr("common.avanti"), async () => {
      page.quad = q.map(p => [p[0] / kv, p[1] / kv]);
      const b = busy(tr("scanner.raddrizzamento_foglio"));
      try { const c = await cvReady; await page.process(c); } catch (e) { b.done(); return toast(tr("scanner.elaborazione_non_riuscita") + e.message, true, 6000); }
      b.done();
      showFilter(page, isNew);
    }, "primary", "M5 12h14M13 6l6 6-6 6");
    const node = el("div", { class: "scn-crop" },
      el("div", { class: "scn-top dark" }, btn(isNew ? tr("scanner.riprova") : tr("common.annulla"), () => (isNew ? showCamera() : showPages()), "", "M4 12a8 8 0 1 0 3-6.2M4 4v5h5"),
        el("span", { class: "scn-title" }, tr("scanner.regola_angoli")), el("span", { class: "grow" })),
      box,
      el("div", { class: "scn-bar" },
        btn(tr("scanner.rileva"), async () => {
          const c = await cvReady; const [d, kd] = scaled(src, 800); const r = detectQuad(c, d);
          if (r) { q = r.map(p => [p[0] / kd * kv, p[1] / kd * kv]); draw(); } else toast(tr("scanner.bordi_foglio_non_trovati_regola"));
        }, "", "M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5"),
        btn(tr("scanner.tutta"), () => { q = [[0, 0], [view.width, 0], [view.width, view.height], [0, view.height]]; draw(); }, "", "M4 4h16v16H4z"),
        el("span", { class: "grow" }), nextBtn));
    show("crop", node);
    requestAnimationFrame(fitStage);
    const ro = new ResizeObserver(fitStage); ro.observe(box);
  }

  // ------------------------------------------------ filtri della pagina
  async function showFilter(page, isNew) {
    const img = el("img", { class: "scn-preview", alt: "" });
    let url = null;
    const refresh = async () => {
      const blob = await page.final();
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      img.src = url;
    };
    const chips = el("div", { class: "scn-chips" });
    const drawChips = () => {
      chips.innerHTML = "";
      for (const [id, label] of FILTERS) chips.append(btn(label, async () => {
        if (page.filter === id) return;
        page.filter = id;
        const b = busy(tr("scanner.applicazione_filtro"));
        try { await page.process(await cvReady); await refresh(); } finally { b.done(); }
        drawChips();
      }, "chip" + (page.filter === id ? " on" : "")));
    };
    drawChips();
    const keep = () => { if (isNew && !pages.includes(page)) pages.push(page); };
    const node = el("div", { class: "scn-filter" },
      el("div", { class: "scn-top dark" },
        btn(tr("scanner.ritaglia"), () => showCrop(page, isNew), "", "M6 2v16h16M2 6h16v16"),
        btn(tr("scanner.ruota"), async () => { page.rot = (page.rot + 90) % 360; await page.makeThumb(); await refresh(); }, "", "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"),
        el("span", { class: "grow" }),
        isNew ? btn(tr("scanner.scarta"), () => (pages.length ? showPages() : showCamera()), "", "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13") : el("span")),
      el("div", { class: "scn-previewbox" }, img),
      chips,
      el("div", { class: "scn-bar" },
        isNew ? btn(tr("scanner.altra_pagina"), () => { keep(); showCamera(); }, "", "M12 5v14M5 12h14") : el("span"),
        el("span", { class: "grow" }),
        btn(isNew ? tr("scanner.fine") : "OK", () => { keep(); showPages(); }, "primary", "M5 12l5 5L20 7")));
    show("filter", node);
    await refresh();
  }

  // ------------------------------------------------ elenco delle pagine
  function showPages() {
    stopCamera();
    if (!pages.length) return showCamera();
    const grid = el("div", { class: "scn-grid" });
    const render = () => {
      grid.innerHTML = "";
      title.textContent = tn("scanner.n_pagine", pages.length);
      pages.forEach((p, i) => {
        const card = el("div", { class: "scn-card" },
          el("img", { src: p.thumb, alt: tr("scanner.pagina_0_2", i + 1), onclick: () => showFilter(p, false) }),
          el("span", { class: "scn-num" }, String(i + 1)),
          el("div", { class: "scn-tools" },
            btn("", () => { if (i > 0) { [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]]; render(); } }, "mini", "M15 6l-6 6 6 6"),
            btn("", async () => { p.rot = (p.rot + 90) % 360; await p.makeThumb(); render(); }, "mini", "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"),
            btn("", () => { pages.splice(i, 1); pages.length ? render() : showCamera(); }, "mini danger", "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"),
            btn("", () => { if (i < pages.length - 1) { [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]]; render(); } }, "mini", "M9 6l6 6-6 6")));
        card.querySelectorAll(".scn-tools button")[0].title = tr("scanner.sposta_prima");
        card.querySelectorAll(".scn-tools button")[1].title = tr("scanner.ruota");
        card.querySelectorAll(".scn-tools button")[2].title = tr("scanner.elimina_pagina");
        card.querySelectorAll(".scn-tools button")[3].title = tr("scanner.sposta_dopo");
        dragSort(card, i);
        grid.append(card);
      });
    };
    // trascinamento per riordinare (tieni premuto mezzo secondo sulla miniatura, poi sposta)
    function dragSort(card, i) {
      const img = card.querySelector("img");
      img.addEventListener("pointerdown", e => {
        const sx = e.clientX, sy = e.clientY;
        let dragging = false, target = i;
        const timer = setTimeout(() => { dragging = true; card.classList.add("drag"); img.setPointerCapture(e.pointerId); navigator.vibrate?.(20); }, 450);
        const move = ev => {
          if (!dragging) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) clearTimeout(timer); return; }
          ev.preventDefault();
          card.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px)`;
          const cards = [...grid.children];
          target = i;
          cards.forEach((c, j) => { const r = c.getBoundingClientRect(); if (c !== card && ev.clientX > r.left && ev.clientX < r.right && ev.clientY > r.top && ev.clientY < r.bottom) target = j; c.classList.toggle("over", c !== card && j === target); });
        };
        const up = () => {
          clearTimeout(timer);
          img.removeEventListener("pointermove", move); img.removeEventListener("pointerup", up); img.removeEventListener("pointercancel", up);
          if (!dragging) return;
          img.addEventListener("click", ev => ev.stopImmediatePropagation(), { capture: true, once: true });
          const [p] = pages.splice(i, 1);
          pages.splice(target, 0, p);
          render();
        };
        img.addEventListener("pointermove", move); img.addEventListener("pointerup", up); img.addEventListener("pointercancel", up);
      });
    }
    const title = el("span", { class: "scn-title" });
    const node = el("div", { class: "scn-pages" },
      el("div", { class: "scn-top dark" }, btn("", () => back(), "round", "M6 6l12 12M18 6L6 18"), title, el("span", { class: "grow" })),
      el("p", { class: "scn-note" }, tr("scanner.tocca_pagina_cambiarne_filtro_ritaglio")),
      grid,
      el("div", { class: "scn-bar" },
        btn(tr("common.aggiungi"), () => showCamera(), "", "M12 5v14M5 12h14"),
        el("span", { class: "grow" }),
        btn(tr("scanner.crea_pdf"), () => askPdf(), "primary", "M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6")));
    show("pages", node);
    render();
  }

  // ------------------------------------------------ creazione del PDF
  function askPdf() {
    let ocr = true, size = "a4";
    try { ocr = localStorage.getItem("mbv-scan-ocr") !== "0"; size = localStorage.getItem("mbv-scan-size") || "a4"; } catch { /* */ }
    const name = el("input", { type: "text", value: `Scansione ${stamp()}` });
    const sizeSel = el("select", {}, ...Object.entries(SIZES).map(([k, v]) => el("option", { value: k, selected: k === size }, v[2])));
    const ocrBox = el("input", { type: "checkbox", checked: ocr });
    const sheet = el("div", { class: "scn-sheet" },
      el("h3", {}, tr("scanner.crea_pdf_2")),
      el("label", {}, tr("scanner.nome_file"), name),
      el("label", {}, tr("scanner.formato_pagina"), sizeSel),
      el("label", { class: "chk" }, ocrBox, el("span", {}, tr("scanner.testo_ricercabile_copiabile_ocr_italiano"))),
      el("div", { class: "scn-bar" },
        btn(tr("common.annulla"), () => sheetBack.remove()),
        el("span", { class: "grow" }),
        btn(tr("scanner.crea"), async () => {
          try { localStorage.setItem("mbv-scan-ocr", ocrBox.checked ? "1" : "0"); localStorage.setItem("mbv-scan-size", sizeSel.value); } catch { /* */ }
          sheetBack.remove();
          const fname = (name.value.trim() || tr("scanner.scansione_0", stamp())).replace(/[\\/:*?"<>|]+/g, "-").replace(/\.pdf$/i, "") + ".pdf";
          const b = busy(tr("scanner.creazione_pdf"));
          try {
            const r = await buildPdf(pages, { size: sizeSel.value, ocr: ocrBox.checked, title: fname.replace(/\.pdf$/i, "") }, (p, t) => b.set(p, t));
            b.done();
            showResult(new File([r.pdf], fname, { type: "application/pdf" }), r.text, ocrBox.checked);
          } catch (e) { b.done(); toast(tr("scanner.pdf_non_creato") + e.message, true, 8000); }
        }, "primary")));
    const sheetBack = el("div", { class: "scn-sheetback" }, sheet);
    root.append(sheetBack);
  }

  function showResult(file, text, ocr) {
    const size = file.size > 1048576 ? (file.size / 1048576).toLocaleString(LOCALE, { maximumFractionDigits: 1 }) + " MB" : Math.round(file.size / 1024) + " KB";
    const canShare = !!navigator.canShare?.({ files: [file] });
    const save = () => {
      const a = el("a", { href: URL.createObjectURL(file), download: file.name });
      document.body.append(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    };
    const node = el("div", { class: "scn-result" },
      el("div", { class: "scn-top dark" }, btn(tr("scanner.pagine"), () => showPages(), "", "M15 6l-6 6 6 6"), el("span", { class: "grow" })),
      el("div", { class: "scn-done" },
        el("img", { src: pages[0].thumb, alt: "" }),
        el("h3", {}, file.name),
        el("p", {}, `${tn("scanner.n_pagine", pages.length)} · ${size}` + (ocr ? tr("scanner.testo_riconosciuto_0_parole", text.split(/\s+/).filter(Boolean).length.toLocaleString(LOCALE)) : "")),
        el("div", { class: "scn-actions" },
          canShare ? btn(tr("scanner.condividi"), async () => { try { await navigator.share({ files: [file], title: file.name }); } catch (e) { if (e.name !== "AbortError") toast(tr("scanner.condivisione_non_riuscita") + e.message, true); } }, "primary", "M4 12v8h16v-8M12 3v13M7 8l5-5 5 5") : el("span"),
          btn(tr("scanner.salva_dispositivo"), save, canShare ? "" : "primary", "M12 3v12M7 10l5 5 5-5M4 21h16"),
          openPdf ? btn(tr("scanner.apri_mb_visual"), () => { close(true); openPdf(file); }, "", "M3 7h6l2 2h10v10H3z") : el("span"),
          ocr && text.trim() ? btn(tr("scanner.copia_testo"), async () => { try { await navigator.clipboard.writeText(text); toast(tr("scanner.testo_copiato")); } catch { toast(tr("scanner.copia_non_riuscita"), true); } }, "", "M8 8h12v12H8zM4 16V4h12") : el("span"),
          btn(tr("scanner.nuova_scansione"), () => { pages.length = 0; showCamera(); }, "", "M12 5v14M5 12h14"),
          btn(tr("common.chiudi"), () => close(true), "", "M6 6l12 12M18 6L6 18"))));
    show("result", node);
  }

  // per le prove dalla console: MB_SCAN.pages, MB_SCAN.importFiles([...])
  window.MB_SCAN = { pages, importFiles, showPages, get screen() { return screen; } };
  showCamera();
}
