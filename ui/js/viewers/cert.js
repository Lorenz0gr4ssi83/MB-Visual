// Certificati digitali (.cer/.crt/.pem/.der/.p7b/.p12/.pfx/.csr/.crl): soggetto, emittente, validita', usi, estensioni,
// catena di certificazione. Solo dati pubblici: per i PKCS#12 la password serve per una sola lettura e non resta da nessuna parte
// (non si salva, non resta nella scheda: le esportazioni usano i certificati gia' letti). Motore: mbvisual/fx_cert.py
import { api, button, el, loadCss, loading, modal, toast } from "../core.js";
import { t as tr } from "../i18n.js";

export async function mount(ctx) {
  loadCss("css/formati.css");
  loading(ctx.el, tr("v_cert.lettura_certificato"));
  let r = await api("fx", { op: "cert_read", path: ctx.path }, { json: {} });
  while (r.password_richiesta) {
    const pw = await askPassword(r.errata);
    if (pw === null) { ctx.el.innerHTML = ""; ctx.el.append(el("div", { class: "fx-empty" }, tr("v_cert.serve_password_file_pkcs_12"), el("br"), el("br"), el("button", { class: "btn primary", onclick: () => ctx.openAs("cert") }, tr("v_cert.inserisci_password")))); return {}; }
    loading(ctx.el, tr("v_cert.lettura_certificato"));
    r = await api("fx", { op: "cert_read", path: ctx.path }, { json: { password: pw } });
  }
  ctx.el.innerHTML = "";
  const certs = r.certificati || [];
  let sel = 0;
  const page = el("div", { class: "fx-page" });
  ctx.el.append(page);

  function render() {
    page.innerHTML = "";
    const first = certs[0];
    page.append(el("div", { class: "fx-row" }, el("h2", {}, certs.length ? (certs.length > 1 ? tr("v_cert.n_certificati", certs.length) : tr("v_cert.certificato") + first.nome) : (r.altri[0]?.tipo || tr("v_cert.certificato_2"))),
      certs.length ? status(certs[sel]) : null));
    for (const n of r.note || []) page.append(el("p", { class: "fx-muted", style: { margin: 0 } }, n));
    // catene
    for (const ch of r.catene || []) page.append(chainBox(ch));
    if (certs.length > 1) {
      const t = el("table", { class: "fx-table" }, el("thead", {}, el("tr", {}, ...["", tr("v_cert.soggetto"), tr("v_cert.emittente"), tr("v_cert.valido_fino"), tr("v_cert.tipo")].map(h => el("th", {}, h)))));
      const tb = el("tbody");
      certs.forEach((c, i) => tb.append(el("tr", { class: "click" + (i === sel ? " sel" : ""), onclick: () => { sel = i; render(); } },
        el("td", {}, i + 1), el("td", {}, c.nome), el("td", {}, c.emittente_nome), el("td", {}, c.valido_al, c.scaduto ? tr("v_cert.scaduto") : ""),
        el("td", {}, c.autofirmato ? tr("v_cert.radice_autofirmato") : c.ca ? tr("v_cert.autorita_intermedia") : tr("v_cert.certificato_finale")))));
      t.append(tb);
      page.append(el("div", { class: "panel", style: { padding: 0, overflow: "auto" } }, t));
    }
    if (certs[sel]) page.append(certPanel(certs[sel]));
    for (const o of r.altri || []) page.append(otherPanel(o));
    page.append(el("p", { class: "fx-muted fx-small", style: { margin: 0 } }, tr("v_cert.sono_mostrati_solo_i_dati")));
  }

  function chainBox(ch) {
    const box = el("div", { class: "panel" }, el("h3", {}, tr("v_cert.catena_certificazione")));
    const list = el("div", { style: { display: "grid", gap: "4px" } });
    ch.anelli.forEach((a, i) => {
      const fonte = a.fonte === "file" ? tr("v_cert.file") : a.fonte === "windows-root" ? tr("v_cert.radice_attendibile_windows") : a.fonte === "windows-ca" ? tr("v_cert.autorita_intermedia_windows") : tr("v_cert.emittente_non_disponibile");
      list.append(el("div", { style: { display: "flex", gap: "8px", alignItems: "center", paddingLeft: (i * 18) + "px" } },
        el("span", { class: "fx-muted" }, i ? "└" : "●"),
        a.indice !== null && a.indice !== undefined ? el("a", { href: "#", onclick: e => { e.preventDefault(); sel = a.indice; render(); } }, a.nome) : el("span", {}, a.nome),
        el("span", { class: "chip " + (a.fonte === "mancante" ? "warn" : a.fonte.startsWith("windows") ? "ok" : "mute") }, fonte)));
    });
    box.append(list, el("p", { class: "fx-small", style: { margin: "8px 0 0" } },
      ch.radice_attendibile ? el("span", { class: "chip ok" }, tr("v_cert.radice_tra_quelle_attendibili_windows"))
        : ch.completa ? el("span", { class: "chip warn" }, tr("v_cert.catena_completa_ma_radice_non"))
          : el("span", { class: "chip warn" }, tr("v_cert.catena_incompleta_manca_certificato_dell")),
      " ", el("span", { class: "fx-muted" }, tr("v_cert.ogni_anello_verificato_controllando_firma"))));
    return box;
  }

  render();
  return {
    saveInPlace: false,
    saveFormats: certs.length ? ["pem", "crt", "cer", "p7b", "txt"] : [],
    saveLabels: { pem: tr("v_cert.tutti_i_certificati_pem_testo"), crt: tr("v_cert.certificato_selezionato_pem"), cer: tr("v_cert.certificato_selezionato_der_binario"), p7b: tr("v_cert.tutti_i_certificati_pkcs_7"), txt: tr("v_cert.riepilogo_leggibile") },
    saveNote: tr("v_cert.si_esportano_solo_i_certificati"),
    async save(target) {
      await api("fx", { op: "cert_export" }, { json: { pem: certs.map(c => c.pem), out: target, indice: sel } });
      return { switchTo: false };
    },
  };
}

