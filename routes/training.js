const express = require("express");
const { nanoid } = require("nanoid");
const { getSheets } = require("../googleSheetsClient");
const auth = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

// ============================================================
// TRAINING MODULE - GOOGLE SHEETS DATABASE
// Sheet 1: MasterTemplateData (A-H)
//   A Template ID | B Department | C Template Name/Index Name
//   D Template Document | E Template Video | F Template Score
//   G Template Approval | H Training Name (course name - auto)
// Sheet 2: AQData (A-H)
//   A Template ID | B QA ID | C Question Name | D Option A
//   E Option B | F Option C | G Option D | H Correct Option
// Sheet 3: EmployeeTrainingData (A-P)
//   A Employee Name | B Depatment | C Template Name | D Template ID
//   E Document Score | F Video Score | G QA Score | H Total Score
//   I Training Status Template | J Trainig Start Date | K Training End Date
//   L Last Update | M Tools Documents | N Tools translite | O Tools summary
//   P Progress Data (JSON - auto)
// ============================================================

const MT_SHEET = "MasterTemplateData";
const QA_SHEET = "AQData";
const ET_SHEET = "EmployeeTrainingData";

let headersEnsured = false;

const spreadsheetId = () => {
  const id = process.env.GOOGLE_SHEET_ID_TRAINING;
  if (!id) throw new Error("GOOGLE_SHEET_ID_TRAINING is not configured in .env");
  return id;
};

const nowStamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const dateDMY = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};

const parseNum = (v) => {
  const n = parseInt(v || "0", 10);
  return isNaN(n) ? 0 : n;
};

// Dept helpers (case-insensitive, trimmed)
const normDept = (d) => String(d || "").trim().toUpperCase();
const isCommonDept = (d) => normDept(d) === "COMMON" || normDept(d) === "COMMON ";
const sameDept = (a, b) => normDept(a) === normDept(b);

// 3-times SELF + 2-times WITH-DOER view protection:
// progress.views = { doc: {1:{self:0,withDoer:0,lastAt:0}}, video: {...} }
// Har view ke baad 15-min cooldown: next view tabhi jab last view se 15+ min ho gaye hon.
const REQUIRED_SELF_VIEWS = 3;
const REQUIRED_WITHDOER_VIEWS = 2;
const REQUIRED_VIEWS = REQUIRED_SELF_VIEWS + REQUIRED_WITHDOER_VIEWS; // 5
const VIEW_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
function blankViewSlot() { return { self: 0, withDoer: 0, lastAt: 0 }; }
function getViews(progress) {
  if (!progress.views || typeof progress.views !== "object") progress.views = { doc: {}, video: {} };
  if (!progress.views.doc || typeof progress.views.doc !== "object") progress.views.doc = {};
  if (!progress.views.video || typeof progress.views.video !== "object") progress.views.video = {};
  return progress.views;
}
function getViewSlot(progress, kind, index) {
  const views = getViews(progress);
  const k = kind === "doc" ? "doc" : "video";
  const key = String(index);
  const cur = views[k][key];
  // purana number format (e.g. 5) migrate karo → self/doer me split:
  // total>=5 → complete (3+2); 3-4 → self full + baaki doer; <3 → sab self
  if (typeof cur === "number") {
    const total = parseNum(cur);
    const self = Math.min(REQUIRED_SELF_VIEWS, total);
    const withDoer = Math.min(REQUIRED_WITHDOER_VIEWS, Math.max(0, total - self));
    views[k][key] = { self, withDoer, lastAt: 0 };
    return views[k][key];
  }
  if (!cur || typeof cur !== "object") { views[k][key] = blankViewSlot(); return views[k][key]; }
  return { self: parseNum(cur.self), withDoer: parseNum(cur.withDoer), lastAt: parseNum(cur.lastAt) };
}
function setViewSlot(progress, kind, index, slot) {
  const views = getViews(progress);
  views[kind === "doc" ? "doc" : "video"][String(index)] = slot;
}
const viewCount = (progress, kind, index) => {
  const s = getViewSlot(progress, kind, index);
  return { self: parseNum(s.self), withDoer: parseNum(s.withDoer), total: parseNum(s.self) + parseNum(s.withDoer), lastAt: parseNum(s.lastAt) };
};
const viewsComplete = (progress, kind, index) => {
  const c = viewCount(progress, kind, index);
  return c.self >= REQUIRED_SELF_VIEWS && c.withDoer >= REQUIRED_WITHDOER_VIEWS;
};
const cooldownLeftMs = (progress, kind, index, nowMs) => {
  const c = viewCount(progress, kind, index);
  if (!c.lastAt) return 0;
  const left = c.lastAt + VIEW_COOLDOWN_MS - nowMs;
  return left > 0 ? left : 0;
};
const fmtCooldown = (ms) => {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
};

