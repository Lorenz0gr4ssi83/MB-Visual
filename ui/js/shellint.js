// Impostazione "Integrazione con Windows" (menu File): miniature e anteprime in Esplora risorse, "Apri con",
// icone dei tipi di file, voce nel menu del tasto destro. Il lavoro lo fa mbvisual/shellint.py (solo per l'utente).
import { api, el, modal, toast, waitJob } from "./core.js";

export async function showShellIntegration() {
  let st;
  try { st = await api("shell_status"); } catch (e) { return toast(e.message, true); }
  const chk = (label, on, note) => {
    const i = el("input", { type: "checkbox" });
    i.checked = on;
    return [i, el("label", { style: { display: "flex", gap: "8px", alignItems: "flex-start", margin: "6px 0" } }, i,
      el("span", {}, label, note ? el("div", { class: "note", style: { margin: 0 } }, note) : null))];
  };
  const [cOn, lOn] = chk("Integra MB Visual in Esplora risorse", st.attiva,
    "\"Apri con\", icone dei tipi di file e voce \"Apri con MB Visual\" nel menu del tasto destro (in Windows 11 sotto \"Mostra altre opzioni\").");
  const [cThumb, lThumb] = chk("Miniature e riquadro di anteprima dei formati tecnici", st.attiva ? st.anteprime : true,
    "DWG, DXF, IFC, STEP, IGES, Navisworks, Rhino, SketchUp, Revit, mesh 3D... Se un altro programma (es. AutoCAD) ha gia' le sue miniature, restano le sue.");
  const [cFree, lFree] = chk("Usa MB Visual come programma predefinito per i formati che non ne hanno uno", st.attiva ? st.libere : true,
    "I programmi predefiniti gia' scelti non cambiano: per quelli si sceglie MB Visual da Impostazioni di Windows > App predefinite.");
  const info = [];
  if (st.attiva) {
    info.push(`Attiva: ${st.estensioni} estensioni in "Apri con", miniature per ${st.miniature.length} formati.`);
    if (st.altri_gestori.length) info.push(`Miniature lasciate ad altri programmi: ${st.altri_gestori.map(e => e.toUpperCase()).join(", ")}.`);
    if (st.predefinito.length) info.push(`MB Visual e' il programma predefinito per ${st.predefinito.length} formati che non ne avevano.`);
    info.push(`Cache delle miniature: ${st.cache_mb} MB.`);
  }
  if (!st.disponibile) info.push("Questa copia dell'app non contiene il modulo delle miniature (bin\\shell): saranno registrati solo \"Apri con\" e le icone.");
  const sync = () => { cThumb.disabled = cFree.disabled = !cOn.checked; };
  cOn.addEventListener("change", sync);
  sync();
  const body = el("div", { style: { maxWidth: "560px" } }, lOn, el("div", { style: { marginLeft: "24px" } }, lThumb, lFree),
    ...info.map(t => el("p", { class: "note" }, t)),
    el("p", { class: "note" }, "Solo per il tuo utente di Windows, senza diritti di amministratore. Disattivando, tutte le voci vengono tolte."));
  const buttons = [{ label: "Annulla", value: null }];
  if (st.attiva) buttons.push({ label: "Svuota cache miniature", value: "cache" });
  buttons.push({ label: "Applica", value: "ok", primary: true });
  const r = await modal("Integrazione con Windows", body, buttons);
  if (r === "cache") { await api("shell_set", {}, { json: { pulisci_cache: true } }); return toast("Cache delle miniature svuotata"); }
  if (r !== "ok") return;
  if (!cOn.checked && !st.attiva) return;
  toast(cOn.checked ? "Registrazione in Esplora risorse..." : "Rimozione dall'Esplora risorse...", false, 60000);
  try {
    const { job } = await api("shell_set", {}, { json: { attiva: cOn.checked, anteprime: cThumb.checked, libere: cFree.checked } });
    await waitJob(job);
    toast(cOn.checked ? "MB Visual e' integrata in Esplora risorse" : "Integrazione con Esplora risorse rimossa", false, 4000);
  } catch (e) { toast(e.message, true, 8000); }
}
