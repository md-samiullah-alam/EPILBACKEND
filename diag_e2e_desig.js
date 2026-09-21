// E2E (designation flow): approve CRM ALL template -> doer /my + admin /records verify -> wapas Pending.
require("dotenv").config();
const fs = require("fs");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const BASE = process.env.DIAG_BASE || "http://localhost:5000/api";
const out = [];
const pass = [];
const fail = [];
const ck = (name, ok, detail) => { (ok ? pass : fail).push(name); out.push(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`); };

const adminToken = () => jwt.sign(
  { id: "e2e-admin", name: "E2E Admin", department: "MIS", role: "admin" },
  process.env.JWT_SECRET, { expiresIn: "1h" }
);
const empToken = (e) => jwt.sign(
  { employeeID: e.employeeID, name: e.name, department: e.department || "", designation: e.designation || "" },
  process.env.JWT_SECRET, { expiresIn: "1h" }
);
const call = async (method, url, token, data) => {
  try {
    const r = await axios({ method, url, data, headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
    return r.data;
  } catch (e) {
    return { __err: e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message };
  }
};

(async () => {
  const A = adminToken();
  try {
    // 1) Employees + CRM ALL template
    const emps = await call("get", `${BASE}/employee/all`, A);
    const list = Array.isArray(emps) ? emps : [];
    const crmEmps = list.filter((e) => String(e.Designation || "").trim().toUpperCase() === "CRM ALL");
    out.push(`EMPLOYEES=${list.length} CRM_ALL_EMPS=${crmEmps.length}`);
    const emp = crmEmps[0];
    const desigs = await call("get", `${BASE}/training/templates?designation=${encodeURIComponent("CRM ALL")}&approval=all`, A);
    const tpl = (desigs.templates || [])[0];
    out.push(`TEMPLATE=${tpl ? tpl.TemplateId + " | " + (tpl.Designation || tpl.Department) + " | " + tpl.Approval : "NOT FOUND"}`);
    if (!emp || !tpl) throw new Error("emp/template missing");

    const otherDesig = "MIS";
    const otherEmp = list.find((e) => String(e.Designation || "").trim().toUpperCase() === otherDesig);

    // 2) APPROVE (live) — finally me revert hoga
    const ap = await call("put", `${BASE}/training/templates/approve/${tpl.TemplateId}`, A, { approval: "Approved" });
    out.push(`APPROVE=${JSON.stringify(ap)}`);
    try {
      // 3) Doer panel: CRM ALL employee ko template dikhna chahiye
      const forCrm = await call("get", `${BASE}/training/templates/approved?designation=${encodeURIComponent("CRM ALL")}`, A);
      const gotCrm = (forCrm.templates || []).some((t) => t.TemplateId === tpl.TemplateId);
      ck("doer-approved-list CRM ALL ko template dikhe", gotCrm, `templates=${(forCrm.templates || []).length}`);

      // 4) Doosri designation (MIS) ko LEAK nahi hona chahiye (sirf Common)
      if (otherEmp) {
        const forOther = await call("get", `${BASE}/training/templates/approved?designation=${encodeURIComponent(otherDesig)}`, A);
        const leaked = (forOther.templates || []).some((t) => t.TemplateId === tpl.TemplateId);
        ck(`doer-approved-list ${otherDesig} ko LEAK nahi`, !leaked, `ids=${(forOther.templates || []).map((t) => t.TemplateId).join(",") || "-"}`);
        const myOther = await call("get", `${BASE}/training/my`, empToken(otherEmp));
        const leakedMy = (myOther.records || []).some((r) => r.TemplateId === tpl.TemplateId);
        ck(`/my ${otherDesig} employee ko LEAK nahi`, !leakedMy, `rows=${(myOther.records || []).length}`);
      }

      // 5) Doer /my — employee ki assigned learning
      const my = await call("get", `${BASE}/training/my`, empToken(emp));
      const mine = (my.records || []).find((r) => r.TemplateId === tpl.TemplateId);
      ck("/my CRM ALL employee ko assigned dikhe", !!mine, mine ? `Type=${mine.Type} Status=${mine.Status} TplDesig=${mine.TemplateDesignation || mine.TemplateDepartment}` : "missing");
      ck("/my summary designation bucket>0", !!(my.summary && my.summary.dept && my.summary.dept.assigned > 0), JSON.stringify(my.summary && my.summary.dept));

      // 6) Admin records — scope=CRM ALL
      const rec = await call("get", `${BASE}/training/records?employeeName=all&scope=${encodeURIComponent("CRM ALL")}&status=all`, A);
      const rows = rec.records || [];
      ck("admin /records scope=CRM ALL rows>0", rows.length > 0, `rows=${rows.length}`);
      const bad = rows.filter((r) => String(r.TemplateDesignation || r.TemplateDepartment || "").toUpperCase() !== "CRM ALL");
      ck("admin /records rows sab CRM ALL designation ke", bad.length === 0, `mismatch=${bad.length}`);
      const empRow = rows.find((r) => r.EmployeeName === emp.name);
      ck("admin /records me CRM ALL employee ki row", !!empRow, empRow ? `Status=${empRow.Status} Started=${empRow.Started}` : "missing");

      // 7) Employee-specific filter
      const recEmp = await call("get", `${BASE}/training/records?employeeName=${encodeURIComponent(emp.name)}&scope=all&status=all`, A);
      const empRows = recEmp.records || [];
      ck("admin /records employeeName filter", empRows.length > 0 && empRows.every((r) => r.EmployeeName === emp.name), `rows=${empRows.length}`);
    } finally {
      // REVERT → Pending
      const rv = await call("put", `${BASE}/training/templates/approve/${tpl.TemplateId}`, A, { approval: "Pending" });
      out.push(`REVERT=${JSON.stringify(rv)}`);
    }
    const after = await call("get", `${BASE}/training/templates?designation=${encodeURIComponent("CRM ALL")}&approval=all`, A);
    const t2 = (after.templates || []).find((t) => t.TemplateId === tpl.TemplateId);
    ck("revert → template Pending wapas", !!(t2 && t2.Approval === "Pending"), `Approval=${t2 && t2.Approval}`);
  } catch (e) {
    out.push("FATAL=" + (e && (e.stack || e.message)));
  }
  out.push("");
  out.push(`SUMMARY PASS=${pass.length} FAIL=${fail.length}`);
  if (fail.length) out.push("FAILED: " + fail.join(" | "));
  fs.writeFileSync("diag_e2e_out.txt", out.join("\r\n"), "utf8");
  console.log("E2E DONE. PASS=" + pass.length + " FAIL=" + fail.length);
  process.exit(0);
})();
