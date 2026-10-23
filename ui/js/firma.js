// Firma digitale (solo app per PC; motore mbvisual/firma.py): PAdES nei PDF (visibile con riquadro posizionabile o
// invisibile, firme successive), CAdES .p7m/.p7s di qualsiasi file e firma parallela sui .p7m. Certificati dal magazzino
// di Windows (smart card, CNS, CIE con lettore, token: il PIN lo chiede Windows), da file .p12/.pfx o da un servizio di
// firma remota CSC (PIN e OTP). Senza lettore: firma con lo smartphone (CieSign o app del certificatore) tramite una
// cartella di scambio OneDrive (mbvisual/firmaponte.py). Marca temporale RFC 3161 opzionale.
import { api, baseName, dirName, el, modal, pickFiles, pickFolder, pickSavePath, toast, waitJob, WEB } from "./core.js";
import { t } from "./i18n.js";
import { renderSigner } from "./viewers/signed.js";
import { needComp } from "./components.js";

const lbl = (text, ...input) => el("label", { style: { display: "grid", gap: "4px" } }, text, ...input);
const inp = (id, value = "", type = "text", ph = "") => el("input", { id, type, value, placeholder: ph || undefined, class: "field", style: { width: "100%", padding: "6px 8px" } });
const note = (text, color) => el("div", { style: { fontSize: "12px", color: color || "var(--muted)" } }, text);
const radio = (name, value, text, checked, hint) => el("label", { style: { display: "flex", gap: "8px", alignItems: "flex-start" } },
  el("input", { type: "radio", name, value, checked: checked || undefined, id: name + "-" + value, style: { marginTop: "3px" } }),
  el("span", {}, text, hint ? note(hint) : null));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const P12 = "__p12", CSC = "__csc", TEL = "__tel";
const DISP = () => ({ smartcard: t("firma.disp_smartcard"), windows: t("firma.disp_windows"), tpm: t("firma.disp_tpm"), file: t("firma.disp_file"), remota: t("firma.disp_remota"), altro: t("firma.disp_altro") });

