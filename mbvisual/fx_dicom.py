"""Immagini mediche DICOM: serie nella cartella (o da DICOMDIR), pixel con LUT di modalita', tag in tabella.

Librerie: pydicom (MIT), numpy (BSD), python-gdcm (Apache-2.0, GDCM BSD) per JPEG lossless / JPEG-LS / JPEG 2000;
Pillow (MIT-CMU) per JPEG di base. I pixel si mandano all'interfaccia come numeri grezzi: finestra/livello si
applicano nel browser (cambio immediato, nessun nuovo calcolo qui).
"""
from __future__ import annotations

import os
import threading

MAX_SERIE = 4000          # file esaminati al massimo nella cartella
_CACHE: dict = {}         # (percorso, mtime) -> dataset senza pixel (per i tag e la LUT)
_LOCK = threading.Lock()


def _pyd():
    import pydicom
    try:
        import gdcm  # noqa: F401  (decodifica JPEG lossless / JPEG-LS / JPEG 2000)
    except Exception:
        pass
    return pydicom


def is_dicom(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            h = f.read(132)
    except OSError:
        return False
    if h[128:132] == b"DICM":
        return True
    # file senza preambolo (vecchi ACR-NEMA / DICOM "nudi"): gruppo 0008 o 0002 all'inizio
    return len(h) >= 8 and h[:2] in (b"\x08\x00", b"\x02\x00") and h[2:4] in (b"\x00\x00", b"\x05\x00", b"\x16\x00", b"\x18\x00", b"\x20\x00", b"\x08\x00")


def _read(path: str, pixels=False):
    pyd = _pyd()
    if pixels:
        return pyd.dcmread(path, force=True)
    st = os.stat(path)
    key = (path, st.st_mtime)
    with _LOCK:
        ds = _CACHE.get(key)
    if ds is None:
        ds = pyd.dcmread(path, force=True, stop_before_pixels=True)
        with _LOCK:
            if len(_CACHE) > 400:
                _CACHE.clear()
            _CACHE[key] = ds
    return ds


def _num(v, default=None):
    try:
        if v is None or v == "":
            return default
        if hasattr(v, "__len__") and not isinstance(v, (str, bytes)):
            v = v[0]
        return float(v)
    except Exception:
        return default


def _list(v):
    if v is None:
        return []
    try:
        return [float(x) for x in v]
    except TypeError:
        return [float(v)]


def _fg(ds, seq_name, attr):
    """Valore da Shared/PerFrame Functional Groups (DICOM "enhanced" multi-frame)."""
    for grp in ("SharedFunctionalGroupsSequence", "PerFrameFunctionalGroupsSequence"):
        g = ds.get(grp)
        if not g:
            continue
        s = g[0].get(seq_name)
        if s and attr in s[0]:
            return s[0].get(attr)
    return None


def _str(v) -> str:
    if v is None:
        return ""
    s = str(v)
    return s.replace("^", " ").strip()


def _person(v) -> str:
    return " ".join(p for p in _str(v).split() if p)


def _date(v) -> str:
    s = _str(v)
    return f"{s[6:8]}/{s[4:6]}/{s[0:4]}" if len(s) >= 8 and s[:8].isdigit() else s


def _image_info(ds) -> dict:
    spacing = _list(ds.get("PixelSpacing")) or _list(_fg(ds, "PixelMeasuresSequence", "PixelSpacing")) or _list(ds.get("ImagerPixelSpacing"))
    wc = ds.get("WindowCenter") or _fg(ds, "FrameVOILUTSequence", "WindowCenter")
    ww = ds.get("WindowWidth") or _fg(ds, "FrameVOILUTSequence", "WindowWidth")
    slope = _num(ds.get("RescaleSlope"), None)
    inter = _num(ds.get("RescaleIntercept"), None)
    if slope is None:
        slope = _num(_fg(ds, "PixelValueTransformationSequence", "RescaleSlope"), 1.0)
        inter = _num(_fg(ds, "PixelValueTransformationSequence", "RescaleIntercept"), 0.0)
    expl = ds.get("WindowCenterWidthExplanation")
    return {
        "righe": int(ds.get("Rows") or 0), "colonne": int(ds.get("Columns") or 0),
        "fotogrammi": int(_num(ds.get("NumberOfFrames"), 1) or 1),
        "campioni": int(ds.get("SamplesPerPixel") or 1),
        "fotometria": _str(ds.get("PhotometricInterpretation")),
        "bit": int(ds.get("BitsStored") or ds.get("BitsAllocated") or 0),
        "spaziatura": spacing[:2] if spacing else None,
        "spessore": _num(ds.get("SliceThickness")) or _num(_fg(ds, "PixelMeasuresSequence", "SliceThickness")),
        "finestre": [{"c": c, "w": w, "nome": (_str(expl[i]) if expl is not None and not isinstance(expl, str) and i < len(expl) else _str(expl) if i == 0 else "")}
                     for i, (c, w) in enumerate(zip(_list(wc), _list(ww)))],
        "pendenza": slope if slope is not None else 1.0, "intercetta": inter if inter is not None else 0.0,
        "unita": _str(ds.get("RescaleType")) or ("HU" if _str(ds.get("Modality")) == "CT" else ""),
        "posizione": _list(ds.get("ImagePositionPatient")) or None,
        "orientamento": _list(ds.get("ImageOrientationPatient")) or None,
        "istanza": int(_num(ds.get("InstanceNumber"), 0) or 0),
        "pixel": "PixelData" in ds or "FloatPixelData" in ds or "DoubleFloatPixelData" in ds or bool(ds.get("Rows")),
    }


def _summary(ds) -> dict:
    return {
        "paziente": _person(ds.get("PatientName")), "id_paziente": _str(ds.get("PatientID")),
        "nascita": _date(ds.get("PatientBirthDate")), "sesso": _str(ds.get("PatientSex")), "eta": _str(ds.get("PatientAge")),
        "studio": _str(ds.get("StudyDescription")), "data": _date(ds.get("StudyDate") or ds.get("SeriesDate") or ds.get("ContentDate")),
        "serie": _str(ds.get("SeriesDescription")), "numero_serie": _str(ds.get("SeriesNumber")),
        "modalita": _str(ds.get("Modality")), "parte": _str(ds.get("BodyPartExamined")),
        "istituto": _str(ds.get("InstitutionName")), "apparecchio": " ".join(x for x in (_str(ds.get("Manufacturer")), _str(ds.get("ManufacturerModelName"))) if x),
        "sop": _str(getattr(ds.get("SOPClassUID"), "name", ds.get("SOPClassUID"))),
        "sintassi": _str(getattr(getattr(ds, "file_meta", None), "TransferSyntaxUID", None) and ds.file_meta.TransferSyntaxUID.name),
        "uid_serie": _str(ds.get("SeriesInstanceUID")),
    }


def _sort_key(info, name):
    pos, ori = info.get("posizione"), info.get("orientamento")
    if pos and ori and len(ori) == 6 and len(pos) == 3:
        r, c = ori[:3], ori[3:]
        n = (r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0])
        return (0, sum(p * k for p, k in zip(pos, n)), info.get("istanza") or 0, name)
    return (1, info.get("istanza") or 0, 0, name)


