// Certificati digitali (.cer/.crt/.pem/.der/.p7b/.p12/.pfx/.csr/.crl): soggetto, emittente, validita', usi, estensioni,
// catena di certificazione. Solo dati pubblici: per i PKCS#12 la password serve per una sola lettura e non resta da nessuna parte
// (non si salva, non resta nella scheda: le esportazioni usano i certificati gia' letti). Motore: mbvisual/fx_cert.py
import { api, button, el, loadCss, loading, modal, toast } from "../core.js";

export async function mount(ctx) {
  loadCss("css/formati.css");
  loading(ctx.el, "Lettura del certificato");
  let r = await api("fx", { op: "cert_read", path: ctx.path }, { json: {} });
  while (r.password_richiesta) {
    const pw = await askPassword(r.errata);
    if (pw === null) { ctx.el.innerHTML = ""; ctx.el.append(el("div", { class: "fx-empty" }, "Serve la password del file PKCS#12 per leggerne i certificati.", el("br"), el("br"), el("button", { class: "btn primary", onclick: () => ctx.openAs("cert") }, "Inserisci la password"))); return {}; }
    loading(ctx.el, "Lettura del certificato");
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
    page.append(el("div", { class: "fx-row" }, el("h2", {}, certs.length ? (certs.length > 1 ? `${certs.length} certificati` : "Certificato: " + first.nome) : (r.altri[0]?.tipo || "Certificato")),
      certs.length ? status(certs[sel]) : null));
    for (const n of r.note || []) page.append(el("p", { class: "fx-muted", style: { margin: 0 } }, n));
    // catene
    for (const ch of r.catene || []) page.append(chainBox(ch));
    if (certs.length > 1) {
      const t = el("table", { class: "fx-table" }, el("thead", {}, el("tr", {}, ...["", "Soggetto", "Emittente", "Valido fino al", "Tipo"].map(h => el("th", {}, h)))));
      const tb = el("tbody");
      certs.forEach((c, i) => tb.append(el("tr", { class: "click" + (i === sel ? " sel" : ""), onclick: () => { sel = i; render(); } },
        el("td", {}, i + 1), el("td", {}, c.nome), el("td", {}, c.emittente_nome), el("td", {}, c.valido_al, c.scaduto ? " (scaduto)" : ""),
        el("td", {}, c.autofirmato ? "Radice (autofirmato)" : c.ca ? "Autorita' intermedia" : "Certificato finale"))));
      t.append(tb);
      page.append(el("div", { class: "panel", style: { padding: 0, overflow: "auto" } }, t));
    }
    if (certs[sel]) page.append(certPanel(certs[sel]));
    for (const o of r.altri || []) page.append(otherPanel(o));
    page.append(el("p", { class: "fx-muted fx-small", style: { margin: 0 } }, "Sono mostrati solo i dati pubblici. Le chiavi private non vengono lette ne' esportate; la password dei file .p12/.pfx non viene salvata."));
  }

  function chainBox(ch) {
    const box = el("div", { class: "panel" }, el("h3", {}, "Catena di certificazione"));
    const list = el("div", { style: { display: "grid", gap: "4px" } });
    ch.anelli.forEach((a, i) => {
      const fonte = a.fonte === "file" ? "nel file" : a.fonte === "windows-root" ? "radice attendibile di Windows" : a.fonte === "windows-ca" ? "autorita' intermedia di Windows" : "emittente non disponibile";
      list.append(el("div", { style: { display: "flex", gap: "8px", alignItems: "center", paddingLeft: (i * 18) + "px" } },
        el("span", { class: "fx-muted" }, i ? "└" : "●"),
        a.indice !== null && a.indice !== undefined ? el("a", { href: "#", onclick: e => { e.preventDefault(); sel = a.indice; render(); } }, a.nome) : el("span", {}, a.nome),
        el("span", { class: "chip " + (a.fonte === "mancante" ? "warn" : a.fonte.startsWith("windows") ? "ok" : "mute") }, fonte)));
    });
    box.append(list, el("p", { class: "fx-small", style: { margin: "8px 0 0" } },
      ch.radice_attendibile ? el("span", { class: "chip ok" }, "La radice e' tra quelle attendibili di Windows")
        : ch.completa ? el("span", { class: "chip warn" }, "Catena completa, ma la radice non e' tra quelle attendibili di Windows")
          : el("span", { class: "chip warn" }, "Catena incompleta: manca il certificato dell'emittente"),
      " ", el("span", { class: "fx-muted" }, "Ogni anello e' verificato controllando la firma del certificato con la chiave dell'emittente.")));
    return box;
  }

  render();
  return {
    saveInPlace: false,
    saveFormats: certs.length ? ["pem", "crt", "cer", "p7b", "txt"] : [],
    saveLabels: { pem: "Tutti i certificati in PEM (testo Base64)", crt: "Certificato selezionato in PEM", cer: "Certificato selezionato in DER (binario)", p7b: "Tutti i certificati in PKCS#7", txt: "Riepilogo leggibile" },
    saveNote: "Si esportano solo i certificati pubblici (mai le chiavi private).",
    async save(target) {
      await api("fx", { op: "cert_export" }, { json: { pem: certs.map(c => c.pem), out: target, indice: sel } });
      return { switchTo: false };
    },
  };
}