// opts: { path, openFile(path) }
export async function signDialog({ path, openFile }) {
  if (WEB) return toast(t("firma.solo_pc"), true);
  if (!(await needComp("sign"))) return;
  const isPdf = /\.pdf$/i.test(path), isP7m = /\.p7m$/i.test(path);
  const [st, certsR] = await Promise.all([api("firma", { op: "impostazioni" }, { json: {} }), api("firma", { op: "certificati" }, { json: {} }).catch(e => ({ certificati: [], errore: e.message }))]);
  let certs = certsR.certificati || [];
  let remote = []; // credenziali del servizio di firma remota dopo "Collegati"

  // ---- tipo di firma
  const kinds = isPdf
    ? [["pades", t("firma.tipo_pades"), t("firma.tipo_pades_nota")], ["p7m", t("firma.tipo_p7m_pdf"), t("firma.tipo_p7m_pdf_nota")]]
    : isP7m
      ? [["parallela", t("firma.tipo_parallela"), t("firma.tipo_parallela_nota")], ["p7m", t("firma.tipo_annidata"), t("firma.tipo_annidata_nota")]]
      : [["p7m", t("firma.tipo_p7m"), t("firma.tipo_p7m_nota")], ["p7s", t("firma.tipo_p7s"), t("firma.tipo_p7s_nota")]];
  const kindBox = el("div", { style: { display: "grid", gap: "6px" } }, ...kinds.map(([v, tx, h], i) => radio("firma-tipo", v, tx, i === 0, h)));
  const kind = () => kindBox.querySelector("input:checked").value;

  // ---- certificato
  const certSel = el("select", { id: "firma-cert", class: "field", style: { width: "100%", padding: "6px 8px" } });
  const certInfo = note("");
  const showAll = el("input", { type: "checkbox", id: "firma-tutti" });
  const allRow = el("label", { style: { display: "flex", gap: "6px", fontSize: "12px" } }, showAll, t("firma.mostra_tutti"));
  const certLabel = c => {
    const bad = c.scaduto ? " - " + t("firma.scaduto") : c.non_ancora_valido ? " - " + t("firma.non_ancora_valido") : "";
    return `${c.cie ? "CIE · " : ""}${c.nome || "?"} · ${c.emesso_da || ""} · ${t("firma.fino_al", (c.valido_al || "").slice(0, 10))}${bad}`;
  };
  const fillCerts = () => {
    const keep = certSel.value;
    certSel.innerHTML = "";
    allRow.hidden = !certs.some(c => !c.qualificato && !c.cie);
    for (const c of certs.filter(c => c.qualificato || c.cie || showAll.checked)) certSel.append(el("option", { value: c.id }, certLabel(c)));
    certSel.append(el("option", { value: CSC }, t("firma.opz_remota")), el("option", { value: P12 }, t("firma.opz_p12")), el("option", { value: TEL }, t("firma.opz_telefono")));
    const pref = keep || st.ultimo;
    if (pref && [...certSel.options].some(o => o.value === pref)) certSel.value = pref;
    else if (!certs.some(c => c.qualificato || c.cie)) certSel.value = TEL; // nessun dispositivo: proposta senza lettore
    sync();
  };
  showAll.addEventListener("change", fillCerts);
  const refresh = el("button", { class: "btn", type: "button", title: t("firma.aggiorna_titolo"), onclick: async () => {
    try { certs = (await api("firma", { op: "certificati" }, { json: {} })).certificati || []; fillCerts(); toast(t("firma.trovati", certs.length)); } catch (e) { toast(e.message, true); }
  } }, t("firma.aggiorna"));
  const noCertNote = certs.some(c => c.qualificato || c.cie) ? null : note(certsR.errore || t("firma.nessun_certificato"), "var(--warn)");

  // .p12 / .pfx
  const p12Path = inp("firma-p12", "", "text", t("firma.p12_percorso")), p12Pw = inp("firma-p12pw", "", "password");
  const p12Box = el("div", { style: { display: "grid", gap: "6px" } },
    el("div", { style: { display: "flex", gap: "6px" } }, p12Path, el("button", { class: "btn", type: "button", onclick: async () => { const f = await pickFiles(); if (f?.[0]) p12Path.value = f[0]; } }, t("firma.sfoglia"))),
    lbl(t("firma.p12_password"), p12Pw));

  // firma remota (CSC)
  const cUrl = inp("firma-csc-url", st.csc_url || "", "text", "https://..."), cUser = inp("firma-csc-u", st.csc_utente || ""), cPw = inp("firma-csc-p", "", "password");
  const cCred = el("select", { id: "firma-csc-cred", class: "field", style: { width: "100%", padding: "6px 8px" } });
  const cPin = inp("firma-csc-pin", "", "password"), cOtp = inp("firma-csc-otp", "", "text");
  const cOtpBtn = el("button", { class: "btn", type: "button", onclick: async () => {
    try { await api("firma", { op: "csc_otp" }, { json: { url: cUrl.value.trim(), utente: cUser.value.trim(), credenziale: cCred.value } }); toast(t("firma.otp_inviato")); } catch (e) { toast(e.message, true); }
  } }, t("firma.invia_otp"));
  const pinRow = lbl(t("firma.csc_pin"), cPin), otpRow = lbl(t("firma.csc_otp"), el("div", { style: { display: "flex", gap: "6px" } }, cOtp, cOtpBtn));
  const cAuth = el("div", { hidden: true, style: { display: "grid", gap: "6px" } }, lbl(t("firma.csc_credenziale"), cCred),
    el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" } }, pinRow, otpRow));
  const showCred = () => {
    const c = remote.find(x => x.id === cCred.value);
    cOtpBtn.hidden = !(c && c.otp_online);
    pinRow.hidden = !!c && !c.pin;
    otpRow.hidden = !!c && !c.otp;
  };
  cCred.addEventListener("change", showCred);
  const cConnect = el("button", { class: "btn", type: "button", onclick: async () => {
    if (!cUrl.value.trim()) return toast(t("firma.csc_manca_url"), true);
    cConnect.disabled = true;
    try {
      const r = await api("firma", { op: "csc_collega" }, { json: { url: cUrl.value.trim(), utente: cUser.value.trim(), password: cPw.value } });
      remote = r.credenziali || [];
      cCred.innerHTML = "";
      for (const c of remote) cCred.append(el("option", { value: c.id }, certLabel(c)));
      cAuth.hidden = false;
      showCred();
      toast(t("firma.csc_collegato", remote.length));
    } catch (e) { toast(e.message, true, 8000); } finally { cConnect.disabled = false; }
  } }, t("firma.csc_collega"));
  const cscBox = el("div", { style: { display: "grid", gap: "6px" } },
    lbl(t("firma.csc_url"), cUrl),
    el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "8px", alignItems: "end" } }, lbl(t("firma.csc_utente"), cUser), lbl(t("firma.csc_password"), cPw), cConnect),
    cAuth, note(t("firma.csc_nota")));

  // con lo smartphone (cartella di scambio)
  const telFolder = inp("firma-tel-dir", "");
  const telProposals = el("select", { id: "firma-tel-prop", class: "field", style: { padding: "6px 8px" } });
  const telBox = el("div", { style: { display: "grid", gap: "8px" } },
    note(t("firma.tel_intro"), "var(--fg)"),
    el("ol", { style: { margin: "0", paddingLeft: "20px", display: "grid", gap: "4px", fontSize: "12.5px" } },
      el("li", {}, t("firma.tel_passo1")), el("li", {}, t("firma.tel_passo2")), el("li", {}, t("firma.tel_passo3")), el("li", {}, t("firma.tel_passo4"))),
    lbl(t("firma.tel_cartella"), el("div", { style: { display: "flex", gap: "6px" } }, telFolder, telProposals,
      el("button", { class: "btn", type: "button", onclick: async () => { const f = await pickFolder(); if (f) telFolder.value = f; } }, t("firma.sfoglia")))),
    note(t("firma.tel_valore")));
  telProposals.addEventListener("change", () => { if (telProposals.value) telFolder.value = telProposals.value; telProposals.value = ""; });
  api("firma", { op: "tel_cartella" }, { json: {} }).then(r => {
    telFolder.value = r.cartella || "";
    telProposals.append(el("option", { value: "" }, "OneDrive..."), ...(r.proposte || []).map(p => el("option", { value: p.cartella }, p.nome)));
    telProposals.hidden = !(r.proposte || []).length;
  }).catch(() => { /* */ });

  // ---- PAdES: visibile, pagina, riquadro, motivo, luogo
  const vis = el("input", { type: "checkbox", id: "firma-vis", checked: true });
  const motivo = inp("firma-motivo", st.motivo || ""), luogo = inp("firma-luogo", st.luogo || "");
  const pageN = el("input", { type: "number", id: "firma-pag", min: 1, value: 1, class: "field", style: { width: "64px" } });
  const pageTot = el("span", {});
  const img = el("img", { draggable: "false", style: { display: "block", width: "100%", userSelect: "none" } });
  const rectEl = el("div", { style: { position: "absolute", border: "2px solid #1f6feb", background: "rgba(31,111,235,.15)", pointerEvents: "none" } },
    el("div", { style: { font: "600 10px var(--ui)", color: "#1f6feb", padding: "2px 4px" } }, t("firma.riquadro")));
  const stage = el("div", { style: { position: "relative", border: "1px solid var(--line)", background: "#fff", touchAction: "none" } }, img, rectEl);
  let pg = { w: 595, h: 842, pagine: 1 }, box = null; // box in punti PDF, origine in alto a sinistra come si vede la pagina
  const draw = () => {
    if (!box) return;
    const k = stage.clientWidth / pg.w;
    Object.assign(rectEl.style, { left: box[0] * k + "px", top: box[1] * k + "px", width: (box[2] - box[0]) * k + "px", height: (box[3] - box[1]) * k + "px" });
  };
  const loadPage = async () => {
    try {
      const r = await api("firma", { op: "anteprima" }, { json: { path, pagina: Math.max(0, (+pageN.value || 1) - 1) } });
      pg = r; pageN.max = r.pagine; pageTot.textContent = " " + t("firma.di_pagine", r.pagine);
      img.src = "data:image/png;base64," + r.png;
      if (!box) box = [r.w - 250, r.h - 110, r.w - 36, r.h - 36]; // in basso a destra
      box = [Math.min(box[0], r.w - 20), Math.min(box[1], r.h - 20), Math.min(box[2], r.w), Math.min(box[3], r.h)];
      img.onload = draw;
    } catch (e) { toast(e.message, true); }
  };
  pageN.addEventListener("change", loadPage);
  // trascinando si disegna un riquadro nuovo; un clic sposta quello esistente centrandolo li'
  stage.addEventListener("pointerdown", e => {
    const r = stage.getBoundingClientRect(), k = stage.clientWidth / pg.w;
    const at = ev => [Math.max(0, Math.min(pg.w, (ev.clientX - r.left) / k)), Math.max(0, Math.min(pg.h, (ev.clientY - r.top) / k))];
    const p0 = at(e), old = box.slice();
    let moved = false;
    stage.setPointerCapture(e.pointerId);
    const mv = ev => {
      const p = at(ev);
      if (Math.abs(p[0] - p0[0]) + Math.abs(p[1] - p0[1]) < 4 && !moved) return;
      moved = true;
      box = [Math.min(p0[0], p[0]), Math.min(p0[1], p[1]), Math.max(p0[0], p[0]), Math.max(p0[1], p[1])];
      draw();
    };
    const up = () => {
      stage.removeEventListener("pointermove", mv); stage.removeEventListener("pointerup", up);
      if (!moved) {
        const w = old[2] - old[0], h = old[3] - old[1];
        const x = Math.max(0, Math.min(pg.w - w, p0[0] - w / 2)), y = Math.max(0, Math.min(pg.h - h, p0[1] - h / 2));
        box = [x, y, x + w, y + h];
      } else if (box[2] - box[0] < 60 || box[3] - box[1] < 25) { box = old; toast(t("firma.riquadro_piccolo")); }
      draw();
    };
    stage.addEventListener("pointermove", mv); stage.addEventListener("pointerup", up);
  });
  const preview = el("div", { style: { display: "grid", gap: "6px", alignContent: "start" } },
    el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, t("firma.pagina"), pageN, pageTot,
      el("span", { style: { flex: 1 } }), el("button", { class: "btn", type: "button", onclick: () => { pageN.value = pg.pagine; loadPage(); } }, t("firma.ultima"))),
    stage, note(t("firma.riquadro_nota")));
  const padesBox = el("div", { style: { display: "grid", gap: "8px" } },
    el("label", { style: { display: "flex", gap: "8px" } }, vis, t("firma.visibile")),
    el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" } }, lbl(t("firma.motivo"), motivo), lbl(t("firma.luogo"), luogo)));

  // ---- marca temporale
  const ts = el("input", { type: "checkbox", id: "firma-ts", checked: st.marca || undefined });
  const tsUrl = inp("firma-tsa", st.tsa_url || "", "text", t("firma.tsa_esempio"));
  const tsUser = inp("firma-tsa-u", st.tsa_utente || ""), tsPw = inp("firma-tsa-p", "", "password", st.tsa_password_salvata ? t("firma.tsa_salvata") : "");
  const tsBox = el("div", { style: { display: "grid", gap: "6px", paddingLeft: "22px" } }, lbl(t("firma.tsa_url"), tsUrl),
    el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" } }, lbl(t("firma.tsa_utente"), tsUser), lbl(t("firma.tsa_password"), tsPw)),
    note(t("firma.tsa_nota")));
  const tsSync = () => { tsBox.hidden = !ts.checked; };
  ts.addEventListener("change", tsSync); tsSync();
  const tsRow = el("div", { style: { display: "grid", gap: "6px" } }, el("label", { style: { display: "flex", gap: "8px" } }, ts, t("firma.marca")), tsBox);

  // ---- file di uscita
  const outIn = inp("firma-out");
  const setOut = async () => { outIn.value = (await api("firma", { op: "uscita" }, { json: { path, tipo: kind() === "pades" ? "pades" : kind() } })).out; };
  const outRow = lbl(t("firma.salva_in"), el("div", { style: { display: "flex", gap: "6px" } }, outIn, el("button", { class: "btn", type: "button", onclick: async () => {
    const p = await pickSavePath(baseName(outIn.value), dirName(outIn.value)); if (p) outIn.value = p;
  } }, t("firma.cambia"))));
  const pinNote = note(t("firma.pin_windows"));

  const mode = () => certSel.value;
  const isPades = () => kind() === "pades";
  const kindRow = lbl(t("firma.tipo"), kindBox);
  function sync() {
    const m = mode(), tel = m === TEL;
    const c = certs.find(x => x.id === m);
    certInfo.textContent = c ? [(DISP()[c.dispositivo] || DISP().altro), c.cie ? t("firma.info_cie") : c.qualificato ? t("firma.info_qualificato") : t("firma.info_non_qualificato"), c.codice_fiscale && t("firma.cf", c.codice_fiscale), c.algoritmo_chiave].filter(Boolean).join(" · ")
      : m === P12 ? t("firma.info_p12") : "";
    certInfo.style.color = c && !c.qualificato && !c.cie ? "var(--warn)" : "var(--muted)";
    p12Box.hidden = m !== P12; cscBox.hidden = m !== CSC; telBox.hidden = !tel;
    for (const e of [kindRow, tsRow, outRow]) e.hidden = tel;
    pinNote.hidden = tel || m === CSC || m === P12;
    padesBox.hidden = tel || !isPades();
    preview.hidden = tel || !(isPades() && vis.checked);
    if (!preview.hidden && !img.src) loadPage();
    if (isPdf) content.style.gridTemplateColumns = preview.hidden ? "1fr" : "minmax(0,1fr) minmax(0,330px)";
    requestAnimationFrame(draw);
  }
  certSel.addEventListener("change", sync);
  kindBox.addEventListener("change", () => { sync(); setOut(); });
  vis.addEventListener("change", sync);
  await setOut();

  const left = el("div", { style: { display: "grid", gap: "12px", alignContent: "start", minWidth: 0 } },
    el("div", { style: { fontSize: "12.5px" } }, t("firma.file"), " ", el("b", {}, baseName(path))),
    lbl(t("firma.certificato"), el("div", { style: { display: "flex", gap: "6px" } }, certSel, refresh), certInfo, noCertNote, allRow),
    p12Box, cscBox, telBox, kindRow, padesBox, tsRow, outRow, pinNote);
  const content = el("div", { style: { display: "grid", gridTemplateColumns: isPdf ? "minmax(0,1fr) minmax(0,330px)" : "1fr", gap: "18px" } }, left, isPdf ? preview : null);
  const body = document.getElementById("modal-body");
  const oldW = body.style.width;
  body.style.width = isPdf ? "min(900px, 96vw)" : "min(640px, 94vw)";
  fillCerts();

  let opts;
  try {
    for (;;) {
      const v = await modal(t("firma.titolo"), content, [{ label: t("common.annulla"), value: null }, { label: t("firma.firma"), value: "ok", primary: true }]);
      if (!v) return;
      const m = mode();
      if (m === TEL) {
        if (!telFolder.value.trim()) { toast(t("firma.tel_manca_cartella"), true); continue; }
        opts = { tel: true };
        break;
      }
      if (m === P12 && !p12Path.value.trim()) { toast(t("firma.scegli_p12"), true); continue; }
      if (m === CSC && (!remote.length || !cCred.value)) { toast(t("firma.csc_prima_collega"), true); continue; }
      if (ts.checked && !tsUrl.value.trim()) { toast(t("firma.manca_tsa"), true); continue; }
      if (!outIn.value.trim()) { toast(t("firma.manca_uscita"), true); continue; }
      if (outIn.value.trim().toLowerCase() === path.toLowerCase()) { toast(t("firma.uscita_uguale"), true); continue; }
      opts = { path, out: outIn.value.trim(), modo: kind(), motivo: motivo.value.trim(), luogo: luogo.value.trim(), marca: ts.checked };
      if (m === P12) Object.assign(opts, { p12: p12Path.value.trim(), p12_password: p12Pw.value });
      else if (m === CSC) opts.csc = { url: cUrl.value.trim(), utente: cUser.value.trim(), credenziale: cCred.value, pin: cPin.value, otp: cOtp.value.trim() };
      else opts.cert = m;
      if (isPades() && vis.checked) Object.assign(opts, { visibile: true, pagina: Math.max(0, (+pageN.value || 1) - 1), riquadro: box });
      break;
    }
  } finally { body.style.width = oldW; }

  if (opts.tel) return phoneFlow(path, telFolder.value.trim(), openFile);

  // impostazioni della marca temporale (password cifrata da Windows nel motore)
  try { await api("firma", { op: "impostazioni" }, { json: { tsa_url: tsUrl.value.trim(), tsa_utente: tsUser.value.trim(), ...(tsPw.value ? { tsa_password: tsPw.value } : {}), marca: ts.checked } }); } catch { /* */ }

  toast(opts.cert ? t("firma.in_corso_pin") : t("firma.in_corso"), false, 8000);
  let r;
  try {
    const { job } = await api("firma", { op: isPades() ? "pades" : "cades" }, { json: opts });
    r = await waitJob(job);
  } catch (e) { await modal(t("firma.non_riuscita"), el("p", {}, e.message)); return; }
  return showResult(r, openFile);
}

