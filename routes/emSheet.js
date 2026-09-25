const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const { getSheets } = require("../googleSheetsClient");

// ============================================================
// EM SHEET API - EXACT SHEET STRUCTURE
// ============================================================
router.get("/em-sheet", auth, asyncHandler(async (req, res) => {
  try {
    const SHEET_ID = process.env.GOOGLE_SHEET_ID_EMSHEET;
    if (!SHEET_ID) {
      return res.status(500).json({ error: "GOOGLE_SHEET_ID_EMSHEET is not configured in .env" });
    }
    const SHEET_NAME = process.env.EM_SHEET_TAB_NAME || "EM SHEET WITH RITEH SIR";
    
    console.log("📊 Fetching EM Sheet data...");

    const sheets = await getSheets();
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:M1000`,
    });

    const rows = response.data.values || [];

    if (rows.length === 0) {
      return res.status(404).json({ error: "No data found in the sheet" });
    }

    console.log(`📊 Total rows fetched: ${rows.length}`);
    console.log("📊 First row (headers):", rows[0]);

    // EXACT Column mapping as per your sheet
    const colIndex = {
      no: 0,                    // A - NO
      doerName: 1,              // B - DOER NAME
      totalTaskWithout: 2,      // C - TOTAL NO.OF TASK
      pendingTaskWithout: 3,    // D - PENDING TASK
      percentWithout: 4,        // E - %
      emRepetitionWithout: 5,   // F - EM REPETITION COUNTS
      nextTargetWithout: 6,     // G - NEXT TARGET
      totalTaskDelegation: 7,   // H - TOTAL NO.OF TASK
      pendingTaskDelegation: 8, // I - PENDING TASK
      percentDelegation: 9,     // J - %
      emRepetitionDelegation: 10, // K - EM REPETITION COUNTS
      nextTargetDelegation: 11, // L - NEXT TARGET
      emDoer: 12                // M - EM DOER
    };
    
console.log("Rows Data: ", rows);

    // Parse data rows (skip header row at index 0)
    const dataRows = rows.slice(1);
    const result = {
      weekInfo: rows[0]||"",
      employees: [],
      footer: []
    };

    let isFooter = false;

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      if (!row || row.length === 0) continue;

      const doerName = row[colIndex.doerName] ? row[colIndex.doerName].trim() : "";

      // ⭐ Check for week info row - EXACT match
      if (doerName && doerName.includes("WEEK NO.")) {
        result.weekInfo = doerName;
        console.log(`📊 Week Info found: ${doerName}`);
        continue;
      }

      // Check for footer section
      if (doerName && doerName.includes("TOTAL DOER")) {
        isFooter = true;
        console.log(`📊 Footer section found`);
        
        for (let j = i; j < Math.min(i + 6, dataRows.length); j++) {
          const footerRow = dataRows[j];
          if (footerRow && footerRow.length > 1) {
            const label = footerRow[colIndex.doerName] ? footerRow[colIndex.doerName].trim() : "";
            const value = footerRow[colIndex.totalTaskWithout] ? footerRow[colIndex.totalTaskWithout].trim() : "";
            if (label) {
              result.footer.push({ label, value });
            }
          }
        }
        break;
      }

      if (isFooter || !doerName) continue;

      const employee = {
        no: parseInt(row[colIndex.no]) || result.employees.length + 1,
        doerName: doerName,
        withoutDelegation: {
          totalTask: parseInt(row[colIndex.totalTaskWithout]) || 0,
          pendingTask: parseInt(row[colIndex.pendingTaskWithout]) || 0,
          percent: row[colIndex.percentWithout] || "0.00%",
          emRepetition: row[colIndex.emRepetitionWithout] || "",
          nextTarget: row[colIndex.nextTargetWithout] || ""
        },
        delegation: {
          totalTask: parseInt(row[colIndex.totalTaskDelegation]) || 0,
          pendingTask: parseInt(row[colIndex.pendingTaskDelegation]) || 0,
          percent: row[colIndex.percentDelegation] || "0.00%",
          emRepetition: row[colIndex.emRepetitionDelegation] || "",
          nextTarget: row[colIndex.nextTargetDelegation] || ""
        },
        emDoer: row[colIndex.emDoer] || "NO"
      };

      result.employees.push(employee);
    }

    console.log(`📊 Week Info: ${result.weekInfo}`);
    console.log(`📊 Total employees: ${result.employees.length}`);
    console.log(`📊 Footer items: ${result.footer.length}`);

    res.json({
      success: true,
      data: result,
      totalEmployees: result.employees.length
    });

  } catch (error) {
    console.error("❌ Error fetching EM Sheet:", error);
    res.status(500).json({ 
      error: "Failed to fetch EM Sheet data: " + (error.message || "Unknown error")
    });
  }
}));

module.exports = router;