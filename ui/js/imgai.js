// Miglioramento foto (Real-ESRGAN) e creazione di immagini da una descrizione (Stable Diffusion) per l'editor di immagini
// (imgedit.js). Il lavoro lo fa il motore dell'app per PC (mbvisual/immagini.py, API immagini/*): qui il controllo della scheda
// video con la domanda "Procedo lo stesso?", la finestrella di avanzamento con Annulla e la lettura del risultato.
import { t as tr } from "./i18n.js";
import { api, el, waitJob, fileUrl, WEB } from "./core.js";

export const AI_OK = !WEB;

// true = si parte. kind: "migliora" | "genera"; ask(testo) = finestra Procedi/Annulla dell'editor
export async function aiCheck(kind, ask) {
  const sv = await api("immagini/scheda-video");
  if (kind === "genera" ? sv.idonea_genera : sv.idonea_migliora) return true;
  return !!(await ask(tr("imgai.non_idonea"), sv));
}

function progressBox(root, title) {
  const bar = el("div", { class: "imgai-bar" }), msg = el("div", { class: "ps-note imgai-msg" }, tr("imgai.avvio"));
  let onCancel = null;
  const stop = el("button", { class: "btn", type: "button", onclick: () => { stop.disabled = true; msg.textContent = tr("imgai.annullo"); onCancel?.(); } }, tr("common.annulla"));
  const box = el("div", { class: "ps-dlg imgai-dlg", role: "dialog" }, el("div", { class: "ps-dlg-h" }, title),
    el("div", { class: "ps-dlg-b" }, el("div", { class: "imgai-track" }, bar), msg),
    el("div", { class: "ps-dlg-f" }, el("span", { class: "grow" }), stop));
  root.append(box);
  const t0 = Date.now();
  return {
    set(p, m) {
      bar.style.width = Math.round((p || 0) * 100) + "%";
      const s = Math.round((Date.now() - t0) / 1000);
      if (m && !stop.disabled) msg.textContent = `${m} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    },
    set cancel(fn) { onCancel = fn; },
    close: () => box.remove(),
  };
}

// lavoro con avanzamento; restituisce il risultato del motore ({ out, larghezza, altezza, secondi... })
export async function aiJob(root, title, route, params, body) {
  const rid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const box = progressBox(root, title);
  let cancelled = false;
  box.cancel = () => { cancelled = true; api("immagini/annulla", { rid }, { allowFail: true }); };
  try {
    const q = { ...params, rid, anche_lenta: 1 };
    const r = body !== undefined ? await api(route, q, { body }) : await api(route, {}, { json: q });
    return await waitJob(r.job, (p, m) => box.set(p, m));
  } catch (e) {
    if (cancelled) { const x = new Error(tr("imgai.annullato")); x.cancelled = true; throw x; }
    throw e;
  } finally { box.close(); }
}

export async function canvasFromPath(path, mk) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(tr("imgai.risultato_illeggibile"))); i.src = fileUrl(path, "&v=" + Date.now()); });
  const c = mk(img.naturalWidth, img.naturalHeight);
  c.getContext("2d").drawImage(img, 0, 0);
  return c;
}

export const canvasPng = c => new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error("PNG"))), "image/png"));
