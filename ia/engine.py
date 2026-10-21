"""Motore IA di MB Visual: processo separato con PyTorch (Python ARM64 nativo sui PC Snapdragon, x64 + CUDA dove c'e'
una scheda NVIDIA). Lo avvia e lo interroga l'app (mbvisual/ia.py) su 127.0.0.1 con un codice d'accesso.

  python engine.py --models <cartella modelli> --out <cartella risultati> --token <codice>
  stampa "PORT <n>" e resta in ascolto.

Operazioni (POST /run, JSON):
  segment  {image}                         -> parti riconosciute (persona, capelli, viso, pelle, abbigliamento...) come maschere PNG
  subject  {image}                         -> maschera del soggetto (BiRefNet)
  removebg {image}                         -> immagine con sfondo trasparente
  erase    {image, mask}                   -> togli oggetto e ricostruisci lo sfondo
  fill     {image, mask, prompt, ...}      -> riempimento generativo nella zona (livello PNG + posizione)
  generate {prompt, width, height, ...}    -> immagine nuova da descrizione
  upscale  {image, scale}                  -> aumenta la risoluzione
GET /status, GET /progress.

Controlli (gli unici, concordati con l'utente): nessun minore; nessun atto sessuale esplicito. Nudo artistico/moda,
lingerie, costumi e pose sensuali sono ammessi.
"""
import argparse
import json
import os
import re
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image, ImageFilter

ARGS = None
LOCK = threading.Lock()
PROGRESS = {"p": 0.0, "msg": "", "busy": False}
MODELS = {}

# ---------------------------------------------------------------- controlli di sicurezza
BLOCK_TEXT = [r"bambin\w*", r"ragazzin[ao]\w*", r"minorenn\w*", r"child\w*", r"kids?", r"toddler\w*", r"infant\w*", r"teen\w*", r"underage",
              r"loli\w*", r"shota\w*", r"school ?girls?", r"school ?boys?", r"preteen\w*", r"\d{1,2} ?(?:years? old|anni)",
              r"porn\w*", r"hardcore", r"sex(?:ual)? (?:act|scene|intercourse)", r"sesso", r"rapporto sessuale", r"intercourse", r"penetra\w*",
              r"blowjob", r"handjob", r"cumshot", r"cum\b", r"masturbat\w*", r"orgasm\w*", r"fellatio", r"cunnilingus", r"genitals?",
              r"genital[ei]", r"vagina", r"vulva", r"penis", r"pene", r"erection", r"erezione"]
AGE_RE = re.compile(r"\b(\d{1,2}) ?(?:years? old|anni|yo)\b")


def check_text(prompt):
    low = (prompt or "").lower()
    for w in BLOCK_TEXT:
        m = re.search(r"\b" + w + r"\b", low)
        if not m:
            continue
        if w.startswith(r"\d"):  # un'eta' scritta: blocca solo se minore di 18
            a = AGE_RE.search(low)
            if a and int(a.group(1)) >= 18:
                continue
        raise ValueError("Richiesta non consentita: il motore IA non elabora minori ne' contenuti sessualmente espliciti.")


def check_minors(img, where):
    """Classificazione zero-shot con CLIP: blocca se nell'immagine c'e' con buona probabilita' un bambino o un adolescente."""
    clip = model_clip()
    if clip is None:
        raise ValueError("Manca il modello di controllo dell'eta' (CLIP): installalo da 'Motore IA' prima di usare le funzioni generative.")
    import torch
    proc, m = clip
    labels = ["a photo of a child", "a photo of a teenager", "a photo of an adult woman", "a photo of an adult man", "a photo of a landscape or object without people"]
    with torch.no_grad():
        out = m(**proc(text=labels, images=img.convert("RGB"), return_tensors="pt", padding=True))
        p = out.logits_per_image.softmax(-1)[0].tolist()
    if p[0] + p[1] > 0.45:
        raise ValueError(f"Elaborazione bloccata: {where} sembra contenere una persona minorenne.")


# ---------------------------------------------------------------- modelli (caricati una volta e tenuti in memoria)
def mpath(*p):
    return os.path.join(ARGS.models, *p)


def have(*p):
    return os.path.exists(mpath(*p))


def torch_setup():
    import torch
    torch.set_num_threads(os.cpu_count() or 8)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    return torch, dev, (torch.float16 if dev == "cuda" else torch.float32)


def model_clip():
    if "clip" not in MODELS:
        d = mpath("clip-vit-base-patch32")
        if not os.path.exists(os.path.join(d, "config.json")):
            return None
        from transformers import CLIPModel, CLIPProcessor
        # solo pytorch_model.bin per questo modello: transformers lo apre con torch.load(weights_only=True), nessun codice
        MODELS["clip"] = (CLIPProcessor.from_pretrained(d), CLIPModel.from_pretrained(d).eval())
    return MODELS["clip"]


