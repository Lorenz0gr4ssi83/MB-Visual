// Statistiche d'uso anonime di MB Visual (solo con il consenso esplicito dell'utente nell'app per PC/Mac).
// L'app manda i giorni conclusi in un pacchetto: identificativo casuale dell'installazione (non legato a licenza, PC o
// persona), versione, sistema, lingua, avvii, secondi d'uso, componenti attivi, estensioni aperte, funzioni usate ed
// errori dei visualizzatori (solo tipo ed estensione). Non si salvano IP, nomi di file, percorsi o contenuti.
//   POST /v1/stats         {inst, days: [{day, app, version, os, arch, lang, launches, seconds, comps, exts, funcs, errors}]}
//   POST /v1/stats/forget  {inst}   revoca del consenso: cancella tutte le righe di quell'identificativo
//   GET  /admin/usage?giorni=30     riepilogo per MB Visual Admin (PC e telefono)
//   POST /admin/usage/forget {inst} cancellazione su richiesta (l'utente legge l'identificativo in File > Impostazioni)
// Conservazione: nessuna scadenza automatica (scelta del proprietario); i dati restano finche' servono e si cancellano alla
// revoca del consenso o su richiesta. L'informativa nell'app dice esattamente questo: non aggiungere scadenze non applicate.

const MAX_DAYS = 45;          // giorni accettati in un pacchetto (l'app conserva al massimo 40 giorni non inviati)
const RE_INST = /^[0-9a-f]{32}$/;
const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const RE_EXT = /^[a-z0-9_]{1,12}$/;
const RE_FUNC = /^[a-z0-9_.-]{1,48}$/;
const RE_ERR = /^[a-z0-9_-]{1,24}\|[A-Za-z]{1,32}\|[a-z0-9_]{0,12}$/;
const word = (v, n = 24) => String(v ?? "").replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, n);
const int = (v, max) => Math.max(0, Math.min(max, Math.floor(+v || 0)));
// mappa chiave -> conteggio, solo chiavi del formato previsto (nessun testo libero)
function counts(obj, re, maxKeys = 300) {
  const out = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj).slice(0, maxKeys)) if (re.test(k)) { const n = int(v, 1e6); if (n) out[k] = n; }
  return out;
}
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

export async function postStats(env, b, json, fail) {
  const inst = String(b?.inst || "");
  if (!RE_INST.test(inst)) return fail(400, "Identificativo non valido");
  const days = Array.isArray(b.days) ? b.days.slice(0, MAX_DAYS) : [];
  const min = isoDay(Date.now() - (MAX_DAYS + 1) * 86400000), max = isoDay(Date.now() + 86400000); // fusi orari: domani ancora valido
  const stmts = [];
  for (const d of days) {
    const day = String(d?.day || "");
    if (!RE_DAY.test(day) || day < min || day > max) continue;
    const comps = (Array.isArray(d.comps) ? d.comps : []).map(String).filter(c => RE_FUNC.test(c)).slice(0, 40);
    // stesso giorno rimandato (invio non confermato): si sostituisce, cosi' i conteggi non raddoppiano
    stmts.push(env.DB.prepare(`INSERT INTO usage_days (inst, day, app, version, os, arch, lang, launches, seconds, comps, exts, funcs, errors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(inst, day) DO UPDATE SET app=excluded.app, version=excluded.version, os=excluded.os, arch=excluded.arch, lang=excluded.lang,
        launches=excluded.launches, seconds=excluded.seconds, comps=excluded.comps, exts=excluded.exts, funcs=excluded.funcs, errors=excluded.errors,
        received=datetime('now')`)
      .bind(inst, day, d.app === "mac" ? "mac" : "pc", word(d.version, 20), word(d.os, 40), word(d.arch, 12), word(d.lang, 8).toLowerCase(),
        int(d.launches, 1000), int(d.seconds, 86400), JSON.stringify(comps), JSON.stringify(counts(d.exts, RE_EXT)),
        JSON.stringify(counts(d.funcs, RE_FUNC)), JSON.stringify(counts(d.errors, RE_ERR, 100))));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, ricevuti: stmts.length });
}

export async function forgetStats(env, b, json, fail) {
  const inst = String(b?.inst || "");
  if (!RE_INST.test(inst)) return fail(400, "Identificativo non valido");
  const r = await env.DB.prepare("DELETE FROM usage_days WHERE inst = ?").bind(inst).run();
  return json({ ok: true, cancellati: r?.meta?.changes ?? 0 });
}

// riepilogo per l'app di gestione: periodo di N giorni (7-400) + andamento mensile degli ultimi 13 mesi
export async function usageSummary(env, url, json) {
  const giorni = Math.max(7, Math.min(400, +(url.searchParams.get("giorni") || 30)));
  const from = isoDay(Date.now() - (giorni - 1) * 86400000);
  const all = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;
  const one = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first()) || {};
  // ultima riga di ogni installazione nel periodo: versione, sistema e lingua attuali (chi aggiorna non conta due volte)
  const last = `SELECT u.* FROM usage_days u JOIN (SELECT inst, MAX(day) d FROM usage_days WHERE day >= ? GROUP BY inst) m ON m.inst = u.inst AND m.d = u.day`;
  const by = col => all(`SELECT ${col} AS k, COUNT(*) AS n FROM (${last}) GROUP BY k ORDER BY n DESC LIMIT 30`, from);
  const top = (col, lim = 30) => all(`SELECT j.key AS k, SUM(j.value) AS n, COUNT(DISTINCT u.inst) AS inst FROM usage_days u, json_each(u.${col}) j
    WHERE u.day >= ? GROUP BY j.key ORDER BY n DESC LIMIT ${lim}`, from);
  const tot = await one("SELECT COUNT(DISTINCT inst) AS attivi, SUM(launches) AS avvii, SUM(seconds) AS secondi, COUNT(*) AS giorni_uso FROM usage_days WHERE day >= ?", from);
  return json({
    ok: true, giorni, dal: from,
    attivi: tot.attivi || 0, avvii: tot.avvii || 0, ore: Math.round((tot.secondi || 0) / 360) / 10,
    minuti_sessione: tot.avvii ? Math.round((tot.secondi || 0) / tot.avvii / 6) / 10 : 0,
    installazioni: (await one("SELECT COUNT(DISTINCT inst) AS n FROM usage_days")).n || 0,
    per_giorno: await all("SELECT day AS k, COUNT(*) AS n FROM usage_days WHERE day >= ? GROUP BY day ORDER BY day", from),
    per_mese: await all("SELECT substr(day, 1, 7) AS k, COUNT(DISTINCT inst) AS n FROM usage_days WHERE day >= date('now', 'start of month', '-12 months') GROUP BY k ORDER BY k"),
    versioni: await by("version"), sistemi: await by("CASE WHEN arch = '' THEN os ELSE os || ' ' || arch END"), app: await by("app"), lingue: await by("lang"),
    componenti: await all(`SELECT j.value AS k, COUNT(*) AS n FROM (${last}) u, json_each(u.comps) j GROUP BY k ORDER BY n DESC`, from),
    formati: await top("exts"), funzioni: await top("funcs", 50), errori: await top("errors"),
  });
}
