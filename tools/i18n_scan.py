"""Traduzioni: trova nei sorgenti i testi italiani dell'interfaccia non ancora passati da t().

Uso:
  python tools/i18n_scan.py ui/js/app.js              -> elenco dei testi candidati (riga, testo)
  python tools/i18n_scan.py ui/js/app.js --plan p.tsv -> piano modificabile: id, riga, chiave proposta, testo
  python tools/i18n_scan.py --apply p.tsv             -> sostituisce i testi del piano con t("chiave", ...)
                                                         e aggiunge le chiavi a ui/i18n/it.json
  python tools/i18n_scan.py --count ui/js             -> quanti testi restano per file

Nel piano si cancellano (o si commentano con #) le righe da lasciare come sono; la chiave si puo' cambiare.
I template `...${x}...` diventano t("chiave", x) con {0}, {1}... nel testo.
Per i file Python (.py) il testo diventa t("chiave", x) importato da mbvisual.i18n.
"""
from __future__ import annotations

import io
import json
import re
import sys
import tokenize
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
I18N = ROOT / "ui" / "i18n"

# ------------------------------------------------------------------ lettura dei letterali JS
PUNCT_BEFORE_REGEX = set("(,=:[!&|?{};+-*%<>~^")
KW_BEFORE_REGEX = {"return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"}


def js_literals(src: str):
    """Restituisce (inizio, fine, tipo, parti, espressioni) per ogni stringa/template di primo livello e annidati."""
    out = []
    i, n = 0, len(src)
    last = ""  # ultimo segno significativo (per distinguere / divisione da regex)
    stack = []  # per i template: profondita' delle graffe dentro ${ }

    def read_string(i, q):
        j = i + 1
        buf = []
        while j < n:
            c = src[j]
            if c == "\\":
                buf.append(src[j:j + 2])
                j += 2
                continue
            if c == q:
                return j + 1, "".join(buf)
            if c == "\n":
                return j, "".join(buf)
            buf.append(c)
            j += 1
        return j, "".join(buf)

    def read_template(i):
        # restituisce fine, parti statiche, espressioni (testo sorgente) e i letterali annidati trovati
        j = i + 1
        parts, exprs, buf = [], [], []
        while j < n:
            c = src[j]
            if c == "\\":
                buf.append(src[j:j + 2])
                j += 2
                continue
            if c == "`":
                parts.append("".join(buf))
                return j + 1, parts, exprs
            if c == "$" and j + 1 < n and src[j + 1] == "{":
                parts.append("".join(buf))
                buf = []
                k = j + 2
                depth = 1
                start = k
                while k < n and depth:
                    d = src[k]
                    if d in "'\"":
                        k2, _ = read_string(k, d)
                        nested.append((k, k2))
                        k = k2
                        continue
                    if d == "`":
                        k2, _, _ = read_template(k)
                        nested.append((k, k2))
                        k = k2
                        continue
                    if d == "{":
                        depth += 1
                    elif d == "}":
                        depth -= 1
                        if not depth:
                            break
                    k += 1
                exprs.append((src[start:k], start))  # testo e posizione nel file
                j = k + 1
                continue
            buf.append(c)
            j += 1
        parts.append("".join(buf))
        return j, parts, exprs

    nested: list = []
    while i < n:
        c = src[i]
        if c in " \t\r\n":
            i += 1
            continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "'\"":
            j, s = read_string(i, c)
            out.append((i, j, c, [s], []))
            i = j
            last = "str"
            continue
        if c == "`":
            nested.clear()
            j, parts, exprs = read_template(i)
            out.append((i, j, "`", parts, exprs))
            for a, b in list(nested):
                # letterali dentro ${}: rianalizzati a parte
                sub = js_literals(src[a:b])
                for (x, y, q, p, e) in sub:
                    out.append((a + x, a + y, q, p, [(et, a + es) for et, es in e]))
            i = j
            last = "str"
            continue
        if c == "/" and (last in PUNCT_BEFORE_REGEX or last in KW_BEFORE_REGEX or last == ""):
            # regex
            j = i + 1
            cls = False
            while j < n and src[j] != "\n":
                d = src[j]
                if d == "\\":
                    j += 2
                    continue
                if d == "[":
                    cls = True
                elif d == "]":
                    cls = False
                elif d == "/" and not cls:
                    break
                j += 1
            j += 1
            while j < n and src[j].isalpha():
                j += 1
            i = j
            last = "re"
            continue
        if c.isalnum() or c in "_$":
            j = i
            while j < n and (src[j].isalnum() or src[j] in "_$"):
                j += 1
            last = src[i:j]
            i = j
            continue
        last = c if c not in ")]" else "id"
        i += 1
    return out


