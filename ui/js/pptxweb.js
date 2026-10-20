// PowerPoint nel browser (web app): lettura diapositive (testi, immagini, forme, tabelle) e modifica dei testi.
// Produce la stessa struttura del motore Python (mbvisual/office.py).
const EMU = 9525;
const kids = (n, name) => (n ? [...n.children].filter(c => c.localName === name) : []);
const kid = (n, name) => kids(n, name)[0] || null;
const deep = (n, name) => (n ? n.getElementsByTagNameNS("*", name)[0] || null : null);
const attr = (n, a) => (n ? n.getAttribute(a) : null);
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function resolve(base, target) {
  const parts = base.split("/").slice(0, -1);
  for (const p of target.split("/")) { if (p === "..") parts.pop(); else if (p !== ".") parts.push(p); }
  return parts.join("/");
}

async function xml(zip, path) {
  const f = zip.file(path);
  return f ? new DOMParser().parseFromString(await f.async("string"), "application/xml") : null;
}

async function rels(zip, path) {
  const p = path.replace(/([^/]+)$/, "_rels/$1.rels");
  const d = await xml(zip, p);
  const out = {};
  for (const r of d ? [...d.getElementsByTagName("Relationship")] : []) out[r.getAttribute("Id")] = { target: resolve(path, r.getAttribute("Target")), type: r.getAttribute("Type") };
  return out;
}

function xfrmOf(spPr) {
  const x = kid(spPr, "xfrm");
  if (!x) return null;
  const off = kid(x, "off"), ext = kid(x, "ext");
  if (!off || !ext) return null;
  return { x: +attr(off, "x"), y: +attr(off, "y"), w: +attr(ext, "cx"), h: +attr(ext, "cy"), rot: (+attr(x, "rot") || 0) / 60000 };
}

function color(n) {
  const c = n && deep(n, "srgbClr");
  return c ? "#" + attr(c, "val") : null;
}

function paragraphs(txBody) {
  return kids(txBody, "p").map(p => {
    const pPr = kid(p, "pPr");
    let size = null, bold = false, italic = false, col = null, text = "";
    for (const r of [...p.children]) {
      if (r.localName === "r" || r.localName === "fld") {
        const rPr = kid(r, "rPr");
        if (rPr) {
          if (attr(rPr, "sz") && !size) size = +attr(rPr, "sz") / 100;
          bold = bold || attr(rPr, "b") === "1";
          italic = italic || attr(rPr, "i") === "1";
          col = col || color(kid(rPr, "solidFill"));
        }
        text += kid(r, "t")?.textContent || "";
      } else if (r.localName === "br") text += " ";
    }
    return { text, level: +attr(pPr, "lvl") || 0, size, bold, italic, color: col,
      align: { l: "left", ctr: "center", r: "right", just: "justify" }[attr(pPr, "algn")] || null };
  });
}

function phMap(doc) {
  const map = {};
  for (const sp of doc ? [...doc.getElementsByTagNameNS("*", "sp")] : []) {
    const ph = deep(kid(sp, "nvSpPr"), "ph");
    if (!ph) continue;
    const xf = xfrmOf(kid(sp, "spPr"));
    if (!xf) continue;
    const t = attr(ph, "type") || "body", i = attr(ph, "idx");
    if (i !== null) map["idx" + i] = xf;
    if (!map["type" + t]) map["type" + t] = xf;
  }
  return map;
}

const PH = { title: "title", ctrTitle: "ctrTitle", subTitle: "subTitle", body: "body", obj: "body" };

