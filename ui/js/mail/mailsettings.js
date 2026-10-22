// Impostazioni della posta: account (IMAP/SMTP con configurazione automatica, PEC dei gestori italiani, Microsoft 365
// e Gmail con accesso OAuth), firme HTML, risposte rapide, categorie, regole, commesse, opzioni.
import { el, modal, pickFolder, toast, waitJob } from "../core.js";
import { t as tr } from "../i18n.js";
import { afterAccountsChanged, ap, call, icon } from "./mailapp.js";
import { IC } from "./mailicons.js";

const OAUTH_READY = false;

// ------------------------------------------------------------------ finestra a schede (sopra la posta)
let W = null;
function win(title, tabs, start) {
  W?.close();
  const back = el("div", { class: "ml-dlgback" });
  const side = el("nav", { class: "ml-dlgnav" });
  const main = el("div", { class: "ml-dlgmain" });
  const box = el("div", { class: "ml-dlg" },
    el("header", {}, el("h3", {}, title), el("button", { class: "ml-dlgx", html: IC.chiudi, title: tr("common.chiudi"), onclick: () => W.close() })),
    el("div", { class: "ml-dlgbody" }, side, main));
  back.append(box);
  document.body.append(back);
  const onKey = e => { if (e.key === "Escape" && document.getElementById("modal").hidden) { e.stopPropagation(); W.close(); } };
  document.addEventListener("keydown", onKey, true);
  W = {
    close() { back.remove(); document.removeEventListener("keydown", onKey, true); W = null; afterAccountsChanged(); },
    show(k) {
      for (const b of side.children) b.classList.toggle("on", b.dataset.k === k);
      main.innerHTML = "";
      const t = tabs.find(x => x[0] === k);
      Promise.resolve(t[3](main)).catch(e => main.append(el("p", { class: "bad" }, e.message)));
    },
    main,
  };
  for (const [k, label, ic] of tabs) {
    const b = el("button", { "data-k": k, onclick: () => W.show(k) }, icon(ic), el("span", {}, label));
    side.append(b);
  }
  W.show(start || tabs[0][0]);
  return W;
}

const TABS = () => [
  ["account", tr("mail.account"), "posta", renderAccounts],
  ["firme", tr("mail.firme"), "firma", renderSignatures],
  ["risposte", tr("mail.risposte_rapide"), "risposte", renderQuick],
  ["categorie", tr("mail.categorie"), "categoria", renderCats],
  ["regole", tr("mail.regole"), "regole", renderRules],
  ["commesse", tr("mail.commesse"), "commessa", renderCommesse],
  ["opzioni", tr("mail.opzioni"), "impostazioni", renderOptions],
];

export function openSettings(tab) { win(tr("mail.impostazioni_posta"), TABS(), tab); }

const field = (label, input, hint) => el("label", { class: "ml-field" }, el("span", { class: "k" }, label), input, hint ? el("span", { class: "hint" }, hint) : null);
const inp = (value = "", type = "text", ph = "") => el("input", { type, value: value ?? "", placeholder: ph || undefined, class: "field" });
const sel = (value, opts) => { const s = el("select", { class: "field" }, ...opts.map(([v, l]) => el("option", { value: v }, l))); s.value = value ?? opts[0][0]; return s; };
const check = (on, label) => { const c = el("input", { type: "checkbox", checked: on || undefined }); return [c, el("label", { class: "ml-check" }, c, label)]; };

// ------------------------------------------------------------------ account
async function renderAccounts(main) {
  const { account } = await call("accounts", {});
  ap(main, el("div", { class: "ml-dlghead" }, el("h4", {}, tr("mail.account")),
    el("button", { class: "btn primary", onclick: () => addAccount() }, icon("piu"), tr("mail.aggiungi_account"))));
  if (!account.length) main.append(el("p", { class: "muted" }, tr("mail.nessun_account")));
  for (const a of account) {
    ap(main, el("div", { class: "ml-acccard" },
      el("div", { class: "ml-av", style: { background: a.colore || "var(--chrome-4)" } }, (a.nome || a.email || "?")[0].toUpperCase()),
      el("div", { class: "fx" }, el("b", {}, a.nome || a.email), el("div", { class: "muted" }, a.email),
        el("div", { class: "muted mono" }, a.tipo === "graph" ? "Microsoft Graph" : `${a.imap}:${a.imap_port} · ${a.smtp}:${a.smtp_port}`, a.oauth ? " · OAuth" : "", a.pec ? " · PEC" : "")),
      el("button", { class: "btn", onclick: () => editAccount(a) }, tr("mail.modifica")),
      el("button", { class: "btn danger", onclick: async () => {
        if (await confirmDel(tr("mail.rimuovi_account_conferma", a.email))) { await call("account_delete", { id: a.id }); W?.show("account"); }
      } }, tr("mail.rimuovi"))));
  }
  ap(main, el("p", { class: "note muted" }, tr("mail.account_nota_sicurezza")));
}
const confirmDel = text => modal(tr("mail.conferma"), el("p", {}, text), [{ label: tr("common.annulla"), value: false }, { label: tr("mail.rimuovi"), value: true, danger: true }]);

