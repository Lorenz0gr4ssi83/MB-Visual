// Audio e video: riproduzione nativa o conversione automatica con FFmpeg; taglio, rotazione, estrazione audio, fotogrammi, conversione.
import { t as tr } from "../i18n.js";
import { api, button, dirName, el, fileUrl, fmtTime, loading, modal, pickSavePath, toast, waitJob, withExt } from "../core.js";
import { keymap } from "../shortcuts.js";

const NATIVE_V = new Set(["mp4", "m4v", "webm", "ogv", "mov"]);
const NATIVE_A = new Set(["mp3", "wav", "wave", "flac", "ogg", "oga", "opus", "m4a", "aac"]);

export async function mount(ctx) {
  const ld = loading(ctx.el, tr("v_media.analisi_file_multimediale"));
  const probe = await api("media_probe", { path: ctx.path });
  const isVideo = probe.video;
  let src = fileUrl(ctx.path);
  const tryNative = (isVideo ? NATIVE_V : NATIVE_A).has(ctx.ext);
  const media = el(isVideo ? "video" : "audio", { controls: true, preload: "metadata", style: { maxWidth: "100%", maxHeight: "100%", width: isVideo ? "100%" : "min(720px, 90%)", background: "#000", outline: "none" } });

  async function convert() {
    ld.set(0, tr("v_media.conversione_formato_riproducibile"));
    const j = await api("media_playable", { path: ctx.path });
    const r = await waitJob(j.job, p => ld.set(p, tr("v_media.conversione_corso_0", Math.round(p * 100))));
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
  const marks = el("span", { class: "note" }, tr("v_media.taglio_intero_file"));
  const showMarks = () => { marks.textContent = inP === null && outP === null ? tr("v_media.taglio_intero_file") : `Taglio: ${fmtTime(inP ?? 0)} → ${fmtTime(outP ?? media.duration)}`; repaint(); };
  const speed = el("select", { id: "spd-" + ctx.tab.name, title: tr("v_media.velocita"), onchange: e => (media.playbackRate = +e.target.value) },
    ...[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3].map(v => el("option", { value: v, selected: v === 1 }, v + "×")));
  const step = d => { media.pause(); media.currentTime = Math.max(0, media.currentTime + d); };
  ctx.tb.append(
    speed,
    isVideo ? button("", "rotateL", () => step(-1 / 25), { iconOnly: true, title: tr("v_media.fotogramma_precedente") }) : null,
    isVideo ? button("", "rotate", () => step(1 / 25), { iconOnly: true, title: tr("v_media.fotogramma_successivo") }) : null,
    el("span", { class: "sep" }),
    button(tr("v_media.inizio_qui"), "scissors", () => { inP = media.currentTime; if (outP !== null && outP <= inP) outP = null; showMarks(); }, { title: tr("v_media.imposta_l_inizio_taglio_posizione") }),
    button(tr("v_media.fine_qui"), "scissors", () => { outP = media.currentTime; if (inP !== null && inP >= outP) inP = null; showMarks(); }, { title: tr("v_media.imposta_fine_taglio_posizione_attuale") }),
    button(tr("v_media.azzera"), null, () => { inP = outP = null; showMarks(); }), marks,
    el("span", { class: "sep" }),
    button(tr("v_media.esporta_converti"), "download", () => exportDialog()),
    button(tr("v_media.apri_montaggio"), "edit", () => openInEditor(), { title: tr("v_media.crea_progetto_montaggio_video_stile") }),
    isVideo ? button(tr("v_media.fotogramma"), "camera", async () => {
      const out = await pickSavePath(withExt(ctx.name.replace(/\.[^.]+$/, "") + "_" + Math.round(media.currentTime) + "s.x", "png"), dirName(ctx.path));
      if (!out) return;
      await api("media_frame", { path: ctx.path }, { json: { t: media.currentTime, out } });
      toast(tr("v_media.fotogramma_salvato"));
    }, { title: tr("v_media.salva_fotogramma_attuale_come_immagine") }) : null,
    el("span", { class: "grow" }),
    el("span", { class: "note" }, (probe.flussi || []).map(s => s.tipo + ": " + s.dettagli.split(",")[0]).join(" · ")));
  [...ctx.tb.childNodes].forEach(n => { if (n.nodeType === 3 && n.textContent === "null") n.remove(); });
  // tasti di Premiere / VLC
  const markIn = () => { inP = media.currentTime; if (outP !== null && outP <= inP) outP = null; showMarks(); };
  const markOut = () => { outP = media.currentTime; if (inP !== null && inP >= outP) inP = null; showMarks(); };
  const toggle = () => (media.paused ? media.play() : media.pause());
  const seek = d => { media.currentTime = Math.max(0, Math.min(media.duration || 0, media.currentTime + d)); };
  let shuttle = 1;
  keymap(ctx, "Premiere / VLC", [
    { keys: "Space|K", desc: tr("v_media.riproduci_pausa"), run: toggle, group: tr("v_media.riproduzione") },
    { keys: "L", desc: tr("v_media.avanti_premuto_piu_volte_piu"), run: () => { shuttle = media.paused ? 1 : Math.min(8, shuttle * 2); media.playbackRate = shuttle; media.play(); ctx.status(tr("v_media.velocita_0", shuttle)); }, group: tr("v_media.riproduzione") },
    { keys: "J", desc: tr("v_media.indietro_5_secondi"), run: () => seek(-5), group: tr("v_media.riproduzione") },
    { keys: "ArrowLeft", desc: tr("v_media.indietro_5_secondi"), run: () => seek(-5), group: tr("v_media.riproduzione") },
    { keys: "ArrowRight", desc: tr("v_media.avanti_5_secondi"), run: () => seek(5), group: tr("v_media.riproduzione") },
    { keys: ",", desc: tr("v_media.fotogramma_precedente"), run: () => step(-1 / 25), group: tr("v_media.riproduzione") },
    { keys: ".", desc: tr("v_media.fotogramma_successivo"), run: () => step(1 / 25), group: tr("v_media.riproduzione") },
    { keys: "Home", desc: tr("v_media.vai_all_inizio"), run: () => { media.currentTime = 0; }, group: tr("v_media.riproduzione") },
    { keys: "End", desc: tr("v_media.vai_fine"), run: () => { media.currentTime = media.duration || 0; }, group: tr("v_media.riproduzione") },
    { keys: "M", desc: tr("v_media.audio_si_no"), run: () => { media.muted = !media.muted; }, group: tr("v_media.riproduzione") },
    ...(isVideo ? [{ keys: "F", desc: tr("v_media.schermo_intero"), run: () => (document.fullscreenElement ? document.exitFullscreen() : media.requestFullscreen?.()), group: tr("v_media.riproduzione") }] : []),
    { keys: "I", desc: tr("v_media.inizio_taglio_qui_punto_attacco"), run: markIn, group: tr("v_media.taglio") },
    { keys: "O", desc: tr("v_media.fine_taglio_qui_punto_stacco"), run: markOut, group: tr("v_media.taglio") },
    { keys: "Ctrl+Shift+X", desc: tr("v_media.azzera_i_punti_taglio"), run: () => { inP = outP = null; showMarks(); }, group: tr("v_media.taglio") },
    { keys: "Ctrl+M", desc: tr("v_media.esporta_converti"), run: () => exportDialog(), group: tr("v_media.taglio") },
  ]);

  // nuovo progetto di montaggio (.mbvid) con questo file gia' in timeline, adattato alle sue dimensioni
  async function openInEditor() {
    const { newProject, uid } = await import("../vidmodel.js");
    const i = await api("video_info", { path: ctx.path });
    const P = newProject({ w: i.w || 1920, h: i.h || 1080, fps: i.fps ? [23.976, 24, 25, 29.97, 30, 50, 59.94, 60].reduce((b, r) => (Math.abs(r - i.fps) < Math.abs(b - i.fps) ? r : b), 25) : 25 });
    const m = { id: uid("m"), path: ctx.path, name: ctx.name, kind: i.video ? "video" : "audio", dur: i.dur, w: i.w, h: i.h, fps: i.fps, audio: !!i.audio };
    P.media.push(m);
    const link = m.kind === "video" && m.audio ? uid("l") : null;
    const fr = 1 / P.settings.fps, dur = Math.max(fr, Math.floor((i.dur || 1) / fr) * fr);
    if (m.kind === "video") P.clips.push({ id: uid("c"), kind: "video", track: "V1", media: m.id, start: 0, dur, in: 0, speed: 1, link, name: m.name, motion: { x: P.settings.w / 2, y: P.settings.h / 2, scale: 100, rot: 0 }, opacity: 100, blend: "normal", fx: [], kf: {} });
    if (m.audio) P.clips.push({ id: uid("c"), kind: "audio", track: "A1", media: m.id, start: 0, dur, in: 0, speed: 1, link, name: m.name, volume: 0, gain: 0, fx: [], kf: {} });
    const path = (await api("temp_path", { name: ctx.name.replace(/\.[^.]+$/, "") + " - montaggio.mbvid" })).path;
    await api("save", { path }, { body: new TextEncoder().encode(JSON.stringify(P, null, 1)) });
    ctx.openFile(path, null, { untitled: true });
  }

  async function exportDialog(defaultExt) {
    const fmtSel = el("select", { id: "exp-fmt-" + ctx.tab.name, class: "field" },
      ...(isVideo ? ["mp4", "webm", "mkv", "mov", "avi", "gif"] : []).map(f => el("option", { value: f }, tr("v_media.video") + f.toUpperCase())),
      ...["mp3", "wav", "flac", "ogg", "m4a", "opus"].map(f => el("option", { value: f }, tr("v_media.solo_audio") + f.toUpperCase())));
    if (defaultExt) fmtSel.value = defaultExt;
    const rot = el("select", { id: "exp-rot-" + ctx.tab.name, class: "field" }, el("option", { value: 0 }, tr("v_media.nessuna_rotazione")), el("option", { value: 90 }, tr("v_media.ruota_90_orario")), el("option", { value: 180 }, tr("v_media.ruota_180")), el("option", { value: 270 }, tr("v_media.ruota_90_antiorario")));
    const mute = el("input", { type: "checkbox", id: "exp-mute-" + ctx.tab.name });
    const vol = el("input", { type: "range", min: 0, max: 300, value: 100, id: "exp-vol-" + ctx.tab.name });
    const volL = el("span", {}, "100%");
    vol.addEventListener("input", () => (volL.textContent = vol.value + "%"));
    const body = el("div", { style: { display: "grid", gap: "10px" } },
      el("label", { style: { display: "grid", gap: "4px" } }, tr("v_media.formato_uscita"), fmtSel),
      el("div", {}, marks.textContent),
      isVideo ? el("label", { style: { display: "grid", gap: "4px" } }, tr("v_media.rotazione"), rot) : null,
      isVideo ? el("label", { style: { display: "flex", gap: "8px" } }, mute, tr("v_media.rimuovi_l_audio")) : null,
      el("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, tr("v_media.volume"), vol, volL));
    const ok = await modal(tr("v_media.esporta_converti"), body, [{ label: tr("common.annulla"), value: false }, { label: tr("v_media.scegli_dove_salvare"), value: true, primary: true }]);
    if (!ok) return;
    const ext = fmtSel.value;
    const out = await pickSavePath(withExt(ctx.name.replace(/(\.[^.]+)$/, "_modificato$1"), ext), dirName(ctx.path));
    if (!out) return;
    await exportTo(out, { rotate: +rot.value, mute: mute.checked, volume: +vol.value / 100 });
  }

  async function exportTo(out, o = {}) {
    const ext = out.split(".").pop().toLowerCase();
    const j = await api("media_edit", { path: ctx.path }, { json: { out, start: inP, end: outP, rotate: o.rotate || 0, mute: !!o.mute, audio_only: !["mp4", "webm", "mkv", "mov", "avi", "gif", "m4v", "wmv", "flv", "mpg", "ts"].includes(ext), volume: o.volume ?? 1 } });
    toast(tr("v_media.esportazione_avviata"));
    try {
      await waitJob(j.job, p => ctx.status(tr("v_media.esportazione_0", Math.round(p * 100))));
      ctx.status(tr("v_media.esportazione_completata"));
      toast(tr("v_media.esportato") + out);
    } catch (e) { toast(tr("v_media.esportazione_non_riuscita") + e.message, true, 7000); }
  }

  media.addEventListener("loadedmetadata", () => ctx.status(tr("v_media.durata_0", fmtTime(media.duration)) + (isVideo ? ` · ${media.videoWidth}×${media.videoHeight}` : "") + (playable ? "" : tr("v_media.convertito_riproduzione"))));
  return {
    saveInPlace: false,
    saveAsName: () => ctx.name.replace(/(\.[^.]+)$/, "_modificato$1"),
    async save(target) { await exportTo(target); return { switchTo: false }; },
    dispose() { media.pause(); media.removeAttribute("src"); media.load(); },
  };
}
