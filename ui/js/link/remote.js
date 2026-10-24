// Telecomando dal telefono (lato PC): i gesti arrivano dal collegamento (linkpc.js) e diventano eventi sul documento attivo.
// Funziona con qualsiasi visualizzatore senza toccarlo: trascinamenti = eventi puntatore/mouse sull'area di disegno
// (canvas piu' grande della scheda), zoom = rotella, pagine = tasti PagGiu'/PagSu'; i PDF passano da pdf.js (iframe).
// Anteprima per il telefono: immagine JPEG dell'area di disegno (o della pagina del PDF) ridotta.

const MB = () => window.MB;
const visible = e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 40 && e.getClientRects().length ? r : null; };

function pdfApp(tab) {
  const fr = [...(tab?.view?.querySelectorAll("iframe") || [])].find(f => visible(f));
  try { return fr?.contentWindow?.PDFViewerApplication || null; } catch { return null; }
}
// area di disegno: il canvas (o l'elemento) visibile piu' grande della scheda attiva
function target(tab) {
  if (!tab?.view) return null;
  let best = null, area = 0;
  for (const c of tab.view.querySelectorAll("canvas, svg, .viewer, img")) {
    const r = visible(c);
    if (r && r.width * r.height > area) { area = r.width * r.height; best = c; }
  }
  return best;
}
function kind(tab) {
  if (!tab) return "none";
  if (pdfApp(tab)) return "pdf";
  if (tab.three) return "3d";
  return target(tab) ? "2d" : "other";
}

export function state() {
  const tabs = (MB()?.tabs || []).filter(t => !t.path.startsWith("mail://"));
  const a = MB()?.active;
  const st = { tabs: tabs.map((t, i) => ({ i, name: t.name, active: t === a })), name: a?.name || "", kind: kind(a) };
  const app = pdfApp(a);
  if (app) { st.page = app.page; st.pages = app.pagesCount; }
  return st;
}

// trascinamento in corso: punto virtuale che parte dal centro dell'area di disegno
let drag = null;
function fire(el, type, x, y, button, extra = {}) {
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button, buttons: type.endsWith("up") ? 0 : button === 2 ? 2 : button === 1 ? 4 : 1, view: window, ...extra };
  if (type.startsWith("pointer")) el.dispatchEvent(new PointerEvent(type, { ...base, pointerId: 77, pointerType: "mouse", isPrimary: true }));
  else el.dispatchEvent(new MouseEvent(type, base));
}
// le librerie (es. OrbitControls) catturano il puntatore: con un puntatore simulato il browser darebbe errore
function safeCapture(el) {
  const s = el.setPointerCapture, r = el.releasePointerCapture;
  el.setPointerCapture = id => { try { s.call(el, id); } catch { /* puntatore simulato */ } };
  el.releasePointerCapture = id => { try { r.call(el, id); } catch { /* */ } };
}

export function apply(h) {
  const tabs = (MB()?.tabs || []).filter(t => !t.path.startsWith("mail://"));
  const a = MB()?.active;
  if (h.a === "tab") { const t = tabs[h.i]; if (t) MB().activate(t); return; }
  const app = pdfApp(a);
  if (h.a === "page") {
    if (app) { app.page = Math.max(1, Math.min(app.pagesCount, app.page + (h.d > 0 ? 1 : -1))); return; }
    const el = target(a) || document.body;
    const key = h.d > 0 ? "PageDown" : "PageUp";
    for (const tp of ["keydown", "keyup"]) el.dispatchEvent(new KeyboardEvent(tp, { key, code: key, bubbles: true }));
    return;
  }
  if (h.a === "zoom") {
    if (app) { app.pdfViewer.currentScale = Math.max(0.1, Math.min(10, app.pdfViewer.currentScale * h.f)); return; }
    const el = target(a);
    if (!el) return;
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    // passi di rotella: un pizzico ampio = piu' passi (come la rotella del mouse)
    const steps = Math.max(1, Math.min(8, Math.round(Math.abs(Math.log(h.f)) / 0.08)));
    for (let i = 0; i < steps; i++) el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: h.f > 1 ? -100 : 100, deltaMode: 0 }));
    return;
  }
  if (h.a === "fit") {
    if (app) { app.pdfViewer.currentScaleValue = "page-fit"; return; }
    const b = [...(a?.view?.querySelectorAll("button") || [])].find(x => visible(x) && /adatt|fit|estensioni|inquadra|zoom.*(tutto|esteso)/i.test((x.title || "") + " " + x.textContent));
    if (b) b.click(); else fire(target(a) || document.body, "dblclick", innerWidth / 2, innerHeight / 2, 1);
    return;
  }
  if (h.a === "drag") {
    if (app) { // PDF: il trascinamento scorre la pagina
      const c = app.pdfViewer.container;
      if (h.phase === "move") { c.scrollLeft -= h.dx * 2; c.scrollTop -= h.dy * 2; }
      return;
    }
    const el = target(a);
    if (!el) return;
    const btn = h.btn === "pan" ? (a.three ? 2 : 1) : 0; // 3D: destro = sposta (OrbitControls), 2D: centrale = sposta
    if (h.phase === "start") {
      const r = el.getBoundingClientRect();
      safeCapture(el);
      drag = { el, x: r.left + r.width / 2, y: r.top + r.height / 2, btn };
      fire(el, "pointerdown", drag.x, drag.y, btn); fire(el, "mousedown", drag.x, drag.y, btn);
    } else if (drag && h.phase === "move") {
      drag.x += h.dx * 1.6; drag.y += h.dy * 1.6;
      fire(drag.el, "pointermove", drag.x, drag.y, drag.btn); fire(drag.el, "mousemove", drag.x, drag.y, drag.btn);
      fire(window, "mousemove", drag.x, drag.y, drag.btn);
    } else if (drag && h.phase === "end") {
      fire(drag.el, "pointerup", drag.x, drag.y, drag.btn); fire(drag.el, "mouseup", drag.x, drag.y, drag.btn);
      fire(window, "mouseup", drag.x, drag.y, drag.btn);
      drag = null;
    }
  }
}

// ---------------------------------------------------------------- anteprima per il telefono
async function jpeg(src, w, h) {
  const k = Math.min(1, 900 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.72));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}
export async function snapshot() {
  const a = MB()?.active;
  const app = pdfApp(a);
  try {
    if (app) {
      const pv = app.pdfViewer.getPageView(app.page - 1);
      const c = pv?.canvas || pv?.div?.querySelector("canvas");
      if (c) return { h: { w: c.width, h: c.height }, data: await jpeg(c, c.width, c.height) };
      return { h: {} };
    }
    if (a?.three?.renderer) { // 3D: si ridisegna e si legge subito (il buffer di WebGL non resta dopo il fotogramma)
      const { renderer, scene, camera } = a.three;
      if (scene && camera) renderer.render(scene, camera);
      const c = renderer.domElement;
      return { h: { w: c.width, h: c.height }, data: await jpeg(c, c.width, c.height) };
    }
    const el = target(a);
    if (el instanceof HTMLCanvasElement) return { h: { w: el.width, h: el.height }, data: await jpeg(el, el.width, el.height) };
    if (el instanceof HTMLImageElement && el.complete) return { h: { w: el.naturalWidth, h: el.naturalHeight }, data: await jpeg(el, el.naturalWidth, el.naturalHeight) };
  } catch { /* canvas non leggibile */ }
  return { h: {} };
}