// Auto add helper columns if missing (Training Name in H1, Progress Data in P1)
async function ensureHeaders() {
  if (headersEnsured) return;
  headersEnsured = true;
  const sheets = await getSheets();
  const sid = spreadsheetId();
  const checks = [
    { sheet: MT_SHEET, col: "H", header: "Training Name" },
    { sheet: ET_SHEET, col: "P", header: "Progress Data" },
  ];
  for (const c of checks) {
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: `${c.sheet}!${c.col}1` });
      const cell = (res.data.values || [[null]])[0][0];
      if (!cell) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: sid,
          range: `${c.sheet}!${c.col}1`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[c.header]] },
        });
      }
    } catch (err) {
      console.log(`[Training] Skipped header check ${c.sheet}!${c.col}1 : ${err.message}`);
    }
  }
}

// ============================================================
// SHEET READERS
// ============================================================
async function readMasterRows() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId(), range: `${MT_SHEET}!A2:I` });
  return res.data.values || [];
}

async function readQaRows() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId(), range: `${QA_SHEET}!A2:H` });
  return res.data.values || [];
}

async function readTrainingRows() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId(), range: `${ET_SHEET}!A2:R` });
  return res.data.values || [];
}

// ============================================================
// MAPPERS
// ============================================================
function mapTemplateRow(r) {
  return {
    TemplateId: r[0] || "",
    Department: r[1] || "",
    IndexName: r[2] || "",
    Document: r[3] || "",
    Video: r[4] || "",
    Score: r[5] || "",
    Approval: r[6] || "Pending",
    TrainingName: r[7] || "",
  };
}

function mapQaRow(r) {
  return {
    TemplateId: r[0] || "",
    QaId: r[1] || "",
    Question: r[2] || "",
    OptionA: r[3] || "",
    OptionB: r[4] || "",
    OptionC: r[5] || "",
    OptionD: r[6] || "",
    CorrectOption: r[7] || "",
  };
}

function mapTrainingRow(r) {
  let progress = {};
  try { progress = JSON.parse(r[15] || "{}"); } catch (e) { progress = {}; }
  if (!progress) progress = {};
  return {
    EmployeeName: r[0] || "",
    Department: r[1] || "",
    TemplateName: r[2] || "",
    TemplateId: r[3] || "",
    DocumentScore: parseNum(r[4]),
    VideoScore: parseNum(r[5]),
    QaScore: parseNum(r[6]),
    TotalScore: parseNum(r[7]),
    Status: r[8] || "Pending",
    StartDate: r[9] || "",
    EndDate: r[10] || "",
    LastUpdate: r[11] || "",
    ToolsDocuments: r[12] || "",
    ToolsTranslite: r[13] || "",
    ToolsSummary: r[14] || "",
    Progress: progress,
  };
}

// Group MasterTemplateData rows (indices) by Template ID
function groupTemplates(rows) {
  const map = new Map();
  for (const raw of rows) {
    // readMasterRows() returns RAW arrays (r[0], r[1]…) while groupTemplates expects mapped objects;
    // Normalize here so all call sites work regardless of input shape.
    const r = Array.isArray(raw) ? mapTemplateRow(raw) : raw;
    if (!r.TemplateId) continue;
    if (!map.has(r.TemplateId)) {
      map.set(r.TemplateId, {
        TemplateId: r.TemplateId,
        Department: r.Department,
        TemplateName: r.TrainingName || r.IndexName,
        TemplateScore: r.Score,
        Approval: r.Approval || "Pending",
        indices: [],
      });
    }
    const g = map.get(r.TemplateId);
    g.indices.push({ IndexName: r.IndexName, Document: r.Document, Video: r.Video });
    if (r.Department) g.Department = r.Department;
    if (r.Score && !g.TemplateScore) g.TemplateScore = r.Score;
  }
  return Array.from(map.values());
}

function filterExistingIndexes(list, totalIndices) {
  const valid = new Set();
  for (let i = 1; i <= totalIndices; i++) valid.add(String(i));
  return (list || []).filter((x) => valid.has(String(x)));
}

// ============================================================
// ASSIGNED-LEARNING CORE — source of truth = TEMPLATES
// Har employee ko assigned = ALL approved COMMON templates + uske dept ke approved templates.
// Status per (employee × template): record nahi mila → "Pending" (not started).
// Yahi se assigned count, pending/inProgress/completed aur total score nikalta hai.
// ============================================================
async function readEmployeeMaster() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Employee!A2:E",
  });
  return (res.data.values || [])
    .filter((e) => e && e[1])
    .map((e) => ({ employeeID: e[0] || "", name: e[1] || "", department: e[4] || "" }));
}

