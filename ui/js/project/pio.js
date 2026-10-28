// Lettori e scrittori dei piani di progetto, in puro JavaScript (anche nella web app e in Node per i collaudi):
//   MSPDI .xml (formato XML di Microsoft Project)  lettura e scrittura SENZA PERDITE: gli elementi che l'app non gestisce
//                                                   (campi personalizzati, viste, dati temporali...) si riscrivono tali e quali
//   MPX .mpx (Project 98 e programmi che lo esportano) lettura e scrittura
//   Primavera P6 .xer e P6 XML                       lettura
//   GanttProject .gan                                lettura e scrittura
//   .mpp (binario di Project) = motore Python (mbvisual/mpp.py), restituisce lo stesso modello
import { parseXml, kids, kid, val, text, find, tag, escapeXml, local } from "./pxml.js";
import { parseDate, toIso, dayOf, DAY, fromParts, newCalendar, STD_WEEK } from "./pcal.js";
import { newProject, outline, schedule, isMilestone, nextUid, CT } from "./pmodel.js";

// ------------------------------------------------------------------ riconoscimento
export function detect(bytes, ext = "") {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) return "mpp";
  if (/^MPX[,;]/.test(head)) return "mpx";
  if (/^ERMHDR/.test(head)) return "xer";
  if (/APIBusinessObjects/.test(head)) return "p6xml";
  if (/schemas\.microsoft\.com\/project|<Project[\s>][\s\S]*<SaveVersion>/.test(head)) return "mspdi";
  if (/<project[\s>]/.test(head) && /<tasks|ganttproject|view-date/i.test(new TextDecoder("latin1").decode(bytes.slice(0, 65536)))) return "gan";
  return { mpp: "mpp", mpt: "mpp", mpx: "mpx", xer: "xer", gan: "gan", xml: "mspdi", pmxml: "p6xml" }[ext] || null;
}
export function decode(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const enc = head.match(/encoding=["']([\w-]+)/i)?.[1]?.toLowerCase();
  if (enc && enc !== "utf-8" && enc !== "utf8") { try { return new TextDecoder(enc).decode(bytes); } catch { /* */ } }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return new TextDecoder("windows-1252").decode(bytes); }
}
export function readProject(bytes, ext = "") {
  const kind = detect(bytes, ext);
  const s = decode(bytes);
  let P;
  if (kind === "mspdi") P = readMspdi(s);
  else if (kind === "mpx") P = readMpx(s);
  else if (kind === "xer") P = readXer(s);
  else if (kind === "p6xml") P = readP6Xml(s);
  else if (kind === "gan") P = readGan(s);
  else throw new Error("formato");
  P.src = kind;
  schedule(P);
  return P;
}

// ------------------------------------------------------------------ MSPDI
// formato delle durate di Project -> unita' (35+ = stimata)
const DFMT = { 3: "m", 4: "em", 5: "h", 6: "eh", 7: "d", 8: "ed", 9: "w", 10: "ew", 11: "mo", 12: "emo", 19: "%", 20: "e%", 21: "d" };
const DFMT_INV = { m: 3, em: 4, h: 5, eh: 6, d: 7, ed: 8, w: 9, ew: 10, mo: 11, emo: 12 };
const fmtUnit = n => { n = +n; const est = n >= 35 && n <= 53; return { u: DFMT[est ? n - 32 : n] || "d", est }; };
export function isoDur(s) { // PT8H30M0S -> minuti
  if (!s) return 0;
  const m = String(s).match(/^(-)?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?/);
  if (!m) return 0;
  const v = (+(m[2] || 0)) * 525600 + (+(m[3] || 0)) * 43200 + (+(m[4] || 0)) * 1440 + (+(m[5] || 0)) * 60 + (+(m[6] || 0)) + (+(m[7] || 0)) / 60;
  return (m[1] ? -1 : 1) * v;
}
export const durIso = min => { const neg = min < 0; min = Math.abs(Math.round(min * 10) / 10); const h = Math.floor(min / 60), mm = Math.floor(min - h * 60), ss = Math.round((min - h * 60 - mm) * 60); return `${neg ? "-" : ""}PT${h}H${mm}M${ss}S`; };
const bool = v => v === "1" || v === "true";
const num = (v, d = 0) => (v == null || v === "" || isNaN(+v) ? d : +v);

// ordine degli elementi nello schema mspdi_pj15.xsd (Project lo vuole rispettato)
const ORD_PROJECT = "SaveVersion GUID Name Title Subject Category Company Manager Author CreationDate Revision LastSaved ScheduleFromStart StartDate FinishDate FYStartDate CriticalSlackLimit CurrencyDigits CurrencySymbol CurrencyCode CurrencySymbolPosition CalendarUID DefaultStartTime DefaultFinishTime MinutesPerDay MinutesPerWeek DaysPerMonth DefaultTaskType DefaultFixedCostAccrual DefaultStandardRate DefaultOvertimeRate DurationFormat WorkFormat EditableActualCosts HonorConstraints EarnedValueMethod InsertedProjectsLikeSummary MultipleCriticalPaths NewTasksEffortDriven NewTasksEstimated SplitsInProgressTasks SpreadActualCost SpreadPercentComplete TaskUpdatesResource FiscalYearStart WeekStartDay MoveCompletedEndsBack MoveRemainingStartsBack MoveRemainingStartsForward MoveCompletedEndsForward BaselineForEarnedValue AutoAddNewResourcesAndTasks StatusDate CurrentDate MicrosoftProjectServerURL Autolink NewTaskStartDate DefaultTaskEVMethod ProjectExternallyEdited ExtendedCreationDate ActualsInSync RemoveFileProperties AdminProject BaslineCalendar NewTasksAreManual UpdateManuallyScheduledTasksWhenEditingLinks KeepTaskOnNearestWorkingTimeWhenMadeAutoScheduled OutlineCodes WBSMasks ExtendedAttributes Calendars Tasks Resources Assignments".split(" ");
const ORD_TASK = "GUID UID ID Name Type IsNull CreateDate Contact WBS WBSLevel OutlineNumber OutlineLevel Priority Start Finish Duration DurationFormat Work Stop Resume ResumeValid EffortDriven Recurring OverAllocated Estimated Milestone Summary DisplayAsSummary Critical IsSubproject IsSubprojectReadOnly SubprojectName ExternalTask ExternalTaskProject EarlyStart EarlyFinish LateStart LateFinish StartVariance FinishVariance WorkVariance FreeSlack StartSlack FinishSlack TotalSlack FixedCost FixedCostAccrual PercentComplete PercentWorkComplete Cost OvertimeCost OvertimeWork ActualStart ActualFinish ActualDuration ActualCost ActualOvertimeCost ActualWork ActualOvertimeWork RegularWork RemainingDuration RemainingCost RemainingWork RemainingOvertimeCost RemainingOvertimeWork ACWP CV ConstraintType CalendarUID ConstraintDate Deadline LevelAssignments LevelingCanSplit LevelingDelay LevelingDelayFormat PreLeveledStart PreLeveledFinish Hyperlink HyperlinkAddress HyperlinkSubAddress IgnoreResourceCalendar Notes HideBar Rollup BCWS BCWP PhysicalPercentComplete EarnedValueMethod PredecessorLink ActualWorkProtected ActualOvertimeWorkProtected ExtendedAttribute Baseline OutlineCode IsPublished StatusManager CommitmentStart CommitmentFinish CommitmentType Active Manual ManualStart ManualFinish ManualDuration TimephasedData".split(" ");
const ORD_RES = "UID ID Name Type IsNull Initials Phonetics NTAccount MaterialLabel Code Group WorkGroup EmailAddress Hyperlink HyperlinkAddress HyperlinkSubAddress MaxUnits PeakUnits OverAllocated AvailableFrom AvailableTo Start Finish CanLevel AccrueAt Work RegularWork OvertimeWork ActualWork RemainingWork ActualOvertimeWork RemainingOvertimeWork PercentWorkComplete StandardRate StandardRateFormat Cost OvertimeRate OvertimeRateFormat OvertimeCost CostPerUse ActualCost ActualOvertimeCost RemainingCost RemainingOvertimeCost WorkVariance CostVariance SV CV ACWP CalendarUID Notes BCWS BCWP IsGeneric IsInactive IsEnterprise BookingType ActualWorkProtected ActualOvertimeWorkProtected ActiveDirectoryGUID CreationDate ExtendedAttribute Baseline OutlineCode IsCostResource AssnOwner AssnOwnerGuid IsBudget AvailabilityPeriods Rates TimephasedData".split(" ");
const ORD_ASSN = "UID TaskUID ResourceUID PercentWorkComplete ActualCost ActualFinish ActualOvertimeCost ActualOvertimeWork ActualStart ActualWork ACWP Confirmed Cost CostRateTable CostVariance CV Delay Finish FinishVariance Hyperlink HyperlinkAddress HyperlinkSubAddress WorkVariance HasFixedRateUnits FixedMaterial LevelingDelay LevelingDelayFormat LinkedFields Milestone Notes Overallocated OvertimeCost OvertimeWork PeakUnits RateScale RegularWork RemainingCost RemainingOvertimeCost RemainingOvertimeWork RemainingWork ResponsePending Start Stop Resume StartVariance Summary SV Units UpdateNeeded VAC Work WorkContour BCWS BCWP BookingType ActualWorkProtected ActualOvertimeWorkProtected CreationDate AssnOwner AssnOwnerGuid BudgetCost BudgetWork ExtendedAttribute Baseline TimephasedData".split(" ");
const ORD_CAL = "UID Name IsBaseCalendar IsBaselineCalendar BaseCalendarUID WeekDays Exceptions WorkWeeks".split(" ");
// elementi derivati dalle date: se l'attivita' e' stata modificata non si riscrivono (Project li ricalcola)
const STALE_TASK = new Set("Stop Resume ResumeValid StartVariance FinishVariance WorkVariance StartSlack FinishSlack ActualDuration ActualWork RegularWork RemainingDuration RemainingCost RemainingWork ACWP CV BCWS BCWP PercentWorkComplete TimephasedData PreLeveledStart PreLeveledFinish OverAllocated".split(" "));
const STALE_ASSN = new Set("Start Finish Stop Resume RemainingWork RegularWork TimephasedData StartVariance FinishVariance WorkVariance CostVariance".split(" "));

// figli non gestiti, conservati come testo XML grezzo nell'ordine originale
function extras(src, node, managed) {
  const x = [];
  for (const c of kids(node)) if (!managed.has(local(c.n))) x.push([local(c.n), src.slice(c.s, c.e)]);
  return x;
}
const T_MANAGED = new Set("UID ID Name IsNull WBS OutlineNumber OutlineLevel Priority Start Finish Duration DurationFormat Work Estimated Milestone Summary Critical EarlyStart EarlyFinish LateStart LateFinish FreeSlack TotalSlack FixedCost PercentComplete Cost ActualStart ActualFinish ConstraintType CalendarUID ConstraintDate Deadline LevelingDelay LevelingDelayFormat Notes PredecessorLink Baseline Active Manual ManualStart ManualFinish ManualDuration".split(" "));
const R_MANAGED = new Set("UID ID Name Type IsNull Initials MaterialLabel Group EmailAddress MaxUnits Work StandardRate StandardRateFormat Cost OvertimeRate OvertimeRateFormat CostPerUse CalendarUID Notes IsCostResource".split(" "));
const A_MANAGED = new Set("UID TaskUID ResourceUID Units Work Cost".split(" "));
const P_MANAGED = new Set("Name Title Author Company Manager StartDate FinishDate CalendarUID MinutesPerDay MinutesPerWeek DaysPerMonth CurrencySymbol StatusDate Calendars Tasks Resources Assignments".split(" "));
const C_MANAGED = new Set("UID Name IsBaseCalendar BaseCalendarUID WeekDays Exceptions".split(" "));

const timeMin = s => { const m = String(s || "").match(/(\d+):(\d+)/); return m ? +m[1] * 60 + +m[2] : 0; };
function workTimes(node) {
  const out = [];
  for (const w of kids(kid(node, "WorkingTimes"), "WorkingTime")) {
    const a = timeMin(val(w, "FromTime")); let b = timeMin(val(w, "ToTime"));
    if (b <= a) b = 1440;
    out.push([a, b]);
  }
  return out;
}

export function readMspdi(src) {
  const doc = parseXml(src);
  const R = kids(doc).find(n => local(n.n) === "Project");
  if (!R) throw new Error("MSPDI");
  const P = newProject(parseDate(val(R, "StartDate")));
  P.name = val(R, "Name") || ""; P.title = val(R, "Title") || ""; P.author = val(R, "Author") || ""; P.company = val(R, "Company") || ""; P.manager = val(R, "Manager") || "";
  P.mpd = num(val(R, "MinutesPerDay"), 480); P.mpw = num(val(R, "MinutesPerWeek"), 2400); P.dpm = num(val(R, "DaysPerMonth"), 20);
  P.currency = val(R, "CurrencySymbol") || "€";
  P.status = parseDate(val(R, "StatusDate"));
  P.cal = num(val(R, "CalendarUID"), 1);
  P.x = { root: extras(src, R, P_MANAGED), rootAttrs: R.a, fmt: "mspdi" };
  // calendari
  P.calendars = [];
  for (const c of kids(kid(R, "Calendars"), "Calendar")) {
    const base = val(c, "BaseCalendarUID");
    const isBase = bool(val(c, "IsBaseCalendar"));
    const cal = { uid: num(val(c, "UID")), name: val(c, "Name") || "", base: !isBase && base != null && base !== "-1" ? +base : null, week: isBase ? STD_WEEK() : [null, null, null, null, null, null, null], exc: [], x: extras(src, c, C_MANAGED) };
    for (const wd of kids(kid(c, "WeekDays"), "WeekDay")) {
      const dt = num(val(wd, "DayType"));
      const working = bool(val(wd, "DayWorking"));
      if (dt >= 1 && dt <= 7) cal.week[dt - 1] = working ? workTimes(wd) : [];
      else if (dt === 0) { // eccezioni nel formato vecchio
        const tp = kid(wd, "TimePeriod"), f = parseDate(val(tp, "FromDate")), t = parseDate(val(tp, "ToDate"));
        if (f != null && t != null) cal.exc.push({ from: dayOf(f), to: dayOf(t - 1), name: "", work: working ? workTimes(wd) : [] });
      }
    }
    const exs = kids(kid(c, "Exceptions"), "Exception");
    if (exs.length) cal.exc = [];
    for (const e of exs) {
      const tp = kid(e, "TimePeriod"), f = parseDate(val(tp, "FromDate")), t = parseDate(val(tp, "ToDate"));
      if (f == null || t == null) continue;
      cal.exc.push({ from: dayOf(f), to: dayOf(t - 1 / 60), name: val(e, "Name") || "", work: bool(val(e, "DayWorking")) ? workTimes(e) : [], rec: num(val(e, "Type"), 1) !== 1 ? src.slice(e.s, e.e) : null });
    }
    P.calendars.push(cal);
  }
  if (!P.calendars.length) P.calendars.push(newCalendar(1, "Standard"));
  if (!P.calendars.some(c => c.uid === P.cal)) P.cal = P.calendars[0].uid;
  // attivita'
  P.tasks = [];
  for (const n of kids(kid(R, "Tasks"), "Task")) {
    const uid = num(val(n, "UID"));
    if (uid === 0 && num(val(n, "OutlineLevel")) === 0) { P.x.summary = src.slice(n.s, n.e); continue; } // riepilogo del progetto
    if (bool(val(n, "IsNull"))) { P.tasks.push({ uid, name: "", lvl: 1, dur: 0, du: "d", isNull: true, preds: [], bl: [], pct: 0, ct: 0, act: true, x: [] }); continue; }
    const df = fmtUnit(val(n, "DurationFormat") ?? 7);
    const dfRaw = val(n, "DurationFormat");
    const manual = bool(val(n, "Manual"));
    const t = {
      uid, name: val(n, "Name") || "", lvl: num(val(n, "OutlineLevel"), 1), dur: 0,
      du: df.u === "%" || df.u === "e%" ? "d" : df.u, est: df.est || bool(val(n, "Estimated")), ms: bool(val(n, "Milestone")), manual,
      start: parseDate(manual ? val(n, "ManualStart") ?? val(n, "Start") : val(n, "Start")), finish: parseDate(manual ? val(n, "ManualFinish") ?? val(n, "Finish") : val(n, "Finish")),
      ct: num(val(n, "ConstraintType")), cd: parseDate(val(n, "ConstraintDate")), dl: parseDate(val(n, "Deadline")), pct: num(val(n, "PercentComplete")),
      notes: val(n, "Notes") || "", cal: val(n, "CalendarUID") && val(n, "CalendarUID") !== "-1" ? +val(n, "CalendarUID") : null,
      as: parseDate(val(n, "ActualStart")), af: parseDate(val(n, "ActualFinish")), fc: num(val(n, "FixedCost")), pri: num(val(n, "Priority"), 500),
      act: val(n, "Active") == null ? true : bool(val(n, "Active")), delay: Math.round(num(val(n, "LevelingDelay")) / 10), wbs: val(n, "WBS") || "",
      preds: [], bl: [], x: extras(src, n, T_MANAGED), _df: dfRaw,
    };
    // durata: per le attivita' manuali vale ManualDuration
    t.dur = Math.max(0, Math.round(isoDur(manual ? (val(n, "ManualDuration") ?? val(n, "Duration")) : val(n, "Duration"))));
    if (t.ct === 0 || t.ct === 1) t.cd = null;
    for (const l of kids(n, "PredecessorLink")) {
      const lf = fmtUnit(val(l, "LagFormat") ?? 7);
      const lag = num(val(l, "LinkLag")) / 10;
      const L = { u: num(val(l, "PredecessorUID")), t: num(val(l, "Type"), 1), lag: Math.round(lag), lu: lf.u };
      if (lf.u === "%" || lf.u === "e%") { L.pc = lag; L.lag = 0; L.lu = "d"; } // ritardo in percentuale: LinkLag = % x 10
      if (val(l, "CrossProject") === "1") continue;
      t.preds.push(L);
    }
    for (const b of kids(n, "Baseline")) {
      const k = num(val(b, "Number"));
      t.bl[k] = { start: parseDate(val(b, "Start")), finish: parseDate(val(b, "Finish")), dur: Math.round(isoDur(val(b, "Duration"))), work: Math.round(isoDur(val(b, "Work"))), cost: num(val(b, "Cost")) / 100 };
    }
    P.tasks.push(t);
  }
  // risorse
  for (const n of kids(kid(R, "Resources"), "Resource")) {
    const uid = num(val(n, "UID"));
    if (uid === 0 || bool(val(n, "IsNull"))) { if (uid === 0) P.x.res0 = src.slice(n.s, n.e); continue; }
    const typ = bool(val(n, "IsCostResource")) ? "cost" : num(val(n, "Type"), 1) === 0 ? "material" : "work";
    P.resources.push({
      uid, name: val(n, "Name") || "", type: typ, ini: val(n, "Initials") || "", group: val(n, "Group") || "", max: num(val(n, "MaxUnits"), 1),
      rate: num(val(n, "StandardRate")), ovt: num(val(n, "OvertimeRate")), use: num(val(n, "CostPerUse")) / 100, label: val(n, "MaterialLabel") || "",
      email: val(n, "EmailAddress") || "", cal: val(n, "CalendarUID") && val(n, "CalendarUID") !== "-1" ? +val(n, "CalendarUID") : null, notes: val(n, "Notes") || "",
      x: extras(src, n, R_MANAGED),
    });
  }
  // assegnazioni
  const resUids = new Set(P.resources.map(r => r.uid));
  for (const n of kids(kid(R, "Assignments"), "Assignment")) {
    const a = { uid: num(val(n, "UID")), task: num(val(n, "TaskUID")), res: num(val(n, "ResourceUID")), units: num(val(n, "Units"), 1), w: val(n, "Work") ? Math.round(isoDur(val(n, "Work"))) : null, cost: num(val(n, "Cost")) / 100, x: extras(src, n, A_MANAGED) };
    if (!resUids.has(a.res)) { (P.x.assn ||= []).push(src.slice(n.s, n.e)); continue; } // assegnazioni senza risorsa (Project le crea da solo)
    P.assignments.push(a);
  }
  const res = new Map(P.resources.map(r => [r.uid, r]));
  for (const a of P.assignments) if (res.get(a.res)?.type === "material") a.w = null;
  for (const t of P.tasks) t._h = taskHash(t);
  for (const a of P.assignments) a._h = JSON.stringify([a.units, a.w]);
  return P;
}
// valori scelti dall'utente (non quelli calcolati): se cambiano, i dati derivati del file non valgono piu'
const taskHash = t => JSON.stringify([t.name, t.sum ? 0 : t.dur, t.du, t.manual, t.manual ? [t.start, t.finish] : 0, t.ct, t.cd, t.sum ? 0 : t.pct, t.preds, t.as, t.af, t.lvl, t.act, t.cal, t.delay || 0]);

function emit(order, values, x) {
  // values: Map nome -> [stringhe XML]; x: [[nome, grezzo]] estranei
  const extraBy = new Map();
  for (const [n, raw] of x || []) (extraBy.get(n) || extraBy.set(n, []).get(n)).push(raw);
  const out = [];
  for (const n of order) {
    if (values.has(n)) out.push(...values.get(n));
    else if (extraBy.has(n)) out.push(...extraBy.get(n));
  }
  for (const [n, raws] of extraBy) if (!order.includes(n) && !values.has(n)) out.push(...raws);
  return out.join("");
}
const dt = t => (t == null ? null : toIso(t));
const set = (m, n, v) => { if (v != null && v !== "") m.set(n, [tag(n, v)]); };

export function writeMspdi(P) {
  schedule(P);
  const V = new Map();
  set(V, "SaveVersion", "14");
  set(V, "Name", P.name || "Project"); set(V, "Title", P.title); set(V, "Author", P.author); set(V, "Company", P.company); set(V, "Manager", P.manager);
  set(V, "ScheduleFromStart", "1");
  set(V, "StartDate", dt(P.start)); set(V, "FinishDate", dt(P.finish));
  set(V, "CurrencySymbol", P.currency || "€");
  set(V, "CalendarUID", P.cal);
  set(V, "MinutesPerDay", P.mpd); set(V, "MinutesPerWeek", P.mpw); set(V, "DaysPerMonth", P.dpm);
  set(V, "StatusDate", dt(P.status));
  if (P.x?.root) for (const [n] of P.x.root) if (V.has(n) && ["SaveVersion", "ScheduleFromStart"].includes(n)) V.delete(n); // valori del file originale
  // calendari
  const cals = P.calendars.map(c => {
    const m = new Map();
    set(m, "UID", c.uid); set(m, "Name", c.name); set(m, "IsBaseCalendar", c.base == null ? "1" : "0"); set(m, "BaseCalendarUID", c.base == null ? "-1" : c.base);
    const wd = [];
    c.week.forEach((s, i) => {
      if (s == null) return;
      wd.push(tag("WeekDay", [tag("DayType", i + 1), tag("DayWorking", s.length ? 1 : 0), s.length ? tag("WorkingTimes", s.map(([a, b]) => tag("WorkingTime", [tag("FromTime", hhmm(a)), tag("ToTime", hhmm(b % 1440))]))) : ""]));
    });
    if (wd.length) m.set("WeekDays", [tag("WeekDays", wd)]);
    if (c.exc.length) m.set("Exceptions", [tag("Exceptions", c.exc.map(e => e.rec || tag("Exception", [tag("EnteredByOccurrences", 0), tag("TimePeriod", [tag("FromDate", toIso(e.from * DAY)), tag("ToDate", toIso(e.to * DAY + 1439).replace(/:00$/, ":59"))]), tag("Occurrences", 1), tag("Name", e.name || ""), tag("Type", 1), tag("DayWorking", e.work.length ? 1 : 0), e.work.length ? tag("WorkingTimes", e.work.map(([a, b]) => tag("WorkingTime", [tag("FromTime", hhmm(a)), tag("ToTime", hhmm(b % 1440))]))) : ""])))]);
    return tag("Calendar", [emit(ORD_CAL, m, c.x)]);
  });
  V.set("Calendars", [tag("Calendars", cals)]);
  // attivita'
  const tasks = [];
  if (P.x?.summary) tasks.push(P.x.summary);
  for (const t of P.tasks) {
    const m = new Map();
    if (t.isNull) { set(m, "UID", t.uid); set(m, "ID", t.id); set(m, "IsNull", 1); tasks.push(tag("Task", [emit(ORD_TASK, m, [])])); continue; }
    const touched = t._h !== taskHash(t);
    const df = !touched && t._df != null ? t._df : (DFMT_INV[t.du] || 7) + (t.est ? 32 : 0);
    set(m, "UID", t.uid); set(m, "ID", t.id); set(m, "Name", t.name); set(m, "IsNull", 0);
    set(m, "WBS", t.wbs || t.on); set(m, "OutlineNumber", t.on); set(m, "OutlineLevel", t.lvl); set(m, "Priority", t.pri ?? 500);
    set(m, "Start", dt(t.start)); set(m, "Finish", dt(t.finish));
    set(m, "Duration", durIso(t.dur)); set(m, "DurationFormat", df); set(m, "Work", durIso(t.work || 0));
    set(m, "Estimated", t.est ? 1 : 0); set(m, "Milestone", isMilestone(t) ? 1 : 0); set(m, "Summary", t.sum ? 1 : 0); set(m, "Critical", t.crit ? 1 : 0);
    set(m, "EarlyStart", dt(t.es)); set(m, "EarlyFinish", dt(t.ef)); set(m, "LateStart", dt(t.ls)); set(m, "LateFinish", dt(t.lf));
    set(m, "FreeSlack", Math.round((t.fs || 0) * 10)); set(m, "TotalSlack", Math.round((t.ts || 0) * 10));
    set(m, "FixedCost", t.fc || 0); set(m, "PercentComplete", Math.round(t.pct || 0)); set(m, "Cost", Math.round((t.cost || 0) * 100));
    set(m, "ActualStart", dt(t.as)); set(m, "ActualFinish", dt(t.af));
    set(m, "ConstraintType", t.ct || 0); set(m, "CalendarUID", t.cal ?? -1); set(m, "ConstraintDate", t.ct > 1 ? dt(t.cd) : null); set(m, "Deadline", dt(t.dl));
    set(m, "LevelingDelay", Math.round((t.delay || 0) * 10)); set(m, "LevelingDelayFormat", 8);
    set(m, "Notes", t.notes);
    m.set("PredecessorLink", (t.preds || []).map(L => tag("PredecessorLink", [tag("PredecessorUID", L.u), tag("Type", L.t ?? 1), tag("CrossProject", 0),
      tag("LinkLag", L.pc != null ? Math.round(L.pc * 10) : Math.round((L.lag || 0) * 10)), tag("LagFormat", L.pc != null ? 19 : DFMT_INV[L.lu] || 7)])));
    m.set("Baseline", (t.bl || []).map((b, k) => b ? tag("Baseline", [tag("Number", k), tag("Start", dt(b.start)), tag("Finish", dt(b.finish)), tag("Duration", durIso(b.dur || 0)), tag("DurationFormat", 7), tag("Work", durIso(b.work || 0)), tag("Cost", Math.round((b.cost || 0) * 100))]) : "").filter(Boolean));
    set(m, "Active", t.act === false ? 0 : 1);
    set(m, "Manual", t.manual ? 1 : 0);
    if (t.manual) { set(m, "ManualStart", dt(t.start)); set(m, "ManualFinish", dt(t.finish)); set(m, "ManualDuration", durIso(t.dur)); }
    const x = touched ? (t.x || []).filter(([n]) => !STALE_TASK.has(n)) : t.x;
    tasks.push(tag("Task", [emit(ORD_TASK, m, x)]));
  }
  V.set("Tasks", [tag("Tasks", tasks)]);
  // risorse
  const rs = [];
  if (P.x?.res0) rs.push(P.x.res0);
  P.resources.forEach((r, i) => {
    const m = new Map();
    set(m, "UID", r.uid); set(m, "ID", i + 1); set(m, "Name", r.name); set(m, "Type", r.type === "material" ? 0 : 1); set(m, "IsNull", 0);
    set(m, "Initials", r.ini || (r.name || "?")[0]); set(m, "MaterialLabel", r.type === "material" ? r.label : null); set(m, "Group", r.group); set(m, "EmailAddress", r.email);
    set(m, "MaxUnits", r.type === "work" ? (r.max ?? 1) : null); set(m, "Work", durIso(r.work || 0));
    set(m, "StandardRate", r.rate || 0); set(m, "StandardRateFormat", r.type === "material" ? 7 : 2); set(m, "Cost", Math.round((r.cost || 0) * 100));
    set(m, "OvertimeRate", r.ovt || 0); set(m, "OvertimeRateFormat", 2); set(m, "CostPerUse", Math.round((r.use || 0) * 100));
    set(m, "CalendarUID", r.cal ?? null); set(m, "Notes", r.notes); set(m, "IsCostResource", r.type === "cost" ? 1 : 0);
    rs.push(tag("Resource", [emit(ORD_RES, m, r.x)]));
  });
  V.set("Resources", [tag("Resources", rs)]);
  // assegnazioni
  const tasksBy = new Map(P.tasks.map(t => [t.uid, t]));
  const as = (P.x?.assn || []).filter(raw => { const u = +(raw.match(/<TaskUID>(\d+)/)?.[1]); return tasksBy.has(u); });
  for (const a of P.assignments) {
    const t = tasksBy.get(a.task);
    if (!t) continue;
    const r = P.resources.find(x => x.uid === a.res);
    const m = new Map();
    set(m, "UID", a.uid); set(m, "TaskUID", a.task); set(m, "ResourceUID", a.res);
    set(m, "Cost", Math.round((a.cost && r?.type === "cost" ? a.cost : 0) * 100) || null);
    set(m, "Units", a.units ?? 1);
    if (r?.type !== "material") set(m, "Work", durIso(r?.type === "work" ? (a.w ?? (a.units ?? 1) * t.dur) : 0));
    const touched = t._h !== taskHash(t) || a._h !== JSON.stringify([a.units, a.w]);
    if (touched) { set(m, "Start", dt(t.start)); set(m, "Finish", dt(t.finish)); }
    const x = touched ? (a.x || []).filter(([n]) => !STALE_ASSN.has(n)) : a.x;
    as.push(tag("Assignment", [emit(ORD_ASSN, m, x)]));
  }
  V.set("Assignments", [tag("Assignments", as)]);
  const body = emit(ORD_PROJECT, V, (P.x?.root || []).filter(([n]) => !P_MANAGED.has(n) || n === "SaveVersion"));
  const attrs = P.x?.rootAttrs && Object.keys(P.x.rootAttrs).length ? P.x.rootAttrs : { xmlns: "http://schemas.microsoft.com/project" };
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${tag("Project", [body], attrs)}\n`;
}
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;

// ------------------------------------------------------------------ MPX
const MPX_CT = ["As Soon As Possible", "As Late As Possible", "Must Start On", "Must Finish On", "Start No Earlier Than", "Start No Later Than", "Finish No Earlier Than", "Finish No Later Than"];
function csvSplit(line, sep) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
export function readMpx(src) {
  const lines = src.split(/\r?\n/);
  const sep = lines[0][3] || ",";
  const P = newProject();
  P.calendars = []; P.x = { fmt: "mpx" };
  let dateOrder = 0, decSep = ".", taskFields = null, resFields = null, curTask = null, curRes = null, curCal = null, pm = "PM";
  const d = s => {
    if (!s || s === "NA") return null;
    const m = s.match(/(\d{1,4})[^\d](\d{1,2})[^\d](\d{1,4})(?:\s+(\d{1,2})[:.](\d{2})\s*([AaPp][Mm])?)?/);
    if (!m) return null;
    let [a, b, c] = [+m[1], +m[2], +m[3]];
    let y, mo, dd;
    if (dateOrder === 0) { mo = a; dd = b; y = c; } else if (dateOrder === 1) { dd = a; mo = b; y = c; } else { y = a; mo = b; dd = c; }
    if (y < 100) y += y < 70 ? 2000 : 1900;
    let hh = m[4] ? +m[4] : null, mi = m[5] ? +m[5] : 0;
    if (m[6] && /p/i.test(m[6]) && hh < 12) hh += 12;
    if (m[6] && /a/i.test(m[6]) && hh === 12) hh = 0;
    return fromParts(y, mo, dd, hh ?? 0, mi) + (hh == null ? -1 : 0); // senza ora: -1 = "solo data"
  };
  const dur = s => {
    if (!s) return null;
    const m = s.replace(decSep, ".").match(/(-?[\d.]+)\s*(e?)(m|h|d|w|mo|min|hr|dy|wk|mon|g|s|t)?(\??)/i);
    if (!m) return null;
    const u = { m: "m", min: "m", h: "h", hr: "h", d: "d", dy: "d", g: "d", t: "d", w: "w", wk: "w", s: "w", mo: "mo", mon: "mo" }[(m[3] || "d").toLowerCase()] || "d";
    const uu = (m[2] ? "e" : "") + u;
    const mins = { m: 1, h: 60, d: P.mpd, w: P.mpw, mo: P.mpd * P.dpm, em: 1, eh: 60, ed: 1440, ew: 10080, emo: 43200 }[uu];
    return { dur: Math.round(+m[1] * mins), du: uu, est: !!m[4] };
  };
  const pctv = s => num(String(s || "").replace("%", "").replace(decSep, "."));
  const money = s => num(String(s || "").replace(/[^\d.,-]/g, "").replace(decSep === "," ? /\./g : /,/g, "").replace(",", "."));
  const pendingPreds = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const f = csvSplit(line, sep);
    const rec = f[0].trim();
    if (rec === "MPX") continue;
    if (rec === "10") { decSep = f[5] || "."; P.currency = f[1] || P.currency; }
    else if (rec === "11") { if (f[4]) P.mpd = Math.round(num(f[4].replace(",", "."), 8) * 60); if (f[5]) P.mpw = Math.round(num(f[5].replace(",", "."), 40) * 60); }
    else if (rec === "12") { dateOrder = num(f[1]); pm = f[7] || "PM"; }
    else if (rec === "20") {
      curCal = { uid: P.calendars.length + 1, name: f[1] || "Standard", base: null, week: STD_WEEK(), exc: [] };
      for (let i = 0; i < 7; i++) { const v = f[2 + i]; if (v === "0") curCal.week[i] = []; else if (v === "1" && !curCal.week[i].length) curCal.week[i] = [[480, 720], [780, 1020]]; }
      P.calendars.push(curCal);
    } else if (rec === "25" && curCal) {
      const day = num(f[1]) - 1, sh = [];
      for (let i = 2; i + 1 < f.length; i += 2) if (f[i]) { const a = timeMin(f[i]), b = timeMin(f[i + 1]); sh.push([a, b <= a ? 1440 : b]); }
      if (day >= 0 && day < 7 && (sh.length || curCal.week[day].length)) curCal.week[day] = sh.length ? sh : curCal.week[day];
    } else if (rec === "26" && curCal) {
      const a = d(f[1]), b = d(f[2]);
      if (a != null) { const sh = []; for (let i = 4; i + 1 < f.length; i += 2) if (f[i]) sh.push([timeMin(f[i]), timeMin(f[i + 1]) || 1440]); curCal.exc.push({ from: dayOf(a + 1), to: dayOf((b ?? a) + 1), name: "", work: f[3] === "1" ? sh : [] }); }
    } else if (rec === "30") {
      P.name = f[1] || ""; P.company = f[2] || ""; P.manager = f[3] || "";
      const s = d(f[5]); if (s != null) P.start = s + (s % 1440 === 1439 ? 481 : 0);
    } else if (rec === "41") resFields = f.slice(1).map(Number);
    else if (rec === "50" && resFields) {
      const v = {}; resFields.forEach((k, i) => (v[k] = f[i + 1]));
      curRes = { uid: num(v[49], P.resources.length + 1), id: num(v[40], P.resources.length + 1), name: v[1] || "", type: "work", ini: v[2] || "", group: v[3] || "", max: v[41] ? pctv(v[41]) / (String(v[41]).includes("%") ? 100 : 1) : 1, rate: money(v[42]), ovt: money(v[43]), use: money(v[44]), email: v[11] || "" };
      P.resources.push(curRes);
    } else if (rec === "61") taskFields = f.slice(1).map(Number);
    else if (rec === "70" && taskFields) {
      const v = {}; taskFields.forEach((k, i) => (v[k] = f[i + 1]));
      const lvl = num(v[3], 1);
      const uid = num(v[98], P.tasks.length + 1);
      if (lvl === 0 || (uid === 0 && v[3] === "0")) { curTask = null; continue; } // riepilogo del progetto
      const D = dur(v[40]) || { dur: 0, du: "d", est: false };
      let ct = MPX_CT.findIndex(x => x.toLowerCase() === String(v[91] || "").toLowerCase());
      if (ct < 0) ct = /^\d$/.test(v[91] || "") ? +v[91] : 0;
      const ds = s => { const x = d(s); return x == null ? null : x % 1440 === 1439 ? x + 1 + 480 : x; };
      const df = s => { const x = d(s); return x == null ? null : x % 1440 === 1439 ? x + 1 + 1020 : x; };
      curTask = { uid, name: v[1] || "", lvl, dur: D.dur, du: D.du, est: D.est, ms: /^(yes|ja|oui|si|sì|1)$/i.test(v[81] || ""), manual: false, start: ds(v[50]), finish: df(v[51]),
        ct, cd: ds(v[68]), pct: pctv(v[44]), notes: "", preds: [], bl: [], act: true, pri: 500, fc: money(v[35]), wbs: v[2] || "", as: ds(v[58]), af: df(v[59]) };
      if (v[56] || v[57]) curTask.bl[0] = { start: ds(v[56]), finish: df(v[57]), dur: dur(v[41])?.dur ?? 0, work: 0, cost: 0 };
      if (curTask.ct < 2) curTask.cd = null;
      pendingPreds.push([curTask, v[74] ? "u" : "id", v[74] || v[70] || ""]);
      curTask._id = num(v[90], P.tasks.length + 1);
      P.tasks.push(curTask);
    } else if (rec === "71" && curTask) curTask.notes = f.slice(1).join(sep).replace(/\x7f/g, "\n");
    else if (rec === "51" && curRes) curRes.notes = f.slice(1).join(sep);
    else if (rec === "75" && curTask) {
      const r = P.resources.find(x => x.id === num(f[1])) || P.resources.find(x => x.uid === num(f[13]));
      if (r) { const w = dur(f[3]); P.assignments.push({ uid: P.assignments.length + 1, task: curTask.uid, res: r.uid, units: num(String(f[2]).replace(",", "."), 1), w: w ? w.dur : null }); }
    }
  }
  if (!P.calendars.length) P.calendars.push(newCalendar(1, "Standard"));
  P.cal = P.calendars[0].uid;
  const byId = new Map(P.tasks.map(t => [t._id, t])), byU = new Map(P.tasks.map(t => [t.uid, t]));
  for (const [t, kind, s] of pendingPreds) {
    for (const part of s.split(/[;,]/).map(x => x.trim()).filter(Boolean)) {
      const m = part.match(/^(\d+)\s*(FS|SS|FF|SF)?\s*(?:([+-])\s*(.+))?$/i);
      if (!m) continue;
      const p = kind === "u" ? byU.get(+m[1]) : byId.get(+m[1]);
      if (!p) continue;
      const L = { u: p.uid, t: ["FF", "FS", "SF", "SS"].indexOf((m[2] || "FS").toUpperCase()), lag: 0, lu: "d" };
      if (m[3]) { if (/%/.test(m[4])) L.pc = (m[3] === "-" ? -1 : 1) * pctv(m[4]); else { const D = dur(m[4]); if (D) { L.lag = (m[3] === "-" ? -1 : 1) * D.dur; L.lu = D.du; } } }
      t.preds.push(L);
    }
  }
  for (const t of P.tasks) delete t._id;
  if (P.start == null || isNaN(P.start)) P.start = Math.min(...P.tasks.map(t => t.start ?? Infinity).filter(isFinite), Date.now() / 60000);
  return P;
}
export function writeMpx(P) {
  schedule(P);
  const q = s => { s = String(s ?? ""); return /[,"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const D = t => { if (t == null) return ""; const x = new Date(t * 60000); const p = n => String(n).padStart(2, "0"); return `${p(x.getUTCDate())}/${p(x.getUTCMonth() + 1)}/${p(x.getUTCFullYear() % 100)} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}`; };
  const du = (m, u = "d") => { const k = { m: 1, h: 60, d: P.mpd, w: P.mpw, mo: P.mpd * P.dpm, em: 1, eh: 60, ed: 1440, ew: 10080, emo: 43200 }[u] || P.mpd; return `${Math.round((m / k) * 100) / 100}${u}`; };
  const L = ["MPX,Microsoft Project for Windows,4.0,ANSI", `10,${q(P.currency || "€")},1,2,",",.`, `11,2,0,1,${(P.mpd / 60).toFixed(2)},${(P.mpw / 60).toFixed(2)},0.00/h,0.00/h,0,1`, "12,1,1,480,/,:,,,0,1"];
  for (const c of P.calendars.filter(x => x.base == null)) { // record 20: nome + 7 giorni (i calendari delle risorse non si scrivono)
    L.push(`20,${q(c.name)}${c.week.map(s => (s == null ? 2 : s.length ? 1 : 0)).map(v => "," + v).join("")}`);
    c.week.forEach((s, i) => { if (s?.length) L.push(`25,${i + 1},${s.map(([a, b]) => `${hhmm(a).slice(0, 5)},${hhmm(b % 1440).slice(0, 5)}`).join(",")}`); });
    for (const e of c.exc) L.push(`26,${D(e.from * DAY).slice(0, 8)},${D(e.to * DAY).slice(0, 8)},${e.work.length ? 1 : 0}${e.work.map(([a, b]) => `,${hhmm(a).slice(0, 5)},${hhmm(b % 1440).slice(0, 5)}`).join("")}`);
  }
  L.push(`30,${q(P.name)},${q(P.company)},${q(P.manager)},${q(P.calendars.find(c => c.uid === P.cal)?.name || "Standard")},${D(P.start)},${D(P.finish)},0`);
  L.push("40,ID,Name,Initials,Group,Max Units,Standard Rate,Overtime Rate,Cost Per Use,Email Address,Unique ID", "41,40,1,2,3,41,42,43,44,11,49");
  P.resources.forEach((r, i) => { r._id = i + 1; L.push(`50,${i + 1},${q(r.name)},${q(r.ini)},${q(r.group)},${r.max ?? 1},${r.rate || 0}/h,${r.ovt || 0}/h,${r.use || 0},${q(r.email)},${r.uid}`); if (r.notes) L.push(`51,${q(r.notes)}`); });
  L.push("60,ID,Name,WBS,Outline Level,Duration,% Complete,Start,Finish,Constraint Type,Constraint Date,Predecessors,Milestone,Fixed Cost,Actual Start,Actual Finish,Baseline Start,Baseline Finish,Unique ID", "61,90,1,2,3,40,44,50,51,91,68,70,81,35,58,59,56,57,98");
  for (const t of P.tasks) {
    if (t.isNull) continue;
    const pr = (t.preds || []).map(p => { const x = P.tasks.find(y => y.uid === p.u); if (!x) return null; const lag = p.pc != null ? `${p.pc}%` : p.lag ? du(Math.abs(p.lag), p.lu || "d") : ""; return `${x.id}${p.t !== 1 || lag ? ["FF", "FS", "SF", "SS"][p.t ?? 1] : ""}${lag ? (p.lag < 0 || p.pc < 0 ? "-" : "+") + lag.replace("-", "") : ""}`; }).filter(Boolean).join(",");
    const b = t.bl?.[0];
    L.push(`70,${t.id},${q(t.name)},${q(t.wbs || t.on)},${t.lvl},${du(t.dur, t.du)}${t.est ? "?" : ""},${t.pct || 0}%,${D(t.start)},${D(t.finish)},${MPX_CT[t.ct || 0]},${t.ct > 1 ? D(t.cd) : ""},${q(pr)},${isMilestone(t) ? "Yes" : "No"},${t.fc || 0},${D(t.as)},${D(t.af)},${b ? D(b.start) : ""},${b ? D(b.finish) : ""},${t.uid}`);
    if (t.notes) L.push(`71,${q(t.notes.replace(/\r?\n/g, "\x7f"))}`);
    for (const a of P.assignments.filter(x => x.task === t.uid)) { const r = P.resources.find(x => x.uid === a.res); if (r) L.push(`75,${r._id},${a.units ?? 1},${du(a.w ?? (a.units ?? 1) * t.dur, "h")},0h,0h,0h,0,0,0,${D(t.start)},${D(t.finish)},0d,${r.uid}`); }
  }
  for (const r of P.resources) delete r._id;
  return L.join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------ Primavera P6 (.xer)
export function readXer(src) {
  const tables = {};
  let cur = null;
  for (const line of src.split(/\r?\n/)) {
    if (line.startsWith("%T\t")) { cur = { f: [], rows: [] }; tables[line.slice(3).trim()] = cur; }
    else if (line.startsWith("%F\t") && cur) cur.f = line.slice(3).split("\t");
    else if (line.startsWith("%R\t") && cur) { const v = line.slice(3).split("\t"); const o = {}; cur.f.forEach((k, i) => (o[k] = v[i] ?? "")); cur.rows.push(o); }
  }
  const rows = n => tables[n]?.rows || [];
  const proj = rows("PROJECT").find(p => p.project_flag !== "N") || rows("PROJECT")[0];
  if (!proj) throw new Error("XER");
  const pid = proj.proj_id;
  const P = newProject();
  P.name = proj.proj_short_name || ""; P.x = { fmt: "xer" };
  const dd = s => parseDate(s);
  P.start = dd(proj.plan_start_date) ?? dd(proj.last_recalc_date) ?? P.start;
  // calendari
  P.calendars = [];
  const calMap = new Map();
  for (const c of rows("CALENDAR")) {
    const cal = parseXerCalendar(c.clndr_data || "", P.calendars.length + 1, c.clndr_name || "");
    calMap.set(c.clndr_id, cal.uid);
    P.calendars.push(cal);
    if (c.default_flag === "Y" && !P._cal) { P._cal = cal.uid; const h = num(c.day_hr_cnt, 8); P.mpd = Math.round(h * 60); P.mpw = Math.round(num(c.week_hr_cnt, h * 5) * 60); }
  }
  if (!P.calendars.length) P.calendars.push(newCalendar(1, "Standard"));
  P.cal = calMap.get(proj.clndr_id) ?? P._cal ?? P.calendars[0].uid; delete P._cal;
  // WBS -> attivita' di riepilogo
  const wbs = rows("PROJWBS").filter(w => w.proj_id === pid);
  const wbsKids = new Map();
  let root = null;
  for (const w of wbs) { if (w.proj_node_flag === "Y") root = w.wbs_id; (wbsKids.get(w.parent_wbs_id) || wbsKids.set(w.parent_wbs_id, []).get(w.parent_wbs_id)).push(w); }
  const tasksBy = new Map();
  for (const t of rows("TASK").filter(t => t.proj_id === pid)) (tasksBy.get(t.wbs_id) || tasksBy.set(t.wbs_id, []).get(t.wbs_id)).push(t);
  let uid = 1;
  const taskUid = new Map();
  const addTask = (t, lvl) => {
    const hrs = num(t.target_drtn_hr_cnt);
    const ms = t.task_type === "TT_Mile" || t.task_type === "TT_FinMile";
    const x = { uid: uid++, name: t.task_name || "", lvl, dur: ms ? 0 : Math.round(hrs * 60), du: "d", est: false, ms, manual: false, start: dd(t.target_start_date), finish: dd(t.target_end_date),
      ct: { CS_MSO: 2, CS_MEO: 3, CS_MSOA: 4, CS_MSOB: 5, CS_MEOA: 6, CS_MEOB: 7, CS_ALAP: 1 }[t.cstr_type] || 0, cd: dd(t.cstr_date), pct: num(t.phys_complete_pct), notes: "", preds: [], bl: [], act: true, pri: 500, fc: 0,
      wbs: t.task_code || "", as: dd(t.act_start_date), af: dd(t.act_end_date), cal: calMap.get(t.clndr_id) ?? null };
    if (x.ct < 2) x.cd = null;
    if (t.complete_pct_type === "CP_Drtn" && hrs > 0) x.pct = Math.round(100 * (1 - num(t.remain_drtn_hr_cnt) / hrs));
    if (t.status_code === "TK_Complete") x.pct = 100;
    taskUid.set(t.task_id, x.uid);
    P.tasks.push(x);
  };
  const walk = (w, lvl) => {
    const kidsW = (wbsKids.get(w.wbs_id) || []).sort((a, b) => num(a.seq_num) - num(b.seq_num));
    const ts = (tasksBy.get(w.wbs_id) || []).sort((a, b) => (a.task_code > b.task_code ? 1 : -1));
    if (!kidsW.length && !ts.length) return;
    P.tasks.push({ uid: uid++, name: w.wbs_name || w.wbs_short_name || "", lvl, dur: 0, du: "d", preds: [], bl: [], pct: 0, ct: 0, act: true, pri: 500, fc: 0, notes: "", wbs: w.wbs_short_name || "" });
    for (const k of kidsW) walk(k, lvl + 1);
    for (const t of ts) addTask(t, lvl + 1);
  };
  for (const t of (tasksBy.get(root) || [])) addTask(t, 1);
  for (const w of (wbsKids.get(root) || []).sort((a, b) => num(a.seq_num) - num(b.seq_num))) walk(w, 1);
  if (!root) for (const [, ts] of tasksBy) for (const t of ts) if (!taskUid.has(t.task_id)) addTask(t, 1);
  const byU = new Map(P.tasks.map(t => [t.uid, t]));
  for (const r of rows("TASKPRED")) {
    const s = byU.get(taskUid.get(r.task_id)), p = taskUid.get(r.pred_task_id);
    if (!s || !p) continue;
    s.preds.push({ u: p, t: { PR_FF: 0, PR_FS: 1, PR_SF: 2, PR_SS: 3 }[r.pred_type] ?? 1, lag: Math.round(num(r.lag_hr_cnt) * 60), lu: "h" });
  }
  const resMap = new Map();
  for (const r of rows("RSRC")) { const x = { uid: P.resources.length + 1, name: r.rsrc_name || r.rsrc_short_name || "", type: r.rsrc_type === "RT_Mat" ? "material" : "work", ini: r.rsrc_short_name || "", max: 1, rate: 0, use: 0 }; resMap.set(r.rsrc_id, x.uid); P.resources.push(x); }
  for (const r of rows("RSRCRATE")) { const u = resMap.get(r.rsrc_id); const x = P.resources.find(y => y.uid === u); if (x && !x.rate) { x.rate = num(r.cost_per_qty); x.max = num(r.max_qty_per_hr, 1) || 1; } }
  for (const a of rows("TASKRSRC").filter(a => a.proj_id === pid)) {
    const t = taskUid.get(a.task_id), r = resMap.get(a.rsrc_id);
    if (t && r) P.assignments.push({ uid: P.assignments.length + 1, task: t, res: r, units: num(a.target_qty_per_hr, 1) || 1, w: Math.round(num(a.target_qty) * 60) || null });
  }
  return P;
}
// clndr_data: (0||DaysOfWeek()( (0||1()()) (0||2()( (0||0(s|08:00|f|12:00)()) ... ))) (0||Exceptions()( (0||0(d|41275)()) ...))
function parseXerCalendar(s, uid, name) {
  const cal = { uid, name, base: null, week: STD_WEEK(), exc: [] };
  const dow = s.match(/DaysOfWeek\(\)\(([\s\S]*?)\)\s*\)\s*\(0\|\|\d+\|?\|?(?:VIEW|Exceptions)/) || s.match(/DaysOfWeek\(\)\(([\s\S]*)\)\s*\)/);
  if (dow) {
    const parts = dow[1].split(/\(0\|\|([1-7])\(\)\(/).slice(1);
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const day = +parts[i] - 1, sh = [];
      for (const m of parts[i + 1].matchAll(/s\|(\d+:\d+)\|f\|(\d+:\d+)|f\|(\d+:\d+)\|s\|(\d+:\d+)/g)) { const a = timeMin(m[1] || m[4]); let b = timeMin(m[2] || m[3]); if (b <= a) b = 1440; sh.push([a, b]); }
      cal.week[day] = sh.sort((a, b) => a[0] - b[0]);
    }
  }
  const ex = s.match(/Exceptions\(\)\(([\s\S]*)/);
  if (ex) for (const m of ex[1].matchAll(/\(0\|\|\d+\(d\|(\d+)\)\(([^]*?)\)\)/g)) {
    const d = dayOf(fromParts(1899, 12, 30)) + +m[1], sh = [];
    for (const k of m[2].matchAll(/s\|(\d+:\d+)\|f\|(\d+:\d+)|f\|(\d+:\d+)\|s\|(\d+:\d+)/g)) sh.push([timeMin(k[1] || k[4]), timeMin(k[2] || k[3]) || 1440]);
    cal.exc.push({ from: d, to: d, name: "", work: sh });
  }
  return cal;
}

// ------------------------------------------------------------------ Primavera P6 XML
export function readP6Xml(src) {
  const doc = parseXml(src);
  const R = find(doc, "APIBusinessObjects");
  const pj = kid(R, "Project");
  if (!pj) throw new Error("P6");
  const P = newProject(parseDate(val(pj, "PlannedStartDate")) ?? parseDate(val(pj, "StartDate")));
  P.name = val(pj, "Name") || val(pj, "Id") || ""; P.x = { fmt: "p6xml" };
  P.calendars = [];
  const calMap = new Map();
  for (const c of [...kids(R, "Calendar"), ...kids(pj, "Calendar")]) {
    const cal = { uid: P.calendars.length + 1, name: val(c, "Name") || "", base: null, week: STD_WEEK(), exc: [] };
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (const d of kids(kid(c, "StandardWorkWeek"), "StandardWorkHours")) {
      const i = names.indexOf(val(d, "DayOfWeek"));
      if (i < 0) continue;
      cal.week[i] = kids(d, "WorkTime").map(w => [timeMin(val(w, "Start")), Math.min(1440, timeMin(val(w, "Finish")) + (/:59/.test(val(w, "Finish") || "") ? 1 : 0))]).filter(([a, b]) => b > a);
    }
    for (const h of kids(kid(c, "HolidayOrExceptions"), "HolidayOrException")) {
      const d = parseDate(val(h, "Date"));
      if (d == null) continue;
      cal.exc.push({ from: dayOf(d), to: dayOf(d), name: "", work: kids(h, "WorkTime").map(w => [timeMin(val(w, "Start")), Math.min(1440, timeMin(val(w, "Finish")) + 1)]).filter(([a, b]) => b > a + 1) });
    }
    calMap.set(val(c, "ObjectId"), cal.uid);
    P.calendars.push(cal);
    const hpd = num(val(c, "HoursPerDay"), 0); if (hpd && P.calendars.length === 1) P.mpd = Math.round(hpd * 60);
  }
  if (!P.calendars.length) P.calendars.push(newCalendar(1, "Standard"));
  P.cal = calMap.get(val(pj, "ActivityDefaultCalendarObjectId")) ?? P.calendars[0].uid;
  const wbs = kids(pj, "WBS");
  const wbsKids = new Map();
  for (const w of wbs) { const p = val(w, "ParentObjectId") || "root"; (wbsKids.get(p) || wbsKids.set(p, []).get(p)).push(w); }
  const wbsIds = new Set(wbs.map(w => val(w, "ObjectId")));
  const acts = new Map();
  for (const a of kids(pj, "Activity")) { const w = wbsIds.has(val(a, "WBSObjectId")) ? val(a, "WBSObjectId") : "root"; (acts.get(w) || acts.set(w, []).get(w)).push(a); }
  let uid = 1;
  const actUid = new Map();
  const addAct = (a, lvl) => {
    const type = val(a, "Type") || "";
    const ms = /Milestone/i.test(type);
    const t = { uid: uid++, name: val(a, "Name") || "", lvl, dur: ms ? 0 : Math.round(num(val(a, "PlannedDuration")) * 60), du: "d", est: false, ms, manual: false,
      start: parseDate(val(a, "StartDate")) ?? parseDate(val(a, "PlannedStartDate")), finish: parseDate(val(a, "FinishDate")) ?? parseDate(val(a, "PlannedFinishDate")),
      ct: { "Start On": 2, "Finish On": 3, "Start On or After": 4, "Start On or Before": 5, "Finish On or After": 6, "Finish On or Before": 7, "As Late As Possible": 1, "Mandatory Start": 2, "Mandatory Finish": 3 }[val(a, "PrimaryConstraintType")] || 0,
      cd: parseDate(val(a, "PrimaryConstraintDate")), pct: Math.round(num(val(a, "PercentComplete")) * (num(val(a, "PercentComplete")) <= 1 ? 100 : 1)), notes: "", preds: [], bl: [], act: true, pri: 500, fc: 0,
      wbs: val(a, "Id") || "", as: parseDate(val(a, "ActualStartDate")), af: parseDate(val(a, "ActualFinishDate")), cal: calMap.get(val(a, "CalendarObjectId")) ?? null };
    if (t.ct < 2) t.cd = null;
    actUid.set(val(a, "ObjectId"), t.uid);
    P.tasks.push(t);
  };
  const walk = (w, lvl) => {
    P.tasks.push({ uid: uid++, name: val(w, "Name") || "", lvl, dur: 0, du: "d", preds: [], bl: [], pct: 0, ct: 0, act: true, pri: 500, fc: 0, notes: "", wbs: val(w, "Code") || "" });
    for (const k of (wbsKids.get(val(w, "ObjectId")) || []).sort((a, b) => num(val(a, "SequenceNumber")) - num(val(b, "SequenceNumber")))) walk(k, lvl + 1);
    for (const a of acts.get(val(w, "ObjectId")) || []) addAct(a, lvl + 1);
  };
  for (const a of acts.get("root") || []) addAct(a, 1);
  const top = wbs.filter(w => !wbsIds.has(val(w, "ParentObjectId")));
  for (const w of top.sort((a, b) => num(val(a, "SequenceNumber")) - num(val(b, "SequenceNumber")))) walk(w, 1);
  const byU = new Map(P.tasks.map(t => [t.uid, t]));
  for (const r of [...kids(pj, "Relationship"), ...kids(R, "Relationship")]) {
    const s = byU.get(actUid.get(val(r, "SuccessorActivityObjectId"))), p = actUid.get(val(r, "PredecessorActivityObjectId"));
    if (s && p) s.preds.push({ u: p, t: { "Finish to Finish": 0, "Finish to Start": 1, "Start to Finish": 2, "Start to Start": 3 }[val(r, "Type")] ?? 1, lag: Math.round(num(val(r, "Lag")) * 60), lu: "h" });
  }
  const resMap = new Map();
  for (const r of kids(R, "Resource")) { const x = { uid: P.resources.length + 1, name: val(r, "Name") || "", type: /Material/i.test(val(r, "ResourceType") || "") ? "material" : "work", ini: val(r, "Id") || "", max: num(val(r, "MaxUnitsPerTime"), 1) || 1, rate: num(val(r, "PricePerUnit")), use: 0 }; resMap.set(val(r, "ObjectId"), x.uid); P.resources.push(x); }
  for (const a of [...kids(pj, "ResourceAssignment"), ...kids(R, "ResourceAssignment")]) {
    const t = actUid.get(val(a, "ActivityObjectId")), r = resMap.get(val(a, "ResourceObjectId"));
    if (t && r) P.assignments.push({ uid: P.assignments.length + 1, task: t, res: r, units: num(val(a, "PlannedUnitsPerTime"), 1) || 1, w: Math.round(num(val(a, "PlannedUnits")) * 60) || null });
  }
  return P;
}

// ------------------------------------------------------------------ GanttProject (.gan)
export function readGan(src) {
  const doc = parseXml(src);
  const R = kids(doc).find(n => local(n.n) === "project");
  if (!R) throw new Error("GAN");
  const P = newProject();
  P.name = R.a.name || ""; P.company = R.a.company || ""; P.x = { fmt: "gan", attrs: R.a };
  P.notes = val(R, "description") || "";
  // calendario: default-week con 1 = giorno libero, giorni festivi in <date>
  const cal = P.calendars[0];
  const dw = find(R, "default-week");
  if (dw) ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].forEach((k, i) => { cal.week[i] = dw.a[k] === "1" ? [] : [[480, 720], [780, 1020]]; });
  for (const d of kids(kid(R, "calendars"), "date")) {
    const y = +d.a.year || 0, m = +d.a.month, dd = +d.a.date;
    if (!m || !dd) continue;
    if (y) cal.exc.push({ from: dayOf(fromParts(y, m, dd)), to: dayOf(fromParts(y, m, dd)), name: text(d).trim(), work: d.a.type === "WORKING_DAY" ? [[480, 720], [780, 1020]] : [] });
    else for (let yy = 2000; yy <= 2050; yy++) cal.exc.push({ from: dayOf(fromParts(yy, m, dd)), to: dayOf(fromParts(yy, m, dd)), name: text(d).trim(), work: [] }); // ricorrente ogni anno
  }
  const idMap = new Map();
  let uid = 1;
  const deps = [];
  const walk = (n, lvl) => {
    for (const t of kids(n, "task")) {
      const ms = t.a.meeting === "true";
      const days = num(t.a.duration);
      const start = parseDate(t.a.start);
      const x = { uid: uid++, name: t.a.name || "", lvl, dur: ms ? 0 : Math.round(days * P.mpd), du: "d", est: false, ms, manual: false, start: start != null ? start + 480 : null,
        ct: 0, cd: null, pct: num(t.a.complete), notes: val(t, "notes") || "", preds: [], bl: [], act: true, pri: { 0: 300, 1: 500, 2: 700, 3: 100, 4: 900 }[t.a.priority] ?? 500, fc: num(t.a.cost), color: t.a.color || null, wbs: "", ganId: t.a.id };
      if (t.a.thirdDate && t.a["thirdDate-constraint"] === "1") { x.ct = 4; x.cd = parseDate(t.a.thirdDate) + 480; }
      idMap.set(t.a.id, x);
      P.tasks.push(x);
      for (const d of kids(t, "depend")) deps.push([x, d.a.id, num(d.a.type, 2), num(d.a.difference)]);
      walk(t, lvl + 1);
    }
  };
  walk(kid(R, "tasks"), 1);
  for (const [p, sid, ty, diff] of deps) {
    const s = idMap.get(sid);
    if (s) s.preds.push({ u: p.uid, t: { 1: 3, 2: 1, 3: 0, 4: 2 }[ty] ?? 1, lag: Math.round(diff * P.mpd), lu: "d" });
  }
  // prima data delle attivita' = inizio del progetto; le attivita' senza predecessori restano dove erano (vincolo SNET)
  const starts = P.tasks.map(t => t.start).filter(v => v != null);
  if (starts.length) P.start = Math.min(...starts);
  for (const t of P.tasks) if (!t.preds.length && t.start != null && t.start > P.start && t.ct === 0) { t.ct = 4; t.cd = t.start; }
  const resMap = new Map();
  for (const r of kids(kid(R, "resources"), "resource")) { const x = { uid: P.resources.length + 1, name: r.a.name || "", type: "work", ini: "", max: 1, rate: 0, use: 0, email: r.a.contacts || "" }; for (const p of kids(r, "rate")) if (p.a.name === "standard") x.rate = num(p.a.value); resMap.set(r.a.id, x.uid); P.resources.push(x); }
  for (const a of kids(kid(R, "allocations"), "allocation")) {
    const t = idMap.get(a.a["task-id"]), r = resMap.get(a.a["resource-id"]);
    if (t && r) P.assignments.push({ uid: P.assignments.length + 1, task: t.uid, res: r, units: num(a.a.load, 100) / 100, w: null });
  }
  for (const t of P.tasks) delete t.ganId;
  return P;
}
export function writeGan(P) {
  schedule(P);
  const d = t => toIso(t).slice(0, 10);
  const cal = P.calendars.find(c => c.uid === P.cal) || P.calendars[0];
  const wk = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((k, i) => `${k}="${cal.week[i]?.length ? 0 : 1}"`).join(" ");
  const out = [`<?xml version="1.0" encoding="UTF-8"?>`, `<project name="${escapeXml(P.name || "")}" company="${escapeXml(P.company || "")}" webLink="" view-date="${d(P.start)}" view-index="0" gantt-divider-location="400" resource-divider-location="300" version="3.2" locale="it">`,
    `<description>${escapeXml(P.notes || "")}</description>`, `<view zooming-state="default:3" id="gantt-chart"/><view id="resource-table"/>`,
    `<calendars><day-types><day-type id="0"/><day-type id="1"/><default-week id="1" name="default" ${wk}/><only-show-weekends value="false"/><overriden-day-types/><days/></day-types>`];
  for (const e of cal.exc) for (let dd = e.from; dd <= e.to; dd++) { const [y, m, g] = d(dd * DAY).split("-").map(Number); out.push(`<date year="${y}" month="${m}" date="${g}" type="${e.work.length ? "WORKING_DAY" : "HOLIDAY"}"><![CDATA[${e.name || ""}]]></date>`); }
  out.push(`</calendars>`, `<tasks empty-milestones="true"><taskproperties><taskproperty id="tpd0" name="type" type="default" valuetype="icon"/><taskproperty id="tpd1" name="priority" type="default" valuetype="icon"/><taskproperty id="tpd3" name="name" type="default" valuetype="text"/><taskproperty id="tpd4" name="begindate" type="default" valuetype="date"/><taskproperty id="tpd5" name="enddate" type="default" valuetype="date"/><taskproperty id="tpd6" name="duration" type="default" valuetype="int"/><taskproperty id="tpd7" name="completion" type="default" valuetype="int"/></taskproperties>`);
  const succ = new Map();
  for (const t of P.tasks) for (const L of t.preds || []) (succ.get(L.u) || succ.set(L.u, []).get(L.u)).push([t, L]);
  const C = P.calendars.find(c => c.uid === P.cal);
  const days = t => Math.max(isMilestone(t) ? 0 : 1, Math.round((t.dur || 0) / P.mpd));
  const rec = t => {
    const deps = (succ.get(t.uid) || []).map(([s, L]) => `<depend id="${s.id - 1}" type="${{ 3: 1, 1: 2, 0: 3, 2: 4 }[L.t ?? 1]}" difference="${Math.round((L.lag || 0) / P.mpd)}" hardness="Strong"/>`).join("");
    const k = t.kids.map(rec).join("");
    const pri = t.pri >= 900 ? 4 : t.pri >= 700 ? 2 : t.pri <= 100 ? 3 : t.pri <= 300 ? 0 : 1;
    return `<task id="${t.id - 1}" name="${escapeXml(t.name || "")}" color="${t.color || (t.sum ? "#000000" : "#8cb6ce")}" meeting="${isMilestone(t)}" start="${d(t.start)}" duration="${t.sum ? Math.max(1, Math.round(C ? (t.dur || 0) / P.mpd : 1)) : days(t)}" complete="${Math.round(t.pct || 0)}" priority="${pri}" expand="true"${t.fc ? ` cost-manual-value="${t.fc}" cost-calculated="false"` : ""}>${t.notes ? `<notes><![CDATA[${t.notes.replace(/]]>/g, "]]]]><![CDATA[>")}]]></notes>` : ""}${deps}${k}</task>`;
  };
  out.push(P.tasks.filter(t => !t.parent && !t.isNull).map(rec).join(""), `</tasks>`, `<resources>`);
  P.resources.forEach((r, i) => out.push(`<resource id="${i}" name="${escapeXml(r.name)}" function="Default:0" contacts="${escapeXml(r.email || "")}" phone="">${r.rate ? `<rate name="standard" value="${r.rate}"/>` : ""}</resource>`));
  out.push(`</resources>`, `<allocations>`);
  for (const a of P.assignments) { const t = P.tasks.find(x => x.uid === a.task), ri = P.resources.findIndex(x => x.uid === a.res); if (t && ri >= 0) out.push(`<allocation task-id="${t.id - 1}" resource-id="${ri}" function="Default:0" responsible="true" load="${((a.units ?? 1) * 100).toFixed(1)}"/>`); }
  out.push(`</allocations>`, `<vacations/>`, `<previous/>`, `<roles roleset-name="Default"/>`, `</project>`);
  return out.join("\n");
}

