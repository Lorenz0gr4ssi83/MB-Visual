// Firma digitale (solo app per PC; motore mbvisual/firma.py): PAdES nei PDF (visibile con riquadro posizionabile o
// invisibile, firme successive), CAdES .p7m/.p7s di qualsiasi file e firma parallela sui .p7m. Certificati dal magazzino
// di Windows (smart card, CNS, token: il PIN lo chiede Windows) o da file .p12/.pfx. Marca temporale RFC 3161 opzionale.
import { api, baseName, dirName, el, modal, pickFiles, pickSavePath, toast, waitJob, WEB } from "./core.js";
import { renderSigner } from "./viewers/signed.js";

const lbl = (text, ...input) => el("label", { style: { display: "grid", gap: "4px" } }, text, ...input);
const inp = (id, value = "", type = "text", ph = "") => el("input", { id, type, value, placeholder: ph || undefined, class: "field", style: { width: "100%", padding: "6px 8px" } });
const radio = (name, value, text, checked, hint) => el("label", { style: { display: "flex", gap: "8px", alignItems: "flex-start" } },
  el("input", { type: "radio", name, value, checked: checked || undefined, id: name + "-" + value, style: { marginTop: "3px" } }),
  el("span", {}, text, hint ? el("div", { style: { color: "var(--muted)", fontSize: "12px" } }, hint) : null));