export async function addAccount(opts = {}) {
  if (!W) win(tr("mail.impostazioni_posta"), TABS(), "account");
  const main = W.main;
  main.innerHTML = "";
  const { preset } = await call("accounts", {});
  const kinds = [
    ["imap", tr("mail.tipo_imap"), tr("mail.tipo_imap_nota"), "posta"],
    ["pec", tr("mail.tipo_pec"), tr("mail.tipo_pec_nota"), "pec"],
    ["microsoft", "Microsoft 365 / Outlook.com", tr("mail.tipo_microsoft_nota"), "nuvola"],
    ["google", "Gmail / Google Workspace", tr("mail.tipo_google_nota"), "nuvola"],
  ];
  if (!OAUTH_READY) kinds.splice(2, 2); // Microsoft 365 e Google con OAuth: tappa successiva
  let kind = opts.pec ? "pec" : "imap";
  const cards = el("div", { class: "ml-kinds" });
  const form = el("div", { class: "ml-form" });
  const drawKinds = () => {
    cards.innerHTML = "";
    for (const [k, l, n, ic] of kinds) cards.append(el("button", { class: "ml-kind" + (k === kind ? " on" : ""), onclick: () => { kind = k; drawKinds(); drawForm(); } }, icon(ic), el("b", {}, l), el("span", {}, n)));
  };
  const email = inp("", "email", "nome@dominio.it"), pw = inp("", "password"), name = inp("", "text", tr("mail.nome_visualizzato_ph"));
  const pecSel = sel("", [["", tr("mail.gestore_auto")], ...preset.pec.map(p => [p.id, p.nome])]);
  email.addEventListener("change", () => {
    const d = email.value.split("@")[1]?.toLowerCase();
    const p = d && preset.pec.find(x => x.domini.includes(d));
    if (p) { pecSel.value = p.id; if (kind === "imap") { kind = "pec"; drawKinds(); drawForm(); } }
    if (OAUTH_READY && d && ["gmail.com", "googlemail.com"].includes(d) && kind === "imap") { kind = "google"; drawKinds(); drawForm(); }
    if (OAUTH_READY && d && ["outlook.com", "hotmail.com", "hotmail.it", "live.com", "live.it", "msn.com"].includes(d) && kind === "imap") { kind = "microsoft"; drawKinds(); drawForm(); }
  });
  const status = el("div", { class: "ml-wizstatus" });
  function drawForm() {
    form.innerHTML = "";
    status.innerHTML = "";
    ap(form, field(tr("mail.indirizzo_email"), email), field(tr("mail.nome_visualizzato"), name, tr("mail.nome_visualizzato_hint")));
    if (kind === "microsoft" || kind === "google") {
      ap(form, el("p", { class: "muted" }, tr(kind === "microsoft" ? "mail.oauth_microsoft_spieg" : "mail.oauth_google_spieg")),
        el("div", { class: "ml-row-btns" }, el("button", { class: "btn primary", onclick: () => oauth(kind) }, icon("apri"), tr(kind === "microsoft" ? "mail.accedi_microsoft" : "mail.accedi_google")),
          el("button", { class: "btn", onclick: () => openGuide() }, tr("mail.apri_guida"))));
      if (kind === "google") form.append(el("p", { class: "note muted" }, tr("mail.google_password_app")),
        el("button", { class: "link", onclick: () => { kind = "imap"; drawKinds(); drawForm(); email.dispatchEvent(new Event("change")); } }, tr("mail.usa_password_app")));
      return;
    }
    if (kind === "pec") form.append(field(tr("mail.gestore_pec"), pecSel));
    ap(form, field(tr("mail.password"), pw, kind === "pec" ? tr("mail.password_pec_hint") : tr("mail.password_hint")),
      el("div", { class: "ml-row-btns" }, el("button", { class: "btn primary", onclick: () => configure() }, tr("mail.avanti"))));
  }
  async function configure() {
    const addr = email.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return toast(tr("mail.indirizzo_non_valido"), true);
    let cfg;
    if (kind === "pec" && pecSel.value) {
      const p = preset.pec.find(x => x.id === pecSel.value);
      cfg = { fonte: "preimpostato", tipo: "imap", ...p, gestore: p.nome, utente: addr, nota: p.nota ? tr(p.nota) : "" };
    } else {
      status.innerHTML = "";
      ap(status, el("div", { class: "spinner" }), el("span", { id: "ml-acst" }, tr("mail.ricerca_impostazioni")));
      try {
        const { job } = await call("autoconfig", { email: addr });
        cfg = await waitJob(job, (p, m) => { const s = document.getElementById("ml-acst"); if (s && m) s.textContent = m; });
      } catch (e) { cfg = { fonte: "nessuna" }; status.append(el("p", { class: "bad" }, e.message)); }
    }
    if (OAUTH_READY && cfg.tipo === "graph") { kind = "microsoft"; drawKinds(); drawForm(); return; }
    if (OAUTH_READY && cfg.oauth === "google") { kind = "google"; drawKinds(); drawForm(); return; }
    if (!OAUTH_READY) { delete cfg.oauth; if (cfg.tipo === "graph") Object.assign(cfg, { tipo: "imap", imap: "outlook.office365.com", imap_port: 993, imap_sec: "ssl", smtp: "smtp.office365.com", smtp_port: 587, smtp_sec: "starttls" }); }
    editAccount({ ...cfg, email: addr, nome: name.value.trim() || addr, pec: kind === "pec" || !!cfg.pec, _new: true, _password: pw.value, _found: cfg.fonte });
  }
  async function oauth(provider) {
    const addr = email.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return toast(tr("mail.indirizzo_non_valido"), true);
    status.innerHTML = "";
    ap(status, el("div", { class: "spinner" }), el("span", {}, tr("mail.attesa_browser")));
    try {
      const r = await call("oauth_login", { provider, email: addr, nome: name.value.trim() });
      const res = await waitJob(r.job);
      toast(tr("mail.account_aggiunto", res.email || addr));
      W?.show("account");
    } catch (e) {
      status.innerHTML = "";
      ap(status, el("p", { class: "bad" }, e.message));
      if (/configur|client/i.test(e.message)) status.append(el("button", { class: "btn", onclick: () => import("../cloud.js").then(m => m.configure?.()) }, tr("mail.configura_id_app")));
    }
  }
  ap(main, el("div", { class: "ml-dlghead" }, el("h4", {}, tr("mail.aggiungi_account"))), cards, form, status);
  drawKinds();
  drawForm();
}

