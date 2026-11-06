// Regression for the mixed-EOL edit failure: matching must be line-ending
// insensitive, while every byte outside the matched region keeps its own EOL.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { editTool } = require("../dist/edit.js");

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

const base = path.join(os.tmpdir(), "enctools-edit-eol-" + Date.now());
fs.mkdirSync(base, { recursive: true });
const write = (name, text) => {
  const p = path.join(base, name);
  fs.writeFileSync(p, text);
  return p;
};
const run = (p, oldString, newString, extra) => editTool({ path: p, oldString, newString, ...(extra || {}) }, base);

// A file whose middle lines are LF-only inside an otherwise CRLF file, exactly
// like the repro (Device\ArcMap\*ViewService.cpp).
const MIXED =
  "void f() {\r\n" +
  "    KEEP_LF();\n" +
  "    A();\n" +
  "    B();\n" +
  "    C();\r\n" +
  "}\r\n";

const OLD_LF = "    A();\n    B();"; // written with LF, no trailing newline
const NEW = "    //REPRO_OK";

(async () => {
  {
    const p = write("mixed.cpp", MIXED);
    let res;
    t("mixed file: LF oldString across LF-only lines now matches", () => {
      res = run(p, OLD_LF, NEW);
      assert.strictEqual(res.metadata.replacements, 1);
    });
    t("mixed file: untouched LF line stays LF, CRLF stays CRLF", () => {
      const got = fs.readFileSync(p, "utf8");
      assert.ok(got.includes("{\r\n    KEEP_LF();\n"), JSON.stringify(got));
      assert.ok(got.includes("\n    C();\r\n}\r\n"), JSON.stringify(got));
      assert.ok(got.includes("    //REPRO_OK\n"), JSON.stringify(got));
    });
  }

  {
    const p = write("crlf.cpp", MIXED.replace(/(?<!\r)\n/g, "\r\n"));
    t("pure CRLF file: LF oldString still matches", () => {
      const res = run(p, OLD_LF, NEW);
      assert.strictEqual(res.metadata.replacements, 1);
    });
  }

  {
    const p = write("lf.cpp", MIXED.replace(/\r\n/g, "\n"));
    t("pure LF file: CRLF oldString still matches", () => {
      const res = run(p, "    A();\r\n    B();", NEW);
      assert.strictEqual(res.metadata.replacements, 1);
    });
  }

  {
    const p = write("mixed_trailing.cpp", MIXED);
    t("oldString ending in an LF-only newline matches", () => {
      const res = run(p, "    A();\n", "    //ONE\n");
      assert.strictEqual(res.metadata.replacements, 1);
      assert.ok(fs.readFileSync(p, "utf8").includes("    //ONE\n    B();\n"));
    });
  }

  {
    // Two identical matches, one in a CRLF region and one in an LF region:
    // inserted newlines must adopt each region's local style.
    const p = write(
      "mixed_all.cpp",
      "    A();\r\n    B();\r\n" + "    X();\r\n" + "    A();\n    B();\n",
    );
    t("replaceAll: each region keeps its own EOL, including inserted lines", () => {
      const res = run(p, OLD_LF, "    N1();\n    N2();", { replaceAll: true });
      assert.strictEqual(res.metadata.replacements, 2);
      const got = fs.readFileSync(p, "utf8");
      assert.ok(got.includes("    N1();\r\n    N2();\r\n    X();\r\n"), "CRLF region:\n" + JSON.stringify(got));
      assert.ok(got.includes("    X();\r\n    N1();\n    N2();\n"), "LF region:\n" + JSON.stringify(got));
    });
  }

  {
    const p = write("miss.cpp", MIXED);
    t("a real mismatch still reports the exact-match error", () => {
      assert.throws(() => run(p, "    NOPE();", NEW), /Could not find oldString/);
    });
  }

  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
