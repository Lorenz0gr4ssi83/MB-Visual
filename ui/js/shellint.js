// Impostazione "Integrazione con Windows" (menu File): miniature e anteprime in Esplora risorse, "Apri con",
// icone dei tipi di file, voce nel menu del tasto destro. Il lavoro lo fa mbvisual/shellint.py (solo per l'utente).
import { api, el, modal, toast, waitJob } from "./core.js";
import { t as tr } from "./i18n.js";

export async function showShellIntegration() {
  let st;
  try { st = await api("shell_status"); } catch (e) { return toast(e.message, true); }
  const chk = (label, on, note) => {
    const i = el("input", { type: "checkbox" });
    i.checked = on;
    return [i, el("label", { style: { display: "flex", gap: "8px", alignItems: "flex-start", margin: "6px 0" } }, i,
      el("span", {}, label, note ? el("div", { class: "note", style: { margin: 0 } }, note) : null))];
  };
  const [cOn, lOn] = chk(tr("shellint.integra_mb_visual_esplora_risorse"), st.attiva,
    tr("shellint.apri_icone_tipi_file_voce"));
  const [cThumb, lThumb] = chk(tr("shellint.miniature_riquadro_anteprima_formati_tecnici"), st.attiva ? st.anteprime : true,
    tr("shellint.dwg_dxf_ifc_step_iges"));
  const [cFree, lFree] = chk(tr("shellint.usa_mb_visual_come_programma"), st.attiva ? st.libere : true,
    tr("shellint.i_programmi_predefiniti_gia_scelti"));
  const info = [];
  if (st.attiva) {
    info.push(tr("shellint.attiva_0_estensioni_apri_miniature", st.estensioni, st.miniature.length));
    if (st.altri_gestori.length) info.push(tr("shellint.miniature_lasciate_ad_altri_programmi", st.altri_gestori.map(e => e.toUpperCase()).join(", ")));
    if (st.predefinito.length) info.push(tr("shellint.mb_visual_programma_predefinito_0", st.predefinito.length));
    info.push(tr("shellint.cache_miniature_0_mb", st.cache_mb));
  }
  if (!st.disponibile) info.push(tr("shellint.questa_copia_dell_app_non"));
  const sync = () => { cThumb.disabled = cFree.disabled = !cOn.checked; };
  cOn.addEventListener("change", sync);
  sync();
  const body = el("div", { style: { maxWidth: "560px" } }, lOn, el("div", { style: { marginLeft: "24px" } }, lThumb, lFree),
    ...info.map(t => el("p", { class: "note" }, t)),
    el("p", { class: "note" }, tr("shellint.solo_tuo_utente_windows_senza")));
  const buttons = [{ label: tr("common.annulla"), value: null }];
  if (st.attiva) buttons.push({ label: tr("shellint.svuota_cache_miniature"), value: "cache" });
  buttons.push({ label: tr("common.applica"), value: "ok", primary: true });
  const r = await modal(tr("shellint.integrazione_windows"), body, buttons);
  if (r === "cache") { await api("shell_set", {}, { json: { pulisci_cache: true } }); return toast(tr("shellint.cache_miniature_svuotata")); }
  if (r !== "ok") return;
  if (!cOn.checked && !st.attiva) return;
  toast(cOn.checked ? tr("shellint.registrazione_esplora_risorse") : tr("shellint.rimozione_dall_esplora_risorse"), false, 60000);
  try {
    const { job } = await api("shell_set", {}, { json: { attiva: cOn.checked, anteprime: cThumb.checked, libere: cFree.checked } });
    await waitJob(job);
    toast(cOn.checked ? tr("shellint.mb_visual_integrata_esplora_risorse") : tr("shellint.integrazione_esplora_risorse_rimossa"), false, 4000);
  } catch (e) { toast(e.message, true, 8000); }
}
