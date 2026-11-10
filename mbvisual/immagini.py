"""Miglioramento delle foto (Real-ESRGAN) e creazione di immagini da una descrizione (Stable Diffusion), tutto in locale.

Motori nel pacchetto (tools/fetch_image_engines.py, versioni fisse):
- bin/realesrgan/realesrgan-ncnn-vulkan.exe  (BSD-3-Clause) con i modelli realesrgan-x4plus (foto) e -anime (disegni)
- bin/sd/vulkan/sd-cli.exe e bin/sd/cpu/sd-cli.exe  (stable-diffusion.cpp, MIT): motore Vulkan e ripiego solo processore
Modello di Stable Diffusion 1.5 (CreativeML OpenRAIL-M: uso commerciale permesso) e LCM-LoRA (OpenRAIL++) scaricati la prima
volta in DATA_DIR/immagini/modelli con impronta controllata. Nessun filtro sul contenuto: non c'e' safety checker.

Prima di partire si guarda la scheda video IN LOCALE (Vulkan via ctypes in un processo figlio, cosi' un driver difettoso non
ferma l'app; ripiego sul registro di Windows): idonea per migliorare = qualsiasi scheda Vulkan vera; idonea per generare =
NVIDIA o AMD con almeno 8 GB. Non idonea = l'interfaccia chiede "Procedo lo stesso?", la riga di comando esce con codice 3
se manca --anche-lenta.

Riga di comando (app.py, accanto a --miniatura):
  --migliora <foto> <uscita.png> [2|3|4] [--disegno] [--anche-lenta]
  --genera "<descrizione>" <uscita.png> [larghezza altezza] [--negativo "..."] [--passi n] [--seme n] [--anche-lenta]
  --scheda-video   -> JSON su stdout
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path

from .i18n import t
from .paths import BIN_DIR, DATA_DIR, IS_WIN, NO_WINDOW, TEMP_DIR

ESR_EXE = BIN_DIR / "realesrgan" / "realesrgan-ncnn-vulkan.exe"
SD_EXE = {"vulkan": BIN_DIR / "sd" / "vulkan" / "sd-cli.exe", "cpu": BIN_DIR / "sd" / "cpu" / "sd-cli.exe"}
MODELS_DIR = DATA_DIR / "immagini" / "modelli"
WORK_DIR = TEMP_DIR / "immagini"

_HF = "https://huggingface.co"
MODELLI = {
    "sd15": {"file": "stable-diffusion-v1-5-Q8_0.gguf", "size": 1763578176,
             "sha256": "d0555243938c62faeefb4ac93f6c7a053ad373a4290c5256bce229aeb193bf94",
             "url": f"{_HF}/second-state/stable-diffusion-v1-5-GGUF/resolve/031b5f5df991f511b3f5fa8fed6d99048ababb69/"
                    "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf"},
    "lcm": {"file": "lcm-lora-sdv1-5.safetensors", "size": 134621556,
            "sha256": "8f90d840e075ff588a58e22c6586e2ae9a6f7922996ee6649a7f01072333afe4",
            "url": f"{_HF}/latent-consistency/lcm-lora-sdv1-5/resolve/cf2fced511dbe7e26c8d1d397e728fbab875db4b/"
                   "pytorch_lora_weights.safetensors"},
}
NVIDIA, AMD, INTEL = 0x10DE, 0x1002, 0x8086
MIN_GB_GENERA = 7.5  # "almeno 8 GB": le schede da 8 GB dichiarano qualche centinaio di MB in meno


class NonIdonea(Exception):
    """Scheda video non idonea e nessuna conferma: la riga di comando esce con codice 3."""


class Annullato(Exception):
    pass


def frase_non_idonea() -> str:
    return t("srv_immagini.non_idonea")


# ------------------------------------------------------------------ scheda video
def _vk_enumerate() -> list[dict]:
    """Dispositivi Vulkan con ctypes (vulkan-1.dll del sistema). Da chiamare in un processo figlio."""
    import ctypes as C
    lib = C.WinDLL("vulkan-1.dll") if IS_WIN else C.CDLL("libvulkan.so.1")

    class AppInfo(C.Structure):
        _fields_ = [("sType", C.c_int), ("pNext", C.c_void_p), ("pApplicationName", C.c_char_p), ("applicationVersion", C.c_uint32),
                    ("pEngineName", C.c_char_p), ("engineVersion", C.c_uint32), ("apiVersion", C.c_uint32)]

    class CreateInfo(C.Structure):
        _fields_ = [("sType", C.c_int), ("pNext", C.c_void_p), ("flags", C.c_uint32), ("pApplicationInfo", C.POINTER(AppInfo)),
                    ("enabledLayerCount", C.c_uint32), ("ppEnabledLayerNames", C.c_void_p),
                    ("enabledExtensionCount", C.c_uint32), ("ppEnabledExtensionNames", C.c_void_p)]

    app = AppInfo(0, None, b"MB Desk", 1, b"MB Desk", 1, (1 << 22) | (1 << 12))  # Vulkan 1.1
    ci = CreateInfo(1, None, 0, C.pointer(app), 0, None, 0, None)
    inst = C.c_void_p()
    if lib.vkCreateInstance(C.byref(ci), None, C.byref(inst)) != 0:
        return []
    out = []
    try:
        n = C.c_uint32(0)
        lib.vkEnumeratePhysicalDevices(inst, C.byref(n), None)
        devs = (C.c_void_p * max(1, n.value))()
        lib.vkEnumeratePhysicalDevices(inst, C.byref(n), devs)
        for i in range(n.value):
            props = (C.c_ubyte * 4096)()
            lib.vkGetPhysicalDeviceProperties(C.c_void_p(devs[i]), props)
            raw = bytes(props)
            vendor, device, dtype = (int.from_bytes(raw[o:o + 4], "little") for o in (8, 12, 16))
            name = raw[20:276].split(b"\0", 1)[0].decode("utf-8", "replace")
            mem = (C.c_ubyte * 1024)()
            lib.vkGetPhysicalDeviceMemoryProperties(C.c_void_p(devs[i]), mem)
            m = bytes(mem)
            heaps = int.from_bytes(m[260:264], "little")
            local = 0
            for h in range(min(heaps, 16)):
                size = int.from_bytes(m[264 + 16 * h:272 + 16 * h], "little")
                flags = int.from_bytes(m[272 + 16 * h:276 + 16 * h], "little")
                if flags & 1:
                    local = max(local, size)
            out.append({"indice": i, "nome": name, "vendor": vendor, "device": device, "tipo": dtype, "memoria": local})
    finally:
        lib.vkDestroyInstance(inst, None)
    return out


def _registry_gpus() -> list[dict]:
    """Ripiego senza Vulkan: schede dal registro di Windows (memoria a 64 bit, AdapterRAM di WMI si ferma a 4 GB)."""
    if not IS_WIN:
        return []
    import winreg
    res = []
    key = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
    try:
        root = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key)
    except OSError:
        return []
    for i in range(64):
        try:
            sub = winreg.EnumKey(root, i)
        except OSError:
            break
        if not sub.isdigit():
            continue
        try:
            k = winreg.OpenKey(root, sub)
            name = winreg.QueryValueEx(k, "DriverDesc")[0]
            try:
                mem = int(winreg.QueryValueEx(k, "HardwareInformation.qwMemorySize")[0])
            except OSError:
                try:
                    v = winreg.QueryValueEx(k, "HardwareInformation.MemorySize")[0]
                    mem = int.from_bytes(v, "little") if isinstance(v, bytes) else int(v)
                except OSError:
                    mem = 0
            mid = str(winreg.QueryValueEx(k, "MatchingDeviceId")[0]).upper()
            vm = re.search(r"VEN_([0-9A-F]{4})", mid)
            res.append({"nome": name, "vendor": int(vm.group(1), 16) if vm else 0, "memoria": mem})
        except OSError:
            continue
    return res


_CACHE: dict = {}


def _child_cmd(flag: str) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, flag]
    return [sys.executable, "-m", "mbvisual.immagini", flag]


def _vk_devices() -> list[dict] | None:
    """Dispositivi Vulkan letti in un processo figlio (None = Vulkan non utilizzabile)."""
    if "vk" in _CACHE:
        return _CACHE["vk"]
    devs = None
    try:
        env = {**os.environ, "VK_LOADER_DEBUG": "none"}
        r = subprocess.run(_child_cmd("--vk-elenco"), capture_output=True, timeout=30, creationflags=NO_WINDOW, env=env,
                           cwd=str(Path(__file__).resolve().parent.parent) if not getattr(sys, "frozen", False) else None)
        line = [x for x in r.stdout.decode("utf-8", "replace").splitlines() if x.startswith("@@VK ")]
        if line:
            devs = json.loads(line[-1][5:])
    except Exception as e:  # noqa: BLE001
        print("controllo Vulkan non riuscito:", e)
    _CACHE["vk"] = devs
    return devs


def _best(devs: list[dict]) -> dict | None:
    real = [d for d in devs if d["tipo"] in (1, 2, 3)]  # integrata, dedicata, virtuale (4 = processore, 0 = altro)
    if not real:
        return None
    # dedicata prima, poi la memoria propria piu' grande
    return sorted(real, key=lambda d: (d["tipo"] != 2, -d["memoria"]))[0]


def scheda_video(force: bool = False) -> dict:
    if force:
        _CACHE.clear()
    if "sv" in _CACHE:
        return dict(_CACHE["sv"])
    devs = _vk_devices() or []
    best = _best(devs)
    res = {"idonea_migliora": False, "idonea_genera": False, "nome": "", "memoria_gb": 0, "motivo": "",
           "vulkan": bool(best), "dispositivi": [{k: d[k] for k in ("indice", "nome", "tipo")} | {"memoria_gb": round(d["memoria"] / 2**30, 1)} for d in devs]}
    if best:
        gb = round(best["memoria"] / 2**30, 1)
        res.update(nome=best["nome"], memoria_gb=gb, indice=best["indice"], vendor=best["vendor"])
        res["idonea_migliora"] = True
        gen = [d for d in devs if d["tipo"] in (1, 2) and d["vendor"] in (NVIDIA, AMD) and d["memoria"] >= MIN_GB_GENERA * 2**30]
        if gen:
            g = sorted(gen, key=lambda d: -d["memoria"])[0]
            res.update(idonea_genera=True, nome=g["nome"], memoria_gb=round(g["memoria"] / 2**30, 1), indice=g["indice"], vendor=g["vendor"])
            res["motivo"] = t("srv_immagini.motivo_idonea", res["nome"], res["memoria_gb"])
        elif best["vendor"] not in (NVIDIA, AMD):
            res["motivo"] = t("srv_immagini.motivo_marca", best["nome"])
        else:
            res["motivo"] = t("srv_immagini.motivo_memoria", best["nome"], gb)
    else:
        regs = sorted(_registry_gpus(), key=lambda d: -d["memoria"])
        if regs:
            res.update(nome=regs[0]["nome"], memoria_gb=round(regs[0]["memoria"] / 2**30, 1))
        res["motivo"] = t("srv_immagini.motivo_vulkan")
    _CACHE["sv"] = res
    return dict(res)


# ------------------------------------------------------------------ processi e annullamento
_RUN: dict[str, dict] = {}
_LOCK = threading.Lock()


def annulla(rid: str) -> dict:
    with _LOCK:
        r = _RUN.get(rid)
    if r:
        r["stop"] = True
        p = r.get("proc")
        if p and p.poll() is None:
            try:
                p.kill()
            except OSError:
                pass
    return {"ok": True, "trovato": bool(r)}


def _check(rid):
    r = _RUN.get(rid)
    if r and r.get("stop"):
        raise Annullato(t("srv_immagini.annullato"))


def _run(rid: str, cmd: list[str], on_text, env=None, cwd=None) -> tuple[int, str]:
    """Avvia un motore e passa a on_text ogni pezzo di uscita (righe separate da \\r o \\n). Restituisce codice e coda dell'uscita."""
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW,
                         env=env, cwd=cwd)
    with _LOCK:
        _RUN.setdefault(rid, {})["proc"] = p
    tail, buf = [], b""
    while True:
        ch = p.stdout.read1(4096) if hasattr(p.stdout, "read1") else p.stdout.read(1)
        if not ch:
            break
        buf += ch
        parts = re.split(rb"[\r\n]", buf)
        buf = parts.pop()
        for part in parts:
            s = part.decode("utf-8", "replace").strip()
            if s:
                tail = (tail + [s])[-40:]
                on_text(s)
    p.wait()
    if buf.strip():
        tail.append(buf.decode("utf-8", "replace").strip())
    _check(rid)
    return p.returncode, "\n".join(tail)