export async function editAccount(a) {
  if (!W) win(tr("mail.impostazioni_posta"), TABS(), "account");
  const main = W.main;
  main.innerHTML = "";
  const isNew = !!a._new;
  const f = {
    nome: inp(a.nome), email: inp(a.email, "email"), utente: inp(a.utente || a.email), password: inp(a._password || "", "password", a.ha_password ? "••••••••" : ""),
    imap: inp(a.imap), imap_port: inp(a.imap_port || 993, "number"), imap_sec: sel(a.imap_sec || "ssl", [["ssl", "SSL/TLS"], ["starttls", "STARTTLS"], ["none", tr("mail.nessuna")]]),
    smtp: inp(a.smtp), smtp_port: inp(a.smtp_port || 465, "number"), smtp_sec: sel(a.smtp_sec || "ssl", [["ssl", "SSL/TLS"], ["starttls", "STARTTLS"], ["none", tr("mail.nessuna")]]),
    utente_smtp: inp(a.utente_smtp || "", "text", tr("mail.come_imap")), password_smtp: inp("", "password", tr("mail.come_imap")),
    intervallo: inp(a.intervallo || 3, "number"), scarica_giorni: sel(String(a.scarica_giorni ?? 365), [["30", tr("mail.giorni_30")], ["90", tr("mail.giorni_90")], ["365", tr("mail.giorni_365")], ["0", tr("mail.giorni_tutto")]]),
    alias: inp((a.alias || []).join(", "), "text", "info@studio.it, ..."), colore: inp(a.colore || "#5f93d0", "color"),
    caldav: inp(a.caldav || "", "text", "https://..."), carddav: inp(a.carddav || "", "text", "https://..."),
  };
  const [pec, pecRow] = check(a.pec, tr("mail.casella_pec"));
  const [save, saveRow] = check(a.salva_inviati !== false, tr("mail.salva_copia_inviata"));
  const graph = a.tipo === "graph";
  const st = el("div", { class: "ml-wizstatus" });
  const found = a._found && a._found !== "nessuna" ? el("div", { class: "ml-bar info" }, icon("ok"), el("span", {}, tr("mail.trovate_impostazioni_" + a._found, a.gestore || ""))) :
    a._found === "nessuna" ? el("div", { class: "ml-bar warn" }, icon("errore"), el("span", {}, tr("mail.impostazioni_non_trovate"))) : null;
  ap(main, el("div", { class: "ml-dlghead" }, el("h4", {}, isNew ? tr("mail.nuovo_account") : a.email)), found,
    a.nota ? el("div", { class: "ml-bar" }, icon("importante"), el("span", {}, a.nota)) : null,
    el("div", { class: "ml-grid2" }, field(tr("mail.nome_visualizzato"), f.nome), field(tr("mail.indirizzo_email"), f.email)),
    graph ? el("p", { class: "muted" }, tr("mail.account_graph_nota")) : el("div", {},
      el("div", { class: "ml-grid2" }, field(tr("mail.nome_utente"), f.utente), a.oauth ? el("div") : field(tr("mail.password"), f.password)),
      el("h5", {}, tr("mail.posta_in_arrivo_imap")),
      el("div", { class: "ml-grid3" }, field(tr("mail.server"), f.imap), field(tr("mail.porta"), f.imap_port), field(tr("mail.sicurezza"), f.imap_sec)),
      el("h5", {}, tr("mail.posta_in_uscita_smtp")),
      el("div", { class: "ml-grid3" }, field(tr("mail.server"), f.smtp), field(tr("mail.porta"), f.smtp_port), field(tr("mail.sicurezza"), f.smtp_sec)),
      el("details", { class: "ml-adv" }, el("summary", {}, tr("mail.avanzate")),
        el("div", { class: "ml-grid2" }, field(tr("mail.utente_smtp"), f.utente_smtp), field(tr("mail.password_smtp"), f.password_smtp)),
        el("div", { class: "ml-grid2" }, field(tr("mail.caldav"), f.caldav, tr("mail.caldav_hint")), field(tr("mail.carddav"), f.carddav, tr("mail.carddav_hint"))))),
    el("div", { class: "ml-grid3 eq" }, field(tr("mail.controlla_ogni_min"), f.intervallo), field(tr("mail.lettura_senza_rete"), f.scarica_giorni), field(tr("mail.colore"), f.colore)),
    field(tr("mail.alias"), f.alias, tr("mail.alias_hint")),
    pecRow, graph ? null : saveRow, st,
    el("div", { class: "ml-row-btns" },
      el("button", { class: "btn", onclick: () => (isNew ? addAccount() : W.show("account")) }, tr("common.annulla")),
      graph ? null : el("button", { class: "btn", onclick: () => test(false) }, tr("mail.prova")),
      el("button", { class: "btn primary", onclick: () => test(true) }, isNew ? tr("mail.prova_e_salva") : tr("common.salva"))));
  const body = () => {
    const b = { ...(isNew ? {} : { id: a.id }), tipo: a.tipo || "imap", oauth: a.oauth || "", nome: f.nome.value.trim(), email: f.email.value.trim().toLowerCase(),
      utente: f.utente.value.trim(), imap: f.imap.value.trim(), imap_port: +f.imap_port.value, imap_sec: f.imap_sec.value,
      smtp: f.smtp.value.trim(), smtp_port: +f.smtp_port.value, smtp_sec: f.smtp_sec.value, utente_smtp: f.utente_smtp.value.trim(),
      pec: pec.checked, salva_inviati: save.checked, intervallo: Math.max(1, +f.intervallo.value || 3), scarica_giorni: +f.scarica_giorni.value,
      alias: f.alias.value.split(/[,;\s]+/).filter(x => x.includes("@")), colore: f.colore.value, caldav: f.caldav.value.trim(), carddav: f.carddav.value.trim(),
      gestore: a.gestore || "" };
    if (f.password.value) b.password = f.password.value;
    if (f.password_smtp.value) b.password_smtp = f.password_smtp.value;
    return b;
  };
  async function test(andSave) {
    const b = body();
    if (graph) { await call("account_save", b); toast(tr("mail.salvato")); W.show("account"); return; }
    st.innerHTML = "";
    ap(st, el("div", { class: "spinner" }), el("span", {}, tr("mail.prova_in_corso")));
    let r;
    try { r = await waitJob((await call("account_test", { ...b, id: isNew ? null : a.id })).job); } catch (e) { r = { imap: { ok: false, errore: e.message } }; }
    st.innerHTML = "";
    const line = (k, x) => el("div", { class: "ml-testline " + (x?.ok ? "ok" : "bad") }, icon(x?.ok ? "ok" : "errore"), el("b", {}, k), el("span", {}, x?.ok ? tr("mail.funziona") : x?.errore || "-"));
    ap(st, line("IMAP", r.imap), line("SMTP", r.smtp));
    const ok = r.imap?.ok && r.smtp?.ok;
    if (!andSave) return;
    if (!ok) {
      const go = await modal(tr("mail.prova_non_riuscita"), el("p", {}, tr("mail.salvare_comunque")), [{ label: tr("common.annulla"), value: false }, { label: tr("mail.salva_comunque"), value: true }]);
      if (!go) return;
    }
    await call("account_save", b);
    toast(isNew ? tr("mail.account_aggiunto", b.email) : tr("mail.salvato"));
    W.show("account");
  }
}

