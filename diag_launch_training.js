// TEMP diag launcher: sirf training + employee routes ek alag port (5001) par chalata hai.
// Poora server.js intentionally use nahi kiya — usme cron/auto-generate side effects hote hain.
require("dotenv").config();
const express = require("express");
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use("/api/employee", require("./routes/employee"));
app.use("/api/training", require("./routes/training"));
app.use(require("./middleware/errorHandler"));
const PORT = 5001;
app.listen(PORT, () => console.log("DIAG TRAINING SERVER READY ON " + PORT));
