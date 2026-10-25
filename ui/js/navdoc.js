// File .mbvnav (JSON accanto al modello, come un NWF di Navisworks): viste salvate e test di interferenza con i risultati.
//   { format: "mbvnav", version: 1, app, saved, models: [nomi dei file della scena],
//     views: [{ guid, name, vi (punto di vista come nel BCF: ui/js/bcfview.js, coordinate del progetto), dist, thumb, created }],
//     clashTests: [test], takeoff: { groupBy } }
//   test = { guid, name, type: "hard"|"clearance"|"duplicate", tolerance (unita' della scena), skipSameModel, groupRadius,
//            setA/setB: { mode: "all"|"model"|"class"|"level"|"selection", values: [], items: [chiavi elemento] },
//            lastRun, stats: { candidates, elements, ms }, clashes: [clash] }
//   clash = { key, num, status, dist, point, a: { key, name, cls, model }, b, group, found, resolvedAt, assigned, note }
// Chiave di un elemento: "g:" + GlobalId IFC, oppure "p:" + percorso nella scena (modelli non IFC), come i componenti BCF.
// Modulo puro (senza DOM): lo usa anche il collaudo con Node.
export const FORMAT = "mbvnav";
const uid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16));

export function newDoc(models = []) {
  return { format: FORMAT, version: 1, app: "MB Desk", saved: "", models: [...models], views: [], clashTests: [], takeoff: { groupBy: "cls,type,level" } };
}

export function newTest(name, type = "hard", tolerance = 0.01) {
  return { guid: uid(), name, type, tolerance, skipSameModel: false, groupRadius: 0,
    setA: { mode: "all", values: [], items: [] }, setB: { mode: "all", values: [], items: [] }, lastRun: "", stats: null, clashes: [] };
}

export function serializeDoc(doc) {
  return JSON.stringify({ ...doc, saved: new Date().toISOString() }, (k, v) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1e6) / 1e6 : v), 1);
}

export function parseDoc(text) {
  const d = JSON.parse(typeof text === "string" ? text.replace(/^﻿/, "") : new TextDecoder().decode(text));
  if (!d || d.format !== FORMAT) throw new Error("not mbvnav");
  const out = { ...newDoc(), ...d };
  out.views = Array.isArray(d.views) ? d.views.filter(v => v && v.vi) : [];
  out.clashTests = (Array.isArray(d.clashTests) ? d.clashTests : []).map(t => ({ ...newTest(t.name || "Test"), ...t, clashes: Array.isArray(t.clashes) ? t.clashes : [] }));
  return out;
}

export { uid };