def _slices_from(files: list[str], uid: str | None) -> list[dict]:
    out = []
    for f in files:
        try:
            ds = _read(f)
        except Exception:
            continue
        if uid and _str(ds.get("SeriesInstanceUID")) != uid:
            continue
        try:
            if not ds.get("Rows"):
                continue
            info = _image_info(ds)
        except Exception:
            continue
        out.append({"path": f, "nome": os.path.basename(f), "fotogrammi": info["fotogrammi"], "istanza": info["istanza"],
                    "_k": _sort_key(info, os.path.basename(f)), "posizione": info["posizione"]})
    out.sort(key=lambda s: s.pop("_k"))
    return out


def _folder_series(folder: str) -> dict:
    """Serie presenti nella cartella: uid -> {descrizione, file}."""
    series: dict = {}
    n = 0
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return {}
    for name in names:
        p = os.path.join(folder, name)
        ext = os.path.splitext(name)[1].lower()
        if ext not in ("", ".dcm", ".dicom", ".dic", ".ima", ".img") and not ext[1:].isdigit():
            continue
        if not os.path.isfile(p) or name.upper() == "DICOMDIR" or not is_dicom(p):
            continue
        n += 1
        if n > MAX_SERIE:
            break
        try:
            ds = _read(p)
        except Exception:
            continue
        uid = _str(ds.get("SeriesInstanceUID")) or "?"
        s = series.setdefault(uid, {"uid": uid, "descrizione": _str(ds.get("SeriesDescription")), "modalita": _str(ds.get("Modality")),
                                     "numero": _str(ds.get("SeriesNumber")), "file": []})
        s["file"].append(p)
    return series


