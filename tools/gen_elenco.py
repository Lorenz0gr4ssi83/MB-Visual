"""Genera ELENCO_FORMATI.md dal registro ui/formats.json (lo stesso che usa l'app)."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
reg = json.loads((ROOT / "ui" / "formats.json").read_text(encoding="utf-8"))
all_exts = sorted({e for c in reg["categories"] for e in c["exts"]})

out = ["# MB Visual - elenco completo dei formati", "",
       f"**{len(all_exts)} estensioni** in {len(reg['categories'])} categorie si aprono con un visualizzatore dedicato.",
       "Questo elenco e' generato automaticamente dallo stesso registro (`ui/formats.json`) che l'app usa per decidere come aprire un file:",
       "**se un'estensione non compare qui, il file si apre solo come byte grezzi nell'editor esadecimale.**", "",
       "Nell'app lo stesso elenco e' consultabile dal pulsante **Formati**, con la ricerca per estensione.", ""]
for c in reg["categories"]:
    out.append(f"## {c['name']} ({len(c['exts'])})")
    out.append("")
    if c.get("requires"):
        r = reg["requirements"][c["requires"]]
        out.append(f"> Richiede **{r['name']}** (gratuito) installato sul PC: {r['url']}")
        out.append("")
    out.append(f"- **Visualizza:** {c['view']}")
    out.append(f"- **Modifica:** {c['edit']}")
    out.append("")
    out.append(" ".join(f"`.{e}`" for e in sorted(set(c["exts"]))))
    out.append("")
fb = reg["fallback"]
out += [f"## {fb['name']}", "", f"- **Visualizza:** {fb['view']}", f"- **Modifica:** {fb['edit']}", "",
        "## Indice alfabetico", "", " ".join(f"`.{e}`" for e in all_exts), ""]
(ROOT / "ELENCO_FORMATI.md").write_text("\n".join(out), encoding="utf-8")
print(len(all_exts), "estensioni")
