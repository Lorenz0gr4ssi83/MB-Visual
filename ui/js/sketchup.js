// SketchUp (.skp) senza SketchUp: il file si legge in ui/js/skpworker.js (OpenSKP, MIT) e qui diventa una scena three.js
// con la gerarchia di gruppi e componenti (geometria di ogni definizione condivisa tra le sue copie), materiali e texture,
// spigoli in nero come in SketchUp, tag (layer) accendibili dall'albero e scene salvate come viste.
import * as THREE from "three";
import { fmtNum, t } from "./i18n.js";

function readSkp(bytes, ld) {
  const mb = (bytes.length / 1048576).toFixed(0); // i byte passano al Worker: la dimensione si legge prima
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./skpworker.js", import.meta.url), { type: "module" });
    w.onmessage = ev => {
      const d = ev.data;
      if (d.progress !== undefined && !d.done) return ld.set(0.1 + 0.6 * d.progress, t("skp.fase", t("skp.stage_" + (d.stage || "header"))));
      w.terminate();
      if (d.error && /allocation|memory|memoria/i.test(d.error)) reject(new Error(t("skp.err_memoria", mb)));
      else if (d.error) reject(new Error(t("skp.err_lettura", d.error.split(" | ")[0])));
      else resolve(d);
    };
    w.onerror = e => { w.terminate(); reject(new Error(e.message || t("skp.err_worker"))); };
    const buf = bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer;
    w.postMessage({ buffer: buf }, [buf]);
  });
}

// materiale colorizzato di SketchUp: la texture prende il colore del materiale conservando le sue variazioni di luminosita'
function colorize(img, rgb) {
  const cv = new OffscreenCanvas(img.width, img.height), g = cv.getContext("2d");
  g.drawImage(img, 0, 0);
  const im = g.getImageData(0, 0, cv.width, cv.height), px = im.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  const mean = sum / (px.length / 4) || 1;
  for (let i = 0; i < px.length; i += 4) {
    const k = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / mean;
    px[i] = Math.min(255, rgb[0] * k); px[i + 1] = Math.min(255, rgb[1] * k); px[i + 2] = Math.min(255, rgb[2] * k);
  }
  g.putImageData(im, 0, 0);
  return cv;
}

