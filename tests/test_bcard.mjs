// Prove dei riconoscitori dei campi dei biglietti da visita (ui/js/bcardparse.js), senza browser:
//   node tests/test_bcard.mjs
// Con tests/samples/biglietti/attesi.json (python tools/make_bcard_samples.py) prova anche i testi dei campioni.
import * as B from "../ui/js/bcardparse.js";
import { readFileSync, existsSync } from "node:fs";

let ok = 0, ko = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok++; else { ko++; console.log(`KO ${name}\n   atteso ${w}\n   trovato ${g}`); }
};
const has = (name, cond) => { if (cond) ok++; else { ko++; console.log("KO " + name); } };
const ph = c => c.phones.map(p => p.type + " " + p.value);

// ---------------------------------------------------------------- biglietto italiano tipico
let c = B.parseText([
  { text: "MB Engineering S.r.l.", h: 40 },
  { text: "Ing. Mario Rossi", h: 34 },
  { text: "Direttore tecnico", h: 20 },
  { text: "Via Giuseppe Verdi, 12", h: 18 },
  { text: "20121 Milano (MI)", h: 18 },
  { text: "Tel. +39 02 1234 5678 - Fax 02 1234 5679", h: 18 },
  { text: "Cell. 333 123 4567", h: 18 },
  { text: "m.rossi@mbengineering.it", h: 18 },
  { text: "www.mbengineering.it", h: 18 },
  { text: "P.IVA 01234567890", h: 14 },
]);
eq("it nome", [c.prefix, c.given, c.family], ["Ing.", "Mario", "Rossi"]);
eq("it azienda", c.org, "MB Engineering S.r.l.");
eq("it ruolo", c.title, "Direttore tecnico");
eq("it indirizzo", c.adr, { street: "Via Giuseppe Verdi, 12", cap: "20121", city: "Milano", prov: "MI", country: "" });
eq("it telefoni", ph(c), ["work +39 02 1234 5678", "fax +39 02 1234 5679", "cell +39 333 123 4567"]);
eq("it email", c.emails, ["m.rossi@mbengineering.it"]);
eq("it sito", c.urls, ["www.mbengineering.it"]);
eq("it piva", c.piva, "01234567890");
eq("it nessuna riga avanzata", c.extra, []);

// ---------------------------------------------------------------- cognome in maiuscolo, indirizzo su una riga, senza etichette
c = B.parseText("ROSSI Maria Teresa\nArchitetto\nStudio Tecnico Bianchi & Associati\nPiazza della Libertà 3, 50129 Firenze FI\n055 123456\n347 9876543\nmariateresa.rossi@studiobianchi.com\nC.F. RSSMTR80A41D612X");
eq("caps nome", [c.given, c.family], ["Maria Teresa", "Rossi"]);
eq("caps ruolo", c.title, "Architetto");
eq("caps azienda", c.org, "Studio Tecnico Bianchi & Associati");
eq("caps indirizzo", c.adr, { street: "Piazza della Libertà 3", cap: "50129", city: "Firenze", prov: "FI", country: "" });
eq("caps telefoni senza etichetta", ph(c), ["work +39 055 123456", "cell +39 347 9876543"]);
eq("caps cf", c.cf, "RSSMTR80A41D612X");

// ---------------------------------------------------------------- inglese, prefissi internazionali, social
c = B.parseText([
  { text: "John A. Smith", h: 36 },
  { text: "Senior Project Manager", h: 20 },
  { text: "Acme Building Ltd", h: 28 },
  { text: "221B Baker Street", h: 16 },
  { text: "London NW1 6XE, United Kingdom", h: 16 },
  { text: "T: +44 20 7946 0958", h: 16 },
  { text: "M: +44 7700 900123", h: 16 },
  { text: "john.smith@acmebuilding.co.uk", h: 16 },
  { text: "linkedin.com/in/johnsmith", h: 16 },
  { text: "VAT No. GB123456789", h: 12 },
]);
eq("en nome", [c.given, c.family], ["John A.", "Smith"]);
eq("en ruolo", c.title, "Senior Project Manager");
eq("en azienda", c.org, "Acme Building Ltd");
eq("en telefoni", ph(c), ["work +44 20 7946 0958", "cell +44 7700 900123"]);
eq("en social", c.socials, [{ type: "linkedin", value: "linkedin.com/in/johnsmith" }]);
eq("en via", c.adr.street, "221B Baker Street");
has("en sito non dal social o dall'email", c.urls.length === 0);

