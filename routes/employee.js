const express = require("express");
const { getSheets } = require("../googleSheetsClient");
const auth = require("../middleware/auth");

const router = express.Router();

// GET ALL EMPLOYEE NAMES
router.get("/all", auth, async (req, res) => {
  try {
    const sheets = await getSheets();
    const empRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Employee!A2:BZ",
    });
console.log("empRes.data.values:", empRes.data.values);

    const employees = (empRes.data.values || []).map(e => ({
      employeeID: e[0],
      name: e[1],
      number: e[2] || "",
      Department:e[4] || "",
      CompanyName:e[6] || "",
      DateofBirth : e[7] || "",
      JoiningDate : e[8] || "",
      ProfilePicture : e[9] || "" ,
      Designation : e[10] || "",
      DoerName : e[11] || "",
      ShiftStartTime : e[17] || "",
      ShiftEndTime : e[18] || "",
      TotalWorkingHours : e[19] || "",
    }));

    res.json(employees);
  } catch (err) {
    console.error("EMPLOYEE ALL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET CURRENT EMPLOYEE PROFILE (based on JWT)
router.get("/profile", auth, async (req, res) => {
  try {
    const sheets = await getSheets();
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
      department: me[4] || "",
      companyName: me[6] || "",
      dateOfBirth: me[7] || "",
      joiningDate: me[8] || "",
      profilePicture: me[9] || "",
      designation: me[10] || "",
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
