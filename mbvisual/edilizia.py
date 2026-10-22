"""Pratiche edilizie: anagrafica di commessa (.mbcomm) e moduli compilati in automatico.

Anagrafica = JSON nella cartella di progetto (committenti, immobile con dati catastali, tecnici, imprese, intervento):
si scrive una volta sola e riempie tutti i moduli. I modelli stanno in ui/templates/edilizia/*.mbm, scritti in un
linguaggio a righe (descritto in `parse`) e trascritti dai moduli unificati nazionali (Accordi in Conferenza Unificata
4/5/2017, 4/8/2021 CILA-Superbonus, 27/3/2025 "Salva Casa"; fonti in ui/templates/edilizia/FONTI.md).
Ogni modello diventa:
- un PDF con campi modulo (testo e caselle) gia' compilati dall'anagrafica: il resto si compila nell'editor PDF;
- oppure un DOCX (python-docx) per gli schemi da completare a testo libero (relazione tecnica, dichiarazione di conformita').
Fascicolo = un solo PDF con frontespizio, indice con i numeri di pagina e segnalibri (campi appiattiti).
Visura catastale PDF (Agenzia delle Entrate): `visura` legge comune, foglio, particella, subalterno, categoria, indirizzo e
intestati dal testo.

Il testo dei moduli resta in italiano (sono atti amministrativi italiani); i messaggi del motore passano da t().
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path

from .i18n import t
from .paths import UI_DIR

TPL_DIR = UI_DIR / "templates" / "edilizia"
VERSION = 1

# ------------------------------------------------------------------ elenco dei moduli
# id, file del modello, uscita (pdf|docx), nome del file generato
MODULI = [
    ("cila", "cila.mbm", "pdf", "CILA"),
    ("cilas", "cilas.mbm", "pdf", "CILA-Superbonus"),
    ("scia", "scia.mbm", "pdf", "SCIA"),
    ("scia_alt", "scia_alternativa.mbm", "pdf", "SCIA alternativa al permesso di costruire"),
    ("inizio", "inizio_lavori.mbm", "pdf", "Comunicazione di inizio lavori"),
    ("fine", "fine_lavori.mbm", "pdf", "Comunicazione di fine lavori"),
    ("soggetti", "soggetti_coinvolti.mbm", "pdf", "Soggetti coinvolti"),
    ("relazione", "relazione_tecnica.mbm", "docx", "Relazione tecnica asseverata"),
    ("conformita", "dichiarazione_conformita.mbm", "docx", "Dichiarazione di conformità"),
    ("procura", "procura_speciale.mbm", "pdf", "Procura speciale"),
    ("delega", "delega.mbm", "pdf", "Delega"),
]

# Regioni: modulistica regionale adottata dopo l'Accordo "Salva Casa" (27/3/2025) o precedente.
# I moduli generati sono quelli nazionali; per queste regioni i quadri variabili (*) possono differire.
REGIONI = [
    ("", "Nazionale (moduli unificati)", ""),
    ("ABR", "Abruzzo", "DGR 318 del 29/05/2025"),
    ("BAS", "Basilicata", "DGR 246/2025 e 656/2025"),
    ("BZ", "Provincia autonoma di Bolzano", "modulistica provinciale propria"),
    ("CAL", "Calabria", "DGR 573 del 20/11/2025"),
    ("CAM", "Campania", "DD 217 del 16/06/2025, DD 14 del 26/09/2025, DD 55 del 13/10/2025"),
    ("EMR", "Emilia-Romagna", "DGR 1298 del 28/07/2025 (modulistica edilizia unificata regionale)"),
    ("FVG", "Friuli Venezia Giulia", "modulistica regionale propria (anni precedenti)"),
    ("LAZ", "Lazio", "DD G05745 del 09/05/2025"),
    ("LIG", "Liguria", "modulistica regionale aggiornata nel 2025"),
    ("LOM", "Lombardia", "DGR XII/4246 del 15/04/2025"),
    ("MAR", "Marche", "DGR 902/2025, DGR 1660 del 18/11/2025"),
    ("MOL", "Molise", "DGR 466 del 16/12/2025"),
    ("PIE", "Piemonte", "DGR 4-1118 del 20/05/2025"),
    ("PUG", "Puglia", "DGR 534 del 03/12/2025"),
    ("SAR", "Sardegna", "piattaforma SUAPE (LR 18/2025)"),
    ("SIC", "Sicilia", "DA 123/2025 e 281/2025"),
    ("TOS", "Toscana", "DD 10133 del 14/05/2025, DD 13763 del 20/06/2025"),
    ("TN", "Provincia autonoma di Trento", "modulistica provinciale propria"),
    ("UMB", "Umbria", "DGR 439 del 14/05/2025"),
    ("VDA", "Valle d'Aosta", "modulistica regionale propria (anni precedenti)"),
    ("VEN", "Veneto", "modulistica regionale propria (anni precedenti)"),
]

# Nomi (in italiano: sono testo dei moduli) dei codici usati nell'anagrafica
TIPOLOGIE = {
    "manutenzione_straordinaria": "manutenzione straordinaria (art. 3, comma 1, lett. b), d.P.R. 380/2001)",
    "manutenzione_straordinaria_strutturale": "manutenzione straordinaria che riguarda parti strutturali o prospetti",
    "restauro": "restauro e risanamento conservativo (art. 3, comma 1, lett. c), d.P.R. 380/2001)",
    "restauro_strutturale": "restauro e risanamento conservativo che riguarda parti strutturali",
    "ristrutturazione": "ristrutturazione edilizia (art. 3, comma 1, lett. d), d.P.R. 380/2001)",
    "ristrutturazione_pesante": "ristrutturazione edilizia di cui all'art. 10, comma 1, lett. c), d.P.R. 380/2001",
    "nuova_costruzione": "nuova costruzione in diretta esecuzione di strumenti urbanistici con precise disposizioni plano-volumetriche",
    "nuova_costruzione_piano_attuativo": "nuova costruzione o ristrutturazione urbanistica disciplinata da piano attuativo",
    "barriere": "eliminazione delle barriere architettoniche con ascensori esterni o manufatti che alterano la sagoma",
    "pertinenze": "realizzazione di pertinenze minori",
    "geognostiche": "opere temporanee per attività di ricerca nel sottosuolo a carattere geognostico",
    "movimenti_terra": "movimenti di terra non pertinenti all'attività agricola",
    "serre": "serre mobili stagionali con strutture in muratura",
    "variante_pdc": "variante in corso d'opera a permesso di costruire",
    "variante_scia": "variante in corso d'opera a SCIA",
    "variante_scia_essenziale": "variante in corso d'opera a SCIA che costituisce variazione essenziale",
    "mutamento_uso": "mutamento di destinazione d'uso",
    "altro": "altro intervento",
}
TIPI_TITOLO = {
    "suap": "titolo unico (SUAP)", "pdc": "permesso di costruire / licenza edilizia / concessione edilizia",
    "autorizzazione": "autorizzazione edilizia", "comunicazione": "comunicazione edilizia (art. 26 l. 47/1985)",
    "dia": "denuncia di inizio attività", "dia_alt": "DIA/SCIA alternativa al permesso di costruire",
    "scia": "segnalazione certificata di inizio attività", "cila": "comunicazione inizio lavori asseverata",
    "cil": "comunicazione edilizia libera", "condono": "condono edilizio",
    "pdc_sanatoria": "permesso di costruire in sanatoria (artt. 36 o 36-bis)", "scia_sanatoria": "SCIA in sanatoria (art. 36-bis)",
    "scia_variante77": "SCIA in sanatoria per variante a titolo anteriore alla l. 10/1977", "altro": "altro",
}

RUOLI_TECNICI = ("progettista", "direttore_lavori", "strutturista", "dl_strutture", "sicurezza", "impianti", "altro")


# ------------------------------------------------------------------ anagrafica
def _persona() -> dict:
    return {"tipo": "persona", "cognome": "", "nome": "", "cf": "", "nato_a": "", "nato_prov": "", "nato_stato": "",
            "nato_il": "", "res_comune": "", "res_prov": "", "res_stato": "", "res_indirizzo": "", "res_civico": "",
            "res_cap": "", "pec": "", "email": "", "telefono": "", "titolo": "", "quota": "",
            "ditta": {"ragione": "", "cf_piva": "", "qualita": "", "cciaa": "", "cciaa_prov": "", "cciaa_n": "",
                      "sede_comune": "", "sede_prov": "", "sede_indirizzo": "", "sede_cap": "", "pec": "", "telefono": ""}}


def nuova() -> dict:
    """Anagrafica vuota (struttura completa: l'interfaccia la riempie)."""
    return {
        "tipo": "mbvisual-commessa", "versione": VERSION,
        "commessa": {"codice": "", "nome": ""},
        "regione": "",
        "comune": {"nome": "", "prov": "", "sportello": "SUE", "indirizzo": "", "pec": ""},
        "committenti": [_persona()],
        "procuratore": {**_persona(), "attivo": False},
        "immobile": {"via": "", "civico": "", "scala": "", "piano": "", "interno": "", "cap": "", "comune": "", "prov": "",
                     "catasto": "fabbricati", "sezione": "", "sez_urbana": "", "foglio": "", "particella": "", "subalterno": "",
                     "categoria": "", "classe": "", "consistenza": "", "superficie": "", "rendita": "", "destinazione": "",
                     "coordinate": "", "altre_unita": [], "zona_urbanistica": "", "zona_sismica": "", "anno_costruzione": "",
                     "ante67": False, "titolo_legittimo": "", "titolo_legittimazione": "", "difformita": False, "titoli": []},
        "tecnici": [], "imprese": [],
        "intervento": {"descrizione": "", "tipologia": "", "inizio_lavori": "", "fine_lavori": "", "fine_parziale": False,
                       "titolo_tipo": "", "titolo_n": "", "titolo_data": "", "importo": "", "superficie": "", "volume": "",
                       "piani": "", "oneroso": False, "parti_comuni": "no", "titolarita_esclusiva": True,
                       "sicurezza_81": False, "cantiere_200": False, "notifica_99": False, "sicurezza_riserva": False,
                       "stato_lavori": "da_iniziare", "inizio_effettivo": "", "data_realizzazione": "", "altri_atti": "nessuno",
                       "tipologia_altro": "", "cambio_uso": "no", "contributo_calcolo": "tecnico", "contributo_pagato": False,
                       "gratuito_norma": "", "in_economia": False, "variante": False, "superbonus": "", "note": ""},
        "pratica": {"numero": "", "protocollo": "", "data": ""},
        "generati": [],
    }


def _merge(base, data):
    """Unisce i dati letti alla struttura completa: chiavi mancanti (file vecchi o scritti a mano) con il valore vuoto."""
    if isinstance(base, dict) and isinstance(data, dict):
        out = dict(base)
        for k, v in data.items():
            out[k] = _merge(base[k], v) if k in base else v
        return out
    return data if data is not None else base


def normalizza(data: dict) -> dict:
    a = _merge(nuova(), data or {})
    a["committenti"] = [_merge(_persona(), p) for p in (a.get("committenti") or [])] or [_persona()]
    a["procuratore"] = _merge({**_persona(), "attivo": False}, a.get("procuratore") or {})
    a["tecnici"] = [_merge({**_persona(), "ruolo": "progettista", "ruolo_altro": "", "anche_dl": False, "albo": "", "albo_prov": "",
                            "albo_n": "", "piva": "", "studio_comune": "", "studio_prov": "", "studio_stato": "Italia",
                            "studio_indirizzo": "", "studio_civico": "", "studio_cap": "", "cellulare": "", "abilitazione": ""}, x)
                    for x in (a.get("tecnici") or [])]
    a["imprese"] = [_merge({"ragione": "", "cf_piva": "", "cciaa": "", "cciaa_prov": "", "cciaa_n": "", "sede_comune": "",
                            "sede_prov": "", "sede_stato": "Italia", "sede_indirizzo": "", "sede_civico": "", "sede_cap": "",
                            "legale_cognome": "", "legale_nome": "", "legale_cf": "", "legale_nato_a": "", "legale_nato_prov": "",
                            "legale_nato_stato": "Italia", "legale_nato_il": "", "pec": "", "email": "", "telefono": "", "cellulare": "",
                            "cassa_sede": "", "cassa_codice_impresa": "", "cassa_codice": "", "inps_sede": "", "inps_matricola": "",
                            "inail_sede": "", "inail_codice": "", "inail_pat": "", "lavori": ""}, x)
                    for x in (a.get("imprese") or [])]
    return a


def leggi(path: str) -> dict:
    p = Path(path)
    txt = p.read_text(encoding="utf-8-sig") if p.exists() and p.stat().st_size else ""
    return normalizza(json.loads(txt) if txt.strip() else {})


def scrivi(path: str, data: dict) -> dict:
    a = normalizza(data)
    Path(path).write_bytes(json.dumps(a, ensure_ascii=False, indent=1).encode("utf-8"))
    return a


# ------------------------------------------------------------------ valori per i modelli
def _data_it(v) -> str:
    """'2026-10-22' -> '22/10/2026' (le date gia' scritte all'italiana restano come sono)."""
    if not v:
        return ""
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", str(v))
    return f"{m.group(3)}/{m.group(2)}/{m.group(1)}" if m else str(v)


def _persona_vista(p: dict) -> dict:
    v = dict(p)
    v["cognome_nome"] = " ".join(x for x in (p.get("cognome", ""), p.get("nome", "")) if x).strip()
    v["nato_il"] = _data_it(p.get("nato_il"))
    if v.get("cognome") or v.get("cf"):  # persona indicata senza stato: Italia (si cambia nella finestra dei dati)
        v["nato_stato"] = v.get("nato_stato") or "Italia"
        v["res_stato"] = v.get("res_stato") or "Italia"
    v["indirizzo"] = p.get("res_indirizzo", "")
    v["recapito"] = p.get("pec") or p.get("email") or ""
    d = dict(p.get("ditta") or {})
    v["ditta"] = d
    v["societa"] = bool(p.get("tipo") == "societa" or d.get("ragione"))
    return v


def contesto(a: dict) -> dict:
    """Variabili disponibili nei modelli (`{tit.cognome_nome}`, `{imm.foglio}`, `@per x in titolari_altri`...)."""
    a = normalizza(a)
    tit = [_persona_vista(p) for p in a["committenti"]]
    tec = []
    for x in a["tecnici"]:
        v = _persona_vista(x)
        v["ruolo_nome"] = x.get("ruolo_altro") if x.get("ruolo") == "altro" else {
            "progettista": "progettista delle opere architettoniche", "direttore_lavori": "direttore dei lavori",
            "strutturista": "progettista delle opere strutturali", "dl_strutture": "direttore dei lavori delle opere strutturali",
            "sicurezza": "coordinamento della sicurezza in fase di progettazione e di esecuzione",
            "impianti": "progettista degli impianti"}.get(x.get("ruolo"), x.get("ruolo", ""))
        v["albo_completo"] = " ".join(s for s in (x.get("albo", ""), ("di " + x["albo_prov"]) if x.get("albo_prov") else "",
                                                   ("n. " + x["albo_n"]) if x.get("albo_n") else "") if s)
        tec.append(v)
    imp = []
    for x in a["imprese"]:
        v = dict(x)
        v["legale"] = " ".join(s for s in (x.get("legale_cognome", ""), x.get("legale_nome", "")) if s)
        v["legale_nato_il"] = _data_it(x.get("legale_nato_il"))
        v["cassa"] = bool(x.get("cassa_sede") or x.get("cassa_codice"))
        v["inps"] = bool(x.get("inps_sede") or x.get("inps_matricola"))
        v["inail"] = bool(x.get("inail_sede") or x.get("inail_codice"))
        imp.append(v)
    first = lambda role: next((x for x in tec if x.get("ruolo") == role), None)  # noqa: E731
    one = lambda role: [first(role)] if first(role) else [{}]  # sezione del modulo: il tecnico, o vuota da compilare  # noqa: E731
    base_roles = ("progettista", "direttore_lavori", "strutturista", "dl_strutture")
    imm = dict(a["immobile"])
    imm["indirizzo"] = " ".join(s for s in (imm.get("via", ""), imm.get("civico", "")) if s)
    imm["catastali"] = ", ".join(s for s in (
        ("sez. " + imm["sezione"]) if imm.get("sezione") else "", ("foglio " + imm["foglio"]) if imm.get("foglio") else "",
        ("particella " + imm["particella"]) if imm.get("particella") else "", ("sub. " + imm["subalterno"]) if imm.get("subalterno") else "",
        ("cat. " + imm["categoria"]) if imm.get("categoria") else "") if s)
    if not imm.get("comune"):
        imm["comune"] = a["comune"].get("nome", "")
    # titoli edilizi dell'immobile: per tipo (quadro "Regolarita' urbanistica") e gli "altro"
    titoli = []
    for x in imm.get("titoli") or []:
        v = dict(x)
        v["data"] = _data_it(x.get("data"))
        v["tipo_nome"] = x.get("descrizione") if x.get("tipo") == "altro" and x.get("descrizione") else TIPI_TITOLO.get(x.get("tipo"), x.get("tipo", ""))
        titoli.append(v)
    imm["titoli"] = titoli
    tt = {}
    for v in titoli:
        if v.get("tipo") and v["tipo"] != "altro" and v["tipo"] not in tt:
            tt[v["tipo"]] = v
    itv = dict(a["intervento"])
    itv["tipologia_nome"] = itv.get("tipologia_altro") if itv.get("tipologia") == "altro" and itv.get("tipologia_altro") else TIPOLOGIE.get(itv.get("tipologia"), itv.get("tipologia", ""))
    for k in ("inizio_lavori", "fine_lavori", "titolo_data", "inizio_effettivo", "data_realizzazione"):
        itv[k] = _data_it(itv.get(k))
    oggi = date.today().strftime("%d/%m/%Y")
    luogo = a["comune"].get("nome") or imm.get("comune") or ""
    vuota = {k: ("" if isinstance(v, str) else v) for k, v in _persona().items()}
    proc = _persona_vista(a["procuratore"]) if a["procuratore"].get("attivo") else _persona_vista(vuota)
    proc["attivo"] = bool(a["procuratore"].get("attivo"))
    reg = next((r for r in REGIONI if r[0] == a.get("regione")), REGIONI[0])
    prog = first("progettista") or (tec[0] if tec else _persona_vista(vuota))
    return {
        "tit": tit[0], "titolari": tit, "titolari_altri": tit[1:], "piu_titolari": len(tit) > 1,
        "proc": proc, "imm": imm, "altre_unita": imm.get("altre_unita") or [], "titoli": titoli, "tt": tt,
        "titoli_altri": [v for v in titoli if v.get("tipo") == "altro"],
        "tecnici": tec, "prog": prog,
        # procuratore per procura e delega: quello indicato, altrimenti il progettista
        "pr": proc if proc["attivo"] else prog,
        "dl": first("direttore_lavori") or {}, "strutt": first("strutturista") or {}, "csp": first("sicurezza") or {},
        "altri_tecnici": [x for x in tec if x is not (first("progettista") or (tec[0] if tec else None))],
        "tec_prog": one("progettista"), "tec_dl": one("direttore_lavori"), "tec_strutt": one("strutturista"),
        "tec_dls": one("dl_strutture"), "tec_altri": [x for x in tec if x.get("ruolo") not in base_roles] or [{}],
        "imprese": imp, "imp": imp[0] if imp else {}, "imprese_o_vuota": imp or [{}], "com": a["comune"], "int": itv, "prat": a["pratica"],
        "commessa": a["commessa"], "regione": {"codice": reg[0], "nome": reg[1], "atto": reg[2]},
        "oggi": oggi, "luogo_data": f"{luogo}, {oggi}" if luogo else oggi,
    }


def _get(scope: dict, path: str):
    cur = scope
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.isdigit():
            i = int(part)
            cur = cur[i] if i < len(cur) else None
        else:
            return None
        if cur is None:
            return None
    return cur


def _str(v) -> str:
    if v is None or v is False:
        return ""
    if v is True:
        return "X"
    return str(v)


def _cond(expr: str, scope: dict) -> bool:
    """Condizione delle caselle: `a.b` (vero se pieno), `!a.b`, `a.b=v1|v2`, `a.b!=v`, piu' condizioni unite da `&`."""
    expr = (expr or "").strip()
    if not expr:
        return False
    if expr == "1":
        return True
    for part in expr.split("&"):
        part = part.strip()
        if "!=" in part:
            k, v = part.split("!=", 1)
            ok = _str(_get(scope, k.strip())).lower() not in [x.strip().lower() for x in v.split("|")]
        elif "=" in part:
            k, v = part.split("=", 1)
            ok = _str(_get(scope, k.strip())).lower() in [x.strip().lower() for x in v.split("|")]
        elif part.startswith("!"):
            ok = not any(_get(scope, x.strip()) for x in part[1:].split("|"))
        else:
            ok = any(_get(scope, x.strip()) for x in part.split("|"))
        if not ok:
            return False
    return True


# ------------------------------------------------------------------ linguaggio dei modelli (.mbm)
# Una riga = un blocco:
#   # commento                     @meta chiave valore (titolo, rif, fonte...)
#   = TITOLO   ~ sottotitolo       ## FASCIA DI SEZIONE | nota a destra      ### a) Titolo del quadro
#   !! DICHIARA (centrato, grassetto)
#   testo libero                   -> paragrafo; `>` all'inizio = rientro (uno per livello)
#   [codice?condizione] testo      -> casella con codice (es. [a.1?int.titolarita_esclusiva]); `[]` senza codice
#   {{percorso:righe}}             -> campo di testo su piu' righe a tutta larghezza
#   | cella | cella |  (|# = intestazione)  @colonne 10,60,30 prima della tabella (percentuali)
#   @firma Il/I Dichiarante/i      @firme Il dichiarante|Il progettista     @nota testo piccolo
#   @pagina   @spazio 4   @include _privacy   @per x in elenco ... @fine   @se cond ... @altrimenti ... @fine
# Nel testo: {percorso} campo compilato (anche {percorso:30} = 30 mm, {percorso:*} = resto della riga, {_:25} vuoto),
# [] o [?condizione] casella in linea, **grassetto**.
_LINE_CB = re.compile(r"^\[([\w.()\-]{0,24})(?:\?([^\]]*))?\]\s?(.*)$")
_INLINE = re.compile(r"\{([^{}]+)\}|\[(\?[^\]]*)?\]|\*\*(.+?)\*\*|(<br>)")


def _inline(text: str) -> list:
    """Testo -> elementi: ('w', parola, grassetto) / ('f', percorso, larghezza) / ('c', condizione)."""
    out = []
    pos = 0

    def words(s, bold=False):
        if s[:1].isspace() and out:
            if out[-1][0] in ("f", "c", "v"):
                out.append(("s",))
            elif out[-1][0] == "w" and not out[-1][1][-1:].isspace():
                out[-1] = ("w", out[-1][1] + " ", out[-1][2])
        for w in re.findall(r"\S+\s*", s):
            out.append(("w", w, bold))

    for m in _INLINE.finditer(text):
        before = text[pos:m.start()]
        if before:
            words(before)
        if m.group(1) is not None and m.group(1).startswith("="):
            out.append(("v", m.group(1)[1:].strip(), text[m.end():m.end() + 1].isspace()))
        elif m.group(1) is not None:
            spec = m.group(1).split(":")
            out.append(("f", spec[0].strip(), spec[1].strip() if len(spec) > 1 else ""))
        elif m.group(3) is not None:
            words(m.group(3), True)
        elif m.group(4):
            out.append(("br",))
        else:
            out.append(("c", (m.group(2) or "?")[1:]))
        pos = m.end()
    if pos < len(text):
        words(text[pos:])
    return out


def _load_tpl(name: str) -> str:
    p = TPL_DIR / name
    if not p.exists() and not name.endswith(".mbm"):
        p = TPL_DIR / (name + ".mbm")
    return p.read_text(encoding="utf-8")


def parse(text: str) -> tuple[dict, list]:
    """Modello -> (meta, blocchi)."""
    meta: dict = {}
    lines = []

    def add(src, depth=0):
        for raw in src.splitlines():
            s = raw.rstrip()
            if s.lstrip().startswith("@include "):
                if depth > 8:
                    raise ValueError("@include troppo annidati")
                add(_load_tpl(s.split(None, 1)[1].strip()), depth + 1)
            else:
                lines.append(s)

    add(text)
    # righe che continuano (terminano con "\") unite alla successiva
    joined, buf = [], ""
    for s in lines:
        if s.endswith("\\"):
            buf += s[:-1] + " "
            continue
        joined.append(buf + s)
        buf = ""
    if buf:
        joined.append(buf)
    stack = [[]]
    table = None
    cols = None
    for s in joined:
        st = s.strip()
        if not st.startswith("|"):
            table = None
        if not st or st.startswith("#") and not st.startswith("##") and not st.startswith("###"):
            continue
        cur = stack[-1]
        if st.startswith("@"):
            word, _, rest = st[1:].partition(" ")
            rest = rest.strip()
            if word == "meta":
                k, _, v = rest.partition(" ")
                meta[k] = v.strip()
            elif word == "per":
                m = re.match(r"(\w+)\s+in\s+([\w.]+)", rest)
                blk = ("loop", m.group(1), m.group(2), [])
                cur.append(blk)
                stack.append(blk[3])
            elif word == "se":
                blk = ["if", rest, [], []]
                cur.append(blk)
                stack.append(blk[2])
            elif word == "altrimenti":
                stack.pop()
                parent = stack[-1][-1]
                stack.append(parent[3])
            elif word == "fine":
                stack.pop()
            elif word == "colonne":
                cols = [float(x) for x in rest.split(",") if x.strip()]
            elif word in ("firma", "firme"):
                cur.append(("sign", [x.strip() for x in rest.split("|")]))
            elif word == "imposta":
                k, _, v = rest.partition(" ")
                cur.append(("set", k.strip(), v.strip()))
            elif word == "pagina":
                cur.append(("page",))
            elif word == "spazio":
                cur.append(("space", float(rest or 3)))
            elif word == "nota":
                cur.append(("note", _inline(rest), 0))
            continue
        level = 0
        while st.startswith(">"):
            level += 1
            st = st[1:].lstrip()
        if st.startswith("@nota "):
            cur.append(("note", _inline(st[6:].strip()), level))
            continue
        if st.startswith("|"):
            rcond = None
            if st.startswith("|?"):  # riga condizionata: |?condizione| cella | cella |
                end = st.index("|", 2)
                rcond, st = st[2:end].strip(), st[end:]
            header = st.startswith("|#")
            body = st[2:] if header else st[1:]
            cells = [c.strip() for c in _split_cells(body)]
            if table is None:
                table = ("table", cols, [], level)
                cols = None
                cur.append(table)
            table[2].append((header, [_cell(c) for c in cells], rcond))
            continue
        if st.startswith("###"):
            cur.append(("head", st[3:].strip()))
        elif st.startswith("##"):
            title, _, note = st[2:].partition("|")
            cur.append(("band", title.strip(), note.strip()))
        elif st.startswith("= "):
            cur.append(("title", st[2:].strip()))
        elif st.startswith("~ "):
            cur.append(("subtitle", st[2:].strip()))
        elif st.startswith("!!"):
            cur.append(("center", st[2:].strip()))
        elif st.startswith("{{") and st.endswith("}}"):
            spec = st[2:-2].split(":")
            cur.append(("multi", spec[0].strip(), int(spec[1]) if len(spec) > 1 and spec[1].strip().isdigit() else 3, level))
        else:
            m = _LINE_CB.match(st)
            if m and (m.group(1) or m.group(2) is not None or st.startswith("[]")):
                cur.append(("check", level, m.group(1) or "", m.group(2) or "", _inline(m.group(3))))
            else:
                cur.append(("para", level, _inline(st)))
    return meta, stack[0]


def _split_cells(body: str) -> list:
    """Celle di una riga di tabella: "|" separa le celle, ma non dentro [condizioni] o {campi}."""
    out, cur, depth = [], "", 0
    for ch in body:
        if ch in "[{":
            depth += 1
        elif ch in "]}":
            depth = max(0, depth - 1)
        if ch == "|" and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur)
    return out


