const express = require("express");
const { getSheets } = require("../googleSheetsClient");
const auth = require("../middleware/auth");

const router = express.Router();

// ============================================================
// HEADER-AWARE EMPLOYEE READER (Designation column K safe)
// Sheet me column order shift ho sakta hai, isliye header row
// se "Designation" + "Department" ka index dhoondhte hain.
// Fallback: purana fixed index (E=4 Dept, K=10 Designation).
// ============================================================
const normHeader = (h) => String(h || "").trim().toLowerCase().replace(/[^a-z]/g, "");
function findColIdx(header, names) {
  const normed = (header || []).map(normHeader);
  for (const n of names) {
    const i = normed.indexOf(normHeader(n));
    if (i !== -1) return i;
  }
  return -1;
}
let empColCache = null;
async function getEmpColMap() {
  if (empColCache) return empColCache;
  try {
    const sheets = await getSheets();
    const hRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Employee!A1:BZ1",
    });
    const header = (hRes.data.values || [])[0] || [];
    const dept = findColIdx(header, ["department", "dept", "depatment", "departmentname"]);
    const desig = findColIdx(header, ["designation", "designations", "desig", "designition", "desgination", "post", "role", "title", "jobtitle", "position"]);
    empColCache = {
      dept: dept !== -1 ? dept : 4,
      desig: desig !== -1 ? desig : 10,
      header,
    };
  } catch (e) {
    empColCache = { dept: 4, desig: 10, header: [] };
  }
  return empColCache;
}
function empRowToObj(e, colMap) {
  const deptIdx = colMap ? colMap.dept : 4;
  const desigIdx = colMap ? colMap.desig : 10;
  const cell = (i) => String(e[i] ?? "").trim();
  // K (designation column) blank ho to poori row me designation jaisa text dhoondho
  let designation = cell(desigIdx);
  if (!designation) {
    const order = [10, 11, 12, 5, 6, 13, 14, 15, 16, 4, 3, 7];
    for (const i of order) {
      if (i === desigIdx) continue;
      const v = cell(i);
      if (!v || /^\d{5,}$/.test(v.replace(/[\s+\-]/g, "")) || v.length > 60) continue;
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v)) continue; // date skip
      if (/^https?:\/\//i.test(v)) continue; // link skip
      designation = v; break;
    }
  }
  return {
    employeeID: e[0],
    name: e[1],
    number: e[2] || "",
    Department: e[deptIdx] || e[4] || "",
    CompanyName: e[6] || "",
    DateofBirth: e[7] || "",
    JoiningDate: e[8] || "",
    ProfilePicture: e[9] || "",
    Designation: designation,
    DoerName: e[11] || "",
    ShiftStartTime: e[17] || "",
    ShiftEndTime: e[18] || "",
    TotalWorkingHours: e[19] || "",
  };
}

// GET ALL EMPLOYEE NAMES
router.get("/all", auth, async (req, res) => {
  try {
    const sheets = await getSheets();
    const colMap = await getEmpColMap();
    const empRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Employee!A2:BZ",
    });

    const employees = (empRes.data.values || []).map((e) => empRowToObj(e, colMap));

    res.json(employees);
  } catch (err) {
    console.error("EMPLOYEE ALL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// UNIQUE DESIGNATIONS (Admin Training -> Create Template dropdown)
// COMMON hamesha sabse pehle + employee sheet ke unique designations
router.get("/designations", auth, async (req, res) => {
  try {
    const sheets = await getSheets();
    const colMap = await getEmpColMap();
    const empRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Employee!A2:BZ",
    });
    const seen = new Map();
    for (const e of (empRes.data.values || [])) {
      const d = empRowToObj(e, colMap).Designation;
      const t = String(d || "").trim();
      if (!t) continue;
      const k = t.toUpperCase();
      if (!seen.has(k)) seen.set(k, t);
    }
    const designations = ["COMMON", ...[...seen.values()].sort((a, b) => a.localeCompare(b))];
    res.json({ ok: true, designations, columnIndex: colMap.desig, header: colMap.header.slice(0, 20) });
  } catch (err) {
    console.error("EMPLOYEE DESIGNATIONS ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET CURRENT EMPLOYEE PROFILE (based on JWT)
router.get("/profile", auth, async (req, res) => {
  try {
    const sheets = await getSheets();
    const colMap = await getEmpColMap();
    const empRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Employee!A2:BZ",
    });

    const employees = empRes.data.values || [];
    const me = employees.find((e) => e[0] === req.user.employeeID);

    if (!me) return res.status(404).json({ error: "Employee not found" });

    res.json({
      employeeID: me[0],
      name: me[1],
      mobile: me[2] || "",
      department: me[colMap.dept] || me[4] || "",
      companyName: me[6] || "",
      dateOfBirth: me[7] || "",
      joiningDate: me[8] || "",
      profilePicture: me[9] || "",
      designation: empRowToObj(me, colMap).Designation,
      doerName: me[11] || "",
      shiftStartTime: me[17] || "",
      shiftEndTime: me[18] || "",
      totalWorkingHours: me[19] || "",
    });
  } catch (err) {
    console.error("EMPLOYEE PROFILE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET ALL ADMIN NAMES
router.get("/allAdmin", auth, async (req, res) => {
  try {
    const sheets = await getSheets();
    const adminRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Admin!A2:B",
    });

    const admins = (adminRes.data.values || []).map(a => ({
      employeeID: a[0],
      name: a[1],
    }));

    res.json(admins);
  } catch (err) {
    console.error("ADMIN ALL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
