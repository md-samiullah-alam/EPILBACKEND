// Fast read-only check: templates ka Approval + employees ka designation (records=0 ki wajah)
require("dotenv").config();
const fs = require("fs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const base = process.env.DIAG_BASE || "http://localhost:5000/api";
const out = [];
const token = jwt.sign({ id: "diag", name: "Diag", department: "MIS", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
const headers = { Authorization: `Bearer ${token}` };
const get = async (label, url) => {
  try {
    const r = await axios.get(url, { headers, timeout: 20000 });
    out.push(`=== ${label} === OK`);
    return r.data;
  } catch (e) {
    out.push(`=== ${label} === ERR ` + (e.response ? e.response.status : e.message));
    return null;
  }
};
(async () => {
  try {
    const t = await get("templates?approval=all", `${base}/training/templates?approval=all`);
    out.push("ALL_TEMPLATES=" + JSON.stringify(((t && t.templates) || []).map((x) => ({ id: x.TemplateId, desig: x.Designation || x.Department, name: x.TemplateName, approval: x.Approval }))));
    const a = await get("templates?approval=Approved", `${base}/training/templates?approval=Approved`);
    out.push("APPROVED_COUNT=" + ((a && a.templates) || []).length);
    const e = await get("employee/all", `${base}/employee/all`);
    const emps = Array.isArray(e) ? e : (e && (e.data || e.employees)) || [];
    out.push("EMPLOYEE_COUNT=" + emps.length);
    out.push("EMP_SAMPLE=" + JSON.stringify(emps.slice(0, 6).map((x) => ({ name: x.name, department: x.Department || x.department, designation: x.Designation || x.designation }))));
    const desigs = [...new Set(emps.map((x) => String(x.Designation || x.designation || "").trim()).filter(Boolean))];
    out.push("EMP_DESIGS=" + JSON.stringify(desigs));
    const my = await get("training/my (admin token se)", `${base}/training/my`);
    out.push("MY_ROWS=" + ((my && my.records) || []).length);
  } catch (err) {
    out.push("FATAL=" + (err && (err.stack || err.message)));
  }
  fs.writeFileSync("diag_verify2_out.txt", out.join("\r\n"), "utf8");
  process.exit(0);
})();
