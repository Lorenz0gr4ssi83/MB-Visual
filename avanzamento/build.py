"""Genera avanzamento.html da avanzamento.src.html + fasi.json (logo incorporato)."""
import base64
import json
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
src = (HERE / "avanzamento.src.html").read_text(encoding="utf-8")
data = json.loads((HERE / "fasi.json").read_text(encoding="utf-8"))
logo = base64.b64encode((HERE.parent / "ui" / "img" / "logo.png").read_bytes()).decode()
html = (src.replace("__LOGO__", "data:image/png;base64," + logo)
           .replace("__UPDATED__", datetime.now().strftime("%d/%m/%Y %H:%M"))
           .replace("__NOW__", data["now"])
           .replace("__PHASES__", json.dumps(data["phases"], ensure_ascii=False)))
(HERE / "avanzamento.html").write_text(html, encoding="utf-8")
total = sum(p["peso"] * p["fatto"] / 100 for p in data["phases"])
print(f"totale {total:.0f}%")