def _dicomdir(path: str, ds) -> list[dict]:
    """Serie elencate in un DICOMDIR (percorsi relativi alla sua cartella)."""
    base = os.path.dirname(path)
    out, cur_pat, cur_study, cur = [], "", "", None
    for rec in ds.DirectoryRecordSequence:
        t = _str(rec.get("DirectoryRecordType")).upper()
        if t == "PATIENT":
            cur_pat = _person(rec.get("PatientName"))
        elif t == "STUDY":
            cur_study = _str(rec.get("StudyDescription")) or _date(rec.get("StudyDate"))
        elif t == "SERIES":
            cur = {"uid": _str(rec.get("SeriesInstanceUID")), "descrizione": " · ".join(x for x in (cur_pat, cur_study, _str(rec.get("SeriesDescription"))) if x),
                   "modalita": _str(rec.get("Modality")), "numero": _str(rec.get("SeriesNumber")), "file": []}
            out.append(cur)
        elif cur is not None and rec.get("ReferencedFileID"):
            ref = rec.ReferencedFileID
            parts = [str(x) for x in ref] if not isinstance(ref, str) else [ref]
            p = os.path.join(base, *parts)
            if not os.path.exists(p):  # supporti con nomi in minuscolo
                p2 = os.path.join(base, *[x.lower() for x in parts])
                p = p2 if os.path.exists(p2) else p
            cur["file"].append(p)
    return [s for s in out if s["file"]]


def open_series(path: str, uid: str | None = None) -> dict:
    ds = _read(path)
    folder = os.path.dirname(path)
    if "DirectoryRecordSequence" in ds:
        lst = _dicomdir(path, ds)
        if not lst:
            raise ValueError("Il DICOMDIR non elenca nessuna immagine")
        pick = next((s for s in lst if s["uid"] == uid), lst[0])
        slices = _slices_from([f for f in pick["file"] if os.path.isfile(f)], None)
        if not slices:
            raise ValueError("Le immagini elencate nel DICOMDIR non si trovano accanto al file")
        first = _read(slices[0]["path"])
        return _result(first, slices, lst, pick["uid"], dicomdir=True)
    series = _folder_series(folder)
    my_uid = uid or _str(ds.get("SeriesInstanceUID")) or "?"
    if uid and uid in series:
        files = series[uid]["file"]
    else:
        files = series.get(my_uid, {}).get("file") or [path]
        if path not in files:
            files = [path] + files
    slices = _slices_from(files, None if my_uid == "?" else my_uid) or ([{"path": path, "nome": os.path.basename(path), "fotogrammi": _image_info(ds)["fotogrammi"], "istanza": 0, "posizione": None}] if ds.get("Rows") else [])
    lst = [{k: v for k, v in s.items() if k != "file"} | {"n": len(s["file"])} for s in series.values()]
    first = _read(slices[0]["path"]) if slices else ds
    res = _result(first if uid else ds, slices, lst, my_uid)
    res["indice"] = next((i for i, s in enumerate(slices) if os.path.samefile(s["path"], path)), 0) if not uid else 0
    return res


def _result(ds, slices, series, uid, dicomdir=False):
    for s in series:
        s.pop("file", None) if not dicomdir else s.update(n=len(s.pop("file")))
    # una sola immagine multi-fotogramma = sezioni del file stesso
    frames = []
    for i, s in enumerate(slices):
        for f in range(max(1, s["fotogrammi"])):
            frames.append({"s": i, "f": f})
    return {"ok": True, "riepilogo": _summary(ds), "immagine": _image_info(ds), "sezioni": slices, "fotogrammi": frames,
            "serie": series, "uid": uid, "dicomdir": dicomdir, "senza_immagini": not slices}


