// Funzioni di Navisworks Manage nel visualizzatore 3D (ui/js/viewers/model3d.js): un pannello a schede sopra la vista con
// Clash Detective (ui/js/clashpanel.js), Viste salvate (qui) e Computo (ui/js/qtopanel.js). Viste e test di interferenza
// stanno nel file .mbvnav accanto al modello (ui/js/navdoc.js), salvato da solo dopo ogni modifica.
// Qui anche cio' che serve a tutte le schede: elenco degli elementi della scena (con chiave stabile GUID IFC o percorso),
// insiemi di elementi (modello, classe, livello, selezione), evidenziazione A/B con il resto trasparente, inquadratura, istantanee.
import { api, askText, baseName, confirmBox, dirName, el, loadCss, pickFiles, pickSavePath, readBytes, saveBytes, toast, WEB } from "./core.js";
import { t as tr, fmtDateTime, collator, LOCALE } from "./i18n.js";
import { newDoc, parseDoc, serializeDoc, uid } from "./navdoc.js";

export const ICON = {
  clash: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="5" width="8" height="8" rx="1"/><circle cx="10.5" cy="6" r="4"/></svg>',
  views: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M1.5 4.5h3l1-1.5h5l1 1.5h3v8.5h-13z"/><circle cx="8" cy="8.5" r="2.5"/></svg>',
  qto: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="1.5" width="12" height="13" rx="1"/><path d="M4.5 4.5h7M4.5 7.5h2M8 7.5h3.5M4.5 10.5h2M8 10.5h3.5"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
};