// ------------------------------------------------------------------ modello dal motore .mpp (Python)
export function fromEngine(J) {
  const P = newProject(parseDate(J.start));
  Object.assign(P, { name: J.name || "", title: J.title || "", author: J.author || "", company: J.company || "", manager: J.manager || "", mpd: J.mpd || 480, mpw: J.mpw || 2400, dpm: J.dpm || 20, currency: J.currency || "€", src: "mpp", x: { fmt: "mpp" } });
  if (J.calendars?.length) { P.calendars = J.calendars.map(c => ({ ...c, exc: (c.exc || []).map(e => ({ ...e, from: dayOf(parseDate(e.from)), to: dayOf(parseDate(e.to)) })) })); P.cal = J.cal ?? P.calendars[0].uid; }
  const D = v => parseDate(v);
  P.tasks = J.tasks.map(t => ({ ...t, start: D(t.start), finish: D(t.finish), cd: D(t.cd), dl: D(t.dl), as: D(t.as), af: D(t.af), bl: (t.bl || []).map(b => b && { ...b, start: D(b.start), finish: D(b.finish) }), preds: t.preds || [], act: t.act !== false, pri: t.pri ?? 500 }));
  P.resources = J.resources || [];
  P.assignments = J.assignments || [];
  // attivita' che Project ha messo in date diverse da quelle ricalcolate (programmate manualmente, interrotte, legate al
  // calendario delle risorse): restano dove le aveva Project, come attivita' manuali
  const saved = new Map(P.tasks.map(t => [t.uid, [t.start, t.finish]]));
  schedule(P);
  for (const t of P.tasks) {
    const [s, f] = saved.get(t.uid) || [];
    if (t.sum || t.isNull || s == null || f == null) continue;
    if (s !== t.start || f !== t.finish) { t.manual = true; t.start = s; t.finish = f; t.fromFile = true; }
  }
  return P;
}
// per il motore (scrittura .mpp con Project via automazione): si passa l'XML
export const toXml = writeMspdi;
export { CT };
