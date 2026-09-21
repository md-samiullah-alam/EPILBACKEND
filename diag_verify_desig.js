// Fast read-only verification: training module DESIGNATION-wise matching (live server)
// Run: node diag_verify_desig.js   -> writes diag_verify_out.txt
require("dotenv").config();
const fs = require("fs");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const base = process.env.DIAG_BASE || "http://localhost:5000/api";
const out = [];
const token = jwt.sign({ id: "diag", name: "Diag", department: "MIS", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
const headers = { Authorization: `Bearer ${token}` };
const get = async (label, url) => {
  out.push(`=== ${label} ===`);
  try {
    const r = await axios.get(url, { headers, timeout: 20000 });
    out.push("STATUS=" + r.status);
    return r.data;
  } catch (e) {
    out.push("ERR=" + (e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message));
    return null;
  }
};
const desigsOf = (d) => JSON.stringify(((d && d.templates) || []).map((t) => t.Designation || t.Department));

(async () => {
  try {
    const d = await get("employee designations", `${base}/employee/designations`);
    const list = (d && d.designations) || [];
    out.push("DESIG_LIST=" + JSON.stringify(list.slice(0, 12)));
    const sample = list.find((x) => String(x).toUpperCase() !== "COMMON" && String(x).toUpperCase() !== "ALL") || "";
    out.push("SAMPLE_DESIG=" + sample);

    const all = await get("templates (no filter)", `${base}/training/templates`);
    out.push("COUNT=" + ((all && all.templates) || []).length + " DESIGS=" + desigsOf(all));
    out.push("TemplateDesignation field present=" + JSON.stringify(((all && all.templates) || []).slice(0, 3).map((t) => t.Designation)));

    const byDesig = await get(`templates?designation=${sample}`, `${base}/training/templates?designation=${encodeURIComponent(sample)}`);
    out.push("COUNT=" + ((byDesig && byDesig.templates) || []).length + " DESIGS=" + desigsOf(byDesig));

    const byDeptAlias = await get(`templates?department=${sample} (purana alias)`, `${base}/training/templates?department=${encodeURIComponent(sample)}`);
    out.push("COUNT=" + ((byDeptAlias && byDeptAlias.templates) || []).length + " DESIGS=" + desigsOf(byDeptAlias));

    const ghost = await get("templates?designation=__NO_SUCH__ (0 hona chahiye)", `${base}/training/templates?designation=__NO_SUCH__`);
    out.push("COUNT=" + ((ghost && ghost.templates) || []).length + " DESIGS=" + desigsOf(ghost));

    const appr = await get(`approved?designation=${sample}`, `${base}/training/templates/approved?designation=${encodeURIComponent(sample)}`);
    out.push("COUNT=" + ((appr && appr.templates) || []).length + " DESIGS=" + desigsOf(appr));

    const recs = await get("records?employeeName=all&scope=all&status=all", `${base}/training/records?employeeName=all&scope=all&status=all`);
    const rows = (recs && recs.records) || [];
    out.push("RECORD_ROWS=" + rows.length);
    out.push("SAMPLE_KEYS=" + JSON.stringify(Object.keys(rows[0] || {})));
    const bad = rows.filter((r) => {
      const td = String(r.TemplateDesignation || r.TemplateDepartment || "").trim().toUpperCase();
      if (td === "COMMON" || !td) return false;
      return String(r.Designation || "").trim().toUpperCase() !== td;
    });
    out.push("DESIG_MISMATCH_ROWS=" + bad.length + " (0 hona chahiye)");
    const scoped = await get(`records?scope=${sample}`, `${base}/training/records?employeeName=all&scope=${encodeURIComponent(sample)}&status=all`);
    out.push("SCOPED_ROWS=" + ((scoped && scoped.records) || []).length);
  } catch (e) {
    out.push("FATAL=" + (e && (e.stack || e.message)));
  }
  fs.writeFileSync("diag_verify_out.txt", out.join("\r\n"), "utf8");
  process.exit(0);
})();
