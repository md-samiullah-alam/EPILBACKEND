// Diagnostic: simulate GET endpoints of training module with a real JWT (read-only)
require("dotenv").config();
const fs = require("fs");
const jwt = require("jsonwebtoken");
const axios = require("axios");

(async () => {
  const out = [];
  const base = process.env.DIAG_BASE || "http://localhost:5000/api/training";
  const token = jwt.sign(
    { id: "diag-admin", name: "Diag Admin", department: "MIS", role: "admin" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
  const headers = { Authorization: `Bearer ${token}` };

  const hits = [
    ["GET /templates?approval=Pending", `${base}/templates?approval=Pending`],
    ["GET /templates?approval=Approved", `${base}/templates?approval=Approved`],
    ["GET /templates?approval=all", `${base}/templates?approval=all`],
    ["GET /templates/approved", `${base}/templates/approved`],
    ["GET /templates/departments", `${base}/templates/departments`],
  ];

  for (const [label, url] of hits) {
    try {
      const r = await axios.get(url, { headers, timeout: 20000 });
      out.push(`=== ${label} ===`);
      out.push("STATUS=" + r.status);
      out.push("BODY=" + JSON.stringify(r.data));
    } catch (e) {
      out.push(`=== ${label} ===`);
      out.push("HTTP_ERROR=" + (e.response ? e.response.status + " " + JSON.stringify(e.response.data) : e.message));
    }
    out.push("");
  }

  fs.writeFileSync("diag_approve_flow_out.txt", out.join("\r\n"), "utf8");
  console.log("DIAG APPROVE FLOW DONE");
  process.exit(0);
})();