# ------------------------------------------------------------------ riconoscimento dei testi dell'interfaccia
IT_WORDS = set("""il lo la le gli un una uno di del della dei delle degli da dal dalla dai con per su sul sulla nel nella nei non e' è
che si ci se o oppure come anche solo tutto tutti tutte questo questa quello file cartella apri aperto salva salvato chiudi
nuovo nuova errore impossibile caricamento attendere annulla elimina modifica scegli seleziona copia incolla taglia
inserisci pagina pagine testo immagine livello livelli colore larghezza altezza dimensione sinistra destra sopra sotto
nessun nessuna nessuno trovato trovata disponibile riuscito riuscita conferma rinomina sposta ruota ingrandisci riduci
mostra nascondi tutto cerca sostituisci stampa esporta importa aggiungi rimuovi pronto in corso e i altri altre
presente gratuito nota note foto disegno disegni nessuno sempre mai prima dopo ancora gia' piu' meno molto poco ogni
qui li' dove quando perche' mentre senza contro fra tra verso fino sopra dentro fuori""".split())
NOT_UI = re.compile(r"^(?:[#.]?[a-z][\w-]*|[\w./-]+\.(?:js|css|json|png|svg|html|wasm|py|mjs)|https?://\S+|data:.*|blob:.*|[\w-]+/[\w.+-]+)$")
CSS_LIKE = re.compile(r"(var\(--|\d(px|em|rem|vh|vw|%)\b|rgba?\(|#[0-9a-f]{3,8}\b|;\s*[a-z-]+\s*:|^[a-z-]+\s*:\s*\S)", re.I)


def is_ui_text(s: str) -> bool:
    t = s.strip()
    if len(t) < 2 or not re.search(r"[A-Za-zÀ-ÿ]{2}", t):
        return False
    if NOT_UI.match(t):
        return False
    if CSS_LIKE.search(t) and not re.search(r"[a-zà-ù]{3,} [a-zà-ù]{3,}", t) and not (" " in t and any(w in IT_WORDS for w in re.findall(r"[a-zà-ù']+", t.lower()))):
        return False
    if re.fullmatch(r"[A-Z0-9_]+", t) or re.fullmatch(r"[a-z]+[A-Z]\w*", t):  # COSTANTI, camelCase
        return False
    if re.fullmatch(r"(Ctrl|Alt|Shift|Maiusc|F\d+|Esc|Enter|Delete|Space|Tab|Arrow\w+|[A-Z])([+|][\w\[\]+-]+)*", t):
        return False
    words = re.findall(r"[a-zà-ù']+", t.lower())
    if any(w in IT_WORDS for w in words):
        return True
    if re.search(r"[àèéìòù]|\w'", t):
        return True
    if re.fullmatch(r"[a-z0-9_]+(?:\.[\w-]+)+", t):  # chiavi di traduzione, nomi di file
        return False
    # finali tipici dell'italiano (zione, mente, are/ere/ire, ato/ata...)
    if any(re.fullmatch(r"\w{2,}(zione|zioni|mente|are|ere|ire|ato|ata|ati|ate|ito|ita|uto|uta|abile|ibile|ente|enti|ore|ori|ione|ioni|aggio|eria|ura)", w) for w in words):
        return True
    # piu' parole di lettere con almeno una minuscola, senza segni da codice (elenchi: "Testi, relazioni, lettere")
    if len(re.findall(r"[A-Za-zà-ù]{3,}", t)) >= 2 and re.search(r"\b[a-zà-ù]{3,}\b", t) and not re.search(r"[=;{}<>$\\]|\w\(|\)\w|^\w+:\w|\w\.\w|\w_\w", t):
        return True
    # parola con maiuscola iniziale seguita da minuscole (etichette brevi: "Livelli", "Annulla")
    return bool(re.fullmatch(r"[A-ZÀ-Ý][a-zà-ù']+(?: [\wà-ù'./()+-]+)*[.:!?]*", t))


