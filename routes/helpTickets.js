const express = require("express");
const { nanoid } = require("nanoid");
const { getSheets } = require("../googleSheetsClient");
const auth = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { parser, handleUpload, uploadBufferToCloudinary } = require("../cloudinary");
const { formatDateIST, parseDDMMYYYY, getWeekRange } = require("../utils/dateHelpers");
const { getCache, setCache, invalidateCache } = require("../utils/sheetCache");

const router = express.Router();
const SHEET_NAME = "HelpTicketsMaster";

// ======================================================
// SMART SHEET READ WITH CACHE
// ======================================================
async function readHelpSheet() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID_HELPTICKET;
  const range = `${SHEET_NAME}!A2:H`;
  const cached = getCache(spreadsheetId, range);
  if (cached) return cached;
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const data = res.data.values || [];
  setCache(spreadsheetId, range, data);
  return data;
}

function invalidateHelpCache() {
  invalidateCache(process.env.GOOGLE_SHEET_ID_HELPTICKET, `${SHEET_NAME}!A2:H`);
}

function mapHelpTicket(r) {
  return {
    TicketID: r[0],
    CreatedBy: r[1],
    AssignedTo: r[2],
    Issue: r[3],
    Status: r[4],
    CreatedDate: r[5],
    DoneDate: r[6] || "",
    IssuePhoto: r[7] || ""
  };
}

// ======================================================
// CREATE TICKET
// ======================================================
router.post("/create", auth, handleUpload(parser.single("IssuePhoto")), asyncHandler(async (req, res) => {
  const { AssignedTo, Issue } = req.body;
  if (!AssignedTo || !Issue) return res.status(400).json({ error: "AssignedTo and Issue required" });
  if (AssignedTo === req.user.name) return res.status(400).json({ error: "Cannot assign ticket to yourself" });

  // 1) Image (agar hai) ko pehle Cloudinary par upload karo (memory buffer +
  // 25s timeout taaki Render proxy hang hokar 502 na de).
  let photoUrl = "";
  if (req.file && req.file.buffer && req.file.buffer.length) {
    try {
      console.log(`[HelpTicket] Uploading image: ${req.file.originalname} (${req.file.size} bytes, ${req.file.mimetype})`);
      const up = await uploadBufferToCloudinary(req.file.buffer, {
        public_id: `help_${Date.now()}`,
      });
      photoUrl = up.secure_url || up.url || "";
      console.log("[HelpTicket] Image uploaded:", photoUrl);
    } catch (upErr) {
      console.error("[HelpTicket] Cloudinary upload failed:", upErr.message);
      return res.status(502).json({
        error: "Image upload failed: " + (upErr.message || "Cloudinary error"),
        hint: "2MB se chhoti JPG/PNG try karo, ya bina image ke ticket banao.",
      });
    }
  } else if (req.file && !req.file.buffer) {
    console.error("[HelpTicket] File received without buffer:", req.file.originalname);
    return res.status(400).json({ error: "Image read nahi ho payi. Dobara select karke retry karo." });
  }

  const sheets = await getSheets();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID_HELPTICKET;

  // Sequential ticket ID
  const idRes = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${SHEET_NAME}!A:A`,
  });
  const allIds = idRes.data.values || [];
  let maxNumber = 0;
  for (let i = 1; i < allIds.length; i++) {
    const id = allIds[i][0];
    if (id && id.startsWith('#')) {
      const num = parseInt(id.substring(1), 10);
      if (!isNaN(num) && num > maxNumber) maxNumber = num;
    }
  }

  const ticketID = `#${String(maxNumber + 1).padStart(5, '0')}`;
  const createdDate = formatDateIST();

  await sheets.spreadsheets.values.append({
    spreadsheetId, range: `${SHEET_NAME}!A:H`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[ticketID, req.user.name, AssignedTo, Issue, "Pending", createdDate, "", photoUrl]]
    }
  });

  invalidateHelpCache();
  res.json({ ok: true, ticketID });
}));

// ======================================================
// GET CREATED TICKETS
// ======================================================
router.get("/created", auth, asyncHandler(async (req, res) => {
  const rows = await readHelpSheet();
  const tickets = rows.filter(r => r[1] === req.user.name).map(mapHelpTicket);
  res.json(tickets);
}));

// ======================================================
// GET ASSIGNED TICKETS
// ======================================================
router.get("/assigned", auth, asyncHandler(async (req, res) => {
  const rows = await readHelpSheet();
  const tickets = rows.filter(r => r[2] === req.user.name).map(mapHelpTicket);
  res.json(tickets);
}));

// ======================================================
// GET ALL TICKETS WITH FILTERS
// ======================================================
router.get("/all", auth, asyncHandler(async (req, res) => {
  const { assignedTo, createdBy, status } = req.query;
  const rows = await readHelpSheet();

  const tickets = rows.filter(r => {
    let ok = true;
    if (assignedTo) ok = ok && r[2] === assignedTo;
    if (createdBy) ok = ok && r[1] === createdBy;
    if (status) ok = ok && r[4] === status;
    return ok;
  }).map(mapHelpTicket);

  res.json({ ok: true, tickets });
}));

// ======================================================
// FILTER TICKETS BY WEEK/MONTH
// ======================================================
router.get("/filter", auth, asyncHandler(async (req, res) => {
  const { month, week, selectedName } = req.query;
  if (!month || !week) return res.status(400).json({ error: "Month and Week are required" });

  const rows = await readHelpSheet();
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
      tickets.push(mapHelpTicket(r));
    });

    return {
      total, pending, completed, delayed,
      pendingPercentage: total ? ((pending / total) * 100).toFixed(2) : "0.00",
      delayedPercentage: completed ? ((delayed / completed) * 100).toFixed(2) : "0.00",
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

// ======================================================
// UPDATE STATUS
// ======================================================
router.patch("/status/:ticketID", auth, asyncHandler(async (req, res) => {
  const { Status } = req.body;
  if (!Status) return res.status(400).json({ error: "Status required" });

  const rows = await readHelpSheet();
  const index = rows.findIndex(r => r[0] === req.params.ticketID);
  if (index === -1) return res.status(404).json({ error: "Ticket not found" });

  const ticket = rows[index];
  ticket[4] = Status;
  ticket[6] = Status === "Done" ? formatDateIST() : "";

  const sheets = await getSheets();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID_HELPTICKET;
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${SHEET_NAME}!A${index + 2}:H${index + 2}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [ticket] }
  });

  invalidateHelpCache();
  res.json({ ok: true });
}));

module.exports = router;