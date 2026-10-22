// Confronto di due modelli IFC per GlobalId: elementi aggiunti (verde), eliminati (rosso), con geometria cambiata
// (arancio, la posizione vecchia in rosso trasparente), con sole proprieta' cambiate (blu), uguali (grigio trasparente).
// Proprieta' confrontate: attributi, Pset e quantita' (anche del tipo), tipo, materiali, contenitore spaziale.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { button, el, readBytes, toast } from "../core.js";
import { COL, KIND_IT, canvasJpeg, chipBox, csvBlob, diffList, footerNumbers, legend, pdfDoc, reportHeader, reportTable, saveXlsx } from "./common.js";
import { t as tr, LOCALE } from "../i18n.js";

const KINDS = ["add", "del", "geo", "prop"];
const KIND_LABEL = { add: tr("ifccmp.aggiunto"), del: tr("ifccmp.eliminato"), geo: tr("ifccmp.geometria_modificata"), prop: tr("ifccmp.proprieta_modificate"), same: tr("ifccmp.uguale") };
const G_ATTR = tr("ifccmp.g_attributi");
const KCOL = { add: COL.add, del: COL.del, geo: COL.mod, prop: COL.prop, same: COL.same };

export async function mountCompare(env) {
  const { ctx, oldPath, newPath, body, tools, progress, info } = env;
  progress(0.03, tr("ifccmp.avvio_motore_ifc"));
  const W = await import("/vendor/web-ifc/web-ifc-api.js");
  const ifc = new W.IfcAPI();
  ifc.SetWasmPath("/vendor/web-ifc/", true);
  await ifc.Init(undefined, true); // thread singolo (pagina isolata, vedi model3d.js)
  const [bytesA, bytesB] = [await readBytes(oldPath), await readBytes(newPath)];
  progress(0.08, tr("ifccmp.apertura_modelli"));
  await tick();
  const mA = ifc.OpenModel(bytesA, { COORDINATE_TO_ORIGIN: true });
  const get = (m, id, flat = false) => { try { return ifc.GetLine(m, id, flat); } catch { return null; } };
  const ids = (m, t) => { const out = []; try { const v = ifc.GetLineIDsWithType(m, t, true); for (let k = 0; k < v.size(); k++) out.push(v.get(k)); } catch { /* */ } return out; };
  const typeName = (m, id) => { try { return ifc.GetNameFromTypeCode(ifc.GetLineType(m, id)); } catch { return "?"; } };
  const sv = v => (v && typeof v === "object" && "value" in v ? v.value : v);

  // ---- elementi e proprieta'
  const fmtV = v => {
    v = sv(v);
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.map(fmtV).join(", ");
    if (typeof v === "number") return String(+v.toPrecision(10));
    if (v === "T" || v === true) return tr("ifccmp.vero");
    if (v === "F" || v === false) return tr("ifccmp.falso");
    if (v === "U") return tr("ifccmp.sconosciuto");
    return String(v);
  };
  const propValue = p => {
    if (!p) return "";
    if (p.NominalValue !== undefined) return fmtV(p.NominalValue);
    if (p.EnumerationValues) return fmtV(p.EnumerationValues);
    if (p.ListValues) return fmtV(p.ListValues);
    if (p.UpperBoundValue !== undefined || p.LowerBoundValue !== undefined) return `${fmtV(p.LowerBoundValue)} … ${fmtV(p.UpperBoundValue)}`;
    for (const k of Object.keys(p)) if (/Value$/.test(k) && k !== "SetPointValue" && p[k] !== null && p[k] !== undefined) return fmtV(p[k]);
    return "";
  };
  function psetInto(m, pid, out, prefix = "") {
    const d = get(m, pid);
    if (!d) return;
    const g = prefix + (sv(d.Name) || typeName(m, pid));
    const list = d.HasProperties || d.Quantities || [];
    const grp = (out[g] ||= {});
    for (const r of list) {
      const p = get(m, sv(r));
      if (!p) continue;
      const n = sv(p.Name) || "?";
      if (p.HasProperties) { for (const q of p.HasProperties) { const pp = get(m, sv(q)); if (pp) grp[n + "." + (sv(pp.Name) || "?")] = propValue(pp); } } // proprieta' complesse
      else grp[n] = propValue(p);
    }
  }
  function matNames(m, id, depth = 0, out = []) {
    const l = get(m, id);
    if (!l || depth > 5) return out;
    if (l.LayerThickness !== undefined && l.Material) { const nm = matNames(m, sv(l.Material), depth + 1, []).join("/"); out.push(`${nm} ${+(+sv(l.LayerThickness)).toPrecision(6)}`); return out; }
    if (sv(l.Name) && /MATERIAL$/i.test(typeName(m, id))) { out.push(String(sv(l.Name))); return out; }
    for (const k of ["ForLayerSet", "MaterialLayers", "Materials", "MaterialConstituents", "Material", "MaterialProfiles", "ForProfileSet", "Material"]) {
      const v = l[k];
      if (!v) continue;
      for (const r of Array.isArray(v) ? v : [v]) if (sv(r)) matNames(m, sv(r), depth + 1, out);
    }
    return out;
  }
  function readModel(m) {
    const skip = new Set([W.IFCOPENINGELEMENT, W.IFCOPENINGSTANDARDCASE].filter(Boolean));
    const els = new Map(); // GlobalId -> elemento
    const byId = new Map();
    for (const id of ids(m, W.IFCPRODUCT)) {
      let t; try { t = ifc.GetLineType(m, id); } catch { continue; }
      if (skip.has(t)) continue;
      const l = get(m, id);
      const gid = sv(l?.GlobalId);
      if (!gid) continue;
      const e = { id, gid, type: typeName(m, id), name: fmtV(l.Name), props: { [G_ATTR]: {} } };
      const A = e.props[G_ATTR];
      for (const k of ["Name", "Description", "ObjectType", "Tag", "PredefinedType", "LongName", "Elevation", "CompositionType"]) if (l[k] !== undefined && l[k] !== null) A[k] = fmtV(l[k]);
      A[tr("ifccmp.classe_ifc")] = e.type;
      els.set(gid, e);
      byId.set(id, e);
    }
    const rels = (t, fn) => { for (const id of ids(m, t)) { const r = get(m, id); if (r) fn(r); } };
    rels(W.IFCRELDEFINESBYPROPERTIES, r => {
      const targets = (r.RelatedObjects || []).map(x => byId.get(sv(x))).filter(Boolean);
      if (!targets.length) return;
      const tmp = {};
      psetInto(m, sv(r.RelatingPropertyDefinition), tmp);
      for (const e of targets) for (const [g, ps] of Object.entries(tmp)) Object.assign((e.props[g] ||= {}), ps);
    });
    rels(W.IFCRELDEFINESBYTYPE, r => {
      const targets = (r.RelatedObjects || []).map(x => byId.get(sv(x))).filter(Boolean);
      const tl = get(m, sv(r.RelatingType));
      if (!targets.length || !tl) return;
      const tmp = {};
      for (const ps of tl.HasPropertySets || []) psetInto(m, sv(ps), tmp, tr("ifccmp.g_tipo") + " · ");
      for (const e of targets) { e.props[G_ATTR][tr("ifccmp.p_tipo")] = `${typeName(m, sv(r.RelatingType))} ${fmtV(tl.Name)}`.trim(); for (const [g, ps] of Object.entries(tmp)) Object.assign((e.props[g] ||= {}), ps); }
    });
    rels(W.IFCRELASSOCIATESMATERIAL, r => {
      const names = [...new Set(matNames(m, sv(r.RelatingMaterial)))].join(", ");
      for (const x of r.RelatedObjects || []) { const e = byId.get(sv(x)); if (e) (e.props[tr("ifccmp.g_materiali")] ||= {})[tr("ifccmp.p_materiale")] = names; }
    });
    rels(W.IFCRELCONTAINEDINSPATIALSTRUCTURE, r => {
      const s = get(m, sv(r.RelatingStructure));
      const nm = `${typeName(m, sv(r.RelatingStructure)).replace(/^IFC/, "")} ${fmtV(s?.Name)}`.trim();
      for (const x of r.RelatedElements || []) { const e = byId.get(sv(x)); if (e) { e.props[G_ATTR][tr("ifccmp.p_contenitore")] = nm; e.level = fmtV(s?.Name); } }
    });
    rels(W.IFCRELAGGREGATES, r => {
      const s = get(m, sv(r.RelatingObject));
      for (const x of r.RelatedObjects || []) { const e = byId.get(sv(x)); if (e && !e.props[G_ATTR][tr("ifccmp.p_contenitore")]) e.props[G_ATTR][tr("ifccmp.parte")] = `${typeName(m, sv(r.RelatingObject)).replace(/^IFC/, "")} ${fmtV(s?.Name)}`.trim(); }
    });
    return { els, byId };
  }

  // ---- geometria (con la firma di forma e posizione di ogni elemento)
  const root = new THREE.Group();
  async function readGeometry(m, model, shift, p0, p1, label) {
    const tmpM = new THREE.Matrix4(), v3 = new THREE.Vector3();
    const list = [...model.byId.keys()];
    const onMesh = fm => {
      const e = model.byId.get(fm.expressID);
      if (!e) return;
      const geos = [];
      const bb = new THREE.Box3();
      let nv = 0, sx = 0, sy = 0, sz = 0;
      const pgs = fm.geometries;
      for (let k = 0; k < pgs.size(); k++) {
        const pg = pgs.get(k);
        const geom = ifc.GetGeometry(m, pg.geometryExpressID);
        const v = ifc.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const idx = ifc.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        tmpM.fromArray(pg.flatTransformation);
        if (shift) tmpM.premultiply(shift);
        const n = v.length / 6, pos = new Float32Array(n * 3);
        for (let q = 0; q < n; q++) {
          v3.set(v[q * 6], v[q * 6 + 1], v[q * 6 + 2]).applyMatrix4(tmpM);
          pos[q * 3] = v3.x; pos[q * 3 + 1] = v3.y; pos[q * 3 + 2] = v3.z;
          bb.expandByPoint(v3);
          sx += v3.x; sy += v3.y; sz += v3.z;
        }
        nv += n;
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
        g.computeVertexNormals();
        geos.push({ g, tri: idx.length / 3 });
        geom.delete?.();
      }
      if (!geos.length) return;
      e.geos = geos;
      e.bb = bb;
      const r = x => Math.round(x * 1000); // millimetri
      e.gsig = `${geos.reduce((s, q) => s + q.tri, 0)}|${[bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z].map(r).join(",")}|${[sx / nv, sy / nv, sz / nv].map(r).join(",")}`;
    };
    const STEP = 800;
    for (let s = 0; s < list.length; s += STEP) {
      try { ifc.StreamMeshes(m, list.slice(s, s + STEP), onMesh); } catch (err) { console.warn("IFC: geometria non letta", err); }
      progress(p0 + (p1 - p0) * Math.min(1, (s + STEP) / list.length), tr("ifccmp.0_1_2_elementi", label, Math.min(list.length, s + STEP).toLocaleString(LOCALE), list.length.toLocaleString(LOCALE)));
      await tick();
    }
  }
  progress(0.1, tr("ifccmp.lettura_revisione_vecchia"));
  await tick();
  const A = readModel(mA);
  await readGeometry(mA, A, null, 0.12, 0.42, tr("ifccmp.geometria_vecchia"));
  let shift = null;
  try { shift = new THREE.Matrix4().fromArray(Array.from(ifc.GetCoordinationMatrix(mA))); } catch { /* */ }
  progress(0.44, tr("ifccmp.lettura_revisione_nuova"));
  await tick();
  const mB = ifc.OpenModel(bytesB, { COORDINATE_TO_ORIGIN: false }); // stesso spostamento della vecchia: restano allineate
  const B = readModel(mB);
  await readGeometry(mB, B, shift, 0.46, 0.8, tr("ifccmp.geometria_nuova"));

  // ---- confronto per GlobalId
  progress(0.82, tr("ifccmp.confronto_elementi"));
  await tick();
  const flat = e => { const o = new Map(); for (const [g, ps] of Object.entries(e.props)) for (const [k, v] of Object.entries(ps)) o.set(g + "\u0000" + k, v); return o; };
  const rows = [];
  for (const [gid, eb] of B.els) {
    const ea = A.els.get(gid);
    if (!ea) { rows.push({ kind: "add", gid, a: null, b: eb, diffs: [] }); continue; }
    const fa = flat(ea), fb = flat(eb), diffs = [];
    for (const k of new Set([...fa.keys(), ...fb.keys()])) {
      const va = fa.get(k), vb = fb.get(k);
      if ((va ?? "") !== (vb ?? "")) { const [g, p] = k.split("\u0000"); diffs.push({ g, p, o: va, n: vb }); }
    }
    const geo = (ea.gsig || "") !== (eb.gsig || "");
    rows.push({ kind: geo ? "geo" : diffs.length ? "prop" : "same", gid, a: ea, b: eb, diffs, geo });
  }
  for (const [gid, ea] of A.els) if (!B.els.has(gid)) rows.push({ kind: "del", gid, a: ea, b: null, diffs: [] });
  const ord = { geo: 0, prop: 1, add: 2, del: 3, same: 4 };
  for (const r of rows) {
    const e = r.b || r.a;
    r.type = e.type;
    r.typeRaw = e.type;
    r.name = e.name || "";
    r.level = e.level || r.a?.level || "";
    if (r.kind === "geo") r.geoText = geoChange(r.a, r.b);
  }
  rows.sort((p, q) => ord[p.kind] - ord[q.kind] || p.type.localeCompare(q.type) || p.name.localeCompare(q.name));
  const counts = { add: 0, del: 0, geo: 0, prop: 0, same: 0 };
  rows.forEach(r => counts[r.kind]++);
  const nPropDiffs = rows.reduce((s, r) => s + r.diffs.length, 0);
  function geoChange(a, b) {
    if (!a.bb || !b.bb) return a.bb ? tr("ifccmp.geometria_tolta") : b.bb ? tr("ifccmp.geometria_aggiunta") : tr("ifccmp.forma_diversa");
    const ca = a.bb.getCenter(new THREE.Vector3()), cb = b.bb.getCenter(new THREE.Vector3());
    const sa = a.bb.getSize(new THREE.Vector3()), sb = b.bb.getSize(new THREE.Vector3());
    const parts = [];
    const d = cb.clone().sub(ca);
    if (d.length() > 0.001) parts.push(tr("ifccmp.centro_spostato_0_x_1", fmtM(d.length()), fmtM(d.x), fmtM(-d.z), fmtM(d.y)));
    if (sa.distanceTo(sb) > 0.001) parts.push(`ingombro ${dims(sa)} → ${dims(sb)}`);
    return parts.join(" · ") || tr("ifccmp.forma_diversa");
  }

  // ---- scena 3D
  progress(0.88, tr("ifccmp.preparazione_vista_3d"));
  await tick();
  const side = el("div", { class: "cmp-side" }), main = el("div", { class: "cmp-main" }), detail = el("div", { class: "cmp-detail" });
  body.classList.add("with-detail");
  body.append(side, main, detail);
  const bar = el("div", { class: "cmp-bar" }), stage = el("div", { class: "cmp-stage" });
  const tip = el("div", { class: "cmp-tip", hidden: true });
  main.append(bar, stage);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(devicePixelRatio || 1);
  renderer.domElement.className = "fill";
  stage.append(renderer.domElement, tip);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 1e6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2));
  const dl = new THREE.DirectionalLight(0xffffff, 1.4);
  dl.position.set(1, 2, 1.5);
  scene.add(dl, root);
  const mat = k => new THREE.MeshStandardMaterial({ color: new THREE.Color(KCOL[k]), roughness: 0.7, metalness: 0.02, side: THREE.DoubleSide, transparent: k === "same" || k === "ghost", opacity: k === "same" ? 0.18 : k === "ghost" ? 0.28 : 1, depthWrite: k !== "same" && k !== "ghost" });
  const MATS = { add: mat("add"), del: mat("del"), geo: mat("geo"), prop: mat("prop"), same: mat("same"), ghost: mat("ghost") };
  MATS.same.color.set("#9da1a6");
  MATS.ghost.color.set(COL.del);
  const SEL = new THREE.MeshStandardMaterial({ color: 0xffd400, emissive: 0x6b5600, roughness: 0.5, side: THREE.DoubleSide });
  const show = { add: true, del: true, geo: true, prop: true, same: true, ghost: true };
  const groups = new Map(); // riga -> gruppi 3D
  const pickables = [];
  const mk = (e, material, row, ghost = false) => {
    if (!e?.geos) return null;
    const g = new THREE.Group();
    for (const q of e.geos) { const mesh = new THREE.Mesh(q.g, material); mesh.userData.row = row; mesh.userData.ghost = ghost; g.add(mesh); if (!ghost) pickables.push(mesh); }
    root.add(g);
    return g;
  };
  for (const r of rows) {
    const isSpace = /IFCSPACE/i.test(r.typeRaw);
    const main3 = r.kind === "del" ? mk(r.a, MATS.del, r) : mk(r.b, MATS[r.kind], r);
    const ghost = r.kind === "geo" ? mk(r.a, MATS.ghost, r, true) : null;
    if (isSpace && r.kind === "same" && main3) main3.visible = false;
    groups.set(r, { main: main3, ghost, space: isSpace });
  }
  const all = new THREE.Box3().setFromObject(root);
  if (all.isEmpty()) all.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const diag = all.getSize(new THREE.Vector3()).length() || 1;
  camera.near = diag / 5000; camera.far = diag * 50; camera.updateProjectionMatrix();
  function frame(box) {
    const c = box.getCenter(new THREE.Vector3()), r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, diag / 200);
    const dir = camera.position.clone().sub(controls.target).normalize();
    if (!isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(1, 0.8, 1.2).normalize();
    camera.position.copy(c).addScaledVector(dir, r / Math.sin((camera.fov * Math.PI) / 360) * 1.05);
    controls.target.copy(c);
    controls.update();
    redraw();
  }
  const resize = () => { const rc = stage.getBoundingClientRect(); if (!rc.width) return; renderer.setSize(rc.width, rc.height, false); camera.aspect = rc.width / rc.height; camera.updateProjectionMatrix(); redraw(); };
  let pending = false;
  function redraw() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; renderer.render(scene, camera); }); }
  const drawNow = () => renderer.render(scene, camera);
  controls.addEventListener("change", redraw);
  new ResizeObserver(resize).observe(stage);
  let dark = true;
  const setBg = () => { scene.background = new THREE.Color(dark ? "#1e2021" : "#f2f3f1"); redraw(); };
  setBg();

  function applyVis() {
    for (const [r, g] of groups) {
      const typeOk = !typeFilter.value || r.type === typeFilter.value;
      if (g.main) g.main.visible = show[r.kind] && typeOk && !(g.space && r.kind === "same");
      if (g.ghost) g.ghost.visible = show.geo && show.ghost && typeOk;
    }
    redraw();
  }

  // ---- pannello sinistro
  const sum = el("div", { class: "cmp-sum" }, ...[["add", tr("ifccmp.n_aggiunti")], ["del", tr("ifccmp.n_eliminati")], ["geo", tr("ifccmp.n_geometria")], ["prop", tr("ifccmp.n_proprieta")], ["same", tr("ifccmp.n_uguali")]].map(([k, t]) => el("div", {}, el("b", { style: { color: k === "same" ? "" : KCOL[k] } }, String(counts[k])), el("span", {}, t))));
  const filt = KINDS.map(k => chipBox(KIND_LABEL[k], KCOL[k], true, v => { show[k] = v; applyVis(); refresh(); }, counts[k]));
  const fSame = chipBox(tr("ifccmp.uguali_trasparenti"), COL.same, true, v => { show.same = v; applyVis(); refresh(); }, counts.same);
  const fGhost = chipBox(tr("ifccmp.posizione_vecchia_elementi_modificati"), MATS.ghost.color.getStyle(), true, v => { show.ghost = v; applyVis(); });
  const types = [...new Set(rows.filter(r => r.kind !== "same").map(r => r.type))].sort();
  const typeFilter = el("select", { class: "field", style: { width: "100%" } }, el("option", { value: "" }, tr("ifccmp.tutte_classi_ifc")), ...types.map(t => el("option", { value: t }, t)));
  typeFilter.addEventListener("change", () => { applyVis(); refresh(); });
  const search = el("input", { type: "search", class: "field cmp-search", placeholder: tr("ifccmp.cerca_nome_globalid_proprieta") });
  search.addEventListener("input", () => refresh());
  const list = diffList({ onPick: it => select(it.ref, true) });
  side.append(el("div", { class: "cmp-sec" }, el("h4", {}, tr("ifccmp.riepilogo_globalid")), sum, el("span", { class: "note", style: { color: "var(--muted)", fontSize: "11.5px" } }, tr("ifccmp.0_differenze_proprieta_1_elementi", nPropDiffs, rows.filter(r => r.diffs.length).length))),
    el("div", { class: "cmp-sec" }, el("h4", {}, tr("ifccmp.mostra")), ...filt, fSame, fGhost, typeFilter, search), list.el);
  function refresh() {
    const q = search.value.trim().toLowerCase();
    const L = rows.filter(r => (r.kind === "same" ? show.same && q : show[r.kind]) && (!typeFilter.value || r.type === typeFilter.value) &&
      (!q || (r.name + " " + r.gid + " " + r.type + " " + r.diffs.map(d => d.p + " " + d.o + " " + d.n).join(" ")).toLowerCase().includes(q)));
    list.set(L.map(r => ({ ref: r, color: KCOL[r.kind], title: `${r.type}${r.name ? " · " + r.name : ""}`, where: KIND_LABEL[r.kind],
      sub: r.kind === "geo" ? r.geoText + (r.diffs.length ? tr("ifccmp.0_proprieta", r.diffs.length) : "") : r.kind === "prop" ? r.diffs.slice(0, 3).map(d => `${d.p}: ${d.o ?? "—"} → ${d.n ?? "—"}`).join(" · ") : r.gid,
      tip: `${r.gid}${r.level ? " · " + r.level : ""}` })));
    if (!L.length) list.el.querySelector(".cmp-list-in").append(el("div", { class: "cmp-empty" }, rows.some(r => r.kind !== "same") ? tr("ifccmp.nessuna_differenza_i_filtri_scelti") : tr("ifccmp.nessuna_differenza_i_due_modelli")));
  }

  // ---- dettaglio (destra)
  let selRow = null, showSameProps = false;
  function renderDetail() {
    detail.innerHTML = "";
    const r = selRow;
    if (!r) { detail.append(el("div", { class: "cmp-empty" }, tr("ifccmp.seleziona_elemento_modello_nell_elenco"))); return; }
    const head = el("div", { class: "cmp-sec" },
      el("h4", {}, el("span", { class: "cmp-chip", style: { background: KCOL[r.kind] } }), KIND_LABEL[r.kind]),
      el("b", {}, `${r.type}${r.name ? " · " + r.name : ""}`),
      el("span", { class: "note", style: { color: "var(--muted)", fontSize: "11.5px", userSelect: "text" } }, `GlobalId ${r.gid}`),
      r.geoText ? el("span", { style: { color: COL.mod } }, tr("ifccmp.geometria") + r.geoText) : null,
      el("label", { class: "cmp-check" }, (() => { const c = el("input", { type: "checkbox", checked: showSameProps || undefined }); c.addEventListener("change", () => { showSameProps = c.checked; renderDetail(); }); return c; })(), tr("ifccmp.mostra_anche_proprieta_uguali")));
    detail.append(head);
    const t = el("table", { class: "cmp-props" }, el("tr", {}, el("th", {}, tr("ifccmp.proprieta")), el("th", {}, tr("ifccmp.vecchia")), el("th", {}, tr("ifccmp.nuova"))));
    const groupsOf = e => (e ? e.props : {});
    const pa = groupsOf(r.a), pb = groupsOf(r.b);
    const gnames = [...new Set([...Object.keys(pa), ...Object.keys(pb)])];
    let any = false;
    for (const g of gnames) {
      const keys = [...new Set([...Object.keys(pa[g] || {}), ...Object.keys(pb[g] || {})])];
      const lines = keys.map(k => ({ k, o: pa[g]?.[k], n: pb[g]?.[k] })).filter(x => showSameProps || r.kind === "add" || r.kind === "del" || (x.o ?? "") !== (x.n ?? ""));
      if (!lines.length) continue;
      any = true;
      t.append(el("tr", { class: "grp" }, el("td", { colspan: 3 }, g)));
      for (const x of lines) {
        const same = (x.o ?? "") === (x.n ?? "");
        t.append(el("tr", { class: same ? "same" : "" }, el("td", {}, x.k), el("td", { class: same ? "" : "o" }, x.o ?? "—"), el("td", { class: same ? "" : "n" }, x.n ?? "—")));
      }
    }
    detail.append(any ? t : el("div", { class: "cmp-empty" }, tr("ifccmp.nessuna_proprieta_diversa")));
  }
  function select(r, zoom) {
    if (selRow) { const g = groups.get(selRow); g?.main?.traverse(o => { if (o.isMesh) o.material = o.userData.mat0 || o.material; }); }
    selRow = r;
    const g = groups.get(r);
    if (g?.main) {
      g.main.traverse(o => { if (o.isMesh) { o.userData.mat0 = o.material; o.material = SEL; } });
      g.main.visible = true;
      if (zoom) { const box = new THREE.Box3().setFromObject(g.main); if (g.ghost) box.union(new THREE.Box3().setFromObject(g.ghost)); frame(box); }
    } else if (zoom) toast(tr("ifccmp.questo_elemento_non_ha_geometria"));
    const k = list.items.findIndex(x => x.ref === r);
    if (k >= 0) list.select(k);
    renderDetail();
    ctx.status(`${KIND_LABEL[r.kind]}: ${r.type} ${r.name} · ${r.gid}`);
    redraw();
  }

  // ---- barra
  const bBg = button(tr("ifccmp.sfondo_chiaro"), "sun", () => { dark = !dark; bBg.lastChild.textContent = dark ? tr("ifccmp.sfondo_chiaro") : tr("ifccmp.sfondo_scuro"); setBg(); });
  let cur = -1;
  const step = d => { const L = list.items; if (!L.length) return; cur = (cur + d + L.length) % L.length; select(L[cur].ref, true); };
  bar.append(button(tr("ifccmp.adatta"), "fit", () => frame(all)), button(tr("ifccmp.precedente"), '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>', () => step(-1)), button(tr("ifccmp.successiva"), '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>', () => step(1)),
    el("span", { class: "sep" }), bBg, el("span", { class: "grow" }),
    el("span", { class: "cmp-legend" }, ...["add", "del", "geo", "prop"].map(k => el("span", {}, el("i", { class: "cmp-chip", style: { background: KCOL[k] } }), KIND_LABEL[k].toLowerCase()))));
  tools.append(el("span", { class: "note" }, tr("ifccmp.0_1_elementi", A.els.size, B.els.size)));

  // ---- selezione nel 3D
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  const hit = e => {
    const rc = renderer.domElement.getBoundingClientRect();
    mouse.set(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const vis = pickables.filter(m => { let o = m; while (o) { if (!o.visible) return false; o = o.parent; } return true; });
    const h = ray.intersectObjects(vis, false);
    // gli uguali sono trasparenti: si preferisce l'elemento cambiato piu' vicino
    return (h.find(x => x.object.userData.row.kind !== "same") || h[0])?.object.userData.row || null;
  };
  let down = null;
  renderer.domElement.addEventListener("pointerdown", e => (down = [e.clientX, e.clientY]));
  renderer.domElement.addEventListener("pointerup", e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.button !== 0) return;
    const r = hit(e);
    if (r) select(r, false);
  });
  let hoverT = 0;
  renderer.domElement.addEventListener("pointermove", e => {
    if (e.buttons) { tip.hidden = true; return; }
    clearTimeout(hoverT);
    hoverT = setTimeout(() => {
      const r = hit(e);
      if (!r) { tip.hidden = true; return; }
      const rc = stage.getBoundingClientRect();
      tip.hidden = false;
      tip.textContent = `${KIND_LABEL[r.kind]} · ${r.type}${r.name ? " · " + r.name : ""}`;
      tip.style.left = e.clientX - rc.left + 14 + "px"; tip.style.top = e.clientY - rc.top + 14 + "px";
    }, 60);
  });
  renderer.domElement.addEventListener("pointerleave", () => (tip.hidden = true));
  renderer.domElement.addEventListener("dblclick", e => { const r = hit(e); if (r) select(r, true); });

  refresh();
  renderDetail();
  resize();
  frame(all);

  // ---- report
  const geomCell = r => (r.kind === "geo" ? r.geoText : r.kind === "add" ? tr("ifccmp.g_nuovo") : r.kind === "del" ? tr("ifccmp.g_tolto") : "");
  const elemRows = () => rows.filter(r => r.kind !== "same").map(r => [r.gid, r.type, r.name, KIND_LABEL[r.kind], geomCell(r), r.diffs.length, r.level]);
  const propRows = () => rows.flatMap(r => r.diffs.map(d => [r.gid, r.type, r.name, d.g, d.p, cellV(d.o), cellV(d.n)]));
  async function reportXlsx() {
    return saveXlsx(null, [
      { name: tr("ifccmp.riepilogo"), filter: false, widths: [36, 60], rows: [[tr("ifccmp.confronto_modelli_ifc_globalid"), ""], [tr("ifccmp.vecchia"), info.oldName], [tr("ifccmp.nuova"), info.newName], [tr("ifccmp.data"), info.date],
        [tr("ifccmp.elementi_vecchia"), A.els.size], [tr("ifccmp.elementi_nuova"), B.els.size], [tr("ifccmp.aggiunti"), counts.add], [tr("ifccmp.eliminati"), counts.del], [tr("ifccmp.geometria_modificata"), counts.geo], [tr("ifccmp.solo_proprieta_modificate"), counts.prop],
        [tr("ifccmp.uguali"), counts.same], [tr("ifccmp.differenze_proprieta"), nPropDiffs]] },
      { name: tr("ifccmp.elementi"), widths: [25, 22, 34, 22, 50, 12, 20], rows: [["GlobalId", tr("ifccmp.classe_ifc"), tr("common.nome"), tr("ifccmp.stato"), tr("ifccmp.geometria_2"), tr("ifccmp.proprieta_cambiate"), tr("ifccmp.piano")], ...elemRows()] },
      { name: tr("ifccmp.proprieta"), widths: [25, 22, 34, 28, 30, 30, 30], rows: [["GlobalId", tr("ifccmp.classe_ifc"), tr("common.nome"), tr("ifccmp.gruppo_pset"), tr("ifccmp.proprieta"), tr("ifccmp.valore_vecchio"), tr("ifccmp.valore_nuovo")], ...propRows()] },
    ]);
  }
  async function reportCsv() {
    const out = [["GlobalId", tr("ifccmp.classe_ifc"), tr("common.nome"), tr("ifccmp.stato"), tr("ifccmp.gruppo_pset"), tr("ifccmp.proprieta"), tr("ifccmp.valore_vecchio"), tr("ifccmp.valore_nuovo")]];
    for (const r of rows) {
      if (r.kind === "same") continue;
      if (r.kind !== "prop") out.push([r.gid, r.type, r.name, KIND_LABEL[r.kind], tr("ifccmp.geometria_2"), "", "", geomCell(r)]);
      for (const d of r.diffs) out.push([r.gid, r.type, r.name, KIND_LABEL[r.kind], d.g, d.p, d.o ?? "", d.n ?? ""]);
    }
    return csvBlob(out);
  }
  async function reportPdf() {
    const doc = pdfDoc();
    const p = doc.addPage(842, 595);
    const top = reportHeader(p, info, tr("ifccmp.confronto_modelli_ifc"));
    const lines = [tr("ifccmp.elementi_vecchia_0_nuova_1", A.els.size, B.els.size),
      tr("ifccmp.aggiunti_0_eliminati_1_geometria", counts.add, counts.del, counts.geo, counts.prop, counts.same), tr("ifccmp.differenze_proprieta_0", nPropDiffs)];
    lines.forEach((l, i) => p.text(24, top + 8 + i * 13, l, 9.5, { bold: i === 1 }));
    legend(p, 24, top + 54, ["add", "del", "geo", "prop"].map(k => [KCOL[k], KIND_LABEL[k]]).concat([[COL.same, tr("ifccmp.l_uguale")]]));
    // vista d'insieme a dimensione fissa, senza l'elemento selezionato evidenziato
    const keepSel = selRow, keepPos = camera.position.clone(), keepTgt = controls.target.clone(), keepDpr = renderer.getPixelRatio();
    if (keepSel) groups.get(keepSel)?.main?.traverse(o => { if (o.isMesh && o.userData.mat0) o.material = o.userData.mat0; });
    renderer.setPixelRatio(1);
    renderer.setSize(1600, 960, false);
    camera.aspect = 1600 / 960; camera.updateProjectionMatrix();
    frame(all);
    drawNow();
    const c = document.createElement("canvas");
    c.width = 1600; c.height = 960;
    c.getContext("2d").drawImage(renderer.domElement, 0, 0, 1600, 960);
    renderer.setPixelRatio(keepDpr);
    camera.position.copy(keepPos); controls.target.copy(keepTgt); controls.update();
    resize();
    if (keepSel) { selRow = null; select(keepSel, false); }
    const areaY = top + 66, f = Math.min((p.w - 48) / c.width, (p.h - areaY - 24) / c.height);
    p.image(await canvasJpeg(c, 0.9), c.width, c.height, (p.w - c.width * f) / 2, areaY, c.width * f, c.height * f);
    let pos = reportTable(doc, info, tr("ifccmp.elementi_cambiati"), [{ t: tr("ifccmp.stato"), w: 110 }, { t: tr("ifccmp.classe_ifc"), w: 110 }, { t: tr("common.nome"), w: 150 }, { t: "GlobalId", w: 140 }, { t: tr("ifccmp.geometria_2"), w: 230 }, { t: tr("ifccmp.prop"), w: 54 }],
      rows.filter(r => r.kind !== "same").map(r => ({ color: KCOL[r.kind], cells: [KIND_LABEL[r.kind], r.type, r.name, r.gid, geomCell(r), r.diffs.length || ""] })));
    if (nPropDiffs) reportTable(doc, info, tr("ifccmp.differenze_proprieta"), [{ t: tr("ifccmp.elemento"), w: 170 }, { t: tr("ifccmp.gruppo"), w: 130 }, { t: tr("ifccmp.proprieta"), w: 130 }, { t: tr("ifccmp.valore_vecchio"), w: 182 }, { t: tr("ifccmp.valore_nuovo"), w: 182 }],
      rows.flatMap(r => r.diffs.map(d => ({ color: KCOL[r.kind], cells: [`${r.type} ${r.name}`.trim(), d.g, d.p, d.o ?? "—", d.n ?? "—"] }))));
    footerNumbers(doc);
    return new Blob([doc.build(tr("ifccmp.confronto") + info.oldName + " - " + info.newName)], { type: "application/pdf" });
  }

  return {
    onShow() { resize(); },
    reportPdf, reportXlsx, reportCsv,
    _ic: { rows, counts, select, list, frame, A, B },
    dispose() {
      try { ifc.CloseModel(mA); ifc.CloseModel(mB); } catch { /* */ }
      root.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
      Object.values(MATS).forEach(m => m.dispose());
      renderer.dispose();
    },
  };
}

const tick = () => new Promise(r => setTimeout(r, 0));
const fmtN = v => (Math.abs(v) < 5e-4 ? 0 : v).toLocaleString(LOCALE, { maximumFractionDigits: 3 });
const fmtM = v => `${fmtN(v)} m`;
const dims = s => [s.x, s.z, s.y].map(fmtN).join(" × ");
const cellV = v => (typeof v === "string" && /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v) ? +v : v ?? ""); // numeri veri in Excel
