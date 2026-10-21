// Segnalazioni BIM in formato BCF (.bcfzip / .bcf) aperte da sole: elenco, schede, commenti e istantanee; modifica e salvataggio;
// "Sovrapponi al modello" le porta nel visualizzatore 3D (IFC aperto o indicato nel BCF) per ripristinare i punti di vista.
import { api, button, dirName, el, loading, modal, pickFiles, readBytes, toast, WEB } from "../core.js";
import { readBcf, writeBcf } from "../bcf.js";
import { createPanel } from "../bcfpanel.js";

const MODEL_EXTS = /\.(ifc|nwd|nwc|stp|step|igs|iges|glb|gltf|obj|stl|fbx|3dm)$/i;

export async function mount(ctx) {
  const ld = loading(ctx.el, "Lettura delle segnalazioni BCF");
  const store = await readBcf(await readBytes(ctx.path));
  ld.set(1);
  ctx.el.innerHTML = "";
  ctx.fillBody(true);
  const preview = el("div", { class: "bcf-preview" }, "Seleziona una segnalazione per vedere l'istantanea");
  let shownUrl = null;
  const panel = createPanel({
    store, path: ctx.path, baseName: ctx.name, dir: dirName(ctx.path),
    onDirty: v => ctx.setDirty(v),
    onPreview(v) {
      if (shownUrl) URL.revokeObjectURL(shownUrl);
      shownUrl = v?.snapshot ? URL.createObjectURL(v.snapshot) : null;
      preview.innerHTML = "";
      preview.append(shownUrl ? el("img", { src: shownUrl, alt: "Istantanea" }) : el("span", {}, "Punto di vista senza istantanea"));
    },
    async onSaved(target) {
      // salvato da MB Visual: non deve sembrare una modifica fatta da un altro programma
      if (target !== ctx.path || WEB) return;
      try { const s = await api("stat", { path: target }); ctx.info.modificato = s.modificato; ctx.info.size = s.size; } catch { /* */ }
    },
  });
  ctx.el.append(el("div", { class: "bcf-standalone" }, panel.el, preview));
  const status = () => ctx.status(`${panel.store.topics.length} segnalazioni · BCF ${panel.store.version}`);
  status();

  // ---- sovrapposizione a un modello 3D
  async function overlay() {
    const tabs3d = (window.MB?.tabs || []).filter(t => t.viewer === "model3d" && t.api?._bcf);
    const dir = dirName(ctx.path);
    const names = [...new Set(panel.store.topics.flatMap(t => t.files.map(f => f.filename)).filter(n => n && MODEL_EXTS.test(n)))];
    const found = [];
    if (!WEB) for (const n of names) { const p = dir + "\\" + n.split(/[\\/]/).pop(); try { await api("stat", { path: p }); found.push(p); } catch { /* non c'e' */ } }
    const choices = [...tabs3d.map(t => ({ label: "Modello aperto: " + t.name, tab: t })), ...found.filter(p => !tabs3d.some(t => t.path === p)).map(p => ({ label: "Apri " + p.split(/[\\/]/).pop() + " (indicato nel BCF)", path: p })),
      { label: "Scegli un altro modello (IFC, Navisworks, STEP...)", pick: true }];
    let ch = choices[0];
    if (choices.length > 1) {
      const radios = choices.map((c, i) => el("label", { style: { display: "flex", gap: "6px", alignItems: "center", margin: "4px 0" } }, el("input", { type: "radio", name: "bcf-ov", value: String(i), checked: i === 0 }), c.label));
      const box = el("div", {}, el("p", {}, "Su quale modello mostrare le segnalazioni?"), ...radios);
      const r = await modal("Sovrapponi al modello", box, [{ label: "Annulla", value: null }, { label: "Sovrapponi", primary: true, value: () => box.querySelector("input:checked")?.value }]);
      if (r == null) return;
      ch = choices[+r];
    }
    let path = ch.path;
    if (ch.pick) { path = (await pickFiles())?.[0]; if (!path) return; }
    let tab = ch.tab;
    if (!tab) {
      await window.MB.openFile(path);
      tab = window.MB.tabs.find(t => t.path === path);
      if (!tab?.api?._bcf) return toast("Il file scelto non si e' aperto come modello 3D", true);
    }
    // copia: il pannello del modello lavora sulle sue segnalazioni e salva nello stesso file BCF
    await tab.api._bcf.load(structuredClone(panel.store), panel.path && !panel.path.startsWith("download://") ? panel.path : null);
    window.MB.activate(tab);
    if (panel.dirty) toast("Nel modello ci sono anche le modifiche non ancora salvate fatte qui", false, 4000);
  }
  ctx.tb.append(button("Sovrapponi al modello", "cube", overlay, { title: "Mostra le segnalazioni sul modello 3D (IFC o altro) e ripristina i punti di vista" }));

  return {
    saveInPlace: true,
    saveFormats: ["bcfzip", "bcf"],
    saveLabels: { bcfzip: "Segnalazioni BCF (.bcfzip)", bcf: "Segnalazioni BCF (.bcf)" },
    async save(target) {
      const blob = await writeBcf(panel.store, panel.store.version.startsWith("3") ? "3.0" : "2.1");
      await api("save", { path: target }, { body: new Uint8Array(await blob.arrayBuffer()) });
      panel.setStore(panel.store, target);
      status();
    },
    renamed() { status(); },
    dispose() { panel.dispose(); if (shownUrl) URL.revokeObjectURL(shownUrl); },
  };
}
