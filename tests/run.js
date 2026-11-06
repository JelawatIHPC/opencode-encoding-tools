// Runner for the mirror test suite: executes every test script in this folder
// and reports pass/fail by exit code. Run from the mirror root: `npm test`.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".js") && f !== "run.js")
  .sort();

let pass = 0;
let fail = 0;
for (const f of files) {
  try {
    const out = execFileSync(process.execPath, [path.join(dir, f)], { timeout: 180000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const last = (out.trim().split(/\r?\n/).pop() || "").trim();
    console.log("PASS " + f.padEnd(26) + " | " + last.slice(0, 100));
    pass++;
  } catch (e) {
    const last = (String(e.stdout || "").trim().split(/\r?\n/).pop() || "").trim();
    console.log("FAIL " + f.padEnd(26) + " | " + (e.status === null ? "TIMEOUT" : "exit " + e.status) + " | " + last.slice(0, 100));
    fail++;
  }
}
console.log("\n" + pass + " test file(s) passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
