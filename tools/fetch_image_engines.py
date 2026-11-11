"""Scarica i motori del miglioramento foto e della generazione di immagini in bin/ (non vanno nel repository).

Uso:  python tools/fetch_image_engines.py [--forza]

- bin/realesrgan  = realesrgan-ncnn-vulkan (github.com/xinntao/Real-ESRGAN, BSD-3-Clause; ncnn BSD-3-Clause) con i modelli
                    realesrgan-x4plus (foto) e realesrgan-x4plus-anime (disegni). Solo Windows x64: su ARM64 gira in emulazione.
- bin/sd/vulkan   = stable-diffusion.cpp (github.com/leejet/stable-diffusion.cpp, MIT; ggml MIT) con il motore Vulkan
- bin/sd/cpu      = la stessa versione solo processore (ripiego: schede senza Vulkan o non idonee)
Il modello di Stable Diffusion NON e' qui: l'app lo scarica la prima volta (mbvisual/immagini.py, MODELLI).
Versioni e impronte fisse: cambiarle qui e rilanciare. build_portable.py lo chiama da solo se mancano.
"""
import hashlib
import io
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "bin"

ESRGAN = ("https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip",
          "abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d")
SD_TAG = "master-1079-a3c49b1"
SD = {
    "vulkan": (f"https://github.com/leejet/stable-diffusion.cpp/releases/download/{SD_TAG}/sd-master-a3c49b1-bin-win-vulkan-x64.zip",
               "60991b744e21add68625c27386e3a6dbcfc72929a3101880cb4863f5f1e6c013"),
    "cpu": (f"https://github.com/leejet/stable-diffusion.cpp/releases/download/{SD_TAG}/sd-master-a3c49b1-bin-win-cpu-x64.zip",
            "0810a923711e87ce4aac487b598aa1698ff38b20380b17f0b0a2ac23f34e6a72"),
}
ESRGAN_KEEP = ("realesrgan-ncnn-vulkan.exe", "vcomp140.dll", "models/realesrgan-x4plus.bin", "models/realesrgan-x4plus.param",
               "models/realesrgan-x4plus-anime.bin", "models/realesrgan-x4plus-anime.param")
CACHE = Path.home() / ".mbvisual" / "motori-immagini" / "dl"

LICENZE = {
    "realesrgan": "Real-ESRGAN ncnn Vulkan - https://github.com/xinntao/Real-ESRGAN - BSD 3-Clause License\n"
                  "Copyright (c) 2021, Xintao Wang. ncnn: Copyright (C) 2017 THL A29 Limited, BSD 3-Clause.\n",
    "sd": "stable-diffusion.cpp - https://github.com/leejet/stable-diffusion.cpp - MIT License, Copyright (c) 2023 leejet\n"
          "ggml - https://github.com/ggml-org/ggml - MIT License, Copyright (c) 2023-2024 The ggml authors\n",
}


def _get(url, sha):
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / url.rsplit("/", 1)[1]
    if not f.exists() or hashlib.sha256(f.read_bytes()).hexdigest() != sha:
        print("scarico", url)
        req = urllib.request.Request(url, headers={"User-Agent": "MB-Desk-build"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
        if hashlib.sha256(data).hexdigest() != sha:
            raise SystemExit(f"impronta diversa per {url}")
        f.write_bytes(data)
    return zipfile.ZipFile(io.BytesIO(f.read_bytes()))


def fetch(force=False):
    esr = BIN / "realesrgan"
    if force or not (esr / "realesrgan-ncnn-vulkan.exe").exists():
        shutil.rmtree(esr, ignore_errors=True)
        z = _get(*ESRGAN)
        for info in z.infolist():
            rel = next((k for k in ESRGAN_KEEP if info.filename == k or info.filename.endswith("/" + k)), None)
            if rel:
                (esr / rel).parent.mkdir(parents=True, exist_ok=True)
                (esr / rel).write_bytes(z.read(info))
        (esr / "LICENZA.txt").write_text(LICENZE["realesrgan"], encoding="utf-8")
    for kind, (url, sha) in SD.items():
        d = BIN / "sd" / kind
        if force or not (d / "sd-cli.exe").exists():
            shutil.rmtree(d, ignore_errors=True)
            d.mkdir(parents=True)
            z = _get(url, sha)
            for info in z.infolist():
                n = info.filename.rsplit("/", 1)[-1]
                if n.lower().endswith((".exe", ".dll", ".txt")) and n != "sd-server.exe":
                    (d / n).write_bytes(z.read(info))
            (d / "LICENZA.txt").write_text(LICENZE["sd"], encoding="utf-8")
    print("motori immagini pronti in", BIN)


if __name__ == "__main__":
    fetch("--forza" in sys.argv)
