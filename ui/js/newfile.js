// "Crea nuovo": galleria come la schermata "Nuovo" di Office (categorie a sinistra, ricerca, schede con l'icona del
// programma e la miniatura del modello). File vuoti dei formati modificabili, aperti subito nel loro editor.
// Office, PDF, DXF e database partono dai modelli in ui/templates (tools/make_templates.py); gli altri si generano qui.
import { api, el, toast, WEB } from "./core.js";
import { t as tr } from "./i18n.js";

const enc = s => new TextEncoder().encode(s);
const tpl = name => fetch("templates/" + name).then(r => { if (!r.ok) throw new Error(tr("newfile.modello_non_trovato") + name); return r.arrayBuffer(); }).then(b => new Uint8Array(b));
async function canvasImage(w, h, type) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, w, h);
  const blob = await new Promise(r => c.toBlob(r, type, 0.95));
  return new Uint8Array(await blob.arrayBuffer());
}

// [estensione, nome, nome del file, generatore, miniatura, nota]
// Un solo modello per tipo: formato, orientamento e dimensioni si cambiano poi nel programma (es. pagina del PDF,
// limiti del disegno). Niente formati di codice (basta un testo e cambiare estensione) ne' immagini non modificabili.
const TYPES = [
  [tr("newfile.nuovo"), [
    ["docx", tr("newfile.documento_word"), tr("newfile.nuovo_documento"), () => tpl("vuoto.docx"), "doc", tr("newfile.testi_relazioni_lettere")],
    ["xlsx", tr("newfile.cartella_lavoro_excel"), tr("newfile.nuovo_foglio"), () => tpl("vuoto.xlsx"), "sheet", tr("newfile.tabelle_calcoli_computi")],
    ["pptx", tr("newfile.presentazione_powerpoint"), tr("newfile.nuova_presentazione"), () => tpl("vuoto.pptx"), "slide", tr("newfile.diapositive")],
    ["mbpub", tr("newfile.pubblicazione"), tr("newfile.nuova_pubblicazione"), () => import("./pubmodel.js").then(m => m.blankMbpub()), "pub", tr("newfile.volantini_brochure_biglietti_newsletter")],
    ["vsdx", tr("newfile.diagramma"), tr("newfile.nuovo_diagramma"), () => import("./vsdmodel.js").then(m => m.blankVsdx()), "diagram-l", tr("newfile.diagrammi_flusso_schemi_visio")],
    ["mbvid", tr("newfile.progetto_video"), tr("newfile.nuovo_progetto_video"), () => import("./vidmodel.js").then(m => enc(JSON.stringify(m.newProject(), null, 1))), "video-l", tr("newfile.montaggio_video_audio_titoli_transizioni")],
    ["pdf", tr("newfile.documento_pdf"), tr("newfile.nuovo_pdf"), () => tpl("vuoto_A4.pdf"), "page", tr("newfile.moduli_testi_immagini")],
    ["dxf", tr("newfile.disegno_cad"), tr("newfile.nuovo_disegno"), () => tpl("vuoto.dxf"), "cad", tr("newfile.si_apre_autocad_ogni_cad")],
    ["png", tr("newfile.immagine"), tr("newfile.nuova_immagine"), () => canvasImage(1920, 1080, "image/png"), "image-l", tr("newfile.disegno_fotoritocco_livelli")],
    ["txt", tr("newfile.testo"), tr("newfile.nuovo_testo"), () => enc(""), "text", tr("newfile.note_appunti_codice")],
  ]],
];

