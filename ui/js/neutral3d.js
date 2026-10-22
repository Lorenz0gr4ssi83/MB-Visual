// Modelli dei formati neutri letti dai lettori propri (JT ISO 14306, U3D ECMA-363): lettura in un
// Web Worker (neutral3dworker.js), cache della conversione nel motore (mbvisual/model3dcache.py) e scena three.js
// con albero dell'assieme, colori, trasformazioni e proprieta'.
import * as THREE from "three";
import { api, dirName, fileUrl, readBytes, toast, WEB } from "./core.js";
import { t, fmtNum } from "./i18n.js";

// cambiare quando i lettori producono dati diversi: le conversioni salvate si rifanno
const CACHE_VER = { jt: "jt-3", u3d: "u3d-1" };

export async function loadNeutral(ctx, bytes, ld, info) {
  const kind = ctx.ext;
  let res = await cacheGet(ctx.path, kind);
  if (res) ld.set(0.5, t("n3d.da_cache"));
  else {
    if (!bytes) bytes = await readBytes(ctx.path);
    res = await runWorker(kind, bytes, ctx, ld);
    cachePut(ctx.path, kind, res); // in sottofondo
  }
  ld.set(0.9, t("n3d.preparazione"));
  const built = build(res, ctx.name);
  const warns = (res.warnings || []).map(w => (Array.isArray(w) ? t(w[0], ...w.slice(1)) : String(w)));
  if (warns.length) {
    built.root.userData[t("n3d.avvisi")] = warns.join(" · ");
    toast(warns.join("\n"), false, 9000);
  }
  const fmt = { jt: "JT", u3d: "U3D" }[kind] || kind.toUpperCase();
  info.status = t("n3d.stato", fmt + (res.info?.versione ? " " + res.info.versione : ""), fmtNum(res.meshes.length));
  return built;
}

