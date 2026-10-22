// Pubblicazioni: modelli di partenza (scelti dentro l'editor, come la schermata "Modelli" di Publisher).
// Tutti i colori fanno riferimento alla combinazione (sN) e i caratteri alla combinazione di caratteri (+t/+b):
// cambiando combinazione cambia tutta la pubblicazione.
import { t as tr } from "./i18n.js";
import { MM, newDoc, newPage, textBox, imageBox, shapeBox, wordArt, tableBox } from "./pubmodel.js";

const m = v => v * MM;
const LOREM = [
  tr("pubtemplates.sostituire_questo_testo_vostro_fate"),
  tr("pubtemplates.raccontate_poche_righe_chi_siete"),
  tr("pubtemplates.potete_cambiare_carattere_dimensione_colore"),
  tr("pubtemplates.combinazioni_colori_caratteri_si_scelgono"),
];
const body = (n, style = "Corpo del testo") => Array.from({ length: n }, (_, k) => [LOREM[k % LOREM.length], style]);

function volantino() {
  const d = newDoc(210, 297);
  const p = d.pages[0].items;
  d.margins = { l: m(15), t: m(15), r: m(15), b: m(15) };
  p.push(shapeBox(d, "rect", 0, 0, d.w, m(92), "s1", null, { wrap: "none" }));
  p.push(shapeBox(d, "rect", 0, m(92), d.w, m(4), "s3", null, { wrap: "none" }));
  p.push(textBox(d, m(15), m(18), m(180), m(42), [[tr("pubtemplates.titolo_dell_evento"), "Titolo", { c: "s5", z: 44 }]], { valign: "b", fit: "shrink" }));
  p.push(textBox(d, m(15), m(62), m(180), m(22), [[tr("pubtemplates.slogan_breve_che_invoglia_partecipare"), "Sottotitolo", { c: "s5:70" }]]));
  p.push(imageBox(d, m(15), m(106), m(180), m(88)));
  p.push(textBox(d, m(15), m(202), m(112), m(70), [[tr("pubtemplates.cosa_si_tratta"), "Titolo 2"], ...body(2)]));
  p.push(shapeBox(d, "round", m(134), m(202), m(61), m(70), "s1:15", null, { wrap: "none", r: 10 }));
  p.push(textBox(d, m(138), m(206), m(53), m(62), [[tr("pubtemplates.quando"), "Titolo 3"], [tr("pubtemplates.sabato_14_novembre_ore_18"), "Normale"], [tr("pubtemplates.dove"), "Titolo 3"], [tr("pubtemplates.via_esempio_1_citta"), "Normale"], [tr("pubtemplates.ingresso"), "Titolo 3"], [tr("pubtemplates.libero_fino_ad_esaurimento_posti"), "Normale"]]));
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
  p.push(textBox(d, m(146), m(133), m(46), m(28), [["-30%", "Titolo", { c: "s5", a: "c", z: 34 }], [tr("pubtemplates.tutto"), "Normale", { c: "s5", a: "c", b: true }]], { valign: "m" }));
  p.push(wordArt(d, "GRANDI SALDI", m(15), m(160), m(180), m(34), { fill: "s1", outline: "s0", ow: 0, form: "piatto" }));
  p.push(textBox(d, m(15), m(198), m(180), m(14), [[tr("pubtemplates.solo_venerdi_domenica_tutti_i"), "Sottotitolo", { a: "c" }]]));
  p.push(textBox(d, m(15), m(216), m(180), m(50), [[tr("pubtemplates.approfittate_offerte"), "Titolo 2", { a: "c" }], [LOREM[1], "Corpo del testo", { a: "c" }]]));
  p.push(shapeBox(d, "rect", 0, d.h - m(22), d.w, m(22), "s1", null, { wrap: "none" }));
  p.push(textBox(d, m(15), d.h - m(20), m(180), m(18), [[tr("pubtemplates.negozio_esempio_via_roma_10"), "Normale", { c: "s5", a: "c", z: 12, b: true }]], { valign: "m" }));
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
  P1.push(textBox(d, pad, pad, W - 2 * pad, m(190), [[tr("pubtemplates.chi_siamo"), "Titolo 1"], ...body(3)]));
  P1.push(shapeBox(d, "rect", W, 0, W, d.h, "s1:12", null, { wrap: "none" }));
  P1.push(textBox(d, W + pad, m(20), W - 2 * pad, m(40), [[tr("pubtemplates.contatti"), "Titolo 2", { a: "c" }], [tr("pubtemplates.azienda_esempio_s_r_l"), "Indirizzo", { a: "c", b: true }], [tr("pubtemplates.via_esempio_1_00000_citta"), "Indirizzo", { a: "c" }], ["Tel. +39 000 000 0000", "Indirizzo", { a: "c" }], ["info@azienda.it", "Indirizzo", { a: "c" }]]));
  P1.push(imageBox(d, W + pad, m(70), W - 2 * pad, m(60)));
  P1.push(textBox(d, W + pad, m(135), W - 2 * pad, m(20), [[tr("pubtemplates.inserite_qui_mappa_logo"), "Didascalia", { a: "c" }]]));
  P1.push(shapeBox(d, "rect", 2 * W, 0, W, d.h, "s1", null, { wrap: "none" }));
  P1.push(imageBox(d, 2 * W + pad, m(25), W - 2 * pad, m(85)));
  P1.push(textBox(d, 2 * W + pad, m(118), W - 2 * pad, m(40), [[tr("pubtemplates.nome_dell_azienda"), "Titolo", { c: "s5", a: "c", z: 28 }]], { fit: "shrink", valign: "m" }));
  P1.push(textBox(d, 2 * W + pad, m(160), W - 2 * pad, m(20), [[tr("pubtemplates.vostro_slogan"), "Sottotitolo", { c: "s5:70", a: "c" }]]));
  // interno: testo collegato sulle tre ante
  const t1 = textBox(d, pad, pad + m(14), W - 2 * pad, m(176), [[tr("pubtemplates.titolo_dell_articolo_principale"), "Titolo 1"], ...body(8)]);
  const t2 = textBox(d, W + pad, pad, W - 2 * pad, m(110), []);
  const t3 = textBox(d, 2 * W + pad, pad, W - 2 * pad, m(110), []);
  delete d.stories[t2.story]; delete d.stories[t3.story];
  t2.story = t1.story; t3.story = t1.story; t1.next = t2.id; t2.next = t3.id;
  P2.push(textBox(d, pad, pad, W - 2 * pad, m(12), [[tr("pubtemplates.benvenuti"), "Testo in evidenza", { a: "l", c: "s1" }]]));
  P2.push(t1, t2, t3);
  P2.push(imageBox(d, W + pad, m(125), W - 2 * pad, m(65)));
  P2.push(shapeBox(d, "rect", 2 * W + pad, m(125), W - 2 * pad, m(65), "s1", null, { wrap: "none" }));
  P2.push(textBox(d, 2 * W + pad + m(4), m(129), W - 2 * pad - m(8), m(57), [[tr("pubtemplates.frase_importante_citazione_dato_che"), "Citazione", { c: "s5" }]], { valign: "m" }));
  return d;
}

