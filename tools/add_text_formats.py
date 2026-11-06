"""Aggiunge al registro (ui/formats.json, categoria "text") le estensioni di codice sorgente e di testo che l'app non conosceva.

Fonti: GitHub Linguist (languages.yml: solo linguaggi di testo) e, se si passa il catalogo, le estensioni che mime-db o
freedesktop dichiarano text/*, */xml, */json, +xml, +json (le descrizioni di TrID e PRONOM NON bastano: non dicono se e' testo).
Scrive anche ui/js/textlangs.js = estensione -> linguaggio dell'editor (Monaco) per l'evidenziazione. Rilanciabile: le estensioni
gia' presenti in qualsiasi categoria non si toccano; quelle aggiunte da qui si riconoscono da ui/js/textlangs.js.
Uso: python tools/add_text_formats.py <languages.yml> [<Estensioni_con_descrizioni.csv>]
"""
import csv
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
REG = ROOT / "ui" / "formats.json"
OUT = ROOT / "ui" / "js" / "textlangs.js"
OK_EXT = re.compile(r"^[a-z0-9][a-z0-9_+\-.]{0,30}$")

# modalita' di Ace / CodeMirror di Linguist -> linguaggio di Monaco presente in ui/vendor/monaco/min/vs/basic-languages
ACE = {"c_cpp": "cpp", "java": "java", "python": "python", "ruby": "ruby", "perl": "perl", "php": "php", "javascript": "javascript",
       "typescript": "typescript", "html": "html", "xml": "xml", "json": "json", "yaml": "yaml", "ini": "ini", "sh": "shell",
       "powershell": "powershell", "sql": "sql", "mysql": "mysql", "pgsql": "pgsql", "lua": "lua", "golang": "go", "rust": "rust",
       "swift": "swift", "kotlin": "kotlin", "scala": "scala", "r": "r", "fsharp": "fsharp", "vbscript": "vb", "pascal": "pascal",
       "scheme": "scheme", "clojure": "clojure", "coffee": "coffee", "dart": "dart", "elixir": "elixir", "julia": "julia", "less": "less",
       "scss": "scss", "sass": "scss", "css": "css", "markdown": "markdown", "objectivec": "objective-c", "jade": "pug", "razor": "razor",
       "rst": "restructuredtext", "tcl": "tcl", "twig": "twig", "verilog": "systemverilog", "batchfile": "bat", "dockerfile": "dockerfile",
       "graphqlschema": "graphql", "handlebars": "handlebars", "terraform": "hcl", "liquid": "liquid", "protobuf": "protobuf",
       "sparql": "sparql", "abap": "abap", "apex": "apex", "csharp": "csharp", "toml": "ini", "properties": "ini", "solidity": "solidity",
       "mips": "mips"}
CM = {"clike": None, "xml": "xml", "javascript": "javascript", "shell": "shell", "python": "python", "ruby": "ruby", "perl": "perl",
      "sql": "sql", "yaml": "yaml", "properties": "ini", "toml": "ini", "lua": "lua", "go": "go", "rust": "rust", "swift": "swift",
      "markdown": "markdown", "gfm": "markdown", "css": "css", "htmlmixed": "html", "htmlembedded": "html", "php": "php",
      "powershell": "powershell", "r": "r", "verilog": "systemverilog", "tcl": "tcl", "pascal": "pascal", "scheme": "scheme",
      "clojure": "clojure", "coffeescript": "coffee", "dart": "dart", "julia": "julia", "mllike": "fsharp", "vb": "vb",
      "vbscript": "vb", "dockerfile": "dockerfile", "protobuf": "protobuf", "pug": "pug", "twig": "twig", "sparql": "sparql",
      "commonlisp": None, "haskell": None}
CM_MIME = {"text/x-java": "java", "text/x-csharp": "csharp", "text/x-c++src": "cpp", "text/x-csrc": "cpp", "text/x-c++hdr": "cpp",
           "text/x-chdr": "cpp", "text/x-scala": "scala", "text/x-kotlin": "kotlin", "text/x-objectivec": "objective-c",
           "application/json": "json", "text/x-scss": "scss", "text/x-less": "less", "application/ld+json": "json"}


def monaco_of(lang: dict) -> str:
    m = ACE.get(str(lang.get("ace_mode", "")).lower())
    if m:
        return m
    mime = str(lang.get("codemirror_mime_type", "")).lower()
    if mime in CM_MIME:
        return CM_MIME[mime]
    return CM.get(str(lang.get("codemirror_mode", "")).lower()) or "plaintext"


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    reg = json.loads(REG.read_text(encoding="utf-8"))
    text = next(c for c in reg["categories"] if c["id"] == "text")
    old_added = set()
    if OUT.exists():
        old_added = set(re.findall(r'"([^"]+)":', OUT.read_text(encoding="utf-8")))
    text["exts"] = [e for e in text["exts"] if e not in old_added]
    have = {e for c in reg["categories"] for e in c["exts"]}
    add: dict[str, str] = {}
    langs = yaml.safe_load(Path(sys.argv[1]).read_text(encoding="utf-8"))
    for name, lang in langs.items():
        for e in lang.get("extensions") or []:
            e = e.lstrip(".").lower()
            if OK_EXT.match(e) and e not in have and e not in add:
                add[e] = monaco_of(lang)
    n_ling = len(add)
    if len(sys.argv) > 2:
        with open(sys.argv[2], encoding="utf-8-sig") as f:
            for r in csv.DictReader(f, delimiter=";"):
                if r["Repertorio"] not in ("mime-db", "freedesktop shared-mime-info"):
                    continue
                mime = r["MIME"].lower()
                if not re.search(r"^text/|/xml$|\+xml$|/json$|\+json$", mime):
                    continue
                e = r["Estensione normalizzata"].lstrip(".").lower()
                if OK_EXT.match(e) and e not in have and e not in add:
                    add[e] = "json" if "json" in mime else "xml" if "xml" in mime else "plaintext"
    text["exts"] += sorted(add)
    REG.write_bytes(json.dumps(reg, ensure_ascii=False, indent=1).encode("utf-8") + b"\n")
    body = ",\n".join(f'  "{e}": "{m}"' for e, m in sorted(add.items()))
    OUT.write_bytes(("// GENERATO da tools/add_text_formats.py: estensioni di codice e di testo aggiunte al registro -> linguaggio dell'editor\n"
                     "export default {\n" + body + "\n};\n").encode("utf-8"))
    print(f"aggiunte {len(add)} estensioni ({n_ling} da Linguist, {len(add) - n_ling} dal tipo MIME)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
