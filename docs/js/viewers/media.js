// Audio e video: riproduzione nativa o conversione automatica con FFmpeg; taglio, rotazione, estrazione audio, fotogrammi, conversione.
import { api, button, dirName, el, fileUrl, fmtTime, loading, modal, pickSavePath, toast, waitJob, withExt } from "../core.js";

const NATIVE_V = new Set(["mp4", "m4v", "webm", "ogv", "mov"]);
const NATIVE_A = new Set(["mp3", "wav", "wave", "flac", "ogg", "oga", "opus", "m4a", "aac"]);

export async function mount(ctx) {
  const ld = loading(ctx.el, "Analisi del file multimediale");
  const probe = await api("media_probe", { path: ctx.path });
  const isVideo = probe.video;
  let src = fileUrl(ctx.path);
  const tryNative = (isVideo ? NATIVE_V : NATIVE_A).has(ctx.ext);
  const media = el(isVideo ? "video" : "audio", { controls: true, preload: "metadata", style: { maxWidth: "100%", maxHeight: "100%", width: isVideo ? "100%" : "min(720px, 90%)", background: "#000", outline: "none" } });

  async function convert() {
    ld.set(0, "Conversione in un formato riproducibile");
    const j = await api("media_playable", { path: ctx.path });
    const r = await waitJob(j.job, p => ld.set(p, `Conversione in corso: ${Math.round(p * 100)}%`));
    return fileUrl(r.path);
  }
  const playable = await new Promise(res => {
    if (!tryNative) return res(false);
    const t = document.createElement(isVideo ? "video" : "audio");
    t.preload = "metadata";
    t.onloadedmetadata = () => res(isVideo ? t.videoWidth > 0 : true);
    t.onerror = () => res(false);
    setTimeout(() => res(false), 6000);
    t.src = src;
  });
  if (!playable) src = await convert();
  media.src = src;
  ctx.el.innerHTML = "";

  // forma d'onda per l'audio
  const wave = el("canvas", { style: { width: "min(720px, 90%)", height: "120px", display: isVideo ? "none" : "block" } });
  const stage = el("div", { style: { height: "100%", display: "grid", placeItems: "center", alignContent: "center", gap: "16px", padding: "14px", background: isVideo ? "#000" : "transparent" } },
    !isVideo ? el("div", { style: { fontSize: "18px", fontWeight: 600 } }, ctx.name) : null, wave, media);
  ctx.el.append(stage);
  ctx.fillBody(true);
  if (!isVideo) api("media_waveform", { path: ctx.path }).then(r => drawWave(r.peaks)).catch(() => { });

  function drawWave(peaks) {
    const dpr = devicePixelRatio || 1, W = wave.clientWidth * dpr, H = wave.clientHeight * dpr;
    wave.width = W; wave.height = H;
    const g = wave.getContext("2d");
    const css = getComputedStyle(document.documentElement);
    const paint = () => {
      g.clearRect(0, 0, W, H);
      const pos = media.duration ? media.currentTime / media.duration : 0;
      peaks.forEach((p, i) => {
        const x = (i / peaks.length) * W, h = Math.max(1, p * H * 0.95);
        g.fillStyle = i / peaks.length < pos ? css.getPropertyValue("--accent") : css.getPropertyValue("--line");
        g.fillRect(x, (H - h) / 2, Math.max(1, W / peaks.length - 0.5), h);
      });
      if (inP !== null) { g.fillStyle = "rgba(255,159,26,.25)"; const a = inP / media.duration * W, b = (outP ?? media.duration) / media.duration * W; g.fillRect(a, 0, b - a, H); }
    };
    media.addEventListener("timeupdate", paint);
    wave.addEventListener("click", e => { const r = wave.getBoundingClientRect(); media.currentTime = ((e.clientX - r.left) / r.width) * media.duration; });
    paint();
    repaint = paint;
  }
  let repaint = () => { };

  // ---- punti di taglio
  let inP = null, outP = null;
  const marks = el("span", { class: "note" }, "Taglio: intero file");
  const showMarks = () => { marks.textContent = inP === null && outP === null ? "Taglio: intero file" : `Taglio: ${fmtTime(inP ?? 0)} → ${fmtTime(outP ?? media.duration)}`; repaint(); };
  const speed = el("select", { id: "spd-" + ctx.tab.name, title: "Velocita'", onchange: e => (media.playbackRate = +e.target.value) },
    ...[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3].map(v => el("option", { value: v, selected: v === 1 }, v + "×")));
  const step = d => { media.pause(); media.currentTime = Math.max(0, media.currentTime + d); };
  ctx.tb.append(
    speed,
    isVideo ? button("", "rotateL", () => step(-1 / 25), { iconOnly: true, title: "Fotogramma precedente" }) : null,
    isVideo ? button("", "rotate", () => step(1 / 25), { iconOnly: true, title: "Fotogramma successivo" }) : null,
    el("span", { class: "sep" }),
    button("Inizio qui", "scissors", () => { inP = media.currentTime; if (outP !== null && outP <= inP) outP = null; showMarks(); }, { title: "Imposta l'inizio del taglio alla posizione attuale" }),
    button("Fine qui", "scissors", () => { outP = media.currentTime; if (inP !== null && inP >= outP) inP = null; showMarks(); }, { title: "Imposta la fine del taglio alla posizione attuale" }),
    button("Azzera", null, () => { inP = outP = null; showMarks(); }), marks,
    el("span", { class: "sep" }),
    button("Esporta / converti", "download", () => exportDialog()),
    isVideo ? button("Fotogramma", "camera", async () => {
      const out = await pickSavePath(withExt(ctx.name.replace(/\.[^.]+$/, "") + "_" + Math.round(media.currentTime) + "s.x", "png"), dirName(ctx.path));
      if (!out) return;
      await api("media_frame", { path: ctx.path }, { json: { t: media.currentTime, out } });
      toast("Fotogramma salvato");
    }, { title: "Salva il fotogramma attuale come immagine" }) : null,
    el("span", { class: "grow" }),
    el("span", { class: "note" }, (probe.flussi || []).map(s => s.tipo + ": " + s.dettagli.split(",")[0]).join(" · ")));
  [...ctx.tb.childNodes].forEach(n => { if (n.nodeType === 3 && n.textContent === "null") n.remove(); });

  async function exportDialog(defaultExt) {
    const fmtSel = el("select", { id: "exp-fmt-" + ctx.tab.name, class: "field" },
      ...(isVideo ? ["mp4", "webm", "mkv", "mov", "avi", "gif"] : []).map(f => el("option", { value: f }, "Video " + f.toUpperCase())),
      ...["mp3", "wav", "flac", "ogg", "m4a", "opus"].map(f => el("option", { value: f }, "Solo audio " + f.toUpperCase())));
    if (defaultExt) fmtSel.value = defaultExt;
    const rot = el("select", { id: "exp-rot-" + ctx.tab.name, class: "field" }, el("option", { value: 0 }, "Nessuna rotazione"), el("option", { value: 90 }, "Ruota 90° orario"), el("option", { value: 180 }, "Ruota 180°"), el("option", { value: 270 }, "Ruota 90° antiorario"));
    const mute = el("input", { type: "checkbox", id: "exp-mute-" + ctx.tab.name });
    const vol = el("input", { type: "range", min: 0, max: 300, value: 100, id: "exp-vol-" + ctx.tab.name });
    const volL = el("span", {}, "100%");
    vol.addEventListener("input", () => (volL.textContent = vol.value + "%"));
    const body = el("div", { style: { display: "grid", gap: "10px" } },
      el("label", { style: { display: "grid", gap: "4px" } }, "Formato di uscita", fmtSel),
      el("div", {}, marks.textContent),
      isVideo ? el("label", { style: { display: "grid", gap: "4px" } }, "Rotazione", rot) : null,
      isVideo ? el("label", { style: { display: "flex", gap: "8px" } }, mute, "Rimuovi l'audio") : null,
      el("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, "Volume", vol, volL));
    const ok = await modal("Esporta / converti", body, [{ label: "Annulla", value: false }, { label: "Scegli dove salvare", value: true, primary: true }]);
    if (!ok) return;
    const ext = fmtSel.value;
    const out = await pickSavePath(withExt(ctx.name.replace(/(\.[^.]+)$/, "_modificato$1"), ext), dirName(ctx.path));
    if (!out) return;
    await exportTo(out, { rotate: +rot.value, mute: mute.checked, volume: +vol.value / 100 });
  }

  async function exportTo(out, o = {}) {
    const ext = out.split(".").pop().toLowerCase();
    const j = await api("media_edit", { path: ctx.path }, { json: { out, start: inP, end: outP, rotate: o.rotate || 0, mute: !!o.mute, audio_only: !["mp4", "webm", "mkv", "mov", "avi", "gif", "m4v", "wmv", "flv", "mpg", "ts"].includes(ext), volume: o.volume ?? 1 } });
    toast("Esportazione avviata...");
    try {
      await waitJob(j.job, p => ctx.status(`Esportazione ${Math.round(p * 100)}%`));
      ctx.status("Esportazione completata");
      toast("Esportato: " + out);
    } catch (e) { toast("Esportazione non riuscita: " + e.message, true, 7000); }
  }

  media.addEventListener("loadedmetadata", () => ctx.status(`Durata ${fmtTime(media.duration)}` + (isVideo ? ` · ${media.videoWidth}×${media.videoHeight}` : "") + (playable ? "" : " · convertito per la riproduzione")));
  return {
    saveInPlace: false,
    saveAsName: () => ctx.name.replace(/(\.[^.]+)$/, "_modificato$1"),
    async save(target) { await exportTo(target); return { switchTo: false }; },
    dispose() { media.pause(); media.removeAttribute("src"); media.load(); },
  };
}