# ------------------------------------------------------------------ miglioramento foto (Real-ESRGAN)
def migliora(src: str, out: str, scala: int = 4, modello: str = "foto", anche_lenta: bool = False, rid: str | None = None,
             update=None) -> dict:
    from PIL import Image, ImageOps
    update = update or (lambda *a, **k: None)
    rid = rid or uuid.uuid4().hex
    scala = int(scala)
    if scala not in (2, 3, 4):
        raise ValueError(t("srv_immagini.scala_non_valida"))
    if not ESR_EXE.exists():
        raise RuntimeError(t("srv_immagini.motore_mancante", "Real-ESRGAN"))
    sv = scheda_video()
    if not sv["idonea_migliora"] and not anche_lenta:
        raise NonIdonea(frase_non_idonea())
    _RUN[rid] = {"stop": False}
    work = WORK_DIR / uuid.uuid4().hex
    work.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    try:
        update(0.0, t("srv_immagini.preparo"))
        im = ImageOps.exif_transpose(Image.open(src))
        im.load()
        alpha = None
        if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
            im = im.convert("RGBA")
            alpha = im.getchannel("A")
            if alpha.getextrema() == (255, 255):
                alpha = None
        rgb = im.convert("RGB")
        w, h = rgb.size
        inp, o4 = work / "ingresso.png", work / "uscita.png"
        rgb.save(inp)
        name = "realesrgan-x4plus-anime" if modello in ("disegno", "anime") else "realesrgan-x4plus"
        base = [str(ESR_EXE), "-i", str(inp), "-o", str(o4), "-n", name, "-s", "4", "-f", "png", "-m", str(ESR_EXE.parent / "models")]
        if sv.get("indice") is not None:
            base += ["-g", str(sv["indice"])]

        def prog(s):
            m = re.match(r"^(\d+(?:[.,]\d+)?)%$", s)
            if m:
                update(0.05 + 0.85 * float(m.group(1).replace(",", ".")) / 100, t("srv_immagini.miglioro"))
        # tessere: "automatica" sceglie la misura dalla memoria dichiarata; sulle schede integrate (Adreno, Intel...) con tessere
        # grandi il risultato esce nero senza errori, quindi li' si parte da 128 e un risultato vuoto si rifa' con tessere piu' piccole
        tiles = ["0", "128", "64"] if sv.get("vendor") in (NVIDIA, AMD) else ["128", "64", "32"]
        src_lit = rgb.convert("L").getextrema()[1] > 8
        for tile in tiles:
            o4.unlink(missing_ok=True)
            update(0.05, t("srv_immagini.miglioro"))
            code, tail = _run(rid, base + ["-t", tile], prog, cwd=str(ESR_EXE.parent))
            if code == 0 and o4.exists():
                with Image.open(o4) as chk:
                    if not src_lit or chk.convert("L").getextrema()[1] > 8:
                        break
                print("Real-ESRGAN: risultato vuoto con tessere", tile)
        else:
            raise RuntimeError(t("srv_immagini.errore_motore", "Real-ESRGAN", _last_line(tail) if code else t("srv_immagini.risultato_vuoto")))
        update(0.92, t("srv_immagini.salvo"))
        big = Image.open(o4).convert("RGB")
        nw, nh = w * scala, h * scala
        if big.size != (nw, nh):
            big = big.resize((nw, nh), Image.LANCZOS)
        if alpha is not None:
            big.putalpha(alpha.resize((nw, nh), Image.LANCZOS))
        _save(big, out)
        return {"ok": True, "out": str(out), "larghezza": nw, "altezza": nh, "secondi": round(time.time() - t0, 1),
                "scheda": sv.get("nome", ""), "modello": name}
    finally:
        _RUN.pop(rid, None)
        shutil.rmtree(work, ignore_errors=True)


