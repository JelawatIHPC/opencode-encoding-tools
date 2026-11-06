// include= semantics: a glob without "/" matches the file name at any depth
// (ripgrep -g behaviour); a glob with "/" is relative to the searched root.
// Also: "the filter excluded everything" must not look like a genuine no-match.
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

const base = path.join(os.tmpdir(), "enctools-grep-include-" + Date.now());
fs.mkdirSync(path.join(base, "Code", "deeper"), { recursive: true });
fs.writeFileSync(path.join(base, "top.cpp"), "needle top\n", "utf8");
fs.writeFileSync(path.join(base, "top.h"), "needle header\n", "utf8");
fs.writeFileSync(path.join(base, "Code", "deep.cpp"), "needle deep\n", "utf8");
fs.writeFileSync(path.join(base, "Code", "deeper", "more.cpp"), "needle more\n", "utf8");
fs.writeFileSync(path.join(base, "Code", "note.txt"), "needle txt\n", "utf8");

const filesOf = (r) => new Set(r.output.split("\n").filter((l) => /^[A-Za-z]:.*:$/.test(l.trim())).map((l) => path.basename(l.trim().slice(0, -1))));

(async () => {
  const all = await grepTool({ pattern: "needle" }, base);
  t("no include: finds everything", () => {
    assert.strictEqual(all.metadata.matches, 5);
  });

  const cpp = await grepTool({ pattern: "needle", include: "*.cpp" }, base);
  t('include "*.cpp" is recursive (the reported bug)', () => {
    const got = filesOf(cpp);
    assert.deepStrictEqual([...got].sort(), ["deep.cpp", "more.cpp", "top.cpp"]);
  });

  const h = await grepTool({ pattern: "needle", include: "*.h" }, base);
  t('include "*.h" finds the header', () => {
    assert.deepStrictEqual([...filesOf(h)], ["top.h"]);
  });

  const scoped = await grepTool({ pattern: "needle", include: "Code/*.cpp" }, base);
  t('include "Code/*.cpp" stays in that directory', () => {
    assert.deepStrictEqual([...filesOf(scoped)], ["deep.cpp"]);
  });

  const starred = await grepTool({ pattern: "needle", include: "Code/**/*.cpp" }, base);
  t('include "Code/**/*.cpp" is recursive within Code', () => {
    assert.deepStrictEqual([...filesOf(starred)].sort(), ["deep.cpp", "more.cpp"]);
  });

  const none = await grepTool({ pattern: "needle", include: "*.zzz" }, base);
  t("a filter that matches nothing says so instead of a bare 'No files found'", () => {
    assert.ok(/matched none of the \d+ file\(s\) scanned/.test(none.output), "output was:\n" + none.output);
    assert.ok(none.output.includes('"*.zzz"'), none.output);
    assert.strictEqual(none.metadata.includeMatched, 0);
    assert.ok(none.metadata.includeFiltered > 0);
  });

  const realMiss = await grepTool({ pattern: "zzz_absent_zzz" }, base);
  t("a genuine no-match still reads 'No files found'", () => {
    assert.strictEqual(realMiss.output, "No files found");
  });

  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