const assignedTemplatesFor = (approved, empDept) => [
  ...approved.filter((t) => isCommonDept(t.Department)),
  ...approved.filter((t) => !isCommonDept(t.Department) && sameDept(t.Department, empDept)),
];

// Har employee × uska assigned template = 1 row (record ho ya na ho)
function buildAssignedView({ employees, approved, records }) {
  const recMap = new Map(records.map((r) => [`${r.EmployeeName}|||${r.TemplateId}`, r]));
  const rows = [];
  for (const emp of employees) {
    const assigned = assignedTemplatesFor(approved, emp.department);
    for (const t of assigned) {
      const rec = recMap.get(`${emp.name}|||${t.TemplateId}`);
      rows.push({
        EmployeeName: emp.name,
        Department: emp.department,
        TemplateId: t.TemplateId,
        TemplateName: t.TemplateName,
        TemplateDepartment: t.Department,
        Type: isCommonDept(t.Department) ? "Common" : "Dept",
        DocumentScore: rec ? rec.DocumentScore : 0,
        VideoScore: rec ? rec.VideoScore : 0,
        QaScore: rec ? rec.QaScore : 0,
        TotalScore: rec ? rec.TotalScore : 0,
        Status: rec ? rec.Status : "Pending",
        Started: !!rec,
        StartDate: rec ? rec.StartDate : "",
        EndDate: rec ? rec.EndDate : "",
        LastUpdate: rec ? rec.LastUpdate : "",
      });
    }
  }
  return rows;
}

// assigned rows se buckets: pending = assigned − completed − inProgress (never-started included)
function summarizeAssigned(rows) {
  const mk = (arr) => {
    const assigned = arr.length;
    const completed = arr.filter((r) => r.Status === "Completed").length;
    const inProgress = arr.filter((r) => r.Status === "In Progress").length;
    const pending = Math.max(0, assigned - completed - inProgress);
    const totalEarned = arr.reduce((s, r) => s + parseNum(r.TotalScore), 0);
    return {
      assigned, started: arr.filter((r) => r.Started).length,
      completed, inProgress, pending,
      totalMax: assigned * 300, totalEarned,
    };
  };
  const common = mk(rows.filter((r) => r.Type === "Common"));
  const dept = mk(rows.filter((r) => r.Type !== "Common"));
  const total = {
    assigned: common.assigned + dept.assigned,
    started: common.started + dept.started,
    completed: common.completed + dept.completed,
    inProgress: common.inProgress + dept.inProgress,
    pending: common.pending + dept.pending,
    totalMax: common.totalMax + dept.totalMax,
    totalEarned: common.totalEarned + dept.totalEarned,
  };
  return { common, dept, total };
}

// scope filter: "all" | "common" | <template dept name>
function applyScope(rows, scope) {
  if (!scope || scope === "all") return rows;
  if (String(scope).toLowerCase() === "common") return rows.filter((r) => r.Type === "Common");
  return rows.filter((r) => r.Type !== "Common" && sameDept(r.TemplateDepartment, scope));
}

// ============================================================
// GET ROUTES
// ============================================================

// All templates grouped (admin) - optional ?department= & ?approval= filter
router.get("/templates", auth, asyncHandler(async (req, res) => {
  const { department, approval } = req.query;
  const rows = await readMasterRows();
  const qaRows = await readQaRows();
  let templates = groupTemplates(rows);
  if (department && department !== "all") templates = templates.filter((t) => t.Department === department);
  if (approval && approval !== "all") templates = templates.filter((t) => t.Approval === approval);
  for (const t of templates) t.QuestionCount = qaRows.filter((q) => q[0] === t.TemplateId).length;
  res.json({ ok: true, templates, total: templates.length });
}));

// Approved templates - available for DOER panel
router.get("/templates/approved", auth, asyncHandler(async (req, res) => {
  const rows = await readMasterRows();
  const qaRows = await readQaRows();
  let templates = groupTemplates(rows).filter((t) => t.Approval === "Approved");
  
  // Filter by department if provided (for DOER panel: Common + user's department)
  const { department } = req.query;
  if (department && department !== "all") {
    templates = templates.filter(t => t.Department === "Common" || t.Department === department);
  }
  
  // Sort: Common templates first, then department templates
  templates.sort((a, b) => {
    if (a.Department === "Common" && b.Department !== "Common") return -1;
    if (a.Department !== "Common" && b.Department === "Common") return 1;
    return 0;
  });
  
  for (const t of templates) t.QuestionCount = qaRows.filter((q) => q[0] === t.TemplateId).length;
  res.json({ ok: true, templates, total: templates.length });
}));