def model_segformer():
    if "seg" not in MODELS:
        from transformers import SegformerForSemanticSegmentation
        d = mpath("segformer_b3_clothes")
        # il preprocessore di transformers richiede torchvision (assente su Windows ARM64): si prepara l'immagine qui
        MODELS["seg"] = SegformerForSemanticSegmentation.from_pretrained(d, use_safetensors=True).eval()
    return MODELS["seg"]


def seg_input(img):
    import torch
    x = np.asarray(img.convert("RGB").resize((512, 512), Image.BILINEAR), dtype=np.float32) / 255.0
    x = (x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
    return torch.from_numpy(x.transpose(2, 0, 1)[None].astype(np.float32))


def model_birefnet():
    if "bir" not in MODELS:
        import onnxruntime as ort
        MODELS["bir"] = ort.InferenceSession(mpath("BiRefNet-ONNX", "onnx", "model.onnx"), providers=["CPUExecutionProvider"])
    return MODELS["bir"]


def _vae(torch, dt):
    from diffusers import AutoencoderKL
    return AutoencoderKL.from_pretrained(mpath("sd-vae-ft-mse"), torch_dtype=dt)


def _speed(pipe, torch):
    """LCM-LoRA (4-8 passi) per le qualita' Veloce/Alta; DPM++ 2M Karras (25-30 passi) per la Massima.
    La LoRA non si fonde nei pesi: si accende e spegne a ogni richiesta (set_mode)."""
    from diffusers import DPMSolverMultistepScheduler, LCMScheduler
    pipe._mbv_dpm = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, use_karras_sigmas=True, algorithm_type="dpmsolver++")
    pipe._mbv_lcm = False
    if os.path.exists(mpath("lcm-lora-sdv1-5", "pytorch_lora_weights.safetensors")):
        pipe.load_lora_weights(mpath("lcm-lora-sdv1-5"), weight_name="pytorch_lora_weights.safetensors", adapter_name="lcm")
        pipe._mbv_lcmsched = LCMScheduler.from_config(pipe.scheduler.config)
        pipe._mbv_lcm = True
    pipe.scheduler = pipe._mbv_dpm
    return pipe


def set_mode(pipe, fast, base=None):
    """fast=True: LCM (pochi passi); False: DPM++ senza LoRA. `base` = pipeline che possiede la LoRA (per le derivate)."""
    b = base or pipe
    fast = bool(fast and b._mbv_lcm)
    if b._mbv_lcm:
        if fast:
            pipe.enable_lora()
            pipe.set_adapters(["lcm"], [1.0])
        else:
            pipe.disable_lora()
    pipe.scheduler = b._mbv_lcmsched if fast else b._mbv_dpm
    return fast


QUALITY = {"veloce": {"side": 512, "fast": True}, "alta": {"side": 768, "fast": True}, "massima": {"side": 768, "fast": False}}
REAL = ", RAW photo, dslr, detailed skin texture, skin pores, subtle film grain, sharp focus, natural colors"


def quality(a):
    q = a.get("qualita") or {"512": "veloce", "768": "alta"}.get(str(a.get("side") or ""), "alta")
    return QUALITY.get(q, QUALITY["alta"])


def realism(prompt):
    """Il risultato deve sembrare una foto: si aggiungono le parole che Realistic Vision associa alle foto vere."""
    p = (prompt or "").strip()
    return (p + REAL) if p else ""


def model_controlnet_inpaint():
    """Inpainting guidato dalla profondita' (ControlNet Depth): stesse parti della pipeline di inpainting + ControlNet."""
    if "cninp" not in MODELS:
        if not have("controlnet-depth", "diffusion_pytorch_model.fp16.safetensors"):
            return None
        torch, dev, dt = torch_setup()
        from diffusers import ControlNetModel, StableDiffusionControlNetInpaintPipeline
        cn = ControlNetModel.from_pretrained(mpath("controlnet-depth"), variant="fp16", torch_dtype=dt)
        MODELS["cninp"] = StableDiffusionControlNetInpaintPipeline.from_pipe(model_inpaint(), controlnet=cn.to(dev))
    return MODELS["cninp"]


def model_depth():
    if "depth" not in MODELS:
        if not have("depth-anything-v2-small", "onnx", "model.onnx"):
            return None
        import onnxruntime as ort
        MODELS["depth"] = ort.InferenceSession(mpath("depth-anything-v2-small", "onnx", "model.onnx"), providers=["CPUExecutionProvider"])
    return MODELS["depth"]


