// Pubblicazioni: modelli di partenza (scelti dentro l'editor, come la schermata "Modelli" di Publisher).
// Tutti i colori fanno riferimento alla combinazione (sN) e i caratteri alla combinazione di caratteri (+t/+b):
// cambiando combinazione cambia tutta la pubblicazione.
import { MM, newDoc, newPage, textBox, imageBox, shapeBox, wordArt, tableBox } from "./pubmodel.js";

const m = v => v * MM;
const LOREM = [
  "Per sostituire questo testo con il vostro, fate clic qui e iniziate a scrivere. Il testo si adatta alla casella e, se non ci sta, continua nella casella collegata successiva.",
  "Raccontate in poche righe chi siete, cosa fate e perche' i lettori dovrebbero scegliervi. Frasi brevi e concrete si leggono meglio su carta.",
  "Potete cambiare carattere, dimensione e colore dalla scheda Home; gli stili (Titolo 1, Corpo del testo...) mantengono uniforme tutta la pubblicazione.",
  "Le combinazioni di colori e di caratteri si scelgono dalla scheda Progettazione pagina: tutta la pubblicazione cambia aspetto con un clic.",
];
const body = (n, style = "Corpo del testo") => Array.from({ length: n }, (_, k) => [LOREM[k % LOREM.length], style]);

function volantino() {
  const d = newDoc(210, 297);
  const p = d.pages[0].items;
  d.margins = { l: m(15), t: m(15), r: m(15), b: m(15) };
  p.push(shapeBox(d, "rect", 0, 0, d.w, m(92), "s1", null, { wrap: "none" }));
  p.push(shapeBox(d, "rect", 0, m(92), d.w, m(4), "s3", null, { wrap: "none" }));
  p.push(textBox(d, m(15), m(18), m(180), m(42), [["TITOLO DELL'EVENTO", "Titolo", { c: "s5", z: 44 }]], { valign: "b", fit: "shrink" }));
  p.push(textBox(d, m(15), m(62), m(180), m(22), [["Uno slogan breve che invoglia a partecipare", "Sottotitolo", { c: "s5:70" }]]));
  p.push(imageBox(d, m(15), m(106), m(180), m(88)));
  p.push(textBox(d, m(15), m(202), m(112), m(70), [["Di cosa si tratta", "Titolo 2"], ...body(2)]));
  p.push(shapeBox(d, "round", m(134), m(202), m(61), m(70), "s1:15", null, { wrap: "none", r: 10 }));
  p.push(textBox(d, m(138), m(206), m(53), m(62), [["Quando", "Titolo 3"], ["Sabato 14 novembre, ore 18:00", "Normale"], ["Dove", "Titolo 3"], ["Via Esempio 1, Citta'", "Normale"], ["Ingresso", "Titolo 3"], ["Libero fino ad esaurimento posti", "Normale"]]));
  p.push(shapeBox(d, "rect", 0, d.h - m(16), d.w, m(16), "s0", null, { wrap: "none" }));
  p.push(textBox(d, m(15), d.h - m(14), m(180), m(12), [["info@azienda.it  ·  www.azienda.it  ·  +39 000 000 0000", "Normale", { c: "s5", a: "c", z: 10 }]], { valign: "m" }));
  return d;
}