// opts: { path, openFile(path) }
export async function signDialog({ path, openFile }) {
  if (WEB) return toast("La firma digitale e' disponibile nell'app per PC", true);
  const isPdf = /\.pdf$/i.test(path), isP7m = /\.p7m$/i.test(path);
  const [st, certsR] = await Promise.all([api("firma", { op: "impostazioni" }, { json: {} }), api("firma", { op: "certificati" }, { json: {} }).catch(e => ({ certificati: [], errore: e.message }))]);
  let certs = certsR.certificati || [];

  // ---- tipo di firma
  const kinds = isPdf
    ? [["pades", "PAdES: firma dentro il PDF", "Il documento resta un PDF che si apre ovunque. Si possono aggiungere altre firme dopo."], ["p7m", "CAdES: busta .p7m", "Il PDF viene racchiuso in un file .p7m (si apre con MB Visual, Dike, ArubaSign...)."]]
    : isP7m
      ? [["parallela", "Aggiungi una firma (firma parallela)", "Il nuovo firmatario si aggiunge nella stessa busta, accanto a quelli presenti."], ["p7m", "Busta annidata (.p7m.p7m)", "Firma l'intera busta: controfirma che include le firme precedenti."]]
      : [["p7m", "CAdES: busta .p7m (file incluso)", "Il formato richiesto da PA, gare e PEC."], ["p7s", "CAdES: firma separata .p7s", "Il file resta com'e'; la firma sta in un file accanto con lo stesso nome + .p7s."]];
  const kindBox = el("div", { style: { display: "grid", gap: "6px" } }, ...kinds.map(([v, t, h], i) => radio("firma-tipo", v, t, i === 0, h)));
  const kind = () => kindBox.querySelector("input:checked").value;

  // ---- certificato
  const certSel = el("select", { id: "firma-cert", class: "field", style: { width: "100%", padding: "6px 8px" } });
  const certInfo = el("div", { style: { fontSize: "12px", color: "var(--muted)" } });
  const p12Path = inp("firma-p12", "", "text", "Percorso del file .p12 / .pfx"), p12Pw = inp("firma-p12pw", "", "password");
  const p12Box = el("div", { hidden: true, style: { display: "grid", gap: "6px" } },
    el("div", { style: { display: "flex", gap: "6px" } }, p12Path, el("button", { class: "btn", type: "button", onclick: async () => { const f = await pickFiles(); if (f?.[0]) p12Path.value = f[0]; } }, "Sfoglia...")),
    lbl("Password del file", p12Pw));
  const showAll = el("input", { type: "checkbox", id: "firma-tutti" });
  const allRow = el("label", { style: { display: "flex", gap: "6px", fontSize: "12px" } }, showAll, "Mostra anche i certificati non qualificati per la firma");
  showAll.addEventListener("change", () => fillCerts());
  const fillCerts = () => {
    certSel.innerHTML = "";
    allRow.hidden = !certs.some(c => !c.qualificato);
    for (const c of certs.filter(c => c.qualificato || showAll.checked)) {
      const bad = c.scaduto ? " - SCADUTO" : c.non_ancora_valido ? " - non ancora valido" : "";
      certSel.append(el("option", { value: c.id }, `${c.nome || "?"} · ${c.emesso_da || ""} · fino al ${(c.valido_al || "").slice(0, 10)}${bad}`));
    }
    certSel.append(el("option", { value: "__p12" }, "Da file .p12 / .pfx..."));
    if (st.ultimo && [...certSel.options].some(o => o.value === st.ultimo)) certSel.value = st.ultimo;
    showCert();
  };
  const showCert = () => {
    const c = certs.find(x => x.id === certSel.value);
    p12Box.hidden = certSel.value !== "__p12";
    certInfo.textContent = c ? [c.dispositivo, c.qualificato ? "certificato di firma (non ripudio)" : "certificato NON qualificato per la firma", c.codice_fiscale && "CF " + c.codice_fiscale, c.algoritmo_chiave].filter(Boolean).join(" · ")
      : certSel.value === "__p12" ? "La chiave e' nel file: la password serve solo ora e non viene salvata." : "";
    certInfo.style.color = c && !c.qualificato ? "var(--warn)" : "var(--muted)";
  };
  certSel.addEventListener("change", showCert);
  const refresh = el("button", { class: "btn", type: "button", title: "Dopo aver inserito la smart card o il token", onclick: async () => {
    try { certs = (await api("firma", { op: "certificati" }, { json: {} })).certificati || []; fillCerts(); toast(`${certs.length} certificati di firma trovati`); } catch (e) { toast(e.message, true); }
  } }, "Aggiorna");
  fillCerts();
  const anyQ = certs.some(c => c.qualificato);
  const noCertNote = anyQ ? null : el("div", { class: "note", style: { fontSize: "12px", color: "var(--warn)" } },
    certsR.errore || "Nessun certificato di firma qualificata in Windows: inserisci la smart card o il token (con il software del certificatore installato) e premi Aggiorna, oppure usa un file .p12/.pfx.");

  // ---- PAdES: visibile, pagina, riquadro, motivo, luogo
  const vis = el("input", { type: "checkbox", id: "firma-vis", checked: true });
  const motivo = inp("firma-motivo", st.motivo || ""), luogo = inp("firma-luogo", st.luogo || "");
  const pageN = el("input", { type: "number", id: "firma-pag", min: 1, value: 1, class: "field", style: { width: "64px" } });
  const pageTot = el("span", {});
  const img = el("img", { draggable: "false", style: { display: "block", width: "100%", userSelect: "none" } });
  const rectEl = el("div", { style: { position: "absolute", border: "2px solid #1f6feb", background: "rgba(31,111,235,.15)", pointerEvents: "none" } },
    el("div", { style: { font: "600 10px var(--ui)", color: "#1f6feb", padding: "2px 4px" } }, "Firma"));
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
      pg = r; pageN.max = r.pagine; pageTot.textContent = ` di ${r.pagine}`;
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
      } else if (box[2] - box[0] < 60 || box[3] - box[1] < 25) { box = old; toast("Riquadro troppo piccolo: trascina un'area piu' grande"); }
      draw();
    };
    stage.addEventListener("pointermove", mv); stage.addEventListener("pointerup", up);
  });
  const preview = el("div", { style: { display: "grid", gap: "6px", alignContent: "start" } },
    el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, "Pagina ", pageN, pageTot,
      el("span", { style: { flex: 1 } }), el("button", { class: "btn", type: "button", onclick: () => { pageN.value = pg.pagine; loadPage(); } }, "Ultima")),
    stage, el("div", { style: { fontSize: "12px", color: "var(--muted)" } }, "Trascina sulla pagina per disegnare il riquadro della firma; un clic lo sposta."));
  const padesBox = el("div", { style: { display: "grid", gap: "8px" } },
    el("label", { style: { display: "flex", gap: "8px" } }, vis, "Firma visibile (riquadro sulla pagina)"),
    el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" } }, lbl("Motivo (facoltativo)", motivo), lbl("Luogo (facoltativo)", luogo)));

  // ---- marca temporale
  const ts = el("input", { type: "checkbox", id: "firma-ts", checked: st.marca || undefined });
  const tsUrl = inp("firma-tsa", st.tsa_url || "", "text", "es. https://timestamp.aruba.it/ o quello del tuo certificatore");
  const tsUser = inp("firma-tsa-u", st.tsa_utente || ""), tsPw = inp("firma-tsa-p", "", "password", st.tsa_password_salvata ? "(salvata: lascia vuoto per non cambiarla)" : "");
  const tsBox = el("div", { style: { display: "grid", gap: "6px", paddingLeft: "22px" } }, lbl("Indirizzo del servizio di marca temporale (TSA, RFC 3161)", tsUrl),
    el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" } }, lbl("Utente (se richiesto)", tsUser), lbl("Password", tsPw)),
    el("div", { style: { fontSize: "12px", color: "var(--muted)" } }, "Le marche qualificate le vende il certificatore (InfoCert, Aruba, Namirial...) con utente e password. La password resta nel PC, cifrata da Windows."));
  const tsSync = () => { tsBox.hidden = !ts.checked; };
  ts.addEventListener("change", tsSync); tsSync();

  // ---- file di uscita
  const outIn = inp("firma-out");
  const setOut = async () => { outIn.value = (await api("firma", { op: "uscita" }, { json: { path, tipo: kind() === "pades" ? "pades" : kind() } })).out; };
  await setOut();
  const outRow = el("div", { style: { display: "flex", gap: "6px" } }, outIn, el("button", { class: "btn", type: "button", onclick: async () => {
    const p = await pickSavePath(baseName(outIn.value), dirName(outIn.value)); if (p) outIn.value = p;
  } }, "Cambia..."));

  const isPades = () => kind() === "pades";
  const syncKind = () => {
    padesBox.hidden = !isPades();
    preview.hidden = !(isPades() && vis.checked);
    if (!preview.hidden && !img.src) loadPage();
    setOut();
    requestAnimationFrame(draw);
  };
  kindBox.addEventListener("change", syncKind);
  vis.addEventListener("change", syncKind);

  const left = el("div", { style: { display: "grid", gap: "12px", alignContent: "start", minWidth: 0 } },
    el("div", { style: { fontSize: "12.5px" } }, "File: ", el("b", {}, baseName(path))),
    lbl("Tipo di firma", kindBox),
    lbl("Certificato", el("div", { style: { display: "flex", gap: "6px" } }, certSel, refresh), certInfo, noCertNote, allRow, p12Box),
    padesBox,
    el("div", { style: { display: "grid", gap: "6px" } }, el("label", { style: { display: "flex", gap: "8px" } }, ts, "Aggiungi la marca temporale (data certa)"), tsBox),
    lbl("Salva il file firmato in", outRow),
    el("div", { style: { fontSize: "12px", color: "var(--muted)" } }, "Con smart card o token, alla firma Windows chiede il PIN nella sua finestra: MB Visual non lo vede e non lo memorizza."));
  const content = el("div", { style: { display: "grid", gridTemplateColumns: isPdf ? "minmax(0,1fr) minmax(0,330px)" : "1fr", gap: "18px" } }, left, isPdf ? preview : null);
  const body = document.getElementById("modal-body");
  const oldW = body.style.width;
  body.style.width = isPdf ? "min(900px, 96vw)" : "min(640px, 94vw)";
  syncKind();

  let opts;
  try {
    for (;;) {
      const v = await modal("Firma digitale", content, [{ label: "Annulla", value: null }, { label: "Firma", value: "ok", primary: true }]);
      if (!v) return;
      const p12 = certSel.value === "__p12";
      if (p12 && !p12Path.value.trim()) { toast("Scegli il file .p12 / .pfx", true); continue; }
      if (!p12 && !certSel.value) { toast("Scegli il certificato", true); continue; }
      if (ts.checked && !tsUrl.value.trim()) { toast("Scrivi l'indirizzo del servizio di marca temporale", true); continue; }
      if (!outIn.value.trim()) { toast("Scegli dove salvare il file firmato", true); continue; }
      if (outIn.value.trim().toLowerCase() === path.toLowerCase()) { toast("Il file firmato deve avere un nome diverso dall'originale", true); continue; }
      opts = { path, out: outIn.value.trim(), modo: kind(), motivo: motivo.value.trim(), luogo: luogo.value.trim(), marca: ts.checked };
      if (p12) Object.assign(opts, { p12: p12Path.value.trim(), p12_password: p12Pw.value }); else opts.cert = certSel.value;
      if (isPades() && vis.checked) Object.assign(opts, { visibile: true, pagina: Math.max(0, (+pageN.value || 1) - 1), riquadro: box });
      break;
    }
  } finally { body.style.width = oldW; }

  // impostazioni della marca temporale (password cifrata da Windows nel motore)
  try { await api("firma", { op: "impostazioni" }, { json: { tsa_url: tsUrl.value.trim(), tsa_utente: tsUser.value.trim(), ...(tsPw.value ? { tsa_password: tsPw.value } : {}), marca: ts.checked } }); } catch { /* */ }

  toast("Firma in corso: se Windows chiede il PIN, inseriscilo nella sua finestra", false, 8000);
  let r;
  try {
    const { job } = await api("firma", { op: isPades() ? "pades" : "cades" }, { json: opts });
    r = await waitJob(job);
  } catch (e) { await modal("Firma non riuscita", el("p", {}, e.message)); return; }
  return showResult(r, openFile);
}

