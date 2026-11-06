// Regression: files that are binary *by content* but not by extension (DICOM
// .dcm, .pdb, ...) must be skipped via a cheap head sniff and must NOT be
// charged to the read budget. BOM-tagged UTF-16 text must not be misclassified.
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

const base = path.join(os.tmpdir(), "enctools-grep-binary-" + Date.now());
fs.mkdirSync(base, { recursive: true });
fs.writeFileSync(path.join(base, "a.txt"), "alpha\nneedle here\n", "utf8");

// Binary by content, unknown extension. Contains the pattern as raw bytes too,
// so a text search must not report it.
const dcm = Buffer.alloc(3 * 1024 * 1024, 0);
Buffer.from("needle inside binary\n").copy(dcm, 1024);
fs.writeFileSync(path.join(base, "series.dcm"), dcm);

// UTF-16LE with BOM: contains NUL bytes but is text.
fs.writeFileSync(
  path.join(base, "u16.txt"),
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("needle utf16\n", "utf16le")]),
);

(async () => {
  const res = await grepTool({ pattern: "needle" }, base);
  t("finds real text files", () => {
    assert.ok(res.output.includes("a.txt"), "expected a.txt in:\n" + res.output);
  });
  t("finds BOM-tagged UTF-16 text (not misclassified as binary)", () => {
    assert.ok(res.output.includes("u16.txt"), "expected u16.txt in:\n" + res.output);
  });
  t("does not report matches inside the binary file", () => {
    assert.ok(!res.output.includes("series.dcm"), "binary must be skipped:\n" + res.output);
  });
  t("binary file is not charged to the read budget", () => {
    assert.strictEqual(res.metadata.filesRead, 2, "filesRead should count only the 2 text files");
    assert.strictEqual(res.metadata.budget.skippedBinary, 1);
  });
  t("bytesRead accounts for text files only (excludes the 3MB binary)", () => {
    const a = fs.statSync(path.join(base, "a.txt")).size;
    const u = fs.statSync(path.join(base, "u16.txt")).size;
    assert.strictEqual(res.metadata.bytesRead, a + u);
  });

  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