function volantinoVendita() {
  const d = newDoc(210, 297);
  d.scheme = { name: "Mandarino", c: ["#2e1f14", "#ef7f1a", "#f6b26b", "#3d85c6", "#a3a3a3", "#fff4e8"] };
  const p = d.pages[0].items;
  p.push(imageBox(d, 0, 0, d.w, m(150)));
  p.push(shapeBox(d, "burst", m(140), m(118), m(58), m(58), "s1", { c: "s5", w: 2 }, { wrap: "none" }));
  p.push(textBox(d, m(146), m(133), m(46), m(28), [["-30%", "Titolo", { c: "s5", a: "c", z: 34 }], ["su tutto", "Normale", { c: "s5", a: "c", b: true }]], { valign: "m" }));
  p.push(wordArt(d, "GRANDI SALDI", m(15), m(160), m(180), m(34), { fill: "s1", outline: "s0", ow: 0, form: "piatto" }));
  p.push(textBox(d, m(15), m(198), m(180), m(14), [["Solo da venerdi' a domenica, in tutti i nostri negozi", "Sottotitolo", { a: "c" }]]));
  p.push(textBox(d, m(15), m(216), m(180), m(50), [["Approfittate delle offerte", "Titolo 2", { a: "c" }], [LOREM[1], "Corpo del testo", { a: "c" }]]));
  p.push(shapeBox(d, "rect", 0, d.h - m(22), d.w, m(22), "s1", null, { wrap: "none" }));
  p.push(textBox(d, m(15), d.h - m(20), m(180), m(18), [["Negozio Esempio · Via Roma 10 · Aperto tutti i giorni 9-20", "Normale", { c: "s5", a: "c", z: 12, b: true }]], { valign: "m" }));
  return d;
}

function brochure() {
  const d = newDoc(297, 210);
  d.margins = { l: m(10), t: m(10), r: m(10), b: m(10) };
  d.grid = { cols: 3, rows: 1, gap: m(20) };
  d.pages.push(newPage(d));
  const P1 = d.pages[0].items, P2 = d.pages[1].items;
  const W = m(99), pad = m(10);
  // esterno: aletta interna | retro | copertina
  P1.push(textBox(d, pad, pad, W - 2 * pad, m(190), [["Chi siamo", "Titolo 1"], ...body(3)]));
  P1.push(shapeBox(d, "rect", W, 0, W, d.h, "s1:12", null, { wrap: "none" }));
  P1.push(textBox(d, W + pad, m(20), W - 2 * pad, m(40), [["Contatti", "Titolo 2", { a: "c" }], ["Azienda Esempio S.r.l.", "Indirizzo", { a: "c", b: true }], ["Via Esempio 1 · 00000 Citta'", "Indirizzo", { a: "c" }], ["Tel. +39 000 000 0000", "Indirizzo", { a: "c" }], ["info@azienda.it", "Indirizzo", { a: "c" }]]));
  P1.push(imageBox(d, W + pad, m(70), W - 2 * pad, m(60)));
  P1.push(textBox(d, W + pad, m(135), W - 2 * pad, m(20), [["Inserite qui una mappa o il logo", "Didascalia", { a: "c" }]]));
  P1.push(shapeBox(d, "rect", 2 * W, 0, W, d.h, "s1", null, { wrap: "none" }));
  P1.push(imageBox(d, 2 * W + pad, m(25), W - 2 * pad, m(85)));
  P1.push(textBox(d, 2 * W + pad, m(118), W - 2 * pad, m(40), [["Nome dell'azienda", "Titolo", { c: "s5", a: "c", z: 28 }]], { fit: "shrink", valign: "m" }));
  P1.push(textBox(d, 2 * W + pad, m(160), W - 2 * pad, m(20), [["Il vostro slogan", "Sottotitolo", { c: "s5:70", a: "c" }]]));
  // interno: testo collegato sulle tre ante
  const t1 = textBox(d, pad, pad + m(14), W - 2 * pad, m(176), [["Titolo dell'articolo principale", "Titolo 1"], ...body(8)]);
  const t2 = textBox(d, W + pad, pad, W - 2 * pad, m(110), []);
  const t3 = textBox(d, 2 * W + pad, pad, W - 2 * pad, m(110), []);
  delete d.stories[t2.story]; delete d.stories[t3.story];
  t2.story = t1.story; t3.story = t1.story; t1.next = t2.id; t2.next = t3.id;
  P2.push(textBox(d, pad, pad, W - 2 * pad, m(12), [["Benvenuti", "Testo in evidenza", { a: "l", c: "s1" }]]));
  P2.push(t1, t2, t3);
  P2.push(imageBox(d, W + pad, m(125), W - 2 * pad, m(65)));
  P2.push(shapeBox(d, "rect", 2 * W + pad, m(125), W - 2 * pad, m(65), "s1", null, { wrap: "none" }));
  P2.push(textBox(d, 2 * W + pad + m(4), m(129), W - 2 * pad - m(8), m(57), [["“Una frase importante, una citazione o un dato che colpisce il lettore.”", "Citazione", { c: "s5" }]], { valign: "m" }));
  return d;
}