// ---------------------------------------------------------------- nome e ruolo sulla stessa riga, particelle, pec, 0039
c = B.parseText("Geom. Luca De Santis - Responsabile cantieri\nEdilnord Costruzioni S.p.A.\nSede legale: Corso Vittorio Emanuele II 45 - 10125 Torino (TO)\nTel 011/5551234 Cell 0039 338 1112223\nluca.desantis@edilnord.it  PEC edilnord@legalmail.it\nInstagram: @edilnord");
eq("riga unica nome", [c.prefix, c.given, c.family], ["Geom.", "Luca", "De Santis"]);
eq("riga unica ruolo", c.title, "Responsabile cantieri");
eq("riga unica azienda", c.org, "Edilnord Costruzioni S.p.A.");
eq("sede legale", c.adr, { street: "Corso Vittorio Emanuele II 45", cap: "10125", city: "Torino", prov: "TO", country: "" });
eq("telefoni con / e 0039", ph(c), ["work +39 011 5551234", "cell +39 338 1112223"]);
eq("due email", c.emails, ["luca.desantis@edilnord.it", "edilnord@legalmail.it"]);
eq("instagram", c.socials, [{ type: "instagram", value: "@edilnord" }]);

// ---------------------------------------------------------------- numeri che NON sono telefoni
c = B.parseText("Alfa Srl\nP. IVA e C.F. 09876543210\nREA MI-1234567\nCap. Soc. 10.000 euro i.v.\nVia Roma 1 00184 Roma\nTel. 06 99887766");
eq("niente piva/rea tra i telefoni", ph(c), ["work +39 06 99887766"]);
eq("piva con CF", c.piva, "09876543210");
eq("cap non telefono", c.adr.cap, "00184");

// ---------------------------------------------------------------- QR: vCard 3.0 / 2.1 / MECARD / URL
const vc = "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Bianchi;Giulia;;Dott.ssa;\r\nFN:Dott.ssa Giulia Bianchi\r\nORG:Bianchi Consulting\r\nTITLE:Consulente\r\nTEL;TYPE=CELL:+39 320 1234567\r\nTEL;TYPE=WORK,VOICE:+39 06 1234567\r\nEMAIL;TYPE=INTERNET:giulia@bianchiconsulting.it\r\nURL:https://bianchiconsulting.it\r\nADR;TYPE=WORK:;;Via Appia\\, 10;Roma;RM;00179;Italia\r\nEND:VCARD";
let q = B.parseQr(vc);
eq("qr vcard tipo", q.kind, "vcard");
eq("qr vcard nome", [q.c.prefix, q.c.given, q.c.family, q.c.org, q.c.title], ["Dott.ssa", "Giulia", "Bianchi", "Bianchi Consulting", "Consulente"]);
eq("qr vcard telefoni", ph(q.c), ["cell +39 320 1234567", "work +39 06 1234567"]);
eq("qr vcard indirizzo", q.c.adr, { street: "Via Appia, 10", city: "Roma", prov: "RM", cap: "00179", country: "Italia" });
q = B.parseQr("BEGIN:VCARD\nVERSION:2.1\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Nicol=C3=B2;Andrea\nTEL;CELL:3351234567\nEMAIL;INTERNET:a.nicolo@example.it\nEND:VCARD");
eq("qr vcard 2.1", [q.c.given, q.c.family, ph(q.c)], ["Andrea", "Nicolò", ["cell +39 3351234567"]]);
q = B.parseQr("MECARD:N:Verdi,Paolo;TEL:+390212345678;TEL:3471234567;EMAIL:paolo@verdi.it;URL:http://www.verdi.it;ORG:Verdi SNC;;");
eq("qr mecard", [q.kind, q.c.given, q.c.family, q.c.org, ph(q.c), q.c.urls], ["mecard", "Paolo", "Verdi", "Verdi SNC", ["work +390212345678", "cell +39 3471234567"], ["www.verdi.it"]]);
q = B.parseQr("https://www.linkedin.com/in/paolo-verdi");
eq("qr link social", q.c.socials, [{ type: "linkedin", value: "www.linkedin.com/in/paolo-verdi" }]);
eq("qr testo qualsiasi", B.parseQr("ciao"), null);

