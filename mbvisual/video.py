"""Montaggio video (editor in stile Premiere: ui/js/videdit.js): analisi dei file, forme d'onda, miniature per la
timeline, normalizzazione, stabilizzazione ed esportazione del progetto .mbvid con un unico grafo di filtri FFmpeg.

Il grafo riproduce la composizione dell'anteprima WebGL (ui/js/vidgl.js) con le stesse formule:
  clip -> velocita' -> fotogrammi fermi per le transizioni -> effetti (sorgente, RGB con alfa) -> opacita'
       -> trasformazione su una tela trasparente grande quanto la sequenza (perspective se animata)
  clip della stessa traccia unite dalle transizioni (xfade) -> sovrapposte dal basso verso l'alto (overlay / blend).
Tempi del modello in secondi; i fotogrammi chiave sono relativi all'inizio della clip in timeline.
"""
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import uuid
from pathlib import Path

from .media import NO_WINDOW, _ffmpeg, _parse_duration
from .paths import TEMP_DIR
from .i18n import t as _t

CACHE = TEMP_DIR / "video"
CACHE.mkdir(parents=True, exist_ok=True)
RATES = {23.976: "24000/1001", 29.97: "30000/1001", 59.94: "60000/1001", 47.952: "48000/1001", 119.88: "120000/1001"}
LUMA = (0.2126, 0.7152, 0.0722)
XFADE = {"fade": "fade", "fadeblack": "fadeblack", "fadewhite": "fadewhite", "wipeleft": "wipeleft", "wiperight": "wiperight",
         "wipeup": "wipeup", "wipedown": "wipedown", "slideleft": "slideleft", "slideright": "slideright", "slideup": "slideup",
         "slidedown": "slidedown", "zoomin": "zoomin", "circleopen": "circleopen", "circleclose": "circleclose"}
# metodi di fusione dell'interfaccia -> modi del filtro blend (primo ingresso = livello sopra)
BLEND = {"multiply": "multiply", "screen": "screen", "overlay": "hardlight", "hardlight": "overlay", "darken": "darken",
         "lighten": "lighten", "difference": "difference", "add": "addition"}


def _key(path: str, extra: str = "") -> str:
    st = os.stat(path)
    return hashlib.sha1(f"{path}|{st.st_size}|{st.st_mtime}|{extra}".encode()).hexdigest()[:16]


def _rate(fps: float) -> str:
    for k, v in RATES.items():
        if abs(fps - k) < 0.01:
            return v
    return f"{fps:g}"


def _n(v: float) -> str:
    return f"{v:.6f}".rstrip("0").rstrip(".") if v != int(v) else str(int(v))


# ------------------------------------------------------------------ analisi
def info(path: str) -> dict:
    r = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path], capture_output=True, creationflags=NO_WINDOW)
    text = r.stderr.decode("utf-8", "replace")
    out = {"dur": _parse_duration(text), "w": None, "h": None, "fps": None, "video": False, "audio": False, "still": False}
    fmt = (re.search(r"Input #0, ([^\n]+?), from", text) or [None, ""])[1]
    for m in re.finditer(r"Stream #\d+:\d+[^\n]*?: (Video|Audio): ([^\n]+)", text):
        kind, desc = m.groups()
        if kind == "Audio":
            out["audio"] = True
            continue
        if "attached pic" in desc or out["video"]:
            continue
        out["video"] = True
        d = re.search(r"\b(\d{2,5})x(\d{2,5})\b", desc)
        if d:
            out["w"], out["h"] = int(d.group(1)), int(d.group(2))
        f = re.search(r"(\d+(?:\.\d+)?) fps", desc) or re.search(r"(\d+(?:\.\d+)?) tbr", desc)
        if f:
            out["fps"] = float(f.group(1))
    rot = re.search(r"rotation of (-?\d+(?:\.\d+)?) degrees", text)
    if rot and out["w"] and round(abs(float(rot.group(1)))) % 180 == 90:
        out["w"], out["h"] = out["h"], out["w"]
    if out["video"] and ("_pipe" in fmt or "image2" in fmt or fmt.startswith(("png", "jpeg", "webp", "bmp", "tiff"))) and not out["audio"]:
        out["still"] = True
    return out