// ---- firma con lo smartphone: copia nella cartella di scambio, attesa del file firmato, verifica, salvataggio
async function phoneFlow(path, folder, openFile) {
  let s;
  try { s = await api("firma", { op: "tel_avvia" }, { json: { path, cartella: folder } }); } catch (e) { return toast(e.message, true, 8000); }
  const state = el("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } }, el("span", { class: "chip mute" }, t("firma.tel_attesa")));
  const result = el("div", { style: { display: "grid", gap: "10px" } });
  const outIn = inp("firma-tel-out");
  const outRow = lbl(t("firma.salva_in"), el("div", { style: { display: "flex", gap: "6px" } }, outIn, el("button", { class: "btn", type: "button", onclick: async () => {
    const p = await pickSavePath(baseName(outIn.value), dirName(outIn.value)); if (p) outIn.value = p;
  } }, t("firma.cambia"))));
  outRow.hidden = true;
  const box = el("div", { style: { display: "grid", gap: "12px" } },
    el("div", {}, t("firma.tel_copiato"), " ", el("b", {}, s.copia)),
    el("div", { style: { fontSize: "12.5px", wordBreak: "break-all" } }, t("firma.tel_nella_cartella"), " ", el("b", {}, s.cartella)),
    el("ol", { style: { margin: 0, paddingLeft: "20px", display: "grid", gap: "4px", fontSize: "12.5px" } },
      el("li", {}, t("firma.tel_passo2")), el("li", {}, t("firma.tel_passo3")), el("li", {}, t("firma.tel_passo4"))),
    state, result, outRow);
  let found = null, open = true;
  const primary = () => document.querySelector("#modal-body .row .btn.primary");
  const poll = (async () => {
    while (open) {
      await sleep(2000);
      if (!open) break;
      let r;
      try { r = await api("firma", { op: "tel_stato" }, { json: { id: s.id } }); } catch { continue; }
      if (r.fase !== 2) continue;
      found = r;
      const e = r.esito || {};
      const v = e.verifica || {};
      const signers = v.firme ? v.firme.flatMap(f => f.firmatari || []) : (v.livelli || []).flatMap(l => l.firmatari || []);
      state.innerHTML = "";
      state.append(e.firme_valide ? el("span", { class: "chip ok" }, t("firma.valida")) : el("span", { class: "chip bad" }, t("firma.verifica_ko")),
        e.stesso_documento === true ? el("span", { class: "chip ok" }, t("firma.stesso_documento")) : e.stesso_documento === false ? el("span", { class: "chip bad" }, t("firma.documento_diverso")) : el("span", { class: "chip warn" }, t("firma.documento_da_controllare")));
      result.innerHTML = "";
      result.append(el("div", {}, t("firma.tel_ricevuto"), " ", el("b", {}, r.nome)), signers.length ? renderSigner(signers[signers.length - 1]) : null);
      outIn.value = r.out;
      outRow.hidden = false;
      if (primary()) primary().disabled = false;
      break;
    }
  })();
  const p = modal(t("firma.tel_titolo"), box, [{ label: t("common.annulla"), value: false }, { label: t("firma.tel_salva_apri"), value: true, primary: true }]);
  if (primary()) primary().disabled = true;
  const ok = await p;
  open = false;
  await poll;
  if (!ok || !found) { api("firma", { op: "tel_stop" }, { json: { id: s.id } }).catch(() => { /* */ }); return; }
  try {
    const r = await api("firma", { op: "tel_salva" }, { json: { id: s.id, out: outIn.value.trim() } });
    toast(t("firma.salvato", baseName(r.out)));
    if (openFile) openFile(r.out);
  } catch (e) { toast(e.message, true, 8000); }
}

async function showResult(r, openFile) {
  const v = r.verifica || {};
  const signers = v.firme ? v.firme.flatMap(f => f.firmatari || []) : (v.livelli || []).flatMap(l => l.firmatari || []);
  const last = signers[signers.length - 1];
  const box = el("div", { style: { display: "grid", gap: "10px" } },
    el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } },
      r.firme_valide ? el("span", { class: "chip ok" }, signers.length > 1 ? t("firma.tutte_valide", signers.length) : t("firma.valida")) : el("span", { class: "chip bad" }, t("firma.verifica_ko")),
      r.pdf_apribile === false ? el("span", { class: "chip bad" }, t("firma.pdf_non_apribile")) : null),
    el("div", {}, t("firma.file_firmato"), " ", el("b", {}, baseName(r.out))),
    last ? renderSigner(last) : null,
    note(t("firma.verifica_nota")));
  const go = await modal(t("firma.documento_firmato"), box, [{ label: t("common.chiudi"), value: false }, { label: t("firma.apri_firmato"), value: true, primary: true }]);
  if (go && openFile) openFile(r.out);
  return r;
}