function status(c) {
  return c.scaduto ? el("span", { class: "chip bad" }, tr("v_cert.scaduto_2"))
    : c.non_ancora_valido ? el("span", { class: "chip warn" }, tr("v_cert.non_ancora_valido"))
      : el("span", { class: "chip ok" }, c.giorni_rimasti < 30 ? tr("v_cert.valido_scade_tra_0_giorni", c.giorni_rimasti) : tr("v_cert.valido"));
}

function nameTable(rows) {
  const dl = el("dl", { class: "kv" });
  for (const r of rows) dl.append(el("dt", {}, r.campo), el("dd", {}, r.valore));
  return dl;
}

function copyBtn(text) {
  return el("button", { class: "btn", title: tr("common.copia"), onclick: () => navigator.clipboard.writeText(text).then(() => toast(tr("v_cert.copiato"))) }, tr("common.copia"));
}

function certPanel(c) {
  const box = el("div", { class: "panel", style: { display: "grid", gap: "12px" } });
  box.append(el("div", { class: "fx-row" }, el("b", { style: { fontSize: "15px" } }, c.nome), status(c),
    c.autofirmato ? el("span", { class: "chip mute" }, tr("v_cert.autofirmato_radice")) : c.ca ? el("span", { class: "chip mute" }, tr("v_cert.autorita_certificazione")) : null));
  const grid = el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" } });
  grid.append(el("div", {}, el("h3", {}, tr("v_cert.soggetto")), nameTable(c.soggetto)), el("div", {}, el("h3", {}, tr("v_cert.emittente")), nameTable(c.emittente)));
  box.append(grid);
  const dl = el("dl", { class: "kv" });
  const add = (k, v, extra) => { if (v) dl.append(el("dt", {}, k), el("dd", { class: extra ? "fx-mono" : "" }, v, extra ? " " : "", extra ? copyBtn(v) : null)); };
  add(tr("v_cert.valido_2"), c.valido_dal); add(tr("v_cert.valido_fino"), c.valido_al);
  add(tr("v_cert.usi_chiave"), c.usi); add(tr("v_cert.usi_estesi"), c.usi_estesi);
  add(tr("v_cert.chiave_pubblica"), c.chiave); add(tr("v_cert.algoritmo_firma"), c.algoritmo_firma);
  add(tr("v_cert.numero_serie"), c.seriale, true); add(tr("v_cert.versione"), c.versione);
  add(tr("v_cert.impronta_sha_256"), c.sha256, true); add(tr("v_cert.impronta_sha_1"), c.sha1, true);
  box.append(el("div", {}, el("h3", {}, tr("v_cert.dettagli")), dl));
  box.append(extTable(c.estensioni));
  box.append(el("details", {}, el("summary", { style: { cursor: "pointer" } }, tr("v_cert.certificato_formato_pem")),
    el("pre", { class: "fx-mono", style: { whiteSpace: "pre-wrap", fontSize: "11.5px", margin: "8px 0 0" } }, c.pem), copyBtn(c.pem)));
  return box;
}