// Unique departments present in MasterTemplateData
router.get("/templates/departments", auth, asyncHandler(async (req, res) => {
  const rows = await readMasterRows();
  const depts = [...new Set(rows.map((r) => (r[1] || "").trim()).filter(Boolean))].sort();
  res.json({ ok: true, departments: depts });
}));

// Questions of a template. ?forTest=1 omits CorrectOption (for DOER test)
router.get("/qa/:templateId", auth, asyncHandler(async (req, res) => {
  const rows = await readQaRows();
  const forTest = req.query.forTest === "1";
  const questions = rows.filter((r) => r[0] === req.params.templateId).map(mapQaRow);
  if (forTest) {
    for (const q of questions) q.CorrectOption = "";
  }
  res.json({ ok: true, questions, total: questions.length });
}));

// All employee training records - admin performance review.
// MASTER SOURCE = templates: har assigned (employee × template) row milti hai,
// record na ho to Status="Pending", Started=false.
// Query: ?employeeName= (name|all) & ?status= (all|Pending|In Progress|Completed)
//        & ?scope= (all|common|<template-dept>) — Common/Dept filter
// Response: { records (assigned rows, filtered), summary (scoped assigned summary) }
router.get("/records", auth, asyncHandler(async (req, res) => {
  const { employeeName, status, scope } = req.query;
  const [masterRows, employees, trainingRows] = await Promise.all([
    readMasterRows(), readEmployeeMaster(), readTrainingRows(),
  ]);
  const approved = groupTemplates(masterRows).filter((t) => t.Approval === "Approved");
  let emps = employees;
  if (employeeName && employeeName !== "all") emps = emps.filter((e) => e.name === employeeName);
  const assigned = buildAssignedView({ employees: emps, approved, records: trainingRows.map(mapTrainingRow) });
  const scoped = applyScope(assigned, scope);
  const summary = summarizeAssigned(scoped);
  let rows = scoped.map((r) => ({ ...r }));
  if (status && status !== "all") rows = rows.filter((r) => r.Status === status);
  rows.sort((a, b) => (b.LastUpdate || "").localeCompare(a.LastUpdate || ""));
  res.json({ ok: true, records: rows, total: rows.length, summary });
}));

// DOER - meri assigned learnings (master source = templates).
// Har assigned (common + mere dept) template ki row: record na ho → Pending/not-started.
// Response: { records: assigned rows, summary: {common, dept, total} }
router.get("/my", auth, asyncHandler(async (req, res) => {
  const [masterRows, trainingRows] = await Promise.all([readMasterRows(), readTrainingRows()]);
  const approved = groupTemplates(masterRows).filter((t) => t.Approval === "Approved");
  const userDept = req.user.department || "";
  const me = [{ name: req.user.name, department: userDept }];
  const assigned = buildAssignedView({ employees: me, approved, records: trainingRows.map(mapTrainingRow) });
  const summary = summarizeAssigned(assigned);
  const byId = new Map(assigned.map((r) => [r.TemplateId, r]));
  // progress/views purane record se (learn screen ke liye)
  const progressMap = new Map(trainingRows.map(mapTrainingRow).map((r) => [`${r.EmployeeName}|||${r.TemplateId}`, r.Progress]));
  const rows = assigned.map((r) => ({ ...r, Progress: progressMap.get(`${req.user.name}|||${r.TemplateId}`) || {} }));
  void byId;
  res.json({ ok: true, records: rows, total: rows.length, summary });
}));

// ============================================================
// POST ROUTES
// ============================================================

// ADMIN - Create new template (with indices + questions)
router.post("/templates", auth, asyncHandler(async (req, res) => {
  const { department, name, templateScore, indices, questions } = req.body;
  if (!department || !name) return res.status(400).json({ error: "Department and Template Name are required" });
  if (!indices || !indices.length) return res.status(400).json({ error: "At least one Index is required" });

  await ensureHeaders();
  const templateId = `TMP-${nanoid(8).toUpperCase()}`;
  const score = templateScore || 100;
  const sheets = await getSheets();
  const sid = spreadsheetId();

  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    await sheets.spreadsheets.values.append({
      spreadsheetId: sid,
      range: `${MT_SHEET}!A:H`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          templateId,
          department,
          (idx.name || "").trim() || `Index ${i + 1}`,
          idx.document || "",
          idx.video || "",
          score,
          "Pending",
          name,
        ]],
      },
    });
  }

  let createdQuestions = 0;
  if (questions && questions.length) {
    for (const q of questions) {
      if (!q.question || !q.correctOption) continue;
      const qaId = `QA-${nanoid(8).toUpperCase()}`;
      await sheets.spreadsheets.values.append({
        spreadsheetId: sid,
        range: `${QA_SHEET}!A:H`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[templateId, qaId, q.question, q.optionA || "", q.optionB || "", q.optionC || "", q.optionD || "", q.correctOption]],
        },
      });
      createdQuestions++;
    }
  }

  res.json({ ok: true, templateId, message: "Template saved (Pending approval)", questionsAdded: createdQuestions });
}));

