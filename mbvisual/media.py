"""Audio e video tramite FFmpeg (incluso nell'app): analisi, conversione per la riproduzione, modifiche."""
import hashlib
import os
import re
import subprocess
from pathlib import Path

from .paths import TEMP_DIR, find_ffmpeg
from .i18n import t as tr

NO_WINDOW = 0x08000000
CACHE = TEMP_DIR / "media"
CACHE.mkdir(parents=True, exist_ok=True)


def _ffmpeg():
    exe = find_ffmpeg()
    if not exe:
        raise RuntimeError(tr("srv_media.ffmpeg_non_disponibile"))
    return exe


def _parse_duration(text: str) -> float | None:
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if not m:
        return None
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)


def probe(path: str) -> dict:
    r = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path], capture_output=True, creationflags=NO_WINDOW)
    text = r.stderr.decode("utf-8", "replace")
    streams = []
    for m in re.finditer(r"Stream #\d+:\d+(?:\[\w+\])?(?:\((\w+)\))?: (Video|Audio|Subtitle|Data|Attachment): ([^\n]+)", text):
        lang, kind, desc = m.groups()
        streams.append({"tipo": kind, "lingua": lang, "dettagli": desc.strip()})
    return {"durata": _parse_duration(text), "flussi": streams,
            "video": any(s["tipo"] == "Video" and "attached pic" not in s["dettagli"] for s in streams),
            "audio": any(s["tipo"] == "Audio" for s in streams),
            "formato": (re.search(r"Input #0, ([^,]+(?:,[^,]+)*), from", text) or [None, None])[1]}


def _run_with_progress(args: list[str], duration: float | None, update) -> None:
    proc = subprocess.Popen(args, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, creationflags=NO_WINDOW)
    buf = b""
    tail = []
    while True:
        chunk = proc.stderr.read(512)
        if not chunk:
            break
        buf += chunk
        *lines, buf = re.split(rb"[\r\n]", buf)
        for line in lines:
            s = line.decode("utf-8", "replace")
            if s:
                tail = (tail + [s])[-15:]
            m = re.search(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)", s)
            if m and duration:
                h, mi, sec = m.groups()
                update(progress=(int(h) * 3600 + int(mi) * 60 + float(sec)) / duration)
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError("FFmpeg: " + " | ".join(tail[-4:]))


def playable(path: str, update) -> dict:
    """Converte in un formato riproducibile (MP4 H.264/AAC o M4A) con cache."""
    st = os.stat(path)
    key = hashlib.sha1(f"{path}|{st.st_size}|{st.st_mtime}".encode()).hexdigest()[:16]
    info = probe(path)
    is_video = info["video"]
    out = CACHE / (key + (".mp4" if is_video else ".m4a"))
    if out.exists() and out.stat().st_size > 0:
        return {"path": str(out), "info": info}
    update(message=tr("srv_media.conversione_riproduzione"))
    tmp = out.with_suffix(".part" + out.suffix)
    args = [_ffmpeg(), "-y", "-hide_banner", "-i", path]
    if is_video:
        args += ["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                 "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
                 "-movflags", "+faststart", "-f", "mp4", str(tmp)]
    else:
        args += ["-vn", "-map", "0:a:0", "-c:a", "aac", "-b:a", "256k", "-ac", "2", "-ar", "48000", "-f", "ipod", str(tmp)]
    _run_with_progress(args, info["durata"], update)
    tmp.replace(out)
    return {"path": str(out), "info": info}


def edit(path: str, out_path: str, start: float | None = None, end: float | None = None, rotate: int = 0,
         mute: bool = False, audio_only: bool = False, volume: float | None = None, update=None) -> dict:
    """Taglio / rotazione / rimozione audio / estrazione audio / volume / conversione (formato dall'estensione di uscita)."""
    info = probe(path)
    ext = Path(out_path).suffix.lower()
    args = [_ffmpeg(), "-y", "-hide_banner"]
    if start:
        args += ["-ss", f"{start:.3f}"]
    args += ["-i", path]
    if end is not None:
        args += ["-t", f"{max(0.01, end - (start or 0)):.3f}"]
    vf, af = [], []
    if rotate in (90, 180, 270):
        vf.append({90: "transpose=1", 180: "transpose=1,transpose=1", 270: "transpose=2"}[rotate])
    if volume is not None and volume != 1:
        af.append(f"volume={volume:.3f}")
    if ext == ".gif":
        vf.append("fps=12,scale='min(720,iw)':-2:flags=lanczos")
        args += ["-an"]
    audio_exts = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".opus", ".aac", ".wma", ".aiff", ".ac3"}
    if audio_only or ext in audio_exts:
        args += ["-vn"]
        if ext == ".mp3":
            args += ["-c:a", "libmp3lame", "-q:a", "2"]
        elif ext == ".ogg":
            args += ["-c:a", "libvorbis", "-q:a", "6"]
        elif ext == ".opus":
            args += ["-c:a", "libopus", "-b:a", "160k"]
        elif ext in (".m4a", ".aac"):
            args += ["-c:a", "aac", "-b:a", "256k", "-ac", "2"]
    elif ext != ".gif":
        if ext == ".webm":
            args += ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-c:a", "libopus"]
        else:
            args += ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ac", "2"]
            if ext in (".mp4", ".mov", ".m4v"):
                args += ["-movflags", "+faststart"]
        if mute:
            args += ["-an"]
    if vf:
        args += ["-vf", ",".join(vf)]
    if af and not mute:
        args += ["-af", ",".join(af)]
    args.append(out_path)
    dur = info["durata"]
    if dur and end is not None:
        dur = end - (start or 0)
    elif dur and start:
        dur = dur - start
    _run_with_progress(args, dur, update or (lambda **k: None))
    return {"path": out_path}


def frame(path: str, t: float, out_path: str) -> str:
    r = subprocess.run([_ffmpeg(), "-y", "-hide_banner", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1", out_path],
                       capture_output=True, creationflags=NO_WINDOW)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode("utf-8", "replace")[-400:])
    return out_path


def waveform(path: str, points: int = 1200) -> list[float]:
    """Picchi audio normalizzati per disegnare la forma d'onda."""
    r = subprocess.run([_ffmpeg(), "-hide_banner", "-i", path, "-vn", "-ac", "1", "-ar", "8000", "-f", "u8", "-"],
                       capture_output=True, creationflags=NO_WINDOW)
    data = r.stdout
    if not data:
        return []
    step = max(1, len(data) // points)
    peaks = []
    for i in range(0, len(data), step):
        block = data[i:i + step]
        peaks.append(max(abs(b - 128) for b in block) / 128)
    return peaks[:points]
