// Pulsante "Misure" nelle barre dei visualizzatori (modulo leggero: il pannello si carica al primo clic)
import { button } from "../core.js";
import { t as tr } from "../i18n.js";

export const MIS_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M1.5 11.5l10-10 3 3-10 10z"/><path d="M4 9l1.5 1.5M6 7l1 1M8 5l1.5 1.5M10 3l1 1"/></svg>';
export const measureBtn = onclick => button(tr("mis.misure"), MIS_ICON, onclick, { title: tr("mis.misure_titolo"), comp: "measure" });
export const mbmisOf = p => (p ? p.replace(/\.[^.\/]+$/, "") + ".mbmis" : null);
