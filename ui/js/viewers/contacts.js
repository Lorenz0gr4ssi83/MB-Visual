// Contatti vCard (.vcf/.vcard, versioni 2.1/3.0/4.0, anche molti contatti in un file): schede con foto, ricerca,
// dettagli; esportazione in CSV ed Excel. Lettura in ui/js/pim.js (funziona anche nella web app).
import { el, loadCss, readBytes, toast } from "../core.js";
import { decodeText, parseVcards, saveTable } from "../pim.js";

export async function mount(ctx) {
  loadCss("css/formati.css");
  const cards = parseVcards(decodeText(await readBytes(ctx.path)));
  ctx.el.innerHTML = "";
  ctx.fillBody(true);
  let sel = cards[0] || null, query = "";
  const list = el("div", { class: "fx-cards", style: { padding: "14px" } });
  const main = el("div", { style: { overflow: "auto", height: "100%" } }, list);
  const detail = el("div", { class: "fx-pane" }, el("div", { class: "head" }, "Contatto"), el("div", { class: "scroll" }));
  ctx.el.append(el("div", { class: "fx-split with-right" }, main, detail));
  const search = el("input", { type: "search", placeholder: "Cerca nome, azienda, telefono, email", style: { width: "280px" } });
  ctx.tb.append(el("b", { style: { padding: "0 8px" } }, `${cards.length} contatt${cards.length === 1 ? "o" : "i"}`), el("span", { class: "grow" }), search);
  search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); renderList(); });

  function photo(c) {
    const ph = el("div", { class: "vc-ph" });
    if (c.foto) { const i = el("img", { src: c.foto, alt: "" }); i.onerror = () => { i.remove(); ph.textContent = initials(c); }; ph.append(i); }
    else ph.textContent = initials(c);
    return ph;
  }

  function renderList() {
    list.innerHTML = "";
    const shown = cards.filter(c => !query || JSON.stringify([c.nome, c.azienda, c.telefoni, c.email, c.note, c.indirizzi]).toLowerCase().includes(query));
    for (const c of shown) {
      const tel = c.telefoni.find(t => t.pref) || c.telefoni[0];
      list.append(el("div", { class: "panel vc-card" + (c === sel ? " sel" : ""), onclick: () => { sel = c; renderList(); renderDetail(); } }, photo(c),
        el("div", { style: { minWidth: 0 } }, el("div", { class: "vc-name" }, c.nome),
          el("div", { class: "fx-muted fx-small" }, [c.qualifica, c.azienda].filter(Boolean).join(" · ")),
          tel ? el("div", { class: "fx-small" }, tel.valore) : null, c.email[0] ? el("div", { class: "fx-small", style: { overflowWrap: "anywhere" } }, c.email[0].valore) : null)));
    }
    if (!shown.length) list.append(el("div", { class: "fx-empty" }, cards.length ? "Nessun contatto corrisponde alla ricerca." : "Nessun contatto nel file."));
    ctx.status(`${shown.length} / ${cards.length} contatti`);
  }

  function renderDetail() {
    const box = detail.querySelector(".scroll");
    box.innerHTML = "";
    if (!sel) return;
    const c = sel;
    box.append(el("div", { style: { display: "flex", gap: "12px", alignItems: "center", padding: "14px" } }, photo(c),
      el("div", {}, el("div", { class: "vc-name" }, c.nome), el("div", { class: "fx-muted fx-small" }, [c.qualifica, c.ruolo].filter(Boolean).join(" · ")))));
    const dl = el("dl", { class: "kv stack", style: { padding: "0 14px 14px" } });
    const add = (k, v) => { if (v) dl.append(el("dt", {}, k), el("dd", { style: { whiteSpace: "pre-wrap" } }, v)); };
    add("Azienda", [c.azienda, c.reparto].filter(Boolean).join(" - "));
    for (const t of c.telefoni) add("Telefono" + (t.tipo ? ` (${t.tipo})` : ""), el("a", { href: "tel:" + t.valore.replace(/[^\d+]/g, "") }, t.valore));
    for (const m of c.email) add("Email" + (m.tipo ? ` (${m.tipo})` : ""), el("a", { href: "mailto:" + m.valore }, m.valore));
    for (const a of c.indirizzi) add("Indirizzo" + (a.tipo ? ` (${a.tipo})` : ""), addr(a));
    for (const u of c.siti) add("Sito", u);
    add("Compleanno", c.compleanno); add("Anniversario", c.anniversario); add("Soprannome", c.soprannome);
    add("Profili", c.social.join("\n")); add("Categorie", c.categorie.join(", ")); add("Note", c.note);
    add("Versione vCard", c.versione);
    box.append(dl);
  }

  const COLS = ["Nome completo", "Titolo", "Nome", "Secondo nome", "Cognome", "Suffisso", "Azienda", "Reparto", "Qualifica",
    "Email 1", "Email 2", "Email 3", "Telefono lavoro", "Cellulare", "Telefono casa", "Fax", "Altro telefono",
    "Indirizzo", "Citta'", "Provincia", "CAP", "Paese", "Sito web", "Compleanno", "Categorie", "Note"];
  function rows() {
    return cards.map(c => {
      const tel = re => (c.telefoni.find(t => re.test(t.tipo)) || {}).valore || "";
      const used = new Set([tel(/Lavoro/), tel(/Cellulare/), tel(/Casa/), tel(/Fax/)].filter(Boolean));
      const other = c.telefoni.map(t => t.valore).filter(v => !used.has(v)).join(", ");
      const a = c.indirizzi[0] || {};
      return [c.nome, c.titolo_nome, c.nome_proprio, c.altri_nomi, c.cognome, c.suffisso, c.azienda, c.reparto, c.qualifica,
        c.email[0]?.valore || "", c.email[1]?.valore || "", c.email[2]?.valore || "", tel(/Lavoro/), tel(/Cellulare/), tel(/Casa/), tel(/Fax/), other,
        [a.via, a.esteso].filter(Boolean).join(" "), a.citta || "", a.provincia || "", a.cap || "", a.paese || "", c.siti.join(" "), c.compleanno, c.categorie.join(", "), c.note];
    });
  }

  renderList();
  renderDetail();
  if (!cards.length) toast("Nessuna scheda vCard trovata nel file", true);
  return {
    saveInPlace: false,
    saveFormats: ["csv", "xlsx"],
    saveLabels: { csv: "Contatti in tabella (separatore ;)", xlsx: "Contatti in un foglio Excel" },
    async save(target) { await saveTable(target, "Contatti", COLS, rows()); return { switchTo: false }; },
  };
}

function initials(c) { return (c.nome_proprio?.[0] || c.nome[0] || "?").toUpperCase() + (c.cognome?.[0] || "").toUpperCase(); }
function addr(a) { return [a.casella, a.via, a.esteso, [a.cap, a.citta, a.provincia && `(${a.provincia})`].filter(Boolean).join(" "), a.paese].filter(Boolean).join("\n"); }
