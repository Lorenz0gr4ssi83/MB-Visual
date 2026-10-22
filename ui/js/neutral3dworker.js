// Web Worker dei lettori 3D scritti da zero (JT, U3D): la lettura non blocca l'interfaccia.
// Messaggi: { kind, bytes, name } -> { ok, result } | { progress } | { need: file } (file esterni dei JT spezzati)
const pending = new Map();
let seq = 0;

function readExternal(file) {
  const id = ++seq;
  return new Promise(resolve => {
    pending.set(id, resolve);
    postMessage({ need: file, id });
  });
}

self.onmessage = async ev => {
  const m = ev.data;
  if (m.reply) { const r = pending.get(m.reply); pending.delete(m.reply); r?.(m.bytes || null); return; }
  try {
    const progress = (f, text) => postMessage({ progress: f, text });
    let result;
    if (m.kind === "jt") {
      const { parseJT } = await import("./jt.js");
      result = await parseJT(m.bytes, { name: m.name, progress, readExternal });
    } else if (m.kind === "u3d") {
      const { parseU3D } = await import("./u3d.js");
      result = await parseU3D(m.bytes, { name: m.name, progress });
    } else throw new Error("formato non gestito: " + m.kind);
    const transfer = [];
    for (const g of result.meshes) for (const k of ["p", "n", "i", "c"]) if (g[k] && !transfer.includes(g[k].buffer)) transfer.push(g[k].buffer);
    postMessage({ ok: true, result }, transfer);
  } catch (e) {
    postMessage({ ok: false, error: e?.message || String(e) });
  }
};