def waveform(path: str, per_second: int = 100) -> dict:
    """Picchi (0..1) a intervalli regolari per disegnare la forma d'onda nella timeline."""
    import numpy as np
    per_second = max(10, min(400, int(per_second)))
    sr = 8000
    r = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
                       capture_output=True, creationflags=NO_WINDOW)
    a = np.frombuffer(r.stdout, dtype="<i2")
    step = sr // per_second
    n = len(a) // step
    if not n:
        return {"rate": per_second, "peaks": []}
    peaks = np.abs(a[:n * step].astype(np.int32)).reshape(n, step).max(axis=1) / 32768.0
    return {"rate": per_second, "peaks": [round(float(p), 3) for p in peaks]}


def thumbs(path: str, height: int = 54, update=None) -> dict:
    """Striscia di miniature (una ogni `step` secondi) per la timeline, in cache."""
    inf = info(path)
    dur = inf["dur"] or 1
    n = int(max(1, min(240, math.ceil(dur / 1.0))))
    step = dur / n
    out = CACHE / f"th_{_key(path, str(height))}.jpg"
    meta = out.with_suffix(".json")
    if out.exists() and meta.exists():
        return json.loads(meta.read_text())
    args = [_ffmpeg(), "-y", "-hide_banner", "-nostdin"]
    if dur > 1200:
        args += ["-skip_frame", "nokey"]
    args += ["-i", path, "-an", "-vf", f"fps=1/{step:.6f},scale=-2:{height}:flags=bilinear,tile={n}x1", "-frames:v", "1", "-q:v", "5", str(out)]
    r = subprocess.run(args, capture_output=True, creationflags=NO_WINDOW)
    if r.returncode != 0 or not out.exists():
        raise RuntimeError(_t("srv_video.miniature_non_create") + r.stderr.decode("utf-8", "replace")[-300:])
    w = inf["w"] or 16
    h = inf["h"] or 9
    tw = int(round(height * w / h / 2)) * 2
    res = {"path": str(out), "step": step, "count": n, "tw": tw, "th": height}
    meta.write_text(json.dumps(res))
    return res


def peak(path: str, start: float = 0, dur: float | None = None) -> dict:
    """Livello massimo e medio (dB) di un tratto, per "Normalizza audio"."""
    args = [_ffmpeg(), "-hide_banner", "-nostdin", "-ss", f"{max(0, start):.3f}"]
    if dur:
        args += ["-t", f"{dur:.3f}"]
    args += ["-i", path, "-vn", "-af", "volumedetect", "-f", "null", "-"]
    text = subprocess.run(args, capture_output=True, creationflags=NO_WINDOW).stderr.decode("utf-8", "replace")
    mx = re.search(r"max_volume: (-?[\d.]+|-inf) dB", text)
    mean = re.search(r"mean_volume: (-?[\d.]+|-inf) dB", text)
    f = lambda m: None if not m or m.group(1) == "-inf" else float(m.group(1))  # noqa: E731
    return {"max": f(mx), "mean": f(mean)}


def stabilize(path: str, out: str, smooth: int = 15, update=None) -> dict:
    """Stabilizzazione in due passate (vid.stab): copia stabilizzata del file, con l'audio originale."""
    update = update or (lambda **k: None)
    work = CACHE / ("stab_" + uuid.uuid4().hex[:8])
    work.mkdir(parents=True, exist_ok=True)
    dur = info(path)["dur"]
    try:
        update(message=_t("srv_video.analisi_movimento"))
        _run([_ffmpeg(), "-y", "-hide_banner", "-nostdin", "-i", path, "-vf", "vidstabdetect=shakiness=6:accuracy=12:result=t.trf", "-f", "null", "-"],
             dur, lambda p: update(progress=p * 0.5), cwd=work)
        update(message=_t("srv_video.stabilizzazione"))
        _run([_ffmpeg(), "-y", "-hide_banner", "-nostdin", "-i", path, "-vf", f"vidstabtransform=input=t.trf:smoothing={int(smooth)}:optzoom=1:interpol=bicubic,unsharp=5:5:0.6",
              "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "copy",
              "-movflags", "+faststart", out], dur, lambda p: update(progress=0.5 + p * 0.5), cwd=work)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return {"path": out}


