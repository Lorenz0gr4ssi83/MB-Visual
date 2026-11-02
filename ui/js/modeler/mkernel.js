// Chiamate al motore di modellazione (mbvisual/modeler.py): ricalcolo con risposta binaria, misure, importazioni,
// esportazioni, apertura e salvataggio dei .mbmod.
import { api, waitJob } from "../core.js";
import { LANG, t as tr } from "../i18n.js";

let seq = 0;
export const newSid = () => "m" + Date.now().toString(36) + (seq++);

async function post(op, json) {
  const r = await fetch("/api/modeler?op=" + op, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-MBV-Lang": LANG }, body: JSON.stringify(json) });
  return r;
}

export class KernelFail extends Error {
  constructor(data) { super(data.errore || tr("core.errore")); this.key = data.chiave; this.args = data.args || []; }
}

// risposta del ricalcolo: [u32 lunghezza JSON][JSON][dati dei corpi]
export async function regen(sid, cdoc, have, upto = null) {
  const r = await post("regen", { sid, doc: cdoc, have, upto });
  const ct = r.headers.get("Content-Type") || "";
  if (!ct.startsWith("application/octet-stream")) {
    let data;
    try { data = await r.json(); } catch { data = { errore: tr("core.risposta_non_valida_motore") + r.status + ")" }; }
    throw new KernelFail(data);
  }
  const buf = await r.arrayBuffer();
  const n = new DataView(buf).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  const base = 4 + n;
  const arr = (C, [off, len]) => new C(buf, base + off, len / C.BYTES_PER_ELEMENT);
  for (const b of meta.bodies) {
    if (!b.off) continue;
    const o = b.off;
    b.mesh = { pos: arr(Float32Array, o.pos), nrm: arr(Float32Array, o.nrm), idx: arr(Uint32Array, o.idx), fr: arr(Uint32Array, o.fr),
      ep: arr(Float32Array, o.ep), er: arr(Uint32Array, o.er), vp: arr(Float32Array, o.vp) };
  }
  return meta;
}

async function call(op, json) {
  const r = await post(op, json);
  const data = await r.json().catch(() => ({ ok: false, errore: tr("core.risposta_non_valida_motore") + r.status + ")" }));
  if (!data.ok) throw new KernelFail(data);
  return data;
}

export const measure = (sid, cdoc, a, b) => call("measure", { sid, doc: cdoc, a, b });
export async function job(op, json, onProgress) {
  const d = await call(op, json);
  return waitJob(d.job, onProgress);
}
export const exportModel = (o, onP) => job("export", o, onP);
export const importFile = (path, onP) => job("import", { path }, onP);
export const importSteps = (steps, name, onP) => job("import_steps", { steps, name }, onP);
export const openDoc = path => call("open", { path });
export const saveDoc = (o, onP) => job("save", o, onP);
export const closeSession = sid => call("close", { sid }).catch(() => {});
export const stopKernel = () => call("stop", {}).catch(() => {});
export const toBrep = blob => call("to_brep", { blob });
export const status = () => api("modeler", { op: "status" }, { allowFail: true });

// triangoli dall'interfaccia (mesh lette da three.js): [{name, color, pos: Float32Array, idx: Uint32Array}]
export async function importMesh(parts, brep = true) {
  let size = 0;
  for (const p of parts) size += p.pos.byteLength + p.idx.byteLength;
  const buf = new Uint8Array(size);
  let off = 0;
  const meta = parts.map(p => {
    const ov = off; buf.set(new Uint8Array(p.pos.buffer, p.pos.byteOffset, p.pos.byteLength), off); off += p.pos.byteLength;
    const ot = off; buf.set(new Uint8Array(p.idx.buffer, p.idx.byteOffset, p.idx.byteLength), off); off += p.idx.byteLength;
    return { name: p.name, color: p.color, nv: p.pos.length / 3, nt: p.idx.length / 3, ov, ot };
  });
  const r = await fetch("/api/modeler?op=import_mesh&brep=" + (brep ? 1 : 0) + "&parts=" + encodeURIComponent(JSON.stringify(meta)),
    { method: "POST", credentials: "same-origin", headers: { "X-MBV-Lang": LANG }, body: buf });
  const data = await r.json();
  if (!data.ok) throw new KernelFail(data);
  return data;
}
