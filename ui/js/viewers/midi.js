// MIDI (.mid .midi .kar .rmi): il brano si suona con un sintetizzatore SoundFont nel browser (ui/js/midiworker.js:
// spessasynth_core Apache-2.0 + suoni General MIDI FluidR3Mono MIT), poi si ascolta come un audio qualsiasi.
// Karaoke: testo sincronizzato (eventi lyric, o eventi di testo dei .kar). Salva con nome: WAV direttamente, MP3/OGG/FLAC/M4A
// passando il WAV a FFmpeg (api media_edit, solo app per PC).
import { api, el, fmtTime, loading, readBytes, toast, waitJob, WEB } from "../core.js";
import { t as tr } from "../i18n.js";

export async function mount(ctx) {
  const ld = loading(ctx.el, tr("v_midi.sintesi"));
  const bytes = await readBytes(ctx.path);
  const worker = new Worker(new URL("../midiworker.js", import.meta.url), { type: "module" });
  const res = await new Promise((resolve, reject) => {
    worker.onmessage = e => {
      const m = e.data;
      if (m.progress !== undefined) ld.set(m.progress, tr("v_midi.sintesi_0", Math.round(m.progress * 100)));
      else if (m.error) reject(new Error(tr("v_midi.non_leggibile", m.error)));
      else if (m.done) resolve(m);
    };
    worker.onerror = e => reject(new Error(e.message || tr("v_midi.non_leggibile", "worker")));
    const buf = bytes.slice().buffer;
    worker.postMessage({ midi: buf, name: ctx.name, soundfont: "/vendor/soundfont/FluidR3Mono_GM.sf3" }, [buf]);
  }).finally(() => worker.terminate());
  const wav = new Uint8Array(res.wav);
  const info = res.info;
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  ctx.el.innerHTML = "";
  ctx.fillBody(true);

  const audio = el("audio", { controls: true, src: url, style: { width: "100%" } });
  const head = el("div", { style: { display: "grid", gap: "6px" } },
    el("h2", { style: { margin: 0, fontSize: "19px" } }, info.titoli[0] || ctx.name),
    el("div", { class: "note" }, [tr("v_midi.durata_0", fmtTime(info.durata)), tr("v_midi.tracce_0", info.tracce.length), tr("v_midi.formato_0", info.formato)].join(" · ")),
    info.copyright.length ? el("div", { class: "note" }, info.copyright.join(" · ")) : null);
  const page = el("div", { style: { padding: "18px 22px", display: "grid", gap: "14px", alignContent: "start", maxWidth: "980px", height: "100%", boxSizing: "border-box", gridTemplateRows: "auto auto 1fr" } }, head, audio);
  ctx.el.append(page);

  // ---- karaoke: righe divise da "/" (a capo) e "\" (paragrafo); la parola cantata si evidenzia
  let raf = 0;
  if (info.lyrics.length) {
    const lines = [];
    let cur = [];
    for (const w of info.lyrics) {
      const brk = /^[\\/]/.test(w.s);
      if (brk && cur.length) { lines.push(cur); cur = []; }
      const s = w.s.replace(/^[\\/]/, "").replace(/[\r\n]+/g, " ");
      if (s) cur.push({ t: w.t, s });
      if (/[\r\n]$/.test(w.s) && cur.length) { lines.push(cur); cur = []; }
    }
    if (cur.length) lines.push(cur);
    const box = el("div", { class: "panel", style: { overflow: "auto", fontSize: "20px", lineHeight: 1.6, textAlign: "center" } });
    const spans = [];
    for (const ln of lines) {
      const p = el("div", { style: { padding: "2px 0", color: "var(--muted)" } });
      for (const w of ln) { const sp = el("span", {}, w.s); sp.dataset.t = w.t; spans.push({ el: sp, t: w.t, line: p }); p.append(sp); }
      box.append(p);
    }
    page.append(el("div", { style: { display: "grid", gap: "6px", minHeight: 0, gridTemplateRows: "auto 1fr" } }, el("h3", { style: { margin: 0, fontSize: "14.5px" } }, tr("v_midi.testo_karaoke")), box));
    let lastLine = null;
    const tick = () => {
      const now = audio.currentTime;
      let i = spans.length - 1;
      while (i >= 0 && spans[i].t > now) i--;
      spans.forEach((s, k) => { s.el.style.color = k <= i ? "var(--accent-ink)" : ""; });
      const line = i >= 0 ? spans[i].line : null;
      if (line !== lastLine) {
        if (lastLine) lastLine.style.color = "var(--muted)";
        if (line) { line.style.color = "var(--fg)"; line.scrollIntoView({ block: "center", behavior: "smooth" }); }
        lastLine = line;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  ctx.status(`MIDI · ${fmtTime(info.durata)}` + (info.lyrics.length ? " · " + tr("v_midi.karaoke") : ""));

  const saveFormats = WEB ? ["wav"] : ["wav", "mp3", "ogg", "flac", "m4a"];
  return {
    saveInPlace: false,
    saveFormats,
    saveLabels: { wav: tr("v_midi.audio_wav") },
    saveAsName: () => ctx.name.replace(/\.[^.]+$/, ".wav"),
    async save(target) {
      const ext = target.split(".").pop().toLowerCase();
      if (ext === "wav") { await api("save", { path: target }, { body: wav }); return { switchTo: false }; }
      // altri formati: il WAV in un file temporaneo, poi FFmpeg (stesso percorso dell'esportazione del lettore audio)
      const tmp = (await api("temp_path", { name: ctx.name.replace(/\.[^.]+$/, "") + ".wav" })).path;
      await api("save", { path: tmp }, { body: wav });
      const j = await api("media_edit", { path: tmp }, { json: { out: target, audio_only: true } });
      await waitJob(j.job, p => ctx.status(tr("v_midi.conversione_0", Math.round(p * 100))));
      toast(tr("v_midi.salvato_0", target));
      return { switchTo: false };
    },
    dispose() { cancelAnimationFrame(raf); audio.pause(); URL.revokeObjectURL(url); },
  };
}