def _cell(c: str) -> list:
    m = _LINE_CB.match(c)
    if c.startswith("[") and m and (m.group(1) == "" or m.group(2) is not None) and not m.group(3).strip():
        return [("c", m.group(2) or "")]
    return _inline(c)


def _expand(blocks: list, scope: dict) -> list:
    """Svolge @per / @se: restituisce blocchi semplici, ciascuno con lo scope in cui risolvere i campi."""
    out = []
    for b in blocks:
        if b[0] == "set":
            scope = dict(scope)
            scope[b[1]] = b[2]
            continue
        if b[0] == "loop":
            items = _get(scope, b[2]) or []
            for i, it in enumerate(items):
                sub = dict(scope)
                sub[b[1]] = it
                sub["_n"] = i + 1
                sub["_loop"] = scope.get("_loop", "") + f"{b[1]}{i + 1}_"
                out.extend(_expand(b[3], sub))
        elif b[0] == "if":
            out.extend(_expand(b[2] if _cond(b[1], scope) else b[3], scope))
        else:
            out.append((b, scope))
    return out


def _subst(tokens: list, scope: dict) -> list:
    """{=percorso}: il valore diventa testo normale (parole), non un campo."""
    if not any(tk[0] == "v" for tk in tokens):
        return tokens
    out = []
    for tk in tokens:
        if tk[0] != "v":
            out.append(tk)
            continue
        words = re.findall(r"\S+\s*", _value(tk[1], scope))
        for i, w in enumerate(words):
            out.append(("w", w if i < len(words) - 1 else w.rstrip() + (" " if tk[2] else ""), False))
    return out