export function openGuide() {
  call("guide_path", {}).then(r => window.MB.openFile(r.path)).catch(e => toast(e.message, true));
}

// ------------------------------------------------------------------ firme
async function renderSignatures(main) {
  const { account } = await call("accounts", {});
  ap(main, el("div", { class: "ml-dlghead" }, el("h4", {}, tr("mail.firme"))), el("p", { class: "muted" }, tr("mail.firme_spieg")));
  if (!account.length) return main.append(el("p", {}, tr("mail.nessun_account")));
  const pick = sel(account[0].id, account.map(a => [a.id, a.nome + " <" + a.email + ">"]));
  const ed = el("div", { class: "ml-editor ml-sigedit", contenteditable: "true" });
  const [n, nRow] = check(true, tr("mail.firma_nuovi"));
  const [r, rRow] = check(true, tr("mail.firma_risposte"));
  const load = () => {
    const a = account.find(x => x.id === pick.value);
    ed.innerHTML = a.firma || "";
    n.checked = a.firma_nuovi !== false;
    r.checked = a.firma_risposte !== false;
  };
  pick.addEventListener("change", load);
  const exec = (c, v) => { ed.focus(); document.execCommand(c, false, v); };
  const fb = (ic, title, run) => el("button", { class: "ml-fbtn", title, html: IC[ic], onmousedown: e => e.preventDefault(), onclick: run });
  ap(main, field(tr("mail.account"), pick),
    el("div", { class: "ml-fbar" }, fb("grassetto", tr("mail.grassetto"), () => exec("bold")), fb("corsivo", tr("mail.corsivo"), () => exec("italic")),
      fb("colore", tr("mail.colore_testo"), () => exec("foreColor", "#ea7426")), fb("link", tr("mail.inserisci_link"), async () => {
        const u = await askVal(tr("mail.inserisci_link"), "https://"); if (u) exec("createLink", u);
      }), fb("immagine", tr("mail.inserisci_immagine"), async () => {
        const { pickFiles, readBytes } = await import("../core.js");
        const ps = await pickFiles();
        if (!ps?.[0]) return;
        const b = await readBytes(ps[0]);
        let s = "";
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
        const ext = ps[0].split(".").pop().toLowerCase();
        exec("insertImage", `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${btoa(s)}`);
      })), ed, nRow, rRow,
    el("div", { class: "ml-row-btns" }, el("button", { class: "btn primary", onclick: async () => {
      const a = account.find(x => x.id === pick.value);
      await call("account_save", { id: a.id, firma: ed.innerHTML.trim(), firma_nuovi: n.checked, firma_risposte: r.checked });
      a.firma = ed.innerHTML.trim();
      toast(tr("mail.salvato"));
    } }, tr("common.salva"))));
  load();
}