function biglietto() {
  const d = newDoc(85, 55);
  d.margins = { l: m(4), t: m(4), r: m(4), b: m(4) };
  const p = d.pages[0].items;
  p.push(shapeBox(d, "rect", 0, 0, m(6), d.h, "s1", null, { wrap: "none" }));
  p.push(imageBox(d, m(61), m(5), m(19), m(19)));
  p.push(textBox(d, m(10), m(6), m(50), m(16), [[tr("pubtemplates.nome_cognome"), "Titolo 2", { z: 13, sb: 0 }], [tr("pubtemplates.ruolo_azienda"), "Didascalia", { i: false, c: "s2" }]], { pad: [0, 0, 0, 0] }));
  p.push(shapeBox(d, "line", m(10), m(27), m(70), 0, "none", { c: "s1", w: 0.75 }, { wrap: "none" }));
  p.push(textBox(d, m(10), m(30), m(70), m(21), [[tr("pubtemplates.azienda_esempio_s_r_l"), "Indirizzo", { b: true, z: 7.5 }], [tr("pubtemplates.via_esempio_1_00000_citta"), "Indirizzo", { z: 7.5 }], ["+39 000 000 0000 · nome@azienda.it", "Indirizzo", { z: 7.5 }], ["www.azienda.it", "Indirizzo", { z: 7.5, c: "s1" }]], { pad: [0, 0, 0, 0] }));
  return d;
}