def _txt(s: str, scope: dict) -> str:
    """{=percorso} nei titoli e nelle fasce."""
    return re.sub(r"\{=([^{}]+)\}", lambda m: _value(m.group(1).strip(), scope), s) if "{=" in s else s


def _value(path: str, scope: dict) -> str:
    if path == "_" or path.startswith("_:"):
        return ""
    if path == "_n":
        return str(scope.get("_n", ""))
    return _str(_get(scope, path))


# ------------------------------------------------------------------ PDF con campi (PyMuPDF)
MM = 72 / 25.4
PAGE_W, PAGE_H = 595.28, 841.89
ML, MR, MT, MB = 17 * MM, 17 * MM, 20 * MM, 17 * MM
FS = 8.6          # corpo del testo
LH = 11.6         # interlinea
INDENT = 14
CB = 7.6          # lato della casella
FIELD_FILL = (0.925, 0.945, 0.975)
INK = (0.08, 0.09, 0.1)
GREY = (0.42, 0.44, 0.47)
BAND = (0.23, 0.25, 0.27)


class _Fonts:
    """Arial di Windows (testo unicode: ≤, ≥, ✓...) con Helvetica di riserva."""

    def __init__(self):
        import pymupdf
        self._wcache = {}
        win = Path(r"C:\Windows\Fonts")
        self.files = {}
        for key, name in (("r", "arial.ttf"), ("b", "arialbd.ttf"), ("i", "ariali.ttf")):
            f = win / name
            if f.exists():
                self.files[key] = str(f)
        if len(self.files) == 3:
            self.font = {k: pymupdf.Font(fontfile=v) for k, v in self.files.items()}
            self.names = {"r": "mbr", "b": "mbb", "i": "mbi"}
        else:
            self.files = {}
            self.font = {"r": pymupdf.Font("helv"), "b": pymupdf.Font("hebo"), "i": pymupdf.Font("heit")}
            self.names = {"r": "helv", "b": "hebo", "i": "heit"}

    def w(self, text, size=FS, style="r"):
        key = (text, size, style)
        v = self._wcache.get(key)
        if v is None:
            v = self._wcache[key] = self.font[style].text_length(text, fontsize=size)
        return v

    def install(self, page):
        if self.files:
            for k, f in self.files.items():
                page.insert_font(fontname=self.names[k], fontfile=f)

    def safe(self, text):
        if self.files:
            return text
        return (text.replace("≤", "<=").replace("≥", ">=").replace("✓", "X").replace("☐", "[ ]"))


