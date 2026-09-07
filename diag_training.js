// Diagnostic: read MasterTemplateData + AQData and write a plain-text report to a file
require("dotenv").config();
const fs = require("fs");
const { getSheets } = require("./googleSheetsClient");

(async () => {
  const out = [];
  try {
    const sheets = await getSheets();
    const sid = process.env.GOOGLE_SHEET_ID_TRAINING;

    out.push("SPREADSHEET_ID=" + sid);
    out.push("");

    const meta = await sheets.spreadsheets.get({ spreadsheetId: sid });
    out.push("SHEETS:" + JSON.stringify(meta.data.sheets.map((s) => s.properties.title)));
    out.push("");

    const mt = await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: "MasterTemplateData!A1:I" });
    out.push("=== MasterTemplateData (A1:I) ===");
    mt.data.values.forEach((r, i) => out.push(`${i + 1}| ${JSON.stringify(r)}`));
    out.push("");

    const qa = await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: "AQData!A1:H" });
    out.push("=== AQData (A1:H) ===");
    qa.data.values.forEach((r, i) => out.push(`${i + 1}| ${JSON.stringify(r)}`));
  } catch (e) {
    out.push("ERROR: " + (e && e.message ? e.message : String(e)));
  }
  fs.writeFileSync("diag_training_out.txt", out.join("\r\n"), "utf8");
  console.log("DIAG DONE");
  process.exit(0);
})();