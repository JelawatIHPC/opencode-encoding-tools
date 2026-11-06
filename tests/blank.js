const fs = require("fs"), path = require("path");
const P = require("../dist/patch.js");
const D = path.join(require("os").tmpdir(), "enctools-tests", "blanktest");
fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(D, { recursive: true });

function run(label, patch) {
  fs.writeFileSync(path.join(D, "b.txt"), "X\n\nY\n", "utf8");
  try { const r = P.patchTool({ patchText: patch }, D); console.log(label + ": " + r.output.split("\n").join(" | ") + "  => " + JSON.stringify(fs.readFileSync(path.join(D, "b.txt"), "utf8"))); }
  catch (e) { console.log(label + ": THROW " + e.message.split("\n")[0]); }
}

// blank context line WITH the required single-space prefix
run("space-prefixed blank ctx", "*** Begin Patch\n*** Update File: b.txt\n@@\n X\n \n-Y\n+Z\n*** End Patch");

// blank context line with NO prefix (model forgot the leading space)
run("unprefixed blank ctx", "*** Begin Patch\n*** Update File: b.txt\n@@\n X\n\n-Y\n+Z\n*** End Patch");
