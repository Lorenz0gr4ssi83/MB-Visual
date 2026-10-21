// Word, Excel e PowerPoint nell'editor ONLYOFFICE integrato (gira dentro MB Visual, senza server esterni):
// formattazione completa, formule con suggerimenti e selezione delle celle mentre si scrive la formula, revisioni.
// Il file viene passato all'editor come byte e torna indietro come byte al salvataggio.
import { api, el, extOf, readBytes, toast } from "../core.js";

// formati che l'editor scrive direttamente (gli altri passano dal convertitore di MB Visual)
const NATIVE = { word: ["docx", "odt", "rtf", "txt", "pdf"], cell: ["xlsx", "ods", "csv", "pdf"], slide: ["pptx", "odp", "pdf"] };
const KIND = ext => (/^(xlsx|xlsm|xlsb|xls|xltx|xltm|xlt|ods|fods|csv|tsv)$/.test(ext) ? "cell" : /^(pptx|pptm|ppt|pps|ppsx|ppsm|potx|potm|pot|odp|otp|fodp)$/.test(ext) ? "slide" : "word");
const MAIN = { word: "docx", cell: "xlsx", slide: "pptx" };

export async function mount(ctx) {
  ctx.fillBody(true);
  const ext = extOf(ctx.path), kind = KIND(ext);
  const { url } = await api("onlyoffice");
  const frame = el("iframe", {
    class: "fill", title: ctx.name, style: { border: "0", background: "#fff" },
    allow: "cross-origin-isolated; clipboard-read; clipboard-write; fullscreen",
    src: `${url}/editor.html?embed=1&locale=it&embedOrigin=${encodeURIComponent(location.origin)}`,
  });
  const wait = el("div", { class: "center", style: { position: "absolute", inset: 0, background: "var(--bg)" } }, el("div", {}, el("div", { class: "spinner" }), "Avvio dell'editor ONLYOFFICE..."));
  ctx.el.append(el("div", { style: { position: "relative", height: "100%" } }, frame, wait));

  // ---- messaggi con l'editor
  const pending = new Map();
  let seq = 0;
  const send = (type, payload = {}, transfer) => new Promise((resolve, reject) => {
    const id = `mbv-${++seq}`;
    pending.set(id, { resolve, reject });
    frame.contentWindow.postMessage({ id, type, payload }, url, transfer || []);
  });
  let readyResolve;
  const ready = new Promise(r => (readyResolve = r));
  const onMessage = e => {
    if (e.origin !== url || e.source !== frame.contentWindow) return;
    const { id, type, payload } = e.data || {};
    if (type === "document:ready") return readyResolve();
    if (type === "document:dirty-changed" || type === "mbv:dirty") return ctx.setDirty(!!payload?.dirty);
    const p = id && pending.get(id);
    if (!p) { if (type === "document:error") toast("ONLYOFFICE: " + (payload?.message || "errore"), true, 6000); return; }
    pending.delete(id);
    if (type === "document:error") p.reject(new Error(payload?.message || "errore dell'editor"));
    else p.resolve(payload);
  };
  window.addEventListener("message", onMessage);
  // l'editor annuncia "ready" quando ha caricato; se il messaggio arrivasse prima dell'ascolto, si riprova con get-state
  const poll = setInterval(() => { try { frame.contentWindow.postMessage({ id: "mbv-state", type: "document:get-state", payload: {} }, url); } catch { /* */ } }, 1000);
  await Promise.race([ready, new Promise(r => setTimeout(r, 60000))]);
  clearInterval(poll);

  const bytes = await readBytes(ctx.path);
  try {
    await send("document:open-buffer", { fileName: ctx.info?.nome || ctx.name, buffer: bytes.buffer, readonly: false }, [bytes.buffer]);
  } catch (e) {
    wait.remove();
    throw e;
  }
  wait.remove();
  ctx.status("Editor ONLYOFFICE · modifiche salvate con Salva (Ctrl+S)");

  // Ctrl+S dentro l'editor: l'iframe ha la tastiera, quindi la scorciatoia si ripete qui
  const keyFix = e => { if (e.ctrlKey && e.key.toLowerCase() === "s" && document.activeElement === frame) { e.preventDefault(); } };
  window.addEventListener("keydown", keyFix, true);

  const saveFormats = [...new Set([ext, ...NATIVE[kind]])].filter(x => NATIVE[kind].includes(x) || x === MAIN[kind]);
  return {
    saveFormats,
    saveAsName: () => ctx.name.replace(/\.[^.]+$/, "." + (NATIVE[kind].includes(ext) ? ext : MAIN[kind])),
    // i formati vecchi (doc, xls, ppt) si riscrivono nel formato moderno: salvare "sul posto" chiede il nome
    get saveInPlace() { return NATIVE[kind].includes(ext); },
    async save(target) {
      const t = extOf(target);
      const fmt = (NATIVE[kind].includes(t) ? t : MAIN[kind]).toUpperCase();
      const res = await send("document:save", { targetExt: fmt });
      const data = new Uint8Array(await res.file.arrayBuffer());
      await api("save", { path: target }, { body: data });
      frame.contentWindow.postMessage({ type: "mbv:saved" }, url); // l'editor riparte da "nessuna modifica"
      if (fmt !== t.toUpperCase()) return { converted: fmt.toLowerCase() };
    },
    dispose() { window.removeEventListener("message", onMessage); window.removeEventListener("keydown", keyFix, true); },
  };
}