function biglietto() {
  const d = newDoc(85, 55);
  d.margins = { l: m(4), t: m(4), r: m(4), b: m(4) };
  const p = d.pages[0].items;
  p.push(shapeBox(d, "rect", 0, 0, m(6), d.h, "s1", null, { wrap: "none" }));
  p.push(imageBox(d, m(61), m(5), m(19), m(19)));
  p.push(textBox(d, m(10), m(6), m(50), m(16), [["Nome Cognome", "Titolo 2", { z: 13, sb: 0 }], ["Ruolo in azienda", "Didascalia", { i: false, c: "s2" }]], { pad: [0, 0, 0, 0] }));
  p.push(shapeBox(d, "line", m(10), m(27), m(70), 0, "none", { c: "s1", w: 0.75 }, { wrap: "none" }));
  p.push(textBox(d, m(10), m(30), m(70), m(21), [["Azienda Esempio S.r.l.", "Indirizzo", { b: true, z: 7.5 }], ["Via Esempio 1 · 00000 Citta'", "Indirizzo", { z: 7.5 }], ["+39 000 000 0000 · nome@azienda.it", "Indirizzo", { z: 7.5 }], ["www.azienda.it", "Indirizzo", { z: 7.5, c: "s1" }]], { pad: [0, 0, 0, 0] }));
  return d;
}

function newsletter() {
  const d = newDoc(210, 297);
  d.margins = { l: m(15), t: m(15), r: m(15), b: m(18) };
  d.grid = { cols: 3, rows: 1, gap: m(5) };
  d.pages.push(newPage(d));
  const M = d.masters[0].items;
  M.push(shapeBox(d, "line", m(15), d.h - m(14), m(180), 0, "none", { c: "s1", w: 0.75 }, { wrap: "none" }));
  M.push(textBox(d, m(15), d.h - m(13), m(180), m(9), [["Newsletter  ·  Numero 1  ·  Pagina {pagina} di {pagine}", "Normale", { a: "r", z: 8, c: "s2" }]], { pad: [0, 2, 0, 0] }));
  const P1 = d.pages[0].items, P2 = d.pages[1].items;
  P1.push(shapeBox(d, "rect", 0, 0, d.w, m(48), "s1", null, { wrap: "none" }));
  P1.push(textBox(d, m(15), m(10), m(180), m(26), [["La nostra newsletter", "Titolo", { c: "s5", z: 40 }]], { fit: "shrink", valign: "b" }));
  P1.push(textBox(d, m(15), m(36), m(180), m(9), [["Notizie, progetti e appuntamenti  ·  Novembre 2026", "Normale", { c: "s5:70", z: 11 }]]));
  P1.push(shapeBox(d, "rect", m(15), m(56), m(52), m(110), "s1:15", null, { wrap: "none" }));
  P1.push(textBox(d, m(18), m(59), m(46), m(104), [["In questo numero", "Titolo 2"], ["Articolo principale", "Elenco puntato"], ["Il progetto del mese", "Elenco puntato"], ["Prossimi appuntamenti", "Elenco puntato"], ["Dalla nostra squadra", "Elenco puntato"], ["", "Normale"], ["Una breve nota per i lettori, i riferimenti dell'ufficio o un avviso importante.", "Didascalia", { i: false }]]));
  P1.push(textBox(d, m(73), m(56), m(122), m(20), [["Titolo dell'articolo principale", "Titolo 1", { sb: 0 }]]));
  P1.push(imageBox(d, m(73), m(78), m(122), m(62)));
  P1.push(textBox(d, m(73), m(141), m(122), m(8), [["Didascalia dell'immagine: descrivete in breve cosa mostra.", "Didascalia"]]));
  const a1 = textBox(d, m(73), m(152), m(122), m(124), [...body(10)], { cols: 2, gap: m(5) });
  P1.push(textBox(d, m(15), m(172), m(52), m(104), [["Prossimi appuntamenti", "Titolo 3"], ["12/11 · Incontro con i clienti", "Normale"], ["20/11 · Fiera di settore", "Normale"], ["03/12 · Presentazione del nuovo catalogo", "Normale"]]));
  P1.push(a1);
  const a2 = textBox(d, m(15), m(15), m(180), m(80), [], { cols: 3, gap: m(5) });
  delete d.stories[a2.story];
  a2.story = a1.story; a1.next = a2.id;
  P2.push(a2);
  P2.push(shapeBox(d, "line", m(15), m(100), m(180), 0, "none", { c: "s3", w: 2 }, { wrap: "none" }));
  P2.push(textBox(d, m(15), m(104), m(180), m(16), [["Il progetto del mese", "Titolo 1", { sb: 0 }]]));
  P2.push(imageBox(d, m(15), m(122), m(88), m(70)));
  P2.push(textBox(d, m(108), m(122), m(87), m(148), [...body(6)], { cols: 1 }));
  P2.push(shapeBox(d, "round", m(15), m(198), m(88), m(72), "s1", null, { wrap: "none", r: 8 }));
  P2.push(textBox(d, m(21), m(204), m(76), m(60), [["“Una citazione in evidenza attira lo sguardo e invoglia a leggere l'articolo.”", "Citazione", { c: "s5" }]], { valign: "m" }));
  return d;
}

