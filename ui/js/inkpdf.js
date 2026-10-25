// Tratti della penna (ui/js/ink.js) -> annotazioni Ink del PDF (ISO 32000: /Subtype /Ink con /InkList), con l'aspetto
// disegnato (/AP /N) che conserva lo spessore variabile della pressione e l'evidenziatore semitrasparente in "Moltiplica".
// Acrobat, Anteprima, Edge, pdf.js e PDF-XChange le mostrano e le lasciano spostare o cancellare come annotazioni a mano libera.
// Usa pdf-lib (solo nella web app: tools/build_web.py WEB_LIBS).
import { loadScript } from "./core.js";
import { t } from "./i18n.js";
import { hexRgb, strokeBox, widthAt } from "./ink.js";

const n = v => (Math.round(v * 1000) / 1000).toString();

/** bytes: PDF (gia' con le annotazioni di pdf.js); strokes: tratti con s = indice della pagina e coordinate PDF */
export async function addInkAnnots(bytes, strokes) {
  await loadScript("/vendor/pdf-lib/pdf-lib.min.js");
  const { PDFDocument, PDFHexString, PDFString } = window.PDFLib;
  // i byte di pdf.js arrivano dall'iframe (altro "realm"): per pdf-lib non sarebbero un Uint8Array -> copia
  const doc = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw new Error(t("ink.pdf_protetto"));
  const ctx = doc.context, pages = doc.getPages(), now = new Date();
  let k = 0;
  for (const st of strokes) {
    const page = pages[st.s];
    if (!page || !st.pts.length) continue;
    const box = strokeBox(st).map((v, i) => (i < 2 ? v - 1 : v + 1));
    const [r, g, b] = hexRgb(st.color).map(v => v / 255);
    const hl = st.tool === "hl";
    const ops = [`q /GS0 gs ${n(r)} ${n(g)} ${n(b)} RG ${n(r)} ${n(g)} ${n(b)} rg 1 J 1 j`];
    const P = st.pts;
    if (hl || !st.pressure || P.length === 1) {
      ops.push(`${n(hl ? st.w : widthAt(st, 0))} w ${n(P[0][0])} ${n(P[0][1])} m`);
      for (let i = 1; i < P.length; i++) ops.push(`${n(P[i][0])} ${n(P[i][1])} l`);
      if (P.length === 1) ops.push(`${n(P[0][0])} ${n(P[0][1])} l`);
      ops.push("S");
    } else {
      for (let i = 1; i < P.length; i++) ops.push(`${n((widthAt(st, i - 1) + widthAt(st, i)) / 2)} w ${n(P[i - 1][0])} ${n(P[i - 1][1])} m ${n(P[i][0])} ${n(P[i][1])} l S`);
    }
    ops.push("Q");
    const gs = { Type: "ExtGState", CA: st.o, ca: st.o };
    if (hl) gs.BM = "Multiply";
    const ap = ctx.register(ctx.stream(ops.join("\n"), { Type: "XObject", Subtype: "Form", BBox: box, Resources: { ExtGState: { GS0: gs } } }));
    const avg = P.reduce((a, _, i) => a + widthAt(st, i), 0) / P.length;
    const annot = ctx.obj({
      Type: "Annot", Subtype: "Ink", Rect: box, InkList: [P.flatMap(p => [p[0], p[1]])], C: [r, g, b], CA: st.o, F: 4,
      BS: { Type: "Border", W: hl ? st.w : avg, S: "S" }, AP: { N: ap }, P: page.ref,
      NM: PDFString.of(`mbv-ink-${now.getTime().toString(36)}-${k++}`), M: PDFString.fromDate(now),
      T: PDFHexString.fromText("MB Desk"), Subj: PDFHexString.fromText(hl ? t("ink.evidenziatore") : t("ink.penna")),
    });
    page.node.addAnnot(ctx.register(annot));
  }
  return await doc.save({ useObjectStreams: false });
}
