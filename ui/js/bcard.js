// Biglietti da visita (app per telefono): lettura del fronte e del retro gia' raddrizzati dallo scanner (scanner.js),
// scheda di revisione modificabile e passaggio del contatto al telefono con una vCard 3.0.
// Tutto nel dispositivo: OCR con Tesseract.js (ita + eng), QR con jsQR (Apache 2.0), nessun dato inviato al server.
// Una web app non puo' scrivere nei contatti: il file .vcf si apre o si condivide e la conferma la da' l'utente
// nella schermata "Nuovo contatto" del telefono.
import { el, loadScript, toast } from "./core.js";
import { t } from "./i18n.js";
import * as P from "./bcardparse.js";
import { applyFilter, blobToCanvas, canvasOf, getOcr, rotated, scaled } from "./scanner.js";

const V = p => (window.MBV_ROOT || "/") + "vendor/" + p;
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

// ---------------------------------------------------------------- QR
let qrLib = null;
const loadQr = () => (qrLib ||= loadScript(V("jsqr/jsQR.js")).then(() => window.jsQR).catch(e => { qrLib = null; throw e; }));
function qrIn(jsQR, canvas) {
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const d = g.getImageData(0, 0, canvas.width, canvas.height);
  const r = jsQR(d.data, canvas.width, canvas.height, { inversionAttempts: "attemptBoth" });
  if (!r?.data) return null;
  const L = r.location, n = p => [p.x / canvas.width, p.y / canvas.height];
  return { data: r.data, box: [L.topLeftCorner, L.topRightCorner, L.bottomRightCorner, L.bottomLeftCorner].map(n) };
}
// QR del biglietto: sul biglietto raddrizzato e, se non si trova, sulla foto intera a due grandezze.
// box = angoli del QR in frazioni del biglietto raddrizzato (solo se trovato li'): la zona si copre prima dell'OCR
export async function readQr(side) {
  let jsQR;
  try { jsQR = await loadQr(); } catch { return null; }
  const tries = [async () => scaled(await blobToCanvas(side.out), 1600)[0], async () => scaled(await blobToCanvas(side.src), 1600)[0], async () => scaled(await blobToCanvas(side.src), 900)[0]];
  for (let i = 0; i < tries.length; i++) {
    try { const r = qrIn(jsQR, await tries[i]()); if (r) return { data: r.data, box: i === 0 ? r.box : null }; } catch { /* */ }
  }
  return null;
}

// ---------------------------------------------------------------- OCR
// copia per l'OCR: grigi con lo sfondo uniformato; biglietti scuri (testo chiaro) invertiti prima
function ocrCanvas(cv, src, qrBox) {
  const k = Math.max(1, 1600 / Math.max(src.width, src.height));
  const c = canvasOf(Math.round(src.width * k), Math.round(src.height * k));
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(src, 0, 0, c.width, c.height);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  let sum = 0, n = 0;
  for (let i = 0; i < px.length; i += 4 * 37) { sum += px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11; n++; }
  if (sum / n < 115) { // copia invertita (disegnare un canvas su se stesso con un filtro non e' affidabile)
    const copy = canvasOf(c.width, c.height);
    copy.getContext("2d").drawImage(c, 0, 0);
    g.filter = "invert(1)"; g.drawImage(copy, 0, 0); g.filter = "none";
  }
  if (!cv) return c;
  const m = cv.imread(c), f = applyFilter(cv, m, "gray");
  cv.imshow(c, f);
  m.delete(); f.delete();
  if (qrBox) { // QR coperto di bianco (con un margine): i moduli letti come lettere sporcherebbero le righe vicine
    const cx = qrBox.reduce((a, p) => a + p[0], 0) / 4, cy = qrBox.reduce((a, p) => a + p[1], 0) / 4;
    const g2 = c.getContext("2d");
    g2.fillStyle = "#fff"; g2.beginPath();
    qrBox.forEach(([x, y], i) => { const X = (cx + (x - cx) * 1.25) * c.width, Y = (cy + (y - cy) * 1.25) * c.height; i ? g2.lineTo(X, Y) : g2.moveTo(X, Y); });
    g2.fill();
  }
  return c;
}
function ocrLines(data) {
  const out = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const text = (l.text || "").trim();
    if (text && l.confidence > 25) out.push({ text, h: l.bbox.y1 - l.bbox.y0, conf: l.confidence });
  }
  return out;
}
// testo di un lato: l'orientamento si prova finche' la lettura non e' convincente (biglietti in verticale o capovolti)
export async function readSide(cv, side, onProgress, qrBox = null) {
  const base = ocrCanvas(cv, await blobToCanvas(side.out), qrBox);
  const worker = await getOcr("ita+eng", m => { if (m.status === "recognizing text") onProgress?.(m.progress); });
  const rots = base.height > base.width ? [90, 270, 0] : [0, 180];
  let best = null;
  for (const rot of rots) {
    const r = await worker.recognize(rot ? rotated(base, rot) : base, {}, { blocks: true, text: true });
    const cand = { rot, conf: r.data.confidence || 0, lines: ocrLines(r.data), text: r.data.text || "" };
    if (!best || cand.conf > best.conf) best = cand;
    if (cand.conf >= 62) break;
  }
  return best;
}

