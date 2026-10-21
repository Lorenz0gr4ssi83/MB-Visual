// Progetto di montaggio video MB Visual (.mbvid): si apre nell'editor in stile Premiere Pro (ui/js/videdit.js).
// I file multimediali sono riferiti per percorso; se la cartella e' stata spostata si cercano col percorso relativo.
import { api, dirName, loading, readBytes } from "../core.js";
import { createVideoEditor } from "../videdit.js";
import { newProject } from "../vidmodel.js";
import { t } from "../i18n.js";

export async function mount(ctx) {
  loading(ctx.el, t("v_video.apertura_progetto_video"));
  let P;
  const text = new TextDecoder().decode(await readBytes(ctx.path)).trim();
  if (!text) P = newProject();
  else {
    try { P = JSON.parse(text); } catch { throw new Error(t("v_video.file_non_progetto_video_mb")); }
    if (!P.mbvid) throw new Error(t("v_video.file_non_progetto_video_mb_2"));
    P = { ...newProject(P.settings), ...P };
    P.settings = { ...newProject().settings, ...P.settings };
  }
  // supporti: percorso assoluto, altrimenti relativo alla cartella del progetto; se mancano restano "non in linea"
  const dir = dirName(ctx.path);
  for (const m of P.media) {
    const ok = async p => { try { const s = await api("stat", { path: p }, { allowFail: true }); return s && s.ok !== false; } catch { return false; } };
    if (await ok(m.path)) continue;
    const alt = m.rel && !ctx.untitled ? dir + "\\" + m.rel : null;
    if (alt && (await ok(alt))) m.path = alt;
    else m.offline = true;
  }
  const off = P.media.filter(m => m.offline).length;
  const api_ = createVideoEditor(ctx, P, { openSourceFirst: !!ctx.openSource });
  if (off) setTimeout(() => ctx.status(t("v_video.0_supporti_non_linea_clic", off)), 500);
  return api_;
}