def _last_line(tail: str) -> str:
    lines = [x for x in tail.splitlines() if x.strip() and not x.startswith("WARNING: [Loader")]
    return lines[-1][:300] if lines else "?"


def _save(img, out):
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    ext = out.suffix.lower()
    if ext in (".jpg", ".jpeg"):
        img.convert("RGB").save(out, quality=95)
    elif ext in (".png", ""):
        img.save(out, "PNG", compress_level=4)
    else:
        img.save(out)


# ------------------------------------------------------------------ modelli scaricati la prima volta
def model_path(key: str) -> Path:
    return MODELS_DIR / MODELLI[key]["file"]


def stato_modelli() -> dict:
    return {k: {"presente": model_path(k).exists(), "byte": m["size"]} for k, m in MODELLI.items()}


def ensure_model(key: str, update=None, rid: str | None = None, base: float = 0.0, span: float = 1.0) -> Path:
    m = MODELLI[key]
    dst = model_path(key)
    if dst.exists() and dst.stat().st_size == m["size"]:
        return dst
    update = update or (lambda *a, **k: None)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    part = dst.with_suffix(dst.suffix + ".part")
    for tentativo in range(5):
        have = part.stat().st_size if part.exists() else 0
        if have > m["size"]:
            part.unlink()
            have = 0
        if have < m["size"]:
            req = urllib.request.Request(m["url"], headers={"User-Agent": "MB-Desk", **({"Range": f"bytes={have}-"} if have else {})})
            try:
                with urllib.request.urlopen(req, timeout=60) as r, open(part, "ab" if have and r.status == 206 else "wb") as f:
                    if r.status != 206:
                        have = 0
                    last = 0.0
                    while True:
                        if rid:
                            _check(rid)
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        have += len(chunk)
                        now = time.time()
                        if now - last > 0.3:
                            last = now
                            update(base + span * have / m["size"], t("srv_immagini.scarico_modello", round(have / 2**20), round(m["size"] / 2**20)))
            except Annullato:
                raise
            except Exception as e:  # noqa: BLE001
                if tentativo == 4:
                    raise RuntimeError(t("srv_immagini.download_fallito", str(e)))
                time.sleep(2 * (tentativo + 1))
                continue
        if part.stat().st_size == m["size"]:
            update(base + span, t("srv_immagini.verifico_modello"))
            hsh = hashlib.sha256()
            with open(part, "rb") as f:
                for b in iter(lambda: f.read(1 << 22), b""):
                    hsh.update(b)
            if hsh.hexdigest() != m["sha256"]:
                part.unlink()
                raise RuntimeError(t("srv_immagini.modello_corrotto"))
            os.replace(part, dst)
            return dst
    raise RuntimeError(t("srv_immagini.download_fallito", "?"))


