// Archivi (7-Zip): contenuto ad albero, apertura diretta dei file interni, estrazione, aggiunta/eliminazione/rinomina.
import { api, askText, button, confirmBox, el, fmtSize, loading, modal, pickFiles, pickFolder, toast } from "../core.js";
import { t as _t } from "../i18n.js";

export async function mount(ctx) {
  let password = null;
  let data;
  const list = el("div", { style: { overflow: "auto", height: "100%" } });
  ctx.fillBody(true);

  async function load() {
    loading(ctx.el, _t("v_archive.lettura_dell_archivio"));
    data = await api("archive_list", password ? { path: ctx.path, password } : { path: ctx.path }, { allowFail: true });
    if (!data.ok) throw new Error(data.errore);
    if (data.items.some(i => i.encrypted) && !password) {
      const p = await askText(_t("v_archive.archivio_protetto"), _t("v_archive.password_dell_archivio"), "");
      if (p) { password = p; }
    }
    ctx.el.innerHTML = "";
    ctx.el.append(list);
    render();
  }

  let filter = "", selected = new Set(), cwd = "";
  function render() {
    list.innerHTML = "";
    const items = data.items.filter(i => i.path);
    // cartelle implicite
    const dirs = new Set();
    for (const i of items) { const parts = i.path.split("/"); for (let k = 1; k < parts.length; k++) dirs.add(parts.slice(0, k).join("/")); if (i.dir) dirs.add(i.path); }
    const inCwd = p => (cwd ? p.startsWith(cwd + "/") : true) && !p.slice(cwd ? cwd.length + 1 : 0).includes("/");
    const rows = [];
    if (!filter) {
      for (const d of [...dirs].filter(inCwd).sort()) rows.push({ path: d, dir: true, size: 0, modified: "" });
      for (const i of items.filter(i => !i.dir && inCwd(i.path))) rows.push(i);
    } else {
      for (const i of items.filter(i => !i.dir && i.path.toLowerCase().includes(filter))) rows.push(i);
    }
    const crumbs = el("div", { style: { padding: "8px 12px", display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
      el("button", { class: "link", onclick: () => { cwd = ""; render(); } }, ctx.name));
    let acc = "";
    for (const part of cwd ? cwd.split("/") : []) { acc = acc ? acc + "/" + part : part; const target = acc; crumbs.append(" / ", el("button", { class: "link", onclick: () => { cwd = target; render(); } }, part)); }
    const t = el("table", { class: "grid", style: { width: "100%" } },
      el("thead", {}, el("tr", {}, el("th", { style: { width: "28px" } }, ""), el("th", {}, _t("common.nome")), el("th", {}, _t("v_archive.dimensione")), el("th", {}, _t("v_archive.compresso")), el("th", {}, _t("v_archive.modificato")))));
    const tb = el("tbody");
    for (const r of rows) {
      const name = filter ? r.path : r.path.split("/").pop();
      const cb = el("input", { type: "checkbox", checked: selected.has(r.path) });
      cb.addEventListener("change", () => { cb.checked ? selected.add(r.path) : selected.delete(r.path); });
      const tr = el("tr", { style: { cursor: "pointer" } }, el("td", {}, cb), el("td", {}, (r.dir ? "📁 " : "") + name + (r.encrypted ? " 🔒" : "")),
        el("td", { style: { textAlign: "right" } }, r.dir ? "" : fmtSize(r.size)), el("td", { style: { textAlign: "right" } }, r.dir ? "" : fmtSize(r.packed)), el("td", {}, r.modified || ""));
      tr.addEventListener("dblclick", () => (r.dir ? ((cwd = r.path), render()) : openEntry(r.path)));
      tb.append(tr);
    }
    t.append(tb);
    list.append(crumbs, t);
    const files = items.filter(i => !i.dir);
    ctx.status(_t("v_archive.0_file_1_non_compressi", files.length, fmtSize(files.reduce((s, i) => s + i.size, 0))) + (data.type ? _t("v_archive.formato") + data.type : ""));
  }

  async function openEntry(entry) {
    toast(_t("v_archive.estrazione") + entry.split("/").pop() + "...");
    const r = await api("archive_extract", { path: ctx.path }, { json: { entry, password } });
    ctx.openFile(r.path);
  }

  const search = el("input", { type: "search", placeholder: _t("v_archive.cerca_nell_archivio"), id: "arc-q-" + ctx.tab.name, style: { width: "200px" } });
  search.addEventListener("input", () => { filter = search.value.trim().toLowerCase(); render(); });
  const editable = () => data?.editable;
  async function add(paths) {
    if (!editable()) return toast(_t("v_archive.questo_tipo_archivio_sola_lettura"), true);
    await api("archive_add", { path: ctx.path }, { json: { files: paths, folder: cwd } });
    toast(_t("v_archive.0_elemento_i_aggiunti_all", paths.length));
    await load();
  }
  ctx.tb.append(search, el("span", { class: "sep" }),
    button(_t("v_archive.apri"), "open", () => { const f = [...selected].find(p => !data.items.find(i => i.path === p)?.dir); if (f) openEntry(f); else toast(_t("v_archive.seleziona_file_fai_doppio_clic")); }),
    button(_t("v_archive.estrai_selezionati"), "download", async () => {
      const dest = await pickFolder();
      if (!dest) return;
      const sel = [...selected];
      if (!sel.length) return toast(_t("v_archive.seleziona_almeno_elemento"), true);
      for (const e of sel) await api("archive_extract", { path: ctx.path }, { json: { entry: e, dest, password } });
      toast(_t("v_archive.estratti") + dest);
    }),
    button(_t("v_archive.estrai_tutto"), "download", async () => {
      const dest = await pickFolder();
      if (!dest) return;
      await api("archive_extract", { path: ctx.path }, { json: { dest, password } });
      toast(_t("v_archive.archivio_estratto") + dest);
    }),
    el("span", { class: "sep" }),
    button(_t("v_archive.aggiungi_file"), "plus", async () => { const ps = await pickFiles(); if (ps?.length) add(ps); }),
    button(_t("common.rinomina"), "edit", async () => {
      const [one] = [...selected];
      if (!one || selected.size !== 1) return toast(_t("v_archive.seleziona_solo_elemento"), true);
      const nn = await askText(_t("common.rinomina"), _t("v_archive.nuovo_nome"), one.split("/").pop());
      if (!nn) return;
      await api("archive_rename", { path: ctx.path }, { json: { old: one, new: one.replace(/[^/]*$/, nn) } });
      selected.clear(); await load();
    }),
    button(_t("common.elimina"), "trash", async () => {
      if (!selected.size) return toast(_t("v_archive.seleziona_elementi_eliminare"), true);
      if (!(await confirmBox(_t("v_archive.elimina_dall_archivio"), _t("v_archive.eliminare_0_elemento_i_dall", selected.size), _t("common.elimina"), true))) return;
      await api("archive_delete", { path: ctx.path }, { json: { entries: [...selected] } });
      selected.clear(); await load();
    }),
    el("span", { class: "grow" }), el("span", { class: "note" }, _t("v_archive.doppio_clic_aprire_trascina_file")));
  await load();

  return {
    onBack() { // indietro: prima si risale di una cartella dentro l'archivio
      if (!cwd) return false;
      cwd = cwd.includes("/") ? cwd.slice(0, cwd.lastIndexOf("/")) : "";
      render();
      return true;
    },
    async acceptDrop(paths) {
      if (!editable()) return false;
      const choice = await modal(_t("v_archive.file_trascinati"), _t("v_archive.p_aggiungere_0_elemento_i", paths.length, ctx.name, cwd ? _t("v_archive.cartella") + cwd : ""),
        [{ label: _t("v_archive.aprili"), value: "open" }, { label: _t("v_archive.aggiungi_all_archivio"), value: "add", primary: true }]);
      if (choice === "add") { await add(paths); return true; }
      return false;
    },
  };
}
