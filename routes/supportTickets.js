const express = require("express");
const { getSheets } = require("../googleSheetsClient");
const auth = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { parser, handleUpload, uploadBufferToCloudinary } = require("../cloudinary");
const { formatDateIST, parseDDMMYYYY, getWeekRange } = require("../utils/dateHelpers");
const { getCache, setCache, invalidateCache } = require("../utils/sheetCache");

const router = express.Router();
const SHEET_NAME = "SupportTicketsMaster";

// ======================================================
// SMART SHEET READ WITH CACHE
// ======================================================
async function readSupportSheet() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID_SUPPORTTICKET;
  const range = `${SHEET_NAME}!A2:Z`;
  const cached = getCache(spreadsheetId, range);
  if (cached) return cached;
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const data = res.data.values || [];
  setCache(spreadsheetId, range, data);
  return data;
}

function invalidateSupportCache() {
  invalidateCache(process.env.GOOGLE_SHEET_ID_SUPPORTTICKET, `${SHEET_NAME}!A2:Z`);
}

async function getUserDepartment(name) {
  const sheets = await getSheets();
  const empRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID, range: "Employee!A2:O",
  });
  const employees = empRes.data.values || [];
  const user = employees.find(e => e[1] === name);
  return user ? user[4] : "";  // Column 4 (index 4) is Department
}

function mapTicket(r) {
  return {
    TicketID: r[0] || "",
    CreatedBy: r[1] || "",
    AssignedTo: r[2] || "",
    Issue: r[3] || "",
    Status: r[4] || "Pending",
    CreatedDate: r[5] || "",
    DoneDate: r[6] || "",
    IssuePhoto: r[7] || "",
    WorkBy: r[8] || "",
    Taskcompletedapproval: r[9] || "Pending",
    Problem: r[12] || "",
    Solution: r[13] || "",
    Department: r[14] || "",  // Column O (index 14) - Ticket creator's department
  };
}

// ======================================================
// TEST ROUTES
// ======================================================
router.get("/test", (req, res) => {
  res.json({ message: "Support tickets route working", timestamp: new Date() });
});

router.get("/test-auth", auth, (req, res) => {
  res.json({ message: "Auth working", user: req.user });
});

// ======================================================
// CREATE TICKET
// ======================================================
router.post("/create", auth, handleUpload(parser.single("IssuePhoto")), asyncHandler(async (req, res) => {
  const { Issue } = req.body;
  if (!Issue) return res.status(400).json({ error: "Issue description is required" });

  // 1) Image (agar hai) ko pehle Cloudinary par upload karo.
  // Memory storage hai, isliye yaha buffer milta hai - 25s timeout ke sath,
  // taaki Render proxy hang hokar 502 na de. Koi bhi failure clean JSON dega.
  let photoUrl = "";
  if (req.file && req.file.buffer && req.file.buffer.length) {
    try {
      console.log(`[SupportTicket] Uploading image: ${req.file.originalname} (${req.file.size} bytes, ${req.file.mimetype})`);
      const up = await uploadBufferToCloudinary(req.file.buffer, {
        public_id: `support_${Date.now()}`,
      });
      photoUrl = up.secure_url || up.url || "";
      console.log("[SupportTicket] Image uploaded:", photoUrl);
    } catch (upErr) {
      console.error("[SupportTicket] Cloudinary upload failed:", upErr.message);
      return res.status(502).json({
        error: "Image upload failed: " + (upErr.message || "Cloudinary error"),
        hint: "2MB se chhoti JPG/PNG try karo, ya bina image ke ticket banao.",
      });
    }
  } else if (req.file && !req.file.buffer) {
    console.error("[SupportTicket] File received without buffer:", req.file.originalname);
    return res.status(400).json({ error: "Image read nahi ho payi. Dobara select karke retry karo." });
  }

  const sheets = await getSheets();
  const createdDate = formatDateIST();

  // Get employees data including department
  const empRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID, range: "Employee!A2:O",
  });
  const employees = empRes.data.values || [];
  
  // Get current user's department (jo ticket create kar raha hai)
  const currentUser = employees.find(emp => emp[1] === req.user.name);
  const userDepartment = currentUser ? currentUser[4] : "";  // Column 4 is Department
  
  console.log("Creating ticket for user:", req.user.name, "Department:", userDepartment);
  
  // Get all MIS employees (excluding current user if they are MIS)
  const misEmployees = employees.filter(emp => emp[4] === "MIS" && emp[1] !== req.user.name);

  if (!misEmployees.length) return res.status(400).json({ error: "No MIS employees found to assign tickets" });

  // Get last ID
  const lastIdRes = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID_SUPPORTTICKET, range: `${SHEET_NAME}!A:A`,
  });
  const allIds = lastIdRes.data.values || [];
  let lastId = "#00000";
  if (allIds.length > 1 && allIds[allIds.length - 1]?.[0]) lastId = allIds[allIds.length - 1][0];

  let nextIdNumber = lastId === "#00000" ? 1 : parseInt(lastId.substring(1), 10) + 1;
  const ticketIDs = [];
  const errors = [];

  for (const emp of misEmployees) {
    try {
      const ticketID = `#${String(nextIdNumber).padStart(5, '0')}`;
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID_SUPPORTTICKET,
        range: `${SHEET_NAME}!A:Z`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[
            ticketID,                    // A: TicketID
            req.user.name,               // B: CreatedBy
            emp[1],                      // C: AssignedTo
            Issue,                       // D: Issue
            "Pending",                   // E: Status
            createdDate,                 // F: CreatedDate
            "",                          // G: DoneDate
            photoUrl,                    // H: IssuePhoto
            "",                          // I: WorkBy
            "Pending",                   // J: Taskcompletedapproval
            "",                          // K: 
            "",                          // L: 
            "",                          // M: Problem
            "",                          // N: Solution
            userDepartment               // O: Department (Ticket creator ka department)
          ]],
        },
      });
      ticketIDs.push(ticketID);
      nextIdNumber++;
    } catch (err) {
      console.error("Error creating ticket for:", emp[1], err);
      errors.push(`Failed for ${emp[1]}`);
    }
  }

  if (!ticketIDs.length) return res.status(500).json({ error: "Failed to create any tickets", details: errors });
  invalidateSupportCache();

  res.json({
    ok: true, 
    ticketIDs,
    message: `${ticketIDs.length} ticket(s) created successfully`,
    errors: errors.length > 0 ? errors : undefined
  });
}));

