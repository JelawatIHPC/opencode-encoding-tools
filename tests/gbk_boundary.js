const fs = require("fs"), path = require("path");
const E = require("../dist/edit.js");
const D = path.join(require("os").tmpdir(), "enctools-tests", "gbktest2");
fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(D, { recursive: true });
const J = (f) => path.join(D, f);

function attempt(label, fn) {
  try { fn(); console.log(label + ": OK"); }
  catch (e) { console.log(label + ": THROW -> " + e.message.split("\n")[0]); }
}

// A) pure ASCII file, explicit gbk  -> accepted (definite=false)
fs.writeFileSync(J("ascii.txt"), "hello world\n", "utf8");
attempt("A pure-ASCII + charset=gbk", () => console.log("   " + JSON.stringify(E.editTool({ path: "ascii.txt", oldString: "world", newString: "there", charset: "gbk" }, D).metadata.charset)));

// B) non-ASCII strict UTF-8 file, explicit gbk -> definite=true, mismatch => hard error
fs.writeFileSync(J("utf8.txt"), "你好 world\n", "utf8");
attempt("B UTF-8(非ASCII) + charset=gbk", () => E.editTool({ path: "utf8.txt", oldString: "world", newString: "there", charset: "gbk" }, D));

// C) UTF-8 BOM + ASCII, explicit gbk -> definite=true (bom) => hard error
fs.writeFileSync(J("bom.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello world\n", "utf8")]));
attempt("C UTF-8 BOM + charset=gbk", () => E.editTool({ path: "bom.txt", oldString: "world", newString: "there", charset: "gbk" }, D));

// D) pure ASCII + charset=windows-1252, add Chinese -> accepted request, but unrepresentable => hard error
fs.writeFileSync(J("win.txt"), "hello world\n", "utf8");
attempt("D pure-ASCII + charset=windows-1252 + 中文", () => E.editTool({ path: "win.txt", oldString: "world", newString: "世界", charset: "windows-1252" }, D));
