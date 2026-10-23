// App per telefono: file recenti salvati nel dispositivo (IndexedDB), per riaprirli dalla Home anche senza rete.
// Nella web app i file aperti esistono solo in memoria: qui se ne tiene una copia (fino a MAX_FILE per file e MAX_TOTAL
// in tutto; i meno recenti si tolgono per primi) con una miniatura JPEG. Niente viene inviato a un server.
// Record: { id, name, size, t (ultima apertura), blob (o null se troppo grande), thumb (Blob JPEG o null) }
const DB = "mbv-telefono", ST = "recenti";
const MAX_FILE = 150 * 1048576, MAX_TOTAL = 600 * 1048576, MAX_COUNT = 60;

let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST, { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(ST, mode);
    const out = fn(t.objectStore(ST));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const idOf = (name, size) => `${name}|${size}`;

export async function list() {
  try { return (await tx("readonly", s => s.getAll())).sort((a, b) => b.t - a.t); } catch { return []; }
}
export async function get(id) { try { return await tx("readonly", s => s.get(id)); } catch { return null; } }
export async function remove(id) { try { await tx("readwrite", s => s.delete(id)); } catch { /* */ } }
export async function clear() { try { await tx("readwrite", s => s.clear()); } catch { /* */ } }

// file aperto: copia (se non troppo grande) e data di apertura; restituisce l'id
export async function put(blob, name) {
  const id = idOf(name, blob.size);
  try {
    const old = await get(id);
    const rec = { id, name, size: blob.size, t: Date.now(), blob: blob.size <= MAX_FILE ? blob : null, thumb: old?.thumb || null };
    await tx("readwrite", s => s.put(rec));
    await evict();
    // chiede al browser di non cancellare i file salvati quando lo spazio scarseggia (Chrome/Android)
    navigator.storage?.persist?.().catch(() => {});
  } catch { /* spazio pieno o navigazione privata: i recenti restano vuoti */ }
  return id;
}
export async function setThumb(id, thumb) {
  try { const r = await get(id); if (r) { r.thumb = thumb; await tx("readwrite", s => s.put(r)); } } catch { /* */ }
}
// file salvato dalla web app (stesso nome): il contenuto nuovo sostituisce la copia
export async function update(id, blob) {
  try {
    const r = await get(id);
    if (!r) return id;
    await remove(id);
    r.id = idOf(r.name, blob.size); r.size = blob.size; r.blob = blob.size <= MAX_FILE ? blob : null; r.t = Date.now();
    await tx("readwrite", s => s.put(r));
    return r.id;
  } catch { return id; }
}

async function evict() {
  const all = await list();
  let total = 0;
  for (const [i, r] of all.entries()) {
    total += r.blob ? r.size : 0;
    if (i >= MAX_COUNT || total > MAX_TOTAL) await remove(r.id);
  }
}

export async function usage() {
  const all = await list();
  return { count: all.length, bytes: all.reduce((s, r) => s + (r.blob ? r.size : 0) + (r.thumb?.size || 0), 0) };
}

// licenza non piu' valida (mlicenza.js): via anche i file salvati nel dispositivo
export function wipe() {
  return new Promise(resolve => { try { const r = indexedDB.deleteDatabase(DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); } catch { resolve(); } });
}