async function makeMaterials(d) {
  const tex = await Promise.all(d.textures.map(async t => {
    try {
      let img = await createImageBitmap(new Blob([t.data], { type: t.mime }), { imageOrientation: "flipY" });
      if (t.colorized && t.color) img = colorize(img, t.color);
      const tx = new THREE.Texture(img);
      tx.wrapS = tx.wrapT = THREE.RepeatWrapping; // le texture di SketchUp si ripetono sulle facce
      tx.flipY = false; // UV di SketchUp con origine in basso: l'immagine e' gia' capovolta da createImageBitmap
      tx.colorSpace = THREE.SRGBColorSpace;
      tx.anisotropy = 4;
      tx.needsUpdate = true;
      return { tx, png: t.mime === "image/png", opacity: t.opacity };
    } catch { return null; }
  }));
  return d.materials.map(m => {
    const pbr = m.pbrMetallicRoughness || {};
    const c = pbr.baseColorFactor || [0.8, 0.8, 0.8, 1];
    const t = tex[pbr.baseColorTexture?.index];
    // con la texture: immagine com'e' (SketchUp non la moltiplica per il colore medio) e opacita' del materiale
    const opacity = t ? t.opacity : c[3];
    const blend = opacity < 0.99;
    const mat = new THREE.MeshStandardMaterial({
      color: t ? 0xffffff : new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace), opacity, transparent: blend, depthWrite: !blend,
      metalness: pbr.metallicFactor ?? 0, roughness: pbr.roughnessFactor ?? 0.8,
      // fronte e retro con materiali diversi arrivano come due facce a lato singolo sovrapposte
      side: m.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (t) { mat.map = t.tx; if (t.png) mat.alphaTest = 0.5; } // PNG con trasparenza (alberi, ringhiere): ritaglio netto
    if (m.name) mat.name = m.name;
    return mat;
  });
}

export async function loadSkp(ctx, bytes, ld) {
  ld.set(0.1, t("skp.lettura"));
  const d = await readSkp(bytes, ld);
  ld.set(0.75, t("skp.costruzione"));
  const mats = await makeMaterials(d);
  const fallback = new THREE.MeshStandardMaterial({ color: 0xd8d8d0, roughness: 0.8, side: THREE.DoubleSide });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x111111 });
  // il visualizzatore usa il depth buffer logaritmico (scrive la profondita' nello shader: polygonOffset non ha effetto):
  // gli spigoli si avvicinano alla camera dello 0,05% della distanza, cosi' restano sopra le loro facce
  edgeMat.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace("#include <logdepthbuf_vertex>", "#include <logdepthbuf_vertex>\n#ifdef USE_LOGDEPTHBUF\n  vFragDepth = 1.0 + gl_Position.w * 0.9995;\n#endif");
  };

  // geometrie condivise: una per primitiva di ogni definizione, uno spigolo per definizione
  const geoms = new Map();
  for (const r of d.resources) geoms.set(r.id, r.prims.map(p => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p.positions, 3));
    if (p.normals.length === p.positions.length) g.setAttribute("normal", new THREE.BufferAttribute(p.normals, 3));
    else g.computeVertexNormals();
    if (p.uvs.length) g.setAttribute("uv", new THREE.BufferAttribute(p.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(p.indices, 1));
    return { g, mat: mats[p.mat] || fallback };
  }));
  const edgeGeoms = new Map();
  for (const [id, arr] of Object.entries(d.edges)) if (arr) edgeGeoms.set(id, new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(arr, 3)));

  const byLayer = new Map();
  let count = 0;
  const build = (n, isRoot) => {
    const grp = new THREE.Group();
    const info = d.defInfo[n.defId] || {};
    grp.name = isRoot ? "" : (n.name && !n.generated ? n.name : n.def || n.name || t("skp.gruppo")); // radice senza nome: il percorso parte dal file
    if (!isRoot) {
      grp.matrix.fromArray(n.matrix);
      grp.matrix.decompose(grp.position, grp.quaternion, grp.scale);
      const generic = /^(Group|Gruppo|Gruppe|Groupe|Grupo|Component|Componente)[#_]\d+/i.test(n.def || "") || /^组/.test(n.def || "");
      // etichette nella lingua dell'interfaccia: la scheda proprieta' mostra le chiavi cosi' come sono
      const ud = { [t("skp.p_tipo")]: t(generic ? "skp.gruppo" : "skp.componente"), [t("skp.p_definizione")]: n.def, [t("skp.p_tag")]: n.layer };
      if (n.name && n.name !== grp.name) ud[t("skp.p_nome_istanza")] = n.name;
      if (n.guid) ud.GUID = n.guid;
      if (n.pos) ud[t("skp.p_posizione")] = n.pos.map(v => fmtNum(v)).join(" ; ");
      if (n.props && Object.keys(n.props).length) ud[t("skp.p_attr_dinamici")] = n.props;
      for (const [k, v] of Object.entries(n.dicts || {})) if (v && Object.keys(v).length) ud[t("skp.p_attributi", k)] = v;
      grp.userData = ud;
      count++;
    }
    grp.userData.skpLayer = n.layer;
    if (info.image) grp.userData[t("skp.p_tipo")] = t("skp.immagine");
    for (const p of geoms.get(n.mesh) || []) {
      const m = new THREE.Mesh(p.g, p.mat);
      m.userData.pickParent = true; // il clic seleziona il gruppo o componente, come in SketchUp
      grp.add(m);
    }
    const eg = edgeGeoms.get(String(n.defId));
    if (eg) { const l = new THREE.LineSegments(eg, edgeMat); l.userData.pickParent = true; l.userData.skpEdges = true; grp.add(l); }
    const kids = n.children.map(c => build(c, false));
    kids.forEach(k => grp.add(k.obj));
    if (!isRoot) { if (!byLayer.has(n.layer)) byLayer.set(n.layer, []); byLayer.get(n.layer).push(grp); }
    return { name: grp.name, obj: grp, children: kids };
  };
  const top = build(d.root, true);
  const root = new THREE.Group();
  root.add(top.obj);

  // tag nascosti nel file: oggetti spenti all'apertura (si riaccendono dall'albero, voce "Tag")
  const layerHidden = new Map(d.layers.map(l => [l.name, l.hidden]));
  for (const [name, list] of byLayer) if (layerHidden.get(name)) list.forEach(o => (o.visible = false));

  const tree = [...top.children];
  // geometria sciolta del modello (non in gruppi): voce a parte, i suoi oggetti sono le mesh dirette della radice
  const loose = top.obj.children.filter(o => o.isMesh || o.isLineSegments);
  if (loose.length) { const g = new THREE.Group(); g.name = t("skp.geometria_modello"); g.userData = { [t("skp.p_tipo")]: t("skp.geometria_sciolta"), [t("skp.p_tag")]: "Layer0" }; loose.forEach(o => g.add(o)); top.obj.add(g); tree.unshift({ name: g.name, obj: g, children: [] }); }
  if (byLayer.size > 1 || [...layerHidden.values()].some(Boolean)) {
    tree.push({
      name: t("skp.tag_n", byLayer.size), obj: null, objs: [...byLayer.values()].flat(),
      children: [...byLayer.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([n, list]) => ({ name: `${n === "Layer0" ? t("skp.senza_tag") : n} (${list.length})`, obj: null, objs: list, children: [] })),
    });
  }

  // scene di SketchUp come viste: camera e tag nascosti della scena
  const views = d.pages.filter(p => p.eye && p.target).map((p, i) => ({
    name: p.name || t("skp.scena_n", i + 1),
    apply({ camera, controls, model }) {
      const toW = v => model.localToWorld(new THREE.Vector3(...v));
      const eye = toW(p.eye), target = toW(p.target);
      camera.position.copy(eye);
      if (!p.parallel && p.fov > 1 && p.fov < 170) camera.fov = p.fov;
      camera.updateProjectionMatrix();
      controls.target.copy(target);
      const hide = new Set(p.hiddenLayers);
      for (const [name, list] of byLayer) list.forEach(o => (o.visible = !hide.has(name)));
      controls.update();
    },
  }));

  const nTex = d.textures.length;
  ctx.skpInfo = t("skp.info", String(d.version || "").replace(/[{}]/g, ""), fmtNum(count), fmtNum(d.materialsCount)) + (nTex ? t("skp.info_tex", nTex) : "") +
    (byLayer.size > 1 ? t("skp.info_tag", byLayer.size) : "") + (views.length ? t("skp.info_scene", views.length) : "");
  return { root, tree, views, animations: [] };
}