// ======================================================
// GET CREATED TICKETS
// ======================================================
router.get("/created", auth, asyncHandler(async (req, res) => {
  const rows = await readSupportSheet();
  const tickets = rows.filter((r) => r[1] === req.user.name).map(mapTicket);
  res.json(tickets);
}));

// ======================================================
// GET ASSIGNED TICKETS
// ======================================================
router.get("/assigned", auth, asyncHandler(async (req, res) => {
  const rows = await readSupportSheet();
  const userDept = await getUserDepartment(req.user.name);

  let tickets = rows
    .filter((r) => r[2] === req.user.name)
    .map(mapTicket);

  if (userDept === "MIS") {
    tickets = tickets.filter(t => {
      if (t.Status === "Pending") return true;
      if (t.Status === "InProgress" || t.Status === "Done") return t.WorkBy === req.user.name;
      if (t.Status === "Approved") return true;
      return false;
    });
  }

  res.json(tickets);
}));

// ======================================================
// GET ALL TICKETS WITH FILTERS
// ======================================================
router.get("/all", auth, asyncHandler(async (req, res) => {
  const { assignedTo, createdBy, status } = req.query;
  const rows = await readSupportSheet();

  const tickets = rows
    .filter((r) => {
      let ok = true;
      if (assignedTo) ok = ok && r[2] === assignedTo;
      if (createdBy) ok = ok && r[1] === createdBy;
      if (status) ok = ok && r[4] === status;
      return ok;
    })
    .map(mapTicket);

  res.json({ ok: true, tickets });
}));

// ======================================================
// UPDATE STATUS (MAIN ROUTE)
// ======================================================
router.patch("/status/:ticketID", auth, asyncHandler(async (req, res) => {
  const { Status } = req.body;
  if (!Status) return res.status(400).json({ error: "Status is required" });

  const rows = await readSupportSheet();
  const userDept = await getUserDepartment(req.user.name);

  let foundTicket = null;
  let ticketIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === req.params.ticketID) { foundTicket = rows[i]; ticketIndex = i; break; }
  }
  if (!foundTicket) return res.status(404).json({ error: "Ticket not found" });

  const ticketIssue = foundTicket[3];
  const currentStatus = foundTicket[4];

  // Find ALL tickets with same issue
  const matchingTickets = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][3] && rows[i][3].trim() === ticketIssue.trim()) {
      matchingTickets.push({ row: rows[i], index: i });
    }
  }

  let newStatus = Status;
  let doneDate = foundTicket[6];
  let workBy = foundTicket[8] || "";
  let taskApproval = foundTicket[9] || "Pending";

  if (userDept === "MIS") {
    if (Status === "InProgress" && currentStatus === "Pending") {
      workBy = req.user.name; doneDate = ""; taskApproval = "Pending";
    } else if (Status === "Done" && currentStatus === "InProgress") {
      if (workBy && workBy !== req.user.name) return res.status(403).json({ error: "You can only complete tickets you started" });
      doneDate = formatDateIST(); taskApproval = "Pending";
    } else {
      return res.status(400).json({ error: "MIS can only change Pending → InProgress or InProgress → Done" });
    }
  } else {
    if (currentStatus !== "Done") return res.status(400).json({ error: "You can only approve or reject completed tickets" });
    if (Status === "Approved") { taskApproval = "Approved"; newStatus = "Done"; }
    else if (Status === "Pending") { doneDate = ""; taskApproval = "Pending"; newStatus = "Pending"; }
    else return res.status(400).json({ error: "You can only change Done → Approved or Done → Pending" });
  }

  // Update ALL matching tickets
  const sheets = await getSheets();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID_SUPPORTTICKET;
  for (const ticket of matchingTickets) {
    const updatedRow = [...ticket.row];
    updatedRow[4] = newStatus;
    updatedRow[6] = doneDate;
    updatedRow[8] = workBy;
    updatedRow[9] = taskApproval;
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${SHEET_NAME}!A${ticket.index + 2}:Z${ticket.index + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [updatedRow] },
    });
  }

  invalidateSupportCache();
  res.json({ ok: true, message: `Updated ${matchingTickets.length} ticket(s)`, newStatus, workBy, doneDate, taskApproval });
}));