// fronte e retro -> contatto (il QR con un contatto vince)
export async function readCard(cv, sides, progress) {
  const res = { sides: [], qr: null };
  for (let i = 0; i < sides.length; i++) {
    progress((i / sides.length), t("bcard.lettura_lato", i ? t("bcard.retro") : t("bcard.fronte")));
    const q = await readQr(sides[i]);
    const parsed = q ? P.parseQr(q.data) : null;
    if (parsed && !res.qr) res.qr = parsed;
    const s = await readSide(cv, sides[i], p => progress((i + p) / sides.length), q?.box);
    res.sides.push(s);
  }
  const parts = res.sides.map(s => P.parseText(s.lines));
  res.contact = P.merge(res.qr?.c, ...parts);
  return res;
}

// ---------------------------------------------------------------- rubrica della Posta del telefono (mmailcore: IndexedDB "mbv-posta")
async function mailBook() {
  try { const M = await import("./mmailcore.js"); return (await M.accounts()).length ? M : null; } catch { return null; }
}
async function addToMailBook(M, c) {
  const name = P.displayName(c);
  const addrs = c.emails.filter(Boolean).map(e => (name && name !== e ? `${name} <${e}>` : e));
  const known = (await M.kvGet("indirizzi").catch(() => null)) || [];
  // stessi indirizzi del campo "A" della posta (suggerimenti), il contatto nuovo in testa
  const lc = new Set(c.emails.map(e => e.toLowerCase()));
  await M.kvSet("indirizzi", [...addrs, ...known.filter(x => !lc.has((x.match(/<([^>]+)>/)?.[1] || x).toLowerCase()))].slice(0, 300));
  const book = (await M.kvGet("rubrica").catch(() => null)) || [];
  const entry = { name, org: c.org, title: c.title, emails: c.emails, phones: c.phones, data: Date.now() };
  await M.kvSet("rubrica", [entry, ...book.filter(x => !x.emails?.some(e => lc.has(e.toLowerCase())))].slice(0, 2000));
}

