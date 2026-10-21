// Database SQLite: tabelle, struttura, query SQL, modifica celle e righe.
import { api, button, confirmBox, el, loading, readBytes, toast } from "../core.js";
import { t as _t } from "../i18n.js";

export async function mount(ctx) {
  loading(ctx.el, _t("v_sqlite.apertura_database"));
  let schema = await api("sqlite_schema", { path: ctx.path });
  ctx.el.innerHTML = "";
  const objs = el("div", { class: "tree" });
  const sql = el("textarea", { id: "sql-" + ctx.tab.name, spellcheck: "false", style: { width: "100%", height: "70px", fontFamily: "var(--mono)", fontSize: "13px", border: "0", borderBottom: "1px solid var(--line)", padding: "8px", resize: "vertical", background: "var(--panel-2)" } });
  const result = el("div", { style: { overflow: "auto", minHeight: 0 } });
  const right = el("div", { style: { display: "grid", gridTemplateRows: "auto auto 1fr", height: "100%", minHeight: 0 } }, sql,
    el("div", { class: "tb" }, button(_t("v_sqlite.esegui_ctrl_invio"), "play", () => run(sql.value, true)), el("span", { class: "note" }, _t("v_sqlite.istruzioni_che_modificano_i_dati"))), result);
  ctx.el.append(el("div", { class: "side" }, objs, right));
  ctx.fillBody(true);
  sql.addEventListener("keydown", e => { if (e.ctrlKey && e.key === "Enter") run(sql.value, true); });
  let table = null;

  function renderObjs() {
    objs.innerHTML = "";
    for (const o of schema.oggetti) objs.append(el("div", { class: "node" + (o.nome === table ? " sel" : ""), onclick: () => openTable(o.nome) },
      el("span", {}, (o.tipo === "view" ? "👁 " : "▦ ") + o.nome), el("span", { class: "note", style: { marginLeft: "auto" } }, o.righe ?? "")));
  }

  async function openTable(name) {
    table = name;
    renderObjs();
    const isView = schema.oggetti.find(o => o.nome === name)?.tipo === "view";
    sql.value = isView ? `SELECT * FROM "${name}" LIMIT 1000` : `SELECT rowid AS _rowid_, * FROM "${name}" LIMIT 1000`;
    await run(sql.value, false, !isView);
  }

  async function run(q, explicit, editableTable = false) {
    const write = !/^\s*(select|with|pragma|explain)\b/i.test(q);
    if (write && explicit && !(await confirmBox(_t("v_sqlite.modifica_database"), _t("v_sqlite.l_istruzione_modifica_database_viene"), _t("v_sqlite.esegui")))) return;
    let r;
    try { r = await api("sqlite_query", { path: ctx.path }, { json: { sql: q, write } }); } catch (e) { result.innerHTML = ""; result.append(el("p", { class: "err", style: { padding: "10px" } }, e.message)); return; }
    if (write) { toast(_t("v_sqlite.0_righe_modificate", r.modificate)); schema = await api("sqlite_schema", { path: ctx.path }); renderObjs(); if (table) return openTable(table); return; }
    result.innerHTML = "";
    const t = el("table", { class: "grid" });
    t.append(el("thead", {}, el("tr", {}, ...r.colonne.filter(c => c !== "_rowid_").map(c => el("th", {}, c)), editableTable ? el("th", {}, "") : null)));
    const tb = el("tbody");
    const ri = r.colonne.indexOf("_rowid_");
    for (const row of r.righe) {
      const tr = el("tr");
      row.forEach((v, k) => {
        if (k === ri) return;
        const td = el("td", {}, v && typeof v === "object" ? _t("v_sqlite.blob_0_byte", v.blob) : v === null ? "NULL" : String(v));
        if (v === null) td.style.color = "var(--muted)";
        if (editableTable && !(v && typeof v === "object")) td.addEventListener("dblclick", () => editCell(td, r.colonne[k], row[ri], v));
        tr.append(td);
      });
      if (editableTable) tr.append(el("td", {}, el("button", { class: "btn danger", title: _t("v_sqlite.elimina_riga"), onclick: async () => {
        if (!(await confirmBox(_t("v_sqlite.elimina_riga"), _t("v_sqlite.eliminare_definitivamente_questa_riga_database"), _t("common.elimina"), true))) return;
        await api("sqlite_query", { path: ctx.path }, { json: { sql: `DELETE FROM "${table}" WHERE rowid = ?`, params: [row[ri]], write: true } });
        openTable(table);
      } }, "×")));
      tb.append(tr);
    }
    t.append(tb);
    result.append(t);
    if (editableTable) result.append(el("div", { style: { padding: "8px" } }, el("button", { class: "btn", onclick: async () => {
      await api("sqlite_query", { path: ctx.path }, { json: { sql: `INSERT INTO "${table}" DEFAULT VALUES`, write: true } });
      openTable(table);
    } }, _t("v_sqlite.nuova_riga")), el("span", { class: "note" }, _t("v_sqlite.doppio_clic_cella_modificarla"))));
    ctx.status(`${r.righe.length}${r.troncato ? "+" : ""} righe`);
  }

  function editCell(td, col, rowid, old) {
    const input = el("input", { type: "text", value: old === null ? "" : String(old), style: { width: "100%", font: "inherit" } });
    td.textContent = "";
    td.append(input);
    input.focus();
    const commit = async () => {
      const v = input.value;
      const val = v === "" && old === null ? null : (typeof old === "number" && v.trim() !== "" && !isNaN(+v) ? +v : v);
      await api("sqlite_query", { path: ctx.path }, { json: { sql: `UPDATE "${table}" SET "${col}" = ? WHERE rowid = ?`, params: [val, rowid], write: true } });
      openTable(table);
    };
    input.addEventListener("keydown", e => { if (e.key === "Enter") commit(); if (e.key === "Escape") openTable(table); });
    input.addEventListener("blur", commit, { once: true });
  }

  renderObjs();
  if (schema.oggetti.length) openTable(schema.oggetti[0].nome);
  return {
    // le modifiche SQL sono gia' scritte nel file: "Salva con nome" ne crea una copia
    saveInPlace: false,
    async save(target) { await api("save", { path: target }, { body: await readBytes(ctx.path) }); return { switchTo: false }; },
  };
}