export async function readPptx(bytes) {
  const zip = await window.JSZip.loadAsync(bytes);
  const pres = await xml(zip, "ppt/presentation.xml");
  const sz = deep(pres, "sldSz");
  const prels = await rels(zip, "ppt/presentation.xml");
  const ids = [...pres.getElementsByTagNameNS("*", "sldId")].map(s => s.getAttributeNS(R_NS, "id") || s.getAttribute("r:id"));
  const slides = [];
  for (const [index, rid] of ids.entries()) {
    const path = prels[rid].target;
    const doc = await xml(zip, path);
    const srels = await rels(zip, path);
    const layoutRel = Object.values(srels).find(r => r.type.endsWith("/slideLayout"));
    const layout = layoutRel ? await xml(zip, layoutRel.target) : null;
    const lrels = layoutRel ? await rels(zip, layoutRel.target) : {};
    const masterRel = Object.values(lrels).find(r => r.type.endsWith("/slideMaster"));
    const master = masterRel ? await xml(zip, masterRel.target) : null;
    const lmap = phMap(layout), mmap = phMap(master);
    const shapes = [];
    const tree = deep(doc, "spTree");
    const walk = async (parent, tf) => {
      for (const n of [...parent.children]) {
        const nv = n.firstElementChild;
        const cNvPr = nv ? deep(nv, "cNvPr") : null;
        const base = { id: +attr(cNvPr, "id"), name: attr(cNvPr, "name") || "" };
        const place = xf => { const p = tf(xf); return { x: p.x / EMU, y: p.y / EMU, w: p.w / EMU, h: p.h / EMU, rot: xf.rot || 0 }; };
        if (n.localName === "grpSp") {
          const gx = kid(kid(n, "grpSpPr"), "xfrm");
          const off = kid(gx, "off"), ext = kid(gx, "ext"), choff = kid(gx, "chOff"), chext = kid(gx, "chExt");
          if (off && ext && choff && chext) {
            const sx = +attr(ext, "cx") / (+attr(chext, "cx") || 1), sy = +attr(ext, "cy") / (+attr(chext, "cy") || 1);
            const ox = +attr(off, "x"), oy = +attr(off, "y"), cx = +attr(choff, "x"), cy = +attr(choff, "y");
            await walk(n, xf => tf({ x: ox + (xf.x - cx) * sx, y: oy + (xf.y - cy) * sy, w: xf.w * sx, h: xf.h * sy, rot: xf.rot }));
          } else await walk(n, tf);
        } else if (n.localName === "sp") {
          const ph = deep(nv, "ph");
          let xf = xfrmOf(kid(n, "spPr"));
          if (!xf && ph) { const t = attr(ph, "type") || "body", i = attr(ph, "idx"); xf = lmap["idx" + i] || lmap["type" + t] || mmap["type" + t] || mmap["idx" + i]; }
          if (!xf) continue;
          const spPr = kid(n, "spPr"), tx = kid(n, "txBody");
          const ln = kid(spPr, "ln");
          shapes.push({ ...base, ...place(xf), kind: "shape", fill: color(kid(spPr, "solidFill")), line: ln ? color(kid(ln, "solidFill")) : null,
            ph: ph ? PH[attr(ph, "type") || "body"] || "other" : undefined,
            paragraphs: tx ? paragraphs(tx) : undefined, anchor: tx ? { t: "top", ctr: "middle", b: "bottom" }[attr(kid(tx, "bodyPr"), "anchor")] || null : null });
        } else if (n.localName === "pic") {
          const xf = xfrmOf(kid(n, "spPr"));
          const blip = deep(n, "blip");
          const rel = blip && srels[blip.getAttributeNS(R_NS, "embed") || blip.getAttribute("r:embed")];
          const f = rel && zip.file(rel.target);
          if (!xf || !f) continue;
          const ext = rel.target.split(".").pop().toLowerCase();
          const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp", webp: "image/webp" }[ext] || "image/png";
          shapes.push({ ...base, ...place(xf), kind: "image", src: `data:${mime};base64,` + (await f.async("base64")) });
        } else if (n.localName === "graphicFrame") {
          const tbl = deep(n, "tbl");
          const x = kid(n, "xfrm");
          if (!tbl || !x) continue;
          const off = kid(x, "off"), ext = kid(x, "ext");
          const xf = { x: +attr(off, "x"), y: +attr(off, "y"), w: +attr(ext, "cx"), h: +attr(ext, "cy") };
          shapes.push({ ...base, ...place(xf), kind: "table", rows: kids(tbl, "tr").map(tr => kids(tr, "tc").map(tc => paragraphs(kid(tc, "txBody")))) });
        }
      }
    };
    if (tree) await walk(tree, xf => xf);
    slides.push({ index, shapes, background: color(deep(deep(doc, "bg"), "solidFill")), notes: "" });
  }
  return { ok: true, width: +attr(sz, "cx") / EMU, height: +attr(sz, "cy") / EMU, slides };
}

function setText(txBody, texts) {
  const ps = kids(txBody, "p");
  texts.forEach((t, i) => {
    let p = ps[i];
    if (!p) { p = ps[ps.length - 1].cloneNode(true); txBody.appendChild(p); }
    const runs = [...p.children].filter(c => ["r", "fld", "br"].includes(c.localName));
    let first = runs.find(r => r.localName === "r");
    if (!first) {
      const ns = txBody.namespaceURI;
      first = txBody.ownerDocument.createElementNS(ns, "a:r");
      first.appendChild(txBody.ownerDocument.createElementNS(ns, "a:t"));
      const end = kid(p, "endParaRPr");
      p.insertBefore(first, end);
    }
    runs.filter(r => r !== first).forEach(r => r.remove());
    kid(first, "t").textContent = t;
  });
  ps.slice(texts.length).forEach(p => p.remove());
}

export async function savePptx(bytes, edits) {
  const zip = await window.JSZip.loadAsync(bytes);
  const pres = await xml(zip, "ppt/presentation.xml");
  const prels = await rels(zip, "ppt/presentation.xml");
  const ids = [...pres.getElementsByTagNameNS("*", "sldId")].map(s => s.getAttributeNS(R_NS, "id") || s.getAttribute("r:id"));
  const bySlide = new Map();
  for (const e of edits) { if (!bySlide.has(e.slide)) bySlide.set(e.slide, []); bySlide.get(e.slide).push(e); }
  for (const [si, list] of bySlide) {
    const path = prels[ids[si]].target;
    const doc = await xml(zip, path);
    for (const e of list) {
      const cnv = [...doc.getElementsByTagNameNS("*", "cNvPr")].find(c => +c.getAttribute("id") === e.shape);
      if (!cnv) continue;
      const shape = cnv.parentNode.parentNode;
      if (e.cell) {
        const tr = kids(deep(shape, "tbl"), "tr")[e.cell[0]];
        const tc = kids(tr, "tc")[e.cell[1]];
        if (tc) setText(kid(tc, "txBody"), e.paragraphs);
      } else {
        const tx = kid(shape, "txBody");
        if (tx) setText(tx, e.paragraphs);
      }
    }
    zip.file(path, new XMLSerializer().serializeToString(doc));
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