// ======================================================
// UPDATE DONE DETAILS (Problem & Solution)
// ======================================================
router.patch("/done-details/:ticketID", auth, asyncHandler(async (req, res) => {
  const { Problem, Solution } = req.body;
  if (!Problem || !Solution) return res.status(400).json({ error: "Problem and Solution are required" });

  const rows = await readSupportSheet();
  let foundTicket = null, ticketIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === req.params.ticketID) { foundTicket = rows[i]; ticketIndex = i; break; }
  }
  if (!foundTicket) return res.status(404).json({ error: "Ticket not found" });

  const ticketIssue = foundTicket[3];
  const matchingTickets = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][3] && rows[i][3].trim() === ticketIssue.trim()) {
      matchingTickets.push({ row: rows[i], index: i });
    }
  }

  const sheets = await getSheets();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID_SUPPORTTICKET;
  for (const ticket of matchingTickets) {
    const updatedRow = [...ticket.row];
    while (updatedRow.length < 14) updatedRow.push("");
    updatedRow[12] = Problem;
    updatedRow[13] = Solution;
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${SHEET_NAME}!A${ticket.index + 2}:Z${ticket.index + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [updatedRow] },
    });
  }

  invalidateSupportCache();
  res.json({ ok: true, message: `Updated ${matchingTickets.length} ticket(s) with problem/solution`, problem: Problem, solution: Solution });
}));

// ======================================================
// FILTER TICKETS BY WEEK/MONTH
// ======================================================
router.get("/filter", auth, asyncHandler(async (req, res) => {
  const { month, week, selectedName } = req.query;
  if (!month || !week) return res.status(400).json({ error: "Month and Week are required" });

  const rows = await readSupportSheet();
  const nameToFilter = (selectedName?.trim() || req.user.name.trim()).toLowerCase();
  const { weekStart, weekEnd } = getWeekRange(month, week);

  function calculateTickets(filteredRows) {
    let total = 0, pending = 0, completed = 0, delayed = 0;
    const tickets = [];

    filteredRows.forEach((r) => {
      const createdDate = parseDDMMYYYY(r[5]);
      const doneDate = parseDDMMYYYY(r[6]);
      if (!createdDate) return;
      if (!(createdDate <= weekEnd && (!doneDate || doneDate >= weekStart))) return;
      total++;
      if (doneDate && doneDate >= weekStart && doneDate <= weekEnd) {
        completed++;
        const wd = Math.ceil((doneDate - createdDate) / (1000 * 60 * 60 * 24));
        if (wd > 3) delayed++;
      } else { pending++; }
      tickets.push(mapTicket(r));
    });

    return {
      total, pending, completed, delayed,
      pendingPercentage: total ? ((pending / total) * 100).toFixed(2) : "0.00",
      delayedPercentage: total ? ((delayed / total) * 100).toFixed(2) : "0.00",
      tickets
    };
  }

  const assignedRows = rows.filter((r) => (r[2] || "").trim().toLowerCase() === nameToFilter);
  const createdRows = rows.filter((r) => (r[1] || "").trim().toLowerCase() === nameToFilter);
  const assignedData = calculateTickets(assignedRows);
  const createdData = calculateTickets(createdRows);

  res.json({
    weekStart: weekStart.toLocaleDateString('en-CA'),
    weekEnd: weekEnd.toLocaleDateString('en-CA'),
    assigned: {
      assignedTotalTicket: assignedData.total,
      assignedPendingTicket: assignedData.pending,
      assignedCompletedTicket: assignedData.completed,
      assignedDelayedTicket: assignedData.delayed,
      assignedPendingPercentage: assignedData.pendingPercentage,
      assignedDelayPercentage: assignedData.delayedPercentage,
      tickets: assignedData.tickets
    },
    created: {
      createdTotalTicket: createdData.total,
      createdPendingTicket: createdData.pending,
      createdCompletedTicket: createdData.completed,
      createdDelayedTicket: createdData.delayed,
      createdPendingPercentage: createdData.pendingPercentage,
      createdDelayPercentage: createdData.delayedPercentage,
      tickets: createdData.tickets
    }
  });
}));

module.exports = router;