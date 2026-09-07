const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");
const jwt = require("jsonwebtoken");
const { getSheets, withSheets } = require("../googleSheetsClient");
const asyncHandler = require("../middleware/asyncHandler");

// =====================================================
// REGISTER
// =====================================================
router.post("/admin/register", asyncHandler(async (req, res) => {
  const { name, mobile, password, department } = req.body;

  if (!name || !mobile || !password || !department) {
    return res.status(400).json({ error: "All fields required" });
  }

  if (mobile.length < 10) {
    return res.status(400).json({ error: "Valid mobile number required" });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const sheets = await getSheets();
  const empRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Admin!A2:F",
  });

  const employees = empRes.data.values || [];

  if (employees.find((e) => e[1] === name)) {
    return res.status(400).json({ error: "UserName already registered" });
  }

  if (employees.find((e) => e[2] === mobile)) {
    return res.status(400).json({ error: "Mobile already registered" });
  }

  const EmployeeID = nanoid(6);
  const hashedPassword = await bcrypt.hash(password, 10);

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Admin!A2:L",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[EmployeeID, name, mobile, hashedPassword, department, new Date().toISOString()]],
    },
  });

  res.json({ ok: true, EmployeeID });
}));

// =====================================================
// LOGIN
// =====================================================
router.post("/admin/login", asyncHandler(async (req, res) => {
  const { employeeID, password } = req.body;

  if (!employeeID || !password) {
    return res.status(400).json({ error: "EmployeeID and password required" });
  }

  // Use withSheets for automatic retry on auth errors
  const empRes = await withSheets(async (sheets) => {
    return await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Admin!A2:L",
    });
  });

  const employees = empRes.data.values || [];
  const user = employees.find((u) => u[0] === employeeID);

  if (!user) return res.status(404).json({ error: "User not found" });

  const passOK = await bcrypt.compare(password, user[3]);
  if (!passOK) return res.status(401).json({ error: "Incorrect password" });

  const token = jwt.sign(
    { employeeID: user[0], name: user[1], department: user[4] },
    process.env.JWT_SECRET,
    { expiresIn: "2d" }
  );

  res.json({
    ok: true,
    token,
    user: {
      employeeID: user[0],
      name: user[1],
      department: user[4],
      mobile: user[2],
      company: user[6] || "",
      sheet: `${user[1]}_Delegations`,
    },
  });
}));

module.exports = router;