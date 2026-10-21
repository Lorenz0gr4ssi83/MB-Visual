// Segnalazioni BIM in formato BCF (BIM Collaboration Format, buildingSMART): lettura di BCF 2.0, 2.1 e 3.0 (.bcfzip/.bcf)
// e scrittura in 2.1 o 3.0. Il modello in memoria e' unico per tutte le versioni:
//   store = { version, project: {id, name}, extensions: {types, statuses, priorities, labels, users, stages, snippetTypes},
//             topics: [topic], raw: {percorso: Uint8Array} (file non interpretati, es. documents.xml e Documents/, riscritti tali e quali) }
//   topic = { guid, serverId, type, status, title, priority, index, labels[], creationDate, creationAuthor, modifiedDate, modifiedAuthor,
//             dueDate, assignedTo, stage, description, referenceLinks[], files[{ifcProject, ifcSpatial, isExternal, filename, date, reference}],
//             bimSnippet, docRefs[], related[], comments[{guid, date, author, text, viewpoint, modifiedDate, modifiedAuthor}],
//             viewpoints[{guid, index, snapshot: Blob|null, snapshotName, vi}], raw: {nome: Uint8Array} }
//   vi (punto di vista) = { camera: {kind: "persp"|"ortho", pos, dir, up, fov, scale, aspect} | null, selection[comp],
//             visibility: {default, exceptions[comp]}, hints: {spaces, spaceBoundaries, openings}, coloring[{color, comps[comp]}],
//             lines[{a, b}], planes[{loc, dir}] }   comp = { ifcGuid, system, toolId }
// Coordinate in metri nel sistema del progetto (Z verso l'alto), come da specifica.
import { loadScript } from "./core.js";

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// valori standard (in inglese nei file, come li scrivono Revit, Navisworks, Solibri, BIMcollab) e nomi italiani mostrati
export const IT = {
  status: { Open: "Aperta", "In Progress": "In corso", InProgress: "In corso", Active: "Attiva", Resolved: "Risolta", Closed: "Chiusa", ReOpened: "Riaperta", Reopened: "Riaperta", Assigned: "Assegnata" },
  type: { Issue: "Problema", Clash: "Interferenza", Request: "Richiesta", Comment: "Commento", Error: "Errore", Warning: "Avviso", Info: "Informazione", Information: "Informazione",
    Fault: "Difetto", Inquiry: "Domanda", Remark: "Osservazione", Solution: "Soluzione", Undefined: "Non definito", Unknown: "Non definito" },
  priority: { Critical: "Critica", High: "Alta", Major: "Alta", Medium: "Media", Normal: "Normale", Low: "Bassa", Minor: "Bassa", "On hold": "In attesa" },
};
export const DEFAULTS = {
  statuses: ["Open", "In Progress", "Resolved", "Closed", "ReOpened"],
  types: ["Issue", "Clash", "Request", "Comment", "Error", "Fault", "Inquiry", "Remark", "Undefined"],
  priorities: ["Critical", "High", "Normal", "Low"],
};
export const tr = (kind, v) => (v ? IT[kind][v] || v : "");
// colore indicativo dello stato (aperta = rosso, in corso = arancio, risolta/chiusa = verde)
export function statusTone(s) {
  const k = (s || "").toLowerCase().replace(/\s/g, "");
  if (["closed", "resolved", "done", "chiusa", "risolta"].includes(k)) return "ok";
  if (["inprogress", "active", "assigned", "incorso"].includes(k)) return "warn";
  return "bad";
}

export function newStore() {
  return { version: "2.1", project: { id: uuid(), name: "" }, extensions: { types: [], statuses: [], priorities: [], labels: [], users: [], stages: [], snippetTypes: [] }, topics: [], raw: {} };
}
export function newTopic(author) {
  const d = nowIso();
  return { guid: uuid(), type: "Issue", status: "Open", title: "", priority: "Normal", labels: [], creationDate: d, creationAuthor: author || "", modifiedDate: "",
    modifiedAuthor: "", dueDate: "", assignedTo: "", stage: "", description: "", referenceLinks: [], files: [], bimSnippet: null, docRefs: [], related: [],
    comments: [], viewpoints: [], raw: {} };
}

