// Rendering di un file MIDI (.mid .midi .kar .rmi) in audio, fuori dal thread della pagina: sintetizzatore SoundFont
// spessasynth_core (Apache-2.0) con i suoni General MIDI FluidR3Mono (MIT, ui/vendor/soundfont). Usato da ui/js/viewers/midi.js.
// Messaggio in ingresso: { midi: ArrayBuffer, name, soundfont: URL, rate }. In uscita: { progress } durante il calcolo,
// poi { done, wav: ArrayBuffer, info } oppure { error }.
import { audioToWav, BasicMIDI, SoundBankLoader, SpessaSynthProcessor, SpessaSynthSequencer } from "../vendor/spessasynth_core/dist/index.js";

const dec = new TextDecoder("latin1");

// testo karaoke: eventi lyric (0x05) o, nei .kar, eventi di testo (0x01) senza le righe "@" di intestazione;
// "/" = a capo, "\" = paragrafo nuovo (convenzione dei file .kar)
function lyricsOf(midi) {
  const out = [];
  const pick = type => {
    for (const tr of midi.tracks) for (const e of tr.events) {
      if (e.statusByte !== type) continue;
      const s = dec.decode(e.data);
      if (type === 0x01 && (s.startsWith("@") || !s.trim() && !s.includes(" "))) continue;
      out.push({ t: midi.midiTicksToSeconds(e.ticks), s });
    }
  };
  pick(0x05);
  if (!out.length) pick(0x01);
  return out.sort((a, b) => a.t - b.t);
}

function metaOf(midi) {
  const titles = [], texts = [];
  for (const tr of midi.tracks) for (const e of tr.events) {
    if (e.statusByte === 0x03) titles.push(dec.decode(e.data).trim());
    else if (e.statusByte === 0x01 && dec.decode(e.data).startsWith("@T")) titles.unshift(dec.decode(e.data).slice(2).trim());
    else if (e.statusByte === 0x02) texts.push(dec.decode(e.data).trim());
  }
  return { titoli: [...new Set(titles.filter(Boolean))], copyright: texts.filter(Boolean) };
}

self.onmessage = async ev => {
  try {
    const { midi: buf, name, soundfont, rate = 44100 } = ev.data;
    const midi = BasicMIDI.fromArrayBuffer(buf, name);
    const sf = await (await fetch(soundfont)).arrayBuffer();
    const bank = SoundBankLoader.fromArrayBuffer(sf);
    const synth = new SpessaSynthProcessor(rate, { eventsEnabled: false });
    synth.soundBankManager.addSoundBank(bank, "main");
    await synth.processorInitialized;
    synth.setSystemParameter?.("autoAllocateVoices", true);
    const seq = new SpessaSynthSequencer(synth);
    seq.loadNewSongList([midi]);
    seq.play();
    const total = Math.ceil(rate * (midi.duration + 2)); // 2 s di coda per il riverbero
    const L = new Float32Array(total), R = new Float32Array(total);
    const BUF = 128;
    let done = 0, n = 0;
    while (done < total) {
      seq.processTick();
      const k = Math.min(BUF, total - done);
      synth.process(L, R, done, k);
      done += k;
      if (++n % 2000 === 0) self.postMessage({ progress: done / total });
    }
    // il sintetizzatore lascia molto margine (picchi intorno a 0,1): volume portato a un picco di 0,89 come un audio normale
    let peak = 0;
    for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    if (peak > 0 && peak < 0.89) { const g = 0.89 / peak; for (let i = 0; i < total; i++) { L[i] *= g; R[i] *= g; } }
    const wav = audioToWav([L, R], rate);
    const tracks = midi.tracks.map(t => ({ nome: t.name, canali: [...t.channels] }));
    self.postMessage({ done: true, wav, info: { durata: midi.duration, tracce: tracks, formato: midi.format, lyrics: lyricsOf(midi), ...metaOf(midi) } }, [wav]);
  } catch (e) {
    self.postMessage({ error: String(e?.message || e) });
  }
};
