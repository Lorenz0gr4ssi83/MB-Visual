"""Collaudo audio/video: crea file reali in molti formati con FFmpeg e li fa passare dal motore di riproduzione di MB Visual."""
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from mbvisual import media  # noqa: E402
from mbvisual.paths import find_ffmpeg  # noqa: E402

FF = find_ffmpeg()
OUT = Path(tempfile.gettempdir()) / "MBVisual_test_media"
OUT.mkdir(exist_ok=True)
A = ["-f", "lavfi", "-i", "sine=frequency=440:duration=2"]
V = ["-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=25"]
AUDIO = {"mp3": [], "wav": [], "flac": [], "ogg": ["-c:a", "libvorbis"], "opus": ["-c:a", "libopus"], "m4a": [], "aac": [],
         "ac3": [], "eac3": [], "aiff": [], "aif": ["-f", "aiff"], "caf": [], "au": [], "w64": [], "wv": [], "tta": [], "mka": [],
         "mp2": [], "mpa": ["-f", "mp2"], "spx": ["-c:a", "libspeex", "-ar", "16000"], "amr": ["-c:a", "libopencore_amrnb", "-ar", "8000", "-ac", "1"],
         "g722": ["-ar", "16000"], "sbc": ["-ar", "44100"], "aptx": ["-ar", "48000", "-ac", "2"], "dfpwm": ["-ar", "48000", "-ac", "1"],
         "gsm": ["-ar", "8000", "-ac", "1"], "voc": [], "wma": ["-f", "asf", "-c:a", "wmav2"], "oga": ["-f", "ogg", "-c:a", "libvorbis"],
         "mlp": ["-ar", "48000", "-strict", "-2"], "truehd": ["-ar", "48000", "-strict", "-2"], "dts": ["-c:a", "dca", "-strict", "-2", "-ar", "48000"],
         "rso": ["-ar", "8000", "-ac", "1", "-c:a", "pcm_u8"], "sox": [], "ircam": ["-f", "au"], "ul": ["-f", "mulaw", "-ar", "8000", "-ac", "1"],
         "al": ["-f", "alaw", "-ar", "8000", "-ac", "1"], "adx": ["-c:a", "adpcm_adx"], "ast": ["-c:a", "pcm_s16be_planar"], "rf64": ["-f", "wav", "-rf64", "always"]}
VIDEO = {"mp4": [], "mkv": [], "webm": ["-c:v", "libvpx", "-b:v", "500k"], "avi": [], "mov": [], "flv": [], "mpg": ["-f", "mpeg"], "mpeg": ["-f", "mpeg"],
         "ts": [], "m2ts": ["-f", "mpegts"], "mts": ["-f", "mpegts"], "3gp": ["-c:v", "h263", "-s", "352x288"], "3g2": ["-c:v", "h263", "-s", "352x288"],
         "asf": [], "wmv": ["-f", "asf", "-c:v", "wmv2"], "mxf": ["-c:v", "mpeg2video"], "nut": [], "dv": ["-c:v", "dvvideo", "-s", "720x576", "-pix_fmt", "yuv420p", "-r", "25"],
         "ogv": ["-f", "ogg", "-c:v", "libtheora"], "m4v": ["-f", "ipod"], "f4v": ["-f", "f4v"], "vob": ["-f", "vob"], "y4m": [], "ivf": ["-c:v", "libvpx"],
         "h264": ["-c:v", "libx264", "-f", "h264"], "264": ["-c:v", "libx264", "-f", "h264"], "hevc": ["-c:v", "libx265", "-f", "hevc"],
         "h261": ["-c:v", "h261", "-s", "352x288", "-f", "h261"], "m1v": ["-c:v", "mpeg1video", "-f", "mpeg1video"], "m2v": ["-c:v", "mpeg2video", "-f", "mpeg2video"],
         "mjpeg": ["-c:v", "mjpeg", "-f", "mjpeg"], "rm": ["-c:v", "rv20", "-s", "352x288"], "swf": ["-c:v", "flv1"], "gxf": ["-c:v", "mpeg2video", "-s", "720x576", "-r", "25", "-pix_fmt", "yuv420p"],
         "gif": [], "mj2": ["-c:v", "jpeg2000", "-f", "mj2"], "avs2": [], "ser": ["-f", "ser"] if False else None}


def make(ext, extra, video):
    out = OUT / f"prova.{ext}"
    args = [FF, "-y", "-loglevel", "error", *(V if video else []), *A, *extra]
    if not video:
        args += ["-vn"]
    args.append(str(out))
    r = subprocess.run(args, capture_output=True, creationflags=0x08000000)
    return out if r.returncode == 0 and out.exists() and out.stat().st_size > 0 else None, r.stderr.decode("utf-8", "replace")[-160:]


def main():
    ok, fail, nogen = [], [], []
    for group, video in ((AUDIO, False), (VIDEO, True)):
        for ext, extra in group.items():
            if extra is None:
                continue
            f, err = make(ext, extra, video)
            if not f:
                nogen.append(f"{ext} ({err.strip()[:90]})")
                continue
            try:
                r = media.playable(str(f), lambda **k: None)
                info = r["info"]
                if (video and not info["video"] and ext != "gif") or (not info["audio"] and not info["video"]):
                    raise RuntimeError("flussi non riconosciuti")
                ok.append(ext)
            except Exception as e:  # noqa: BLE001
                fail.append(f"{ext}: {e}")
    print("APERTI CORRETTAMENTE (%d): %s" % (len(ok), " ".join(ok)))
    print("FALLITI (%d):" % len(fail), *fail, sep="\n  ")
    print("NON GENERABILI QUI (%d):" % len(nogen), *nogen, sep="\n  ")


if __name__ == "__main__":
    main()