function newsletter() {
  const d = newDoc(210, 297);
  d.margins = { l: m(15), t: m(15), r: m(15), b: m(18) };
  d.grid = { cols: 3, rows: 1, gap: m(5) };
  d.pages.push(newPage(d));
  const M = d.masters[0].items;
  M.push(shapeBox(d, "line", m(15), d.h - m(14), m(180), 0, "none", { c: "s1", w: 0.75 }, { wrap: "none" }));
  M.push(textBox(d, m(15), d.h - m(13), m(180), m(9), [[tr("pubtemplates.newsletter_numero_1_pagina_pagina"), "Normale", { a: "r", z: 8, c: "s2" }]], { pad: [0, 2, 0, 0] }));
  const P1 = d.pages[0].items, P2 = d.pages[1].items;
  P1.push(shapeBox(d, "rect", 0, 0, d.w, m(48), "s1", null, { wrap: "none" }));
  P1.push(textBox(d, m(15), m(10), m(180), m(26), [[tr("pubtemplates.nostra_newsletter"), "Titolo", { c: "s5", z: 40 }]], { fit: "shrink", valign: "b" }));
  P1.push(textBox(d, m(15), m(36), m(180), m(9), [[tr("pubtemplates.notizie_progetti_appuntamenti_novembre_2026"), "Normale", { c: "s5:70", z: 11 }]]));
  P1.push(shapeBox(d, "rect", m(15), m(56), m(52), m(110), "s1:15", null, { wrap: "none" }));
  P1.push(textBox(d, m(18), m(59), m(46), m(104), [[tr("pubtemplates.questo_numero"), "Titolo 2"], [tr("pubtemplates.articolo_principale"), "Elenco puntato"], [tr("pubtemplates.progetto_mese"), "Elenco puntato"], [tr("pubtemplates.prossimi_appuntamenti"), "Elenco puntato"], [tr("pubtemplates.nostra_squadra"), "Elenco puntato"], ["", "Normale"], [tr("pubtemplates.breve_nota_i_lettori_i"), "Didascalia", { i: false }]]));
  P1.push(textBox(d, m(73), m(56), m(122), m(20), [[tr("pubtemplates.titolo_dell_articolo_principale"), "Titolo 1", { sb: 0 }]]));
  P1.push(imageBox(d, m(73), m(78), m(122), m(62)));
  P1.push(textBox(d, m(73), m(141), m(122), m(8), [[tr("pubtemplates.didascalia_dell_immagine_descrivete_breve"), "Didascalia"]]));
  const a1 = textBox(d, m(73), m(152), m(122), m(124), [...body(10)], { cols: 2, gap: m(5) });
  P1.push(textBox(d, m(15), m(172), m(52), m(104), [[tr("pubtemplates.prossimi_appuntamenti"), "Titolo 3"], [tr("pubtemplates.12_11_incontro_i_clienti"), "Normale"], [tr("pubtemplates.20_11_fiera_settore"), "Normale"], [tr("pubtemplates.03_12_presentazione_nuovo_catalogo"), "Normale"]]));
  P1.push(a1);
  const a2 = textBox(d, m(15), m(15), m(180), m(80), [], { cols: 3, gap: m(5) });
  delete d.stories[a2.story];
  a2.story = a1.story; a1.next = a2.id;
  P2.push(a2);
  P2.push(shapeBox(d, "line", m(15), m(100), m(180), 0, "none", { c: "s3", w: 2 }, { wrap: "none" }));
  P2.push(textBox(d, m(15), m(104), m(180), m(16), [[tr("pubtemplates.progetto_mese"), "Titolo 1", { sb: 0 }]]));
  P2.push(imageBox(d, m(15), m(122), m(88), m(70)));
  P2.push(textBox(d, m(108), m(122), m(87), m(148), [...body(6)], { cols: 1 }));
  P2.push(shapeBox(d, "round", m(15), m(198), m(88), m(72), "s1", null, { wrap: "none", r: 8 }));
  P2.push(textBox(d, m(21), m(204), m(76), m(60), [[tr("pubtemplates.citazione_evidenza_attira_sguardo_invoglia"), "Citazione", { c: "s5" }]], { valign: "m" }));
  return d;
}

