"""Traduzioni: controllo e completamento dei file di lingua ui/i18n/*.json (riferimento: it.json).

  python tools/i18n_check.py                     -> riepilogo: chiavi mancanti per lingua, segnaposto {0} diversi,
                                                    chiavi usate nel codice ma assenti in it.json
  python tools/i18n_check.py --missing [prefisso] -> chiavi senza traduzione (in almeno una lingua) con il testo italiano,
                                                    in JSON: {"chiave": "testo italiano", ...}
  python tools/i18n_check.py --merge file.json   -> unisce traduzioni nel formato {"chiave": ["en", "es", "fr", "de"]}
                                                    o, per chiavi nuove, {"chiave": ["it", "en", "es", "fr", "de"]}
                                                    (oppure {"en": {...}, "es": {...}} per lingua)
  python tools/i18n_check.py --unused            -> chiavi di it.json non piu' usate nel codice (da togliere a mano)

Le chiavi si scrivono nel codice come t("chiave") / tr("chiave") (JS) o t("chiave") (Python). Le chiavi composte al
volo (es. `fmt.${id}.name`, "keys." + k, "units." + u) sono considerate usate per prefisso.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
I18N = ROOT / "ui" / "i18n"
LANGS = ["en", "es", "fr", "de"]
DYNAMIC_PREFIXES = ("fmt.", "keys.", "units.", "lang.")


def load(code: str) -> dict:
    f = I18N / f"{code}.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def save(code: str, data: dict) -> None:
    (I18N / f"{code}.json").write_text(json.dumps(dict(sorted(data.items())), ensure_ascii=False, indent=1) + "\n",
                                       encoding="utf-8", newline="")


def code_keys() -> set[str]:
    keys = set()
    files = list((ROOT / "ui" / "js").rglob("*.js")) + list((ROOT / "mbvisual").rglob("*.py")) + [ROOT / "app.py"]
    for f in files:
        if "vendor" in f.parts:
            continue
        src = f.read_text(encoding="utf-8", errors="replace")
        keys.update(re.findall(r"\b(?:tr?|_t)\(\s*[\"']([\w.-]+)[\"']", src))
        keys.update(re.findall(r"[\"'](srv_\w+\.[\w-]+)[|\"']", src))  # chiavi scritte come dati e tradotte dopo
        keys.update(re.findall(r"data-i18n(?:-\w+)?=\\?[\"']([\w.-]+)", src))
    html = (ROOT / "ui" / "index.html").read_text(encoding="utf-8")
    keys.update(re.findall(r"data-i18n(?:-\w+)?=\"([\w.-]+)\"", html))
    return keys


def placeholders(s: str) -> list[str]:
    return sorted(re.findall(r"\{\w+\}", s))


def main(argv):
    if argv and argv[0] == "--resolve":
        # conflitti di git (merge/rebase) nei file di lingua: unione delle chiavi delle due versioni
        import subprocess
        for code in ["it"] + LANGS:
            rel = f"ui/i18n/{code}.json"
            sides = []
            for stage in (2, 3):
                r = subprocess.run(["git", "show", f":{stage}:{rel}"], cwd=ROOT, capture_output=True)
                if r.returncode == 0:
                    sides.append(json.loads(r.stdout.decode("utf-8")))
            if len(sides) < 2:
                continue
            merged = {**sides[0], **sides[1]}
            save(code, merged)
            subprocess.run(["git", "add", rel], cwd=ROOT)
            print(f"{rel}: unite {len(merged)} chiavi")
        return
    it = load("it")
    if argv and argv[0] == "--missing":
        pre = argv[1] if len(argv) > 1 else ""
        others = {c: load(c) for c in LANGS}
        out = {k: v for k, v in it.items() if k.startswith(pre) and any(k not in others[c] for c in LANGS)}
        sys.stdout.reconfigure(encoding="utf-8")
        print(json.dumps(out, ensure_ascii=False, indent=0))
        return
    if argv and argv[0] == "--merge":
        data = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        per = {c: load(c) for c in LANGS}
        bad = 0
        if all(c in data for c in LANGS) and all(isinstance(v, dict) for v in data.values()):
            for c in LANGS:
                per[c].update(data[c])
        else:
            for k, vals in data.items():
                if isinstance(vals, list) and len(vals) == len(LANGS) + 1:  # chiave nuova: [it, en, es, fr, de]
                    it[k] = vals[0]
                    vals = vals[1:]
                if k not in it:
                    print("chiave sconosciuta:", k)
                    bad += 1
                    continue
                if len(vals) != len(LANGS):
                    print("servono 4 traduzioni:", k)
                    bad += 1
                    continue
                for c, v in zip(LANGS, vals):
                    per[c][k] = v
        for c in LANGS:
            save(c, per[c])
        save("it", it)
        print(f"{len(data)} voci unite" + (f", {bad} scartate" if bad else ""))
        return
    used = code_keys()
    if argv and argv[0] == "--unused":
        for k in sorted(it):
            if k not in used and not k.startswith(DYNAMIC_PREFIXES) and not k.startswith("common."):
                print(k)
        return
    print(f"it.json: {len(it)} chiavi")
    for c in LANGS:
        d = load(c)
        miss = [k for k in it if k not in d]
        extra = [k for k in d if k not in it]
        ph = [k for k in it if k in d and placeholders(it[k]) != placeholders(d[k])]
        print(f"{c}.json: {len(d)} chiavi, {len(miss)} mancanti, {len(extra)} in piu', {len(ph)} con segnaposto diversi")
        for k in ph[:20]:
            print(f"   segnaposto: {k}: {it[k]!r} -> {d[k]!r}")
    absent = sorted(k for k in used if k not in it and not k.startswith(DYNAMIC_PREFIXES))
    if absent:
        print(f"{len(absent)} chiavi usate nel codice ma assenti in it.json:")
        for k in absent[:50]:
            print("  ", k)


if __name__ == "__main__":
    main(sys.argv[1:])