# ------------------------------------------------------------------ creazione di immagini (stable-diffusion.cpp)
def _round64(v: int) -> int:
    return max(256, min(1024, int(round(v / 64.0)) * 64))


def genera(descrizione: str, out: str, larghezza: int = 512, altezza: int = 512, negativo: str = "", passi: int | None = None,
           seme: int = -1, anche_lenta: bool = False, rid: str | None = None, update=None, motore: str | None = None) -> dict:
    from PIL import Image
    update = update or (lambda *a, **k: None)
    rid = rid or uuid.uuid4().hex
    descrizione = (descrizione or "").strip()
    if not descrizione:
        raise ValueError(t("srv_immagini.descrizione_vuota"))
    sv = scheda_video()
    if not sv["idonea_genera"] and not anche_lenta:
        raise NonIdonea(frase_non_idonea())
    larghezza, altezza = int(larghezza or 512), int(altezza or 512)
    if larghezza < 16 or altezza < 16 or larghezza > 8192 or altezza > 8192:
        raise ValueError(t("srv_immagini.dimensioni_non_valide"))
    _RUN[rid] = {"stop": False}
    t0 = time.time()
    work = WORK_DIR / uuid.uuid4().hex
    work.mkdir(parents=True, exist_ok=True)
    try:
        # motore: Vulkan sulle schede vere con memoria sufficiente, altrimenti solo processore con LCM (6 passi invece di 25)
        if motore is None:
            gpu_ok = sv.get("vulkan") and (sv["idonea_genera"] or (sv.get("vendor") in (NVIDIA, AMD, INTEL) and sv.get("memoria_gb", 0) >= 3.5))
            motore = "vulkan" if gpu_ok else "cpu"
        veloce = motore == "cpu"
        need = ["sd15"] + (["lcm"] if veloce else [])
        tot = sum(MODELLI[k]["size"] for k in need if not model_path(k).exists())
        done = 0
        for k in need:
            if not model_path(k).exists():
                sz = MODELLI[k]["size"]
                ensure_model(k, update, rid, 0.3 * done / tot, 0.3 * sz / tot)
                done += sz
        base = 0.3 if tot else 0.0
        # SD 1.5 lavora bene attorno a 512: lato lungo al massimo 768, poi si ingrandisce alla misura chiesta
        k = min(1.0, 768 / max(larghezza, altezza))
        gw, gh = _round64(larghezza * k), _round64(altezza * k)
        steps = int(passi or (6 if veloce else 25))
        o = work / "generata.png"
        prompt = descrizione + (" <lora:lcm-lora-sdv1-5:1>" if veloce else "")
        cmd = ["-m", str(model_path("sd15")), "-p", prompt, "-W", str(gw), "-H", str(gh), "--steps", str(steps),
               "-s", str(int(seme)), "-o", str(o)]
        if negativo:
            cmd += ["-n", negativo]
        if veloce:
            cmd += ["--lora-model-dir", str(MODELS_DIR), "--sampling-method", "lcm", "--cfg-scale", "1.5"]
        else:
            cmd += ["--sampling-method", "euler_a", "--cfg-scale", "7"]

        def prog(s):
            m = re.search(r"(\d+)/(\d+)\s*-\s*[\d.]+\s*(?:s/it|it/s)", s)
            if m and int(m.group(2)) == steps:
                update(base + (0.95 - base) * int(m.group(1)) / steps, t("srv_immagini.genero_passo", m.group(1), steps))
            elif "loading" in s.lower() or "load" in s.lower() and "model" in s.lower():
                update(base + 0.01, t("srv_immagini.carico_modello"))
            elif "decod" in s.lower():
                update(0.96, t("srv_immagini.decodifico"))
        exe = SD_EXE[motore]
        if not exe.exists():
            raise RuntimeError(t("srv_immagini.motore_mancante", "stable-diffusion.cpp"))
        env = dict(os.environ)
        if motore == "vulkan" and sv.get("indice") is not None:
            env["GGML_VK_VISIBLE_DEVICES"] = str(sv["indice"])
        update(base, t("srv_immagini.carico_modello"))
        code, tail = _run(rid, [str(exe)] + cmd, prog, env=env, cwd=str(exe.parent))
        if code != 0 or not o.exists():
            print("sd-cli", motore, "non riuscito:", tail[-2000:])
            if motore == "vulkan":  # driver Vulkan che non regge: di nuovo sul processore (con i passi veloci)
                return genera(descrizione, out, larghezza, altezza, negativo, None, seme, True, rid, update, "cpu")
            raise RuntimeError(t("srv_immagini.errore_motore", "stable-diffusion.cpp", _last_line(tail)))
        img = Image.open(o)
        img.load()
        if img.size != (larghezza, altezza):
            img = img.resize((larghezza, altezza), Image.LANCZOS)
        _save(img, out)
        return {"ok": True, "out": str(out), "larghezza": larghezza, "altezza": altezza, "secondi": round(time.time() - t0, 1),
                "motore": motore, "passi": steps, "scheda": sv.get("nome", "")}
    finally:
        _RUN.pop(rid, None)
        shutil.rmtree(work, ignore_errors=True)