function status(c) {
  return c.scaduto ? el("span", { class: "chip bad" }, "Scaduto")
    : c.non_ancora_valido ? el("span", { class: "chip warn" }, "Non ancora valido")
      : el("span", { class: "chip ok" }, c.giorni_rimasti < 30 ? `Valido, scade tra ${c.giorni_rimasti} giorni` : "Valido");
}

function nameTable(rows) {
  const dl = el("dl", { class: "kv" });
  for (const r of rows) dl.append(el("dt", {}, r.campo), el("dd", {}, r.valore));
  return dl;
}

function copyBtn(text) {
  return el("button", { class: "btn", title: "Copia", onclick: () => navigator.clipboard.writeText(text).then(() => toast("Copiato")) }, "Copia");
}

function certPanel(c) {
  const box = el("div", { class: "panel", style: { display: "grid", gap: "12px" } });
  box.append(el("div", { class: "fx-row" }, el("b", { style: { fontSize: "15px" } }, c.nome), status(c),
    c.autofirmato ? el("span", { class: "chip mute" }, "Autofirmato (radice)") : c.ca ? el("span", { class: "chip mute" }, "Autorita' di certificazione") : null));
  const grid = el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" } });
  grid.append(el("div", {}, el("h3", {}, "Soggetto"), nameTable(c.soggetto)), el("div", {}, el("h3", {}, "Emittente"), nameTable(c.emittente)));
  box.append(grid);
  const dl = el("dl", { class: "kv" });
  const add = (k, v, extra) => { if (v) dl.append(el("dt", {}, k), el("dd", { class: extra ? "fx-mono" : "" }, v, extra ? " " : "", extra ? copyBtn(v) : null)); };
  add("Valido dal", c.valido_dal); add("Valido fino al", c.valido_al);
  add("Usi della chiave", c.usi); add("Usi estesi", c.usi_estesi);
  add("Chiave pubblica", c.chiave); add("Algoritmo di firma", c.algoritmo_firma);
  add("Numero di serie", c.seriale, true); add("Versione", c.versione);
  add("Impronta SHA-256", c.sha256, true); add("Impronta SHA-1", c.sha1, true);
  box.append(el("div", {}, el("h3", {}, "Dettagli"), dl));
  box.append(extTable(c.estensioni));
  box.append(el("details", {}, el("summary", { style: { cursor: "pointer" } }, "Certificato in formato PEM"),
    el("pre", { class: "fx-mono", style: { whiteSpace: "pre-wrap", fontSize: "11.5px", margin: "8px 0 0" } }, c.pem), copyBtn(c.pem)));
  return box;
}

function extTable(exts) {
  if (!exts?.length) return el("span");
  const t = el("table", { class: "fx-table" }, el("thead", {}, el("tr", {}, el("th", {}, "Estensione"), el("th", {}, "Valore"))));
  const tb = el("tbody");
  for (const e of exts) tb.append(el("tr", {}, el("td", { title: e.oid }, e.nome, e.critica ? el("span", { class: "chip warn", style: { marginLeft: "6px" } }, "critica") : null),
    el("td", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, e.valore)));
  t.append(tb);
  return el("div", {}, el("h3", {}, "Estensioni"), t);
}

function otherPanel(o) {
  const box = el("div", { class: "panel", style: { display: "grid", gap: "10px" } }, el("b", { style: { fontSize: "15px" } }, o.tipo));
  if (o.soggetto) box.append(el("div", {}, el("h3", {}, "Soggetto"), nameTable(o.soggetto)));
  if (o.emittente) box.append(el("div", {}, el("h3", {}, "Emittente"), nameTable(o.emittente)));
  const dl = el("dl", { class: "kv" });
  const add = (k, v) => { if (v !== undefined && v !== "") dl.append(el("dt", {}, k), el("dd", {}, v)); };
  add("Chiave pubblica", o.chiave);
  if (o.firma_valida !== undefined) add("Firma della richiesta", o.firma_valida ? "valida" : "NON valida");
  add("Aggiornato il", o.aggiornato); add("Prossimo aggiornamento", o.prossimo);
  if (o.revocati) add("Certificati revocati", String(o.revocati.length));
  box.append(dl);
  if (o.revocati?.length) {
    const t = el("table", { class: "fx-table" }, el("thead", {}, el("tr", {}, el("th", {}, "Numero di serie"), el("th", {}, "Revocato il"))));
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
    el("p", { style: { margin: 0 } }, "Il file PKCS#12 e' protetto. La password serve solo a leggere i certificati pubblici e non viene salvata."),
    wrong ? el("p", { class: "err", style: { margin: 0 } }, "Password errata, riprova.") : null, input);
  setTimeout(() => input.focus(), 50);
  input.addEventListener("keydown", e => { if (e.key === "Enter") document.querySelector("#modal .btn.primary")?.click(); });
  const ok = await modal("Password del certificato", body, [{ label: "Annulla", value: false }, { label: "Leggi", value: true, primary: true }]);
  const v = ok ? input.value : null;
  input.value = "";
  return v;
}
