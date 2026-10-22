// Rapporto delle interferenze (Clash Detective): HTML con immagini, PDF (scrittore di ui/js/bcfreport.js), CSV, e
// esportazione come segnalazioni BCF (file .bcfzip o nel pannello Segnalazioni gia' aperto sul modello).
// sets = [{ test, clashes }]; le immagini si fanno inquadrando ogni interferenza con i due elementi evidenziati.
import { dirName, saveBlobAs, toast } from "./core.js";
import { t as tr, fmtDateTime, LOCALE } from "./i18n.js";
import { stLabel, typeLabel } from "./clashpanel.js";

const MAX_IMG = 400;
const BCF_STATUS = { new: "Open", active: "Open", reviewed: "In Progress", approved: "Closed", resolved: "Resolved" };
const COLOR = { a: "E0342B", b: "23A043" };

export async function makeReport(N, kind, sets, { images = true, setProgress, done } = {}) {
  const { h } = N;
  const total = sets.reduce((s, x) => s + x.clashes.length, 0);
  const needImg = (images && kind !== "csv") || kind === "bcfzip" || kind === "bcfpanel";
  const shots = new Map(); // clash -> { blob, vi }
  if (needImg) {
    const cam = N.camState();
    let k = 0;
    try {
      for (const { clashes } of sets) for (const c of clashes) {
        if (k >= MAX_IMG && kind !== "bcfzip" && kind !== "bcfpanel") break;
        setProgress?.(k / total, tr("clashrep.immagine_0_1", k + 1, total));
        N.focusClash(c, true);
        await new Promise(r => setTimeout(r, 0)); // non requestAnimationFrame: con la scheda nascosta resterebbe fermo
        const blob = images || kind.startsWith("bcf") ? await N.snapshot(kind === "pdf" ? 1100 : 900, kind.startsWith("bcf") ? "image/png" : "image/jpeg") : null;
        let vi = null;
        if (kind.startsWith("bcf")) {
          vi = N.br.capture();
          const ca = N.byKey(c.a.key), cb = N.byKey(c.b.key);
          const ra = ca ? N.br.compsFor([ca.obj]) : [], rb = cb ? N.br.compsFor([cb.obj]) : [];
          vi.selection = [...ra, ...rb];
          vi.coloring = [{ color: COLOR.a, comps: ra }, { color: COLOR.b, comps: rb }].filter(x => x.comps.length);
        }
        shots.set(c, { blob, vi });
        k++;
      }
    } finally { N.clearHighlight(); N.setCam(cam); }
  }
  setProgress?.(1, tr("clashrep.scrittura"));
  const stem = (sets.length === 1 ? sets[0].test.name : h.ctx.name.replace(/\.[^.]+$/, "")).replace(/[\\/:*?"<>|]+/g, "_");
  const dir = dirName(h.ctx.path || "");
  try {
    if (kind === "csv") await saveBlobAs(`${stem} - ${tr("clashrep.interferenze")}.csv`, csv(N, sets), dir);
    else if (kind === "html") await saveBlobAs(`${stem} - ${tr("clashrep.rapporto")}.html`, await html(N, sets, shots), dir);
    else if (kind === "pdf") await saveBlobAs(`${stem} - ${tr("clashrep.rapporto")}.pdf`, await pdf(N, sets, shots), dir);
    else await toBcf(N, kind, sets, shots, stem, dir);
  } finally { done?.(); }
}

// ---------------------------------------------------------------- testi comuni
const num = (v, d = 3) => (v == null || !isFinite(v) ? "" : Number(v).toLocaleString(LOCALE, { maximumFractionDigits: d }));
const distLabel = t => (t.type === "clearance" ? tr("clash.distanza") : t.type === "duplicate" ? tr("clash.scostamento") : tr("clash.compenetrazione"));
const fmtM = (N, m) => (m == null ? "" : N.unit === "m" ? num(m, 3) + " m" : num(m * 1000, 1) + " mm");
const tolText = (N, t) => (t.type === "clearance" ? tr("clash.distanza_0", fmtM(N, t.tolerance)) : tr("clash.tolleranza_0", fmtM(N, t.tolerance)));
const setText = (s) => s.mode === "all" ? tr("clash.modo_all") : s.mode === "selection" ? tr("clashrep.selezione_0", s.items.length) : `${tr("clash.modo_" + s.mode)}: ${s.values.join(", ")}`;
const blobToDataUrl = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function csv(N, sets) {
  const head = [tr("clashrep.test"), tr("clashrep.tipo"), "N.", tr("clashrep.gruppo"), tr("clashrep.stato"), tr("clashrep.distanza_m"), tr("clashrep.elemento_1"), tr("clashrep.classe_1"), tr("clashrep.livello_1"), tr("clashrep.modello_1"),
    tr("clashrep.elemento_2"), tr("clashrep.classe_2"), tr("clashrep.livello_2"), tr("clashrep.modello_2"), "X (m)", "Y (m)", "Z (m)", tr("clashrep.trovata"), tr("clashrep.risolta"), tr("clashrep.assegnato"), tr("clashrep.nota"), tr("clashrep.chiave_1"), tr("clashrep.chiave_2")];
  const rows = [head];
  for (const { test: t, clashes } of sets) for (const c of clashes) {
    rows.push([t.name, typeLabel(t.type), c.num, c.group || "", stLabel(c.status), num(c.dist, 6), c.a.name, c.a.cls, c.a.level, c.a.model, c.b.name, c.b.cls, c.b.level, c.b.model,
      ...(c.point || []).map(v => num(v, 4)), c.found ? fmtDateTime(c.found) : "", c.resolvedAt ? fmtDateTime(c.resolvedAt) : "", c.assigned || "", c.note || "", c.a.key, c.b.key]);
  }
  const text = "﻿" + rows.map(r => r.map(x => { const s = String(x ?? ""); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(";")).join("\r\n");
  return new Blob([text], { type: "text/csv" });
}

// ---------------------------------------------------------------- HTML (un file solo, immagini incluse, pronto da stampare)
async function html(N, sets, shots) {
  const { h } = N;
  const out = [];
  const now = new Date();
  out.push(`<!doctype html><html lang="${document.documentElement.lang || "it"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(tr("clashrep.rapporto_interferenze"))} - ${esc(h.ctx.name)}</title><style>
:root{--fg:#1b1e1c;--muted:#646863;--line:#d5d8d2;--accent:#2c6797;--new:#c62f28;--active:#d4730f;--reviewed:#2c6797;--approved:#2d7a46;--resolved:#8a8c89}
body{font:13px/1.4 "Segoe UI",Arial,sans-serif;color:var(--fg);margin:24px auto;max-width:1100px;padding:0 16px;background:#fff}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 6px;border-bottom:2px solid var(--accent);padding-bottom:4px}
.muted{color:var(--muted)}.sum{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.sum div{border:1px solid var(--line);border-left:4px solid var(--c);padding:6px 12px;min-width:90px}
.sum b{display:block;font-size:20px;color:var(--c)}table.info{border-collapse:collapse;margin:6px 0 12px}table.info td{padding:2px 12px 2px 0;vertical-align:top}
.clash{display:grid;grid-template-columns:minmax(0,420px) 1fr;gap:14px;border:1px solid var(--line);border-radius:6px;padding:10px;margin:10px 0;break-inside:avoid}
.clash img{width:100%;border:1px solid var(--line);border-radius:4px}.clash h3{margin:0 0 6px;font-size:15px}
.st{display:inline-block;color:#fff;border-radius:9px;padding:0 8px;font-size:11.5px;font-weight:600;background:var(--c)}
.el{display:flex;gap:6px;align-items:baseline;margin:3px 0}.sw{width:10px;height:10px;border-radius:2px;flex:none;display:inline-block}
dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:8px 0 0}dt{color:var(--muted)}dd{margin:0}
@media (max-width:720px){.clash{grid-template-columns:1fr}}@media print{body{margin:0}h2{break-before:page}h2:first-of-type{break-before:auto}}
</style></head><body>`);
  out.push(`<h1>${esc(tr("clashrep.rapporto_interferenze"))}</h1><div class="muted">${esc(h.partNames().join(" + "))} · ${esc(tr("clashrep.generato_0", fmtDateTime(now)))}</div>`);
  const ST = ["new", "active", "reviewed", "approved", "resolved"];
  for (const { test: t, clashes } of sets) {
    const cnt = s => clashes.filter(c => c.status === s).length;
    out.push(`<h2>${esc(t.name)}</h2><table class="info">
<tr><td class="muted">${esc(tr("clashrep.tipo"))}</td><td>${esc(typeLabel(t.type))} · ${esc(tolText(N, t))}</td></tr>
<tr><td class="muted">${esc(tr("clash.insieme_a"))}</td><td>${esc(setText(t.setA))}</td></tr>
<tr><td class="muted">${esc(tr("clash.insieme_b"))}</td><td>${esc(setText(t.setB))}</td></tr>
<tr><td class="muted">${esc(tr("clashrep.eseguito"))}</td><td>${t.lastRun ? esc(fmtDateTime(t.lastRun)) : "—"}${t.stats ? " · " + esc(tr("clashrep.statistiche_0_1", t.stats.candidates.toLocaleString(LOCALE), (t.stats.ms / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 1 }))) : ""}</td></tr></table>`);
    out.push(`<div class="sum"><div style="--c:var(--accent)"><b>${clashes.length}</b>${esc(tr("clashrep.totale"))}</div>${ST.map(s => cnt(s) ? `<div style="--c:var(--${s})"><b>${cnt(s)}</b>${esc(stLabel(s))}</div>` : "").join("")}</div>`);
    for (const c of clashes) {
      const sh = shots.get(c);
      const img = sh?.blob ? `<img src="${await blobToDataUrl(sh.blob)}" alt="">` : "";
      const p = c.point || [];
      out.push(`<div class="clash"><div>${img}</div><div><h3>${esc(tr("clash.interferenza_n", c.num))}${c.group ? ` <span class="muted">· ${esc(tr("clash.gruppo_n", c.group))}</span>` : ""} <span class="st" style="--c:var(--${c.status})">${esc(stLabel(c.status))}</span></h3>
<div class="el"><span class="sw" style="background:#${COLOR.a}"></span><div><b>${esc(c.a.name)}</b><div class="muted">${esc([c.a.cls, c.a.level, c.a.model].filter(Boolean).join(" · "))}</div></div></div>
<div class="el"><span class="sw" style="background:#${COLOR.b}"></span><div><b>${esc(c.b.name)}</b><div class="muted">${esc([c.b.cls, c.b.level, c.b.model].filter(Boolean).join(" · "))}</div></div></div>
<dl><dt>${esc(distLabel(t))}</dt><dd>${esc(fmtM(N, c.dist))}</dd><dt>${esc(tr("clash.punto"))}</dt><dd>${p.map(v => num(v, 3)).join(" ; ")} m</dd>
<dt>${esc(tr("clash.trovata"))}</dt><dd>${c.found ? esc(fmtDateTime(c.found)) : "—"}</dd>${c.assigned ? `<dt>${esc(tr("clashrep.assegnato"))}</dt><dd>${esc(c.assigned)}</dd>` : ""}${c.note ? `<dt>${esc(tr("clashrep.nota"))}</dt><dd>${esc(c.note)}</dd>` : ""}</dl></div></div>`);
    }
  }
  out.push(`<p class="muted">MB Visual · ${esc(tr("clashrep.colori_legenda"))}</p></body></html>`);
  return new Blob([out.join("\n")], { type: "text/html" });
}

// ---------------------------------------------------------------- PDF (A4, due interferenze per pagina)
async function pdf(N, sets, shots) {
  const { PdfDoc, toJpeg, wrap, ellipsis, textW } = await import("./bcfreport.js");
  const { h } = N;
  const d = new PdfDoc();
  const title = tr("clashrep.rapporto_interferenze");
  d.title = title;
  const { M, W } = d, CW = W - 2 * M;
  const TONE = { new: "#c62f28", active: "#d4730f", reviewed: "#2c6797", approved: "#2d7a46", resolved: "#8a8c89" };
  const ST = ["new", "active", "reviewed", "approved", "resolved"];
  d.addPage();
  d.rect(M, M, CW, 4, "#2c6797");
  d.text(M, M + 16, title, 20, { bold: true });
  let y = M + 44;
  d.text(M, y, ellipsis(h.partNames().join(" + "), 10, false, CW), 10, { color: "#646863" }); y += 15;
  d.text(M, y, tr("clashrep.generato_0", fmtDateTime(new Date())), 10, { color: "#646863" }); y += 26;
  for (const { test: t, clashes } of sets) {
    if (y > d.H - M - 140) { d.addPage(); y = M + 10; }
    d.text(M, y, t.name, 14, { bold: true }); y += 20;
    for (const line of [`${typeLabel(t.type)} · ${tolText(N, t)}`, `${tr("clash.insieme_a")}: ${setText(t.setA)}`, `${tr("clash.insieme_b")}: ${setText(t.setB)}`,
      `${tr("clashrep.eseguito")}: ${t.lastRun ? fmtDateTime(t.lastRun) : "—"}`]) {
      for (const l of wrap(line, 9.5, false, CW)) { d.text(M, y, l, 9.5, { color: "#1b1e1c" }); y += 13; }
    }
    y += 6;
    const boxes = [[tr("clashrep.totale"), clashes.length, "#2c6797"], ...ST.map(s => [stLabel(s), clashes.filter(c => c.status === s).length, TONE[s]])];
    const bw = (CW - 5 * 6) / 6;
    boxes.forEach(([lab, n, col], i) => {
      const x = M + i * (bw + 6);
      d.rect(x, y, bw, 40, "#f1f2f0");
      d.rect(x, y, 3, 40, col);
      d.text(x + 8, y + 6, String(n), 16, { bold: true, color: col });
      d.text(x + 8, y + 26, ellipsis(lab, 8, false, bw - 12), 8, { color: "#646863" });
    });
    y += 56;
  }
  // schede: immagine a sinistra, dati a destra
  for (const { test: t, clashes } of sets) {
    let slot = 2;
    for (const c of clashes) {
      if (slot >= 2) { d.addPage(); y = M + 10; slot = 0; d.text(M, y, ellipsis(t.name, 11, true, CW), 11, { bold: true, color: "#2c6797" }); y += 20; }
      const top = y, IW = 300, IH = 220;
      const sh = shots.get(c);
      if (sh?.blob) {
        try {
          const img = await toJpeg(sh.blob, 1100);
          let w = IW, hh = (img.h / img.w) * w;
          if (hh > IH) { hh = IH; w = (img.w / img.h) * hh; }
          d.rect(M - 0.5, top - 0.5, w + 1, hh + 1, "#c4c7c1");
          d.image(img, M, top, w, hh);
        } catch { /* immagine non disponibile */ }
      }
      const x = M + IW + 14, tw = CW - IW - 14;
      let yy = top;
      d.text(x, yy, tr("clash.interferenza_n", c.num) + (c.group ? "  ·  " + tr("clash.gruppo_n", c.group) : ""), 12, { bold: true }); yy += 17;
      d.rect(x, yy, textW(stLabel(c.status), 8.5, true) + 12, 13, TONE[c.status]);
      d.text(x + 6, yy + 2.5, stLabel(c.status), 8.5, { bold: true, color: "#ffffff" }); yy += 21;
      const elem = (col, label, e) => {
        d.rect(x, yy + 1, 8, 8, col);
        for (const l of wrap(`${label}: ${e.name}`, 9, true, tw - 14).slice(0, 2)) { d.text(x + 13, yy, l, 9, { bold: true }); yy += 12; }
        d.text(x + 13, yy, ellipsis([e.cls, e.level, e.model].filter(Boolean).join(" · "), 8, false, tw - 14), 8, { color: "#646863" }); yy += 15;
      };
      elem("#" + COLOR.a, tr("clash.elemento_1"), c.a);
      elem("#" + COLOR.b, tr("clash.elemento_2"), c.b);
      const kv = [[distLabel(t), fmtM(N, c.dist)], [tr("clash.punto"), (c.point || []).map(v => num(v, 3)).join(" ; ") + " m"], [tr("clash.trovata"), c.found ? fmtDateTime(c.found) : "—"],
        c.assigned ? [tr("clashrep.assegnato"), c.assigned] : null].filter(Boolean);
      for (const [k, v] of kv) { d.text(x, yy, k.toUpperCase(), 7, { bold: true, color: "#646863" }); d.text(x, yy + 9, ellipsis(v, 9.5, false, tw), 9.5); yy += 24; }
      if (c.note) for (const l of wrap(c.note, 9, false, tw).slice(0, 4)) { d.text(x, yy, l, 9, { color: "#1b1e1c" }); yy += 12; }
      y = Math.max(top + IH, yy) + 18;
      d.line(M, y - 9, W - M, y - 9);
      slot++;
    }
  }
  d.pages.forEach((p, i) => {
    d.page = p;
    d.line(M, d.H - 28, W - M, d.H - 28);
    d.text(M, d.H - 24, `MB Visual · ${title} · ${ellipsis(h.ctx.name, 7.5, false, 240)}`, 7.5, { color: "#8a8c89" });
    const pg = tr("bcfreport.pagina_0_1", i + 1, d.pages.length);
    d.text(W - M - textW(pg, 7.5), d.H - 24, pg, 7.5, { color: "#8a8c89" });
  });
  return d.build();
}

// ---------------------------------------------------------------- segnalazioni BCF (una per interferenza, tipo "Clash")
async function toBcf(N, kind, sets, shots, stem, dir) {
  const B = await import("./bcf.js");
  const { author } = await import("./bcfpanel.js");
  const who = await author();
  const files = N.br.modelFiles();
  const topics = [];
  for (const { test: t, clashes } of sets) for (const c of clashes) {
    const tp = B.newTopic(who);
    if (c.bcf) tp.guid = c.bcf; // gia' esportata: stessa segnalazione
    tp.type = "Clash";
    tp.status = BCF_STATUS[c.status] || "Open";
    tp.title = `${t.name} · ${tr("clash.interferenza_n", c.num)}: ${c.a.name} / ${c.b.name}`.slice(0, 250);
    tp.labels = [t.name, typeLabel(t.type)];
    if (c.assigned) tp.assignedTo = c.assigned;
    tp.description = [`${typeLabel(t.type)} · ${distLabel(t)} ${fmtM(N, c.dist)}`, `${tr("clash.elemento_1")}: ${c.a.name}${c.a.cls ? " (" + c.a.cls + ")" : ""}${c.a.model ? " · " + c.a.model : ""}`,
      `${tr("clash.elemento_2")}: ${c.b.name}${c.b.cls ? " (" + c.b.cls + ")" : ""}${c.b.model ? " · " + c.b.model : ""}`, `${tr("clash.punto")}: ${(c.point || []).map(v => num(v, 3)).join(" ; ")} m`,
      c.note ? "\n" + c.note : ""].filter(Boolean).join("\n");
    tp.files = files;
    const sh = shots.get(c);
    if (sh) tp.viewpoints.push({ guid: B.uuid(), vi: sh.vi, snapshot: sh.blob });
    c.bcf = tp.guid; // collegamento: la stessa interferenza esportata di nuovo aggiorna la segnalazione
    topics.push(tp);
  }
  N.changed();
  if (kind === "bcfzip") {
    const st = B.newStore();
    st.project.name = N.h.partNames().join(" + ");
    st.topics = topics;
    const blob = await B.writeBcf(st, "2.1");
    await saveBlobAs(`${stem} - ${tr("clashrep.interferenze")}.bcfzip`, blob, dir);
    return;
  }
  // pannello Segnalazioni del modello: aggiunte (o aggiornate se esportate prima) e non ancora salvate
  const ui = await N.h.bcf();
  const store = ui.panel.store;
  let added = 0, updated = 0;
  for (const tp of topics) {
    const i = store.topics.findIndex(x => x.guid === tp.guid);
    if (i >= 0) { tp.comments = store.topics[i].comments; store.topics[i] = tp; updated++; }
    else { store.topics.push(tp); added++; }
  }
  ui.panel.setStore(store, ui.panel.path, true);
  ui.toggle(true);
  toast(updated ? tr("clashrep.bcf_aggiunte_aggiornate", added, updated) : tr("clashrep.bcf_aggiunte", added));
}