function invito() {
  const d = newDoc(148, 210);
  d.scheme = { name: "Orchidea", c: ["#33142e", "#a2336f", "#d77fb0", "#5c8fc8", "#ead1e1", "#fbf2f7"] };
  d.fonts = { name: "Elegante", t: "Constantia", b: "Candara" };
  const p = d.pages[0].items;
  p.push(shapeBox(d, "rect", m(7), m(7), m(134), m(196), "none", { c: "s1", w: 2.5 }, { wrap: "none" }));
  p.push(shapeBox(d, "rect", m(10), m(10), m(128), m(190), "none", { c: "s2", w: 0.75 }, { wrap: "none" }));
  p.push(wordArt(d, tr("pubtemplates.sei_invitato"), m(18), m(22), m(112), m(42), { form: "arco", fill: "s1", outline: "s0", ow: 0, shadow: false }));
  p.push(shapeBox(d, "star5", m(68), m(68), m(12), m(12), "s3", null, { wrap: "none" }));
  p.push(textBox(d, m(18), m(86), m(112), m(70), [[tr("pubtemplates.festa_i_nostri_25_anni"), "Sottotitolo", { a: "c", c: "s0" }], ["", "Normale"], [tr("pubtemplates.venerdi_4_dicembre_2026"), "Titolo 2", { a: "c" }], [tr("pubtemplates.dalle_ore_19_30"), "Normale", { a: "c", z: 12 }], [tr("pubtemplates.villa_esempio_via_giardini_5"), "Normale", { a: "c", z: 12 }]]));
  p.push(textBox(d, m(18), m(165), m(112), m(25), [[tr("pubtemplates.si_prega_confermare_entro_20"), "Didascalia", { a: "c", z: 9 }], [tr("pubtemplates.eventi_azienda_it_39_000"), "Didascalia", { a: "c", z: 9, i: false }]]));
  return d;
}