def _run(args, duration, progress, cwd=None):
    proc = subprocess.Popen(args, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, stdin=subprocess.DEVNULL, cwd=cwd, creationflags=NO_WINDOW)
    buf, tail = b"", []
    while True:
        chunk = proc.stderr.read(512)
        if not chunk:
            break
        buf += chunk
        *lines, buf = re.split(rb"[\r\n]", buf)
        for line in lines:
            s = line.decode("utf-8", "replace")
            if s:
                tail = (tail + [s])[-20:]
            m = re.search(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)", s)
            if m and duration:
                h, mi, sec = m.groups()
                progress(min(1.0, (int(h) * 3600 + int(mi) * 60 + float(sec)) / duration))
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError("FFmpeg: " + " | ".join(t for t in tail[-6:] if not t.startswith("  ")))


# ------------------------------------------------------------------ fotogrammi chiave
def _kf_at(keys, t, default):
    if not keys:
        return default
    if t <= keys[0][0]:
        return keys[0][1]
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if t < t1:
            return v0 + (v1 - v0) * (t - t0) / (t1 - t0) if t1 > t0 else v1
    return keys[-1][1]


def _kf_expr(keys, var, default, fn=None):
    """Interpolazione lineare a tratti come espressione FFmpeg nella variabile `var` (tempo dalla testa della clip)."""
    f = fn or (lambda v: _n(v))
    if not keys:
        return f(default)
    if len(keys) == 1:
        return f(keys[0][1])
    e = f(keys[-1][1])
    for (t0, v0), (t1, v1) in reversed(list(zip(keys, keys[1:]))):
        seg = f(v1) if t1 - t0 < 1e-6 else f"({f(v0)}+({f(v1)}-{f(v0)})*({var}-{_n(t0)})/{_n(t1 - t0)})"
        e = f"if(lt({var},{_n(t1)}),{seg},{e})"
    return f"if(lt({var},{_n(keys[0][0])}),{f(keys[0][1])},{e})"


def _keys(c, prop):
    k = (c.get("kf") or {}).get(prop)
    return sorted(([float(t), float(v)] for t, v in k), key=lambda x: x[0]) if k and len(k) else None


# ------------------------------------------------------------------ esportazione
def export(project: dict, out: str, opts: dict, base_dir: str = "", update=None) -> dict:
    update = update or (lambda **k: None)
    work = CACHE / ("exp_" + uuid.uuid4().hex[:8])
    work.mkdir(parents=True, exist_ok=True)
    try:
        args, graph, maps, length = _build(project, opts, work)
        (work / "graph.txt").write_text(graph, encoding="utf-8")
        cmd = [_ffmpeg(), "-y", "-hide_banner", "-nostdin", *args, "-/filter_complex", "graph.txt", *maps, *_codec(opts, out), out]
        (work / "cmd.txt").write_text(json.dumps(cmd, indent=1), encoding="utf-8")
        update(message=_t("srv_video.esportazione"))
        _run(cmd, length, lambda p: update(progress=p), cwd=work)
    except Exception:
        dbg = TEMP_DIR / "video" / "ultima_esportazione"
        shutil.rmtree(dbg, ignore_errors=True)
        shutil.copytree(work, dbg, dirs_exist_ok=True)  # per capire cosa non e' andato
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return {"path": out}