async function showResult(r, openFile) {
  const v = r.verifica || {};
  const signers = v.firme ? v.firme.flatMap(f => f.firmatari || []) : (v.livelli || []).flatMap(l => l.firmatari || []);
  const last = signers[signers.length - 1];
  const box = el("div", { style: { display: "grid", gap: "10px" } },
    el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } },
      r.firme_valide ? el("span", { class: "chip ok" }, signers.length > 1 ? `Tutte le ${signers.length} firme sono valide` : "Firma valida e documento integro") : el("span", { class: "chip bad" }, "Verifica non superata"),
      r.pdf_apribile === false ? el("span", { class: "chip bad" }, "Il PDF firmato non si apre") : null),
    el("div", {}, "File firmato: ", el("b", {}, baseName(r.out))),
    last ? renderSigner(last) : null,
    el("p", { style: { margin: 0, fontSize: "12px", color: "var(--muted)" } }, "Verifica eseguita subito dopo la firma: integrita' del documento e firma crittografica. Catena di fiducia AgID/eIDAS e revoca non verificate (richiedono la rete)."));
  const go = await modal("Documento firmato", box, [{ label: "Chiudi", value: false }, { label: "Apri il file firmato", value: true, primary: true }]);
  if (go && openFile) openFile(r.out);
  return r;
}
