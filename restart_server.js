// Server restart helper: 5000 par chal raha purana process kill karke server.js naye code ke saath start karta hai.
const { execSync, spawn } = require("child_process");
const fs = require("fs");
try {
  const out = execSync(
    `powershell -NoProfile -Command "$c = Get-NetTCPConnection -State Listen -LocalPort 5000 -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force; Write-Output ('KILLED ' + $c.OwningProcess) } else { Write-Output 'NO_LISTENER' }"`,
    { encoding: "utf8" }
  );
  console.log(out.trim());
} catch (e) {
  console.log("KILL_ERR " + e.message);
}
setTimeout(() => {
  const log = fs.openSync(require("path").join(__dirname, "server_live.log"), "a");
  const child = spawn("node", ["server.js"], { cwd: __dirname, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  console.log("SPAWNED server.js (log: server_live.log)");
  setTimeout(() => process.exit(0), 1000);
}, 3000);
