// Aggiungi account come in Outlook: si scrive solo l'indirizzo e si preme Continua. Il motore (mbvisual/mail/wizard.py)
// capisce la strada: PEC preimpostata o casella normale -> solo la password; Gmail / Google Workspace -> accesso Google
// nel browser; Outlook.com / Microsoft 365 -> accesso Microsoft. Prova e salva da solo; errori in parole semplici.
// Le schede dei tipi e i server restano dietro "Impostazioni manuali" (mailsettings.js).
import { el, loadCss, toast, waitJob } from "../core.js";
import { t as tr } from "../i18n.js";
import { afterAccountsChanged, call, icon } from "./mailapp.js";
import { IC } from "./mailicons.js";

let D = null;

export async function addAccount() {
  loadCss("css/mail.css");
  D?.close();
  const box = el("div", { class: "ml-add" });
  const back = el("div", { class: "ml-addback" }, box);
  document.body.append(back);
  const onKey = e => { if (e.key === "Escape" && document.getElementById("modal").hidden) { e.stopPropagation(); D?.close(); } };
  document.addEventListener("keydown", onKey, true);
  const S = { email: "", det: null, job: null, provider: null };
  D = {
    close() {
      if (S.provider) call("oauth_cancel", { provider: S.provider }).catch(() => { /* */ });
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      D = null;
      afterAccountsChanged();
    },
  };
  const screen = (...kids) => {
    box.innerHTML = "";
    box.append(el("button", { class: "ml-dlgx ml-addx", title: tr("common.chiudi"), html: IC.chiudi, onclick: () => D.close() }), ...kids.filter(Boolean));
  };
  const manual = (extra = {}) => {
    D.close();
    import("./mailsettings.js").then(m => (S.det && S.det.via !== "manuale"
      ? m.editAccount({ ...S.det.cfg, email: S.email, nome: "", _new: true, _password: extra.password || "", _found: S.det.fonte, gestore: S.det.gestore })
      : m.manualAccount({ email: S.email })));
  };
  const manualLink = extra => el("button", { class: "link ml-addman", onclick: () => manual(extra) }, tr("mail.w_impostazioni_manuali"));
  const who = () => el("div", { class: "ml-addwho" }, el("span", { class: "mono" }, S.email),
    el("button", { class: "link", onclick: () => askEmail() }, tr("mail.w_cambia")));

  // ---------------------------------------------------------- 1. solo l'indirizzo
  function askEmail() {
    S.provider = null;
    const input = el("input", { type: "email", class: "ml-addin", value: S.email, placeholder: tr("mail.w_email_ph"), autocomplete: "email", spellcheck: "false" });
    const go = el("button", { class: "btn primary ml-addgo", onclick: () => next() }, tr("mail.w_continua"));
    const err = el("div", { class: "ml-adderr", hidden: true });
    input.addEventListener("keydown", e => { if (e.key === "Enter") next(); });
    screen(el("div", { class: "ml-addicon", html: IC.posta }), el("h2", {}, tr("mail.w_titolo")), el("p", { class: "muted" }, tr("mail.w_spiegazione")),
      input, err, go, manualLink());
    setTimeout(() => input.focus(), 30);
    async function next() {
      const v = input.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { err.hidden = false; err.textContent = tr("mail.w_err_indirizzo"); input.focus(); return; }
      S.email = v;
      searching();
    }
  }

  // ---------------------------------------------------------- 2. ricerca delle impostazioni
  async function searching() {
    const msg = el("p", { class: "muted" }, tr("mail.w_cerco", S.email));
    screen(el("div", { class: "spinner" }), msg);
    try {
      const { job } = await call("w_detect", { email: S.email });
      S.det = await waitJob(job, (p, m) => { if (m) msg.textContent = m; });
    } catch (e) { return askEmail(), toast(e.message, true, 6000); }
    const v = S.det.via;
    if (v === "google" || v === "microsoft") return oauthScreen(v);
    if (v === "manuale") return notFound();
    askPassword();
  }

  // ---------------------------------------------------------- 3a. password (PEC, caselle normali e aziendali)
  function askPassword(errInfo) {
    const d = S.det;
    const pw = el("input", { type: "password", class: "ml-addin", placeholder: tr("mail.password"), autocomplete: "current-password" });
    const eye = el("button", { class: "ml-addeye", title: tr("mail.w_mostra_password"), html: IC.occhio, onclick: () => { pw.type = pw.type === "password" ? "text" : "password"; } });
    const go = el("button", { class: "btn primary ml-addgo", onclick: () => submit() }, tr("mail.w_accedi"));
    const err = el("div", { class: "ml-adderr", hidden: true });
    pw.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
    const kind = d.cfg?.pec ? tr("mail.w_tipo_pec", d.gestore) : d.gestore;
    screen(el("div", { class: "ml-addicon", html: d.cfg?.pec ? IC.pec : IC.posta }), el("h2", {}, tr("mail.w_password_titolo")), who(),
      kind ? el("div", { class: "ml-addkind" }, icon(d.cfg?.pec ? "pec" : "ok"), el("span", {}, kind)) : null,
      el("div", { class: "ml-addpw" }, pw, eye), d.nota ? el("div", { class: "ml-addnote" }, d.nota) : null, err, go, manualLink({ password: "" }));
    setTimeout(() => pw.focus(), 30);
    if (errInfo) showErr(err, errInfo);
    async function submit() {
      if (!pw.value) { pw.focus(); return; }
      go.disabled = true;
      go.textContent = tr("mail.w_verifica");
      err.hidden = true;
      let r;
      try {
        const { job } = await call("w_add", { email: S.email, password: pw.value, cfg: d.cfg, gestore: d.gestore });
        r = await waitJob(job, (p, m) => { if (m) go.textContent = m; });
      } catch (e) { r = { ok: false, messaggio: e.message, aiuto: [] }; }
      go.disabled = false;
      go.textContent = tr("mail.w_accedi");
      if (r.ok) return done(r);
      showErr(err, r);
      pw.select();
    }
  }

  function showErr(err, r) {
    err.hidden = false;
    err.innerHTML = "";
    err.append(el("b", {}, r.messaggio || tr("mail.w_err_generico")));
    if (r.aiuto?.length) err.append(r.aiuto.length > 1 ? el("ol", {}, ...r.aiuto.map(a => el("li", {}, a))) : el("p", {}, r.aiuto[0]));
    if (r.link) err.append(el("button", { class: "btn", onclick: () => call("open_url", { url: r.link }) }, icon("apri"), tr("mail.w_apri_pagina_password")));
    if (r.dettaglio) err.append(el("details", {}, el("summary", {}, tr("mail.w_dettagli")), el("code", {}, r.dettaglio)));
  }

  // ---------------------------------------------------------- 3b. accesso Google / Microsoft nel browser
  async function oauthScreen(provider) {
    S.provider = provider;
    const name = provider === "google" ? "Google" : "Microsoft";
    const err = el("div", { class: "ml-adderr", hidden: true });
    const reopen = el("button", { class: "link", onclick: () => S.url && call("open_url", { url: S.url }) }, tr("mail.w_riapri_browser"));
    screen(el("div", { class: "ml-addicon", html: IC.nuvola }), el("h2", {}, tr("mail.w_accesso_titolo", name)), who(),
      el("div", { class: "ml-addwait" }, el("div", { class: "spinner" }), el("p", {}, tr("mail.w_accesso_spiega", name))), reopen, err,
      el("button", { class: "link ml-addman", onclick: () => { call("oauth_cancel", { provider }); S.provider = null; askEmail(); } }, tr("common.annulla")));
    try {
      const r = await call("oauth_login", { provider, email: S.email });
      S.url = r.url;
      const res = await waitJob(r.job);
      S.provider = null;
      done({ email: res.email, nome: "" });
    } catch (e) {
      if (!D || S.provider !== provider) return;
      S.provider = null;
      showErr(err, { messaggio: /annull|cancel/i.test(e.message) ? tr("mail.w_accesso_annullato") : e.message, aiuto: [tr("mail.w_accesso_aiuto")] });
      err.append(el("div", { class: "ml-addrow" }, el("button", { class: "btn primary", onclick: () => oauthScreen(provider) }, tr("mail.riprova"))));
    }
  }

  // ---------------------------------------------------------- 4. impostazioni non trovate
  function notFound() {
    screen(el("div", { class: "ml-addicon warn", html: IC.errore }), el("h2", {}, tr("mail.w_non_trovate_titolo")), who(),
      el("p", { class: "muted" }, tr("mail.w_non_trovate_testo", S.email.split("@")[1])),
      el("button", { class: "btn primary ml-addgo", onclick: () => manual() }, tr("mail.w_impostazioni_manuali")));
  }

  // ---------------------------------------------------------- 5. fatto
  function done(r) {
    screen(el("div", { class: "ml-addicon ok", html: IC.ok }), el("h2", {}, tr("mail.w_fatto")),
      el("p", {}, tr("mail.w_collegato", r.email || S.email)),
      el("p", { class: "muted" }, r.nome ? tr("mail.w_nome_info", r.nome) : tr("mail.w_arriva_posta")),
      el("button", { class: "btn primary ml-addgo", onclick: () => D.close() }, tr("mail.w_inizia")),
      el("button", { class: "link ml-addman", onclick: () => { S.email = ""; S.det = null; askEmail(); } }, tr("mail.w_altro_account")));
    afterAccountsChanged();
  }

  askEmail();
}