function catalogo() {
  const d = newDoc(210, 297);
  d.margins = { l: m(15), t: m(15), r: m(15), b: m(18) };
  d.grid = { cols: 2, rows: 3, gap: m(8) };
  d.pages.push(newPage(d));
  const M = d.masters[0].items;
  M.push(shapeBox(d, "rect", 0, d.h - m(12), d.w, m(12), "s1", null, { wrap: "none" }));
  M.push(textBox(d, m(15), d.h - m(11), m(180), m(10), [[tr("pubtemplates.catalogo_2026_pagina"), "Normale", { a: "r", c: "s5", z: 9, b: true }]], { valign: "m" }));
  const P1 = d.pages[0].items, P2 = d.pages[1].items;
  P1.push(textBox(d, m(15), m(12), m(180), m(22), [[tr("pubtemplates.catalogo_prodotti"), "Titolo", { z: 32 }]], { valign: "b" }));
  P1.push(shapeBox(d, "rect", m(15), m(35), m(180), m(1.2), "s3", null, { wrap: "none" }));
  const card = (P, x, y, n) => {
    P.push(imageBox(d, x, y, m(86), m(52), { line: { c: "s1:40", w: 0.5 } }));
    P.push(textBox(d, x, y + m(54), m(60), m(22), [[tr("pubtemplates.prodotto") + n, "Titolo 3", { sb: 0 }], [tr("pubtemplates.breve_descrizione_prodotto_materiali_dimensioni"), "Didascalia", { i: false }]], { pad: [0, 2, 0, 0] }));
    P.push(textBox(d, x + m(60), y + m(54), m(26), m(10), [["€ 99,00", "Testo in evidenza", { c: "s1", a: "r", z: 12 }]], { pad: [0, 2, 0, 0] }));
  };
  let n = 1;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) card(P1, m(15) + c * m(94), m(42) + r * m(80), n++);
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) card(P2, m(15) + c * m(94), m(15) + r * m(80), n++);
  P2.push(textBox(d, m(15), m(178), m(180), m(12), [[tr("pubtemplates.listino_prezzi"), "Titolo 2", { sb: 0 }]]));
  const t = tableBox(d, m(15), m(192), 5, 3, m(180), 20);
  const vals = [[tr("pubtemplates.codice"), tr("pubtemplates.descrizione"), tr("pubtemplates.prezzo")], ["P-001", tr("pubtemplates.prodotto_1"), "€ 99,00"], ["P-002", tr("pubtemplates.prodotto_2"), "€ 129,00"], ["P-003", tr("pubtemplates.prodotto_3"), "€ 79,00"], ["P-004", tr("pubtemplates.prodotto_4"), "€ 149,00"]];
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
  p.push(wordArt(d, tr("pubtemplates.buone_feste"), m(12), m(62), m(124), m(26), { form: "onda", fill: "s1", ow: 0, shadow: false }));
  p.push(textBox(d, m(12), m(89), m(124), m(12), [[tr("pubtemplates.auguri_serenita_successo_tutti_noi"), "Normale", { a: "c", z: 11, c: "s0" }]]));
  return d;
}

function comunicato() {
  const d = newDoc(210, 297);
  d.margins = { l: m(20), t: m(18), r: m(20), b: m(20) };
  const p = d.pages[0].items;
  p.push(imageBox(d, m(20), m(16), m(40), m(20)));
  p.push(textBox(d, m(110), m(18), m(80), m(18), [[tr("pubtemplates.comunicato_stampa"), "Titolo 2", { a: "r", sb: 0, c: "s1" }], [tr("pubtemplates.diffusione_immediata_data"), "Didascalia", { a: "r", i: false }]]));
  p.push(shapeBox(d, "rect", m(20), m(40), m(170), m(1.5), "s1", null, { wrap: "none" }));
  p.push(textBox(d, m(20), m(46), m(170), m(30), [[tr("pubtemplates.titolo_notizia_chiaro_breve_informativo"), "Titolo 1", { sb: 0, z: 22 }], [tr("pubtemplates.sottotitolo_che_riassume_notizia_riga"), "Sottotitolo", { z: 13 }]]));
  p.push(textBox(d, m(20), m(80), m(170), m(150), [[tr("pubtemplates.citta_data_primo_paragrafo_risponde"), "Corpo del testo", { b: true }], ...body(4), [tr("pubtemplates.dichiarazione_responsabile_rende_notizia_piu"), "Corpo del testo", { i: true }], [LOREM[1], "Corpo del testo"]]));
  p.push(shapeBox(d, "rect", m(20), m(238), m(170), m(36), "s1:12", null, { wrap: "none" }));
  p.push(textBox(d, m(24), m(241), m(162), m(30), [[tr("pubtemplates.informazioni"), "Titolo 3", { sb: 0 }], [tr("pubtemplates.ufficio_stampa_nome_cognome_stampa"), "Normale"], ["Azienda Esempio S.r.l. · www.azienda.it", "Normale"]]));
  return d;
}

