// Modalita' miniatura: la usa la finestra nascosta di MB Desk che prepara miniature e anteprime per Esplora risorse
// (mbvisual/miniature.py). Apre il file con il visualizzatore normale, aspetta che il disegno sia stabile e salva un PNG
// del canvas principale; poi chiude la scheda. Non modifica nulla dell'interfaccia.
import { api } from "./core.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

function biggestCanvas(root) {
  let best = null, area = 0;
  for (const c of root.querySelectorAll("canvas")) {
    const r = c.getBoundingClientRect(), a = r.width * r.height;
    if (c.width > 8 && c.height > 8 && a > area) { best = c; area = a; }
  }
  return best;
}

// immagine quadrata (lato = size) con il contenuto del canvas ridotto e centrato
function square(c, size) {
  // ritaglio sul contenuto: tutto cio' che differisce dal colore dello sfondo (angolo in alto a sinistra), con un margine
  let [x0, y0, w, h] = [0, 0, c.width, c.height];
  try {
    const tmp = document.createElement("canvas");
    tmp.width = c.width; tmp.height = c.height;
    const tg = tmp.getContext("2d", { willReadFrequently: true });
    tg.drawImage(c, 0, 0);
    const d = tg.getImageData(0, 0, c.width, c.height).data, W = c.width;
    const [r0, g0, b0] = [d[0], d[1], d[2]];
    let minX = W, minY = c.height, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) > 30) {
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (maxX > minX && maxY > minY) {
      const m = Math.round(Math.max(maxX - minX, maxY - minY) * 0.04);
      x0 = Math.max(0, minX - m); y0 = Math.max(0, minY - m);
      w = Math.min(W, maxX + m + 1) - x0; h = Math.min(c.height, maxY + m + 1) - y0;
    }
  } catch { /* canvas non leggibile: intero */ }
  const out = document.createElement("canvas");
  const k = Math.min(size / w, size / h);
  out.width = Math.max(1, Math.round(w * k));
  out.height = Math.max(1, Math.round(h * k));
  const g = out.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(c, x0, y0, w, h, 0, 0, out.width, out.height);
  return out;
}

// modelli 3D: disegno dedicato su sfondo trasparente, vista assonometrica che riempie il riquadro
function render3d(three, size) {
  const { THREE, scene, model } = three;
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: true });
  try {
    r.setPixelRatio(1);
    r.setSize(size, size, false);
    r.setClearColor(0x000000, 0);
    const box = new THREE.Box3();
    model.traverseVisible(o => { if (o.isMesh || o.isLine || o.isPoints) box.expandByObject(o); });
    if (box.isEmpty()) box.setFromObject(model);
    if (box.isEmpty()) return null;
    const s = box.getBoundingSphere(new THREE.Sphere());
    const cam = new THREE.PerspectiveCamera(30, 1, s.radius / 500, s.radius * 50);
    cam.position.copy(s.center).addScaledVector(new THREE.Vector3(1, 0.75, 1).normalize(), s.radius / Math.sin(Math.PI / 12) * 0.98);
    cam.lookAt(s.center);
    const bg = scene.background;
    scene.background = null;
    r.render(scene, cam);
    scene.background = bg;
    const out = document.createElement("canvas");
    out.width = out.height = size;
    out.getContext("2d").drawImage(r.domElement, 0, 0);
    return out;
  } finally {
    r.dispose();
    r.forceContextLoss?.();
  }
}

function closeTab(tab) {
  try { tab.api?.dispose?.(); } catch { /* */ }
  tab.view?.remove();
  const i = window.MB.tabs.indexOf(tab);
  if (i >= 0) window.MB.tabs.splice(i, 1);
}

export async function capture(path, out, size = 512, timeout = 40000) {
  const t0 = Date.now();
  const before = new Set(window.MB.tabs);
  let settled = false;
  const opening = window.MB.openFile(path, null, { fresh: true, miniatura: true }).finally(() => { settled = true; });
  let tab = null;
  while (!tab && !settled && Date.now() - t0 < timeout) {
    tab = window.MB.tabs.find(t => !before.has(t));
    if (!tab) await sleep(50);
  }
  tab ||= window.MB.tabs.find(t => !before.has(t));
  if (!tab) throw new Error("scheda non aperta (file non leggibile)");
  try {
    await Promise.race([opening, sleep(timeout)]);
    if (!tab.api) throw new Error("visualizzatore non pronto: " + (tab.view?.innerText || "").slice(0, 300));
    // il disegno e' "stabile" quando due catture di seguito sono uguali
    let last = "", data = "";
    if (tab.three?.model) {
      await sleep(300);
      data = render3d(tab.three, size)?.toDataURL("image/png") || "";
    }
    while (!data && Date.now() - t0 < timeout) {
      await sleep(400);
      const c = biggestCanvas(tab.view);
      if (!c) continue;
      data = square(c, size).toDataURL("image/png");
      if (data.length > 2000 && data === last) break;
      last = data;
      data = "";
    }
    data ||= last;
    if (!data) throw new Error("niente da disegnare");
    const bin = Uint8Array.from(atob(data.split(",")[1]), ch => ch.charCodeAt(0));
    await api("save", { path: out }, { body: bin });
    return { ok: true, ms: Date.now() - t0 };
  } finally {
    closeTab(tab);
  }
}

window.MBThumb = { capture };