function extTable(exts) {
  if (!exts?.length) return el("span");
  const t = el("table", { class: "fx-table" }, el("thead", {}, el("tr", {}, el("th", {}, tr("v_cert.estensione")), el("th", {}, tr("v_cert.valore")))));
  const tb = el("tbody");
  for (const e of exts) tb.append(el("tr", {}, el("td", { title: e.oid }, e.nome, e.critica ? el("span", { class: "chip warn", style: { marginLeft: "6px" } }, "critica") : null),
    el("td", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, e.valore)));
  t.append(tb);
  return el("div", {}, el("h3", {}, tr("v_cert.estensioni")), t);
}

function otherPanel(o) {
  const box = el("div", { class: "panel", style: { display: "grid", gap: "10px" } }, el("b", { style: { fontSize: "15px" } }, o.tipo));
  if (o.soggetto) box.append(el("div", {}, el("h3", {}, tr("v_cert.soggetto")), nameTable(o.soggetto)));
  if (o.emittente) box.append(el("div", {}, el("h3", {}, tr("v_cert.emittente")), nameTable(o.emittente)));
  const dl = el("dl", { class: "kv" });
  const add = (k, v) => { if (v !== undefined && v !== "") dl.append(el("dt", {}, k), el("dd", {}, v)); };
  add(tr("v_cert.chiave_pubblica"), o.chiave);
  if (o.firma_valida !== undefined) add(tr("v_cert.firma_richiesta"), o.firma_valida ? "valida" : tr("v_cert.non_valida"));
  add(tr("v_cert.aggiornato"), o.aggiornato); add(tr("v_cert.prossimo_aggiornamento"), o.prossimo);
  if (o.revocati) add(tr("v_cert.certificati_revocati"), String(o.revocati.length));
  box.append(dl);
  if (o.revocati?.length) {
    const t = el("table", { class: "fx-table" }, el("thead", {}, el("tr", {}, el("th", {}, tr("v_cert.numero_serie")), el("th", {}, tr("v_cert.revocato")))));
    const tb = el("tbody");
    o.revocati.slice(0, 2000).forEach(x => tb.append(el("tr", {}, el("td", { class: "mono" }, x.seriale), el("td", {}, x.data))));
    t.append(tb);
    box.append(el("div", { style: { maxHeight: "320px", overflow: "auto" } }, t));
  }
  box.append(extTable(o.estensioni));
  return box;
}

async function askPassword(wrong) {
  const input = el("input", { type: "password", class: "field", autocomplete: "off", style: { width: "100%" } });
  const body = el("div", { style: { display: "grid", gap: "8px", minWidth: "340px" } },
    el("p", { style: { margin: 0 } }, tr("v_cert.file_pkcs_12_protetto_password")),
    wrong ? el("p", { class: "err", style: { margin: 0 } }, tr("v_cert.password_errata_riprova")) : null, input);
  setTimeout(() => input.focus(), 50);
  input.addEventListener("keydown", e => { if (e.key === "Enter") document.querySelector("#modal .btn.primary")?.click(); });
  const ok = await modal(tr("v_cert.password_certificato"), body, [{ label: tr("common.annulla"), value: false }, { label: tr("v_cert.leggi"), value: true, primary: true }]);
  const v = ok ? input.value : null;
  input.value = "";
  return v;
}