SKIP_BEFORE = re.compile(r"(===?|!==?|\bcase|\bimport|\bfrom|\brequire\(|\bin\s*$|querySelector(All)?\(|getElementById\(|"
                         r"console\.\w+\(|addEventListener\(|removeEventListener\(|classList\.\w+\(|setAttribute\(|"
                         r"dataset\.\w+\s*=|\btr?\(|\bhas\(|\bkey\s*:|\bid\s*:|\bclass\s*:|\btype\s*:|\bkind\s*:|\bviewer\s*:|"
                         r"\bmode\s*:|\bvalue\s*:|\bfont(Family)?\s*[:=])\s*$")


def candidates_js(path: Path):
    src = path.read_text(encoding="utf-8", newline="")
    res = []
    for (a, b, q, parts, exprs) in js_literals(src):
        text = "{}".join(parts) if q == "`" else parts[0]
        static = "".join(parts)
        if not is_ui_text(static):
            continue
        if "<" in static and re.search(r"<[a-z/!]", static):
            kind = "html"
        else:
            kind = "str"
        before = src[max(0, a - 60):a]
        if SKIP_BEFORE.search(before):
            continue
        after = src[b:b + 3]
        if re.match(r"\s*:(?!:)", after) and re.search(r"[{,]\s*$", before):  # chiave di un oggetto
            continue
        line = src.count("\n", 0, a) + 1
        res.append({"a": a, "b": b, "q": q, "text": text, "parts": parts, "exprs": exprs, "line": line, "kind": kind})
    res.sort(key=lambda r: r["a"])
    # i letterali annidati in un template gia' candidato restano per conto loro
    return src, res


def candidates_py(path: Path):
    src = path.read_text(encoding="utf-8", newline="")
    lines = src.splitlines(keepends=True)
    offs = [0]
    for ln in lines:
        offs.append(offs[-1] + len(ln))
    res = []
    toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    FS, FE = getattr(tokenize, "FSTRING_START", -1), getattr(tokenize, "FSTRING_END", -2)
    skip_until = -1
    for idx, tk in enumerate(toks):
        if idx < skip_until:
            continue
        if tk.type == FS:
            # f-string (Python 3.12+): dal segno di apertura a quello di chiusura corrispondente
            depth, j = 0, idx
            while j < len(toks):
                if toks[j].type == FS:
                    depth += 1
                elif toks[j].type == FE:
                    depth -= 1
                    if not depth:
                        break
                j += 1
            skip_until = j + 1
            start, end = tk.start, toks[j].end
        elif tk.type == tokenize.STRING:
            start, end = tk.start, tk.end
        else:
            continue
        a = offs[start[0] - 1] + start[1]
        b = offs[end[0] - 1] + end[1]
        s = src[a:b]
        m = re.match(r"([rRbBuUfF]*)('''|\"\"\"|'|\")", s)
        prefix, q = m.group(1), m.group(2)
        if "b" in prefix.lower() or len(q) == 3:
            continue
        body = s[len(prefix) + len(q):-len(q)]
        if "f" in prefix.lower():
            parts, exprs = [], []
            buf, k, depth = "", 0, 0
            while k < len(body):
                c = body[k]
                if c == "{" and body[k:k + 2] == "{{":
                    buf += "{"
                    k += 2
                    continue
                if c == "}" and body[k:k + 2] == "}}":
                    buf += "}"
                    k += 2
                    continue
                if c == "{":
                    j = k + 1
                    depth = 1
                    while j < len(body) and depth:
                        depth += {"{": 1, "}": -1}.get(body[j], 0)
                        j += 1
                    parts.append(buf)
                    buf = ""
                    exprs.append(body[k + 1:j - 1])
                    k = j
                    continue
                buf += c
                k += 1
            parts.append(buf)
        else:
            parts, exprs = [body], []
        static = "".join(parts)
        if not is_ui_text(static):
            continue
        prev = toks[idx - 1].string if idx else ""
        prev2 = toks[idx - 2].string if idx > 1 else ""
        if prev in ("==", "!=", "in", "import", "from") or prev2 in ("logging", "log") or (prev == "(" and prev2 in ("t", "get", "startswith", "endswith")):
            continue
        res.append({"a": a, "b": b, "q": "py", "prefix": prefix, "text": "{}".join(parts), "parts": parts, "exprs": exprs,
                    "line": start[0], "kind": "str"})
    return src, res


