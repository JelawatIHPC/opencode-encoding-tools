// patch: inserted lines adopt the target file's dominant EOL, while existing
// lines keep their own terminator (a mixed file must not be flattened).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { patchTool } = require("../dist/patch.js");

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

const base = path.join(os.tmpdir(), "enctools-patch-eol-" + Date.now());
fs.mkdirSync(base, { recursive: true });

// Build the patch with a chosen separator so we can test cross-style patches.
const mkPatch = (file, nl) =>
  [
    "*** Begin Patch",
    `*** Update File: ${file}`,
    "@@",
    " A();",
    "-B();",
    "+B2();",
    "+B3();",
    " C();",
    "*** End Patch",
  ].join(nl) + nl;

(async () => {
  {
    const p = path.join(base, "crlf.cpp");
    fs.writeFileSync(p, "A();\r\nB();\r\nC();\r\n");
    t("CRLF file + LF patch text => inserted lines are CRLF", () => {
      patchTool({ patchText: mkPatch("crlf.cpp", "\n") }, base);
      assert.strictEqual(fs.readFileSync(p, "utf8"), "A();\r\nB2();\r\nB3();\r\nC();\r\n");
    });
  }

  {
    const p = path.join(base, "lf.cpp");
    fs.writeFileSync(p, "A();\nB();\nC();\n");
    t("LF file + CRLF patch text => inserted lines are LF", () => {
      patchTool({ patchText: mkPatch("lf.cpp", "\r\n") }, base);
      assert.strictEqual(fs.readFileSync(p, "utf8"), "A();\nB2();\nB3();\nC();\n");
    });
  }

  {
    // Mixed file: the untouched LF-only line must survive unchanged. Its
    // content must be part of the hunk context or the hunk is not contiguous.
    const p = path.join(base, "mixed.cpp");
    fs.writeFileSync(p, "A();\r\nLF_KEEP();\nB();\r\nC();\r\n");
    const mixedPatch =
      [
        "*** Begin Patch",
        "*** Update File: mixed.cpp",
        "@@",
        " A();",
        " LF_KEEP();",
        "-B();",
        "+B2();",
        "+B3();",
        " C();",
        "*** End Patch",
      ].join("\n") + "\n";
    t("mixed file: patch does not flatten existing LF-only lines", () => {
      patchTool({ patchText: mixedPatch }, base);
      const got = fs.readFileSync(p, "utf8");
      assert.ok(got.includes("A();\r\nLF_KEEP();\nB2();\r\nB3();\r\nC();\r\n"), JSON.stringify(got));
      assert.strictEqual((got.match(/\n/g) || []).length - (got.match(/\r\n/g) || []).length, 1, "exactly one LF-only line expected");
    });
  }

  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
