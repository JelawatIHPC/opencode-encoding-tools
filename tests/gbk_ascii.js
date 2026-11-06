// Behavior when an explicit GBK charset is passed for a pure-ASCII file.
const fs = require("fs");
const path = require("path");
const E = require("../dist/edit.js");
const W = require("../dist/write.js");
const P = require("../dist/patch.js");
const R = require("../dist/read.js");

const D = path.join(require("os").tmpdir(), "enctools-tests", "gbktest");
fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(D, { recursive: true });
const J = (f) => path.join(D, f);
const hex = (f) => [...fs.readFileSync(J(f))].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const summary = (r) => "charset=" + (r.metadata && r.metadata.charset) + " warn=" + !!(r.metadata && (r.metadata.warning || r.metadata.charsetWarnings)) + " output=" + JSON.stringify(r.output.split("\n")[0]);

function attempt(label, fn) {
  try { fn(); console.log(label + ": OK"); }
  catch (e) { console.log(label + ": THROW -> " + e.message.split("\n")[0]); }
}

// 1) read an ASCII file with charset=gbk
fs.writeFileSync(J("a.txt"), "hello world\n", "utf8");
{
  const r = R.readTool({ filePath: "a.txt", charset: "gbk" }, D);
  console.log("read gbk: " + summary(r) + " charsetInMeta=" + r.metadata.charset);
}

// 2) edit ASCII file, same-length ASCII replacement, charset=gbk
fs.writeFileSync(J("a.txt"), "hello world\n", "utf8");
{
  const r = E.editTool({ path: "a.txt", oldString: "world", newString: "there", charset: "gbk" }, D);
  console.log("edit ascii->ascii: " + summary(r) + " bytes=[" + hex("a.txt") + "] text=" + JSON.stringify(fs.readFileSync(J("a.txt"), "utf8")));
}

// 3) edit ASCII file introducing Chinese, charset=gbk
fs.writeFileSync(J("a.txt"), "hello world\n", "utf8");
{
  const r = E.editTool({ path: "a.txt", oldString: "world", newString: "世界", charset: "gbk" }, D);
  console.log("edit ascii->cjk: " + summary(r) + " bytes=[" + hex("a.txt") + "]");
  console.log("  re-decode as gb18030 = " + JSON.stringify(require("iconv-lite").decode(fs.readFileSync(J("a.txt")), "gb18030")));
}

// 4) edit ASCII file introducing an unrepresentable char (emoji), charset=gbk
fs.writeFileSync(J("a.txt"), "hello world\n", "utf8");
attempt("edit ascii->emoji (gbk)", () => E.editTool({ path: "a.txt", oldString: "world", newString: "a😀b", charset: "gbk" }, D));

// 5) patch update ASCII file, charset=gbk
fs.writeFileSync(J("b.txt"), "KEEP\nOLD\n", "utf8");
{
  const pt = ["*** Begin Patch", "*** Update File: b.txt", "@@", " KEEP", "-OLD", "+NEW", "*** End Patch"].join("\n") + "\n";
  const r = P.patchTool({ patchText: pt, charset: "gbk" }, D);
  console.log("patch update gbk: charset(files)=" + (r.metadata.files[0] && r.metadata.files[0].encoding) + " warn=" + !!r.metadata.charsetWarnings + " bytes=[" + hex("b.txt") + "]");
}

// 6) patch add new file, charset=gbk, ascii content
{
  const pt = ["*** Begin Patch", "*** Add File: c.txt", "+new ascii file", "*** End Patch"].join("\n") + "\n";
  const r = P.patchTool({ patchText: pt, charset: "gbk" }, D);
  console.log("patch add gbk: warn=" + !!r.metadata.charsetWarnings + " bytes=[" + hex("c.txt") + "]");
}

// 7) write new file with charset=gbk, ascii content
{
  const r = W.writeTool({ filePath: "d.txt", content: "plain\n", charset: "gbk" }, D);
  console.log("write gbk: " + summary(r) + " bytes=[" + hex("d.txt") + "]");
}
