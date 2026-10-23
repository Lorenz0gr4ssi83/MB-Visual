// PDF con modelli 3D (annotazioni 3D, U3D / PRC): il motore estrae i flussi (mbvisual/pdf3d.py) e il pulsante
// "Modello 3D" apre gli U3D nel visualizzatore 3D dell'app (ui/js/u3d.js). I PRC (ISO 14739) sono elencati ma
// non ancora letti: si avvisa l'utente.
import { api, button, el, fmtSize, modal, toast } from "./core.js";
import { t } from "./i18n.js";

export async function add3dButton(ctx) {
  let r;
  try { r = await api("pdf3d", { path: ctx.path }, { allowFail: true }); } catch { return; }
  const models = r?.models || [];
  if (!models.length) return;
  const open = m => (m.kind === "u3d" ? ctx.openFile(m.path, "model3d", { displayName: m.name + "." + m.kind }) : toast(t("pdf3d.prc_non_supportato"), true, 8000));
  const b = button(models.length > 1 ? t("pdf3d.pulsante_n", models.length) : t("pdf3d.pulsante"), "cube", async () => {
    if (models.length === 1) return open(models[0]);
    const list = el("div", { style: { display: "grid", gap: "6px" } });
    let chosen = null;
    const dlg = modal(t("pdf3d.scegli"), list, [{ label: t("common.chiudi"), value: false }]);
    for (const m of models) {
      // scelta = chiusura della finestra (come Esc) dopo aver annotato il modello
      list.append(el("button", { class: "btn", style: { justifyContent: "flex-start" }, onclick: () => { chosen = m; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); } },
        `${m.name} · ${m.kind.toUpperCase()} · ${fmtSize(m.size)}` + (m.page ? " · " + t("pdf3d.pagina", m.page) : "")));
    }
    await dlg;
    if (chosen) open(chosen);
  }, { title: t("pdf3d.suggerimento") });
  b.dataset.comp = "mech";
  ctx.tb.prepend(b, el("span", { class: "sep" }));
  toast(t("pdf3d.trovati", models.length), false, 4000);
}
