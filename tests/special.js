// Stress-test the encoding tools for characters that JS APIs treat specially
// (`$` in String.replace, regex metacharacters, leading diff prefixes, tabs,
// trailing spaces, empty lines, CRLF, unicode).
const fs = require("fs");
const path = require("path");
const E = require("../dist/edit.js");
const W = require("../dist/write.js");
const P = require("../dist/patch.js");

const D = path.join(require("os").tmpdir(), "enctools-tests", "spectest");
fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(D, { recursive: true });

let pass = 0, fail = 0;
const norm = (s) => s.replace(/\r\n/g, "\n");
function check(label, got, exp) {
  if (got === exp) { pass++; console.log("PASS " + label); }
  else { fail++; console.log("FAIL " + label + "\n  got=" + JSON.stringify(got) + "\n  exp=" + JSON.stringify(exp)); }
}

const CASES = [
  "dollar $$ eq $& grp $1 back $` right $' brace ${x}",
  "caret ^ bracket [a] paren (b) star * plus + qmark ? pipe |",
  "backslash \\ slash / percent %",
  "tab\tinside",
  "trailing spaces   ",
  "unicode 中文 emoji 😀 nbsp\u00a0end",
  "literal \\n and \\r and \\t sequences",
  "quote \"double\" and 'single'",
];

// ---- edit ----
for (let i = 0; i < CASES.length; i++) {
  const f = "e" + i + ".txt";
  const nw = CASES[i];
  fs.writeFileSync(path.join(D, f), "ANCHOR\nrest\n", "utf8");
  try { E.editTool({ path: f, oldString: "ANCHOR", newString: nw }, D); }
  catch (e) { check("edit#" + i, "THROW " + e.message, nw); continue; }
  const got = fs.readFileSync(path.join(D, f), "utf8").split("\n")[0];
  check("edit#" + i, got, nw);
}

// ---- write ----
for (let i = 0; i < CASES.length; i++) {
  const f = "w" + i + ".txt";
  const c = CASES[i] + "\nsecond\n";
  W.writeTool({ filePath: f, content: c }, D);
  const got = fs.readFileSync(path.join(D, f), "utf8");
  check("write#" + i, norm(got), c);
}

// ---- patch: add file ----
const addLines = [
  "dollar $$ eq $& grp $1 back $` right $' brace ${x}",
  "",
  "+leading plus",
  "-leading minus",
  " leading space",
  "*** Begin Patch",
  "*** End Patch",
  "@@ looks like header",
  "trailing spaces   ",
  "tab\tinside | amp & lt < gt >",
  "unicode 中文 😀",
];
const addPatch = ["*** Begin Patch", "*** Add File: added.txt", ...addLines.map((l) => "+" + l), "*** End Patch"].join("\n") + "\n";
try {
  P.patchTool({ patchText: addPatch }, D);
  const got = norm(fs.readFileSync(path.join(D, "added.txt"), "utf8"));
  check("patch-add", got, addLines.join("\n") + "\n");
} catch (e) { check("patch-add", "THROW " + e.message, addLines.join("\n") + "\n"); }

// ---- patch: update file ----
const oldLines = ["KEEP1", "ORIGINAL", "KEEP2"];
fs.writeFileSync(path.join(D, "upd.txt"), oldLines.join("\n") + "\n", "utf8");
const newLines = [
  "KEEP1",
  "new $$ $& $1 line",
  "+plus line",
  "-minus line",
  " space line",
  "@@ at line",
  "*** marker line",
  "trailing   ",
  "newline\t tab",
  "",
  "KEEP2",
];
const updPatch = [
  "*** Begin Patch",
  "*** Update File: upd.txt",
  "@@",
  " KEEP1",
  "-ORIGINAL",
  ...newLines.slice(1, -1).map((l) => "+" + l),
  " KEEP2",
  "*** End Patch",
].join("\n") + "\n";
try {
  P.patchTool({ patchText: updPatch }, D);
  const got = norm(fs.readFileSync(path.join(D, "upd.txt"), "utf8"));
  check("patch-update", got, newLines.join("\n") + "\n");
} catch (e) { check("patch-update", "THROW " + e.message, newLines.join("\n") + "\n"); }

// ---- patch: update preserving a CRLF file ----
fs.writeFileSync(path.join(D, "crlf.txt"), "A\r\nB\r\nC\r\n", "utf8");
const crlfPatch = ["*** Begin Patch", "*** Update File: crlf.txt", "@@", " B", "-C", "+C $$ $1 \\ done", "*** End Patch"].join("\n") + "\n";
try {
  P.patchTool({ patchText: crlfPatch }, D);
  const got = fs.readFileSync(path.join(D, "crlf.txt"), "utf8");
  check("patch-crlf", got, "A\r\nB\r\nC $$ $1 \\ done\r\n");
} catch (e) { check("patch-crlf", "THROW " + e.message, "A\r\nB\r\nC $$ $1 \\ done\r\n"); }

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
