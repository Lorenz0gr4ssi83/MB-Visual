// "Crea nuovo": galleria come la schermata "Nuovo" di Office (categorie a sinistra, ricerca, schede con l'icona del
// programma e la miniatura del modello). File vuoti dei formati modificabili, aperti subito nel loro editor.
// Office, PDF, DXF e database partono dai modelli in ui/templates (tools/make_templates.py); gli altri si generano qui.
import { api, el, toast, WEB } from "./core.js";

const enc = s => new TextEncoder().encode(s);
const tpl = name => fetch("templates/" + name).then(r => { if (!r.ok) throw new Error("Modello non trovato: " + name); return r.arrayBuffer(); }).then(b => new Uint8Array(b));
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
  ["Nuovo", [
    ["docx", "Documento Word", "Nuovo documento", () => tpl("vuoto.docx"), "doc", "Testi, relazioni, lettere"],
    ["xlsx", "Cartella di lavoro Excel", "Nuovo foglio", () => tpl("vuoto.xlsx"), "sheet", "Tabelle, calcoli, computi"],
    ["pptx", "Presentazione PowerPoint", "Nuova presentazione", () => tpl("vuoto.pptx"), "slide", "Diapositive"],
    ["mbpub", "Pubblicazione", "Nuova pubblicazione", () => import("./pubmodel.js").then(m => m.blankMbpub()), "pub", "Volantini, brochure, biglietti, newsletter"],
    ["pdf", "Documento PDF", "Nuovo PDF", () => tpl("vuoto_A4.pdf"), "page", "Moduli, testi, immagini"],
    ["dxf", "Disegno CAD", "Nuovo disegno", () => tpl("vuoto.dxf"), "cad", "Si apre in AutoCAD e in ogni CAD"],
    ["png", "Immagine", "Nuova immagine", () => canvasImage(1920, 1080, "image/png"), "image-l", "Disegno, fotoritocco, livelli"],
    ["txt", "Testo", "Nuovo testo", () => enc(""), "text", "Note, appunti, codice"],
  ]],
];

// icona del programma (colori e iniziale come le app originali, senza marchi)
const APP = {
  docx: ["#185abd", "W"], xlsx: ["#107c41", "X"], csv: ["#107c41", "a,b"], pptx: ["#c43e1c", "P"], mbpub: ["#077568", "P"], pdf: ["#d93025", "PDF"], dxf: ["#c0392b", "DXF"],
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
    const back = el("div", { class: "nf-back", role: "dialog", "aria-label": "Crea un nuovo file" });
    const grid = el("div", { class: "nf-grid" });
    const createBtn = el("button", { class: "btn primary", onclick: () => go() }, "Crea");
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
      el("header", { class: "nf-head" }, el("h2", {}, "Nuovo"), el("span", { class: "nf-hint" }, "Scegli il tipo di file: si apre subito, dove salvarlo lo decidi con Salva"), el("button", { class: "nf-x", title: "Chiudi (Esc)", onclick: () => close(null) }, "×")),
      el("div", { class: "nf-body nf-single" }, grid),
      el("footer", { class: "nf-foot" }, info, el("span", { class: "grow" }), el("button", { class: "btn", onclick: () => close(null) }, "Annulla"), createBtn)));
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
    } catch (e) { return toast("Creazione non riuscita: " + e.message, true); }
    return openFile(path, null, { untitled: true });
  });
}