// ----------------------------------------------------------------------------------------------------------------
// h = scena e funzioni del visualizzatore 3D; getBridge() = ponte BCF condiviso (ui/js/bcfview.js)
export function attachNav(h, getBridge, onToggle) {
  loadCss("css/navis.css");
  const { THREE } = h;
  const N = { h, THREE, br: null, doc: newDoc(h.partNames()), docPath: null, dirty: false };
  // unita' della scena: IFC, Navisworks, glTF, SketchUp in metri; CAD e mesh in millimetri (come l'esportazione)
  const src = (h.ctx.ext || "").toLowerCase();
  N.mpu = ["ifc", "nwd", "nwc", "nwf", "glb", "gltf", "usdz", "vrm", "skp", "las", "laz", "e57"].includes(src) ? 1 : 0.001;
  N.unit = N.mpu === 1 ? "m" : "mm";
  N.fmtLen = (d, digits) => (d == null || !isFinite(d) ? "—" : Number(d).toLocaleString(LOCALE, { maximumFractionDigits: digits ?? (N.unit === "m" ? 3 : 1) }) + " " + N.unit);

  // ---------------------------------------------------------------- pannello a schede
  const root = el("div", { class: "nav-panel", hidden: true });
  const grip = el("div", { class: "nav-grip", title: tr("nav.trascina_larghezza") });
  const tabsRow = el("div", { class: "nav-tabs" });
  const fileRow = el("div", { class: "nav-file" });
  const body = el("div", { class: "nav-body" });
  root.append(grip, el("div", { class: "nav-head" }, tabsRow, el("button", { class: "nav-x", title: tr("nav.chiudi_pannello"), html: ICON.close, onclick: () => close() })), fileRow, body);
  h.box.append(root);
  // larghezza regolabile trascinando il bordo sinistro (ricordata)
  try { const w = +localStorage.getItem("mbv-nav-w"); if (w > 300) root.style.width = w + "px"; } catch { /* */ }
  grip.addEventListener("pointerdown", e => {
    e.preventDefault();
    const x0 = e.clientX, w0 = root.getBoundingClientRect().width;
    const mv = ev => { root.style.width = Math.max(320, Math.min(h.box.clientWidth - 40, w0 + x0 - ev.clientX)) + "px"; };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); try { localStorage.setItem("mbv-nav-w", parseInt(root.style.width)); } catch { /* */ } };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  });
  const TABS = [["clash", tr("nav.clash_detective"), ICON.clash], ["views", tr("nav.viste_salvate"), ICON.views], ["qto", tr("nav.computo"), ICON.qto]];
  const panes = {}, paneP = {};
  let current = null;
  async function show(tab) {
    current = tab;
    tabsRow.innerHTML = "";
    for (const [k, label, icon] of TABS) tabsRow.append(el("button", { class: "nav-tab" + (k === tab ? " on" : ""), html: icon + "<span>" + label + "</span>", onclick: () => show(k) }));
    // scheda creata una volta sola anche con due clic ravvicinati (promessa memorizzata)
    if (!paneP[tab]) window.MBStat?.track("fn", "nav." + tab); // statistiche anonime: interferenze, viste, computo
    paneP[tab] ??= (async () => {
      const box = el("div", { class: "nav-pane" });
      body.append(box);
      const p = tab === "views" ? viewsPane(N, box) : tab === "clash" ? (await import("./clashpanel.js")).clashPane(N, box) : (await import("./qtopanel.js")).qtoPane(N, box);
      p.box = box;
      return (panes[tab] = p);
    })();
    await paneP[tab];
    if (current !== tab) return;
    for (const [k, p] of Object.entries(panes)) p.box.hidden = k !== tab;
    panes[tab].onShow?.();
    onToggle?.(tab);
  }
  function close() {
    root.hidden = true;
    N.clearHighlight();
    for (const p of Object.values(panes)) p.onHide?.();
    onToggle?.(null);
  }

  // ---------------------------------------------------------------- file .mbvnav
  const defaultPath = () => (h.ctx.path && !WEB ? dirName(h.ctx.path) + "\\" + baseName(h.ctx.path).replace(/\.[^.]+$/, "") + ".mbvnav" : null);
  function renderFile() {
    fileRow.innerHTML = "";
    const name = N.docPath ? baseName(N.docPath) : tr("nav.nessun_file");
    fileRow.append(...[el("span", { class: "nav-fname", title: N.docPath || tr("nav.file_creato_prima_modifica") }, name),
      N.dirty ? el("span", { class: "nav-unsaved" }, tr("nav.non_salvato")) : null,
      el("span", { style: { flex: 1 } }),
      el("button", { class: "nav-link", onclick: openOther, title: tr("nav.apri_altro_mbvnav") }, tr("nav.apri")),
      el("button", { class: "nav-link", onclick: () => saveDoc(true), title: tr("nav.salva_mbvnav_nome") }, tr("nav.salva_nome"))].filter(Boolean));
  }
  async function loadDefault() {
    const p = defaultPath();
    if (!p) return;
    const st = await api("stat", { path: p }, { allowFail: true }).catch(() => null);
    if (!st?.ok) { N.docPath = p; return; } // si creera' alla prima modifica
    try {
      N.doc = parseDoc(await readBytes(p));
      N.docPath = p;
    } catch (e) { toast(tr("nav.file_non_leggibile", baseName(p), e.message), true, 6000); N.docPath = null; }
  }
  async function openOther() {
    const ps = await pickFiles();
    if (!ps?.[0]) return;
    try {
      N.doc = parseDoc(await readBytes(ps[0]));
      N.docPath = WEB ? null : ps[0];
      N.dirty = false;
      for (const p of Object.values(panes)) p.reload?.();
      renderFile();
      toast(tr("nav.aperto_0", baseName(ps[0])));
    } catch (e) { toast(tr("nav.file_non_leggibile", baseName(ps[0]), e.message), true, 6000); }
  }
  let saveT = 0;
  N.changed = () => {
    N.dirty = true;
    renderFile();
    if (N.docPath && !WEB) { clearTimeout(saveT); saveT = setTimeout(() => saveDoc(false), 900); }
  };
  async function saveDoc(asNew) {
    clearTimeout(saveT);
    let target = N.docPath;
    if (asNew || !target) {
      target = await pickSavePath(baseName(target || defaultPath() || h.ctx.name.replace(/\.[^.]+$/, "") + ".mbvnav"), target ? dirName(target) : dirName(h.ctx.path || ""));
      if (!target) return;
    }
    try {
      N.doc.models = h.partNames();
      await saveBytes(target, new TextEncoder().encode(serializeDoc(N.doc)));
      if (!target.startsWith("download://")) N.docPath = target;
      N.dirty = false;
      if (asNew) toast(tr("nav.salvato_0", baseName(target)));
    } catch (e) { toast(tr("nav.salvataggio_non_riuscito", e.message), true, 6000); }
    renderFile();
  }
  N.save = () => saveDoc(false);

  // ---------------------------------------------------------------- elementi della scena
  let IDX = null;
  N.reset = () => { IDX = null; N._size = null; N.br?.reset(); };
  N.index = () => {
    if (IDX) return IDX;
    const units = [], byObj = new Map();
    h.model.traverse(m => {
      if (!m.isMesh || m.userData.merged || !m.geometry?.attributes?.position) return;
      const u = h.unitOf(m);
      let rec = byObj.get(u);
      if (!rec) {
        let top = u;
        while (top.parent && top.parent !== h.model) top = top.parent;
        const id = u.userData.expressID;
        rec = { obj: u, meshes: [], model: Math.max(0, h.model.children.indexOf(top)), mid: u.userData.modelID, id,
          cls: id !== undefined ? u.name : u.userData.classe || u.userData.layerName || "", n: units.length };
        byObj.set(u, rec);
        units.push(rec);
      }
      rec.meshes.push(m);
    });
    IDX = { units, byObj, byKey: null, levels: null };
    return IDX;
  };
  // chiave stabile (GUID IFC o percorso nella scena) e nome leggibile
  N.keyOf = rec => {
    if (rec.key) return rec.key;
    const c = N.br.compsFor([rec.obj])[0];
    rec.key = c?.ifcGuid ? "g:" + c.ifcGuid : "p:" + (c?.toolId || rec.n);
    return rec.key;
  };
  N.byKey = key => {
    const I = N.index();
    if (!I.byKey) { I.byKey = new Map(); for (const u of I.units) I.byKey.set(N.keyOf(u), u); }
    return I.byKey.get(key) || null;
  };
  N.nameOf = rec => {
    if (rec.label) return rec.label;
    let n = "";
    if (rec.id !== undefined && h.info.ifc) {
      try { const l = h.info.ifc.GetLine(rec.mid, rec.id, false); n = [l.Name?.value, l.Tag?.value && l.Tag.value !== l.Name?.value ? l.Tag.value : ""].filter(Boolean).join(" · "); } catch { /* */ }
      n = (n || rec.cls) + "  #" + rec.id;
    } else n = rec.obj.name || rec.cls || "#" + rec.n;
    return (rec.label = n);
  };
  N.modelName = rec => h.partNames()[rec.model] || "";
  // livello (piano IFC) di un elemento: struttura spaziale letta una volta per modello (ui/js/qtocore.js)
  N.levelInfo = rec => {
    if (rec.id === undefined || !h.info.ifc || !N._qto) return null;
    const I = N.index();
    I.levels ??= new Map();
    let L = I.levels.get(rec.mid);
    if (!L) { L = N._qto.levelMap(h.info.ifc, h.info.WEBIFC, rec.mid); I.levels.set(rec.mid, L); }
    return L.levelOf(rec.id);
  };
  N.levelOf = rec => N.levelInfo(rec)?.name || "";
  N.levelElev = rec => N.levelInfo(rec)?.elev ?? null;
  N.ready = async () => {
    N.br ??= await getBridge();
    N._qto ??= await import("./qtocore.js");
  };
  // scelte possibili per gli insiemi: modelli, classi, livelli (con il numero di elementi)
  N.choices = mode => {
    const counts = new Map(), elev = new Map();
    for (const u of N.index().units) {
      const v = mode === "model" ? N.modelName(u) : mode === "class" ? u.cls : mode === "level" ? N.levelOf(u) : "";
      if (!v) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
      if (mode === "level" && !elev.has(v)) elev.set(v, N.levelElev(u));
    }
    const out = [...counts.entries()].map(([v, n]) => ({ v, n }));
    if (mode === "model") { const order = h.partNames(); out.sort((a, b) => order.indexOf(a.v) - order.indexOf(b.v)); }
    else if (mode === "level") out.sort((a, b) => (elev.get(a.v) ?? 0) - (elev.get(b.v) ?? 0));
    else out.sort((a, b) => collator.compare(a.v, b.v));
    return out;
  };
  // elementi di un insieme { mode, values, items }
  N.unitsOf = set => {
    const all = N.index().units;
    const vals = new Set(set.values || []);
    switch (set.mode) {
      case "model": return all.filter(u => vals.has(N.modelName(u)));
      case "class": return all.filter(u => vals.has(u.cls));
      case "level": return all.filter(u => vals.has(N.levelOf(u)));
      case "selection": return (set.items || []).map(k => N.byKey(k)).filter(Boolean);
      default: return all;
    }
  };
  N.selectionKeys = () => {
    const I = N.index(), out = [];
    for (const o of h.selection) {
      let u = I.byObj.get(o);
      if (!u) o.traverse(x => { if (!u && I.byObj.has(x)) u = I.byObj.get(x); });
      if (u) out.push(N.keyOf(u));
      else o.traverse(x => { const r = I.byObj.get(x); if (r) out.push(N.keyOf(r)); });
    }
    return [...new Set(out)];
  };

  // triangoli di un elemento in coordinate della scena (vertici solo quelli usati: i modelli uniti condividono i dati)
  N.geometryOf = rec => {
    let nv = 0, ni = 0;
    for (const m of rec.meshes) { const g = m.geometry; ni += g.index ? g.index.count : g.attributes.position.count; }
    const idx = new Uint32Array(ni - (ni % 3));
    const pos = [];
    let o = 0;
    const v = new THREE.Vector3();
    for (const m of rec.meshes) {
      const g = m.geometry, pa = g.attributes.position;
      m.updateWorldMatrix(true, false);
      const mw = m.matrixWorld;
      if (g.index) {
        const ia = g.index.array, n = g.index.count - (g.index.count % 3);
        const remap = new Map();
        for (let k = 0; k < n; k++) {
          const vi = ia[k];
          let r = remap.get(vi);
          if (r === undefined) {
            r = nv++;
            remap.set(vi, r);
            v.fromBufferAttribute(pa, vi).applyMatrix4(mw);
            pos.push(v.x, v.y, v.z);
          }
          if (o < idx.length) idx[o++] = r;
        }
      } else {
        const n = pa.count - (pa.count % 3);
        for (let k = 0; k < n; k++) { v.fromBufferAttribute(pa, k).applyMatrix4(mw); pos.push(v.x, v.y, v.z); if (o < idx.length) idx[o++] = nv++; }
      }
    }
    return { pos: new Float32Array(pos), idx: o === idx.length ? idx : idx.slice(0, o - (o % 3)) };
  };
  N.boxOf = recs => { const b = new THREE.Box3(); for (const r of recs) b.expandByObject(r.obj); return b; };

  // ---------------------------------------------------------------- evidenziazione (elemento A rosso, B verde, resto trasparente)
  const mk = (color, proxy) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, metalness: 0.05, roughness: 0.6, side: THREE.DoubleSide,
    polygonOffset: proxy, polygonOffsetFactor: proxy ? -2 : 0, polygonOffsetUnits: proxy ? -2 : 0 });
  const MAT = { a: mk(0xe0342b, false), ap: mk(0xe0342b, true), b: mk(0x23a043, false), bp: mk(0x23a043, true) };
  const ghost = new THREE.MeshStandardMaterial({ color: 0xa4aab0, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide });
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  const HL = { mats: new Map(), shown: [] };
  const marker = new THREE.Group();
  marker.visible = false;
  marker.renderOrder = 30;
  h.scene.add(marker);
  N.highlight = (aRecs, bRecs, { rest = "ghost", point = null, size = 1 } = {}) => {
    N.clearHighlight();
    const sel = h.selection;
    if (sel.length) h.select([], { scroll: false });
    const A = new Set(aRecs.flatMap(r => r.meshes)), B = new Set(bRecs.flatMap(r => r.meshes));
    h.model.traverse(m => {
      if (!m.isMesh) return;
      const inA = A.has(m), inB = B.has(m) && !inA;
      if (inA || inB) {
        HL.mats.set(m, m.material);
        const px = !!m.userData.proxy;
        m.material = inA ? (px ? MAT.ap : MAT.a) : px ? MAT.bp : MAT.b;
        if (px && !m.visible) { m.visible = true; HL.shown.push(m); }
      } else if (rest !== "normal" && !m.userData.proxy) {
        HL.mats.set(m, m.material);
        m.material = rest === "hide" ? hidden : ghost;
      }
    });
    if (point) {
      marker.clear();
      const s = size;
      const geo = new THREE.BufferGeometry().setFromPoints([[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]].map(p => new THREE.Vector3(...p).multiplyScalar(s)));
      const ln = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffb000, depthTest: false }));
      ln.renderOrder = 30;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(s * 0.18, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffb000, depthTest: false }));
      dot.renderOrder = 31;
      marker.add(ln, dot);
      marker.position.set(...point);
      marker.visible = true;
    }
    N.highlighted = true;
    h.render();
  };
  N.clearHighlight = () => {
    if (!N.highlighted) return;
    const sel = h.selection;
    if (sel.length) h.select([], { scroll: false });
    for (const [m, mat] of HL.mats) m.material = mat;
    for (const m of HL.shown) m.visible = false;
    HL.mats.clear();
    HL.shown = [];
    marker.visible = false;
    N.highlighted = false;
    if (sel.length) h.select(sel, { scroll: false });
  };
  // inquadratura di un riquadro mantenendo la direzione di vista
  N.focusBox = (b, k = 1.6, besidePanel = true) => {
    if (b.isEmpty()) return;
    const { camera, controls } = h;
    const c = b.getCenter(new THREE.Vector3()), size = Math.max(b.getSize(new THREE.Vector3()).length(), 1e-6);
    const dir = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(c);
    const dist = (size / 2) / Math.tan((camera.fov * Math.PI) / 360) * k;
    camera.position.copy(c).add(dir.multiplyScalar(dist));
    camera.near = Math.min(camera.near, size / 50);
    camera.updateProjectionMatrix();
    // pannello aperto sopra la vista: il centro dell'inquadratura va nella parte libera (a sinistra del pannello)
    const W = h.box.clientWidth, pw = root.hidden ? 0 : root.getBoundingClientRect().width;
    if (besidePanel && W > 0 && pw > 0 && pw < W * 0.8) {
      camera.lookAt(c);
      camera.updateMatrixWorld();
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      const visW = 2 * dist * Math.tan((camera.fov * Math.PI) / 360) * camera.aspect;
      const shift = right.multiplyScalar((pw / 2 / W) * visW);
      camera.position.add(shift);
      controls.target.add(shift);
    }
    controls.update();
    h.render();
  };
  // istantanea della vista (JPEG, lato lungo al massimo maxW)
  N.snapshot = async (maxW = 900, type = "image/jpeg") => {
    h.render();
    const src = h.renderer.domElement;
    const k = Math.min(1, maxW / Math.max(src.width, src.height));
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(src.width * k));
    cv.height = Math.max(1, Math.round(src.height * k));
    const g = cv.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(src, 0, 0, cv.width, cv.height);
    return new Promise(r => cv.toBlob(r, type, 0.85));
  };
  N.camState = () => ({ pos: h.camera.position.clone(), target: h.controls.target.clone(), near: h.camera.near, fov: h.camera.fov });
  N.setCam = s => { h.camera.position.copy(s.pos); h.controls.target.copy(s.target); h.camera.near = s.near; h.camera.fov = s.fov; h.camera.updateProjectionMatrix(); h.controls.update(); h.render(); };
  // punto di vista completo (come nel BCF, coordinate del progetto) e ripristino con lo stesso punto di mira
  N.captureView = () => ({ vi: N.br.capture(), dist: h.camera.position.distanceTo(h.controls.target) });
  N.applyView = async v => {
    N.clearHighlight();
    const r = await N.br.apply(v.vi);
    if (v.dist > 0) {
      const dir = new THREE.Vector3();
      h.camera.getWorldDirection(dir);
      h.controls.target.copy(h.camera.position).add(dir.multiplyScalar(v.dist));
      h.controls.update();
    }
    h.render();
    return r;
  };

  // ---------------------------------------------------------------- avvio
  let started = null;
  const start = () => (started ??= (async () => { await N.ready(); await loadDefault(); renderFile(); })());
  return {
    async open(tab = "clash") { await start(); root.hidden = false; await show(tab); },
    async toggle(tab) { if (!root.hidden && current === tab) return close(); await this.open(tab); },
    close, get isOpen() { return !root.hidden; }, get current() { return root.hidden ? null : current; },
    modelsChanged() { N.reset(); for (const p of Object.values(panes)) p.reload?.(); },
    // modelli federati elencati nel .mbvnav e presenti nella stessa cartella ma non aperti: si propone di caricarli
    async offerModels() {
      await start();
      const have = new Set(h.partNames());
      const missing = (N.doc.models || []).filter(n => !have.has(n));
      if (!missing.length || !h.ctx.path || WEB) return;
      const dir = dirName(h.ctx.path);
      const found = [];
      for (const n of missing) { const p = dir + "\\" + n; const st = await api("stat", { path: p }, { allowFail: true }).catch(() => null); if (st?.ok) found.push(p); }
      if (!found.length) return;
      if (await confirmBox(tr("nav.modello_federato"), tr("nav.carica_modelli_0", found.map(baseName).join(", ")), tr("nav.carica"))) await h.addModels(found);
    },
    nav: N,
    dispose() { clearTimeout(saveT); if (N.dirty && N.docPath && !WEB) saveDoc(false); for (const p of Object.values(panes)) p.dispose?.(); N.clearHighlight(); h.scene.remove(marker); },
  };
}

