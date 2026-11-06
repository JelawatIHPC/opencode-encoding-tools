// Regression: a directory junction (or symlink) inside the scanned tree must
// not be read as a file. On Windows a junction reports
// isDirectory() === false / isSymbolicLink() === true, so an unguarded scanner
// handed it to readFileSync and threw EISDIR, aborting the whole search.
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

const stamp = Date.now();
const base = path.join(os.tmpdir(), "enctools-grep-junction-" + stamp);
const real = path.join(base, "real");
const link = path.join(base, "link");
// Target lives OUTSIDE the searched tree, so a match would only come from
// following the junction.
const target = path.join(os.tmpdir(), "enctools-grep-target-" + stamp);
const only = path.join(os.tmpdir(), "enctools-grep-only-" + stamp);

fs.mkdirSync(real, { recursive: true });
fs.mkdirSync(target, { recursive: true });
fs.mkdirSync(only, { recursive: true });
fs.writeFileSync(path.join(real, "a.txt"), "alpha\nneedle here\nbeta\n", "utf8");
fs.writeFileSync(path.join(target, "secret.txt"), "needle in junction target\n", "utf8");
fs.symlinkSync(target, link, "junction");
fs.symlinkSync(target, path.join(only, "link"), "junction");

(async () => {
  const res = await grepTool({ pattern: "needle" }, base);
  t("search across a tree containing a junction does not throw", () => {
    assert.ok(res && typeof res.output === "string");
  });
  t("finds the real file", () => {
    assert.ok(res.output.includes("a.txt"), "expected a.txt in:\n" + res.output);
  });
  t("does not follow the junction (ripgrep default)", () => {
    assert.ok(!res.output.includes("secret.txt"), "junction target should be skipped:\n" + res.output);
  });
  t("metadata reports exactly one match", () => {
    assert.strictEqual(res.metadata.matches, 1);
  });

  const res2 = await grepTool({ pattern: "needle" }, only);
  t("junction as the only entry: empty result instead of EISDIR", () => {
    assert.strictEqual(res2.metadata.matches, 0);
  });

  try { fs.rmdirSync(link); } catch {}
  try { fs.rmdirSync(path.join(only, "link")); } catch {}
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(only, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}

  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