def depth_map(img):
    """Depth Anything V2 (vicino = chiaro), normalizzata 0-255, come immagine RGB per ControlNet Depth."""
    s = model_depth()
    W, H = img.size
    k = 518 / max(W, H)
    w, h = max(14, round(W * k / 14) * 14), max(14, round(H * k / 14) * 14)
    x = np.asarray(img.convert("RGB").resize((w, h), Image.BICUBIC), dtype=np.float32) / 255.0
    x = ((x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]).transpose(2, 0, 1)[None].astype(np.float32)
    d = s.run(None, {s.get_inputs()[0].name: x})[0].reshape(h, w)
    d = (d - d.min()) / max(1e-6, d.max() - d.min())
    return Image.fromarray((d * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC).convert("RGB")


def model_inpaint():
    if "inp" not in MODELS:
        torch, dev, dt = torch_setup()
        from diffusers import StableDiffusionInpaintPipeline
        p = StableDiffusionInpaintPipeline.from_single_file(mpath("Realistic_Vision_V6.0_B1_noVAE", "Realistic_Vision_V6.0_NV_B1_inpainting_fp16.safetensors"),
                                                            vae=_vae(torch, dt), torch_dtype=dt, safety_checker=None, requires_safety_checker=False)
        MODELS["inp"] = _speed(p.to(dev), torch)
    return MODELS["inp"]


def model_txt2img():
    if "gen" not in MODELS:
        torch, dev, dt = torch_setup()
        from diffusers import StableDiffusionPipeline
        p = StableDiffusionPipeline.from_single_file(mpath("Realistic_Vision_V6.0_B1_noVAE", "Realistic_Vision_V6.0_NV_B1_fp16.safetensors"),
                                                     vae=_vae(torch, dt), torch_dtype=dt, safety_checker=None, requires_safety_checker=False)
        MODELS["gen"] = _speed(p.to(dev), torch)
    return MODELS["gen"]


def model_lama():
    if "lama" not in MODELS:
        if not have("lama", "lama_fp32.onnx"):
            return None
        import onnxruntime as ort
        MODELS["lama"] = ort.InferenceSession(mpath("lama", "lama_fp32.onnx"), providers=["CPUExecutionProvider"])
    return MODELS["lama"]


def _rrdbnet():
    """Architettura RRDBNet di Real-ESRGAN x4plus (xinntao/Real-ESRGAN, BSD-3): 23 blocchi RRDB, 64 canali."""
    import torch
    from torch import nn
    F = nn.functional

    class RDB(nn.Module):
        def __init__(s, nf=64, gc=32):
            super().__init__()
            s.conv1, s.conv2 = nn.Conv2d(nf, gc, 3, 1, 1), nn.Conv2d(nf + gc, gc, 3, 1, 1)
            s.conv3, s.conv4 = nn.Conv2d(nf + 2 * gc, gc, 3, 1, 1), nn.Conv2d(nf + 3 * gc, gc, 3, 1, 1)
            s.conv5 = nn.Conv2d(nf + 4 * gc, nf, 3, 1, 1)
            s.lrelu = nn.LeakyReLU(0.2, True)

        def forward(s, x):
            x1 = s.lrelu(s.conv1(x))
            x2 = s.lrelu(s.conv2(torch.cat((x, x1), 1)))
            x3 = s.lrelu(s.conv3(torch.cat((x, x1, x2), 1)))
            x4 = s.lrelu(s.conv4(torch.cat((x, x1, x2, x3), 1)))
            return s.conv5(torch.cat((x, x1, x2, x3, x4), 1)) * 0.2 + x

    class RRDB(nn.Module):
        def __init__(s, nf):
            super().__init__()
            s.rdb1, s.rdb2, s.rdb3 = RDB(nf), RDB(nf), RDB(nf)

        def forward(s, x):
            return s.rdb3(s.rdb2(s.rdb1(x))) * 0.2 + x

    class Net(nn.Module):
        def __init__(s, nf=64, nb=23):
            super().__init__()
            s.conv_first = nn.Conv2d(3, nf, 3, 1, 1)
            s.body = nn.Sequential(*[RRDB(nf) for _ in range(nb)])
            s.conv_body = nn.Conv2d(nf, nf, 3, 1, 1)
            s.conv_up1, s.conv_up2 = nn.Conv2d(nf, nf, 3, 1, 1), nn.Conv2d(nf, nf, 3, 1, 1)
            s.conv_hr, s.conv_last = nn.Conv2d(nf, nf, 3, 1, 1), nn.Conv2d(nf, 3, 3, 1, 1)
            s.lrelu = nn.LeakyReLU(0.2, True)

        def forward(s, x):
            f = s.conv_first(x)
            f = f + s.conv_body(s.body(f))
            f = s.lrelu(s.conv_up1(F.interpolate(f, scale_factor=2, mode="nearest")))
            f = s.lrelu(s.conv_up2(F.interpolate(f, scale_factor=2, mode="nearest")))
            return s.conv_last(s.lrelu(s.conv_hr(f)))
    return Net()


def model_esrgan():
    if "esr" not in MODELS:
        f = mpath("realesrgan", "RealESRGAN_x4plus.pth")
        if not os.path.exists(f):
            return None
        import torch
        sd = torch.load(f, map_location="cpu", weights_only=True)  # solo pesi, nessun codice
        net = _rrdbnet()
        net.load_state_dict(sd.get("params_ema") or sd.get("params") or sd, strict=True)
        MODELS["esr"] = net.eval()
    return MODELS["esr"]


# ---------------------------------------------------------------- utilita'
NEG = ("child, kid, teen, teenager, underage, minor, deformed, bad anatomy, extra limbs, extra fingers, mutated hands, disfigured, "
       "blurry, lowres, jpeg artifacts, cartoon, 3d render, watermark, text, logo")


def load(p, mode="RGB"):
    im = Image.open(p)
    im.load()
    return im.convert(mode)


def save(img, suffix="png"):
    os.makedirs(ARGS.out, exist_ok=True)
    p = os.path.join(ARGS.out, f"ia_{uuid.uuid4().hex[:10]}.{suffix}")
    img.save(p)
    return p


def progress(p, msg=None):
    PROGRESS["p"] = max(0.0, min(1.0, p))
    if msg is not None:
        PROGRESS["msg"] = msg


def steps_cb(total, lo=0.15, hi=0.9, msg="Generazione"):
    def cb(pipe, i, t, kw):
        progress(lo + (hi - lo) * (i + 1) / max(1, total), f"{msg}: passo {i + 1} di {total}")
        return kw
    return cb


def mask_bbox(mask, pad):
    a = np.asarray(mask) > 8
    ys, xs = np.nonzero(a)
    if not len(xs):
        raise ValueError("La selezione e' vuota")
    W, H = mask.size
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    w, h = x1 - x0, y1 - y0
    p = int(max(w, h) * pad) + 16
    return int(max(0, x0 - p)), int(max(0, y0 - p)), int(min(W, x1 + p)), int(min(H, y1 + p))  # int Python (JSON)


def work_size(w, h, side=512, mult=8):
    k = side / max(w, h)
    return max(mult, int(round(w * k / mult)) * mult), max(mult, int(round(h * k / mult)) * mult)


# ---------------------------------------------------------------- operazioni
ATR = ["sfondo", "cappello", "capelli", "occhiali", "abiti parte superiore", "gonna", "pantaloni", "vestito", "cintura", "scarpa sinistra",
       "scarpa destra", "viso", "gamba sinistra", "gamba destra", "braccio sinistro", "braccio destro", "borsa", "sciarpa"]
GROUPS = {"abbigliamento": [4, 5, 6, 7, 8, 17], "capelli": [2], "viso": [11], "pelle": [11, 12, 13, 14, 15], "braccia": [14, 15],
          "gambe": [12, 13], "scarpe": [9, 10], "accessori": [1, 3, 16]}


def op_segment(a):
    import torch
    img = load(a["image"])
    m = model_segformer()
    progress(0.3, "Riconoscimento delle parti")
    with torch.no_grad():
        logits = m(pixel_values=seg_input(img)).logits
    lab = torch.nn.functional.interpolate(logits, size=img.size[::-1], mode="bilinear", align_corners=False).argmax(1)[0].numpy()
    out = {}
    for name, ids in GROUPS.items():
        mk = np.isin(lab, ids)
        if mk.sum() > 50:
            out[name] = save(Image.fromarray((mk * 255).astype(np.uint8)))
    person = lab != 0
    if person.sum() > 50:
        out["persona"] = save(Image.fromarray((person * 255).astype(np.uint8)))
    return {"maschere": out}


def subject_mask(img):
    s = model_birefnet()
    x = np.asarray(img.convert("RGB").resize((1024, 1024), Image.BILINEAR), dtype=np.float32) / 255.0
    x = ((x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]).transpose(2, 0, 1)[None].astype(np.float32)
    y = s.run(None, {s.get_inputs()[0].name: x})[-1][0, 0]
    if y.min() < 0 or y.max() > 1:
        y = 1 / (1 + np.exp(-y))
    return Image.fromarray((np.clip(y, 0, 1) * 255).astype(np.uint8)).resize(img.size, Image.BILINEAR)


def op_subject(a):
    progress(0.3, "Ricerca del soggetto")
    return {"mask": save(subject_mask(load(a["image"])))}


def op_removebg(a):
    img = load(a["image"], "RGBA")
    progress(0.3, "Scontorno")
    m = subject_mask(img)
    img.putalpha(m)
    return {"path": save(img)}


def with_alpha(img, alpha):
    """Livello trasparente: colori invariati + alfa. (paste con maschera su un RGBA vuoto scurisce anche i colori del bordo,
    che poi la fusione scurisce una seconda volta: era la riga scura attorno alle zone modificate.)"""
    layer = img.convert("RGBA")
    layer.putalpha(alpha)
    return layer


def lama_fill(lama, ci, cm):
    """LaMa su un ritaglio (lavora a 512x512): restituisce il ritaglio con la zona della maschera ricostruita."""
    s = 512
    i = np.asarray(ci.convert("RGB").resize((s, s), Image.LANCZOS), dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
    m = (np.asarray(cm.resize((s, s), Image.BILINEAR), dtype=np.float32) > 20).astype(np.float32)[None, None]
    names = [x.name for x in lama.get_inputs()]
    res = lama.run(None, {names[0]: i, names[1]: m})[0][0]
    res = res if res.max() > 2 else res * 255
    return Image.fromarray(np.clip(res.transpose(1, 2, 0), 0, 255).astype(np.uint8)).resize(ci.size, Image.LANCZOS)


def body_base(img, ci, cm, orig, box):
    """Base per cambiare abito senza cambiare il corpo: zona = selezione dentro la sagoma della persona (BiRefNet sulla foto
    intera); dentro la zona colore della pelle della persona (SegFormer: viso, braccia, gambe) modulato dalla luminosita'
    dell'originale, cosi' il modello parte dalle forme vere e non ne inventa di nuove."""
    import torch
    progress(0.04, "Sagoma della persona")
    sil = np.asarray(subject_mask(img).crop(box), dtype=np.float32) / 255.0
    z = (np.asarray(cm, dtype=np.float32) / 255.0) * np.clip((sil - 0.3) / 0.4, 0, 1)
    progress(0.08, "Colore della pelle")
    m = model_segformer()
    with torch.no_grad():
        logits = m(pixel_values=seg_input(img)).logits
    lab = torch.nn.functional.interpolate(logits, size=img.size[::-1], mode="bilinear", align_corners=False).argmax(1)[0].numpy()
    px = np.asarray(img, dtype=np.float32)
    skin = px[np.isin(lab, [12, 13, 14, 15])]  # gambe e braccia (il viso ha spesso trucco e luce diversa)
    if len(skin) < 50:
        skin = px[lab == 11]
    tone = np.median(skin, 0) if len(skin) > 50 else np.array([205, 160, 135], np.float32)
    c = np.asarray(ci, dtype=np.float32)
    # solo le ombre larghe (volumi del corpo): bordi, cuciture e pieghe del capo vecchio restavano come una riga sulla pelle
    L = np.asarray(ci.convert("L").filter(ImageFilter.GaussianBlur(max(2.0, min(ci.size) / 60))), dtype=np.float32)
    # la base va solo dove c'era il capo vecchio (selezione non allargata): la pelle vera attorno resta com'e'
    zo = (np.asarray(orig, dtype=np.float32) / 255.0) * np.clip((sil - 0.3) / 0.4, 0, 1)
    inside = zo > 0.5
    ref = float(np.median(L[inside])) if inside.any() else 128.0
    shade = np.clip(L / max(ref, 1.0), 0.55, 1.35)[..., None]
    base = np.clip(tone * shade, 0, 255)
    za = zo[..., None]
    src = Image.fromarray((c * (1 - za) + base * za).astype(np.uint8))
    return src, Image.fromarray((np.clip(z, 0, 1) * 255).astype(np.uint8)), sil


def op_erase(a):
    img, mask = load(a["image"]), load(a["mask"], "L")
    lama = model_lama()
    if lama is None:  # senza LaMa: riempimento generativo "sfondo"
        return op_fill({**a, "prompt": "empty background, seamless continuation of the surroundings", "strength": 1.0, "_erase": True})
    progress(0.3, "Ricostruzione dello sfondo")
    x0, y0, x1, y1 = mask_bbox(mask, 0.6)
    ci, cm = img.crop((x0, y0, x1, y1)), mask.crop((x0, y0, x1, y1)).filter(ImageFilter.MaxFilter(9))
    out = lama_fill(lama, ci, cm)
    layer = with_alpha(out, cm.filter(ImageFilter.GaussianBlur(2)))
    return {"path": save(layer), "x": x0, "y": y0}


def match_color(out, ci, zone, sil):
    """Il tono della pelle rigenerata si riporta a quello della pelle vera che la circonda: guadagno per canale calcolato
    tra una fascia appena fuori dalla zona (dentro la sagoma) e una appena dentro (solo pixel di colore simile)."""
    z = np.asarray(zone) > 127
    r = max(5, min(ci.size) // 25) | 1
    zi = Image.fromarray((z * 255).astype(np.uint8))
    ring_out = (np.asarray(zi.filter(ImageFilter.MaxFilter(r))) > 127) & ~z & (sil > 0.7)
    ring_in = z & ~(np.asarray(zi.filter(ImageFilter.MinFilter(r))) > 127)
    c, o = np.asarray(ci, dtype=np.float32), np.asarray(out, dtype=np.float32)
    if ring_out.sum() < 50 or ring_in.sum() < 50:
        return out
    ref = np.median(c[ring_out], 0)
    pin = o[ring_in]
    pin = pin[np.abs(pin - ref).sum(1) < 120]  # niente pixel del capo nuovo (es. bikini nero) nel confronto
    if len(pin) < 50:
        return out
    gain = np.clip(ref / np.maximum(np.median(pin, 0), 1), 0.8, 1.25)
    zs = np.asarray(zone.filter(ImageFilter.GaussianBlur(r)), dtype=np.float32)[..., None] / 255.0
    res = o * (1 + (gain - 1) * zs)
    return Image.fromarray(np.clip(res, 0, 255).astype(np.uint8))


def match_grain(out, ci, zone, seed=0):
    """Grana della foto: le zone generate sono piu' lisce (aspetto "da IA"); si aggiunge il rumore che manca rispetto
    all'originale attorno, solo sulla luminosita'."""
    def hp(a):
        im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
        return a - np.asarray(im.filter(ImageFilter.GaussianBlur(1.2)), dtype=np.float32)
    def noise(a, m):  # stima robusta (mediana degli scarti): i contorni non contano, solo la grana delle zone uniformi
        v = hp(a)[m]
        return float(np.median(np.abs(v - np.median(v)))) * 1.4826 if v.size > 100 else 0.0
    z = np.asarray(zone) > 127
    zi = Image.fromarray((z * 255).astype(np.uint8))
    r = max(5, min(ci.size) // 15) | 1
    ring = (np.asarray(zi.filter(ImageFilter.MaxFilter(r))) > 127) & ~z  # dintorni della zona
    c = np.asarray(ci.convert("L"), dtype=np.float32)
    o3 = np.asarray(out, dtype=np.float32)
    ol = np.asarray(out.convert("L"), dtype=np.float32)
    so, sg = noise(c, ring), noise(ol, z)
    add = (max(0.0, so * so - sg * sg)) ** 0.5
    if add < 0.3:
        return out
    n = np.random.default_rng(seed).normal(0, min(add, 5.0), ol.shape).astype(np.float32)
    n = np.asarray(Image.fromarray(np.clip(n * 10 + 128, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.4)), dtype=np.float32)
    n = (n - 128) / 10  # grana appena morbida, come quella di un sensore
    zs = np.asarray(zone.filter(ImageFilter.GaussianBlur(2)), dtype=np.float32) / 255.0
    return Image.fromarray(np.clip(o3 + (n * zs)[..., None], 0, 255).astype(np.uint8))


def op_fill(a):
    """Riempimento generativo: si lavora su un ritaglio attorno alla selezione (lato 512 o 768), poi il risultato torna alla
    risoluzione originale come livello trasparente fuori dalla selezione (con bordo sfumato).
    persona=True (abiti su una persona): si rigenera solo dentro la sagoma, da una base color pelle con le ombre della foto,
    guidati dalla profondita' dell'originale (ControlNet Depth): seno, fianchi e muscoli restano quelli della foto."""
    import torch
    check_text(a.get("prompt"))
    img, mask = load(a["image"]), load(a["mask"], "L")
    if not a.get("_erase"):
        check_minors(img, "l'immagine di partenza")
    x0, y0, x1, y1 = mask_bbox(mask, 0.35)
    ci, cm = img.crop((x0, y0, x1, y1)), mask.crop((x0, y0, x1, y1))
    orig = cm.point(lambda v: 255 if v > 127 else 0)
    # la zona (resa netta) si allarga oltre il bordo della selezione: niente alone del contenuto vecchio sui contorni
    grow = max(5, min(ci.size) // 45) | 1
    cm = cm.point(lambda v: 255 if v > 40 else 0).filter(ImageFilter.MaxFilter(grow))
    strength = float(a.get("strength") or 1.0)
    src, sil, depth = ci, None, None
    persona = bool(a.get("persona")) and not a.get("_erase")
    if persona:
        src, cm, sil = body_base(img, ci, cm, orig, (x0, y0, x1, y1))
        strength = float(a.get("strength") or 0.9)
    q = quality(a)
    w, h = work_size(*ci.size, q["side"])
    base = model_inpaint()
    pipe = base
    if persona and model_depth() is not None:
        progress(0.1, "Profondita' del corpo")
        depth = depth_map(ci).filter(ImageFilter.GaussianBlur(max(1.5, min(ci.size) / 150)))  # senza lo scalino del bordo del capo
        pipe = model_controlnet_inpaint() or base
    lcm = set_mode(pipe, q["fast"], base)
    steps = int(a.get("steps") or (6 if lcm else 28))
    if strength < 1:  # con strength < 1 si eseguono solo steps*strength passi
        steps = int(round(steps / strength))
    progress(0.12, "Preparazione")
    seed = int(a.get("seed") or int(time.time()) % 100000)
    g = torch.Generator().manual_seed(seed)
    kw = {}
    if pipe is not base:
        kw = {"control_image": depth.resize((w, h), Image.BICUBIC), "controlnet_conditioning_scale": float(a.get("forme") or 0.9)}
    prompt = a.get("prompt") or ""
    out = pipe(realism(prompt) if not a.get("_erase") else prompt, image=src.resize((w, h), Image.LANCZOS),
               mask_image=cm.resize((w, h), Image.LANCZOS), negative_prompt=None if lcm else (a.get("negative") or NEG),
               width=w, height=h, num_inference_steps=steps, guidance_scale=1.5 if lcm else float(a.get("guidance") or 5.0),
               strength=strength, generator=g, callback_on_step_end=steps_cb(max(1, int(steps * strength))), **kw).images[0]
    out = out.resize(ci.size, Image.LANCZOS)
    if not a.get("_erase"):
        check_minors(out, "il risultato")
    progress(0.95, "Composizione")
    if os.environ.get("MBV_IA_DEBUG"):
        out.save(os.path.join(os.environ["MBV_IA_DEBUG"], "3a_grezzo.png"))
    if persona:
        out = match_color(out, ci, cm, sil)
    if not a.get("_erase"):
        out = match_grain(out, ci, cm, seed)
    dbg = os.environ.get("MBV_IA_DEBUG")  # cartella in cui salvare i passaggi intermedi (prove)
    if dbg:
        src.save(os.path.join(dbg, "1_base.png")); cm.save(os.path.join(dbg, "2_zona.png")); out.save(os.path.join(dbg, "3_generato.png"))
        if depth is not None:
            depth.save(os.path.join(dbg, "0_profondita.png"))
    soft = cm.filter(ImageFilter.GaussianBlur(max(1.5, min(ci.size) / 200)))
    layer = with_alpha(out, soft)
    return {"path": save(layer), "x": x0, "y": y0}


def op_generate(a):
    import torch
    check_text(a.get("prompt"))
    pipe = model_txt2img()
    q = quality(a)
    lcm = set_mode(pipe, q["fast"])
    W, H = int(a.get("width") or 512), int(a.get("height") or 768)
    w, h = work_size(W, H, max(768, q["side"]))
    steps = int(a.get("steps") or (6 if lcm else 28))
    g = torch.Generator().manual_seed(int(a.get("seed") or int(time.time()) % 100000))
    img = pipe(realism(a.get("prompt")), negative_prompt=None if lcm else (a.get("negative") or NEG), width=w, height=h,
               num_inference_steps=steps, guidance_scale=1.5 if lcm else float(a.get("guidance") or 5.0), generator=g,
               callback_on_step_end=steps_cb(steps)).images[0]
    check_minors(img, "il risultato")
    if (w, h) != (W, H):
        img = img.resize((W, H), Image.LANCZOS)
    return {"path": save(img)}


def op_upscale(a):
    import torch
    img = load(a["image"], "RGBA")
    scale = int(a.get("scale") or 2)
    net = model_esrgan()
    alpha = img.getchannel("A")
    rgb = img.convert("RGB")
    if net is None:
        out = rgb.resize((rgb.width * scale, rgb.height * scale), Image.LANCZOS).filter(ImageFilter.UnsharpMask(1.5, 60, 2))
    else:
        progress(0.2, "Aumento della risoluzione")
        x = torch.from_numpy(np.asarray(rgb, dtype=np.float32) / 255.0).permute(2, 0, 1)[None]
        tile, ov = 256, 16
        H, W = rgb.height, rgb.width
        res = torch.zeros(1, 3, H * 4, W * 4)
        tiles = [(ty, tx) for ty in range(0, H, tile) for tx in range(0, W, tile)]
        with torch.no_grad():
            for n, (ty, tx) in enumerate(tiles):
                ya, xa = max(0, ty - ov), max(0, tx - ov)
                yb, xb = min(H, ty + tile + ov), min(W, tx + tile + ov)
                y = net(x[:, :, ya:yb, xa:xb])
                cy, cx = (ty - ya) * 4, (tx - xa) * 4
                th, tw = min(tile, H - ty) * 4, min(tile, W - tx) * 4
                res[:, :, ty * 4:ty * 4 + th, tx * 4:tx * 4 + tw] = y[:, :, cy:cy + th, cx:cx + tw]
                progress(0.2 + 0.75 * (n + 1) / len(tiles), f"Aumento della risoluzione: {n + 1} di {len(tiles)}")
        out = Image.fromarray((res[0].clamp(0, 1).permute(1, 2, 0).numpy() * 255).astype(np.uint8))
        if scale != 4:
            out = out.resize((W * scale, H * scale), Image.LANCZOS)
    out = out.convert("RGBA")
    out.putalpha(alpha.resize(out.size, Image.LANCZOS))
    return {"path": save(out)}


OPS = {"segment": op_segment, "subject": op_subject, "removebg": op_removebg, "erase": op_erase, "fill": op_fill,
       "generate": op_generate, "upscale": op_upscale}


def status():
    return {"ok": True, "pid": os.getpid(), "busy": PROGRESS["busy"], "modelli": {
        "generativo": have("Realistic_Vision_V6.0_B1_noVAE", "Realistic_Vision_V6.0_NV_B1_inpainting_fp16.safetensors"),
        "veloce_lcm": have("lcm-lora-sdv1-5", "pytorch_lora_weights.safetensors"),
        "soggetto": have("BiRefNet-ONNX", "onnx", "model.onnx"), "parti": have("segformer_b3_clothes", "model.safetensors"),
        "cancella": have("lama", "lama_fp32.onnx"), "risoluzione": have("realesrgan", "RealESRGAN_x4plus.pth"),
        "controllo_eta": have("clip-vit-base-patch32", "config.json"),
        "forme": have("controlnet-depth", "diffusion_pytorch_model.fp16.safetensors") and have("depth-anything-v2-small", "onnx", "model.onnx")}}


# ---------------------------------------------------------------- server HTTP locale
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _auth(self):
        return self.headers.get("x-mbv-token") == ARGS.token

    def do_GET(self):
        if not self._auth():
            return self._json({"ok": False, "errore": "non autorizzato"}, 403)
        if self.path.startswith("/status"):
            return self._json(status())
        if self.path.startswith("/progress"):
            return self._json({"ok": True, **PROGRESS})
        if self.path.startswith("/quit"):
            self._json({"ok": True})
            threading.Timer(0.2, lambda: os._exit(0)).start()
            return
        return self._json({"ok": False, "errore": "percorso sconosciuto"}, 404)

    def do_POST(self):
        if not self._auth():
            return self._json({"ok": False, "errore": "non autorizzato"}, 403)
        a = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        fn = OPS.get(a.get("op"))
        if not fn:
            return self._json({"ok": False, "errore": "operazione sconosciuta"}, 400)
        with LOCK:  # una operazione alla volta (memoria e processore)
            PROGRESS.update(p=0.02, msg="Caricamento del modello", busy=True)
            t = time.time()
            try:
                res = fn(a)
                self._json({"ok": True, "secondi": round(time.time() - t, 1), **res})
            except ValueError as e:
                self._json({"ok": False, "errore": str(e)}, 422)
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                self._json({"ok": False, "errore": f"{type(e).__name__}: {e}"}, 500)
            finally:
                PROGRESS.update(p=1.0, busy=False)


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--parent", type=int, default=0)
    ARGS = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.port), H)
    print(f"PORT {srv.server_address[1]}", flush=True)
    if ARGS.parent:  # si chiude da solo se l'app che l'ha avviato non c'e' piu'
        def watch():
            import psutil
            while psutil.pid_exists(ARGS.parent):
                time.sleep(5)
            os._exit(0)
        threading.Thread(target=watch, daemon=True).start()
    srv.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
