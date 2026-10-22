// Segnalazioni BIM in formato BCF (.bcfzip / .bcf) aperte da sole: elenco, schede, commenti e istantanee; modifica e salvataggio;
// "Sovrapponi al modello" le porta nel visualizzatore 3D (IFC aperto o indicato nel BCF) per ripristinare i punti di vista.
import { t as tr } from "../i18n.js";
import { api, button, dirName, el, loading, modal, pickFiles, readBytes, toast, WEB } from "../core.js";
import { readBcf, writeBcf } from "../bcf.js";
import { createPanel } from "../bcfpanel.js";

const MODEL_EXTS = /\.(ifc|nwd|nwc|stp|step|igs|iges|glb|gltf|obj|stl|fbx|3dm)$/i;

export async function mount(ctx) {
  const ld = loading(ctx.el, tr("v_bcf.lettura_segnalazioni_bcf"));
  const store = await readBcf(await readBytes(ctx.path));
  ld.set(1);
  ctx.el.innerHTML = "";
  ctx.fillBody(true);
  const preview = el("div", { class: "bcf-preview" }, tr("v_bcf.seleziona_segnalazione_vedere_l_istantanea"));
  let shownUrl = null;
  const panel = createPanel({
    store, path: ctx.path, baseName: ctx.name, dir: dirName(ctx.path),
    onDirty: v => ctx.setDirty(v),
    onPreview(v) {
      if (shownUrl) URL.revokeObjectURL(shownUrl);
      shownUrl = v?.snapshot ? URL.createObjectURL(v.snapshot) : null;
      preview.innerHTML = "";
      preview.append(shownUrl ? el("img", { src: shownUrl, alt: tr("v_bcf.istantanea") }) : el("span", {}, tr("v_bcf.punto_vista_senza_istantanea")));
    },
    async onSaved(target) {
      // salvato da MB Visual: non deve sembrare una modifica fatta da un altro programma
      if (target !== ctx.path || WEB) return;
      try { const s = await api("stat", { path: target }); ctx.info.modificato = s.modificato; ctx.info.size = s.size; } catch { /* */ }
    },
  });
  ctx.el.append(el("div", { class: "bcf-standalone" }, panel.el, preview));
  const status = () => ctx.status(tr("v_bcf.0_segnalazioni_bcf_1", panel.store.topics.length, panel.store.version));
  status();

  // ---- sovrapposizione a un modello 3D
  async function overlay() {
    const tabs3d = (window.MB?.tabs || []).filter(t => t.viewer === "model3d" && t.api?._bcf);
    const dir = dirName(ctx.path);
    const names = [...new Set(panel.store.topics.flatMap(t => t.files.map(f => f.filename)).filter(n => n && MODEL_EXTS.test(n)))];
    const found = [];
    if (!WEB) for (const n of names) { const p = dir + "\\" + n.split(/[\\/]/).pop(); try { await api("stat", { path: p }); found.push(p); } catch { /* non c'e' */ } }
    const choices = [...tabs3d.map(t => ({ label: tr("v_bcf.modello_aperto_0", t.name), tab: t })), ...found.filter(p => !tabs3d.some(t => t.path === p)).map(p => ({ label: tr("v_bcf.apri_0_indicato_bcf", p.split(/[\\/]/).pop()), path: p })),
      { label: tr("v_bcf.scegli_altro_modello_ifc_navisworks"), pick: true }];
    let ch = choices[0];
    if (choices.length > 1) {
      const radios = choices.map((c, i) => el("label", { style: { display: "flex", gap: "6px", alignItems: "center", margin: "4px 0" } }, el("input", { type: "radio", name: "bcf-ov", value: String(i), checked: i === 0 }), c.label));
      const box = el("div", {}, el("p", {}, tr("v_bcf.quale_modello_mostrare_segnalazioni")), ...radios);
      const r = await modal(tr("v_bcf.sovrapponi_modello"), box, [{ label: tr("common.annulla"), value: null }, { label: tr("v_bcf.sovrapponi"), primary: true, value: () => box.querySelector("input:checked")?.value }]);
      if (r == null) return;
      ch = choices[+r];
    }
    let path = ch.path;
    if (ch.pick) { path = (await pickFiles())?.[0]; if (!path) return; }
    let tab = ch.tab;
    if (!tab) {
      await window.MB.openFile(path);
      tab = window.MB.tabs.find(t => t.path === path);
      if (!tab?.api?._bcf) return toast(tr("v_bcf.file_scelto_non_si_aperto"), true);
    }
    // copia: il pannello del modello lavora sulle sue segnalazioni e salva nello stesso file BCF
    await tab.api._bcf.load(structuredClone(panel.store), panel.path && !panel.path.startsWith("download://") ? panel.path : null);
    window.MB.activate(tab);
    if (panel.dirty) toast(tr("v_bcf.modello_ci_sono_anche_modifiche"), false, 4000);
  }
  ctx.tb.append(button(tr("v_bcf.sovrapponi_modello"), "cube", overlay, { title: tr("v_bcf.mostra_segnalazioni_modello_3d_ifc") }));

  return {
    saveInPlace: true,
    saveFormats: ["bcfzip", "bcf"],
    saveLabels: { bcfzip: tr("v_bcf.segnalazioni_bcf_bcfzip"), bcf: tr("v_bcf.segnalazioni_bcf_bcf") },
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