class _Pdf:
    def __init__(self, meta, fill_values=True):
        import pymupdf
        self.pm = pymupdf
        self.doc = pymupdf.open()
        self.f = _Fonts()
        self.meta = meta
        self.page = None
        self.widgets: dict[int, list] = {}  # pagina -> campi, aggiunti alla fine (vedi build)
        self.tw = {}
        self.y = 0
        self.names: dict[str, int] = {}
        self.fill_values = fill_values
        self.fields: list = []      # (nome, percorso, valore) per il collaudo
        self.checks: list = []
        self.new_page()

    # -- pagine
    def new_page(self):
        if self.page is not None:
            self.flush()
        self.page = self.doc.new_page(width=PAGE_W, height=PAGE_H)
        self.tw = {}  # colore -> TextWriter: un solo inserimento del testo per pagina (insert_text parola per parola e' lentissimo)
        self.shape = self.page.new_shape()
        self.y = MT

    def flush(self):
        self.shape.commit()  # prima riquadri e fasce, poi il testo sopra
        self.shape = self.page.new_shape()
        for color, tw in self.tw.items():
            tw.write_text(self.page, color=color)
        self.tw = {}

    def rect(self, r, color=None, fill=None, width=0.5):
        self.shape.draw_rect(r)
        self.shape.finish(color=color, fill=fill, width=width)

    def line(self, a, b, color=INK, width=0.5):
        self.shape.draw_line(a, b)
        self.shape.finish(color=color, width=width)

    def ensure(self, h):
        if self.y + h > PAGE_H - MB:
            self.new_page()

    def text(self, x, y, s, size=FS, style="r", color=INK):
        if s:
            tw = self.tw.get(color)
            if tw is None:
                tw = self.tw[color] = self.pm.TextWriter(self.page.rect)
            tw.append((x, y), self.f.safe(s), font=self.f.font[style], fontsize=size)

    def uname(self, base):
        base = re.sub(r"[^\w]+", "_", base).strip("_") or "campo"
        n = self.names.get(base, 0) + 1
        self.names[base] = n
        return base if n == 1 else f"{base}#{n}"  # "#": i codici dei quadri (X_1_2...) non lo contengono mai

    # -- widget
    def field(self, rect, name, value, multiline=False, path=""):
        w = self.pm.Widget()
        w.field_type = self.pm.PDF_WIDGET_TYPE_TEXT
        w.rect = rect
        w.field_name = self.uname(name)
        w.text_font = "Helv"
        size = FS
        if not multiline and value and self.f.w(value, FS) > rect.width - 3:
            size = 0  # adatta alla larghezza
        w.text_fontsize = size
        w.text_color = INK
        w.fill_color = FIELD_FILL
        w.border_width = 0
        if multiline:
            w.field_flags |= self.pm.PDF_TX_FIELD_IS_MULTILINE
        w.field_value = value if self.fill_values else ""
        self.widgets.setdefault(self.page.number, []).append(w)
        self.fields.append((w.field_name, path, value))

    def checkbox(self, x, base, name, on):
        w = self.pm.Widget()
        w.field_type = self.pm.PDF_WIDGET_TYPE_CHECKBOX
        w.rect = self.pm.Rect(x, base - CB + 0.6, x + CB, base + 0.6)
        w.field_name = self.uname(name)
        w.border_color = INK
        w.border_width = 0.6
        w.fill_color = (1, 1, 1)
        w.field_value = bool(on and self.fill_values)
        self.widgets.setdefault(self.page.number, []).append(w)
        self.checks.append((w.field_name, bool(on)))

    # -- testo con campi e caselle in linea
    def flow(self, tokens, scope, x0, width, size=FS, style="r", justify=True, prefix=""):
        """Impagina gli elementi da x0 su `width` punti (a capo automatico, campi e caselle in linea)."""
        lines = _layout(self.f, tokens, scope, width, size, style)
        if not lines:
            self.ensure(LH)
            self.y += LH
            return
        for li, line in enumerate(lines):
            self.ensure(LH)
            base = self.y + size + 0.4
            if not line:
                self.y += LH
                continue
            natural = sum(i[1] + i[3] for i in line) - line[-1][3]
            gaps = [k for k in range(len(line) - 1) if line[k][3] > 0]
            extra = 0
            if justify and li < len(lines) - 1 and gaps and natural < width and (width - natural) / len(gaps) < 4.5:
                extra = (width - natural) / len(gaps)
            x = x0
            for k, it in enumerate(line):
                if it[0] == "w":
                    self.text(x, base, it[2][0].rstrip(), size, it[2][1])
                elif it[0] == "c":
                    self.checkbox(x + 0.5, base, prefix + "casella", _cond(it[2], scope))
                else:
                    path, val = it[2]
                    r = self.pm.Rect(x, base - size - 0.2, x + it[1], base + 2.6)
                    self.field(r, prefix + (path if path != "_" else "campo"), val, path=path)
                x += it[1] + it[3] + (extra if k in gaps else 0)
            self.y += LH

    # -- blocchi
    def block(self, b, scope):
        kind = b[0]
        if kind in ("title", "subtitle", "band", "head", "center"):
            b = (b[0],) + tuple(_txt(x, scope) for x in b[1:])
        lp = scope.get("_loop", "")
        if kind == "title":
            self.ensure(30)
            self.y += 4
            s = self.f.safe(b[1].upper())
            size = 13.5 if self.f.w(s, 13.5, "b") <= PAGE_W - ML - MR else 12
            for ln in _wrap(self.f, s, PAGE_W - ML - MR, size, "b"):
                w = self.f.w(ln, size, "b")
                self.text((PAGE_W - w) / 2, self.y + size, ln, size, "b")
                self.y += size + 3.5
            self.y += 2
        elif kind == "subtitle":
            for ln in _wrap(self.f, b[1], PAGE_W - ML - MR - 40, 8.4, "i"):
                self.ensure(LH)
                w = self.f.w(ln, 8.4, "i")
                self.text((PAGE_W - w) / 2, self.y + 9, ln, 8.4, "i", GREY)
                self.y += 10.6
            self.y += 4
        elif kind == "band":
            self.ensure(34)
            self.y += 5
            r = self.pm.Rect(ML, self.y, PAGE_W - MR, self.y + 15)
            self.rect(r, color=None, fill=BAND, width=0)
            self.text(ML + 6, self.y + 10.6, b[1], 8.8, "b", (1, 1, 1))
            if b[2]:
                w = self.f.w(b[2], 7.2, "i")
                self.text(PAGE_W - MR - 6 - w, self.y + 10.4, b[2], 7.2, "i", (0.86, 0.87, 0.88))
            self.y += 20
        elif kind == "head":
            self.ensure(46)
            self.y += 5
            lines = _wrap(self.f, b[1], PAGE_W - ML - MR, 9.2, "b")
            for ln in lines:
                self.text(ML, self.y + 9.4, ln, 9.2, "b")
                self.y += 11.5
            self.line((ML, self.y + 0.5), (PAGE_W - MR, self.y + 0.5), color=(0.72, 0.74, 0.76), width=0.5)
            self.y += 4
        elif kind == "center":
            self.ensure(22)
            self.y += 3
            w = self.f.w(b[1], 10, "b")
            self.text((PAGE_W - w) / 2, self.y + 10, b[1], 10, "b")
            self.y += 16
        elif kind == "para":
            x0 = ML + b[1] * INDENT
            self.flow(b[2], scope, x0, PAGE_W - MR - x0, prefix=lp)
            self.y += 2.2
        elif kind == "note":
            x0 = ML + b[2] * INDENT + (CB + 23 if b[2] else 0)
            self.flow(b[1], scope, x0, PAGE_W - MR - x0, 7.4, "i", prefix=lp)
            self.y += 1.5
        elif kind == "check":
            level, code, cond, toks = b[1], b[2], b[3], b[4]
            x0 = ML + level * INDENT
            self.ensure(LH)
            base = self.y + FS + 0.4
            cw = 0
            if code:
                cw = max(self.f.w(code, 7.6, "b") + 4, 18 if len(code) < 5 else 0)
                self.text(x0, base, code, 7.6, "b", GREY)
            self.checkbox(x0 + cw, base, lp + (code or "casella"), _cond(cond, scope))
            tx = x0 + cw + CB + 5
            self.flow(toks, scope, tx, PAGE_W - MR - tx, prefix=lp)
            self.y += 1.6
        elif kind == "multi":
            path, n, level = b[1], b[2], b[3]
            x0 = ML + level * INDENT
            h = n * LH
            self.ensure(h + 2)
            r = self.pm.Rect(x0, self.y, PAGE_W - MR, self.y + h)
            self.field(r, lp + path, _value(path, scope), multiline=True, path=path)
            self.y += h + 4
        elif kind == "table":
            self.table(b, scope)
        elif kind == "sign":
            self.sign(b[1], scope)
        elif kind == "page":
            self.new_page()
        elif kind == "space":
            self.y += b[1] * MM

    def table(self, b, scope):
        cols, rows, level = b[1], b[2], b[3]
        x0 = ML + level * INDENT
        W = PAGE_W - MR - x0
        rows = [r for r in rows if r[2] is None or _cond(r[2], scope)]
        if not rows:
            return
        n = max(len(r[1]) for r in rows)
        if not cols or len(cols) != n:
            cols = [100 / n] * n
        tot = sum(cols)
        widths = [W * c / tot for c in cols]
        lp = scope.get("_loop", "")
        self.y += 2
        bold = lambda cell: [("w", tk[1], True) if tk[0] == "w" else tk for tk in cell]  # noqa: E731

        def row(header, cells):
            if header:
                cells = [bold(c) for c in cells]
            h = max(_measure(self.f, cell, widths[ci] - 6, scope) for ci, cell in enumerate(cells)) * LH + 5
            return cells, h

        def draw(header, cells, h):
            x = x0
            for ci in range(n):
                r = self.pm.Rect(x, self.y, x + widths[ci], self.y + h)
                self.rect(r, color=(0.62, 0.64, 0.67), fill=(0.9, 0.91, 0.92) if header else None, width=0.5)
                if ci < len(cells):
                    keep = self.y
                    self.y += 2.5
                    self.flow(cells[ci], scope, x + 3, widths[ci] - 6, justify=False, prefix=lp)
                    self.y = keep
                x += widths[ci]
            self.y += h

        heads = []  # righe d'intestazione iniziali: si ripetono in cima a ogni pagina nuova della tabella
        for i, (header, cells, _c) in enumerate(rows):
            cells, h = row(header, cells)
            if header and len(heads) == i:
                heads.append((cells, h))
            if self.y + h > PAGE_H - MB:
                self.new_page()
                if not header:
                    for hc, hh in heads:
                        draw(True, hc, hh)
            draw(header, cells, h)
        self.y += 4

    def sign(self, labels, scope):
        self.ensure(56)
        self.y += 8
        W = PAGE_W - ML - MR
        if len(labels) == 1:
            # Data e luogo a sinistra, firma a destra (come i moduli unificati)
            self.text(ML, self.y + 9, "Data e luogo", FS, "r", GREY)
            w = self.f.w(labels[0], FS)
            self.text(PAGE_W - MR - 60 * MM + (60 * MM - w) / 2, self.y + 9, labels[0], FS, "r", GREY)
            self.y += 13
            self.field(self.pm.Rect(ML, self.y, ML + 62 * MM, self.y + 13), scope.get("_loop", "") + "data_luogo", _value("luogo_data", scope), path="luogo_data")
            self.line((PAGE_W - MR - 60 * MM, self.y + 26), (PAGE_W - MR, self.y + 26), color=INK, width=0.6)
            self.y += 36
        else:
            colw = W / len(labels)
            self.text(ML, self.y + 9, "Data e luogo", FS, "r", GREY)
            self.y += 13
            self.field(self.pm.Rect(ML, self.y, ML + 62 * MM, self.y + 13), scope.get("_loop", "") + "data_luogo", _value("luogo_data", scope), path="luogo_data")
            self.y += 22
            for i, lab in enumerate(labels):
                cx = ML + i * colw
                w = self.f.w(lab, FS)
                self.text(cx + (colw - w) / 2, self.y + 9, lab, FS, "r", GREY)
                self.line((cx + 10, self.y + 34), (cx + colw - 10, self.y + 34), color=INK, width=0.6)
            self.y += 44

    def finish(self, title):
        self.flush()
        n = len(self.doc)
        for i, page in enumerate(self.doc):
            self.f.install(page)
            head = self.f.safe(title)
            page.insert_text((ML, 11 * MM), head, fontname=self.f.names["r"], fontsize=7, color=GREY)
            src = self.meta.get("fonte_breve", "")
            if src:
                w = self.f.w(src, 7)
                page.insert_text((PAGE_W - MR - w, 11 * MM), self.f.safe(src), fontname=self.f.names["r"], fontsize=7, color=GREY)
            page.draw_line((ML, 12.6 * MM), (PAGE_W - MR, 12.6 * MM), color=(0.8, 0.81, 0.83), width=0.4)
            foot = f"{i + 1} / {n}"
            w = self.f.w(foot, 7)
            page.insert_text(((PAGE_W - w) / 2, PAGE_H - 9 * MM), foot, fontname=self.f.names["r"], fontsize=7, color=GREY)
        self.doc.set_metadata({"title": title, "subject": self.meta.get("fonte", ""), "creator": "MB Visual", "producer": "MB Visual"})
        try:
            self.doc.subset_fonts()
        except Exception:  # noqa: BLE001
            pass