def candidates(path: Path):
    return candidates_py(path) if path.suffix == ".py" else candidates_js(path)


# ------------------------------------------------------------------ chiavi
STOP = set("il lo la le gli un una uno di del della dei delle degli da dal dalla dai con per su sul sulla nel nella nei e o a in al alla ai".split())


def slug(text: str, maxw: int = 5) -> str:
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    words = [w for w in re.findall(r"[a-z0-9]+", t) if w not in STOP]
    return "_".join(words[:maxw]) or "testo"


def load_lang(code: str) -> dict:
    f = I18N / f"{code}.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def save_lang(code: str, data: dict) -> None:
    I18N.mkdir(parents=True, exist_ok=True)
    f = I18N / f"{code}.json"
    f.write_text(json.dumps(dict(sorted(data.items())), ensure_ascii=False, indent=0).replace('\n"', '\n"') + "\n", encoding="utf-8", newline="")


def unescape_js(s: str, q: str) -> str:
    # i testi del catalogo sono quelli visibili: \n, \", \' e \\ si convertono
    return re.sub(r"\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)", lambda m: _esc(m.group(1)), s)


def _esc(e: str) -> str:
    if e.startswith("u{"):
        return chr(int(e[2:-1], 16))
    if e[0] == "u" and len(e) == 5:
        return chr(int(e[1:], 16))
    if e[0] == "x" and len(e) == 3:
        return chr(int(e[1:], 16))
    return {"n": "\n", "t": "\t", "r": "\r", "0": "\0"}.get(e, e)


def catalog_text(c) -> str:
    parts = [unescape_js(p, c["q"]) if c["q"] != "py" else _py_unescape(p, c.get("prefix", "")) for p in c["parts"]]
    out = parts[0]
    for i, p in enumerate(parts[1:]):
        out += "{" + str(i) + "}" + p
    return out


def _py_unescape(p: str, prefix: str) -> str:
    if "r" in prefix.lower():
        return p
    return unescape_js(p, "py")


def ns_for(path: Path) -> str:
    stem = path.stem
    if path.parent.name == "viewers":
        return "v_" + stem
    if path.suffix == ".py":
        return "srv_" + stem
    return stem


def make_plan(path: Path, plan: Path) -> None:
    src, cands = candidates(path)
    it = load_lang("it")
    ns = ns_for(path)
    rev = {}
    # testo gia' nel catalogo: stessa chiave (prima quelle comuni "common.*", poi quelle di questo file)
    for k, v in sorted(it.items(), key=lambda kv: (not kv[0].startswith("common."), kv[0])):
        if k.startswith(("common.", ns + ".")):
            rev.setdefault(v, k)
    used = set(it)
    rows = ["# file\t" + str(path.relative_to(ROOT)).replace("\\", "/"),
            "# id\triga\tchiave\ttesto\t(contesto) - cancellare le righe da non tradurre"]
    for i, c in enumerate(cands):
        text = catalog_text(c)
        key = rev.get(text)
        if not key:
            base = f"{ns}.{slug(text)}"
            key, k = base, 2
            while key in used:
                key = f"{base}_{k}"
                k += 1
            used.add(key)
            rev[text] = key
        flag = "" if c["kind"] == "str" else "  [HTML]"
        ls = src.rfind("\n", 0, c["a"]) + 1
        ctx = src[max(ls, c["a"] - 50):c["a"]].strip().replace("\t", " ")
        rows.append(f"{i}\t{c['line']}\t{key}\t{json.dumps(text, ensure_ascii=False)}{flag}\t{ctx}")
    plan.write_text("\n".join(rows) + "\n", encoding="utf-8", newline="")
    print(f"{len(cands)} testi -> {plan}")


