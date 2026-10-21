"""Installa il motore IA di MB Visual su un PC: ambiente Python dedicato + librerie + modelli (circa 8 GB).

  python tools/ia_setup.py [cartella]      (predefinita: %LOCALAPPDATA%\\MBVisual\\ia; sviluppo: %USERPROFILE%\\.mbvisual\\ia)

Serve un Python 3.13 installato: sui PC Snapdragon quello ARM64 (python.org, "Windows installer (ARM64)"), altrove x64.
PyTorch: ARM64 dall'archivio ufficiale download.pytorch.org (CPU); x64 con scheda NVIDIA la versione CUDA, altrimenti CPU.
Modelli (licenze che permettono l'uso commerciale):
  Realistic Vision 6.0 + inpainting (CreativeML OpenRAIL-M), VAE sd-vae-ft-mse (MIT), LCM-LoRA SD1.5 (OpenRAIL++),
  BiRefNet ONNX (MIT), SegFormer-B3 abbigliamento (MIT), LaMa ONNX (Apache-2.0), Real-ESRGAN x4plus (BSD-3),
  CLIP ViT-B/32 (MIT, controllo eta').
"""
import os
import platform
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

PKGS = ["diffusers", "transformers", "accelerate", "safetensors", "huggingface_hub", "hf_xet", "peft", "pillow", "numpy", "onnxruntime", "psutil"]
HF = [
    ("SG161222/Realistic_Vision_V6.0_B1_noVAE", ["Realistic_Vision_V6.0_NV_B1_fp16.safetensors", "Realistic_Vision_V6.0_NV_B1_inpainting_fp16.safetensors"], None),
    ("stabilityai/sd-vae-ft-mse", ["config.json", "diffusion_pytorch_model.safetensors"], None),
    ("latent-consistency/lcm-lora-sdv1-5", ["pytorch_lora_weights.safetensors"], None),
    ("onnx-community/BiRefNet-ONNX", ["onnx/model.onnx"], None),
    ("sayeed99/segformer_b3_clothes", ["config.json", "preprocessor_config.json", "model.safetensors"], None),
    ("Carve/LaMa-ONNX", ["lama_fp32.onnx"], "lama"),
    ("openai/clip-vit-base-patch32", ["config.json", "preprocessor_config.json", "tokenizer_config.json", "tokenizer.json", "vocab.json", "merges.txt",
                                      "special_tokens_map.json", "pytorch_model.bin"], None),
]
ESRGAN = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"


def find_python():
    arm = platform.machine().upper() in ("ARM64", "AARCH64") or "ARM" in os.environ.get("PROCESSOR_IDENTIFIER", "").upper()
    base = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Python"
    for name in (["Python313-arm64", "Python312-arm64"] if arm else []) + ["Python313", "Python313-x64", "Python312"]:
        p = base / name / "python.exe"
        if p.is_file():
            return str(p), arm and "arm64" in name
    if not arm:
        return sys.executable, False
    raise SystemExit("Serve Python 3.13 per ARM64 (python.org -> Windows installer ARM64)")


def run(*a):
    print(">", " ".join(map(str, a)), flush=True)
    subprocess.run(list(map(str, a)), check=True)


def main():
    dest = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(os.environ["LOCALAPPDATA"]) / "MBVisual" / "ia"
    dest.mkdir(parents=True, exist_ok=True)
    py, arm = find_python()
    venv = dest / "venv"
    if not (venv / "Scripts" / "python.exe").is_file():
        run(py, "-m", "venv", venv)
    vpy = venv / "Scripts" / "python.exe"
    run(vpy, "-m", "pip", "install", "--upgrade", "pip")
    if arm:
        run(vpy, "-m", "pip", "install", "torch", "--index-url", "https://download.pytorch.org/whl/cpu")
    elif shutil.which("nvidia-smi"):
        run(vpy, "-m", "pip", "install", "torch", "--index-url", "https://download.pytorch.org/whl/cu126")
    else:
        run(vpy, "-m", "pip", "install", "torch", "--index-url", "https://download.pytorch.org/whl/cpu")
    run(vpy, "-m", "pip", "install", *PKGS)
    models = dest / "modelli"
    code = (
        "import os,sys,time\nfrom huggingface_hub import hf_hub_download\n"
        f"dst={str(models)!r}\njobs={HF!r}\n"
        "for rid,fns,d in jobs:\n  for fn in fns:\n    for t in range(30):\n      try:\n"
        "        p=hf_hub_download(rid,fn,local_dir=os.path.join(dst,d or rid.split('/')[1])); print('ok',rid,fn,flush=True); break\n"
        "      except Exception as e: print('riprovo',fn,type(e).__name__,flush=True); time.sleep(15)\n")
    run(vpy, "-c", code)
    f = models / "realesrgan" / "RealESRGAN_x4plus.pth"
    if not f.is_file():
        f.parent.mkdir(parents=True, exist_ok=True)
        print("> Real-ESRGAN", flush=True)
        urllib.request.urlretrieve(ESRGAN, f)
    print("\nMotore IA installato in", dest)


if __name__ == "__main__":
    main()