def frame(path: str, index: int = 0) -> tuple[bytes, dict]:
    """Pixel di un fotogramma con la LUT di modalita' (valori reali, es. HU) o RGB a 8 bit."""
    import numpy as np
    pyd = _pyd()
    from pydicom.pixels import apply_modality_lut, apply_color_lut
    ds = pyd.dcmread(path, force=True)
    n = int(_num(ds.get("NumberOfFrames"), 1) or 1)
    index = max(0, min(n - 1, int(index)))
    arr = ds.pixel_array
    if n > 1:
        arr = arr[index]
    photo = _str(ds.get("PhotometricInterpretation")).upper()
    if photo == "PALETTE COLOR":
        arr = apply_color_lut(arr, ds)
        if arr.dtype != np.uint8:
            arr = (arr / 257).astype(np.uint8) if arr.max() > 255 else arr.astype(np.uint8)
    if arr.ndim == 3 and arr.shape[-1] in (3, 4):
        rgb = arr[..., :3]
        if rgb.dtype != np.uint8:
            mx = float(rgb.max()) or 1.0
            rgb = (rgb.astype(np.float32) * (255.0 / (65535.0 if mx > 255 else 255.0))).clip(0, 255).astype(np.uint8)
        h, w = rgb.shape[:2]
        return np.ascontiguousarray(rgb).tobytes(), {"X-W": str(w), "X-H": str(h), "X-C": "3", "X-T": "u8"}
    info = _image_info(ds)
    if "RescaleSlope" in ds or "RescaleIntercept" in ds or "ModalityLUTSequence" in ds:
        out = apply_modality_lut(arr, ds)
    else:
        out = arr.astype(np.float64) * info["pendenza"] + info["intercetta"]
    out = np.asarray(out)
    h, w = out.shape[:2]
    if np.all(np.mod(out, 1) == 0) and out.min() >= -32768 and out.max() <= 32767:
        data, t = out.astype("<i2").tobytes(), "i16"
    else:
        data, t = out.astype("<f4").tobytes(), "f32"
    return data, {"X-W": str(w), "X-H": str(h), "X-C": "1", "X-T": t}


def _val(el) -> str:
    vr = el.VR
    if el.tag in (0x7FE00010, 0x7FE00008, 0x7FE00009):
        return f"<dati dei pixel: {len(el.value or b'')} byte>" if isinstance(el.value, (bytes, bytearray)) else "<dati dei pixel>"
    v = el.value
    if vr in ("OB", "OW", "OF", "OD", "OL", "OV", "UN") or isinstance(v, (bytes, bytearray)):
        b = bytes(v or b"")
        return f"<{len(b)} byte> " + b[:24].hex(" ") + (" ..." if len(b) > 24 else "")
    if vr == "PN":
        return _person(v)
    if vr == "UI":
        name = getattr(v, "name", "")
        return f"{v}" + (f"  ({name})" if name and name != str(v) else "")
    if vr == "DA":
        return _date(v)
    s = str(v) if not (hasattr(v, "__iter__") and not isinstance(v, str)) else " \\ ".join(str(x) for x in v)
    return s if len(s) <= 1000 else s[:1000] + " ..."


def _tags_of(ds, depth, out, limit=20000):
    for el in ds:
        if len(out) >= limit:
            return
        row = {"tag": f"({el.tag.group:04X},{el.tag.element:04X})", "nome": el.name if el.name else el.keyword,
               "vr": el.VR, "livello": depth, "privato": el.tag.is_private}
        if el.VR == "SQ":
            row["valore"] = f"{len(el.value)} elementi"
            out.append(row)
            for i, item in enumerate(el.value):
                out.append({"tag": "", "nome": f"Elemento {i + 1}", "vr": "", "livello": depth + 1, "valore": "", "voce": True})
                _tags_of(item, depth + 2, out, limit)
        else:
            try:
                row["valore"] = _val(el)
            except Exception as e:  # noqa: BLE001
                row["valore"] = f"<non leggibile: {e}>"
            out.append(row)


def tags(path: str) -> dict:
    ds = _read(path)
    out = []
    meta = getattr(ds, "file_meta", None)
    if meta:
        _tags_of(meta, 0, out)
    _tags_of(ds, 0, out)
    return {"ok": True, "tag": out}