// ---------------------------------------------------------------- fronte + retro + QR senza doppioni, il QR vince
const front = B.parseText("Mario Rossi\nRossi Impianti Srl\nTel. 02 1234567\nmario@rossiimpianti.it");
const back = B.parseText("Rossi Impianti Srl\nVia Torino 5, 20123 Milano MI\nTel. +39 02 1234567\nCell. 335 7654321\nwww.rossiimpianti.it\nmario@rossiimpianti.it");
const qr = B.parseQr("MECARD:N:Rossi,Mario Luigi;TEL:+39 335 7654321;;").c;
c = B.merge(qr, front, back);
eq("unione nome dal QR", [c.given, c.family], ["Mario Luigi", "Rossi"]);
eq("unione telefoni senza doppioni", ph(c), ["cell +39 335 7654321", "work +39 02 1234567"]);
eq("unione email", c.emails, ["mario@rossiimpianti.it"]);
eq("unione indirizzo dal retro", c.adr.city, "Milano");
eq("unione sito", c.urls, ["www.rossiimpianti.it"]);

// ---------------------------------------------------------------- vCard in uscita
const out = B.buildVcard({ ...B.empty(), given: "Niccolò", family: "D'Amico", org: "Studio; Rossi, Bianchi", phones: [{ type: "cell", value: "+39 333 1234567" }, { type: "fax", value: "+39 02 1" }],
  emails: ["n@x.it"], urls: ["www.x.it"], adr: { street: "Via Po 1", cap: "10100", city: "Torino", prov: "TO", country: "Italia" }, piva: "01234567890", note: "" }, { photo: "A".repeat(300) });
has("vcard CRLF", out.includes("\r\nVERSION:3.0\r\n"));
has("vcard N", out.includes("N:D'Amico;Niccolò;;;"));
has("vcard ORG escape", out.includes("ORG:Studio\\; Rossi\\, Bianchi"));
has("vcard tel", out.includes("TEL;TYPE=CELL,VOICE:+39 333 1234567") && out.includes("TEL;TYPE=WORK,FAX:+39 02 1"));
has("vcard url https", out.includes("URL;TYPE=WORK:https://www.x.it"));
has("vcard adr", out.includes("ADR;TYPE=WORK:;;Via Po 1;Torino;TO;10100;Italia"));
has("vcard nota piva", out.includes("NOTE:P.IVA 01234567890"));
const enc = new TextEncoder();
has("vcard righe <= 75 byte", out.split("\r\n").every(l => enc.encode(l).length <= 75));
has("vcard foto piegata", /PHOTO;ENCODING=b;TYPE=JPEG:A+\r\n A+/.test(out));
const back2 = B.parseVcard(out);
eq("vcard rilettura", [back2.given, back2.family, back2.org, ph(back2), back2.adr.city], ["Niccolò", "D'Amico", "Studio; Rossi, Bianchi", ["cell +39 333 1234567", "fax +39 02 1"], "Torino"]);

// ---------------------------------------------------------------- testi dei campioni sintetici (attesi.json)
const att = new URL("./samples/biglietti/attesi.json", import.meta.url);
if (existsSync(att)) {
  const A = JSON.parse(readFileSync(att, "utf8"));
  for (const s of A.biglietti) {
    const parts = s.lati.map(l => B.parseText(l.testo));
    const qrc = s.qr ? B.parseQr(s.qr).c : null;
    const r = B.merge(qrc, ...parts);
    const e = s.atteso;
    eq(`${s.id} nome`, [r.given, r.family], [e.given, e.family]);
    if (e.org) eq(`${s.id} azienda`, r.org, e.org);
    if (e.title) eq(`${s.id} ruolo`, r.title, e.title);
    eq(`${s.id} email`, r.emails, e.emails);
    eq(`${s.id} telefoni`, r.phones.map(p => p.type + " " + B.phoneKey(p.value)).sort(), e.phones.slice().sort());
    if (e.city) eq(`${s.id} citta'`, r.adr.city, e.city);
  }
}

console.log(`\n${ok} prove riuscite, ${ko} fallite`);
process.exit(ko ? 1 : 0);