def apply_plan(plan: Path) -> None:
    lines = plan.read_text(encoding="utf-8").splitlines()
    path = ROOT / lines[0].split("\t", 1)[1].strip()
    src, cands = candidates(path)
    chosen = {}
    for ln in lines[1:]:
        if not ln.strip() or ln.startswith("#"):
            continue
        cols = ln.split("\t")
        chosen[int(cols[0])] = (cols[2].strip(), json.loads(cols[3].split("  [HTML]")[0]))
        if not cols[2].strip():
            sys.exit(f"Chiave vuota alla riga {cols[1]}")
    it = load_lang("it")
    out = src
    count = 0
    fn = tname(src, path)
    sel = []
    for i in sorted(chosen):
        c = cands[i]
        key, text = chosen[i]
        if catalog_text(c) != text:
            sys.exit(f"Il file e' cambiato dopo il piano (riga {c['line']}): rifare il piano")
        if key in it and it[key] != text:
            sys.exit(f"Chiave {key} gia' usata con un altro testo: {it[key]!r}")
        it[key] = text
        sel.append((c, key))

    def top_level(items):
        return [x for x in items if not any(o is not x and o[0]["a"] <= x[0]["a"] and x[0]["b"] <= o[0]["b"] for o in items)]

    def render(c, key):
        # i testi dentro ${...} di un template scelto si traducono dentro l'argomento
        args = []
        for e in c["exprs"]:
            et, es = e if isinstance(e, tuple) else (e, None)
            if es is not None:
                inner = top_level([x for x in sel if x[0] is not c and x[0]["a"] >= es and x[0]["b"] <= es + len(et)])
                for ic, ik in sorted(inner, key=lambda x: -x[0]["a"]):
                    et = et[:ic["a"] - es] + render(ic, ik) + et[ic["b"] - es:]
            args.append(et.strip())
        return f'{fn}("{key}"' + "".join(", " + x for x in args) + ")"

    for c, key in sorted(top_level(sel), key=lambda x: -x[0]["a"]):
        out = out[:c["a"]] + render(c, key) + out[c["b"]:]
    count = len(sel)
    if count and path.suffix == ".py" and not re.search(r"^from (?:\.|mbvisual\.)i18n import t\b", out, re.M):
        out = _add_py_import(out, path, fn)
    m = re.search(r"^import \{([^}]*)\} from \"[./]+(?:js/)?i18n\.js\";", out, re.M) if path.suffix == ".js" else None
    if count and m and not re.search(r"(?:^|,)\s*t\b", m.group(1)):
        # import di i18n.js gia' presente (es. solo LOCALE): si aggiunge la funzione di traduzione
        name = "t" if fn == "t" else "t as " + fn
        out = out[:m.start(1)] + " " + name + "," + m.group(1) + out[m.end(1):]
    if count and path.suffix == ".js" and not m:
        rel = "../i18n.js" if path.parent.name == "viewers" else "./i18n.js"
        imp = f'import {{ {"t" if fn == "t" else "t as " + fn} }} from "{rel}";\n'
        # dopo l'ultimo import in testa al file
        last = None
        for mm in re.finditer(r"^import [^;]+;[ \t]*\n", out, re.M):
            last = mm
        if last:
            out = out[:last.end()] + imp + out[last.end():]
        else:
            # dopo i commenti iniziali
            mm = re.match(r"((?://[^\n]*\n)+)", out)
            pos = mm.end() if mm else 0
            out = out[:pos] + imp + out[pos:]
    # fine riga come nel file originale (molti sorgenti sono CRLF: niente diff di tutto il file)
    raw = path.read_bytes()
    out = out.replace("\r\n", "\n")
    if raw.count(b"\r\n") * 2 > raw.count(b"\n"):
        out = out.replace("\n", "\r\n")
    path.write_bytes(out.encode("utf-8"))
    save_lang("it", it)
    print(f"{count} testi sostituiti in {path.name}")