function invito() {
  const d = newDoc(148, 210);
  d.scheme = { name: "Orchidea", c: ["#33142e", "#a2336f", "#d77fb0", "#5c8fc8", "#ead1e1", "#fbf2f7"] };
  d.fonts = { name: "Elegante", t: "Constantia", b: "Candara" };
  const p = d.pages[0].items;
  p.push(shapeBox(d, "rect", m(7), m(7), m(134), m(196), "none", { c: "s1", w: 2.5 }, { wrap: "none" }));
  p.push(shapeBox(d, "rect", m(10), m(10), m(128), m(190), "none", { c: "s2", w: 0.75 }, { wrap: "none" }));
  p.push(wordArt(d, "Sei invitato!", m(18), m(22), m(112), m(42), { form: "arco", fill: "s1", outline: "s0", ow: 0, shadow: false }));
  p.push(shapeBox(d, "star5", m(68), m(68), m(12), m(12), "s3", null, { wrap: "none" }));
  p.push(textBox(d, m(18), m(86), m(112), m(70), [["alla festa per i nostri 25 anni di attivita'", "Sottotitolo", { a: "c", c: "s0" }], ["", "Normale"], ["Venerdi' 4 dicembre 2026", "Titolo 2", { a: "c" }], ["dalle ore 19:30", "Normale", { a: "c", z: 12 }], ["Villa Esempio, Via dei Giardini 5", "Normale", { a: "c", z: 12 }]]));
  p.push(textBox(d, m(18), m(165), m(112), m(25), [["Si prega di confermare entro il 20 novembre", "Didascalia", { a: "c", z: 9 }], ["eventi@azienda.it · +39 000 000 0000", "Didascalia", { a: "c", z: 9, i: false }]]));
  return d;
}