// icona del programma (colori e iniziale come le app originali, senza marchi)
const APP = {
  docx: ["#185abd", "W"], xlsx: ["#107c41", "X"], csv: ["#107c41", "a,b"], pptx: ["#c43e1c", "P"], mbpub: ["#077568", "P"], vsdx: ["#3955a3", "V"], mbvid: ["#3b2d8f", "VID"], pdf: ["#d93025", "PDF"], dxf: ["#c0392b", "DXF"],
  txt: ["#5f6b76", "TXT"], md: ["#37474f", "MD"], html: ["#e65100", "</>"], json: ["#6a4fb3", "{ }"], xml: ["#00838f", "XML"], py: ["#2b6cb0", "PY"], bat: ["#3c3c3c", "BAT"],
  png: ["#0078d4", "PNG"], jpg: ["#0078d4", "JPG"], svg: ["#f57c00", "SVG"], sqlite: ["#0f6d8c", "DB"],
};
function appIcon(ext) {
  const [c, t] = APP[ext] || ["#666", ext.toUpperCase()];
  return `<svg viewBox="0 0 36 36" class="nf-app"><rect x="1" y="1" width="34" height="34" rx="7" fill="${c}"/><text x="18" y="${t.length > 2 ? 22.5 : 24.5}" text-anchor="middle" font-family="Segoe UI, Arial" font-weight="700" font-size="${t.length > 2 ? 10.5 : 17}" fill="#fff">${t.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text></svg>`;
}
// miniatura del modello (pagina, foglio, diapositiva, disegno...)
function thumb(kind, color) {
  const portrait = !/-l$|slide|sheet|cad$/.test(kind);
  const W = portrait ? 74 : 112, H = portrait ? 100 : 74, x = (120 - W) / 2, y = (110 - H) / 2;
  const page = `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="2" fill="#fff" stroke="#c9ced3"/>`;
  const lines = n => Array.from({ length: n }, (_, i) => `<rect x="${x + 9}" y="${y + 14 + i * 9}" width="${W - 18 - (i % 3 === 2 ? 18 : 0)}" height="3" rx="1.5" fill="#dfe3e7"/>`).join("");
  let inner = "";
  if (kind === "doc") inner = `<rect x="${x + 9}" y="${y + 9}" width="${W * 0.5}" height="5" rx="2" fill="${color}" opacity=".7"/>` + lines(8);
  else if (kind === "sheet") {
    for (let i = 0; i <= 6; i++) inner += `<line x1="${x}" y1="${y + 8 + i * 11}" x2="${x + W}" y2="${y + 8 + i * 11}" stroke="#dfe3e7"/>`;
    for (let j = 0; j <= 5; j++) inner += `<line x1="${x + 14 + j * 20}" y1="${y}" x2="${x + 14 + j * 20}" y2="${y + H}" stroke="#dfe3e7"/>`;
    inner += `<rect x="${x + 14}" y="${y + 8}" width="20" height="11" fill="none" stroke="${color}" stroke-width="1.6"/>`;
  } else if (kind === "pub") inner = `<rect x="${x}" y="${y}" width="${W}" height="${H * 0.3}" fill="${color}" opacity=".85"/><rect x="${x + 8}" y="${y + 9}" width="${W * 0.55}" height="5" rx="2" fill="#fff"/><rect x="${x + 8}" y="${y + H * 0.36}" width="${W - 16}" height="${H * 0.28}" fill="#dfe3e7"/><path d="M${x + 12} ${y + H * 0.6} l10 -9 7 6 5 -4 10 7z" fill="#c9ced3"/>` + Array.from({ length: 3 }, (_, i) => `<rect x="${x + 8}" y="${y + H * 0.7 + i * 7}" width="${(W - 20) / 2}" height="3" rx="1.5" fill="#dfe3e7"/><rect x="${x + W / 2 + 2}" y="${y + H * 0.7 + i * 7}" width="${(W - 20) / 2}" height="3" rx="1.5" fill="#dfe3e7"/>`).join("");
  else if (kind === "slide") inner = `<rect x="${x + 22}" y="${y + 24}" width="${W - 44}" height="8" rx="2" fill="#c9ced3"/><rect x="${x + 34}" y="${y + 38}" width="${W - 68}" height="5" rx="2" fill="#dfe3e7"/>`;
  else if (kind === "video-l") {
    // timeline: monitor in alto, tracce video (viola) e audio (verdi con forma d'onda) in basso
    inner = `<rect x="${x + 6}" y="${y + 6}" width="${W * 0.42}" height="${H * 0.38}" fill="#2b2d31"/><rect x="${x + W * 0.52}" y="${y + 6}" width="${W * 0.42}" height="${H * 0.38}" fill="#2b2d31"/><path d="M${x + W * 0.68} ${y + 13} l9 6 -9 6z" fill="#fff"/>`
      + `<rect x="${x + 6}" y="${y + H * 0.52}" width="${W * 0.36}" height="7" fill="${color}" opacity=".8"/><rect x="${x + W * 0.45}" y="${y + H * 0.52}" width="${W * 0.47}" height="7" fill="${color}" opacity=".8"/>`
      + `<rect x="${x + W * 0.22}" y="${y + H * 0.52 + 9}" width="${W * 0.3}" height="7" fill="#c46a8f" opacity=".85"/>`
      + `<rect x="${x + 6}" y="${y + H * 0.52 + 18}" width="${W - 12}" height="9" fill="#4f9b5c" opacity=".85"/>`
      + Array.from({ length: 22 }, (_, i) => `<rect x="${x + 8 + i * (W - 16) / 22}" y="${y + H * 0.52 + 22.5 - (2 + (i * 7) % 4)}" width="2" height="${(2 + (i * 7) % 4) * 2}" fill="#1d4d26"/>`).join("")
      + `<rect x="${x + W * 0.6}" y="${y + H * 0.48}" width="1.5" height="${H * 0.48}" fill="#2d8ceb"/>`;
  }
  else if (kind === "diagram-l") {
    // diagramma di flusso: inizio, processo, decisione collegati da connettori con freccia
    const bx = (cx, cy, w, h, r) => `<rect x="${x + cx - w / 2}" y="${y + cy - h / 2}" width="${w}" height="${h}" rx="${r}" fill="${color}" opacity=".85"/>`;
    const ar = (x1, y1, x2, y2) => `<path d="M${x + x1} ${y + y1}L${x + x2} ${y + y2}" stroke="#7a8691" stroke-width="1.2"/><path d="M${x + x2 - 3} ${y + y2 - 3}L${x + x2} ${y + y2}L${x + x2 + (x1 === x2 ? 3 : -3)} ${y + y2 + (x1 === x2 ? -3 : 3)}" fill="none" stroke="#7a8691" stroke-width="1.2"/>`;
    inner = bx(22, 14, 26, 10, 5) + ar(22, 19, 22, 30) + bx(22, 37, 26, 13, 1)
      + `<path d="M${x + 70} ${y + 26}l13 11 -13 11 -13 -11z" fill="${color}" opacity=".55"/>` + ar(35, 37, 56, 37) + ar(83, 37, 96, 37)
      + bx(102, 37, 12, 13, 1) + `<path d="M${x + 70} ${y + 48}V${y + 60}H${x + 22}V${y + 56}" fill="none" stroke="#7a8691" stroke-width="1.2"/>` + bx(22, 63, 26, 10, 5);
  }
  else if (kind.startsWith("page")) inner = "";
  else if (kind === "cad") inner = `<path d="M${x + 20} ${y + 55} L${x + 50} ${y + 25} L${x + 85} ${y + 45}" fill="none" stroke="${color}" stroke-width="1.4"/><circle cx="${x + 50}" cy="${y + 25}" r="2" fill="${color}"/><circle cx="${x + 68}" cy="${y + 50}" r="12" fill="none" stroke="#7a8691"/>`;
  else if (kind === "cad-sheet") inner = `<rect x="${x + 4}" y="${y + 4}" width="${W - 8}" height="${H - 8}" fill="none" stroke="#7a8691" stroke-width="1.2"/><rect x="${x + W - 48}" y="${y + H - 22}" width="44" height="18" fill="none" stroke="#7a8691"/><line x1="${x + W - 48}" y1="${y + H - 13}" x2="${x + W - 4}" y2="${y + H - 13}" stroke="#7a8691"/><line x1="${x + W - 20}" y1="${y + H - 22}" x2="${x + W - 20}" y2="${y + H - 13}" stroke="#7a8691"/>`;
  else if (kind === "text") inner = lines(9);
  else if (kind === "code") inner = Array.from({ length: 8 }, (_, i) => `<rect x="${x + 9 + (i % 4 > 0 && i % 4 < 3 ? 8 : 0)}" y="${y + 12 + i * 10}" width="${20 + (i * 13) % 30}" height="3" rx="1.5" fill="${i % 3 ? "#dfe3e7" : color}" opacity="${i % 3 ? 1 : 0.6}"/>`).join("");
  else if (kind.startsWith("image")) inner = `<path d="M${x + 8} ${y + H - 10} L${x + W * 0.4} ${y + H * 0.45} L${x + W * 0.6} ${y + H * 0.7} L${x + W * 0.75} ${y + H * 0.55} L${x + W - 8} ${y + H - 10} Z" fill="#c9ced3"/><circle cx="${x + W * 0.72}" cy="${y + H * 0.3}" r="6" fill="#dfe3e7"/>`;
  else if (kind === "db") return `<svg viewBox="0 0 120 110" class="nf-thumb"><ellipse cx="60" cy="30" rx="30" ry="10" fill="#fff" stroke="#c9ced3"/><path d="M30 30 v50 a30 10 0 0 0 60 0 v-50" fill="#fff" stroke="#c9ced3"/><path d="M30 47 a30 10 0 0 0 60 0 M30 64 a30 10 0 0 0 60 0" fill="none" stroke="#dfe3e7"/></svg>`;
  return `<svg viewBox="0 0 120 110" class="nf-thumb">${page}${inner}</svg>`;
}