def _shadow_js(name: str) -> re.Pattern:
    n = re.escape(name)
    return re.compile(rf"\b(?:const|let|var)\s+{n}\b|\b(?:const|let|var)\s*[{{\[][^=;{{}}]{{0,120}}\b{n}\b[^=;{{}}]{{0,120}}[}}\]]\s*=|[(,]\s*{n}\s*(?:[,=]|\)\s*=>)|"
                      rf"(?<![\w.$]){n}\s*=>|\bfunction\s*\w*\s*\([^)]{{0,200}}\b{n}\b|\bcatch\s*\(\s*{n}\s*\)|(?<![\w.$]){n}\s*=(?![=>])")


def _shadow_py(name: str) -> re.Pattern:
    n = re.escape(name)
    return re.compile(rf"(?m)(?:^|[^\w.]){n}\s*(?:,[^=\n]*)?=(?!=)|\bfor\s+(?:[\w,\s(]*,\s*)?{n}\b|\bas\s+{n}\b|"
                      rf"\blambda\s+(?:[\w,\s]*,\s*)?{n}\b|\bdef\s+\w+\([^)]*\b{n}\b")


def tname(src: str, path: Path) -> str:
    """Nome della funzione di traduzione nel file: t, oppure tr (o _t) dove t (e tr) sono gia' variabili locali."""
    if path.suffix == ".py":
        m = re.search(r"^from (?:\.|mbvisual\.)i18n import t(?: as (\w+))?", src, re.M)
        shadow = _shadow_py
    else:
        m = re.search(r"^import \{[^}]*?\bt(?: as (\w+))?\b[^}]*\} from \"[./]+(?:js/)?i18n\.js\";", src, re.M)
        shadow = _shadow_js
    if m:
        return m.group(1) or "t"
    for name in ("t", "tr", "_t"):
        if not shadow(name).search(src):
            return name
    return "_t"


def _add_py_import(out: str, path: Path, fn: str = "t") -> str:
    name = "t" if fn == "t" else "t as " + fn
    mod = f"from .i18n import {name}\n" if path.parent.name == "mbvisual" else f"from mbvisual.i18n import {name}\n"
    last = None
    for mm in re.finditer(r"^(?:from [\w.]+ import [^\n(]+|from [\w.]+ import \([^)]*\)|import [\w., ]+)[ \t]*\n", out, re.M):
        if mm.start() > 0 and out[:mm.start()].count("\ndef ") == 0 and out[:mm.start()].count("\nclass ") == 0:
            last = mm
    if last:
        return out[:last.end()] + mod + out[last.end():]
    return mod + out


def main(argv):
    if not argv:
        print(__doc__)
        return
    if argv[0] == "--apply":
        apply_plan(Path(argv[1]))
        return
    if argv[0] == "--count":
        root = ROOT / argv[1]
        files = [root] if root.is_file() else sorted(list(root.rglob("*.js")) + list(root.rglob("*.py")))
        tot = 0
        for f in files:
            if "vendor" in f.parts or "i18n" in f.name:
                continue
            _, c = candidates(f)
            tot += len(c)
            if c:
                print(f"{len(c):5d}  {f.relative_to(ROOT)}")
        print(f"{tot:5d}  totale")
        return
    path = (ROOT / argv[0]).resolve()
    if "--plan" in argv:
        make_plan(path, Path(argv[argv.index("--plan") + 1]))
        return
    _, cands = candidates(path)
    for c in cands:
        print(f"{c['line']:5d}  {json.dumps(catalog_text(c), ensure_ascii=False)}{'  [HTML]' if c['kind'] != 'str' else ''}")


if __name__ == "__main__":
    main(sys.argv[1:])