def _build_pages(self):
    """Documento finale. page.add_widget controlla l'unicita' del nome su tutto il modulo (tempo quadratico: 7 s per
    600 campi): i campi si mettono su pagine vuote, una per documento d'appoggio, che poi si uniscono; il contenuto
    di ogni pagina si posa sotto i campi come XObject (show_pdf_page: i caratteri restano uno solo per tutto il file)."""
    wdoc = self.pm.open()
    for i in range(len(self.doc)):
        tmp = self.pm.open()
        pg = tmp.new_page(width=PAGE_W, height=PAGE_H)
        for w in self.widgets.get(i, []):
            pg.add_widget(w)
        wdoc.insert_pdf(tmp)
        tmp.close()
    for i, page in enumerate(wdoc):
        page.show_pdf_page(page.rect, self.doc, i, overlay=False)
    wdoc.set_metadata(self.doc.metadata)
    return wdoc


_Pdf.build = _build_pages


def _wrap(fonts, text, width, size, style):
    out, line = [], ""
    for w in text.split():
        cand = (line + " " + w).strip()
        if line and fonts.w(cand, size, style) > width:
            out.append(line)
            line = w
        else:
            line = cand
    if line:
        out.append(line)
    return out or [""]


def _layout(fonts, tokens, scope, width, size=FS, style="r") -> list:
    """Righe di elementi (tipo, larghezza, dati, spazio dopo): la stessa regola per disegnare e per misurare."""
    tokens = _subst(tokens, scope)
    items = []
    for tk in tokens:
        if tk[0] == "w":
            st = "b" if tk[2] else style
            word = tk[1]
            items.append(("w", fonts.w(word.rstrip(), size, st), (word, st), fonts.w(" ", size, st) if word != word.rstrip() else 0))
        elif tk[0] == "s":
            if items:
                a = items[-1]
                items[-1] = (a[0], a[1], a[2], max(a[3], fonts.w(" ", size)))
        elif tk[0] == "c":
            items.append(("c", CB + 1, tk[1], 0))
        elif tk[0] == "br":
            items.append(("br", 0, None, 0))
        elif tk[0] == "f":
            path, wspec = tk[1], tk[2]
            val = _value(path, scope)
            if wspec == "*":
                wd = -1
            elif wspec.replace(".", "").isdigit():
                wd = float(wspec) * MM
            else:
                wd = max(28 * MM, fonts.w(val, FS) + 6)
            items.append(("f", wd, (path, val), 0))
    lines, line, used = [], [], 0.0
    closed = False  # riga appena chiusa da un campo "resto della riga": un <br> subito dopo non crea righe vuote
    for it in items:
        wd = it[1]
        if it[0] == "br":
            if not (closed and not line):
                lines.append(line)
            line, used, closed = [], 0.0, False
            continue
        closed = False
        if wd < 0:  # resto della riga
            if width - used < 30 * MM and line:
                lines.append(line)
                line, used = [], 0.0
            line.append((it[0], width - used, it[2], 0))
            lines.append(line)
            line, used, closed = [], 0.0, True
            continue
        if line and used + wd > width + 0.01:
            room = width - used
            if it[0] == "f" and room >= max(18 * MM, 0.6 * wd) and fonts.w(it[2][1], FS) + 4 <= room:
                wd = room  # campo un po' piu' stretto invece di una riga quasi vuota
            else:
                lines.append(line)
                line, used = [], 0.0
        wd = min(wd, width)
        line.append((it[0], wd, it[2], it[3]))
        used += wd + it[3]
    if line:
        lines.append(line)
    return lines


def _measure(fonts, tokens, width, scope) -> int:
    return max(1, len(_layout(fonts, tokens, scope, width)))