export async function createNew({ openFile }) {
  const items = [];
  for (const [group, entries] of TYPES) for (const it of entries) items.push({ group, ext: it[0], name: it[1], base: it[2], make: it[3], kind: it[4], note: it[5] });
  let sel = items[0];

  return new Promise(resolve => {
    const back = el("div", { class: "nf-back", role: "dialog", "aria-label": tr("newfile.crea_nuovo_file") });
    const grid = el("div", { class: "nf-grid" });
    const createBtn = el("button", { class: "btn primary", onclick: () => go() }, tr("newfile.crea"));
    const info = el("div", { class: "nf-info" });
    const close = v => { back.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const visible = () => items;
    function renderGrid() {
      grid.innerHTML = "";
      const list = visible();
      for (const it of list) {
        const card = el("button", { class: "nf-card" + (it === sel ? " on" : ""), title: `${it.name} (.${it.ext})`,
          onclick: () => { sel = it; renderGrid(); }, ondblclick: () => { sel = it; go(); } });
        card.innerHTML = `<span class="nf-pic">${thumb(it.kind, (APP[it.ext] || ["#666"])[0])}<span class="nf-badge">${appIcon(it.ext)}</span></span>`;
        card.append(el("span", { class: "nf-name" }, it.name), el("span", { class: "nf-sub" }, `.${it.ext}${it.note ? " · " + it.note : ""}`));
        grid.append(card);
      }
      createBtn.disabled = !sel;
      info.textContent = sel ? `${sel.name} · .${sel.ext}${sel.note ? " · " + sel.note : ""}` : "";
      grid.querySelector(".nf-card.on")?.scrollIntoView({ block: "nearest" });
    }
    function go() { if (sel) close(sel); }
    const onKey = e => {
      if (e.key === "Escape") { e.preventDefault(); close(null); return; }
      if (e.key === "Enter" && sel) { e.preventDefault(); go(); return; }
      const list = visible();
      const i = list.indexOf(sel);
      const cols = Math.max(1, Math.round(grid.clientWidth / 168));
      const mv = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      if (mv && list.length) { e.preventDefault(); sel = list[Math.max(0, Math.min(list.length - 1, i + mv))]; renderGrid(); grid.querySelector(".nf-card.on")?.focus(); }
    };
    back.append(el("div", { class: "nf-box" },
      el("header", { class: "nf-head" }, el("h2", {}, tr("newfile.nuovo")), el("span", { class: "nf-hint" }, tr("newfile.scegli_tipo_file_si_apre")), el("button", { class: "nf-x", title: tr("newfile.chiudi_esc"), onclick: () => close(null) }, "×")),
      el("div", { class: "nf-body nf-single" }, grid),
      el("footer", { class: "nf-foot" }, info, el("span", { class: "grow" }), el("button", { class: "btn", onclick: () => close(null) }, tr("common.annulla")), createBtn)));
    back.addEventListener("pointerdown", e => { if (e.target === back) close(null); });
    document.body.append(back);
    document.addEventListener("keydown", onKey, true);
    renderGrid();
    grid.querySelector(".nf-card.on")?.focus();
  }).then(async chosen => {
    if (!chosen) return;
    const { ext, base, make } = chosen;
    let bytes;
    try { bytes = await make(); } catch (e) { return toast(e.message, true); }
    if (WEB) {
      // web app: il file nasce nella memoria del dispositivo; si scarica con Salva
      const path = window.MBV_API.register(new Blob([bytes]), `${base}.${ext}`);
      return openFile(path);
    }
    // il file nasce in una cartella temporanea e si apre subito: dove salvarlo si decide con Salva
    // (alla chiusura, se non e' stato salvato, l'app chiede "Vuoi salvare?")
    let path;
    try {
      path = (await api("temp_path", { name: `${base}.${ext}` })).path;
      await api("save", { path }, { body: bytes });
    } catch (e) { return toast(tr("newfile.creazione_non_riuscita") + e.message, true); }
    return openFile(path, null, { untitled: true });
  });
}