def _codec(o: dict, out: str) -> list:
    fmt = o.get("format", "h264")
    q = o.get("quality", "alta")
    if fmt in ("mp3", "wav", "m4a"):
        return {"mp3": ["-c:a", "libmp3lame", "-b:a", "320k" if q == "alta" else "192k"],
                "wav": ["-c:a", "pcm_s16le"], "m4a": ["-c:a", "aac", "-b:a", "256k"]}[fmt]
    crf = {"h264": {"alta": 18, "media": 22, "bassa": 27}, "h265": {"alta": 21, "media": 26, "bassa": 30}, "webm": {"alta": 28, "media": 33, "bassa": 38}}
    if fmt == "h265":
        return ["-c:v", "libx265", "-preset", "medium", "-crf", str(crf["h265"][q]), "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
    if fmt == "webm":
        return ["-c:v", "libvpx-vp9", "-crf", str(crf["webm"][q]), "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "160k"]
    if fmt == "prores":
        return ["-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le", "-c:a", "pcm_s16le"]
    return ["-c:v", "libx264", "-preset", "medium", "-crf", str(crf["h264"][q]), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]


def _layout(p):
    """Estensioni delle clip per le transizioni (meta' durata oltre il taglio, come Premiere) e transizioni singole."""
    clips = {c["id"]: c for c in p["clips"]}
    for c in p["clips"]:
        c["_pre"] = c["_post"] = 0.0
        c["_tin"] = c["_tout"] = None
    for tr in p.get("transitions") or []:
        a, b, d = clips.get(tr.get("a")), clips.get(tr.get("b")), float(tr.get("dur") or 0)
        if d <= 0:
            continue
        if a and b:
            if a.get("off") or b.get("off"):
                continue
            a["_post"] = b["_pre"] = d / 2
            a["_tout"] = b["_tin"] = ("pair", tr)
        elif a:
            a["_tout"] = ("single", tr)
        elif b:
            b["_tin"] = ("single", tr)
    return clips


def _build(p: dict, o: dict, work: Path):
    S = p["settings"]
    W, H = int(S["w"]), int(S["h"])
    fps = float(S["fps"])
    R = _rate(fps)
    media = {m["id"]: m for m in p["media"]}
    clips = _layout(p)
    total = max([c["start"] + c["dur"] for c in clips.values()] + [0.04])
    a = max(0.0, float(o.get("start") or 0))
    b = float(o.get("end") or total)
    b = min(b, total) if o.get("end") is None else b
    if b - a < 0.04:
        raise RuntimeError(_t("srv_video.intervallo_esportare_vuoto"))
    audio_only = o.get("format") in ("mp3", "wav", "m4a")
    titles = o.get("titles") or {}
    luts = o.get("luts") or {}
    args, g = [], []
    nin = [0]
    lbl = [0]

    def new(prefix="s"):
        lbl[0] += 1
        return f"{prefix}{lbl[0]}"

    def add_input(*a_):
        args.extend(a_)
        nin[0] += 1
        return nin[0] - 1

    def active(c):
        return not c.get("off") and c["start"] < b and c["start"] + c["dur"] > a

    # -------------------------------------------- video
    vout = None
    if not audio_only:
        base = new("main")
        g.append(f"color=c=0x{(S.get('bg') or '#000000').lstrip('#')}:s={W}x{H}:r={R}:d={_n(b + 1)},format=gbrp[{base}]")
        cur = base
        vtracks = [t for t in p["tracks"]["v"] if not t.get("hide")]
        for t in vtracks:  # dal basso (V1) verso l'alto
            tcl = sorted([c for c in clips.values() if c["track"] == t["id"] and c.get("kind") != "audio" and active(c)], key=lambda c: c["start"])
            # catene di clip unite da transizioni
            segs = []
            for c in tcl:
                tin = c["_tin"]
                if segs and tin and tin[0] == "pair" and tin[1].get("a") == segs[-1][-1]["id"]:
                    segs[-1].append(c)
                else:
                    segs.append([c])
            for seg in segs:
                s0 = seg[0]["start"] - seg[0]["_pre"]
                lab = _clip_stream(seg[0], media, S, R, fps, W, H, g, add_input, new, titles, luts, work)
                for prev, c in zip(seg, seg[1:]):
                    tr = c["_tin"][1]
                    d = float(tr["dur"])
                    nxt = _clip_stream(c, media, S, R, fps, W, H, g, add_input, new, titles, luts, work)
                    o_ = new()
                    g.append(f"[{lab}][{nxt}]xfade=transition={XFADE.get(tr.get('type'), 'fade')}:duration={_n(d)}:offset={_n(c['start'] - d / 2 - s0)}[{o_}]")
                    lab = o_
                pl = new()
                g.append(f"[{lab}]setpts=PTS-STARTPTS+{_n(s0)}/TB[{pl}]")
                mode = BLEND.get(seg[0].get("blend") or "normal")
                nx = new("main")
                if not mode:
                    g.append(f"[{cur}][{pl}]overlay=eof_action=pass:format=auto[{nx}]")
                else:
                    tc, full, fa, fb, al, m1, m2, bl, bla = (new() for _ in range(9))
                    g.append(f"color=c=black@0:s={W}x{H}:r={R}:d={_n(b + 1)},format=gbrap[{tc}]")
                    g.append(f"[{tc}][{pl}]overlay=eof_action=pass:format=auto,format=gbrap,split[{fa}][{fb}]")
                    g.append(f"[{fa}]alphaextract[{al}]")
                    g.append(f"[{cur}]format=gbrap,split[{m1}][{m2}]")
                    g.append(f"[{fb}][{m1}]blend=all_mode={mode}[{bl}]")
                    g.append(f"[{bl}][{al}]alphamerge[{bla}]")
                    g.append(f"[{m2}][{bla}]overlay=format=auto[{nx}]")
                    del full
                cur = nx
        vout = "vout"
        ow, oh = int(o.get("w") or W), int(o.get("h") or H)
        ofps = float(o.get("fps") or fps)
        chain = [f"trim=start={_n(a)}:end={_n(b)}", "setpts=PTS-STARTPTS"]
        if (ow, oh) != (W, H):
            ow, oh = ow // 2 * 2, oh // 2 * 2
            chain += [f"scale={ow}:{oh}:force_original_aspect_ratio=decrease:flags=lanczos", f"pad={ow}:{oh}:(ow-iw)/2:(oh-ih)/2:color=black"]
        if abs(ofps - fps) > 0.001:
            chain.append(f"fps={_rate(ofps)}")
        chain.append("format=yuv422p10le" if o.get("format") == "prores" else "format=yuv420p")
        g.append(f"[{cur}]{','.join(chain)}[{vout}]")

    # -------------------------------------------- audio
    atracks = p["tracks"]["a"]
    solo = any(t.get("solo") for t in atracks)
    alabs = []
    for t in atracks:
        if t.get("mute") or (solo and not t.get("solo")):
            continue
        tg = float(t.get("gain") or 0)
        for c in sorted([c for c in clips.values() if c["track"] == t["id"] and active(c)], key=lambda c: c["start"]):
            m = media.get(c.get("media"))
            if not m or not m.get("audio"):
                continue
            lab = _audio_stream(c, m, tg, add_input, g, new)
            if lab:
                alabs.append(lab)
    aout = "aout"
    if alabs:
        mix = new()
        g.append("".join(f"[{x}]" for x in alabs) + f"amix=inputs={len(alabs)}:normalize=0:duration=longest:dropout_transition=0,apad=whole_dur={_n(b + 0.5)}[{mix}]")
        ch = [f"atrim=start={_n(a)}:end={_n(b)}", "asetpts=PTS-STARTPTS"]
        if o.get("loudnorm"):
            ch.append("loudnorm=I=-14:TP=-1:LRA=11")
            ch.append("aresample=48000")
        g.append(f"[{mix}]{','.join(ch)}[{aout}]")
    else:
        g.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={_n(b - a)}[{aout}]")
    maps = (["-map", f"[{vout}]"] if vout else []) + ["-map", f"[{aout}]"]
    if vout:
        maps += ["-shortest"]
    return args, ";\n".join(g) + "\n", maps, b - a


def _src_window(c, m, fps):
    """Parte del file da leggere e fotogrammi fermi da aggiungere prima/dopo (transizioni senza materiale extra)."""
    sp = float(c.get("speed") or 1)
    mi = float(c.get("in") or 0)
    mdur = float(m.get("dur") or 1e9)
    pre, post, dur = c["_pre"], c["_post"], c["dur"]
    real_pre = min(pre, mi / sp)
    real_post = max(0.0, min(post, (mdur - (mi + dur * sp)) / sp))
    ss = mi - real_pre * sp
    tl = (real_pre + dur + real_post) * sp
    return ss, tl, pre - real_pre, post - real_post, sp


def _clip_stream(c, media, S, R, fps, W, H, g, add_input, new, titles, luts, work):
    """Flusso a tela intera (W x H, con alfa) di una clip, lungo pre + durata + post, che parte da 0."""
    kind = c.get("kind")
    L = c["_pre"] + c["dur"] + c["_post"]
    N = max(1, round(L * fps))
    lab = new("c")
    if kind == "color":
        sw, sh = W, H
        g.append(f"color=c=0x{(c.get('color') or '#000000').lstrip('#')}:s={W}x{H}:r={R}:d={_n(L + 0.1)},format=gbrap,trim=end_frame={N}[{lab}]")
    elif kind in ("image", "title"):
        if kind == "title":
            t = titles.get(c["id"])
            if not t:
                raise RuntimeError(_t("srv_video.titolo_non_preparato_l_esportazione"))
            src, sw, sh = t["path"], int(t["w"]), int(t["h"])
        else:
            m = media[c["media"]]
            src = m["path"]
            sw, sh = int(m.get("w") or W), int(m.get("h") or H)
        k = add_input("-loop", "1", "-framerate", R, "-t", _n(L + 0.2), "-i", src)
        g.append(f"[{k}:v]fps={R},trim=end_frame={N},setpts=PTS-STARTPTS,format=gbrap[{lab}]")
    else:
        m = media[c["media"]]
        sw, sh = int(m.get("w") or W), int(m.get("h") or H)
        ss, tl, fpre, fpost, sp = _src_window(c, m, fps)
        k = add_input("-ss", _n(max(0.0, ss)), "-t", _n(tl + 0.5), "-i", m["path"])
        ch = [f"setpts=(PTS-STARTPTS)/{_n(sp)}", f"fps={R}"]
        if fpre > 0.001 or fpost > 0.001:
            ch.append(f"tpad=start_duration={_n(fpre)}:start_mode=clone:stop_duration={_n(fpost + 0.5)}:stop_mode=clone")
        else:
            ch.append("tpad=stop_duration=0.5:stop_mode=clone")
        ch += [f"trim=end_frame={N}", "setpts=PTS-STARTPTS", "format=gbrap"]
        g.append(f"[{k}:v]{','.join(ch)}[{lab}]")
    # ---- effetti alla risoluzione della sorgente
    fx = _effects(c, sw, sh, luts, work, fps)
    pre = c["_pre"]
    op = _keys(c, "opacity")
    if op:
        name = f"op{lab}"
        lines = []
        last = None
        for i in range(N):
            v = round(max(0, min(100, _kf_at(op, i / fps - pre, 100))) / 100, 4)
            if v != last:
                lines.append(f"{i / fps:.4f} colorchannelmixer@{name} aa {v};")
                last = v
        (work / f"{name}.cmd").write_text("\n".join(lines) + "\n", encoding="utf-8")
        fx += [f"sendcmd=f={name}.cmd", f"colorchannelmixer@{name}=aa=1"]
    elif float(c.get("opacity", 100)) < 99.99:
        fx.append(f"colorchannelmixer=aa={_n(max(0, float(c['opacity'])) / 100)}")
    if fx:
        o_ = new("c")
        g.append(f"[{lab}]{','.join(fx)}[{o_}]")
        lab = o_
    # ---- trasformazione (Movimento): adatta alla sequenza, poi posizione / scala / rotazione
    mo = c.get("motion") or {}
    f = 1.0 if kind == "title" else min(W / sw, H / sh)  # i titoli non si adattano: 1 px = 1 px della sequenza
    fw, fh = sw * f, sh * f
    kx, ky, ks, kr = (_keys(c, n) for n in ("x", "y", "scale", "rot"))
    X, Y = float(mo.get("x", W / 2)), float(mo.get("y", H / 2))
    Sc, Rt = float(mo.get("scale", 100)), float(mo.get("rot", 0))
    out = new("c")
    if not (kx or ky or ks or kr):
        w, h = max(1, round(fw * Sc / 100)), max(1, round(fh * Sc / 100))
        if w == W and h == H and abs(X - W / 2) < 0.01 and abs(Y - H / 2) < 0.01 and abs(Rt) < 0.001 and (sw, sh) == (W, H):
            g.append(f"[{lab}]null[{out}]")
        else:
            ch = [f"scale={w}:{h}:flags=bicubic"] if (w, h) != (sw, sh) else []
            ow, oh = w, h
            if abs(Rt) > 0.001:
                rad = Rt * math.pi / 180
                ch.append(f"rotate=a={_n(rad)}:ow='rotw({_n(rad)})':oh='roth({_n(rad)})':c=none:bilinear=1")
                ow = abs(w * math.cos(rad)) + abs(h * math.sin(rad))
                oh = abs(w * math.sin(rad)) + abs(h * math.cos(rad))
            cv, im = new(), new()
            g.append(f"[{lab}]{','.join(ch) or 'null'}[{im}]")
            g.append(f"color=c=black@0:s={W}x{H}:r={R}:d={_n(L + 0.1)},format=gbrap,trim=end_frame={N}[{cv}]")
            g.append(f"[{cv}][{im}]overlay=x='{_n(X - ow / 2)}':y='{_n(Y - oh / 2)}':format=auto:eof_action=pass,format=gbrap[{out}]")
    else:
        # animata: perspective con gli angoli calcolati a ogni fotogramma (in = numero del fotogramma)
        maxs = max([v for _, v in ks] if ks else [Sc])
        k0 = min(1.0, max(0.05, maxs / 100))
        iw, ih = max(2, round(fw * k0)), max(2, round(fh * k0))
        mg = 4
        CW, CH = W + 2 * mg, H + 2 * mg
        ox, oy = (CW - iw) // 2, (CH - ih) // 2
        cx0, cy0 = ox + iw / 2, oy + ih / 2
        T = f"(in/{_n(fps)}-{_n(pre)})"
        Xe = _kf_expr(kx, T, X)
        Ye = _kf_expr(ky, T, Y)
        Ke = f"(({_kf_expr(ks, T, Sc)})/100*{_n(fw / iw)})"
        Re = f"(({_kf_expr(kr, T, Rt)})*{_n(math.pi / 180)})"
        corners = []
        for px, py in ((0, 0), (CW, 0), (0, CH), (CW, CH)):
            dx, dy = px - cx0, py - cy0
            corners.append(f"{mg}+{Xe}+{Ke}*(cos({Re})*{_n(dx)}-sin({Re})*{_n(dy)})")
            corners.append(f"{mg}+{Ye}+{Ke}*(sin({Re})*{_n(dx)}+cos({Re})*{_n(dy)})")
        names = ["x0", "y0", "x1", "y1", "x2", "y2", "x3", "y3"]
        persp = ":".join(f"{nm}='{e}'" for nm, e in zip(names, corners))
        g.append(f"[{lab}]scale={iw}:{ih}:flags=bicubic,pad={CW}:{CH}:{ox}:{oy}:color=black@0,perspective={persp}:sense=destination:eval=frame:interpolation=linear,crop={W}:{H}:{mg}:{mg},format=gbrap[{out}]")
    lab = new("c")
    g.append(f"[{out}]fps={R}[{lab}]")  # xfade vuole una frequenza costante dichiarata
    # ---- transizioni su un solo lato (inizio o fine della clip senza clip adiacente)
    for side in ("_tin", "_tout"):
        t = c[side]
        if not t or t[0] != "single":
            continue
        tr = t[1]
        d = min(float(tr["dur"]), L)
        typ = tr.get("type", "fade")
        o_ = new("c")
        if typ == "fade":
            st = 0 if side == "_tin" else L - d
            g.append(f"[{lab}]fade=t={'in' if side == '_tin' else 'out'}:st={_n(st)}:d={_n(d)}:alpha=1[{o_}]")
        else:
            z = new()
            g.append(f"color=c=black@0:s={W}x{H}:r={R}:d={_n(d)},format=gbrap[{z}]")
            if side == "_tin":
                g.append(f"[{z}][{lab}]xfade=transition={XFADE.get(typ, 'fade')}:duration={_n(d)}:offset=0[{o_}]")
            else:
                g.append(f"[{lab}][{z}]xfade=transition={XFADE.get(typ, 'fade')}:duration={_n(d)}:offset={_n(L - d)}[{o_}]")
        lab = o_
    return lab


def _effects(c, sw, sh, luts, work, fps):
    out = []
    for e in c.get("fx") or []:
        if e.get("on") is False:
            continue
        t, p = e.get("type"), e.get("p") or {}
        if t == "color":
            C = 1 + float(p.get("contrast", 0)) / 100
            B = float(p.get("bright", 0)) / 200
            G = max(0.1, float(p.get("gamma", 1)))
            if abs(C - 1) > 1e-4 or abs(B) > 1e-4 or abs(G - 1) > 1e-4:
                ex = f"clip(pow(clip((val/255-0.5)*{_n(C)}+0.5+{_n(B)},0,1),{_n(1 / G)})*255,0,255)"
                out.append(f"lutrgb=r='{ex}':g='{ex}':b='{ex}'")
            s = float(p.get("sat", 100)) / 100
            tr_, tg_, tb_ = 1 + 0.25 * float(p.get("temp", 0)) / 100, 1 - 0.25 * float(p.get("tint", 0)) / 100, 1 - 0.25 * float(p.get("temp", 0)) / 100
            if abs(s - 1) > 1e-4 or abs(tr_ - 1) > 1e-4 or abs(tg_ - 1) > 1e-4:
                out.append(_mixer(s, (tr_, tg_, tb_)))
        elif t == "bw":
            out.append(_mixer(0, (1, 1, 1)))
        elif t == "blur":
            sg = float(p.get("sigma", 5))
            if sg > 0.05:
                out.append(f"gblur=sigma={_n(sg)}:steps=3")
        elif t == "sharpen":
            k = round(float(p.get("amount", 0.5)) * 10)
            if k:
                m = f"0 {-k} 0 {-k} {10 + 4 * k} {-k} 0 {-k} 0"
                out.append(f"convolution=0m='{m}':1m='{m}':2m='{m}':3m='0 0 0 0 1 0 0 0 0':0rdiv=0.1:1rdiv=0.1:2rdiv=0.1:3rdiv=1")
        elif t == "chroma":
            col = (p.get("color") or "#00ff00").lstrip("#")
            out.append(f"colorkey=color=0x{col}:similarity={_n(max(0.001, float(p.get('sim', 30)) / 100))}:blend={_n(float(p.get('blend', 10)) / 100)}")
        elif t == "lut":
            src = luts.get(p.get("file") or "") or p.get("file")
            if src and os.path.isfile(src):
                name = f"lut{len(list(work.glob('lut*.cube')))}.cube"
                shutil.copy(src, work / name)
                out.append(f"lut3d=file={name}:interp=trilinear")
        elif t == "mirror":
            if p.get("h", True):
                out.append("hflip")
            if p.get("v"):
                out.append("vflip")
        elif t == "crop":
            l_, t_, r_, b_ = (max(0.0, min(100.0, float(p.get(k, 0)))) / 100 for k in ("l", "t", "r", "b"))
            x0, y0 = round(sw * l_), round(sh * t_)
            w, h = max(1, round(sw * (1 - l_ - r_))), max(1, round(sh * (1 - t_ - b_)))
            if (w, h) != (sw, sh):
                out.append(f"crop={w}:{h}:{x0}:{y0},pad={sw}:{sh}:{x0}:{y0}:color=black@0")
    return out


def _mixer(s, mul):
    wr, wg, wb = LUMA
    rows = []
    for i, k in enumerate(mul):
        r = [(1 - s) * wr, (1 - s) * wg, (1 - s) * wb]
        r[i] += s
        rows.append([v * k for v in r])
    names = ["rr", "rg", "rb", "gr", "gg", "gb", "br", "bg", "bb"]
    vals = [v for r in rows for v in r]
    return "colorchannelmixer=" + ":".join(f"{n}={v:.6f}" for n, v in zip(names, vals))


def _atempo(sp):
    out = []
    while sp > 2.0:
        out.append("atempo=2.0")
        sp /= 2
    while sp < 0.5:
        out.append("atempo=0.5")
        sp /= 0.5
    if abs(sp - 1) > 1e-4:
        out.append(f"atempo={_n(sp)}")
    return out


def _audio_stream(c, m, track_gain, add_input, g, new):
    ss, tl, fpre, fpost, sp = _src_window(c, m, 1)
    L = c["_pre"] + c["dur"] + c["_post"]
    k = add_input("-ss", _n(max(0.0, ss)), "-t", _n(tl + 0.2), "-i", m["path"])
    ch = ["aformat=sample_rates=48000:channel_layouts=stereo", "asetpts=PTS-STARTPTS", *_atempo(sp)]
    if fpre > 0.001:
        ch.append(f"adelay={round(fpre * 1000)}:all=1")
    ch += [f"apad=whole_dur={_n(L + 0.1)}", f"atrim=end={_n(L)}", "asetpts=PTS-STARTPTS"]
    static_db = float(c.get("gain") or 0) + track_gain
    vk = _keys(c, "volume")
    if vk:
        T = f"(t-{_n(c['_pre'])})"
        ch.append(f"volume='pow(10,(({_kf_expr(vk, T, 0)})+{_n(static_db)})/20)':eval=frame")
    else:
        db = static_db + float(c.get("volume") or 0)
        if abs(db) > 0.001:
            ch.append(f"volume={_n(10 ** (db / 20))}")
    for side in ("_tin", "_tout"):
        t = c[side]
        if not t:
            continue
        tr = t[1]
        d = min(float(tr["dur"]), L)
        curve = "qsin" if tr.get("type") == "power" else "tri"
        if side == "_tin":
            ch.append(f"afade=t=in:st=0:d={_n(d)}:curve={curve}")
        else:
            ch.append(f"afade=t=out:st={_n(L - d)}:d={_n(d)}:curve={curve}")
    delay = max(0, round((c["start"] - c["_pre"]) * 1000))
    if delay:
        ch.append(f"adelay={delay}:all=1")
    lab = new("a")
    g.append(f"[{k}:a]{','.join(ch)}[{lab}]")
    return lab