async function askVal(title, v) {
  const i = inp(v);
  return modal(title, i, [{ label: tr("common.annulla"), value: null }, { label: "OK", primary: true, value: () => i.value.trim() }]);
}

// ------------------------------------------------------------------ risposte rapide
async function renderQuick(main) {
  const { s } = await call("settings", {});
  const list = s.risposte_rapide || [];
  ap(main, el("div", { class: "ml-dlghead" }, el("h4", {}, tr("mail.risposte_rapide"))), el("p", { class: "muted" }, tr("mail.risposte_spieg")));
  const box = el("div", { class: "ml-list2" });
  const draw = () => {
    box.innerHTML = "";
    list.forEach((q, i) => {
      const n = inp(q.nome), t = el("textarea", { class: "field", rows: 3 }, q.testo || "");
      n.addEventListener("input", () => (q.nome = n.value));
      t.addEventListener("input", () => (q.testo = t.value));
      box.append(el("div", { class: "ml-qr" }, n, t, el("button", { class: "btn danger", onclick: () => { list.splice(i, 1); draw(); } }, tr("mail.rimuovi"))));
    });
  };
  draw();
  ap(main, box, el("div", { class: "ml-row-btns" },
    el("button", { class: "btn", onclick: () => { list.push({ nome: tr("mail.nuova_risposta"), testo: "" }); draw(); } }, icon("piu"), tr("mail.aggiungi")),
    el("button", { class: "btn primary", onclick: async () => { await call("settings_set", { s: { risposte_rapide: list.filter(q => q.nome) } }); toast(tr("mail.salvato")); } }, tr("common.salva"))));
}