function catalogo() {
  const d = newDoc(210, 297);
  d.margins = { l: m(15), t: m(15), r: m(15), b: m(18) };
  d.grid = { cols: 2, rows: 3, gap: m(8) };
  d.pages.push(newPage(d));
  const M = d.masters[0].items;
  M.push(shapeBox(d, "rect", 0, d.h - m(12), d.w, m(12), "s1", null, { wrap: "none" }));
  M.push(textBox(d, m(15), d.h - m(11), m(180), m(10), [["Catalogo 2026  ·  {pagina}", "Normale", { a: "r", c: "s5", z: 9, b: true }]], { valign: "m" }));
  const P1 = d.pages[0].items, P2 = d.pages[1].items;
  P1.push(textBox(d, m(15), m(12), m(180), m(22), [["Catalogo prodotti", "Titolo", { z: 32 }]], { valign: "b" }));
  P1.push(shapeBox(d, "rect", m(15), m(35), m(180), m(1.2), "s3", null, { wrap: "none" }));
  const card = (P, x, y, n) => {
    P.push(imageBox(d, x, y, m(86), m(52), { line: { c: "s1:40", w: 0.5 } }));
    P.push(textBox(d, x, y + m(54), m(60), m(22), [["Prodotto " + n, "Titolo 3", { sb: 0 }], ["Breve descrizione del prodotto, materiali e dimensioni.", "Didascalia", { i: false }]], { pad: [0, 2, 0, 0] }));
    P.push(textBox(d, x + m(60), y + m(54), m(26), m(10), [["€ 99,00", "Testo in evidenza", { c: "s1", a: "r", z: 12 }]], { pad: [0, 2, 0, 0] }));
  };
  let n = 1;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) card(P1, m(15) + c * m(94), m(42) + r * m(80), n++);
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) card(P2, m(15) + c * m(94), m(15) + r * m(80), n++);
  P2.push(textBox(d, m(15), m(178), m(180), m(12), [["Listino prezzi", "Titolo 2", { sb: 0 }]]));
  const t = tableBox(d, m(15), m(192), 5, 3, m(180), 20);
  const vals = [["Codice", "Descrizione", "Prezzo"], ["P-001", "Prodotto 1", "€ 99,00"], ["P-002", "Prodotto 2", "€ 129,00"], ["P-003", "Prodotto 3", "€ 79,00"], ["P-004", "Prodotto 4", "€ 149,00"]];
  vals.forEach((row, r) => row.forEach((v, c) => {
    const st = d.stories[t.cells[r][c].story];
    const s = st.chars[0].s;
    st.chars = [...Array.from(v).map(ch => ({ c: ch, s })), { ...st.chars[st.chars.length - 1] }];
  }));
  t.colW = [m(35), m(105), m(40)];
  P2.push(t);
  return d;
}

function cartolina() {
  const d = newDoc(148, 105);
  d.margins = { l: m(6), t: m(6), r: m(6), b: m(6) };
  const p = d.pages[0].items;
  p.push(imageBox(d, 0, 0, d.w, d.h));
  p.push(shapeBox(d, "rect", 0, m(62), d.w, m(43), "s5", null, { wrap: "none", opacity: 0.85 }));
  p.push(wordArt(d, "Buone Feste", m(12), m(62), m(124), m(26), { form: "onda", fill: "s1", ow: 0, shadow: false }));
  p.push(textBox(d, m(12), m(89), m(124), m(12), [["Auguri di serenita' e successo da tutti noi", "Normale", { a: "c", z: 11, c: "s0" }]]));
  return d;
}

function comunicato() {
  const d = newDoc(210, 297);
  d.margins = { l: m(20), t: m(18), r: m(20), b: m(20) };
  const p = d.pages[0].items;
  p.push(imageBox(d, m(20), m(16), m(40), m(20)));
  p.push(textBox(d, m(110), m(18), m(80), m(18), [["COMUNICATO STAMPA", "Titolo 2", { a: "r", sb: 0, c: "s1" }], ["Per diffusione immediata · {data}", "Didascalia", { a: "r", i: false }]]));
  p.push(shapeBox(d, "rect", m(20), m(40), m(170), m(1.5), "s1", null, { wrap: "none" }));
  p.push(textBox(d, m(20), m(46), m(170), m(30), [["Titolo della notizia: chiaro, breve e informativo", "Titolo 1", { sb: 0, z: 22 }], ["Un sottotitolo che riassume la notizia in una riga", "Sottotitolo", { z: 13 }]]));
  p.push(textBox(d, m(20), m(80), m(170), m(150), [["Citta', data – Il primo paragrafo risponde alle domande principali: chi, che cosa, quando, dove e perche'.", "Corpo del testo", { b: true }], ...body(4), ["“Una dichiarazione del responsabile rende la notizia piu' viva”, ha detto Nome Cognome, direttore di Azienda Esempio.", "Corpo del testo", { i: true }], [LOREM[1], "Corpo del testo"]]));
  p.push(shapeBox(d, "rect", m(20), m(238), m(170), m(36), "s1:12", null, { wrap: "none" }));
  p.push(textBox(d, m(24), m(241), m(162), m(30), [["Per informazioni", "Titolo 3", { sb: 0 }], ["Ufficio stampa · Nome Cognome · stampa@azienda.it · +39 000 000 0000", "Normale"], ["Azienda Esempio S.r.l. · www.azienda.it", "Normale"]]));
  return d;
}