// ADMIN - Add one more index to existing template
router.post("/indices", auth, asyncHandler(async (req, res) => {
  const { templateId, name, document, video } = req.body;
  if (!templateId || !name) return res.status(400).json({ error: "templateId and index name are required" });

  const rows = await readMasterRows();
  const template = groupTemplates(rows).find((t) => t.TemplateId === templateId);
  if (!template) return res.status(404).json({ error: "Template not found" });

  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${MT_SHEET}!A:H`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        templateId,
        template.Department,
        name.trim(),
        document || "",
        video || "",
        template.TemplateScore || 100,
        template.Approval || "Pending",
        template.TemplateName,
      ]],
    },
  });
  res.json({ ok: true, message: "Index added" });
}));

// ADMIN - Add a question to a template (QA ID auto generated)
router.post("/qa", auth, asyncHandler(async (req, res) => {
  const { templateId, question, optionA, optionB, optionC, optionD, correctOption } = req.body;
  if (!templateId || !question || !correctOption) {
    return res.status(400).json({ error: "templateId, question and correctOption are required" });
  }
  const qaId = `QA-${nanoid(8).toUpperCase()}`;
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${QA_SHEET}!A:H`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[templateId, qaId, question, optionA || "", optionB || "", optionC || "", optionD || "", correctOption]] },
  });
  res.json({ ok: true, qaId, message: "Question added" });
}));

// DOER - Start training (creates record in EmployeeTrainingData)
router.post("/start", auth, asyncHandler(async (req, res) => {
  const { templateId } = req.body;
  if (!templateId) return res.status(400).json({ error: "templateId is required" });

  const rows = await readMasterRows();
  const template = groupTemplates(rows).find((t) => t.TemplateId === templateId);
  if (!template) return res.status(404).json({ error: "Template not found" });
  if (template.Approval !== "Approved") return res.status(403).json({ error: "Template is not approved yet" });

  const trainingRows = await readTrainingRows();
  const existingIdx = trainingRows.findIndex((r) => r[0] === req.user.name && r[3] === templateId);
  if (existingIdx !== -1) {
    return res.json({ ok: true, record: mapTrainingRow(trainingRows[existingIdx]), alreadyStarted: true });
  }

  const row = [
    req.user.name,
    req.user.department || "",
    template.TemplateName,
    templateId,
    0, 0, 0, 0,
    "In Progress",
    dateDMY(),
    "",
    nowStamp(),
    "",
    "",
    "",
    "{}",
  ];
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${ET_SHEET}!A:P`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
  res.json({ ok: true, record: mapTrainingRow(row), alreadyStarted: false });
}));

// ============================================================
// PUT ROUTES
// ============================================================

// ADMIN - Approve / Reject template (updates all index rows of that Template ID)
router.put("/templates/approve/:templateId", auth, asyncHandler(async (req, res) => {
  const { approval } = req.body;
  if (!approval || !["Approved", "Pending"].includes(approval)) {
    return res.status(400).json({ error: "approval must be Approved or Pending" });
  }
  const rows = await readMasterRows();
  const affected = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === req.params.templateId) {
      rows[i][6] = approval;
      affected.push(i);
    }
  }
  if (!affected.length) return res.status(404).json({ error: "Template not found" });

  const sheets = await getSheets();
  const sid = spreadsheetId();
  for (const i of affected) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sid,
      range: `${MT_SHEET}!A${i + 2}:G${i + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rows[i].slice(0, 7)] },
    });
  }
  res.json({ ok: true, message: `Template ${approval === "Approved" ? "Approved" : "Moved to Pending"}` });
}));

// ADMIN - Edit an index (indexNo is 1-based position within the template)
router.put("/indices/:templateId/:indexNo", auth, asyncHandler(async (req, res) => {
  const { templateId, indexNo } = req.params;
  const { name, document, video } = req.body;
  const rows = await readMasterRows();
  const templateRows = rows.map((r, i) => ({ i, r, m: mapTemplateRow(r) })).filter((x) => x.m.TemplateId === templateId);
  const target = templateRows[parseInt(indexNo, 10) - 1];
  if (!target) return res.status(404).json({ error: "Index not found" });

  const row = target.r;
  if (name) row[2] = name.trim();
  if (document !== undefined) row[3] = document || "";
  if (video !== undefined) row[4] = video || "";
  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${MT_SHEET}!A${target.i + 2}:G${target.i + 2}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row.slice(0, 7)] },
  });
  res.json({ ok: true, message: "Index updated" });
}));

