// Ambiente di prova del Worker senza Cloudflare (usato da harness.mjs e admin_mobile.mjs): D1 imitato con node:sqlite,
// file statici (ASSETS) letti da una cartella, chiavi vere da %USERPROFILE%\.mbvisual\licenze\chiavi.json.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ---- D1 imitato
export function d1(db) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
    _exec: () => db.prepare(sql).run(...args),
  });
  return {
    prepare: sql => stmt(sql),
    batch: async list => { db.exec("BEGIN"); try { list.forEach(s => s._exec()); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return []; },
  };
}
// file statici dell'app per cellulari (binding ASSETS) letti da una cartella
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json", png: "image/png", webmanifest: "application/manifest+json", wasm: "application/wasm", svg: "image/svg+xml", woff2: "font/woff2", ftl: "text/plain; charset=utf-8" };
export function assets(dir) {
  return { fetch: async req => {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = join(dir, p);
    if (!f.startsWith(dir) || !existsSync(f) || !statSync(f).isFile()) return new Response("Non trovato", { status: 404 });
    return new Response(readFileSync(f), { headers: { "content-type": TYPES[f.split(".").pop()] || "application/octet-stream" } });
  } };
}
export function makeEnv(file = ":memory:", publicDir = null) {
  const db = new DatabaseSync(file);
  db.exec(readFileSync(join(here, "..", "schema.sql"), "utf8"));
  const keys = JSON.parse(readFileSync(join(homedir(), ".mbvisual", "licenze", "chiavi.json"), "utf8"));
  return { DB: d1(db), SIGNING_KEY: keys.private_pkcs8, PUBLIC_KEY: keys.public_raw, ADMIN_TOKEN: process.env.MBV_ADMIN_PROVA || keys.admin_token, _db: db, ...(publicDir ? { ASSETS: assets(publicDir) } : {}) }; // MBV_ADMIN_PROVA: codice di prova al posto di quello vero
}