function cartellina() {
  // cartella stampa / presentazione: copertina + pagina interna con tasca simulata
  const d = newDoc(210, 297);
  d.pages.push(newPage(d));
  const P1 = d.pages[0].items, P2 = d.pages[1].items;
  P1.push(shapeBox(d, "rect", 0, 0, d.w, d.h, "s1", null, { wrap: "none" }));
  P1.push(imageBox(d, m(55), m(60), m(100), m(60)));
  P1.push(textBox(d, m(20), m(140), m(170), m(40), [[tr("pubtemplates.cartella_stampa"), "Titolo", { c: "s5", a: "c", z: 40 }]], { fit: "shrink", valign: "m" }));
  P1.push(textBox(d, m(20), m(182), m(170), m(14), [[tr("pubtemplates.presentazione_dell_azienda_progetti"), "Sottotitolo", { c: "s5:70", a: "c" }]]));
  P1.push(textBox(d, m(20), m(262), m(170), m(16), [["Azienda Esempio S.r.l. · www.azienda.it", "Normale", { c: "s5", a: "c", z: 11 }]], { valign: "m" }));
  P2.push(textBox(d, m(20), m(20), m(170), m(130), [[tr("pubtemplates.profilo_aziendale"), "Titolo 1", { sb: 0 }], ...body(5)], { cols: 2, gap: m(8) }));
  P2.push(shapeBox(d, "snip", m(20), m(190), m(170), m(85), "s1:20", { c: "s1", w: 1 }, { wrap: "none" }));
  P2.push(textBox(d, m(30), m(200), m(150), m(30), [[tr("pubtemplates.tasca_documenti_biglietto_visita"), "Titolo 3", { a: "c", sb: 0 }], [tr("pubtemplates.tagliare_lungo_bordo_piegare_verso"), "Didascalia", { a: "c" }]]));
  return d;
}

// [id, nome, categoria, funzione]
export const TEMPLATES = [
  ["vuoto-a4", "A4 verticale", tr("pubtemplates.vuoto"), () => newDoc(210, 297)],
  ["vuoto-a4o", "A4 orizzontale", tr("pubtemplates.vuoto"), () => newDoc(297, 210)],
  ["vuoto-a5", "A5 verticale", tr("pubtemplates.vuoto"), () => newDoc(148, 210)],
  ["vuoto-a3", "A3 verticale", tr("pubtemplates.vuoto"), () => newDoc(297, 420)],
  ["vuoto-lettera", tr("pubtemplates.lettera_us"), tr("pubtemplates.vuoto"), () => newDoc(215.9, 279.4)],
  ["volantino", tr("pubtemplates.volantino_evento"), tr("pubtemplates.volantini"), volantino],
  ["volantino-vendita", tr("pubtemplates.volantino_promozione"), tr("pubtemplates.volantini"), volantinoVendita],
  ["brochure", tr("pubtemplates.brochure_tre_ante"), tr("pubtemplates.brochure"), brochure],
  ["biglietto", tr("pubtemplates.biglietto_visita"), tr("pubtemplates.biglietti_visita"), biglietto],
  ["newsletter", tr("pubtemplates.newsletter"), tr("pubtemplates.newsletter"), newsletter],
  ["catalogo", tr("pubtemplates.catalogo_prodotti"), tr("pubtemplates.cataloghi"), catalogo],
  ["invito", tr("pubtemplates.invito"), tr("pubtemplates.inviti"), invito],
  ["cartolina", tr("pubtemplates.cartolina_auguri"), tr("pubtemplates.biglietti_d_auguri"), cartolina],
  ["comunicato", tr("pubtemplates.comunicato_stampa_2"), tr("pubtemplates.cartelle_stampa"), comunicato],
  ["cartellina", tr("pubtemplates.cartella_stampa"), tr("pubtemplates.cartelle_stampa"), cartellina],
].map(([id, name, cat, make]) => ({ id, name, cat, make }));
