"""Collaudo del lettore .mpp (mbvisual/mpp.py) contro l'XML MSPDI dello STESSO progetto salvato da Microsoft Project.

    python tests/test_mpp.py [cartella dei campioni]

Campioni (NON nel repo, solo per le prove): dati di prova di MPXJ (LGPL, github.com/joniles/mpxj, junit/data) in
%USERPROFILE%\\.mbvisual\\project-campioni\\mpxj\\junit\\data: in "generated/<prova>/" ogni progetto e' salvato da
Project 2007-2019 sia in .mpp (formati MPP12 e MPP14) sia in XML. Si confrontano nomi, livelli, avanzamento, cardini,
collegamenti (tipo e ritardo), risorse (nome, tariffa, unita') e assegnazioni (unita').
Date di inizio/fine: confrontate a parte (alcuni campioni generati hanno date diverse tra .mpp e .xml perche' il
generatore ha cambiato l'inizio del progetto senza ricalcolare: non sono errori del lettore).
"""
import glob
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from mbvisual import mpp  # noqa: E402
import lxml.etree as ET  # noqa: E402

NS = {"p": "http://schemas.microsoft.com/project"}
BASE = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.mbvisual/project-campioni/mpxj/junit/data")


def xml_project(f):
    r = ET.parse(f).getroot()
    g = lambda n, k: n.findtext("p:" + k, namespaces=NS) or ""
    tasks = {}
    for t in r.findall("p:Tasks/p:Task", NS):
        if g(t, "UID") == "0" or g(t, "IsNull") == "1":
            continue
        preds = sorted((g(L, "PredecessorUID"), g(L, "Type"), g(L, "LinkLag")) for L in t.findall("p:PredecessorLink", NS))
        tasks[int(g(t, "UID"))] = dict(name=g(t, "Name"), lvl=int(g(t, "OutlineLevel") or 1), pct=int(g(t, "PercentComplete") or 0),
                                       ms=g(t, "Milestone") == "1", start=g(t, "Start")[:16], finish=g(t, "Finish")[:16], preds=preds)
    res = {int(g(x, "UID")): (g(x, "Name"), float(g(x, "StandardRate") or 0), float(g(x, "MaxUnits") or 1), g(x, "Type"))
           for x in r.findall("p:Resources/p:Resource", NS) if g(x, "UID") != "0" and g(x, "Name")}
    asn = sorted((int(g(x, "TaskUID")), int(g(x, "ResourceUID")), float(g(x, "Units") or 1)) for x in r.findall("p:Assignments/p:Assignment", NS) if int(g(x, "ResourceUID")) > 0)
    return tasks, res, asn


def main():
    ok = ko = 0
    fields = dict(name=0, lvl=0, pct=0, ms=0, preds=0, dates=0)
    tot = res_ok = res_tot = asn_ok = asn_tot = 0
    errors = []
    for x in sorted(glob.glob(os.path.join(BASE, "generated", "*", "*-mspdi.xml"))):
        for suff in ("-mpp14.mpp", "-mpp12.mpp"):
            m = x.replace("-mspdi.xml", suff)
            if not os.path.exists(m):
                continue
            try:
                J = mpp.read(m)
            except Exception as e:  # noqa: BLE001
                errors.append((os.path.basename(m), str(e)[:90]))
                continue
            X, XR, XA = xml_project(x)
            T = {t["uid"]: t for t in J["tasks"] if not t.get("isNull")}
            for u, a in X.items():
                b = T.get(u)
                tot += 1
                if not b:
                    continue
                for k in ("name", "lvl", "pct", "ms"):
                    fields[k] += a[k] == b[k]
                fields["dates"] += a["start"] == b["start"] and a["finish"] == b["finish"]
                bp = sorted((str(L["u"]), str(L["t"]), str(round(L["lag"] * 10))) for L in b["preds"])
                fields["preds"] += bp == a["preds"]
            R = {r["uid"]: r for r in J["resources"]}
            for u, (n, rate, mx, ty) in XR.items():
                res_tot += 1
                r = R.get(u)
                res_ok += bool(r and r["name"] == n and abs(r["rate"] - rate) < 0.01 and (ty != "1" or abs(r["max"] - mx) < 0.01))
            JA = {(a["task"], a["res"]): a for a in J["assignments"]}
            for tu, ru, un in XA:
                asn_tot += 1
                a = JA.get((tu, ru))
                asn_ok += bool(a and abs(a["units"] - un) < 0.001)

    def check(name, cond, extra=""):
        nonlocal ok, ko
        if cond:
            ok += 1
        else:
            ko += 1
            print("NO ", name, extra)
    print(f"attivita' confrontate: {tot}; " + ", ".join(f"{k} {v}" for k, v in fields.items()) + f"; risorse {res_ok}/{res_tot}; assegnazioni {asn_ok}/{asn_tot}")
    check("nessun file illeggibile", not errors, errors[:5])
    for k in ("name", "lvl", "pct", "ms"):
        check(f"campo {k} uguale all'XML", fields[k] == tot, f"{fields[k]}/{tot}")
    check("collegamenti uguali (>= 98%)", fields["preds"] >= 0.98 * tot, f"{fields['preds']}/{tot}")
    check("date uguali (>= 85%, vedi nota)", fields["dates"] >= 0.85 * tot, f"{fields['dates']}/{tot}")
    check("risorse", res_ok == res_tot, f"{res_ok}/{res_tot}")
    check("assegnazioni", asn_ok == asn_tot, f"{asn_ok}/{asn_tot}")
    # tutti i .mpp dei campioni: i 2007-2024 si leggono, i piu' vecchi danno il messaggio "versione non letta"
    t0 = time.time()
    n_ok = n_old = n_bad = 0
    for f in glob.glob(os.path.join(BASE, "**", "*.mp[pt]"), recursive=True):
        try:
            mpp.read(f)
            n_ok += 1
        except mpp.MppError as e:
            if "vecchio" in str(e) or "98" in str(e) or "2000" in str(e):
                n_old += 1
            else:
                n_bad += 1
                print("  ", os.path.basename(f), e)
    print(f"tutti i .mpp: {n_ok} letti, {n_old} di Project 98-2003 (non letti, messaggio chiaro), {n_bad} errori, {time.time() - t0:.1f} s")
    check("nessun errore sui .mpp 2007-2024", n_bad == 0)
    print(f"\n{ok} prove riuscite, {ko} fallite")
    return 1 if ko else 0


if __name__ == "__main__":
    sys.exit(main())