function cartellina() {
  // cartella stampa / presentazione: copertina + pagina interna con tasca simulata
  const d = newDoc(210, 297);
  d.pages.push(newPage(d));
  const P1 = d.pages[0].items, P2 = d.pages[1].items;
  P1.push(shapeBox(d, "rect", 0, 0, d.w, d.h, "s1", null, { wrap: "none" }));
  P1.push(imageBox(d, m(55), m(60), m(100), m(60)));
  P1.push(textBox(d, m(20), m(140), m(170), m(40), [["Cartella stampa", "Titolo", { c: "s5", a: "c", z: 40 }]], { fit: "shrink", valign: "m" }));
  P1.push(textBox(d, m(20), m(182), m(170), m(14), [["Presentazione dell'azienda e dei progetti", "Sottotitolo", { c: "s5:70", a: "c" }]]));
  P1.push(textBox(d, m(20), m(262), m(170), m(16), [["Azienda Esempio S.r.l. · www.azienda.it", "Normale", { c: "s5", a: "c", z: 11 }]], { valign: "m" }));
  P2.push(textBox(d, m(20), m(20), m(170), m(130), [["Profilo aziendale", "Titolo 1", { sb: 0 }], ...body(5)], { cols: 2, gap: m(8) }));
  P2.push(shapeBox(d, "snip", m(20), m(190), m(170), m(85), "s1:20", { c: "s1", w: 1 }, { wrap: "none" }));
  P2.push(textBox(d, m(30), m(200), m(150), m(30), [["Tasca per documenti e biglietto da visita", "Titolo 3", { a: "c", sb: 0 }], ["Tagliare lungo il bordo e piegare verso l'interno.", "Didascalia", { a: "c" }]]));
  return d;
}

// [id, nome, categoria, funzione]
export const TEMPLATES = [
  ["vuoto-a4", "A4 verticale", "Vuoto", () => newDoc(210, 297)],
  ["vuoto-a4o", "A4 orizzontale", "Vuoto", () => newDoc(297, 210)],
  ["vuoto-a5", "A5 verticale", "Vuoto", () => newDoc(148, 210)],
  ["vuoto-a3", "A3 verticale", "Vuoto", () => newDoc(297, 420)],
  ["vuoto-lettera", "Lettera (US)", "Vuoto", () => newDoc(215.9, 279.4)],
  ["volantino", "Volantino evento", "Volantini", volantino],
  ["volantino-vendita", "Volantino promozione", "Volantini", volantinoVendita],
  ["brochure", "Brochure a tre ante", "Brochure", brochure],
  ["biglietto", "Biglietto da visita", "Biglietti da visita", biglietto],
  ["newsletter", "Newsletter", "Newsletter", newsletter],
  ["catalogo", "Catalogo prodotti", "Cataloghi", catalogo],
  ["invito", "Invito", "Inviti", invito],
  ["cartolina", "Cartolina di auguri", "Biglietti d'auguri", cartolina],
  ["comunicato", "Comunicato stampa", "Cartelle stampa", comunicato],
  ["cartellina", "Cartella stampa", "Cartelle stampa", cartellina],
].map(([id, name, cat, make]) => ({ id, name, cat, make }));