// ------------------------------------------------------------------ categorie
async function renderCats(main) {
  const { s } = await call("settings", {});
  const list = s.categorie.map(c => ({ ...c }));
  ap(main, el("div", { class: "ml-dlghead" }, el("h4", {}, tr("mail.categorie"))), el("p", { class: "muted" }, tr("mail.categorie_spieg")));
  const box = el("div", { class: "ml-list2" });
  const draw = () => {
    box.innerHTML = "";
    list.forEach((c, i) => {
      const n = inp(c.nome), col = inp(c.colore, "color");
      n.addEventListener("input", () => (c.nome = n.value));
      col.addEventListener("input", () => (c.colore = col.value));
      box.append(el("div", { class: "ml-catrow" }, col, n, el("button", { class: "btn danger", onclick: () => { list.splice(i, 1); draw(); } }, tr("mail.rimuovi"))));
    });
  };
  draw();
  ap(main, box, el("div", { class: "ml-row-btns" },
    el("button", { class: "btn", onclick: () => { list.push({ nome: tr("mail.nuova_categoria"), colore: "#8a8c89" }); draw(); } }, icon("piu"), tr("mail.aggiungi")),
    el("button", { class: "btn primary", onclick: async () => { await call("settings_set", { s: { categorie: list.filter(c => c.nome) } }); toast(tr("mail.salvato")); } }, tr("common.salva"))));
}

// ------------------------------------------------------------------ regole
async function renderRules(main) {
  const r = await call("rules", {});
  ap(main, el("div", { class: "ml-dlghead" }, el("h4", {}, tr("mail.regole")), el("button", { class: "btn primary", onclick: () => editRule({}) }, icon("piu"), tr("mail.nuova_regola"))),
    el("p", { class: "muted" }, tr("mail.regole_spieg")));
  if (!r.items.length) main.append(el("p", { class: "muted" }, tr("mail.nessuna_regola")));
  for (const x of r.items) {
    ap(main, el("div", { class: "ml-acccard" }, icon("regole"),
      el("div", { class: "fx" }, el("b", {}, x.nome || tr("mail.regola")), el("div", { class: "muted" }, describeRule(x))),
      el("span", { class: "chip " + (x.attiva ? "ok" : "mute") }, x.attiva ? tr("mail.attiva") : tr("mail.disattivata")),
      el("button", { class: "btn", onclick: () => editRule(x) }, tr("mail.modifica")),
      el("button", { class: "btn danger", onclick: async () => { if (await confirmDel(tr("mail.elimina_regola"))) { await call("rule_delete", { id: x.id }); W.show("regole"); } } }, tr("mail.rimuovi"))));
  }
}

function describeRule(x) {
  const c = x.cond || {}, a = x.azioni || {};
  const cs = [c.da && tr("mail.r_da") + " " + c.da, c.a && tr("mail.r_a") + " " + c.a, c.oggetto && tr("mail.r_oggetto") + " " + c.oggetto,
    c.corpo && tr("mail.r_corpo") + " " + c.corpo, c.allegati && tr("mail.r_allegati"), c.pec && "PEC: " + c.pec].filter(Boolean);
  const as = [a.sposta && tr("mail.r_sposta"), a.letto && tr("mail.r_letto"), a.contrassegna && tr("mail.r_contrassegna"),
    a.categoria && tr("mail.r_categoria") + " " + a.categoria, a.commessa && tr("mail.r_commessa"), a.elimina && tr("mail.r_elimina")].filter(Boolean);
  return (cs.join(" · ") || tr("mail.r_tutti")) + " → " + (as.join(", ") || "-");
}