export function errorText(msg) {
  // errori dei lettori: chiave di traduzione, eventualmente con argomenti in JSON
  if (/^\[".+\]$/.test(msg)) { try { const a = JSON.parse(msg); return t(a[0], ...a.slice(1)); } catch { /* */ } }
  if (/^[a-z0-9_]+\.[a-z0-9_]+$/.test(msg)) return t(msg);
  return msg;
}

function runWorker(kind, bytes, ctx, ld) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./neutral3dworker.js", import.meta.url), { type: "module" });
    const dir = ctx.path ? dirName(ctx.path) : "";
    w.onmessage = async ev => {
      const m = ev.data;
      if (m.progress !== undefined) { ld.set(Math.min(0.88, m.progress), m.text ? t("n3d.lettura_progresso", Math.round(m.progress * 100)) : t("n3d.lettura")); return; }
      if (m.need) {
        // assiemi JT "spezzati": le parti stanno in file .jt accanto (percorso relativo)
        let data = null;
        try { if (dir) data = await readBytes(dir + "\\" + m.need.replace(/\//g, "\\")); } catch { data = null; }
        w.postMessage({ reply: m.id, bytes: data }, data ? [data.buffer] : []);
        return;
      }
      w.terminate();
      if (m.ok) resolve(m.result); else reject(new Error(errorText(m.error)));
    };
    w.onerror = e => { w.terminate(); reject(new Error(e.message || t("n3d.errore_lettore"))); };
    ld.set(0.1, t("n3d.lettura"));
    // copia: i byte possono servire ancora (es. modello federato)
    const copy = bytes.slice();
    w.postMessage({ kind, bytes: copy, name: ctx.name }, [copy.buffer]);
  });
}

// ---------------------------------------------------------------- scena three.js
function build(res, fileName) {
  const geoms = res.meshes.map(m => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.p, 3));
    if (m.n && m.n.length === m.p.length) g.setAttribute("normal", new THREE.BufferAttribute(m.n, 3));
    if (m.c && m.c.length === (m.p.length / 3) * 4) g.setAttribute("color", new THREE.BufferAttribute(m.c, 4));
    g.setIndex(new THREE.BufferAttribute(m.i, 1));
    if (!g.attributes.normal) g.computeVertexNormals();
    return g;
  });
  const mats = new Map();
  const matFor = (c, vc) => {
    const col = c || [0.72, 0.74, 0.76, 1];
    const key = col.map(v => (+v).toFixed(3)).join() + (vc ? "v" : "");
    if (!mats.has(key)) {
      const a = Math.max(0.05, Math.min(1, col[3] ?? 1));
      mats.set(key, new THREE.MeshStandardMaterial({ color: new THREE.Color(col[0], col[1], col[2]), metalness: 0.15, roughness: 0.55,
        side: THREE.DoubleSide, transparent: a < 0.999, opacity: a, depthWrite: a >= 0.999, vertexColors: !!vc }));
    }
    return mats.get(key);
  };
  const kindName = k => t("n3d.k_" + (k || "node"));
  const walk = (n, inherited) => {
    const grp = new THREE.Group();
    grp.name = n.name || kindName(n.kind);
    if (n.m) { grp.matrix.fromArray(n.m); grp.matrixAutoUpdate = false; grp.matrix.decompose(grp.position, grp.quaternion, grp.scale); grp.matrixAutoUpdate = true; }
    const color = n.c || inherited;
    // proprieta' leggibili nella scheda (valori semplici)
    grp.userData[t("n3d.tipo")] = kindName(n.kind);
    for (const [k, v] of Object.entries(n.props || {})) if (v !== null && typeof v !== "object") grp.userData[k.startsWith("@") ? t("n3d.p_" + k.slice(1)) : k] = v;
    const item = { name: grp.name, obj: grp, children: [] };
    (n.mesh || []).forEach((mi, j) => {
      const g = geoms[mi];
      if (!g) return;
      const mesh = new THREE.Mesh(g, matFor((n.mc && n.mc[j]) || color, !!g.attributes.color));
      mesh.name = grp.name;
      mesh.userData.neutralShape = true; // il clic seleziona la parte che contiene la forma
      grp.add(mesh);
    });
    for (const k of n.kids || []) {
      const c = walk(k, color);
      grp.add(c.obj);
      item.children.push(c);
    }
    return item;
  };
  const top = walk(res.root, null);
  top.obj.name = top.name = res.root.name || fileName;
  return { root: top.obj, tree: top.children.length ? [top] : [top] };
}

// ---------------------------------------------------------------- cache della conversione (solo app per PC)
async function cacheGet(path, kind) {
  if (WEB || !path) return null;
  try {
    const r = await api("model_cache", { path, kind, ver: CACHE_VER[kind] }, { allowFail: true });
    if (!r?.ok || !r.hit) return null;
    const [meta, bin] = await Promise.all([fetch(fileUrl(r.json)).then(x => x.json()), fetch(fileUrl(r.bin)).then(x => x.arrayBuffer())]);
    const view = (sp, T) => (sp ? new T(bin.slice(sp[0], sp[0] + sp[1] * T.BYTES_PER_ELEMENT)) : null);
    meta.meshes = meta.meshes.map(m => ({ p: view(m.p, Float32Array), n: view(m.n, Float32Array), c: view(m.c, Float32Array), i: view(m.i, Uint32Array) }));
    return meta;
  } catch { return null; }
}

async function cachePut(path, kind, res) {
  if (WEB || !path) return;
  try {
    const parts = [], meshes = [];
    let off = 0;
    const add = a => { if (!a) return null; const sp = [off, a.length]; parts.push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); off += a.byteLength; return sp; };
    for (const m of res.meshes) meshes.push({ p: add(m.p), n: add(m.n), c: add(m.c), i: add(m.i) });
    const params = { path, kind, ver: CACHE_VER[kind] };
    await api("model_cache", { ...params, part: "bin" }, { body: new Blob(parts), allowFail: true });
    const meta = { root: res.root, warnings: res.warnings, info: res.info, meshes };
    await api("model_cache", { ...params, part: "json" }, { body: JSON.stringify(meta), allowFail: true });
  } catch { /* la cache e' facoltativa */ }
}