// ADMIN - Edit a question
router.put("/qa/:qaId", auth, asyncHandler(async (req, res) => {
  const rows = await readQaRows();
  const idx = rows.findIndex((r) => r[1] === req.params.qaId);
  if (idx === -1) return res.status(404).json({ error: "Question not found" });

  const { question, optionA, optionB, optionC, optionD, correctOption } = req.body;
  const row = rows[idx];
  if (question !== undefined) row[2] = question;
  if (optionA !== undefined) row[3] = optionA;
  if (optionB !== undefined) row[4] = optionB;
  if (optionC !== undefined) row[5] = optionC;
  if (optionD !== undefined) row[6] = optionD;
  if (correctOption !== undefined) row[7] = correctOption;

  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${QA_SHEET}!A${idx + 2}:H${idx + 2}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
  res.json({ ok: true, message: "Question updated" });
}));

// ADMIN - assigned learning summary (Common + Dept) — same master source as /records.
// Query: ?employeeName= & ?scope= (all|common|<template-dept>)
// (Purana ?department= param bhi scope ki tarah support hai.)
router.get("/records/summary", auth, asyncHandler(async (req, res) => {
  const { employeeName, scope, department } = req.query;
  const activeScope = (() => {
    if (scope && scope !== "all") return scope;
    if (department && department !== "all") {
      if (String(department).toLowerCase() === "common") return "common";
      return department;
    }
    return "all";
  })();
  const [masterRows, employees, trainingRows] = await Promise.all([
    readMasterRows(), readEmployeeMaster(), readTrainingRows(),
  ]);
  const approved = groupTemplates(masterRows).filter((t) => t.Approval === "Approved");
  let emps = employees;
  if (employeeName && employeeName !== "all") emps = emps.filter((e) => e.name === employeeName);
  const assigned = buildAssignedView({ employees: emps, approved, records: trainingRows.map(mapTrainingRow) });
  const scoped = applyScope(assigned, activeScope);
  const summary = summarizeAssigned(scoped);
  const templateCounts = {
    common: approved.filter((t) => isCommonDept(t.Department)).length,
    dept: approved.filter((t) => !isCommonDept(t.Department)).length,
    total: approved.length,
  };
  res.json({ ok: true, summary: { ...summary, templateCounts, employeeCount: emps.length } });
}));