export async function editRule(x = {}) {
  if (!W) win(tr("mail.impostazioni_posta"), TABS(), "regole");
  const main = W.main;
  main.innerHTML = "";
  const [F, { s }, { items: comm }] = await Promise.all([call("folders", {}), call("settings", {}), call("commesse", {})]);
  const c = x.cond || {}, a = x.azioni || {};
  const nome = inp(x.nome || ""), da = inp(c.da || ""), dest = inp(c.a || ""), ogg = inp(c.oggetto || ""), corpo = inp(c.corpo || "");
  const [att, attRow] = check(c.allegati, tr("mail.r_con_allegati"));
  const pec = sel(c.pec || "", [["", "-"], ["tutte", tr("mail.r_pec_tutte")], ["ricevute", tr("mail.r_pec_ricevute")], ["posta-certificata", tr("mail.r_pec_messaggi")]]);
  const accSel = sel(x.account || "*", [["*", tr("mail.tutti_account")], ...F.account.map(z => [z.id, z.email])]);
  const folders = [["", "-"], ...F.account.flatMap(z => z.cartelle.filter(f => !f.noselect).map(f => [String(f.id), `${z.email} › ${f.role ? tr("mail.cart_" + f.role) : f.path}`]))];
  const move = sel(String(a.sposta || ""), folders);
  const [read, readRow] = check(a.letto, tr("mail.r_segna_letto"));
  const [flag, flagRow] = check(a.contrassegna, tr("mail.r_contrassegna"));
  const cat = sel(a.categoria || "", [["", "-"], ...s.categorie.map(z => [z.nome, z.nome])]);
  const com = sel(a.commessa || "", [["", "-"], ...comm.map(z => [z.id, (z.codice ? z.codice + " · " : "") + z.nome])]);
  const [arch, archRow] = check(a.archivia, tr("mail.r_archivia_cartella"));
  const [del, delRow] = check(a.elimina, tr("mail.r_elimina"));
  const [stop, stopRow] = check(x.stop, tr("mail.r_stop"));
  const [on, onRow] = check(x.attiva !== 0, tr("mail.attiva"));
  ap(main, el("div", { class: "ml-dlghead" }, el("h4", {}, x.id ? tr("mail.modifica_regola") : tr("mail.nuova_regola"))),
    field(tr("mail.nome"), nome), field(tr("mail.account"), accSel),
    el("h5", {}, tr("mail.r_quando")), el("p", { class: "note muted" }, tr("mail.r_quando_hint")),
    el("div", { class: "ml-grid2" }, field(tr("mail.r_da"), da), field(tr("mail.r_a"), dest), field(tr("mail.r_oggetto"), ogg), field(tr("mail.r_corpo"), corpo), field("PEC", pec)), attRow,
    el("h5", {}, tr("mail.r_allora")),
    el("div", { class: "ml-grid2" }, field(tr("mail.r_sposta"), move), field(tr("mail.r_categoria"), cat), field(tr("mail.r_commessa"), com)),
    archRow, readRow, flagRow, delRow, stopRow, onRow,
    el("div", { class: "ml-row-btns" }, el("button", { class: "btn", onclick: () => W.show("regole") }, tr("common.annulla")),
      el("button", { class: "btn primary", onclick: async () => {
        await call("rule_save", { id: x.id, nome: nome.value.trim(), account: accSel.value, attiva: on.checked ? 1 : 0, stop: stop.checked ? 1 : 0,
          cond: { da: da.value.trim(), a: dest.value.trim(), oggetto: ogg.value.trim(), corpo: corpo.value.trim(), allegati: att.checked, pec: pec.value },
          azioni: { sposta: move.value ? +move.value : 0, letto: read.checked, contrassegna: flag.checked, categoria: cat.value, commessa: com.value, archivia: arch.checked, elimina: del.checked } });
        toast(tr("mail.salvato"));
        W.show("regole");
      } }, tr("common.salva"))));
}

export async function runRulesOn(f) {
  const r = await call("rules", {});
  if (!r.items.length) return toast(tr("mail.nessuna_regola"), true);
  const s = sel(String(r.items[0].id), r.items.map(x => [String(x.id), x.nome || describeRule(x)]));
  const go = await modal(tr("mail.esegui_regole"), field(tr("mail.regola"), s), [{ label: tr("common.annulla"), value: false }, { label: tr("mail.esegui"), value: true, primary: true }]);
  if (!go) return;
  const res = await call("rule_run", { id: +s.value, folder: f.id });
  toast(tr("mail.regola_applicata_n", res.n));
}

// ------------------------------------------------------------------ commesse
async function renderCommesse(main) {
  const { items } = await call("commesse", {});
  ap(main, el("div", { class: "ml-dlghead" }, el("h4", {}, tr("mail.commesse")), el("button", { class: "btn primary", onclick: () => editCommessa(null, () => W?.show("commesse")) }, icon("piu"), tr("mail.nuova_commessa"))),
    el("p", { class: "muted" }, tr("mail.commesse_spieg")));
  for (const c of items) {
    ap(main, el("div", { class: "ml-acccard" }, el("span", { class: "ml-catdot big", style: { background: c.colore || "var(--brand)" } }),
      el("div", { class: "fx" }, el("b", {}, (c.codice ? c.codice + " · " : "") + c.nome), el("div", { class: "muted mono" }, c.cartella || tr("mail.nessuna_cartella"))),
      el("span", { class: "muted" }, String(c.messaggi)),
      el("button", { class: "btn", onclick: () => editCommessa(c, () => W?.show("commesse")) }, tr("mail.modifica"))));
  }
  const [auto, autoRow] = check(true, tr("mail.commesse_auto"));
  const { s } = await call("settings", {});
  auto.checked = s.commesse_auto !== false;
  auto.addEventListener("change", () => call("settings_set", { s: { commesse_auto: auto.checked } }));
  const sub = inp(s.commesse_sottocartella ?? "Posta");
  sub.addEventListener("change", () => call("settings_set", { s: { commesse_sottocartella: sub.value.trim() } }));
  ap(main, el("h5", {}, tr("mail.opzioni")), autoRow, field(tr("mail.sottocartella_posta"), sub, tr("mail.sottocartella_hint")));
}