def render_pdf(tpl: str, anagrafica: dict, out: str | None = None, fill=True) -> dict:
    """Modello -> PDF con campi compilati. Restituisce {path, campi, caselle, pagine}."""
    meta, blocks = parse(_load_tpl(tpl))
    scope = contesto(anagrafica)
    pdf = _Pdf(meta, fill)
    for b, sc in _expand(blocks, scope):
        pdf.block(b, sc)
    title = meta.get("titolo", Path(tpl).stem)
    pdf.finish(title)
    doc = pdf.build()
    from .pdfedit import fix_tounicode
    fix_tounicode(doc)
    res = {"campi": pdf.fields, "caselle": pdf.checks, "pagine": len(doc)}
    if out:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        doc.save(out, garbage=3, deflate=True)
        res["path"] = out
    else:
        res["bytes"] = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    pdf.doc.close()
    return res


# ------------------------------------------------------------------ DOCX (python-docx): schemi a testo libero
def render_docx(tpl: str, anagrafica: dict, out: str) -> dict:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Mm, Pt, RGBColor
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement

    meta, blocks = parse(_load_tpl(tpl))
    scope = contesto(anagrafica)
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Mm(210), Mm(297)
    sec.left_margin = sec.right_margin = Mm(20)
    sec.top_margin = sec.bottom_margin = Mm(18)
    st = doc.styles["Normal"]
    st.font.name = "Arial"
    st.font.size = Pt(10)
    st.element.rPr.rFonts.set(qn("w:eastAsia"), "Arial")
    filled, empty = [], []

    def runs(p, tokens, sc, size=None, italic=False):
        for tk in _subst(tokens, sc):
            if tk[0] == "w":
                r = p.add_run(tk[1])
                r.bold = tk[2]
            elif tk[0] == "s":
                p.add_run(" ")
            elif tk[0] == "br":
                p.add_run().add_break()
            elif tk[0] == "c":
                p.add_run("☒" if _cond(tk[1], sc) else "☐")
            elif tk[0] == "f":
                v = _value(tk[1], sc)
                if v:
                    r = p.add_run(v)
                    filled.append(tk[1])
                else:
                    wd = tk[2]
                    n = 30 if wd == "*" else int(float(wd) / 2.2) if wd.replace(".", "").isdigit() else 18
                    r = p.add_run("_" * max(6, n))
                    empty.append(tk[1])
                continue
            else:
                continue
            if size:
                r.font.size = Pt(size)
            if italic:
                r.italic = True

    def shade(cell, hexcolor):
        tcPr = cell._tc.get_or_add_tcPr()
        s = OxmlElement("w:shd")
        s.set(qn("w:val"), "clear")
        s.set(qn("w:color"), "auto")
        s.set(qn("w:fill"), hexcolor)
        tcPr.append(s)

    for b, sc in _expand(blocks, scope):
        k = b[0]
        if k in ("title", "subtitle", "band", "head", "center"):
            b = (b[0],) + tuple(_txt(x, sc) for x in b[1:])
        if k == "title":
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            r = p.add_run(b[1].upper())
            r.bold = True
            r.font.size = Pt(14)
        elif k == "subtitle":
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            r = p.add_run(b[1])
            r.italic = True
            r.font.size = Pt(9)
        elif k == "band":
            tb = doc.add_table(rows=1, cols=1)
            c = tb.rows[0].cells[0]
            shade(c, "3A3F44")
            r = c.paragraphs[0].add_run(b[1] + (("   " + b[2]) if b[2] else ""))
            r.bold = True
            r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        elif k == "head":
            doc.add_heading(b[1], level=2)
        elif k == "center":
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            r = p.add_run(b[1])
            r.bold = True
        elif k in ("para", "check"):
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            p.paragraph_format.left_indent = Mm(6 * b[1])
            if k == "check":
                if b[2]:
                    r = p.add_run(b[2] + " ")
                    r.bold = True
                p.add_run(("☒" if _cond(b[3], sc) else "☐") + " ")
                runs(p, b[4], sc)
            else:
                runs(p, b[2], sc)
        elif k == "note":
            p = doc.add_paragraph()
            runs(p, b[1], sc, 8.5, True)
        elif k == "multi":
            v = _value(b[1], sc)
            if v:
                for ln in v.split("\n"):
                    doc.add_paragraph(ln)
                filled.append(b[1])
            else:
                for _ in range(max(1, b[2])):
                    doc.add_paragraph("_" * 86)
                empty.append(b[1])
        elif k == "table":
            rows = [r for r in b[2] if r[2] is None or _cond(r[2], sc)]
            if not rows:
                continue
            n = max(len(r[1]) for r in rows)
            tb = doc.add_table(rows=0, cols=n)
            tb.style = "Table Grid"
            for header, cells, _c in rows:
                rr = tb.add_row().cells
                for ci, cell in enumerate(cells):
                    p = rr[ci].paragraphs[0]
                    runs(p, [("w", tk[1], True) if header and tk[0] == "w" else tk for tk in cell], sc)
                    if header:
                        shade(rr[ci], "E6E8EA")
        elif k == "sign":
            doc.add_paragraph()
            tb = doc.add_table(rows=2, cols=max(2, len(b[1]) + (1 if len(b[1]) == 1 else 0)))
            tb.rows[0].cells[0].paragraphs[0].add_run("Data e luogo")
            tb.rows[1].cells[0].paragraphs[0].add_run(_value("luogo_data", sc) or "_" * 24)
            labs = b[1] if len(b[1]) > 1 else [""] + b[1]
            for i, lab in enumerate(labs):
                if i == 0 and len(b[1]) == 1:
                    continue
                c = tb.rows[0].cells[i if len(b[1]) == 1 else i]
                c.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
                c.paragraphs[0].add_run(lab)
                tb.rows[1].cells[i].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
                tb.rows[1].cells[i].paragraphs[0].add_run("\n" + "_" * 28)
        elif k == "page":
            doc.add_page_break()
        elif k == "space":
            doc.add_paragraph()
    cp = doc.core_properties
    cp.title = meta.get("titolo", "")
    cp.subject = meta.get("fonte", "")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    doc.save(out)
    return {"path": out, "compilati": filled, "vuoti": empty}


# ------------------------------------------------------------------ generazione nella cartella di commessa
def _safe_name(s: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "-", s).strip(" .-") or "modulo"


def elenco() -> list:
    out = []
    for mid, tpl, kind, name in MODULI:
        try:
            meta, _ = parse(_load_tpl(tpl))
        except Exception:  # noqa: BLE001
            meta = {}
        out.append({"id": mid, "tipo": kind, "nome": meta.get("titolo", name), "file": name,
                    "descrizione": meta.get("descrizione", ""), "fonte": meta.get("fonte", ""), "gruppo": meta.get("gruppo", "")})
    return out


def output_dir(mbcomm: str) -> Path:
    p = Path(mbcomm)
    return p.parent / (_safe_name(p.stem) + " - moduli")


def genera(mbcomm: str, ids: list, sovrascrivi: bool = False, anagrafica: dict | None = None, update=None) -> dict:
    """Genera i moduli scelti nella cartella "<commessa> - moduli" accanto al file .mbcomm."""
    a = normalizza(anagrafica) if anagrafica is not None else leggi(mbcomm)
    out_dir = output_dir(mbcomm)
    out_dir.mkdir(parents=True, exist_ok=True)
    byid = {m[0]: m for m in MODULI}
    done, errors = [], []
    pref = _safe_name(a["commessa"].get("codice") or "")
    for i, mid in enumerate(ids):
        m = byid.get(mid)
        if not m:
            continue
        if update:
            update(i / max(1, len(ids)), t("srv_edilizia.genero", m[3]))
        name = (pref + " - " if pref else "") + _safe_name(m[3]) + "." + m[2]
        target = out_dir / name
        if target.exists() and not sovrascrivi:
            n = 2
            while (out_dir / f"{target.stem} ({n}){target.suffix}").exists():
                n += 1
            target = out_dir / f"{target.stem} ({n}){target.suffix}"
        try:
            if m[2] == "pdf":
                r = render_pdf(m[1], a, str(target))
                done.append({"id": mid, "path": str(target), "campi": len(r["campi"]),
                             "compilati": sum(1 for x in r["campi"] if x[2]), "pagine": r["pagine"]})
            else:
                r = render_docx(m[1], a, str(target))
                done.append({"id": mid, "path": str(target), "campi": len(r["compilati"]) + len(r["vuoti"]),
                             "compilati": len(r["compilati"])})
        except PermissionError:
            errors.append({"id": mid, "errore": t("srv_edilizia.file_aperto", target.name)})
        except Exception as e:  # noqa: BLE001
            errors.append({"id": mid, "errore": str(e)})
    # elenco dei generati nell'anagrafica (per il pannello)
    try:
        cur = leggi(mbcomm) if anagrafica is None else a
        gen = [g for g in cur.get("generati", []) if Path(g.get("path", "")).exists()]
        stamp = datetime.now().isoformat(timespec="seconds")
        for d in done:
            gen = [g for g in gen if g.get("path") != d["path"]]
            gen.append({"id": d["id"], "path": d["path"], "data": stamp})
        cur["generati"] = gen
        if Path(mbcomm).exists():
            scrivi(mbcomm, cur)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "cartella": str(out_dir), "generati": done, "errori": errors}