// ----------------------------------------------------------------------------------------------------------------
// Viste salvate (Saved Viewpoints): camera, sezioni, visibilita' e colori; si salvano nel file .mbvnav
function viewsPane(N, box) {
  const { h } = N;
  const list = el("div", { class: "nav-views" });
  const color = el("input", { type: "color", value: "#e0342b", title: tr("nav.colore_sostituzione") });
  const head = el("div", { class: "nav-bar" },
    el("button", { class: "btn primary", onclick: saveView, title: tr("nav.salva_vista_titolo") }, tr("nav.salva_vista")),
    el("span", { style: { flex: 1 } }),
    el("label", { class: "nav-color", title: tr("nav.colore_sostituzione") }, color),
    el("button", { class: "btn", onclick: colorSel, title: tr("nav.colora_selezione_titolo") }, tr("nav.colora_selezione")),
    el("button", { class: "btn", onclick: resetLook, title: tr("nav.ripristina_aspetto_titolo") }, tr("nav.ripristina_aspetto")));
  box.append(head, el("p", { class: "note nav-hint" }, tr("nav.viste_nota")), list);
  const urls = [];

  function render() {
    list.innerHTML = "";
    const V = N.doc.views;
    if (!V.length) { list.append(el("p", { class: "nav-empty" }, tr("nav.nessuna_vista"))); return; }
    V.forEach((v, i) => {
      const parts = [];
      if (v.vi?.planes?.length) parts.push(tr("nav.sezione"));
      const hid = v.vi?.visibility;
      if (hid?.exceptions?.length) parts.push(hid.default === false ? tr("nav.0_visibili", hid.exceptions.length) : tr("nav.0_nascosti", hid.exceptions.length));
      if (v.vi?.coloring?.length) parts.push(tr("nav.colori"));
      const card = el("div", { class: "nav-view", tabindex: "0", title: tr("nav.applica_vista") },
        el("div", { class: "nav-thumb" }, v.thumb ? el("img", { src: v.thumb, alt: "" }) : null),
        el("div", { class: "nav-vbody" },
          el("div", { class: "nav-vname" }, v.name),
          el("div", { class: "note" }, [v.created ? fmtDateTime(v.created) : "", ...parts].filter(Boolean).join(" · ")),
          el("div", { class: "nav-vact" },
            el("button", { class: "nav-link", onclick: e => { e.stopPropagation(); updateView(v); } }, tr("nav.aggiorna")),
            el("button", { class: "nav-link", onclick: e => { e.stopPropagation(); renameView(v); } }, tr("nav.rinomina")),
            el("button", { class: "nav-link", disabled: i === 0, onclick: e => { e.stopPropagation(); V.splice(i - 1, 0, V.splice(i, 1)[0]); N.changed(); render(); } }, "↑"),
            el("button", { class: "nav-link danger", onclick: e => { e.stopPropagation(); removeView(v); } }, tr("common.elimina")))));
      card.addEventListener("click", () => applyView(v, card));
      card.addEventListener("keydown", e => { if (e.key === "Enter") applyView(v, card); });
      list.append(card);
    });
  }
  async function thumb() {
    const b = await N.snapshot(320);
    return new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  }
  async function saveView() {
    const n = N.doc.views.length + 1;
    const name = await askText(tr("nav.salva_vista"), tr("nav.nome_vista"), tr("nav.vista_n", n));
    if (name === null) return;
    N.clearHighlight();
    const { vi, dist } = N.captureView();
    N.doc.views.push({ guid: uid(), name: name.trim() || tr("nav.vista_n", n), vi, dist, thumb: await thumb(), created: new Date().toISOString() });
    N.changed();
    render();
  }
  async function updateView(v) {
    N.clearHighlight();
    Object.assign(v, N.captureView(), { thumb: await thumb(), created: new Date().toISOString() });
    N.changed();
    render();
    toast(tr("nav.vista_aggiornata"));
  }
  async function renameView(v) {
    const name = await askText(tr("nav.rinomina"), tr("nav.nome_vista"), v.name);
    if (!name?.trim()) return;
    v.name = name.trim();
    N.changed();
    render();
  }
  async function removeView(v) {
    if (!(await confirmBox(tr("nav.elimina_vista"), tr("nav.eliminare_vista_0", v.name), tr("common.elimina"), true))) return;
    N.doc.views.splice(N.doc.views.indexOf(v), 1);
    N.changed();
    render();
  }
  async function applyView(v, card) {
    list.querySelectorAll(".nav-view").forEach(c => c.classList.toggle("sel", c === card));
    try {
      const r = await N.applyView(v);
      if (r && r.wanted && r.found === 0) toast(tr("nav.elementi_vista_non_trovati"), true, 5000);
    } catch (e) { console.error(e); toast(tr("nav.vista_non_applicata", e.message), true); }
  }
  // sostituzione del colore (Override Color): resta nelle viste salvate dopo
  function colorSel() {
    if (!h.selection.length) return toast(tr("nav.seleziona_prima_elementi"), true);
    N.clearHighlight();
    const objs = h.selection;
    h.select([], { scroll: false });
    N.br.colorize(objs, color.value.replace("#", "").toUpperCase());
    h.render();
  }
  function resetLook() { N.clearHighlight(); N.br.clearOverlay(); h.setClip([]); h.showAll(); h.render(); }
  render();
  return { reload: render, dispose() { urls.forEach(u => URL.revokeObjectURL(u)); } };
}
