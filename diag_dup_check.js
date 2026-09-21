// Dup-check: kya "All" case me same training ID same employee ke liye multiple baar count ho raha hai?
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const fs = require("fs");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const BASE = process.env.DIAG_BASE || "http://localhost:5000/api";
const A = jwt.sign({ id: "diag-admin", name: "Diag Admin", department: "MIS", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
const call = async (url) => (await axios.get(url, { headers: { Authorization: `Bearer ${A}` }, timeout: 60000 })).data;
const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

(async () => {
  const out = [];
  try {
    // 1) Employee sheet duplicates (normalized name)
    const emps = await call(`${BASE}/employee/all`);
    const list = Array.isArray(emps) ? emps : [];
    const byName = new Map();
    for (const e of list) {
      const k = norm(e.name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(e.name + " (ID:" + (e.employeeID || "?") + ")");
    }
    const dups = [...byName.entries()].filter(([, v]) => v.length > 1);
    out.push(`EMPLOYEES_RAW=${list.length} UNIQUE_NORM_NAMES=${byName.size} DUPLICATE_NAME_GROUPS=${dups.length}`);
    for (const [k, v] of dups.slice(0, 20)) out.push(`DUP "${k}" x${v.length} -> ${v.join(" | ")}`);
    out.push("");

    // 2) Records: (employee, templateId) pairs — duplicates?
    const rec = await call(`${BASE}/training/records?employeeName=all&scope=all&status=all`);
    const rows = rec.records || [];
    out.push(`RECORD_ROWS=${rows.length}`);
    const pairCount = new Map();
    for (const r of rows) {
      const k = norm(r.EmployeeName) + "|||" + r.TemplateId;
      pairCount.set(k, (pairCount.get(k) || 0) + 1);
    }
    const dupPairs = [...pairCount.entries()].filter(([, v]) => v > 1);
    out.push(`UNIQUE_PAIRS=${pairCount.size} DUPLICATE_PAIRS=${dupPairs.length}`);
    for (const [k, v] of dupPairs.slice(0, 20)) out.push(`DUP_PAIR "${k}" x${v}`);
    out.push("");

    // 3) TemplateId-wise: kitni baar aaya (per designation bucket)
    const tplCount = new Map();
    for (const r of rows) {
      const t = r.TemplateId + " [" + (r.TemplateDesignation || r.TemplateDepartment || "?") + "] type=" + r.Type;
      tplCount.set(t, (tplCount.get(t) || 0) + 1);
    }
    for (const [t, c] of [...tplCount.entries()].sort()) out.push(`TPL ${t} rows=${c}`);
    out.push("");

    // 4) Summary jaisa admin UI dekhta hai
    out.push("SUMMARY=" + JSON.stringify(rec.summary));
  } catch (e) {
    out.push("FATAL=" + (e && (e.stack || e.message)));
  }
  fs.writeFileSync("diag_dup_out.txt", out.join("\r\n"), "utf8");
  console.log("DUP CHECK DONE");
  process.exit(0);
})();
