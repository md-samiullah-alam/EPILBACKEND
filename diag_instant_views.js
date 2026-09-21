// E2E instant-view test: cooldown hatane ke baad 4 views back-to-back (no 429) + cleanup.
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const fs = require("fs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const { getSheets } = require("./googleSheetsClient");

const BASE = process.env.DIAG_BASE || "http://localhost:5000/api";
const out = [];
const pass = [];
const fail = [];
const ck = (name, ok, detail) => { (ok ? pass : fail).push(name); out.push(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`); };
const adminToken = () => jwt.sign({ id: "e2e-admin", name: "E2E Admin", department: "MIS", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
const call = async (method, url, token, data) => {
  try {
    const r = await axios({ method, url, data, headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
    return { status: r.status, data: r.data };
  } catch (e) {
    return { status: e.response ? e.response.status : 0, data: e.response ? e.response.data : { error: e.message } };
  }
};
(async () => {
  const A = adminToken();
  let emp = null, tpl = null;
  try {
    const emps = await call("get", `${BASE}/employee/all`, A);
    const crmEmps = (Array.isArray(emps.data) ? emps.data : []).filter((e) => String(e.Designation || "").trim().toUpperCase() === "CRM ALL");
    emp = crmEmps[0];
    const desigs = await call("get", `${BASE}/training/templates?designation=${encodeURIComponent("CRM ALL")}&approval=all`, A);
    tpl = (desigs.data.templates || [])[0];
    out.push(`EMP=${emp ? emp.name : "NONE"} TPL=${tpl ? tpl.TemplateId : "NONE"}`);
    if (!emp || !tpl) throw new Error("emp/template missing");
    const empTok = jwt.sign({ employeeID: emp.employeeID, name: emp.name, department: emp.department || "", designation: emp.designation || "" }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const ap = await call("put", `${BASE}/training/templates/approve/${tpl.TemplateId}`, A, { approval: "Approved" });
    out.push(`APPROVE=${ap.status} ${JSON.stringify(ap.data)}`);
    try {
      // START
      const st = await call("post", `${BASE}/training/start`, empTok, { templateId: tpl.TemplateId });
      out.push(`START=${st.status}`);
      // 4 views back-to-back: self x2 + withDoer x2 (pehle 2-min wait hota tha — ab instant)
      const seq = ["self", "self", "withDoer", "withDoer"];
      for (let i = 0; i < seq.length; i++) {
        const r = await call("put", `${BASE}/training/progress`, empTok, { templateId: tpl.TemplateId, viewTick: { kind: "doc", index: 1, mode: seq[i] } });
        const views = r.data.record && r.data.record.Progress && r.data.record.Progress.views;
        const slot = views && views.doc && views.doc["1"];
        ck(`view#${i + 1} (${seq[i]}) instant 200 (no 429)`, r.status === 200, `status=${r.status} slot=${JSON.stringify(slot)} err=${r.data.error || "-"}`);
      }
      // Mark as Read ab turant kaam karega
      const md = await call("put", `${BASE}/training/progress`, empTok, { templateId: tpl.TemplateId, docIndex: 1 });
      ck("markDoc works after 4 instant views", md.status === 200, `status=${md.status} docs=${JSON.stringify(md.data.record && md.data.record.Progress && md.data.record.Progress.docs)} err=${md.data.error || "-"}`);
    } finally {
      // REVERT template + DELETE test record row
      const rv = await call("put", `${BASE}/training/templates/approve/${tpl.TemplateId}`, A, { approval: "Pending" });
      out.push(`REVERT=${rv.status}`);
      try {
        const sheets = await getSheets();
        const sid = process.env.GOOGLE_SHEET_ID_TRAINING;
        const meta = await sheets.spreadsheets.get({ spreadsheetId: sid });
        const etSheet = (meta.data.sheets || []).find((s) => s.properties.title === "EmployeeTrainingData");
        const etSheetId = etSheet ? etSheet.properties.sheetId : null;
        if (etSheetId === null) throw new Error("EmployeeTrainingData sheet not found");
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: "EmployeeTrainingData!A2:P" });
        const rows = res.data.values || [];
        const rowIdx = rows.findIndex((r) => r[0] === emp.name && r[3] === tpl.TemplateId);
        if (rowIdx !== -1) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: sid,
            requestBody: { requests: [{ deleteDimension: { range: { sheetId: etSheetId, dimension: "ROWS", startIndex: rowIdx + 1, endIndex: rowIdx + 2 } } }] },
          });
          out.push(`CLEANUP row ${rowIdx + 2} deleted (sheetId=${etSheetId})`);
        } else out.push("CLEANUP row not found");
      } catch (ce) { out.push("CLEANUP_ERR=" + ce.message); }
    }
  } catch (e) {
    out.push("FATAL=" + (e && (e.stack || e.message)));
  }
  out.push("");
  out.push(`SUMMARY PASS=${pass.length} FAIL=${fail.length}`);
  if (fail.length) out.push("FAILED: " + fail.join(" | "));
  fs.writeFileSync("diag_instant_out.txt", out.join("\r\n"), "utf8");
  console.log("INSTANT E2E DONE");
  process.exit(0);
})();

