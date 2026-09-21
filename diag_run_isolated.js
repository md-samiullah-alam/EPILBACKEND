// TEMP: isolated verification — naya training.js code ek alag port (5001) par chala kar
// diag_desig_match.js ko usi server ke against run karta hai, phir server band kar deta hai.
const { spawn } = require("child_process");
const path = require("path");

const server = spawn(process.execPath, [path.join(__dirname, "diag_launch_training.js")], {
  cwd: __dirname,
  env: { ...process.env, PORT: "5001" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOut = "";
server.stdout.on("data", (d) => { serverOut += d.toString(); });
server.stderr.on("data", (d) => { serverOut += d.toString(); });

const waitReady = () =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (serverOut.includes("DIAG TRAINING SERVER READY") || serverOut.includes("Error") || Date.now() - t0 > 20000) return resolve();
      setTimeout(tick, 400);
    };
    tick();
  });

(async () => {
  await waitReady();
  const child = spawn(process.execPath, [path.join(__dirname, "diag_desig_match.js")], {
    cwd: __dirname,
    env: { ...process.env, DIAG_BASE: "http://localhost:5001/api" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagOut = "";
  child.stdout.on("data", (d) => { diagOut += d.toString(); });
  child.stderr.on("data", (d) => { diagOut += d.toString(); });
  await new Promise((r) => child.on("exit", r));
  require("fs").writeFileSync(
    path.join(__dirname, "diag_isolated_server_log.txt"),
    "=== SERVER OUT ===\r\n" + serverOut + "\r\n=== DIAG OUT ===\r\n" + diagOut,
    "utf8"
  );
  server.kill();
  process.exit(0);
})();
