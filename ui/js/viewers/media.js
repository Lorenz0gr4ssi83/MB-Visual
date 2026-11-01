// Audio e video: riproduzione nativa o conversione automatica con FFmpeg; taglio, rotazione, estrazione audio, fotogrammi, conversione.
import { t as tr } from "../i18n.js";
import { api, button, dirName, el, fileUrl, fmtTime, loading, modal, pickSavePath, toast, waitJob, WEB, withExt } from "../core.js";
import { keymap } from "../shortcuts.js";

const NATIVE_V = new Set(["mp4", "m4v", "webm", "ogv", "mov"]);
const NATIVE_A = new Set(["mp3", "wav", "wave", "flac", "ogg", "oga", "opus", "m4a", "aac"]);

// file grezzi senza intestazione: i parametri non si ricavano dal file. Valori proposti per estensione (SoX: .sw/.ub/.uw a
// 8000 Hz mono; Asterisk .sln; G.711 .alaw/.ulaw; Sound Designer II .sd2 = solo la parte dati, i parametri stavano nella
// "resource fork" del Mac che su Windows si perde), poi quelli scelti l'ultima volta (localStorage mbv-raw-<estensione>).
const RAW_AUDIO = { pcm: ["s16le", 44100, 2], s16le: ["s16le", 44100, 2], sw: ["s16le", 8000, 1], ub: ["u8", 8000, 1], uw: ["u16le", 8000, 1],
  sln: ["s16le", 8000, 1], sd2: ["s16be", 44100, 2], alaw: ["alaw", 8000, 1], al: ["alaw", 8000, 1], ulaw: ["mulaw", 8000, 1], ul: ["mulaw", 8000, 1] };
const RAW_VIDEO = new Set(["yuv"]);
const SAMPLE_FMTS = ["s16le", "s16be", "u8", "s8", "u16le", "s24le", "s32le", "f32le", "f64le", "alaw", "mulaw"];
const PIX_FMTS = { yuv420p: 1.5, yuv422p: 2, yuv444p: 3, nv12: 1.5, uyvy422: 2, yuyv422: 2, rgb24: 3, gray: 1 };
const SIZES = [[176, 144], [320, 240], [352, 288], [640, 480], [720, 480], [720, 576], [1280, 720], [1920, 1080], [3840, 2160]];

function rawProposal(ext, size) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("mbv-raw-" + ext) || "null"); } catch { /* */ }
  if (RAW_AUDIO[ext]) { const [f, ar, ac] = RAW_AUDIO[ext]; return { f, ar, ac, ...(saved || {}) }; }
  // video: la prima dimensione comune per cui il file contiene un numero intero di fotogrammi
  const fit = SIZES.find(([w, h]) => size % (w * h * 1.5) === 0) || [352, 288];
  return saved ? { ...saved } : { f: "rawvideo", pix_fmt: "yuv420p", s: `${fit[0]}x${fit[1]}`, r: 25 };
}

async function rawDialog(ctx) {
  const p = rawProposal(ctx.ext, ctx.info?.size || 0);
  const video = RAW_VIDEO.has(ctx.ext);
  const sel = (vals, cur) => el("select", {}, ...vals.map(v => el("option", { value: v, selected: String(v) === String(cur) }, v)));
  const row = (label, input) => el("label", { style: { display: "grid", gridTemplateColumns: "160px 1fr", gap: "10px", alignItems: "center" } }, el("span", {}, label), input);
  const inputs = video
    ? { s: el("input", { value: p.s, list: "mbv-raw-sizes" }), pix_fmt: sel(Object.keys(PIX_FMTS), p.pix_fmt), r: el("input", { type: "number", min: 1, max: 240, value: p.r }) }
    : { f: sel(SAMPLE_FMTS, p.f), ar: el("input", { type: "number", min: 1000, max: 384000, value: p.ar, list: "mbv-raw-rates" }), ac: el("input", { type: "number", min: 1, max: 8, value: p.ac }) };
  const body = el("div", { class: "mbv-raw", style: { display: "grid", gap: "10px", minWidth: "min(460px, 80vw)" } },
    el("p", { class: "note", style: { margin: 0 } }, tr(video ? "v_media.raw_video_spiegazione" : "v_media.raw_audio_spiegazione", "." + ctx.ext)),
    ...(video ? [row(tr("v_media.raw_dimensioni"), inputs.s), row(tr("v_media.raw_formato_pixel"), inputs.pix_fmt), row(tr("v_media.raw_fotogrammi_secondo"), inputs.r)]
      : [row(tr("v_media.raw_formato_campione"), inputs.f), row(tr("v_media.raw_frequenza"), inputs.ar), row(tr("v_media.raw_canali"), inputs.ac)]),
    el("datalist", { id: "mbv-raw-sizes" }, ...SIZES.map(([w, h]) => el("option", { value: `${w}x${h}` }))),
    el("datalist", { id: "mbv-raw-rates" }, ...[8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000].map(v => el("option", { value: v }))));
  const ok = await modal(tr("v_media.raw_titolo"), body, [{ label: tr("common.annulla"), value: false }, { label: tr("v_media.raw_apri"), value: true, primary: true }]);
  if (!ok) return null;
  const out = video ? { f: "rawvideo", s: inputs.s.value.trim(), pix_fmt: inputs.pix_fmt.value, r: inputs.r.value } : { f: inputs.f.value, ar: inputs.ar.value, ac: inputs.ac.value };
  try { localStorage.setItem("mbv-raw-" + ctx.ext, JSON.stringify(out)); } catch { /* */ }
  return out;
}

export async function mount(ctx) {
  const isRaw = !!(RAW_AUDIO[ctx.ext] || RAW_VIDEO.has(ctx.ext)) && !WEB;
  if (isRaw) {
    const p = await rawDialog(ctx);
    if (!p) throw new Error(tr("v_media.raw_annullato"));
    await api("media_raw", { path: ctx.path }, { json: p });
  }
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
    button(tr("v_media.esporta_converti"), "download", () => exportDialog(), { comp: "video" }),
    // file grezzo: si riapre con la finestra dei parametri (valori proposti = gli ultimi scelti)
    isRaw ? button(tr("v_media.raw_parametri"), null, () => window.MB?.reloadTab?.(ctx.tab), { title: tr("v_media.raw_titolo") }) : null,
    button(tr("v_media.apri_montaggio"), "edit", () => openInEditor(), { title: tr("v_media.crea_progetto_montaggio_video_stile"), comp: "video" }),
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
    const path = (await api("temp_path", { name: ctx.name.replace(/\.[^.]+$/, "") + tr("v_media.suffisso_montaggio") + ".mbvid" })).path;
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
