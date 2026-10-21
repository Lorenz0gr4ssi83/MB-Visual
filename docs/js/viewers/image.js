// Immagini (anche RAW, HEIC, PSD, TIFF...): si aprono nell'editor in stile Photoshop (ui/js/imgedit.js).
// PSD e ORA mantengono i livelli; gli altri formati diventano un livello "Sfondo".
import { api, fileUrl, loading, readBytes } from "../core.js";
import { createEditor, openImageDoc } from "../imgedit.js";

const NATIVE = new Set(["png", "apng", "jpg", "jpeg", "jpe", "jfif", "pjpeg", "pjp", "gif", "webp", "bmp", "dib", "ico", "cur", "avif"]);
const RAW = new Set(["cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "orf", "rw2", "raf", "dng", "pef", "ptx", "srw", "x3f", "3fr", "fff", "erf", "kdc", "dcr", "mos", "mef", "mrw", "rwl", "iiq", "raw", "rwz", "bay", "cap", "eip"]);

export async function mount(ctx) {
  const ld = loading(ctx.el, "Apertura dell'immagine");
  let doc = null, meta = {};
  if (ctx.ext === "psd" || ctx.ext === "ora") {
    ld.set(0.3, "Lettura dei livelli");
    try { doc = await openImageDoc(await readBytes(ctx.path), ctx.ext); } catch (e) { console.warn("Livelli non leggibili, immagine unita:", e); }
  }
  if (!doc) {
    let src = fileUrl(ctx.path);
    if (!NATIVE.has(ctx.ext)) {
      ld.set(0.3, RAW.has(ctx.ext) ? "Sviluppo del file RAW" : "Conversione dell'immagine");
      const r = await api("image", { path: ctx.path });
      src = fileUrl(r.path);
      meta = r.info;
    }
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Immagine non leggibile")); i.src = src; });
    doc = await openImageDoc(img, "");
  }
  return createEditor(ctx, { ...doc, meta, raw: RAW.has(ctx.ext) });
}
