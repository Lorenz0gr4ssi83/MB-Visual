// Testo e codice sorgente con Monaco: colorazione, ricerca/sostituzione, mantenimento della codifica.
import { t } from "../i18n.js";
import { api, button, el, loading } from "../core.js";
import { languageFor, loadMonaco } from "../monaco.js";
import { describeKeys } from "../shortcuts.js";

export async function mount(ctx, opts = {}) {
  // editor Monaco: gli stessi tasti di Visual Studio Code
  describeKeys(ctx, "Visual Studio Code", [
    ["Ctrl+F / Ctrl+H", t("v_text.trova_sostituisci"), t("v_text.modifica")], ["Ctrl+D", t("v_text.seleziona_prossima_occorrenza"), t("v_text.modifica")], ["Alt+clic", t("v_text.piu_cursori"), t("v_text.modifica")],
    ["Ctrl+/", t("v_text.commenta_togli_commento"), t("v_text.modifica")], ["Alt+Su / Alt+Giu'", t("v_text.sposta_riga"), t("v_text.modifica")], ["Maiusc+Alt+Giu'", t("v_text.duplica_riga"), t("v_text.modifica")],
    ["Ctrl+Maiusc+K", t("v_text.elimina_riga"), t("v_text.modifica")], ["Ctrl+G", t("v_text.vai_riga"), t("v_text.navigazione")], ["Ctrl+Z / Ctrl+Y", t("v_text.annulla_ripeti"), t("v_text.modifica")],
    ["Maiusc+Alt+F", t("v_text.formatta_documento"), t("v_text.modifica")], ["F1", t("v_text.questo_elenco_mb_visual"), t("v_text.aiuto")],
  ]);
  const ld = loading(ctx.el, t("v_text.caricamento_dell_editor"));
  const [monaco, doc] = await Promise.all([loadMonaco(), api("text", { path: ctx.path })]);
  ctx.el.innerHTML = "";
  ctx.fillBody(true);
  const host = el("div", { style: { height: "100%" } });
  ctx.el.append(host);
  void ld;
  let lang = opts.language || languageFor(monaco, ctx.ext);
  const editor = monaco.editor.create(host, {
    value: doc.text, language: lang, automaticLayout: true, minimap: { enabled: doc.text.length < 3_000_000 },
    wordWrap: opts.wrap ? "on" : "off", fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 13.5,
    renderWhitespace: "selection", unicodeHighlight: { ambiguousCharacters: false }, scrollBeyondLastLine: false,
  });
  let saved = editor.getModel().getAlternativeVersionId();
  editor.onDidChangeModelContent(() => {
    ctx.setDirty(editor.getModel().getAlternativeVersionId() !== saved);
    opts.onChange?.(editor.getValue());
  });
  editor.onDidChangeCursorPosition(e => ctx.status(t("v_text.riga_0_colonna_1_2", e.position.lineNumber, e.position.column, doc.encoding.toUpperCase(), doc.bom ? " BOM" : "", doc.eol === "\r\n" ? "CRLF" : "LF")));
  ctx.status(`${doc.encoding.toUpperCase()}${doc.bom ? " BOM" : ""} · ${doc.eol === "\r\n" ? "CRLF" : "LF"}`);

  if (!opts.noToolbar) {
    const langSel = el("select", { title: t("v_text.linguaggio_colorazione"), id: "lang-" + ctx.tab.name });
    for (const l of monaco.languages.getLanguages().map(l => l.id).sort()) langSel.append(el("option", { value: l, selected: l === lang }, l));
    langSel.addEventListener("change", () => monaco.editor.setModelLanguage(editor.getModel(), langSel.value));
    const wrapBtn = button(t("v_text.capo_automatico"), "text", () => {
      const on = editor.getOption(monaco.editor.EditorOption.wordWrap) !== "on";
      editor.updateOptions({ wordWrap: on ? "on" : "off" });
      wrapBtn.classList.toggle("on", on);
    });
    if (opts.wrap) wrapBtn.classList.add("on");
    ctx.tb.append(
      button(t("v_text.cerca"), "search", () => editor.getAction("actions.find").run()),
      button(t("v_text.sostituisci"), "edit", () => editor.getAction("editor.action.startFindReplaceAction").run()),
      button(t("v_text.vai_riga"), null, () => editor.getAction("editor.action.gotoLine").run()),
      button(t("v_text.formatta"), "code", () => editor.getAction("editor.action.formatDocument")?.run(), { title: t("v_text.riformatta_documento_json_html_css") }),
      wrapBtn, el("span", { class: "sep" }), el("label", {}, t("v_text.linguaggio"), langSel), el("span", { class: "grow" }),
      ...(opts.extraTools || []));
  }

  return {
    editor,
    async save(target) {
      await api("text_save", { path: target }, { json: { text: editor.getValue(), encoding: doc.encoding, bom: doc.bom, eol: doc.eol } });
      saved = editor.getModel().getAlternativeVersionId();
    },
    onShow() { editor.layout(); },
    dispose() { editor.dispose(); },
  };
}