// ---------------------------------------------------------------- interfaccia
const ICON = {
  x: "M6 6l12 12M18 6L6 18", plus: "M12 5v14M5 12h14", contact: "M4 4h16v16H4zM12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M7 17c1-3 9-3 10 0",
  share: "M4 12v8h16v-8M12 3v13M7 8l5-5 5 5", again: "M4 12a8 8 0 1 0 3-6.2M4 4v5h5", qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2",
  open: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
};
const svg = d => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.innerHTML = `<path d="${d}"/>`; return s; };
const PHONE_TYPES = ["cell", "work", "fax", "home"];
const SOCIAL_TYPES = ["linkedin", "instagram", "facebook", "twitter", "youtube", "tiktok", "github", "skype", "telegram"];
const safeName = s => (s || "contatto").replace(/[\\/:*?"<>|]+/g, "-").trim().slice(0, 80) || "contatto";

export async function openCardReview({ sides, cv, show, busy, again, close }) {
  const b = busy(t("bcard.lettura"));
  let res;
  try { res = await readCard(cv, sides, (p, txt) => b.set(p, txt)); }
  catch (e) { b.done(); toast(t("bcard.lettura_non_riuscita") + " " + e.message, true, 8000); return again(); }
  b.done();
  const c = res.contact;
  // foto del contatto: il fronte ridotto (la vCard resta leggera)
  const front = await blobToCanvas(sides[0].out, 480);
  const photo = front.toDataURL("image/jpeg", 0.78).split(",")[1];
  const thumbs = await Promise.all(sides.map(async s => scaled(await blobToCanvas(s.out, 900), 900)[0].toDataURL("image/jpeg", 0.8)));
  const M = await mailBook();
  let focused = null, dirty = false;

  // ----------------------------------------------- campi
  const inp = (value, set, attrs = {}) => {
    const i = el(attrs.multiline ? "textarea" : "input", { type: attrs.multiline ? null : attrs.type || "text", value: attrs.multiline ? null : value || "", placeholder: attrs.ph || "",
      autocapitalize: attrs.cap || "words", autocomplete: "off", spellcheck: "false", inputmode: attrs.mode || null, rows: attrs.multiline ? 3 : null });
    if (attrs.multiline) i.value = value || "";
    i.addEventListener("input", () => { set(i.value); dirty = true; });
    i.addEventListener("focus", () => { focused = i; });
    return i;
  };
  const field = (label, value, set, attrs) => el("label", { class: "bc-f" }, el("span", {}, label), inp(value, set, attrs));
  const select = (opts, value, set) => {
    const s = el("select", {}, ...opts.map(([v, l]) => el("option", { value: v, selected: v === value }, l)));
    s.addEventListener("change", () => { set(s.value); dirty = true; });
    return s;
  };
  const rmBtn = fn => { const x = el("button", { type: "button", class: "bc-rm", "aria-label": t("common.elimina"), title: t("common.elimina") }, svg(ICON.x)); x.addEventListener("click", fn); return x; };
  const addBtn = (label, fn) => { const a = el("button", { type: "button", class: "bc-add" }, svg(ICON.plus), el("span", {}, label)); a.addEventListener("click", fn); return a; };

  const listGroup = (title, arr, row, make, addLabel) => {
    const box = el("div", { class: "bc-list" });
    const draw = () => {
      box.innerHTML = "";
      arr.forEach((x, i) => box.append(el("div", { class: "bc-row" }, ...row(x, i), rmBtn(() => { arr.splice(i, 1); dirty = true; draw(); }))));
      box.append(addBtn(addLabel, () => { arr.push(make()); dirty = true; draw(); box.querySelectorAll("input")[arr.length - 1]?.focus(); }));
    };
    draw();
    return el("section", { class: "bc-group" }, el("h3", {}, title), box);
  };

  const phoneTypes = PHONE_TYPES.map(k => [k, t("bcard.tel_" + k)]);
  const socialTypes = SOCIAL_TYPES.map(k => [k, k[0].toUpperCase() + k.slice(1)]);
  const urlsObj = c.urls.map(u => ({ value: u }));
  const emailsObj = c.emails.map(e => ({ value: e }));
  const a = c.adr;

  const src = res.qr && (res.qr.kind === "vcard" || res.qr.kind === "mecard")
    ? el("p", { class: "bc-src ok" }, svg(ICON.qr), el("span", {}, t("bcard.dati_dal_qr")))
    : el("p", { class: "bc-src" }, el("span", {}, t("bcard.controlla_campi")));

  const extra = c.extra.length ? el("section", { class: "bc-group" }, el("h3", {}, t("bcard.altre_righe")), el("p", { class: "bc-hint" }, t("bcard.altre_righe_desc")),
    el("div", { class: "bc-chips" }, ...c.extra.map(x => {
      const ch = el("button", { type: "button", class: "bc-chip" }, x);
      ch.addEventListener("pointerdown", e => e.preventDefault()); // il campo attivo non perde il fuoco
      ch.addEventListener("click", () => {
        const target = focused?.isConnected ? focused : noteInp;
        target.value = target.value ? target.value + (target.tagName === "TEXTAREA" ? "\n" : " ") + x : x;
        target.dispatchEvent(new Event("input"));
        ch.remove();
      });
      return ch;
    }))) : null;
  const noteInp = inp(c.note, v => { c.note = v; }, { multiline: true, cap: "sentences" });

  const photoChk = el("input", { type: "checkbox", checked: true });
  const mailChk = el("input", { type: "checkbox", checked: c.emails.length > 0 });
  let enlarged = null;
  const photos = el("div", { class: "bc-photos" }, ...thumbs.map((u, i) => {
    const f = el("figure", {}, el("img", { src: u, alt: "" }), el("figcaption", {}, i ? t("bcard.retro") : t("bcard.fronte")));
    f.addEventListener("click", () => {
      enlarged?.remove();
      enlarged = el("div", { class: "bc-zoom" }, el("img", { src: u, alt: "" }));
      enlarged.addEventListener("click", () => { enlarged.remove(); enlarged = null; });
      node.append(enlarged);
    });
    return f;
  }));

  const saveBtn = el("button", { type: "button", class: "bc-btn primary" }, svg(ICON.contact), el("span", {}, t("bcard.salva_contatti")));
  const againBtn = el("button", { type: "button", class: "bc-btn" }, svg(ICON.again), el("span", {}, t("bcard.altro_breve")));
  const cancel = el("button", { type: "button", class: "bc-hbtn" }, t("common.annulla"));
  const node = el("div", { class: "bc-review" },
    el("header", { class: "bc-head" }, cancel, el("h2", {}, t("bcard.nuovo_contatto")), el("span", { class: "bc-hsp" })),
    el("div", { class: "bc-body" },
      photos, src,
      el("section", { class: "bc-group" }, el("h3", {}, t("bcard.persona")),
        el("div", { class: "bc-two" }, field(t("bcard.titolo"), c.prefix, v => { c.prefix = v; }, { ph: t("bcard.titolo_es") }), field(t("bcard.nome"), c.given, v => { c.given = v; })),
        field(t("bcard.cognome"), c.family, v => { c.family = v; }),
        field(t("bcard.azienda"), c.org, v => { c.org = v; }),
        field(t("bcard.ruolo"), c.title, v => { c.title = v; }, { cap: "sentences" })),
      listGroup(t("bcard.telefoni"), c.phones, x => [select(phoneTypes, x.type, v => { x.type = v; }), inp(x.value, v => { x.value = v; }, { type: "tel", mode: "tel" })],
        () => ({ type: "cell", value: "" }), t("bcard.aggiungi_telefono")),
      listGroup(t("bcard.email"), emailsObj, x => [inp(x.value, v => { x.value = v; }, { type: "email", mode: "email", cap: "off" })], () => ({ value: "" }), t("bcard.aggiungi_email")),
      listGroup(t("bcard.siti"), urlsObj, x => [inp(x.value, v => { x.value = v; }, { type: "url", mode: "url", cap: "off" })], () => ({ value: "" }), t("bcard.aggiungi_sito")),
      listGroup(t("bcard.social"), c.socials, x => [select(socialTypes.some(s => s[0] === x.type) ? socialTypes : [[x.type, x.type], ...socialTypes], x.type, v => { x.type = v; }),
        inp(x.value, v => { x.value = v; }, { cap: "off" })], () => ({ type: "linkedin", value: "" }), t("bcard.aggiungi_social")),
      el("section", { class: "bc-group" }, el("h3", {}, t("bcard.indirizzo")),
        field(t("bcard.via"), a.street, v => { a.street = v; }),
        el("div", { class: "bc-two" }, field(t("bcard.cap"), a.cap, v => { a.cap = v; }, { mode: "numeric", cap: "off" }), field(t("bcard.citta"), a.city, v => { a.city = v; })),
        el("div", { class: "bc-two" }, field(t("bcard.provincia"), a.prov, v => { a.prov = v; }, { cap: "characters" }), field(t("bcard.paese"), a.country, v => { a.country = v; }))),
      el("section", { class: "bc-group" }, el("h3", {}, t("bcard.dati_fiscali")),
        el("div", { class: "bc-two half" }, field(t("bcard.piva"), c.piva, v => { c.piva = v; }, { cap: "characters" }), field(t("bcard.cf"), c.cf, v => { c.cf = v; }, { cap: "characters" }))),
      extra,
      el("section", { class: "bc-group" }, el("h3", {}, t("bcard.note")), noteInp),
      el("section", { class: "bc-group bc-opts" },
        el("label", { class: "bc-chk" }, photoChk, el("span", {}, t("bcard.includi_foto"))),
        M ? el("label", { class: "bc-chk" }, mailChk, el("span", {}, t("bcard.anche_rubrica_posta"))) : null),
      el("p", { class: "bc-hint" }, t("bcard.nota_conferma"))),
    el("footer", { class: "bc-foot" }, againBtn, saveBtn));

  const current = () => ({ ...c, emails: emailsObj.map(x => x.value.trim()).filter(Boolean), urls: urlsObj.map(x => x.value.trim()).filter(Boolean),
    phones: c.phones.filter(p => p.value.trim()), socials: c.socials.filter(s => s.value.trim()) });
  const leave = fn => () => { if (dirty && !confirm(t("bcard.scartare"))) return; fn(); };
  cancel.addEventListener("click", leave(close));
  againBtn.addEventListener("click", leave(again));

  // il file si prepara subito dopo il tocco (Web Share e apertura vogliono il gesto dell'utente)
  const makeFile = () => {
    const cc = current();
    const vcf = P.buildVcard(cc, { photo: photoChk.checked ? photo : null, labels: { piva: t("bcard.piva"), cf: t("bcard.cf") } });
    return { cc, file: new File([vcf], safeName(P.displayName(cc)) + ".vcf", { type: "text/vcard" }) };
  };
  const openFile = file => {
    const url = URL.createObjectURL(file);
    // iPhone/iPad: Safari mostra la scheda del contatto con "Crea nuovo contatto"; Android: il file scaricato si apre con Contatti
    const link = el("a", { href: url, target: IS_IOS ? "_blank" : null, download: IS_IOS ? null : file.name, rel: "noopener" });
    document.body.append(link); link.click();
    setTimeout(() => { URL.revokeObjectURL(url); link.remove(); }, 60000);
  };
  const shareFile = async file => {
    try { await navigator.share({ files: [file], title: file.name }); return true; }
    catch (e) { if (e.name !== "AbortError") toast(t("bcard.condivisione_non_riuscita") + " " + e.message, true); return false; }
  };
  const NATIVE = window.Capacitor?.Plugins?.MbDesk;
  const nativeContact = cc => NATIVE.insertContact({
    name: P.displayName(cc), org: cc.org || "", title: cc.title || "",
    phones: cc.phones.filter(p => p.value.trim()).map(p => ({ number: p.value.trim(), kind: p.type })),
    emails: cc.emails.filter(e => e.trim()), website: (cc.urls.find(u => u.trim()) || "").trim(),
    address: [cc.adr.street, [cc.adr.cap, cc.adr.city, cc.adr.prov && `(${cc.adr.prov})`].filter(Boolean).join(" "), cc.adr.country].filter(Boolean).join(", "),
    note: [cc.note, cc.piva && `${t("bcard.piva")} ${cc.piva}`, cc.cf && `${t("bcard.cf")} ${cc.cf}`].filter(Boolean).join("\n") });
  const canShare = f => { try { return !!navigator.canShare?.({ files: [f] }); } catch { return false; } };

  saveBtn.addEventListener("click", async () => {
    const { cc, file } = makeFile();
    if (!P.displayName(cc) && !cc.phones.length) { toast(t("bcard.contatto_vuoto"), true); return; }
    // app Android (APK): schermata "Nuovo contatto" di Android gia' compilata; web app su Android: condivisione
    // (si sceglie Contatti); iPhone o senza condivisione di file: apertura del file
    if (NATIVE) nativeContact(cc).catch(() => openFile(file));
    else if (!IS_IOS && canShare(file)) shareFile(file); else openFile(file);
    if (M && mailChk.checked && cc.emails.length) addToMailBook(M, cc).then(() => toast(t("bcard.aggiunto_rubrica_posta"))).catch(e => toast(e.message, true));
    dirty = false;
    doneSheet(file);
  });

  function doneSheet(file) {
    node.querySelector(".bc-sheetback")?.remove();
    const mk = (label, ic, fn, cls = "") => { const x = el("button", { type: "button", class: "bc-btn " + cls }, svg(ic), el("span", {}, label)); x.addEventListener("click", fn); return x; };
    const back = el("div", { class: "bc-sheetback" }, el("div", { class: "bc-sheet" },
      el("div", { class: "bc-grab" }),
      el("h3", {}, t("bcard.contatto_pronto")),
      el("p", {}, t("bcard.contatto_pronto_desc")),
      mk(t("bcard.apri_contatti"), ICON.open, () => (NATIVE ? nativeContact(current()).catch(() => openFile(file)) : openFile(file))),
      canShare(file) ? mk(t("bcard.condividi_vcf"), ICON.share, () => shareFile(file)) : null,
      window.MBLinkPhone?.online ? mk(t("link.invia_al_pc"), ICON.share, () => window.MBLinkPhone.sendBlob(file, { kind: "contact", name: file.name, contact: current() })) : null,
      mk(t("bcard.altro_biglietto"), ICON.again, () => again(), "primary"),
      mk(t("bcard.modifica_ancora"), ICON.contact, () => back.remove()),
      mk(t("common.chiudi"), ICON.x, () => close())));
    back.addEventListener("click", e => { if (e.target === back) back.remove(); });
    node.append(back);
  }

  show("card", node);
  if (!P.displayName(c) && !c.phones.length) toast(t("bcard.niente_letto"), true, 6000);
  // per le prove dalla console
  window.MB_BCARD = { res, contact: c, current, makeFile, node };
}