// DOER - Update training progress (complete doc/video of an index, save tools, submit QA)
router.put("/progress", auth, asyncHandler(async (req, res) => {
  const { templateId, docIndex, videoIndex, tools, qaAnswers, viewTick } = req.body;
  if (!templateId) return res.status(400).json({ error: "templateId is required" });

  const masterRows = await readMasterRows();
  const templates = groupTemplates(masterRows);
  const template = templates.find((t) => t.TemplateId === templateId);
  if (!template) return res.status(404).json({ error: "Template not found" });
  const totalIndices = template.indices.length || 1;

  const trainingRows = await readTrainingRows();
  const idx = trainingRows.findIndex((r) => r[0] === req.user.name && r[3] === templateId);
  if (idx === -1) return res.status(404).json({ error: "Training not started. Please start training first" });

  const record = mapTrainingRow(trainingRows[idx]);
  let progress = record.Progress && typeof record.Progress === "object" ? record.Progress : {};
  if (!Array.isArray(progress.docs)) progress.docs = [];
  if (!Array.isArray(progress.vids)) progress.vids = [];
  getViews(progress); // ensure views {doc:{},video:{}}

  // viewTick ONLY: sirf view count karo, save karke turant return (neeche scoring se pehle save hota hai)
  if (viewTick && (viewTick.kind === "doc" || viewTick.kind === "video") && viewTick.index) {
    const k = viewTick.kind === "doc" ? "doc" : "video";
    const key = String(viewTick.index);
    const mode = viewTick.mode === "withDoer" ? "withDoer" : "self";
    const nowMs = Date.now();
    const slot = getViewSlot(progress, k, key);
    const left = cooldownLeftMs(progress, k, key, nowMs);
    if (left > 0) {
      return res.status(429).json({
        error: `You just counted a view. Please read/watch carefully — the next view button will enable after ${fmtCooldown(left)} (15-minute gap).`,
        views: progress.views, cooldownMs: left,
      });
    }
    if (mode === "self" && slot.self >= REQUIRED_SELF_VIEWS)
      return res.status(400).json({ error: `Self views complete (3/3). Now 2 views WITH your doer are required.`, views: progress.views });
    if (mode === "withDoer" && slot.withDoer >= REQUIRED_WITHDOER_VIEWS)
      return res.status(400).json({ error: `With-doer views complete (2/2).`, views: progress.views });
    slot[mode] = parseNum(slot[mode]) + 1;
    slot.lastAt = nowMs;
    setViewSlot(progress, k, key, slot);
    // viewTick ke saath doc/video/qa same request me na ho — turant save + return
    const docs = filterExistingIndexes(progress.docs, totalIndices);
    const vids = filterExistingIndexes(progress.vids, totalIndices);
    const qaRowsV = await readQaRows();
    const totalQaV = qaRowsV.filter((r) => r[0] === templateId).length;
    const qaDoneV = !!(progress.qa && progress.qa.attempted);
    const docScoreV = totalIndices ? Math.round((docs.length / totalIndices) * 100) : 0;
    const vidScoreV = totalIndices ? Math.round((vids.length / totalIndices) * 100) : 0;
    const qaScoreV = totalQaV && qaDoneV ? Math.round(((progress.qa.correct || 0) / totalQaV) * 100) : 0;
    const totalScoreV = docScoreV + vidScoreV + qaScoreV;
    const allDoneV = docs.length >= totalIndices && vids.length >= totalIndices && qaDoneV;
    const statusV = allDoneV ? "Completed" : "In Progress";
    const rowV = trainingRows[idx];
    rowV[4] = docScoreV; rowV[5] = vidScoreV; rowV[6] = qaScoreV; rowV[7] = totalScoreV; rowV[8] = statusV;
    if (!rowV[9]) rowV[9] = dateDMY();
    if (allDoneV && !rowV[10]) rowV[10] = dateDMY();
    rowV[11] = nowStamp();
    rowV[12] = record.ToolsDocuments; rowV[13] = record.ToolsTranslite; rowV[14] = record.ToolsSummary;
    rowV[15] = JSON.stringify(progress);
    const sheetsV = await getSheets();
    await sheetsV.spreadsheets.values.update({
      spreadsheetId: spreadsheetId(),
      range: `${ET_SHEET}!A${idx + 2}:P${idx + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowV] },
    });
    return res.json({ ok: true, record: mapTrainingRow(rowV), completed: allDoneV });
  }

  // --- Step-by-step protection: index N complete tabhi jab N-1 ke doc+video done
  const docsSet = new Set(progress.docs.map(String));
  const vidsSet = new Set(progress.vids.map(String));
  const indexComplete = (n) => docsSet.has(String(n)) && vidsSet.has(String(n));
  const prevComplete = (n) => {
    const x = parseInt(n, 10);
    if (x <= 1) return true;
    for (let i = 1; i < x; i++) if (!indexComplete(i)) return false;
    return true;
  };

  if (docIndex) {
    const d = String(docIndex);
    if (parseInt(d, 10) > totalIndices || parseInt(d, 10) < 1)
      return res.status(400).json({ error: "Invalid doc index" });
    if (!prevComplete(d))
      return res.status(400).json({ error: `Pehle Index ${parseInt(d, 10) - 1} complete karein (Document + Video)` });
    if (!viewsComplete(progress, "doc", d)) {
      const c = viewCount(progress, "doc", d);
      return res.status(400).json({ error: `Document needs 3 self reads + 2 with-doer reads (self ${c.self}/3, with doer ${c.withDoer}/2). Then Mark as Read works.`, views: progress.views });
    }
    if (!progress.docs.includes(d)) progress.docs.push(d);
  }
  if (videoIndex) {
    const v = String(videoIndex);
    if (parseInt(v, 10) > totalIndices || parseInt(v, 10) < 1)
      return res.status(400).json({ error: "Invalid video index" });
    if (!progress.docs.includes(v) && String(docIndex) !== v)
      return res.status(400).json({ error: "Pehle isi Index ka Document complete karein, phir Video" });
    if (!prevComplete(v))
      return res.status(400).json({ error: `Pehle Index ${parseInt(v, 10) - 1} complete karein (Document + Video)` });
    if (!viewsComplete(progress, "video", v)) {
      const c = viewCount(progress, "video", v);
      return res.status(400).json({ error: `Video needs 3 self views + 2 with-doer views (self ${c.self}/3, with doer ${c.withDoer}/2). Then Mark as Watched works.`, views: progress.views });
    }
    if (!progress.vids.includes(v)) progress.vids.push(v);
  }

  if (tools) {
    if (tools.documents !== undefined) record.ToolsDocuments = tools.documents;
    if (tools.translite !== undefined) record.ToolsTranslite = tools.translite;
    if (tools.summary !== undefined) record.ToolsSummary = tools.summary;
  }

  // QA test scoring (server side, correct answers never stored on client)
  if (qaAnswers && typeof qaAnswers === "object") {
    const qaRows = await readQaRows();
    const questions = qaRows.filter((r) => r[0] === templateId).map(mapQaRow);
    let correct = 0;
    for (const q of questions) {
      if (qaAnswers[q.QaId] && qaAnswers[q.QaId] === q.CorrectOption) correct++;
    }
    progress.qa = { attempted: true, correct, total: questions.length };
  }

  // Recompute scores
  const docs = filterExistingIndexes(progress.docs, totalIndices);
  const vids = filterExistingIndexes(progress.vids, totalIndices);
  progress.docs = docs;
  progress.vids = vids;

  const docScore = totalIndices ? Math.round((docs.length / totalIndices) * 100) : 0;
  const vidScore = totalIndices ? Math.round((vids.length / totalIndices) * 100) : 0;
  const qaTotal = progress.qa ? parseNum(progress.qa.total) : 0;
  const qaDone = qaTotal > 0 ? progress.qa.attempted === true : true;
  const qaScore = qaTotal > 0 ? Math.round((parseNum(progress.qa.correct) / qaTotal) * 100) : 0;
  const totalScore = docScore + vidScore + qaScore;
  const allDone = docs.length >= totalIndices && vids.length >= totalIndices && qaDone;
  const status = allDone ? "Completed" : "In Progress";

  const row = trainingRows[idx];
  row[4] = docScore;
  row[5] = vidScore;
  row[6] = qaScore;
  row[7] = totalScore;
  row[8] = status;
  if (!row[9]) row[9] = dateDMY();
  if (allDone && !row[10]) row[10] = dateDMY();
  row[11] = nowStamp();
  row[12] = record.ToolsDocuments;
  row[13] = record.ToolsTranslite;
  row[14] = record.ToolsSummary;
  row[15] = JSON.stringify(progress);

  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${ET_SHEET}!A${idx + 2}:P${idx + 2}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });

  res.json({ ok: true, record: mapTrainingRow(row), completed: allDone });
}));

// ============================================================
// DELETE ROUTES
// ============================================================

// ADMIN - Delete template (all its indices + questions)
router.delete("/templates/:templateId", auth, asyncHandler(async (req, res) => {
  const templateId = req.params.templateId;
  const sheets = await getSheets();
  const sid = spreadsheetId();

  const masterRows = await readMasterRows();
  const idxToClear = masterRows.map((r, i) => ({ i, r })).filter((x) => x.r[0] === templateId);
  for (let k = idxToClear.length - 1; k >= 0; k--) {
    await sheets.spreadsheets.values.clear({ spreadsheetId: sid, range: `${MT_SHEET}!A${idxToClear[k].i + 2}:H${idxToClear[k].i + 2}` });
  }

  const qaRows = await readQaRows();
  const qaToClear = qaRows.map((r, i) => ({ i, r })).filter((x) => x.r[0] === templateId);
  for (let k = qaToClear.length - 1; k >= 0; k--) {
    await sheets.spreadsheets.values.clear({ spreadsheetId: sid, range: `${QA_SHEET}!A${qaToClear[k].i + 2}:H${qaToClear[k].i + 2}` });
  }

  res.json({ ok: true, message: "Template deleted" });
}));

// ADMIN - Delete an index (indexNo is 1-based position within the template; last index cannot be removed)
router.delete("/indices/:templateId/:indexNo", auth, asyncHandler(async (req, res) => {
  const { templateId, indexNo } = req.params;
  const rows = await readMasterRows();
  const templateRows = rows.map((r, i) => ({ i, r, m: mapTemplateRow(r) })).filter((x) => x.m.TemplateId === templateId);
  if (templateRows.length <= 1) return res.status(400).json({ error: "A template must have at least one index" });
  const target = templateRows[parseInt(indexNo, 10) - 1];
  if (!target) return res.status(404).json({ error: "Index not found" });

  const sheets = await getSheets();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: spreadsheetId(),
    range: `${MT_SHEET}!A${target.i + 2}:H${target.i + 2}`,
  });
  res.json({ ok: true, message: "Index deleted" });
}));

// ADMIN - Delete a question
router.delete("/qa/:qaId", auth, asyncHandler(async (req, res) => {
  const rows = await readQaRows();
  const idx = rows.findIndex((r) => r[1] === req.params.qaId);
  if (idx === -1) return res.status(404).json({ error: "Question not found" });

  const sheets = await getSheets();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: spreadsheetId(),
    range: `${QA_SHEET}!A${idx + 2}:H${idx + 2}`,
  });
  res.json({ ok: true, message: "Question deleted" });
}));

module.exports = router;