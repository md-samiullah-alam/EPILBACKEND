const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");
const jwt = require("jsonwebtoken");
const { getSheets, withSheets } = require("../googleSheetsClient");
const asyncHandler = require("../middleware/asyncHandler");
const { formatDateDMY, parseDateFromDMY } = require("../utils/dateHelpers");
const { parser } = require("../cloudinary");

// =====================================================
// REGISTER - EXACT SAME PATTERN AS SUPPORT TICKETS
// =====================================================
router.post("/register", parser.fields([
  { name: "profilePicture", maxCount: 1 },
  { name: "aadhaarCard", maxCount: 1 },
  { name: "panCard", maxCount: 1 },
  { name: "bankPassbook", maxCount: 1 },
  { name: "educationCert", maxCount: 1 },
  { name: "experienceCert", maxCount: 1 }
]), asyncHandler(async (req, res) => {
  const data = req.body;
  const files = req.files || {};
  
  console.log("========== REGISTER API ==========");
  console.log("Data keys:", Object.keys(data));
  console.log("Files keys:", Object.keys(files));
  
  // Get Cloudinary URLs - EXACT SAME as supportTickets
  const profilePictureUrl = files.profilePicture ? files.profilePicture[0].path : "";
  const aadhaarCardUrl = files.aadhaarCard ? files.aadhaarCard[0].path : "";
  const panCardUrl = files.panCard ? files.panCard[0].path : "";
  const bankPassbookUrl = files.bankPassbook ? files.bankPassbook[0].path : "";
  const educationCertUrl = files.educationCert ? files.educationCert[0].path : "";
  const experienceCertUrl = files.experienceCert ? files.experienceCert[0].path : "";
  
  // Validation - only 4 fields required
  if (!data.name) return res.status(400).json({ error: "Name required" });
  if (!data.mobile) return res.status(400).json({ error: "Mobile required" });
  if (!data.password) return res.status(400).json({ error: "Password required" });
  if (!data.department) return res.status(400).json({ error: "Department required" });

  if (data.mobile.length < 10) {
    return res.status(400).json({ error: "Valid mobile number required" });
  }

  if (data.password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const sheets = await getSheets();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  
  // Check existing employees
  const empRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Employee!A2:L",
  });

  const employees = empRes.data.values || [];

  if (employees.find((e) => e[1] === data.name)) {
    return res.status(400).json({ error: "UserName already registered" });
  }

  if (employees.find((e) => e[2] === data.mobile)) {
    return res.status(400).json({ error: "Mobile already registered" });
  }

  const EmployeeID = nanoid(6);
  const hashedPassword = await bcrypt.hash(data.password, 10);
  const createdDate = new Date().toISOString();

  // CREATE 75 COLUMNS ROW
  let row = new Array(75).fill("");
  
  // A-L (Index 0-11)
  row[0] = EmployeeID;
  row[1] = data.name;
  row[2] = data.mobile;
  row[3] = hashedPassword;
  row[4] = data.department;
  row[5] = createdDate;
  row[6] = data.companyName || "";
  row[7] = formatDateDMY(data.dateOfBirth);
  row[8] = formatDateDMY(data.joiningDate);
  row[9] = profilePictureUrl;
  row[10] = data.designation || "";
  row[11] = data.doerName || "";
  
  // M-BW (Index 12-74)
  row[12] = data.gender || "";
  row[13] = data.employeeType || "";
  row[14] = data.workLocation || "";
  row[15] = data.employeeStatus || "";
  row[16] = data.shiftName || "";
  row[17] = data.shiftStartTime || "";
  row[18] = data.shiftEndTime || "";
  row[19] = data.totalWorkingHours || "";
  row[20] = data.lunchBreak || "";
  row[21] = data.weeklyOff || "";
  row[22] = data.overtimeApplicable || "";
  row[23] = data.overtimeRate || "";
  row[24] = data.basicSalary || "";
  row[25] = data.petrolAllowance || "";
  row[26] = data.petrolAmount || "";
  row[27] = data.foodAllowance || "";
  row[28] = data.foodAmount || "";
  row[29] = data.workingDays || "";
  row[30] = data.pfApplicable || "";
  row[31] = data.ptApplicable || "";
  row[32] = data.advanceAllowed || "";
  row[33] = data.advanceLimit || "";
  row[34] = data.biometricId || "";
  row[35] = data.graceTime || "";
  row[36] = data.lateMarkAfter || "";
  row[37] = data.halfDayAfter || "";
  row[38] = data.minWorkingHours || "";
  row[39] = data.punchRequired || "";
  row[40] = data.autoAbsentAfter || "";
  row[41] = data.paidLeave || "";
  row[42] = data.casualLeave || "";
  row[43] = data.sickLeave || "";
  row[44] = data.earnedLeave || "";
  row[45] = data.leaveCarryForward || "";
  row[46] = data.leaveCarryMax || "";
  row[47] = data.bankName || "";
  row[48] = data.accountNumber || "";
  row[49] = data.ifscCode || "";
  row[50] = data.pfNumber || "";
  row[51] = data.esicNumber || "";
  row[52] = bankPassbookUrl;
  row[53] = data.aadhaarNumber || "";
  row[54] = aadhaarCardUrl;
  row[55] = data.panNumber || "";
  row[56] = panCardUrl;
  row[57] = data.highestQualification || "";
  row[58] = data.passingYear || "";
  row[59] = educationCertUrl;
  row[60] = data.previousCompany || "";
  row[61] = data.previousDesignation || "";
  row[62] = data.totalExperience || "";
  row[63] = experienceCertUrl;
  row[64] = data.fatherName || "";
  row[65] = data.motherName || "";
  row[66] = data.spouseName || "";
  row[67] = formatDateDMY(data.spouseDob);
  row[68] = data.motherInLawName || "";
  row[69] = data.fatherInLawName || "";
  row[70] = data.emergencyContactName || "";
  row[71] = data.emergencyContactNumber || "";
  row[72] = data.permanentAddress || "";
  row[73] = data.currentAddress || "";
  row[74] = new Date().toISOString();

  console.log(`📊 Saving ${row.filter(r => r !== "").length} fields`);
  console.log(`📊 Profile Picture: ${profilePictureUrl}`);
  
  // Save to Google Sheet
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: "Employee!A:BW",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });

  console.log(`✅ Registered: ${EmployeeID} - ${data.name}`);

  res.json({ ok: true, EmployeeID });
}));

// =====================================================
// LOGIN
// =====================================================
router.post("/login", asyncHandler(async (req, res) => {
  const { employeeID, password } = req.body;

  if (!employeeID || !password) {
    return res.status(400).json({ error: "EmployeeID and password required" });
  }

  // Use withSheets for automatic retry on auth errors
  const empRes = await withSheets(async (sheets) => {
    return await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Employee!A:BW",
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
      companyName: user[6] || "",
      dateOfBirth: parseDateFromDMY(user[7]),
      joiningDate: parseDateFromDMY(user[8]),
      profilePicture: user[9] || "",
      designation: user[10] || "",
      donorName: user[11] || "",
      sheet: `${user[1]}_Delegations`,
    },
  });
}));

module.exports = router;