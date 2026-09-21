// Diagnostic (read-only): verify training module matches DESIGNATION-wise (not department-wise)
// Admin panel + doer panel dono endpoints hit karta hai.
require("dotenv").config();
const fs = require("fs");
const jwt = require("jsonwebtoken");
const axios = require("axios");

(async () => {
  const out = [];
  const tag = process.argv[3] || "5000";
  try {
    await run(out);
  } catch (e) {
    out.push("FATAL=" + (e && (e.stack || e.message || String(e))));
  }
  fs.writeFileSync(`diag_desig_match_out_${tag}.txt`, out.join("\r\n"), "utf8");
  console.log("DIAG DESIG MATCH DONE tag=" + tag);
  process.exit(0);
})();

async function run(out) {
  const base = process.argv[2] || process.env.DIAG_BASE || "http://localhost:5000/api";
  out.push("BASE=" + base);
  out.push("ENV JWT_SECRET set = " + !!process.env.JWT_SECRET);
  const token = jwt.sign(
    { id: "diag-admin", name: "Diag Admin", department: "MIS", role: "admin" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
  const headers = { Authorization: `Bearer ${token}` };

  const record = async (label, url) => {
    out.push(`=== ${label} ===`);
    out.push("URL=" + url);
    try {
      const r = await axios.get(url, { headers, timeout: 30000 });
      out.push("STATUS=" + r.status);
      return r.data;
    } catch (e) {
      out.push("HTTP_ERROR=" + (e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message));
      return null;
    }
  };

  // 1) Employee designations (admin Add-Template dropdown source)
  const desigData = await record("GET /employee/designations", `${base}/employee/designations`);
  const designations = (desigData && desigData.designations) || [];
  out.push("DESIGNATIONS=" + JSON.stringify(designations));
  out.push("");

  // 2) All templates (admin Approved-Template tab)
  const allTpl = await record("GET /training/templates?approval=all", `${base}/training/templates?approval=all`);
  const tpls = (allTpl && allTpl.templates) || [];
  out.push("TEMPLATE_DESIGS=" + JSON.stringify([...new Set(tpls.map((t) => t.Designation || t.Department))]));
  out.push("");

  const sampleDesig = designations.find((d) => String(d).toUpperCase() !== "COMMON") || "";

  // 3) Admin designation filter param (naya param naam)
  if (sampleDesig) {
    const filtered = await record(
      `GET /training/templates?designation=${sampleDesig}`,
      `${base}/training/templates?designation=${encodeURIComponent(sampleDesig)}`
    );
    const list = (filtered && filtered.templates) || [];
    const wrong = list.filter((t) => String(t.Designation || t.Department || "").trim().toUpperCase() !== String(sampleDesig).trim().toUpperCase());
    out.push(`FILTERED_COUNT=${list.length} MISMATCH=${wrong.length}`);
    out.push("");
  }

  // 4) Doer panel: approved templates for a designation (COMMON + matching)
  if (sampleDesig) {
    const appr = await record(
      `GET /training/templates/approved?designation=${sampleDesig}`,
      `${base}/training/templates/approved?designation=${encodeURIComponent(sampleDesig)}`
    );
    const list = (appr && appr.templates) || [];
    out.push("APPROVED_FOR_DESIG=" + JSON.stringify(list.map((t) => `${t.Designation || t.Department} :: ${t.TemplateName}`)));
    const bad = list.filter((t) => {
      const d = String(t.Designation || t.Department || "").trim().toUpperCase();
      return d !== "COMMON" && d !== String(sampleDesig).trim().toUpperCase();
    });
    out.push(`NON_MATCHING_LEAKED=${bad.length}`);
    out.push("");
  }

  // 5) Doer panel: non-existent designation => sirf COMMON (designation leak nahi hona chahiye)
  const ghost = await record(
    "GET /training/templates/approved?designation=__NO_SUCH_DESIG__",
    `${base}/training/templates/approved?designation=__NO_SUCH_DESIG__`
  );
  const ghostList = (ghost && ghost.templates) || [];
  const ghostBad = ghostList.filter((t) => String(t.Designation || t.Department || "").trim().toUpperCase() !== "COMMON");
  out.push("GHOST_NON_COMMON=" + ghostBad.length + " (0 hona chahiye)");
  out.push("");

  // 6) Admin Performance tab: assigned rows (record na ho to bhi Pending row)
  const recs = await record("GET /training/records?employeeName=all&scope=all&status=all", `${base}/training/records?employeeName=all&scope=all&status=all`);
  const rows = (recs && recs.records) || [];
  out.push("RECORD_ROWS=" + rows.length);
  out.push("SAMPLE_ROW=" + JSON.stringify(rows[0] || {}));
  const recBad = rows.filter((r) => {
    const td = String(r.TemplateDesignation || r.TemplateDepartment || "").trim().toUpperCase();
    if (td === "COMMON") return false;
    // designation template sirf us employee ko milna chahiye jiski designation match kare
    return String(r.Designation || "").trim().toUpperCase() !== td;
  });
  out.push("DESIG_MISMATCH_ROWS=" + recBad.length + " (0 hona chahiye)");
  out.push("");

  // 7) Admin Performance tab: designation scope filter
  if (sampleDesig) {
    const scoped = await record(
      `GET /training/records?scope=${sampleDesig}`,
      `${base}/training/records?employeeName=all&scope=${encodeURIComponent(sampleDesig)}&status=all`
    );
    const sRows = (scoped && scoped.records) || [];
    const sBad = sRows.filter((r) => String(r.TemplateDesignation || r.TemplateDepartment || "").trim().toUpperCase() !== String(sampleDesig).trim().toUpperCase());
    out.push(`SCOPED_ROWS=${sRows.length} OUT_OF_SCOPE=${sBad.length} (0 hona chahiye)`);
    out.push("");
  }

  // 8) Param-name probes (stale server detect): designation vs department
  const probe = async (label, qs) => {
    const d = await record(label, `${base}/training/templates?${qs}`);
    const list = (d && d.templates) || [];
    out.push("COUNT=" + list.length + " DESIGS=" + JSON.stringify(list.map((t) => t.Designation || t.Department)));
    out.push("");
  };
  await probe("PROBE designation=CRM ALL", "designation=" + encodeURIComponent("CRM ALL"));
  await probe("PROBE department=CRM ALL", "department=" + encodeURIComponent("CRM ALL"));
  await probe("PROBE approval=Approved", "approval=Approved");
  await probe("PROBE approval=all", "approval=all");
  const mtDep = await record("GET /training/templates/departments", `${base}/training/templates/departments`);
  out.push("TEMPLATE_SHEET_DESIGS=" + JSON.stringify((mtDep && (mtDep.designations || mtDep.departments)) || []));
  out.push("");
}
