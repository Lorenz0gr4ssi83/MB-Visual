// Editor esadecimale: apre qualsiasi file (anche di molti GB) leggendo solo la parte visibile; modifica dei byte.
import { api, button, el, fmtSize, modal, readRange, toast } from "../core.js";
import { t as tr, LOCALE } from "../i18n.js";

const ROW = 16, LH = 20, BLOCK = 65536, MAX_SPACER = 8_000_000;

export async function mount(ctx) {
  const size = ctx.info.size;
  const rows = Math.max(1, Math.ceil(size / ROW));
  const cache = new Map();
  const mods = new Map(); // offset -> valore
  let cursor = 0, nibble = 0, asciiMode = false;

  // ---- intestazione informativa
  const banner = el("div", { class: "panel", style: { margin: "10px 12px 0", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" } });
  if (ctx.reason === "unlisted") {
    banner.append(el("span", { class: "chip warn" }, tr("v_hex.formato_non_nell_elenco")),
      el("span", {}, tr("v_hex.l_estensione_0_non_tra", ctx.ext || tr("v_hex.nessuna"))));
  } else {
    banner.append(el("span", { class: "chip mute" }, tr("v_hex.byte_grezzi")), el("span", {}, tr("v_hex.vista_esadecimale_contenuto_file")));
  }
  const sn = ctx.info.sniff;
  if (sn?.descr) banner.append(el("span", {}, tr("v_hex.contenuto_rilevato"), el("b", {}, sn.descr)));
  const SUGGEST = { pdf: "pdf", zip: "archive", archive: "archive", image: "image", media: "media", sqlite: "sqlite", cad2d: "cad2d",
    mesh3d: "model3d", ifc: "model3d", cad3d: "model3d", font: "font", signed: "signed", text: "text", svg: "svg", html: "html", email: "email" };
  if (sn?.kind && SUGGEST[sn.kind] && ctx.reason === "unlisted") {
    banner.append(el("button", { class: "btn primary", onclick: () => ctx.openAs(SUGGEST[sn.kind]) }, tr("v_hex.prova_ad_aprirlo_come") + sn.descr.toLowerCase()));
  }

  // ---- barra strumenti
  const goto = el("input", { type: "text", placeholder: tr("v_hex.vai_offset_es_0x1f00"), id: "hex-goto-" + ctx.tab.name, style: { width: "170px" } });
  const find = el("input", { type: "text", placeholder: tr("v_hex.cerca_testo_hex_es_25"), id: "hex-find-" + ctx.tab.name, style: { width: "230px" } });
  goto.addEventListener("keydown", e => { if (e.key === "Enter") { const v = parseInt(goto.value.trim(), goto.value.trim().toLowerCase().startsWith("0x") ? 16 : 10); if (!isNaN(v)) moveTo(Math.min(size - 1, v)); } });
  find.addEventListener("keydown", e => { if (e.key === "Enter") search(find.value); });
  ctx.tb.append(goto, find, button(tr("v_hex.cerca"), "search", () => search(find.value)),
    el("span", { class: "sep" }),
    button(tr("v_hex.testo_leggibile"), "text", showStrings, { title: tr("v_hex.estrae_stringhe_testo_presenti_file") }),
    button(tr("v_hex.annulla_modifiche"), "undo", () => { mods.clear(); ctx.setDirty(false); draw(); }),
    el("span", { class: "grow" }),
    el("span", { class: "note" }, tr("v_hex.0_1_byte_clic_byte", fmtSize(size), size.toLocaleString(LOCALE))));

  // ---- area con scorrimento virtuale
  const spacerH = Math.min(rows * LH, MAX_SPACER);
  const scroller = el("div", { style: { position: "relative", overflow: "auto", height: "100%", outline: "none" }, tabindex: "0" });
  const spacer = el("div", { style: { height: spacerH + "px" } });
  const content = el("div", { class: "hex", style: { position: "absolute", top: "0", left: "0", right: "0", padding: "6px 14px" } });
  scroller.append(spacer, content);
  const wrap = el("div", { style: { display: "grid", gridTemplateRows: "auto 1fr", height: "100%", minHeight: 0 } }, banner, scroller);
  ctx.el.append(wrap);
  ctx.fillBody(true);

  const visRows = () => Math.max(1, Math.floor((scroller.clientHeight - 12) / LH));
  const firstRow = () => {
    const max = Math.max(1, spacerH - scroller.clientHeight);
    const frac = Math.min(1, scroller.scrollTop / max);
    return Math.round(frac * Math.max(0, rows - visRows()));
  };
  function setFirstRow(r) {
    const max = Math.max(1, spacerH - scroller.clientHeight);
    const span = Math.max(1, rows - visRows());
    scroller.scrollTop = (r / span) * max;
  }

  async function block(i) {
    if (cache.has(i)) return cache.get(i);
    const start = i * BLOCK;
    const p = readRange(ctx.path, start, Math.min(size, start + BLOCK) - 1);
    cache.set(i, p);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return p;
  }

  async function bytesAt(start, len) {
    const out = new Uint8Array(Math.max(0, Math.min(len, size - start)));
    let pos = 0;
    while (pos < out.length) {
      const off = start + pos;
      const b = await block(Math.floor(off / BLOCK));
      const inner = off % BLOCK;
      const n = Math.min(out.length - pos, b.length - inner);
      if (n <= 0) break;
      out.set(b.subarray(inner, inner + n), pos);
      pos += n;
    }
    return out;
  }

  const hex2 = v => v.toString(16).toUpperCase().padStart(2, "0");
  const ch = v => (v >= 32 && v < 127) || v >= 160 ? String.fromCharCode(v) : "·";
  let drawing = 0;
  async function draw() {
    const my = ++drawing;
    const fr = firstRow(), n = visRows() + 1;
    const start = fr * ROW;
    const data = await bytesAt(start, n * ROW);
    if (my !== drawing) return;
    const offW = Math.max(8, size.toString(16).length);
    let html = "";
    for (let r = 0; r < n; r++) {
      const base = start + r * ROW;
      if (base >= size) break;
      let hx = "", as = "";
      for (let c = 0; c < ROW; c++) {
        const off = base + c;
        if (off >= size) { hx += "   "; continue; }
        const v = mods.has(off) ? mods.get(off) : data[r * ROW + c];
        const cls = "b" + (mods.has(off) ? " mod" : "") + (off === cursor ? " cur" : "");
        hx += `<span class="${cls}" data-o="${off}">${hex2(v)}</span>` + (c === 7 ? "  " : " ");
        as += `<span class="a${off === cursor ? " cur" : ""}" data-o="${off}" data-a="1">${ch(v).replace("&", "&amp;").replace("<", "&lt;")}</span>`;
      }
      html += `<div><span class="off">${base.toString(16).toUpperCase().padStart(offW, "0")}</span>  ${hx} ${as}</div>`;
    }
    content.innerHTML = html;
    content.style.top = scroller.scrollTop + "px";
    ctx.status(`Offset ${cursor} (0x${cursor.toString(16).toUpperCase()})` + (mods.size ? tr("v_hex.0_byte_modificati", mods.size) : ""));
  }

  function moveTo(off) {
    cursor = Math.max(0, Math.min(size - 1, off));
    nibble = 0;
    const r = Math.floor(cursor / ROW), fr = firstRow(), v = visRows();
    if (r < fr || r >= fr + v) setFirstRow(Math.max(0, r - Math.floor(v / 3)));
    draw();
  }

  scroller.addEventListener("scroll", () => requestAnimationFrame(draw));
  new ResizeObserver(() => draw()).observe(scroller);
  content.addEventListener("click", e => {
    const t = e.target.closest("[data-o]");
    if (!t) return;
    asciiMode = !!t.dataset.a;
    moveTo(+t.dataset.o);
    scroller.focus();
  });
  scroller.addEventListener("keydown", async e => {
    const k = e.key;
    const v = visRows();
    const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: ROW, ArrowUp: -ROW, PageDown: ROW * v, PageUp: -ROW * v };
    if (moves[k] !== undefined) { e.preventDefault(); return moveTo(cursor + moves[k]); }
    if (k === "Home" && e.ctrlKey) { e.preventDefault(); return moveTo(0); }
    if (k === "End" && e.ctrlKey) { e.preventDefault(); return moveTo(size - 1); }
    if (e.ctrlKey || e.altKey || k.length !== 1) return;
    e.preventDefault();
    const cur = mods.has(cursor) ? mods.get(cursor) : (await bytesAt(cursor, 1))[0];
    if (asciiMode) {
      const code = k.charCodeAt(0);
      if (code > 255) return;
      mods.set(cursor, code);
      ctx.setDirty(true);
      return moveTo(cursor + 1);
    }
    if (!/^[0-9a-f]$/i.test(k)) return;
    const d = parseInt(k, 16);
    const nv = nibble === 0 ? (d << 4) | (cur & 0x0f) : (cur & 0xf0) | d;
    mods.set(cursor, nv);
    ctx.setDirty(true);
    if (nibble === 0) { nibble = 1; draw(); } else { moveTo(cursor + 1); }
  });

  async function search(q) {
    q = q.trim();
    if (!q) return;
    let needle;
    if (/^([0-9a-f]{2}\s*)+$/i.test(q) && q.replace(/\s/g, "").length % 2 === 0 && /\s|^[0-9a-f]+$/i.test(q) && q.length > 1) {
      needle = new Uint8Array(q.replace(/\s/g, "").match(/../g).map(h => parseInt(h, 16)));
    } else {
      needle = new TextEncoder().encode(q);
    }
    const CH = 1 << 20;
    ctx.status(tr("v_hex.ricerca_corso"));
    for (let pos = cursor + 1; pos < size; pos += CH - needle.length) {
      const buf = await readRange(ctx.path, pos, Math.min(size, pos + CH) - 1);
      outer: for (let i = 0; i <= buf.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (buf[i + j] !== needle[j]) continue outer;
        return moveTo(pos + i);
      }
      if (buf.length < CH) break;
    }
    toast(tr("v_hex.nessun_altra_occorrenza_trovata"));
    draw();
  }

  async function showStrings() {
    const r = await api("strings", { path: ctx.path });
    const pre = el("pre", { style: { maxHeight: "60vh", overflow: "auto", fontFamily: "var(--mono)", fontSize: "12px", margin: 0, whiteSpace: "pre-wrap" } }, r.strings.join("\n") || tr("v_hex.nessun_testo_leggibile"));
    await modal(tr("v_hex.testo_leggibile_0_stringhe", r.strings.length), pre);
  }

  draw();
  scroller.focus();
  return {
    async save(target) {
      if (target !== ctx.path) {
        // salva con nome: copia completa con le modifiche
        const all = await readRange(ctx.path, 0, size - 1);
        for (const [o, v] of mods) all[o] = v;
        await api("save", { path: target }, { body: all });
        return { switchTo: true };
      }
      const patches = [...mods.entries()].sort((a, b) => a[0] - b[0]).map(([o, v]) => ({ offset: o, hex: hex2(v) }));
      await api("patch", { path: ctx.path }, { json: { patches } });
      for (const [o] of mods) cache.delete(Math.floor(o / BLOCK));
      mods.clear();
      draw();
    },
    onShow() { draw(); },
  };
}
