const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");
const jwt = require("jsonwebtoken");
const { getSheets, withSheets } = require("../googleSheetsClient");

// =====================================================
// REGISTER
// =====================================================
router.post("/Admin/register", async (req, res) => {
  try {
    const { name, mobile, password, department } = req.body;

    if (!name || !mobile || !password || !department) {
      return res.status(400).json({ error: "All fields required" });
    }

    // Use withSheets for automatic retry on auth errors
    const empRes = await withSheets(async (sheets) => {
      return await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: "Admin!A2:F",
      });
    });

    const employees = empRes.data.values || [];

    if (employees.find((e) => e[2] === mobile)) {
      return res.status(400).json({ error: "Mobile already registered" });
    }
    res.json({ ok: true, EmployeeID });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// LOGIN
// =====================================================
router.post("/Admin/login", async (req, res) => {
  try {
    const { employeeID, password } = req.body;

    // Use withSheets for automatic retry on auth errors
    const empRes = await withSheets(async (sheets) => {
      return await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: "Admin!A:F",
      });
    });

    const employees = empRes.data.values || [];

    const user = employees.find((u) => u[0] === employeeID);

    if (!user) return res.status(404).json({ error: "User not found" });

    const passOK = await bcrypt.compare(password, user[3]);

    if (!passOK) return res.status(401).json({ error: "Incorrect password" });

    const token = jwt.sign(
      {
        employeeID: user[0],
        name: user[1],
        department: user[4],
      },
      process.env.JWT_SECRET,
      { expiresIn: "2d" }
    );

    res.json({
      ok: true,
      token,
      user: {
        employeeID: user[0],
        name: user[1],
        sheet: `${user[1]}_Delegations`,
      },
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