# ------------------------------------------------------------------ fascicolo PDF unico
def _docx_pdf(src: str, update=None) -> str:
    """DOCX -> PDF: Word/LibreOffice (convert.py), altrimenti impaginazione semplice del testo con PyMuPDF."""
    from .paths import TEMP_DIR
    import hashlib
    st = Path(src).stat()
    key = hashlib.sha1(f"{src}|{st.st_size}|{st.st_mtime}".encode()).hexdigest()[:16]
    out = TEMP_DIR / "edilizia" / f"{key}.pdf"
    if out.exists():
        return str(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        from . import convert
        convert.convert(src, str(out))
        if out.exists() and out.stat().st_size:
            return str(out)
    except Exception:  # noqa: BLE001
        pass
    import pymupdf
    from docx import Document
    d = Document(src)
    html = []
    esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")  # noqa: E731
    body = d.element.body
    for el in body.iterchildren():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag == "p":
            txt = "".join(n.text or "" for n in el.iter() if n.tag.endswith("}t"))
            html.append(f"<p>{esc(txt)}</p>" if txt.strip() else "<p>&nbsp;</p>")
        elif tag == "tbl":
            rows = []
            for tr in el.iter():
                if tr.tag.endswith("}tr"):
                    cells = []
                    for tc in tr:
                        if tc.tag.endswith("}tc"):
                            cells.append(esc(" ".join((n.text or "") for n in tc.iter() if n.tag.endswith("}t"))))
                    rows.append("<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>")
            html.append("<table>" + "".join(rows) + "</table>")
    css = "body{font-family:sans-serif;font-size:10pt} p{margin:0 0 4pt 0;text-align:justify} table{border-collapse:collapse;width:100%} td{border:0.5pt solid #999;padding:3pt;font-size:9pt}"
    story = pymupdf.Story("<html><body>" + "".join(html) + "</body></html>", user_css=css)
    writer = pymupdf.DocumentWriter(str(out))
    rect = pymupdf.paper_rect("a4")
    where = rect + (57, 51, -57, -51)
    more = True
    while more:
        dev = writer.begin_page(rect)
        more, _ = story.place(where)
        story.draw(dev)
        writer.end_page()
    writer.close()
    return str(out)


def fascicolo(files: list, out: str, titolo: str = "", anagrafica: dict | None = None, appiattisci: bool = True, update=None) -> dict:
    """Unisce i documenti in un PDF con frontespizio, indice (numeri di pagina) e segnalibri."""
    import pymupdf
    parts = []  # (titolo, documento)
    total = len(files)
    for i, f in enumerate(files):
        if update:
            update(i / max(1, total) * 0.8, t("srv_edilizia.preparo", Path(f).name))
        ext = Path(f).suffix.lower()
        src = f
        if ext in (".docx", ".doc", ".odt", ".rtf"):
            src = _docx_pdf(f)
        elif ext == ".p7m":
            from . import signed
            inner = signed.open_signed(f) if hasattr(signed, "open_signed") else None
            src = inner.get("path") if isinstance(inner, dict) else None
            if not src or not str(src).lower().endswith(".pdf"):
                raise RuntimeError(t("srv_edilizia.p7m_non_pdf", Path(f).name))
        elif ext != ".pdf":
            raise RuntimeError(t("srv_edilizia.formato_non_ammesso", Path(f).name))
        d = pymupdf.open(src)
        if d.needs_pass:
            raise RuntimeError(t("srv_edilizia.protetto", Path(f).name))
        if appiattisci:
            try:
                d.bake()
            except Exception:  # noqa: BLE001
                pass
        parts.append((Path(f).stem, d, Path(f).name))
    fonts = _Fonts()
    # frontespizio + indice: righe da 16 pt, 40 per pagina dopo la prima
    per_first, per_next = 28, 44
    n_front = 1 if len(parts) <= per_first else 1 + -(-(len(parts) - per_first) // per_next)
    out_doc = pymupdf.open()  # prima solo frontespizio e indice (ToUnicode corretta), poi i documenti
    links = []  # (pagina dell'indice, rettangolo della riga, documento)
    pages_start = []
    cur = n_front
    for _, d, _ in parts:
        pages_start.append(cur)
        cur += len(d)
    sc = contesto(anagrafica or {})
    title = titolo or t("srv_edilizia.fascicolo")
    for p in range(n_front):
        page = out_doc.new_page(width=PAGE_W, height=PAGE_H)
        fonts.install(page)
        y = MT + 10
        if p == 0:
            page.insert_text((ML, y + 18), fonts.safe(title), fontname=fonts.names["b"], fontsize=18, color=INK)
            y += 34
            info = [x for x in (sc["commessa"].get("codice"), sc["commessa"].get("nome")) if x]
            lines = [" - ".join(info)] if info else []
            if sc["tit"]["cognome_nome"]:
                lines.append("Committente: " + ", ".join(x["cognome_nome"] for x in sc["titolari"] if x["cognome_nome"]))
            if sc["imm"]["indirizzo"] or sc["imm"]["comune"]:
                lines.append("Immobile: " + ", ".join(x for x in (sc["imm"]["indirizzo"], sc["imm"]["comune"]) if x))
            if sc["imm"]["catastali"]:
                lines.append("Catasto " + sc["imm"].get("catasto", "") + ": " + sc["imm"]["catastali"])
            if sc["prog"].get("cognome_nome"):
                lines.append("Progettista: " + sc["prog"]["cognome_nome"])
            lines.append(sc["oggi"])
            for ln in lines:
                page.insert_text((ML, y), fonts.safe(ln), fontname=fonts.names["r"], fontsize=10, color=GREY)
                y += 14
            y += 16
            page.insert_text((ML, y), "Indice", fontname=fonts.names["b"], fontsize=12, color=INK)
            y += 8
            page.draw_line((ML, y), (PAGE_W - MR, y), color=(0.7, 0.71, 0.73), width=0.6)
            y += 14
            rng = range(0, min(per_first, len(parts)))
        else:
            start = per_first + (p - 1) * per_next
            rng = range(start, min(start + per_next, len(parts)))
        for k in rng:
            name = parts[k][0]
            num = str(pages_start[k] + 1)
            label = f"{k + 1}. {name}"
            maxw = PAGE_W - ML - MR - 40
            while fonts.w(label, 10) > maxw and len(label) > 8:
                label = label[:-2]
            page.insert_text((ML, y), fonts.safe(label), fontname=fonts.names["r"], fontsize=10, color=INK)
            links.append((p, pymupdf.Rect(ML, y - 11, PAGE_W - MR, y + 4), k))
            nw = fonts.w(num, 10)
            page.insert_text((PAGE_W - MR - nw, y), num, fontname=fonts.names["r"], fontsize=10, color=INK)
            lw = fonts.w(label, 10)
            dots_x0, dots_x1 = ML + lw + 6, PAGE_W - MR - nw - 6
            if dots_x1 > dots_x0:
                page.draw_line((dots_x0, y - 1), (dots_x1, y - 1), color=(0.75, 0.76, 0.78), width=0.5, dashes="[1 2] 0")
            y += 16
    from .pdfedit import fix_tounicode
    fix_tounicode(out_doc)
    toc = [[1, title, 1]]
    for k, (name, d, fname) in enumerate(parts):
        if update:
            update(0.8 + 0.18 * k / max(1, len(parts)), t("srv_edilizia.unisco", fname))
        out_doc.insert_pdf(d)
        toc.append([1, name, pages_start[k] + 1])
        for lvl, tt, pg, *_ in d.get_toc(simple=False):
            if 1 <= pg <= len(d):
                toc.append([min(lvl + 1, 6), tt, pages_start[k] + pg])
        d.close()
    # collegamenti dell'indice: solo ora le pagine di destinazione esistono
    for p, r, k in links:
        out_doc[p].insert_link({"kind": pymupdf.LINK_GOTO, "page": pages_start[k], "from": r, "to": pymupdf.Point(0, 0)})
    # numerazione nel piede (tutte le pagine dopo il frontespizio)
    N = len(out_doc)
    for i in range(n_front, N):
        page = out_doc[i]
        lab = f"{i + 1} / {N}"
        w = fonts.w(lab, 7)
        r = page.rect
        page.insert_text(((r.width - w) / 2, r.height - 5 * MM), lab, fontname="helv", fontsize=7, color=GREY)
    out_doc.set_toc(toc)
    out_doc.set_metadata({"title": title, "creator": "MB Visual", "producer": "MB Visual"})
    try:
        out_doc.subset_fonts()
    except Exception:  # noqa: BLE001
        pass
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    out_doc.save(out, garbage=3, deflate=True)
    res = {"ok": True, "path": out, "pagine": N, "documenti": [{"nome": p[2], "pagina": pages_start[i] + 1} for i, p in enumerate(parts)]}
    out_doc.close()
    return res


# ------------------------------------------------------------------ visura catastale (PDF dell'Agenzia delle Entrate)
_CF = r"[A-Z]{6}\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z]"


def _cf_code(s: str, nome: bool) -> str:
    """Tre lettere del codice fiscale per cognome (nome=False) o nome (nome=True)."""
    s = re.sub(r"[^A-Z]", "", s.upper().replace("À", "A").replace("È", "E").replace("É", "E").replace("Ì", "I").replace("Ò", "O").replace("Ù", "U"))
    cons = [c for c in s if c not in "AEIOU"]
    voc = [c for c in s if c in "AEIOU"]
    if nome and len(cons) >= 4:
        cons = [cons[0], cons[2], cons[3]]
    return ("".join(cons + voc) + "XXX")[:3]


def _split_name(full: str, cf: str) -> tuple[str, str]:
    """"ROSSI DE LUCA MARIA" -> (cognome, nome): la divisione che torna con le prime 6 lettere del codice fiscale."""
    words = full.split()
    if len(words) < 2:
        return full.title(), ""
    for k in range(1, len(words)):
        cog, nom = " ".join(words[:k]), " ".join(words[k:])
        if cf[:3] == _cf_code(cog, False) and cf[3:6] == _cf_code(nom, True):
            return cog.title(), nom.title()
    return words[0].title(), " ".join(words[1:]).title()


def visura(path: str) -> dict:
    """Dati dell'immobile e intestati letti dal testo di una visura catastale per immobile (PDF con testo,
    Agenzia delle Entrate - Servizi catastali). Restituisce {immobile, intestati, unita}."""
    import pymupdf
    with pymupdf.open(path) as d:
        text = "\n".join(p.get_text() for p in d)
    if len(text.strip()) < 40:
        raise RuntimeError(t("srv_edilizia.visura_senza_testo"))
    one = re.sub(r"\s+", " ", text.replace("\xa0", " ").replace("\xad", "-"))
    r: dict = {"immobile": {}, "intestati": [], "unita": []}
    imm = r["immobile"]
    m = re.search(r"Comune di\s+([A-ZÀ-Ü' .\-]+?)\s*\(\s*Codice:?\s*([A-Z]\d{3})\s*\)", one, re.I)
    if m:
        imm["comune"] = m.group(1).strip().title()
        imm["codice_comune"] = m.group(2).upper()
    m = re.search(r"Provincia di\s+([A-ZÀ-Ü'\-]+(?: [A-ZÀ-Ü'\-]+)*?)(?= Catasto| Foglio| Comune| Sezione| INTESTAT| Dati|$)", one)
    if m:
        imm["provincia"] = m.group(1).strip().title()
    fab, ter = re.search(r"Catasto\s+(?:dei\s+)?Fabbricati", one, re.I), re.search(r"Catasto\s+(?:dei\s+)?Terreni", one, re.I)
    if fab or ter:
        imm["catasto"] = "fabbricati" if fab and (not ter or fab.start() < ter.start()) else "terreni"
    m = re.search(r"Foglio:?\s*(\d+)\s+Particella:?\s*(\d+)(?:\s+Sub(?:alterno)?\.?:?\s*(\d+))?", one, re.I)
    if m:
        imm["foglio"], imm["particella"] = m.group(1), m.group(2)
        if m.group(3):
            imm["subalterno"] = m.group(3)
    m = re.search(r"Sez(?:ione)?\.?\s*(?:Urbana)?:?\s*([A-Z0-9]{1,3})\s+Foglio", one)
    if m:
        imm["sez_urbana"] = m.group(1)
    # riga dell'unita' immobiliare: ... foglio particella sub [zona] [microzona] categoria classe consistenza
    if imm.get("foglio") and imm.get("particella"):
        pat = r"\b%s\s+%s\s+%s\b(.{0,160})" % (imm["foglio"], imm["particella"], imm.get("subalterno") or r"\d*")
        m = re.search(pat, one)
        tail = m.group(1) if m else one
    else:
        tail = one
    m = re.search(r"\b([A-F])\s*/\s*(\d{1,2})\b(?:\s+(\d{1,2}|U)\b)?(?:\s+([\d.,]+\s*(?:vani|m²|m2|mq|metri quadri)))?", tail)
    if m:
        imm["categoria"] = f"{m.group(1)}/{m.group(2)}"
        if m.group(3):
            imm["classe"] = m.group(3)
        if m.group(4):
            imm["consistenza"] = m.group(4).replace("m2", "m²")
    if not imm.get("consistenza"):
        m = re.search(r"Consistenza:?\s*([\d.,]+\s*(?:vani|m²|m2|mq))", one, re.I) or re.search(r"\b(\d+(?:,\d)?\s*vani)\b", one)
        if m:
            imm["consistenza"] = m.group(1)
    m = re.search(r"Rendita:?\s*(?:Euro|€)\s*([\d.]+,\d{2})", one, re.I) or re.search(r"(?:Euro|€)\s*([\d.]+,\d{2})", one)
    if m and imm.get("catasto") != "terreni":  # nei terreni gli importi sono redditi dominicale e agrario
        imm["rendita"] = m.group(1)
    m = re.search(r"Superficie(?:\s+catastale)?:?\s*(?:Totale:?\s*)?([\d.,]+)\s*m", one, re.I) or re.search(r"Totale:\s*([\d.,]+)\s*m", one)
    if m:
        imm["superficie"] = m.group(1)
    m = re.search(r"Indirizzo:?\s+(.{3,80}?)(?:\s+n\.\s*([\dA-Z/]+))?(?=\s+(?:Piano|Scala|Interno|Edificio|Partita|Annotazioni|Mappali|Dati|n\.|$))", one, re.I)
    if m:
        imm["via"] = m.group(1).strip(" ,").title()
        if m.group(2):
            imm["civico"] = m.group(2)
    m = re.search(r"\bPiano\s+((?:S\d|T|\d+)(?:\s*-\s*(?:S\d|T|\d+))*)\b", one)
    if m:
        imm["piano"] = m.group(1).replace(" ", "")
    m = re.search(r"\bInterno\s+(\w+)", one)
    if m:
        imm["interno"] = m.group(1)
    m = re.search(r"\bScala\s+([A-Z0-9]{1,3})\b", one)
    if m:
        imm["scala"] = m.group(1)
    # intestati: "COGNOME NOME nato/a a LUOGO (PR) il gg/mm/aaaa CODICEFISCALE* (1) Proprieta' 1/1"
    seen = set()
    for mm in re.finditer(r"(?:\b\d{1,2}\s+)?([A-ZÀ-Ü'][A-ZÀ-Üa-zà-ü' ]+?)\s+nat[oa]\s+a\s+([A-ZÀ-Ü' .\-]+?)\s*(?:\((\w{2})\))?\s+il\s+(\d{2}/\d{2}/\d{4})\s+(" + _CF + r")\*?\s*(?:\(\d+\)\s*)?((?:Propriet|Usufrutt|Nuda|Abitazion|Superfic|Enfiteus|Comproprietar)[A-Za-zà-ü' ]*?(?:\s+per\s+\d+/\d+|\s+\d+/\d+)?)?(?=\s|$)", one):
        cf = mm.group(5)
        if cf in seen:
            continue
        seen.add(cf)
        full = re.sub(r"^(?:INTESTATI?|Intestati?|\d+)\s+", "", mm.group(1).strip())
        cog, nom = _split_name(full, cf)
        d_, m_, y_ = mm.group(4).split("/")
        diritto = (mm.group(6) or "").strip()
        quota = (re.search(r"(\d+/\d+)", diritto) or [None, ""])[1]
        low = diritto.lower()
        titolo = ("usufruttuario" if low.startswith("usufrutt") else "nudo proprietario" if low.startswith("nuda")
                  else "titolare del diritto di abitazione" if low.startswith("abitazion") else "superficiario" if low.startswith("superfic")
                  else ("proprietario" if quota in ("", "1/1") else "comproprietario") if low.startswith(("propriet", "comproprietar")) else low)
        r["intestati"].append({"cognome": cog, "nome": nom, "nato_a": mm.group(2).strip().title(), "nato_prov": (mm.group(3) or "").upper(),
                               "nato_il": f"{y_}-{m_}-{d_}", "cf": cf, "titolo": titolo, "quota": quota, "diritto": diritto})
    # societa' intestatarie: "RAGIONE SOCIALE con sede in LUOGO (PR) 01234567890"
    for mm in re.finditer(r"([A-Z0-9][A-Z0-9&'. \-]+?(?:S\.?R\.?L\.?|S\.?P\.?A\.?|S\.?N\.?C\.?|S\.?A\.?S\.?|SOCIETA'[A-Z' ]*))\s+con sede in\s+([A-Z' .\-]+?)\s*(?:\((\w{2})\))?\s+(\d{11})", one):
        if mm.group(4) in seen:
            continue
        seen.add(mm.group(4))
        r["intestati"].append({"tipo": "societa", "cognome": "", "nome": "", "cf": mm.group(4),
                               "ditta": {"ragione": re.sub(r"^(?:.*?\bINTESTAT[OI]\b\s*)?(?:\d+\s+)*", "", mm.group(1).strip()), "cf_piva": mm.group(4), "sede_comune": mm.group(2).strip().title(),
                                         "sede_prov": (mm.group(3) or "").upper()}})
    if not imm.get("foglio") and not r["intestati"]:
        raise RuntimeError(t("srv_edilizia.visura_non_riconosciuta"))
    return r


# ------------------------------------------------------------------ API (server.py: /api/pratica?op=...)
def handle(op: str, b: dict, start_job) -> dict:
    if op == "moduli":
        return {"ok": True, "moduli": elenco(), "regioni": [{"codice": c, "nome": n, "atto": a} for c, n, a in REGIONI]}
    if op == "nuova":
        return {"ok": True, "anagrafica": nuova()}
    if op == "leggi":
        return {"ok": True, "anagrafica": leggi(b["path"]), "cartella": str(output_dir(b["path"]))}
    if op == "scrivi":
        return {"ok": True, "anagrafica": scrivi(b["path"], b["anagrafica"])}
    if op == "genera":
        return {"ok": True, "job": start_job(genera, b["path"], list(b.get("moduli") or []), bool(b.get("sovrascrivi")), b.get("anagrafica"))}
    if op == "fascicolo":
        return {"ok": True, "job": start_job(fascicolo, list(b["files"]), b["out"], b.get("titolo", ""), b.get("anagrafica"), bool(b.get("appiattisci", True)))}
    if op == "visura":
        return {"ok": True, **visura(b["path"])}
    if op == "file":
        # file della cartella moduli (per il fascicolo): PDF, DOCX e p7m, in ordine di nome
        d = Path(b["cartella"])
        items = []
        if d.is_dir():
            def rank(f):  # prima i moduli nell'ordine dell'elenco, poi gli altri file (elaborati...) per nome
                stem = f.name.lower()
                pos = [i for i, m in enumerate(MODULI) if stem.endswith(" - " + _safe_name(m[3]).lower() + f.suffix.lower())
                       or stem == _safe_name(m[3]).lower() + f.suffix.lower()]
                return (pos[0] if pos else len(MODULI), stem)
            for f in sorted(d.iterdir(), key=rank):
                if f.is_file() and f.suffix.lower() in (".pdf", ".docx", ".p7m") and not f.name.startswith("~$"):
                    st = f.stat()
                    items.append({"path": str(f), "nome": f.name, "size": st.st_size, "modificato": st.st_mtime,
                                  "firmato": f.suffix.lower() == ".p7m" or (f.suffix.lower() == ".pdf" and _signed(f))})
        return {"ok": True, "file": items}
    raise ValueError(t("srv_edilizia.operazione_sconosciuta", op))


def _signed(path: Path) -> bool:
    try:
        import pymupdf
        with pymupdf.open(str(path)) as d:
            return d.get_sigflags() > 0
    except Exception:  # noqa: BLE001
        return False


__all__ = ["nuova", "leggi", "scrivi", "contesto", "parse", "render_pdf", "render_docx", "genera", "fascicolo", "visura", "handle",
           "MODULI", "REGIONI"]
