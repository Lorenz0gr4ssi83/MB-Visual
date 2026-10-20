"""Aggiunge al registro le estensioni dichiarate dai motori inclusi (verifica del 20/10/2026, vedi tests/verifica_formati.md)."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
p = ROOT / "ui" / "formats.json"
reg = json.loads(p.read_text(encoding="utf-8"))
cats = {c["id"]: c for c in reg["categories"]}

ADD = {
    "text": json.loads((ROOT / "tests" / "monaco_exts.json").read_text(encoding="utf-8")),
    "image": ["avifs", "emf", "wmf", "fli", "flc", "fpx", "jpc", "pxr", "ras", "mic"],
    "media": ["266", "h266", "vvc", "evc", "avc", "h26l", "h261", "vc1", "rcv", "obu", "ivr", "ifv", "ipu", "ism", "isma", "ismv",
              "kux", "lvf", "mj2", "mvi", "mxg", "str", "ty", "ty+", "usm", "viv", "xmv", "yop", "cdg", "cdxl", "bmv", "imx",
              "avs2", "avs3", "moflex", "ser"],
    "audio": ["302", "722", "aa", "ac4", "acm", "adp", "aea", "afc", "aix", "al", "apc", "aptx", "aptxhd", "ast", "avr", "binka",
              "bonk", "c2", "daud", "dfpwm", "dss", "dtk", "fsb", "fwse", "g722", "g723_1", "g729", "genh", "lc3", "mac", "mca",
              "mp2", "mpa", "m2a", "msf", "msbc", "mtaf", "musx", "nsp", "osq", "qoa", "rka", "rsd", "rso", "sbc", "sds", "shn",
              "son", "ss2", "svag", "sw", "ub", "ul", "uw", "vpk", "wsd", "xvag", "xmd", "iamf", "vqe", "vql",
              "669", "ams", "dbm", "digi", "dmf", "dsm", "far", "gdm", "imf", "j2b", "m15", "mdl", "med", "mo3", "mods", "mptm",
              "mt2", "okt", "plm", "psm", "pt36", "ptm", "stk", "stm", "st26", "ult", "wow", "xpk"],
    "archive": ["z01", "a", "lib", "hfsx", "lzma86"],
}
SKIP = {"html.liquid"}
added = 0
for cid, exts in ADD.items():
    have = set(cats[cid]["exts"])
    for e in exts:
        if e not in have and e not in SKIP:
            cats[cid]["exts"].append(e)
            have.add(e)
            added += 1
p.write_text(json.dumps(reg, ensure_ascii=False, indent=2), encoding="utf-8")
print("aggiunte", added)
