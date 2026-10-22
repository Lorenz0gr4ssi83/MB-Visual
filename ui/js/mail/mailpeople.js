// Contatti della posta (Ctrl+3): rubriche degli account (CardDAV, Microsoft 365, Google, locali), scheda del contatto con
// tutti i dati del vCard, "Scrivi", messaggi scambiati, commesse in cui compare; nuovo/modifica/elimina.
import { el, loadCss, modal, toast } from "../core.js";
import { collator, t as tr } from "../i18n.js";
import { parseVcards } from "../pim.js";
import { ap, avatarColor, call as _call, fmtWhen, icon, initials } from "./mailapp.js";

export async function mount(host, { search, call = _call }) {
  loadCss("css/mailcal.css");
  const S = { items: [], books: [], sel: null, q: "" };
  const list = el("div", { class: "pp-list" });
  const card = el("section", { class: "pp-card" });
  const head = el("div", { class: "pp-head" });
  host.append(el("div", { class: "pp-root" }, el("aside", { class: "pp-side" }, head, list), card));

  async function load() {
    try {
      const r = await call("contacts", {});
      S.items = r.items.sort((a, b) => collator.compare(a.name || "", b.name || ""));
      S.books = r.rubriche;
    } catch (e) { toast(e.message, true); }
    render();
  }

  function render() {
    head.innerHTML = "";
    head.append(el("button", { class: "btn primary", onclick: () => edit(null) }, icon("piu"), tr("mail.nuovo_contatto")),
      el("span", { class: "muted mono" }, String(S.items.length)));
    list.innerHTML = "";
    const q = S.q;
    const vis = S.items.filter(c => !q || `${c.name} ${c.org} ${c.emails.join(" ")} ${c.phones.join(" ")}`.toLowerCase().includes(q));
    let letter = "";
    for (const c of vis) {
      const l = (c.name || "?")[0].toUpperCase();
      if (l !== letter) { list.append(el("div", { class: "pp-letter label" }, l)); letter = l; }
      list.append(el("button", { class: "pp-row" + (S.sel === c.id ? " sel" : ""), onclick: () => { S.sel = c.id; render(); show(c); } },
        el("span", { class: "ml-av", style: { background: avatarColor(c.emails[0] || c.name) } }, initials(c.name)),
        el("span", { class: "tx" }, el("b", {}, c.name || c.emails[0] || "?"), el("span", { class: "muted" }, c.org || c.emails[0] || ""))));
    }
    if (!vis.length) list.append(el("p", { class: "muted pp-empty" }, q ? tr("mail.nessun_risultato") : tr("mail.nessun_contatto")));
    if (!S.sel) { card.innerHTML = ""; card.append(el("div", { class: "ml-noread" }, el("div", { html: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/></svg>' }), el("p", {}, tr("mail.seleziona_contatto")))); }
  }

  async function show(c) {
    card.innerHTML = "";
    let full = null;
    try { const r = await call("contacts", { id: c.id }); full = parseVcards(r.contatto.vcf || "")[0] || null; } catch { /* */ }
    const kv = el("dl", { class: "kv pp-kv" });
    const row = (k, ...v) => { if (v.some(x => x)) kv.append(el("dt", {}, k), el("dd", {}, ...v)); };
    for (const e of c.emails) row(tr("mail.email"), el("button", { class: "link", onclick: () => write(c, e) }, e));
    for (const p of full?.telefoni || c.phones.map(v => ({ valore: v }))) row(tr("mail.telefono") + (p.tipo ? ` (${p.tipo})` : ""), p.valore);
    if (full) {
      row(tr("mail.azienda"), [full.azienda, full.reparto].filter(Boolean).join(" · "));
      row(tr("mail.qualifica"), full.qualifica);
      for (const a of full.indirizzi) row(tr("mail.indirizzo"), [a.via, a.cap, a.citta, a.provincia, a.paese].filter(Boolean).join(", "));
      for (const s of full.siti) row(tr("mail.sito"), s);
      row(tr("mail.compleanno"), full.compleanno);
      row(tr("mail.note"), full.note);
    } else row(tr("mail.azienda"), c.org);
    row(tr("mail.rubrica"), c.book);
    const msgs = el("div", { class: "pp-msgs" }, el("div", { class: "label" }, tr("mail.messaggi_recenti")));
    ap(card, el("div", { class: "pp-top" },
      full?.foto ? el("img", { class: "pp-photo", src: full.foto, alt: "" }) : el("span", { class: "ml-av big", style: { background: avatarColor(c.emails[0] || c.name) } }, initials(c.name)),
      el("div", { class: "fx" }, el("h2", {}, c.name), el("div", { class: "muted" }, [full?.qualifica, c.org].filter(Boolean).join(" · "))),
      el("div", { class: "pp-acts" },
        c.emails.length ? el("button", { class: "btn primary", onclick: () => write(c, c.emails[0]) }, icon("nuovo"), tr("mail.scrivi")) : null,
        el("button", { class: "btn", onclick: () => edit(c, full) }, tr("mail.modifica")),
        el("button", { class: "btn danger", onclick: () => del(c) }, tr("mail.elimina")))), kv, msgs);
    if (c.emails.length) {
      try {
        const r = await call("list", { folder: "tutto", q: `da:${c.emails[0]}`, limit: 12 });
        const r2 = await call("list", { folder: "tutto", q: `a:${c.emails[0]}`, limit: 12 });
        const all = [...r.items, ...r2.items].sort((a, b) => b.date - a.date).slice(0, 15);
        for (const m of all) {
          msgs.append(el("button", { class: "pp-msg", onclick: async () => (await import("./mailapp.js")).openMessage(m.id) },
            el("span", { class: "mono muted" }, fmtWhen(m.date)), el("b", {}, m.subject || tr("mail.senza_oggetto")), m.has_att ? icon("allegato") : null));
        }
        if (!all.length) msgs.append(el("p", { class: "muted" }, tr("mail.nessun_messaggio_contatto")));
      } catch { /* */ }
    }
  }

  async function write(c, addr) {
    const { newMessage } = await import("./mailapp.js");
    newMessage({ to: addr });
  }

  async function del(c) {
    const ok = await modal(tr("mail.elimina_contatto"), el("p", {}, tr("mail.elimina_contatto_domanda", c.name)), [{ label: tr("common.annulla"), value: false }, { label: tr("mail.elimina"), value: true, danger: true }]);
    if (!ok) return;
    await call("contact_delete", { id: c.id });
    S.sel = null;
    load();
  }

  async function edit(c, full) {
    const f = (lab, inp) => el("label", { class: "ml-field" }, el("span", { class: "k" }, lab), inp);
    const inp = v => el("input", { type: "text", class: "field", value: v || "" });
    const name = inp(c?.name), org = inp(c?.org), title = inp(full?.qualifica);
    const emails = el("textarea", { class: "field", rows: 2 }, (c?.emails || []).join("\n"));
    const phones = el("textarea", { class: "field", rows: 2 }, (c?.phones || []).join("\n"));
    const addr = inp(full?.indirizzi?.[0] ? [full.indirizzi[0].via, full.indirizzi[0].citta].filter(Boolean).join(", ") : "");
    const note = el("textarea", { class: "field", rows: 3 }, full?.note || "");
    const book = el("select", { class: "field" }, ...S.books.map(b => el("option", { value: b.id }, b.name)));
    if (c) book.value = String(c.book_id); else if (S.books[0]) book.value = String(S.books[0].id);
    book.disabled = !!c;
    const form = el("div", { class: "ml-form" }, f(tr("mail.nome"), name), el("div", { class: "ml-grid2" }, f(tr("mail.azienda"), org), f(tr("mail.qualifica"), title)),
      el("div", { class: "ml-grid2" }, f(tr("mail.email") + " (" + tr("mail.una_per_riga") + ")", emails), f(tr("mail.telefono") + " (" + tr("mail.una_per_riga") + ")", phones)),
      f(tr("mail.indirizzo"), addr), f(tr("mail.note"), note), f(tr("mail.rubrica"), book));
    setTimeout(() => name.focus(), 50);
    const r = await modal(c ? tr("mail.modifica_contatto") : tr("mail.nuovo_contatto"), form, [{ label: tr("common.annulla"), value: null }, { label: tr("common.salva"), value: true, primary: true }]);
    if (!r) return;
    const lines = x => x.value.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    try {
      const res = await call("contact_save", { id: c?.id, book: +book.value, name: name.value.trim(), org: org.value.trim(), title: title.value.trim(),
        emails: lines(emails).map(e => e.toLowerCase()), phones: lines(phones), address: addr.value.trim(), note: note.value });
      S.sel = res.id;
      await load();
      const n = S.items.find(x => x.id === res.id);
      if (n) show(n);
    } catch (e) { toast(e.message, true); }
  }

  await load();
  return {
    dispose() {},
    newContact: () => edit(null),
    search: () => { S.q = search.value.trim().toLowerCase(); render(); },
  };
}
