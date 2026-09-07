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

// All employee training records - admin performance review. Optional ?employeeName= & ?status=
router.get("/records", auth, asyncHandler(async (req, res) => {
  const { employeeName, status } = req.query;
  let records = (await readTrainingRows()).map(mapTrainingRow);
  if (employeeName && employeeName !== "all") records = records.filter((r) => r.EmployeeName === employeeName);
  if (status && status !== "all") records = records.filter((r) => r.Status === status);
  records.sort((a, b) => (b.LastUpdate || "").localeCompare(a.LastUpdate || ""));
  res.json({ ok: true, records, total: records.length });
}));

// DOER - my training records
router.get("/my", auth, asyncHandler(async (req, res) => {
  const rows = await readTrainingRows();
  const mine = rows.filter((r) => r[0] === req.user.name).map(mapTrainingRow);
  res.json({ ok: true, records: mine, total: mine.length });
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

// DOER - Update training progress (complete doc/video of an index, save tools, submit QA)
router.put("/progress", auth, asyncHandler(async (req, res) => {
  const { templateId, docIndex, videoIndex, tools, qaAnswers } = req.body;
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

  if (docIndex) {
    const d = String(docIndex);
    if (!progress.docs.includes(d)) progress.docs.push(d);
  }
  if (videoIndex) {
    const v = String(videoIndex);
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