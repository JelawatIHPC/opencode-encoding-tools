// The only remaining budget is wall-clock time, and a run that stops early must
// say so — both when it has matches and when it has none.
process.env.ENCTOOLS_GREP_TIME_BUDGET_MS = "30";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { grepTool } = require("../dist/grep.js");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ok   " + name);
  } catch (e) {
    fail++;
    console.log("  FAIL " + name + ": " + e.message);
  }
}

const base = path.join(os.tmpdir(), "enctools-grep-timeout-" + Date.now());
// Enough directories that a 30ms budget cannot finish them all.
for (let i = 0; i < 200; i++) {
  const d = path.join(base, "d" + String(i).padStart(3, "0"));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "a.txt"), "needle\n", "utf8");
}

(async () => {
  const res = await grepTool({ pattern: "needle" }, base);
  t("reports the reason in the output when matches were found", () => {
    assert.ok(/Search was cut short — timed out after \d+ms/.test(res.output), "output was:\n" + res.output);
  });
  t("flags the timeout in metadata", () => {
    assert.strictEqual(res.metadata.budgetHit, true);
    assert.strictEqual(res.metadata.budget.timedOut, true);
  });
  t("returns the partial matches it did find", () => {
    assert.ok(res.metadata.matches > 0);
  });

  const none = await grepTool({ pattern: "zzz_absent_zzz" }, base);
  t("reports the reason when there were no matches at all", () => {
    assert.ok(
      /^No matches — search was cut short \(timed out after \d+ms; scanned \d+ file\(s\), read \d+\)/.test(none.output),
      "output was:\n" + none.output,
    );
  });

  const quick = path.join(os.tmpdir(), "enctools-grep-quick-" + Date.now());
  fs.mkdirSync(quick, { recursive: true });
  fs.writeFileSync(path.join(quick, "a.txt"), "needle\n", "utf8");
  const ok = await grepTool({ pattern: "needle" }, quick);
  t("complete search stays quiet", () => {
    assert.strictEqual(ok.metadata.budgetHit, false);
    assert.ok(!ok.output.includes("cut short"), ok.output);
    assert.ok(ok.output.includes("Found 1 matches"));
  });

  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(quick, { recursive: true, force: true }); } catch {}
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