# ------------------------------------------------------------------ riga di comando
def _stdio(n: int):
    """stdout/stderr veri anche nell'eseguibile senza console (app.py li manda in un file di registro)."""
    if IS_WIN and getattr(sys, "frozen", False):
        try:
            import ctypes
            import msvcrt
            h = ctypes.windll.kernel32.GetStdHandle(-11 if n == 1 else -12)
            if h and h != -1:
                return open(msvcrt.open_osfhandle(h, os.O_WRONLY), "w", encoding="utf-8", buffering=1)
        except Exception:  # noqa: BLE001
            pass
    return sys.stdout if n == 1 else sys.stderr


def cli(argv: list[str]) -> int:
    out, err = _stdio(1), _stdio(2)
    args = list(argv[1:])

    def opt(name, default=None):
        if name in args:
            i = args.index(name)
            v = args[i + 1] if i + 1 < len(args) else default
            del args[i:i + 2]
            return v
        return default

    def flag(name):
        if name in args:
            args.remove(name)
            return True
        return False

    try:
        if flag("--vk-elenco"):
            try:
                print("@@VK " + json.dumps(_vk_enumerate()), file=out, flush=True)
            except Exception as e:  # noqa: BLE001
                print("@@VK []", file=out, flush=True)
                print(e, file=err)
            return 0
        if flag("--scheda-video"):
            sv = scheda_video()
            print(json.dumps({k: sv[k] for k in ("idonea_migliora", "idonea_genera", "nome", "memoria_gb", "motivo")}, ensure_ascii=False),
                  file=out, flush=True)
            return 0
        lenta = flag("--anche-lenta")

        def progress(p=None, msg=None):
            if msg:
                print(f"{round((p or 0) * 100):3d}% {msg}", file=err, flush=True)
        if flag("--migliora"):
            disegno = flag("--disegno")
            pos = [a for a in args if not a.startswith("--")]
            if len(pos) < 2:
                print(t("srv_immagini.uso_migliora"), file=err)
                return 1
            scala = int(pos[2]) if len(pos) > 2 else 4
            r = migliora(pos[0], pos[1], scala, "disegno" if disegno else "foto", lenta, update=progress)
            print(json.dumps(r, ensure_ascii=False), file=out, flush=True)
            return 0
        if flag("--genera"):
            neg = opt("--negativo", "")
            passi = opt("--passi")
            seme = opt("--seme", "-1")
            pos = [a for a in args if not a.startswith("--")]
            if len(pos) < 2:
                print(t("srv_immagini.uso_genera"), file=err)
                return 1
            w = int(pos[2]) if len(pos) > 2 else 512
            h = int(pos[3]) if len(pos) > 3 else 512
            r = genera(pos[0], pos[1], w, h, neg, int(passi) if passi else None, int(seme), lenta, update=progress)
            print(json.dumps(r, ensure_ascii=False), file=out, flush=True)
            return 0
    except NonIdonea as e:
        print(str(e), file=err, flush=True)
        return 3
    except Exception as e:  # noqa: BLE001
        print((str(e) or e.__class__.__name__).replace("\n", " "), file=err, flush=True)
        return 1
    print(t("srv_immagini.uso_migliora"), file=err)
    return 1


if __name__ == "__main__":
    sys.exit(cli(sys.argv))
