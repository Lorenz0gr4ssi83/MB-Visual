// Lettura dei testi di un DWG per la ricerca nel progetto (ui/js/search.js), in un worker: l'interfaccia resta libera.
// Un worker nuovo per ogni disegno: alla fine viene chiuso e la memoria del motore libredwg si libera tutta.
import { Dwg_File_Type, LibreDwg } from "/vendor/libredwg/dist/libredwg-web.js";

const str = v => (typeof v === "string" ? v : v && typeof v === "object" && typeof v.text === "string" ? v.text : "");

function collect(db) {
  const items = [];
  const blocks = new Map((db.tables?.BLOCK_RECORD?.entries || []).map(b => [b.handle, b]));
  const paper = new Set([...blocks.values()].filter(b => /^\*paper_space/i.test(b.name || "")).map(b => b.handle));
  const one = (e, blk) => {
    const t = e.type;
    let text = "";
    if (t === "TEXT" || t === "MTEXT") text = str(e.text);
    else if (t === "ATTRIB" || t === "ATTDEF") text = (e.tag ? e.tag + "=" : "") + str(e.text);
    else if (t === "DIMENSION") text = str(e.text).replace("<>", "").trim();
    else if (t === "INSERT" && e.name && !e.name.startsWith("*")) items.push([e.handle, "BLOCCO", e.layer, e.name, blk]);
    else if (t === "MULTILEADER") text = str(e.contextData?.mtext?.text || e.text);
    else if (t === "ACAD_TABLE") text = (e.cells || []).map(c => str(c.text || c.value)).filter(Boolean).join(" ");
    if (text && text.trim()) items.push([e.handle, t, e.layer, text, blk]);
    for (const a of e.attribs || []) one(a, blk);
  };
  for (const e of db.entities || []) one(e, null);
  for (const b of blocks.values()) {
    const name = b.name || "";
    if (/^\*model_space/i.test(name)) continue;
    const blk = paper.has(b.handle) ? null : name;
    if (blk && blk.startsWith("*")) continue; // blocchi anonimi (quote, retini): il testo utile e' nelle entita' principali
    for (const e of b.entities || []) one(e, blk);
  }
  const layers = (db.tables?.LAYER?.entries || []).map(l => l.name).filter(Boolean);
  const names = [...blocks.values()].map(b => b.name).filter(n => n && !n.startsWith("*"));
  return { items, layers, blocks: names };
}

self.onmessage = async ev => {
  const { bytes } = ev.data;
  try {
    const lib = await LibreDwg.create("/vendor/libredwg/wasm");
    const data = lib.dwg_read_data(bytes, Dwg_File_Type.DWG);
    if (data === undefined || data === null) throw new Error("versione non supportata o file danneggiato");
    const db = lib.convert(data);
    try { lib.dwg_free(data); } catch { /* */ }
    self.postMessage(collect(db));
  } catch (e) {
    self.postMessage({ error: String(e?.message || e) });
  }
};