export async function editCommessa(c, done) {
  const nome = inp(c?.nome || ""), codice = inp(c?.codice || "", "text", "24-017"), cartella = inp(c?.cartella || ""), colore = inp(c?.colore || "#f07d2e", "color");
  const parole = inp((c?.parole || []).join(", ")), indirizzi = inp((c?.indirizzi || []).join(", "));
  const [chiusa, chiusaRow] = check(c?.chiusa, tr("mail.commessa_chiusa"));
  const body = el("div", { class: "ml-form" },
    el("div", { class: "ml-grid2" }, field(tr("mail.nome"), nome), field(tr("mail.codice"), codice, tr("mail.codice_hint"))),
    field(tr("mail.cartella_progetto"), el("div", { class: "ml-inline" }, cartella, el("button", { class: "btn", onclick: async () => { const d = await pickFolder(); if (d) cartella.value = d; } }, tr("mail.sfoglia")))),
    field(tr("mail.parole_chiave"), parole, tr("mail.parole_hint")), field(tr("mail.indirizzi_referenti"), indirizzi, tr("mail.indirizzi_hint")),
    field(tr("mail.colore"), colore), chiusaRow);
  const r = await modal(c ? tr("mail.modifica_commessa") : tr("mail.nuova_commessa"), body, [
    ...(c ? [{ label: tr("mail.elimina"), value: "del", danger: true }] : []),
    { label: tr("common.annulla"), value: null }, { label: tr("common.salva"), value: "ok", primary: true }]);
  if (r === "del") {
    await call("commessa_delete", { id: c.id });
    return done?.(null);
  }
  if (r !== "ok") return;
  if (!nome.value.trim()) return toast(tr("mail.commessa_nome_obbligatorio"), true);
  const res = await call("commessa_save", { id: c?.id, nome: nome.value.trim(), codice: codice.value.trim(), cartella: cartella.value.trim(), colore: colore.value,
    parole: parole.value.split(/[,;]+/).map(x => x.trim()).filter(Boolean), indirizzi: indirizzi.value.split(/[,;\s]+/).filter(x => x.includes("@")), chiusa: chiusa.checked ? 1 : 0 });
  done?.({ id: res.id, nome: nome.value.trim(), codice: codice.value.trim(), cartella: cartella.value.trim() });
}

// ------------------------------------------------------------------ opzioni
async function renderOptions(main) {
  const { s } = await call("settings", {});
  const save = v => call("settings_set", { s: v }).then(() => toast(tr("mail.salvato"), false, 1200));
  const [rec, recRow] = check(s.nascondi_ricevute !== false, tr("mail.opt_nascondi_ricevute"));
  rec.addEventListener("change", () => save({ nascondi_ricevute: rec.checked }));
  const [not, notRow] = check(s.notifiche !== false, tr("mail.opt_notifiche"));
  not.addEventListener("change", () => save({ notifiche: not.checked }));
  const letto = sel(String(s.segna_letto_dopo ?? 2), [["0", tr("mail.subito")], ["2", tr("mail.dopo_2s")], ["5", tr("mail.dopo_5s")], ["-1", tr("mail.mai")]]);
  letto.addEventListener("change", () => save({ segna_letto_dopo: +letto.value }));
  const soglia = inp(s.soglia_link || 20, "number");
  soglia.addEventListener("change", () => save({ soglia_link: Math.max(1, +soglia.value || 20) }));
  let svcs = [];
  try { svcs = (await call("bigfile_services", {})).servizi; } catch { /* */ }
  const svc = sel(s.servizio_link || "", [["", tr("mail.primo_collegato")], ...svcs.map(x => [x.id, x.nome + (x.connesso ? "" : " (" + tr("mail.non_collegato") + ")")])]);
  svc.addEventListener("change", () => save({ servizio_link: svc.value }));
  const imgs = (s.immagini_remote || []);
  ap(main, el("div", { class: "ml-dlghead" }, el("h4", {}, tr("mail.opzioni"))),
    recRow, notRow, field(tr("mail.opt_segna_letto"), letto),
    el("h5", {}, tr("mail.invii_grandi")), el("p", { class: "muted" }, tr("mail.invii_grandi_spieg")),
    el("div", { class: "ml-grid2" }, field(tr("mail.soglia_mb"), soglia), field(tr("mail.servizio_link"), svc)),
    el("h5", {}, tr("mail.immagini_remote")), el("p", { class: "muted" }, imgs.length ? imgs.join(", ") : tr("mail.immagini_remote_nessuno")),
    imgs.length ? el("button", { class: "btn", onclick: () => save({ immagini_remote: [] }).then(() => W.show("opzioni")) }, tr("mail.azzera_elenco")) : null);
}
