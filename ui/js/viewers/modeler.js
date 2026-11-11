// Modello 3D di solidi (.mbmod) e modifica dei modelli aperti: ui/js/modeler/mapp.js con il motore OpenCascade
// dell'app per PC. Nella web app (telefono) e senza il motore il modello si vede soltanto: anteprima glTF salvata nel file.
import { api, el, loadScript, readBytes, WEB } from "../core.js";
import { t as tr } from "../i18n.js";
import { loadCss } from "../core.js";

const SAVE = ["mbmod", "step", "stp", "iges", "igs", "brep", "dxf", ...(WEB ? [] : ["dwg"]), "stl", "obj", "glb", "gltf"];

export async function mount(ctx) {
  loadCss("css/modeler.css");
  let native = !WEB;
  if (native) { try { native = !!(await api("modeler", { op: "status" }, { allowFail: true })).available; } catch { native = false; } }
  if (!native) return viewOnly(ctx);
  const { loading } = await import("../core.js");
  const ld = loading(ctx.el, tr("mod.apertura"));
  const { ModelerApp } = await import("../modeler/mapp.js");
  const app = new ModelerApp(ctx);
  await app.init(ld);
  return {
    _md: app, // collaudo dalla console: MB.active.api._md
    onShow() { app.view.resize(); },
    // modello aperto da un .mbmod: Salva lo riscrive; modifica di un altro formato: Salva chiede dove (proposto .mbmod)
    get saveInPlace() { return /\.mbmod$/i.test(app.path || ""); },
    saveFormats: SAVE,
    saveLabels: { mbmod: tr("mod.fmt_mbmod"), step: tr("mod.fmt_step"), stp: tr("mod.fmt_step"), iges: tr("mod.fmt_iges"), igs: tr("mod.fmt_iges"), brep: tr("mod.fmt_brep"), dxf: tr("mod.fmt_dxf"), dwg: tr("mod.fmt_dwg"), stl: tr("mod.fmt_stl"), obj: tr("mod.fmt_obj"), glb: tr("mod.fmt_glb"), gltf: tr("mod.fmt_gltf") },
    saveNote: tr("mod.nota_salvataggio"),
    saveAsName: () => ctx.name.replace(/\.[^.]+$/, "") + ".mbmod",
    noConvert: true,
    save: target => app.save(target),
    renamed(p) { app.path = p; },
    dispose: () => app.dispose(),
  };
}

// solo vista: l'anteprima glTF contenuta nel .mbmod nel visualizzatore 3D (esportata anche per il collaudo)
export async function viewOnly(ctx) {
  let glb = null;
  try {
    await loadScript("/vendor/jszip/dist/jszip.min.js");
    const z = await window.JSZip.loadAsync(await readBytes(ctx.path));
    const f = z.file("anteprima.glb");
    if (f) glb = await f.async("uint8array");
  } catch { /* file vuoto o non valido */ }
  if (!glb) {
    ctx.el.append(el("div", { class: "center" }, el("div", { class: "panel" }, el("p", {}, tr("mod.solo_pc")))));
    return {};
  }
  const mod = await import("./model3d.js");
  const name = ctx.name.replace(/\.[^.]+$/, "") + ".glb";
  return mod.mount({ ...ctx, ext: "glb", name, preloaded: async () => {
    const { GLTFLoader } = await import("/vendor/three/examples/jsm/loaders/GLTFLoader.js");
    const g = await new Promise((ok, ko) => new GLTFLoader().parse(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), "", ok, ko));
    const tree = g.scene.children.map(o => ({ name: o.name || "", obj: o, children: [] }));
    return { root: g.scene, tree };
  } });
}
