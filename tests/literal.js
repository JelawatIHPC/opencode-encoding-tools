const fs = require("fs"), path = require("path");
const E = require("../dist/edit.js");
const D = path.join(require("os").tmpdir(), "enctools-tests", "spectest2");
fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(D, { recursive: true });

// oldString containing regex metacharacters and `$` must match literally.
const olds = ["a.b", "a+b", "x(y)[z]", "$$", "$&", "$1", "a|b", "foo?bar"];
let ok = 0, bad = 0;
olds.forEach((o, i) => {
  const f = "m" + i + ".txt";
  fs.writeFileSync(path.join(D, f), "PRE\n" + o + "\nPOST\n", "utf8");
  try {
    E.editTool({ path: f, oldString: o, newString: "REPLACED" }, D);
    const txt = fs.readFileSync(path.join(D, f), "utf8");
    const good = txt === "PRE\nREPLACED\nPOST\n";
    if (good) { ok++; console.log("PASS literal oldString " + JSON.stringify(o)); }
    else { bad++; console.log("FAIL " + JSON.stringify(o) + " -> " + JSON.stringify(txt)); }
  } catch (e) { bad++; console.log("FAIL " + JSON.stringify(o) + " THROW " + e.message); }
});
// A file NOT containing the literal (but matching as regex) must not match.
fs.writeFileSync(path.join(D, "no.txt"), "aXb\n", "utf8");
try { E.editTool({ path: "no.txt", oldString: "a.b", newString: "HIT" }, D); bad++; console.log("FAIL a.b matched aXb (regex leak)"); }
catch { ok++; console.log("PASS a.b did not match aXb"); }
console.log(ok + " passed, " + bad + " failed");
process.exit(bad ? 1 : 0);
