// Testo e codice sorgente con Monaco: colorazione, ricerca/sostituzione, mantenimento della codifica.
import { api, button, el, loading } from "../core.js";
import { languageFor, loadMonaco } from "../monaco.js";

export async function mount(ctx, opts = {}) {
  const ld = loading(ctx.el, "Caricamento dell'editor");
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
  editor.onDidChangeCursorPosition(e => ctx.status(`Riga ${e.position.lineNumber}, colonna ${e.position.column} · ${doc.encoding.toUpperCase()}${doc.bom ? " BOM" : ""} · ${doc.eol === "\r\n" ? "CRLF" : "LF"}`));
  ctx.status(`${doc.encoding.toUpperCase()}${doc.bom ? " BOM" : ""} · ${doc.eol === "\r\n" ? "CRLF" : "LF"}`);

  if (!opts.noToolbar) {
    const langSel = el("select", { title: "Linguaggio per la colorazione", id: "lang-" + ctx.tab.name });
    for (const l of monaco.languages.getLanguages().map(l => l.id).sort()) langSel.append(el("option", { value: l, selected: l === lang }, l));
    langSel.addEventListener("change", () => monaco.editor.setModelLanguage(editor.getModel(), langSel.value));
    const wrapBtn = button("A capo automatico", "text", () => {
      const on = editor.getOption(monaco.editor.EditorOption.wordWrap) !== "on";
      editor.updateOptions({ wordWrap: on ? "on" : "off" });
      wrapBtn.classList.toggle("on", on);
    });
    if (opts.wrap) wrapBtn.classList.add("on");
    ctx.tb.append(
      button("Cerca", "search", () => editor.getAction("actions.find").run()),
      button("Sostituisci", "edit", () => editor.getAction("editor.action.startFindReplaceAction").run()),
      button("Vai alla riga", null, () => editor.getAction("editor.action.gotoLine").run()),
      button("Formatta", "code", () => editor.getAction("editor.action.formatDocument")?.run(), { title: "Riformatta il documento (JSON, HTML, CSS, JS...)" }),
      wrapBtn, el("span", { class: "sep" }), el("label", {}, "Linguaggio", langSel), el("span", { class: "grow" }),
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