// ---------------------------------------------------------------- XML
const kids = (n, name) => (n ? [...n.children].filter(c => c.localName === name) : []);
const kid = (n, name) => kids(n, name)[0] || null;
const txt = (n, name) => { const k = kid(n, name); return k ? k.textContent.trim() : ""; };
const attr = (n, ...names) => { for (const a of names) if (n?.hasAttribute(a)) return n.getAttribute(a); return ""; };
const bool = (v, def) => (v === "" || v == null ? def : /^(true|1)$/i.test(v));
const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
const vec = n => (n ? [num(txt(n, "X")), num(txt(n, "Y")), num(txt(n, "Z"))] : null);
// elementi ripetuti direttamente (2.1) oppure dentro un contenitore (3.0)
const listOf = (n, wrapper, name) => [...kids(n, name), ...kids(kid(n, wrapper), name)];

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ""), "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("XML non valido");
  return doc.documentElement;
}
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tag = (name, value, attrs = "") => (value === "" || value == null ? "" : `<${name}${attrs}>${esc(value)}</${name}>`);
const fnum = v => (Math.abs(v) < 1e-12 ? "0" : String(+(+v).toPrecision(15)));
const xyz = (name, v) => `<${name}><X>${fnum(v[0])}</X><Y>${fnum(v[1])}</Y><Z>${fnum(v[2])}</Z></${name}>`;
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// GUID in scrittura: minuscoli (BCF 3.0 li vuole cosi'); quelli malformati dei file d'origine diventano GUID nuovi, sempre gli stessi nel file
let G = g => g;
function guidMapper() {
  const map = new Map();
  return g => {
    if (!g) return g;
    const k = String(g).trim();
    if (!map.has(k)) map.set(k, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k) ? k.toLowerCase() : uuid());
    return map.get(k);
  };
}
const colorHex = c => { const x = String(c || "").replace(/^#/, "").toUpperCase(); return /^[0-9A-F]{6}([0-9A-F]{2})?$/.test(x) ? x : "FF0000"; };

async function jszip() { await loadScript("/vendor/jszip/dist/jszip.min.js"); return window.JSZip; }
const dec = b => new TextDecoder().decode(b);

// ---------------------------------------------------------------- lettura
export async function readBcf(bytes) {
  const Z = await jszip();
  let zip;
  try { zip = await Z.loadAsync(bytes); } catch { throw new Error("Il file non e' un archivio BCF (zip) valido"); }
  const all = {};
  zip.forEach((p, f) => { if (!f.dir) all[p.replace(/\\/g, "/")] = f; });
  // alcuni programmi mettono tutto in una cartella: la radice e' quella che contiene bcf.version o le cartelle con markup.bcf
  const verPath = Object.keys(all).find(p => /(^|\/)bcf\.version$/i.test(p));
  const markups = Object.keys(all).filter(p => /(^|\/)markup\.bcf$/i.test(p));
  if (!verPath && !markups.length) throw new Error("Nell'archivio non ci sono segnalazioni BCF (manca markup.bcf)");
  const prefix = verPath ? verPath.replace(/bcf\.version$/i, "") : markups[0].replace(/[^/]+\/markup\.bcf$/i, "");
  const files = {};
  for (const [p, f] of Object.entries(all)) if (p.startsWith(prefix)) files[p.slice(prefix.length)] = f;
  const used = new Set();
  const read = async p => { used.add(p); return new Uint8Array(await files[p].async("uint8array")); };
  const readText = async p => dec(await read(p));
  const findCI = p => Object.keys(files).find(k => k.toLowerCase() === p.toLowerCase());

  const store = newStore();
  store.version = "2.1";
  const vp = findCI("bcf.version");
  if (vp) {
    try {
      const v = parseXml(await readText(vp));
      store.version = (attr(v, "VersionId") || txt(v, "DetailedVersion") || "2.1").trim();
    } catch { /* versione illeggibile: si prova come 2.1 */ }
  }
  const pp = findCI("project.bcfp");
  if (pp) {
    try {
      const r = parseXml(await readText(pp));
      const pr = kid(r, "Project");
      if (pr) store.project = { id: attr(pr, "ProjectId") || store.project.id, name: txt(pr, "Name") };
    } catch { /* facoltativo */ }
  }
  const ep = findCI("extensions.xml");
  if (ep) {
    try {
      const r = parseXml(await readText(ep));
      const L = (w, n) => kids(kid(r, w), n).map(e => e.textContent.trim()).filter(Boolean);
      store.extensions = { types: L("TopicTypes", "TopicType"), statuses: L("TopicStatuses", "TopicStatus"), priorities: L("Priorities", "Priority"),
        labels: L("TopicLabels", "TopicLabel"), users: L("Users", "User"), stages: L("Stages", "Stage"), snippetTypes: L("SnippetTypes", "SnippetType") };
    } catch { /* facoltativo */ }
  }
  if (findCI("extensions.xsd")) used.add(findCI("extensions.xsd")); // schema 2.1 delle estensioni: si rigenera se serve

  for (const mp of Object.keys(files).filter(p => /^[^/]+\/markup\.bcf$/i.test(p))) {
    const dir = mp.replace(/markup\.bcf$/i, "");
    let topic;
    try { topic = parseMarkup(parseXml(await readText(mp))); } catch (e) { console.warn("BCF: segnalazione illeggibile", mp, e); continue; }
    if (!topic.guid) topic.guid = dir.slice(0, -1);
    // punti di vista elencati (2.1/3.0) oppure, nei file vecchi, viewpoint.bcfv + snapshot.png senza elenco
    if (!topic.viewpoints.length) {
      const v = findCI(dir + "viewpoint.bcfv"), s = findCI(dir + "snapshot.png");
      if (v || s) topic.viewpoints.push({ guid: uuid(), file: v ? v.slice(dir.length) : "", snapshotName: s ? s.slice(dir.length) : "" });
    }
    for (const v of topic.viewpoints) {
      const vf = v.file && findCI(dir + v.file);
      if (vf) { try { v.vi = parseVisinfo(parseXml(await readText(vf))); if (v.vi.guid && !v.guidFromMarkup) v.guid = v.vi.guid; } catch (e) { console.warn("BCF: punto di vista illeggibile", vf, e); } }
      v.vi = v.vi || emptyVi();
      delete v.vi.guid;
      const sf = v.snapshotName && findCI(dir + v.snapshotName);
      v.snapshot = null;
      if (sf) { const b = await read(sf); v.snapshot = new Blob([b], { type: /\.jpe?g$/i.test(sf) ? "image/jpeg" : "image/png" }); }
      delete v.file;
      delete v.guidFromMarkup;
    }
    used.add(mp);
    topic.raw = {};
    for (const p of Object.keys(files)) if (p.startsWith(dir) && !used.has(p)) { topic.raw[p.slice(dir.length)] = await read(p); used.add(p); }
    store.topics.push(topic);
  }
  for (const p of Object.keys(files)) if (!used.has(p) && !/^(bcf\.version|project\.bcfp|extensions\.xml)$/i.test(p)) store.raw[p] = await read(p);
  store.topics.sort((a, b) => (a.index ?? 1e9) - (b.index ?? 1e9) || (a.serverId && b.serverId ? +a.serverId - +b.serverId : 0) || String(a.creationDate).localeCompare(String(b.creationDate)));
  return store;
}

function parseMarkup(m) {
  const t = kid(m, "Topic");
  if (!t) throw new Error("markup senza Topic");
  const head = kid(m, "Header");
  const fileEls = [...kids(head, "File"), ...kids(kid(head, "Files"), "File")];
  const labels = [];
  for (const L of kids(t, "Labels")) { const ls = kids(L, "Label"); if (ls.length) ls.forEach(x => labels.push(x.textContent.trim())); else if (L.textContent.trim()) labels.push(L.textContent.trim()); }
  const snip = kid(t, "BimSnippet");
  const topic = {
    guid: attr(t, "Guid"), serverId: attr(t, "ServerAssignedId"), type: attr(t, "TopicType"), status: attr(t, "TopicStatus"),
    title: txt(t, "Title"), priority: txt(t, "Priority"), index: txt(t, "Index") ? parseInt(txt(t, "Index"), 10) : undefined, labels,
    creationDate: txt(t, "CreationDate"), creationAuthor: txt(t, "CreationAuthor"), modifiedDate: txt(t, "ModifiedDate"), modifiedAuthor: txt(t, "ModifiedAuthor"),
    dueDate: txt(t, "DueDate"), assignedTo: txt(t, "AssignedTo"), stage: txt(t, "Stage"), description: kid(t, "Description")?.textContent || "",
    referenceLinks: listOf(t, "ReferenceLinks", "ReferenceLink").map(e => e.textContent.trim()).filter(Boolean),
    files: fileEls.map(f => ({ ifcProject: attr(f, "IfcProject"), ifcSpatial: attr(f, "IfcSpatialStructureElement"), isExternal: bool(attr(f, "IsExternal", "isExternal"), true),
      filename: txt(f, "Filename"), date: txt(f, "Date"), reference: txt(f, "Reference") })),
    bimSnippet: snip ? { type: attr(snip, "SnippetType"), isExternal: bool(attr(snip, "IsExternal", "isExternal"), false), reference: txt(snip, "Reference"), schema: txt(snip, "ReferenceSchema") } : null,
    docRefs: listOf(t, "DocumentReferences", "DocumentReference").map(d => ({ guid: attr(d, "Guid") || uuid(), isExternal: bool(attr(d, "isExternal", "IsExternal"), false),
      referencedDocument: txt(d, "ReferencedDocument"), documentGuid: txt(d, "DocumentGuid"), url: txt(d, "Url"), description: txt(d, "Description") })),
    related: listOf(t, "RelatedTopics", "RelatedTopic").map(r => attr(r, "Guid")).filter(Boolean),
    // commenti: in 2.x accanto al Topic, in 3.0 dentro <Comments>
    comments: [...kids(m, "Comment"), ...kids(kid(t, "Comments"), "Comment")].map(c => ({
      guid: attr(c, "Guid") || uuid(), date: txt(c, "Date"), author: txt(c, "Author"), text: kid(c, "Comment")?.textContent || "",
      viewpoint: attr(kid(c, "Viewpoint"), "Guid"), modifiedDate: txt(c, "ModifiedDate"), modifiedAuthor: txt(c, "ModifiedAuthor"),
      status: txt(c, "Status"), // BCF 2.0: stato nel commento
    })),
    viewpoints: [...kids(m, "Viewpoints"), ...kids(kid(t, "Viewpoints"), "ViewPoint")].map(v => ({
      guid: attr(v, "Guid") || uuid(), guidFromMarkup: !!attr(v, "Guid"), file: txt(v, "Viewpoint"), snapshotName: txt(v, "Snapshot"),
      index: txt(v, "Index") ? parseInt(txt(v, "Index"), 10) : undefined,
    })),
  };
  // BCF 2.0: stato e tipo potevano stare solo nell'ultimo commento
  if (!topic.status) { const c = topic.comments.filter(x => x.status).pop(); if (c) topic.status = c.status; }
  topic.comments.forEach(c => delete c.status);
  topic.viewpoints.sort((a, b) => (a.index ?? 1e9) - (b.index ?? 1e9));
  topic.comments.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return topic;
}

export function emptyVi() {
  return { camera: null, selection: [], visibility: { default: true, exceptions: [] }, hints: { spaces: false, spaceBoundaries: false, openings: false }, coloring: [], lines: [], planes: [] };
}
const comp = c => ({ ifcGuid: attr(c, "IfcGuid"), system: txt(c, "OriginatingSystem"), toolId: txt(c, "AuthoringToolId") });

function parseVisinfo(r) {
  const vi = emptyVi();
  vi.guid = attr(r, "Guid");
  const C = kid(r, "Components");
  if (C) {
    const legacy = kids(C, "Component"); // BCF 2.0: un elenco unico con Selected / Visible / Color
    if (legacy.length) {
      vi.selection = legacy.filter(c => bool(attr(c, "Selected"), false)).map(comp);
      vi.visibility.exceptions = legacy.filter(c => !bool(attr(c, "Visible"), true)).map(comp);
      const byColor = new Map();
      for (const c of legacy) { const col = attr(c, "Color"); if (col) { if (!byColor.has(col)) byColor.set(col, []); byColor.get(col).push(comp(c)); } }
      vi.coloring = [...byColor].map(([color, comps]) => ({ color, comps }));
      vi.visibility.default = true;
    }
    vi.selection.push(...kids(kid(C, "Selection"), "Component").map(comp));
    const V = kid(C, "Visibility");
    if (V) {
      // attributo assente: si mostra tutto (lo schema 3.0 direbbe false, ma i file reali che lo omettono intendono "tutto visibile")
      vi.visibility.default = bool(attr(V, "DefaultVisibility"), true);
      vi.visibility.exceptions.push(...kids(kid(V, "Exceptions"), "Component").map(comp));
    }
    const H = kid(V, "ViewSetupHints") || kid(C, "ViewSetupHints");
    if (H) vi.hints = { spaces: bool(attr(H, "SpacesVisible"), false), spaceBoundaries: bool(attr(H, "SpaceBoundariesVisible"), false), openings: bool(attr(H, "OpeningsVisible"), false) };
    for (const col of kids(kid(C, "Coloring"), "Color")) {
      vi.coloring.push({ color: attr(col, "Color"), comps: [...kids(col, "Component"), ...kids(kid(col, "Components"), "Component")].map(comp) });
    }
  }
  const P = kid(r, "PerspectiveCamera"), O = kid(r, "OrthogonalCamera"), cam = P || O;
  if (cam) {
    vi.camera = { kind: P ? "persp" : "ortho", pos: vec(kid(cam, "CameraViewPoint")), dir: vec(kid(cam, "CameraDirection")), up: vec(kid(cam, "CameraUpVector")) || [0, 0, 1],
      fov: P ? num(txt(P, "FieldOfView")) || 60 : undefined, scale: O ? num(txt(O, "ViewToWorldScale")) || 1 : undefined, aspect: num(txt(cam, "AspectRatio")) || undefined };
  }
  vi.lines = kids(kid(r, "Lines"), "Line").map(l => ({ a: vec(kid(l, "StartPoint")), b: vec(kid(l, "EndPoint")) }));
  vi.planes = kids(kid(r, "ClippingPlanes"), "ClippingPlane").map(p => ({ loc: vec(kid(p, "Location")), dir: vec(kid(p, "Direction")) }));
  return vi;
}

// ---------------------------------------------------------------- scrittura
export async function writeBcf(store, version = store.version) {
  const v3 = String(version).startsWith("3");
  const Z = await jszip();
  G = guidMapper();
  const zip = new Z();
  zip.file("bcf.version", v3 ? HEAD + '<Version VersionId="3.0"/>\n'
    : HEAD + '<Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>\n');
  const pr = store.project || {};
  if (v3) zip.file("project.bcfp", HEAD + `<ProjectInfo><Project ProjectId="${esc(pr.id || uuid())}">${tag("Name", pr.name)}</Project></ProjectInfo>\n`);
  else zip.file("project.bcfp", HEAD + `<ProjectExtension><Project ProjectId="${esc(pr.id || uuid())}">${tag("Name", pr.name)}</Project><ExtensionSchema></ExtensionSchema></ProjectExtension>\n`);
  if (v3) {
    // in BCF 3.0 i valori ammessi stanno in extensions.xml: si uniscono quelli del file d'origine e quelli usati
    const ex = store.extensions || {};
    const uniq = (a, b) => [...new Set([...(a || []), ...b.filter(Boolean)])];
    const T = store.topics;
    const lists = [["TopicTypes", "TopicType", uniq(ex.types, T.map(t => t.type))], ["TopicStatuses", "TopicStatus", uniq(ex.statuses, T.map(t => t.status))],
      ["Priorities", "Priority", uniq(ex.priorities, T.map(t => t.priority))], ["TopicLabels", "TopicLabel", uniq(ex.labels, T.flatMap(t => t.labels))],
      ["Users", "User", uniq(ex.users, T.flatMap(t => [t.assignedTo, t.creationAuthor, t.modifiedAuthor, ...t.comments.map(c => c.author)]))],
      ["SnippetTypes", "SnippetType", uniq(ex.snippetTypes, T.map(t => t.bimSnippet?.type))], ["Stages", "Stage", uniq(ex.stages, T.map(t => t.stage))]];
    zip.file("extensions.xml", HEAD + "<Extensions>" + lists.map(([w, n, l]) => `<${w}>${l.map(x => tag(n, x)).join("")}</${w}>`).join("") + "</Extensions>\n");
  }
  for (const [p, b] of Object.entries(store.raw || {})) if (!(!v3 && /^documents\.xml$/i.test(p))) zip.file(p, b);
  store.topics.forEach((t, i) => {
    const dir = zip.folder(G(t.guid));
    const names = t.viewpoints.map((v, k) => ({
      vp: k === 0 ? "viewpoint.bcfv" : `viewpoint_${G(v.guid)}.bcfv`,
      snap: v.snapshot ? (k === 0 ? "snapshot" : `snapshot_${G(v.guid)}`) + (v.snapshot.type === "image/jpeg" ? ".jpg" : ".png") : "",
    }));
    dir.file("markup.bcf", markupXml(t, v3, names, i));
    t.viewpoints.forEach((v, k) => {
      dir.file(names[k].vp, visinfoXml(v.vi || emptyVi(), G(v.guid), v3));
      if (v.snapshot) dir.file(names[k].snap, v.snapshot);
    });
    for (const [n, b] of Object.entries(t.raw || {})) if (!/^(viewpoint|snapshot)[^/]*\.(bcfv|png|jpe?g)$/i.test(n)) dir.file(n, b);
  });
  return zip.generateAsync({ type: "blob", compression: "DEFLATE", mimeType: "application/octet-stream" });
}

function markupXml(t, v3, names, i) {
  const files = (t.files || []).map(f => `<File${f.ifcProject ? ` IfcProject="${esc(f.ifcProject)}"` : ""}${f.ifcSpatial ? ` IfcSpatialStructureElement="${esc(f.ifcSpatial)}"` : ""} ${v3 ? "IsExternal" : "isExternal"}="${f.isExternal !== false}">`
    + tag("Filename", f.filename) + tag("Date", f.date) + tag("Reference", f.reference) + "</File>").join("");
  const header = files ? `<Header>${v3 ? `<Files>${files}</Files>` : files}</Header>` : "";
  const snip = t.bimSnippet ? `<BimSnippet SnippetType="${esc(t.bimSnippet.type)}" ${v3 ? "IsExternal" : "isExternal"}="${!!t.bimSnippet.isExternal}">${tag("Reference", t.bimSnippet.reference)}${tag("ReferenceSchema", t.bimSnippet.schema)}</BimSnippet>` : "";
  const docs = (t.docRefs || []).map(d => v3
    ? `<DocumentReference Guid="${esc(G(d.guid))}">${d.documentGuid ? tag("DocumentGuid", d.documentGuid) : tag("Url", d.url || d.referencedDocument)}${tag("Description", d.description)}</DocumentReference>`
    : `<DocumentReference Guid="${esc(G(d.guid))}" isExternal="${!!(d.isExternal || d.url)}">${tag("ReferencedDocument", d.referencedDocument || d.url || (d.documentGuid ? "../Documents/" + d.documentGuid : ""))}${tag("Description", d.description)}</DocumentReference>`).join("");
  const rel = (t.related || []).map(g => `<RelatedTopic Guid="${esc(G(g))}"/>`).join("");
  const comments = (t.comments || []).map(c => `<Comment Guid="${esc(G(c.guid))}">${tag("Date", c.date || nowIso())}${tag("Author", c.author || "-")}${v3 ? tag("Comment", c.text) : `<Comment>${esc(c.text)}</Comment>`}`
    + (c.viewpoint ? `<Viewpoint Guid="${esc(G(c.viewpoint))}"/>` : "") + tag("ModifiedDate", c.modifiedDate) + tag("ModifiedAuthor", c.modifiedAuthor) + "</Comment>").join("");
  const vps = (t.viewpoints || []).map((v, k) => `<${v3 ? "ViewPoint" : "Viewpoints"} Guid="${esc(G(v.guid))}">${tag("Viewpoint", names[k].vp)}${tag("Snapshot", names[k].snap)}<Index>${k}</Index></${v3 ? "ViewPoint" : "Viewpoints"}>`).join("");
  const labels = v3 ? (t.labels.length ? `<Labels>${t.labels.map(l => tag("Label", l)).join("")}</Labels>` : "") : t.labels.map(l => tag("Labels", l)).join("");
  const links = v3 ? (t.referenceLinks.length ? `<ReferenceLinks>${t.referenceLinks.map(l => tag("ReferenceLink", l)).join("")}</ReferenceLinks>` : "") : t.referenceLinks.map(l => tag("ReferenceLink", l)).join("");
  const topic = `<Topic Guid="${esc(G(t.guid))}"${t.serverId && v3 ? ` ServerAssignedId="${esc(t.serverId)}"` : ""} TopicType="${esc(t.type || "Issue")}" TopicStatus="${esc(t.status || "Open")}">`
    + links + `<Title>${esc(t.title || "Senza titolo")}</Title>` + tag("Priority", t.priority) + `<Index>${t.index ?? i}</Index>` + labels
    + tag("CreationDate", t.creationDate || nowIso()) + tag("CreationAuthor", t.creationAuthor || "-") + tag("ModifiedDate", t.modifiedDate) + tag("ModifiedAuthor", t.modifiedAuthor)
    + tag("DueDate", t.dueDate) + tag("AssignedTo", t.assignedTo) + tag("Stage", t.stage) + tag("Description", t.description) + snip
    + (v3 ? (docs ? `<DocumentReferences>${docs}</DocumentReferences>` : "") + (rel ? `<RelatedTopics>${rel}</RelatedTopics>` : "") + (comments ? `<Comments>${comments}</Comments>` : "") + (vps ? `<Viewpoints>${vps}</Viewpoints>` : "") : docs + rel)
    + "</Topic>";
  return HEAD + `<Markup>${header}${topic}${v3 ? "" : comments + vps}</Markup>\n`;
}

function compXml(c) {
  return `<Component${c.ifcGuid ? ` IfcGuid="${esc(c.ifcGuid)}"` : ""}>${tag("OriginatingSystem", c.system)}${tag("AuthoringToolId", c.toolId)}</Component>`;
}
function visinfoXml(vi, guid, v3) {
  const h = vi.hints || {};
  const hints = `<ViewSetupHints SpacesVisible="${!!h.spaces}" SpaceBoundariesVisible="${!!h.spaceBoundaries}" OpeningsVisible="${!!h.openings}"/>`;
  const sel = vi.selection?.length ? `<Selection>${vi.selection.map(compXml).join("")}</Selection>` : "";
  const ex = vi.visibility?.exceptions?.length ? `<Exceptions>${vi.visibility.exceptions.map(compXml).join("")}</Exceptions>` : "";
  const vis = `<Visibility DefaultVisibility="${vi.visibility?.default !== false}">${v3 ? hints : ""}${ex}</Visibility>`;
  const col = vi.coloring?.length ? `<Coloring>${vi.coloring.map(c => `<Color Color="${colorHex(c.color)}">${v3 ? `<Components>${c.comps.map(compXml).join("")}</Components>` : c.comps.map(compXml).join("")}</Color>`).join("")}</Coloring>` : "";
  const comps = `<Components>${v3 ? "" : hints}${sel}${vis}${col}</Components>`;
  let cam = "";
  const c = vi.camera;
  if (c) {
    const base = xyz("CameraViewPoint", c.pos) + xyz("CameraDirection", c.dir) + xyz("CameraUpVector", c.up);
    const aspect = v3 ? `<AspectRatio>${fnum(c.aspect || 1.6)}</AspectRatio>` : "";
    cam = c.kind === "ortho" ? `<OrthogonalCamera>${base}<ViewToWorldScale>${fnum(c.scale || 1)}</ViewToWorldScale>${aspect}</OrthogonalCamera>`
      : `<PerspectiveCamera>${base}<FieldOfView>${fnum(v3 ? Math.min(179, Math.max(1, c.fov || 60)) : Math.min(60, Math.max(45, c.fov || 60)))}</FieldOfView>${aspect}</PerspectiveCamera>`;
  }
  const lines = vi.lines?.length ? `<Lines>${vi.lines.map(l => `<Line>${xyz("StartPoint", l.a)}${xyz("EndPoint", l.b)}</Line>`).join("")}</Lines>` : "";
  const planes = vi.planes?.length ? `<ClippingPlanes>${vi.planes.map(p => `<ClippingPlane>${xyz("Location", p.loc)}${xyz("Direction", p.dir)}</ClippingPlane>`).join("")}</ClippingPlanes>` : "";
  return HEAD + `<VisualizationInfo Guid="${esc(guid)}">${comps}${cam}${lines}${planes}</VisualizationInfo>\n`;
}

// ---------------------------------------------------------------- utilita' per l'interfaccia
// data senza ora (scadenze: "2026-10-01" o "2026-10-01T00:00:00Z") = quel giorno, in qualunque fuso orario
export function dayOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(T00:00(:00(\.0+)?)?(Z|[+-]00:?00)?)?$/.exec(iso || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
export function dateIt(iso, withTime = false) {
  if (!iso) return "";
  const day = dayOf(iso);
  if (day) return day.toLocaleDateString("it-IT");
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return withTime ? d.toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : d.toLocaleDateString("it-IT");
}
export const isOverdue = t => !!t.dueDate && statusTone(t.status) !== "ok" && (dayOf(t.dueDate) || new Date(t.dueDate)) < new Date(new Date().toDateString());
