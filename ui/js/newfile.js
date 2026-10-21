// "Crea nuovo": file vuoti dei formati modificabili, aperti subito nel loro editor.
// Office, PDF, DXF e database partono dai modelli in ui/templates (tools/make_templates.py); gli altri si generano qui.
import { api, el, modal, pickSavePath, toast, WEB } from "./core.js";

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

const TYPES = [
  ["Documenti", [
    ["docx", "Documento Word (A4)", "Nuovo documento", () => tpl("vuoto.docx")],
    ["xlsx", "Foglio di calcolo Excel", "Nuovo foglio", () => tpl("vuoto.xlsx")],
    ["pptx", "Presentazione PowerPoint (16:9)", "Nuova presentazione", () => tpl("vuoto.pptx")],
    ["csv", "Tabella CSV (separatore ;)", "Nuova tabella", () => enc("﻿Colonna 1;Colonna 2;Colonna 3\r\n")],
  ]],
  ["PDF", [
    ["pdf", "PDF A4 verticale", "Nuovo PDF", () => tpl("vuoto_A4.pdf")],
    ["pdf", "PDF A4 orizzontale", "Nuovo PDF", () => tpl("vuoto_A4_orizzontale.pdf")],
    ["pdf", "PDF A3 verticale", "Nuovo PDF", () => tpl("vuoto_A3.pdf")],
    ["pdf", "PDF A3 orizzontale", "Nuovo PDF", () => tpl("vuoto_A3_orizzontale.pdf")],
  ]],
  ["Disegno CAD (DXF, si apre in AutoCAD e in ogni CAD)", [
    ["dxf", "Disegno vuoto (millimetri)", "Nuovo disegno", () => tpl("vuoto.dxf")],
    ["dxf", "Foglio A4 con squadratura e cartiglio", "Nuovo disegno A4", () => tpl("foglio_A4.dxf")],
    ["dxf", "Foglio A3 con squadratura e cartiglio", "Nuovo disegno A3", () => tpl("foglio_A3.dxf")],
    ["dxf", "Foglio A2 con squadratura e cartiglio", "Nuovo disegno A2", () => tpl("foglio_A2.dxf")],
    ["dxf", "Foglio A1 con squadratura e cartiglio", "Nuovo disegno A1", () => tpl("foglio_A1.dxf")],
  ]],
  ["Testo e codice", [
    ["txt", "Testo semplice", "Nuovo testo", () => enc("")],
    ["md", "Documento Markdown", "Nuovo documento", () => enc("# Titolo\n\nTesto del documento.\n")],
    ["html", "Pagina web HTML", "Nuova pagina", () => enc('<!doctype html>\n<html lang="it">\n<head>\n  <meta charset="utf-8">\n  <title>Nuova pagina</title>\n</head>\n<body>\n  <h1>Titolo</h1>\n  <p>Testo.</p>\n</body>\n</html>\n')],
    ["json", "Dati JSON", "Nuovi dati", () => enc("{\n  \n}\n")],
    ["xml", "Documento XML", "Nuovo documento", () => enc('<?xml version="1.0" encoding="UTF-8"?>\n<radice>\n</radice>\n')],
    ["py", "Script Python", "nuovo_script", () => enc("")],
    ["bat", "Script Windows (.bat)", "nuovo_script", () => enc("@echo off\r\n")],
  ]],
  ["Immagini", [
    ["png", "Immagine PNG 1920 × 1080", "Nuova immagine", () => canvasImage(1920, 1080, "image/png")],
    ["png", "Immagine PNG A4 a 300 dpi (2480 × 3508)", "Nuova immagine", () => canvasImage(2480, 3508, "image/png")],
    ["jpg", "Immagine JPG 1920 × 1080", "Nuova immagine", () => canvasImage(1920, 1080, "image/jpeg")],
    ["svg", "Disegno vettoriale SVG", "Nuovo disegno", () => enc('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">\n  <rect width="800" height="600" fill="#ffffff"/>\n</svg>\n')],
  ]],
  ["Dati", [
    ["sqlite", "Database SQLite (con una tabella d'esempio)", "Nuovo database", () => tpl("vuoto.sqlite")],
  ]],
];

export async function createNew({ dir = "", openFile }) {
  const list = el("select", { size: 18, class: "field", id: "new-type", style: { width: "100%", minWidth: "360px" } });
  const items = [];
  for (const [group, entries] of TYPES) {
    const g = el("optgroup", { label: group });
    for (const it of entries) { g.append(el("option", { value: items.length }, `${it[1]}  (.${it[0]})`)); items.push(it); }
    list.append(g);
  }
  list.selectedIndex = 0;
  list.addEventListener("dblclick", () => document.querySelector("#modal .btn.primary")?.click());
  const ok = await modal("Crea un nuovo file", list, [{ label: "Annulla", value: false }, { label: "Crea", value: true, primary: true }]);
  if (!ok) return;
  const [ext, , base, make] = items[+list.value];
  let bytes;
  try { bytes = await make(); } catch (e) { return toast(e.message, true); }
  if (WEB) {
    // web app: il file nasce nella memoria del dispositivo; si scarica con Salva
    const path = window.MBV_API.register(new Blob([bytes]), `${base}.${ext}`);
    return openFile(path);
  }
  const target = await pickSavePath(`${base}.${ext}`, dir);
  if (!target) return;
  const path = /\.[^.\\/]+$/.test(target) ? target : `${target}.${ext}`;
  try {
    await api("save", { path }, { body: bytes });
  } catch (e) { return toast("Creazione non riuscita: " + e.message, true); }
  toast("Creato: " + path.split(/[\\/]/).pop());
  return openFile(path);
}
