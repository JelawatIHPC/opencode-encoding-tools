// charset="utf8bom" is UTF-8 plus a BOM: a new file gets one, and writing over
// an existing UTF-8 file without a BOM adds one with a warning. Plain "utf8"
// keeps the current BOM state, so the two names are not interchangeable.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const iconv = require("iconv-lite");
const { writeTool } = require("../dist/write.js");
const { editTool } = require("../dist/edit.js");
const { patchTool } = require("../dist/patch.js");
const { readTool } = require("../dist/read.js");
const { normalizeCharsetParam, requestsUtf8Bom } = require("../dist/charset.js");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ok   " + name);
  } catch (e) {
    fail++;
    console.log("  FAIL " + name + ": " + (e && e.message));
  }
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const dir = path.join(os.tmpdir(), "enctools-utf8bom-" + Date.now());
fs.mkdirSync(dir, { recursive: true });
const p = (n) => path.join(dir, n);
const bytes = (f) => fs.readFileSync(f);
const hasBom = (f) => bytes(f).subarray(0, 3).equals(BOM);
const utf8Body = (f) => bytes(f).subarray(3).toString("utf8");
const lf = (s) => s.replace(/\r\n/g, "\n");
const BOM_WARNING = /Warning: charset="utf8bom" was requested, so a UTF-8 BOM was added/;

function expectThrow(fn, re) {
  try {
    fn();
  } catch (e) {
    assert.ok(re.test(e.message), "unexpected message: " + e.message);
    return e;
  }
  assert.fail("expected an error, but the call succeeded");
}

(() => {
  t('normalizeCharsetParam maps utf8bom to utf8; requestsUtf8Bom keeps the spelling', () => {
    assert.strictEqual(normalizeCharsetParam("utf8bom"), "utf8");
    assert.strictEqual(normalizeCharsetParam("UTF-8-BOM"), "utf8");
    assert.strictEqual(normalizeCharsetParam("utf-8-sig"), "utf8");
    assert.strictEqual(normalizeCharsetParam("UTF_8_SIG"), "utf8");
    assert.strictEqual(requestsUtf8Bom("utf8bom"), true);
    assert.strictEqual(requestsUtf8Bom("UTF-8-BOM"), true);
    assert.strictEqual(requestsUtf8Bom("utf-8-sig"), true);
    assert.strictEqual(requestsUtf8Bom("utf_8_sig"), true);
    assert.strictEqual(requestsUtf8Bom("utf-8"), false);
    assert.strictEqual(requestsUtf8Bom(undefined), false);
  });

  t('write creates a new UTF-8 BOM file with charset="utf8bom" and no warning', () => {
    const f = p("new.txt");
    const r = writeTool({ filePath: f, content: "中文内容\n第二行\n", charset: "utf8bom" }, dir);
    assert.ok(/Wrote file successfully/.test(r.output), r.output);
    assert.ok(!/Warning:/.test(r.output), r.output);
    assert.ok(hasBom(f), "the new file must start with a UTF-8 BOM");
    assert.strictEqual(lf(utf8Body(f)), "中文内容\n第二行\n");
    assert.strictEqual(r.metadata.charset, "utf8");
  });

  t('write over an existing UTF-8 file adds the BOM and warns', () => {
    const f = p("plain.txt");
    fs.writeFileSync(f, "旧内容\n", "utf8");
    assert.ok(!hasBom(f));
    const r = writeTool({ filePath: f, content: "新内容\n", charset: "utf8bom" }, dir);
    assert.ok(/Wrote file successfully/.test(r.output), r.output);
    assert.ok(BOM_WARNING.test(r.output), r.output);
    assert.ok(r.metadata.warning && BOM_WARNING.test(r.metadata.warning), JSON.stringify(r.metadata.warning));
    assert.ok(hasBom(f), "the BOM must be added");
    assert.strictEqual(lf(utf8Body(f)), "新内容\n");
  });

  t('write over an existing BOM file keeps exactly one BOM and stays silent', () => {
    const f = p("bom.txt");
    fs.writeFileSync(f, Buffer.concat([BOM, Buffer.from("旧内容\n", "utf8")]));
    const r = writeTool({ filePath: f, content: "新内容\n", charset: "utf8bom" }, dir);
    assert.ok(/Wrote file successfully/.test(r.output), r.output);
    assert.ok(!/Warning:/.test(r.output), r.output);
    assert.ok(hasBom(f));
    assert.ok(!utf8Body(f).startsWith("\uFEFF"), "the BOM must not be doubled");
    assert.strictEqual(lf(utf8Body(f)), "新内容\n");
  });

  t('charset="UTF-8-BOM" is accepted as the same request', () => {
    const f = p("alias.txt");
    const r = writeTool({ filePath: f, content: "alias\n", charset: "UTF-8-BOM" }, dir);
    assert.ok(/Wrote file successfully/.test(r.output), r.output);
    assert.ok(hasBom(f));
  });

  t('charset="utf-8-sig" is accepted as the same request', () => {
    const f = p("sig.txt");
    const r = writeTool({ filePath: f, content: "sig\n", charset: "utf-8-sig" }, dir);
    assert.ok(/Wrote file successfully/.test(r.output), r.output);
    assert.ok(hasBom(f));
  });

  t('charset="utf-8-sig" adds the BOM to an existing plain UTF-8 file and warns', () => {
    const f = p("sig_plain.txt");
    fs.writeFileSync(f, "alpha\n", "utf8");
    const r = writeTool({ filePath: f, content: "beta\n", charset: "utf-8-sig" }, dir);
    assert.ok(BOM_WARNING.test(r.output), r.output);
    assert.ok(hasBom(f));
  });

  t('plain charset="utf8" still creates a file without a BOM', () => {
    const f = p("utf8_plain.txt");
    writeTool({ filePath: f, content: "abc\n", charset: "utf8" }, dir);
    assert.ok(!hasBom(f), "charset=utf8 must not add a BOM");
  });

  t('plain charset="utf8" keeps an existing BOM untouched', () => {
    const f = p("utf8_keep_bom.txt");
    fs.writeFileSync(f, Buffer.concat([BOM, Buffer.from("abc\n", "utf8")]));
    const r = writeTool({ filePath: f, content: "xyz\n", charset: "utf8" }, dir);
    assert.ok(/Wrote file successfully/.test(r.output), r.output);
    assert.ok(!/Warning:/.test(r.output), r.output);
    assert.ok(hasBom(f), "the existing BOM is a file property and is preserved");
  });

  t('write refuses charset="utf8bom" on a definitely non-UTF-8 file', () => {
    const f = p("utf16.txt");
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello\n", "utf16le")]));
    const before = bytes(f);
    expectThrow(() => writeTool({ filePath: f, content: "x\n", charset: "utf8bom" }, dir), /Charset mismatch/);
    assert.ok(bytes(f).equals(before), "the file must be left untouched");
  });

  t("write refuses charset=utf8bom on a confident GBK file", () => {
    const f = p("gbk.txt");
    const text = "这是一个用于测试字符集检测的中文文件，内容重复多次以便置信度达到满分。\n".repeat(4);
    fs.writeFileSync(f, iconv.encode(text, "gbk"));
    const before = bytes(f);
    expectThrow(() => writeTool({ filePath: f, content: "改成 UTF-8\n", charset: "utf8bom" }, dir), /Charset mismatch/);
    assert.ok(bytes(f).equals(before), "the file must be left untouched");
  });

  t('edit on a plain UTF-8 file adds the BOM and warns', () => {
    const f = p("edit_plain.txt");
    fs.writeFileSync(f, "alpha\nbeta\n", "utf8");
    const r = editTool({ path: f, oldString: "beta", newString: "gamma", charset: "utf8bom" }, dir);
    assert.ok(/Edited file successfully/.test(r.output), r.output);
    assert.ok(BOM_WARNING.test(r.output), r.output);
    assert.ok(hasBom(f));
    assert.strictEqual(lf(utf8Body(f)), "alpha\ngamma\n");
  });

  t("edit on a BOM file keeps the BOM and does not warn", () => {
    const f = p("edit_bom.txt");
    fs.writeFileSync(f, Buffer.concat([BOM, Buffer.from("alpha\nbeta\n", "utf8")]));
    const r = editTool({ path: f, oldString: "beta", newString: "gamma", charset: "utf8bom" }, dir);
    assert.ok(/Edited file successfully/.test(r.output), r.output);
    assert.ok(!/Warning:/.test(r.output), r.output);
    assert.ok(hasBom(f) && !utf8Body(f).startsWith("\uFEFF"));
  });

  t("edit without charset does not add a BOM to a plain UTF-8 file", () => {
    const f = p("edit_nocharset.txt");
    fs.writeFileSync(f, "alpha\nbeta\n", "utf8");
    editTool({ path: f, oldString: "beta", newString: "gamma" }, dir);
    assert.ok(!hasBom(f), "the default write must not add a BOM");
  });

  t("read accepts charset=utf8bom for both BOM and plain UTF-8 files", () => {
    const bom = p("read_bom.txt");
    fs.writeFileSync(bom, Buffer.concat([BOM, Buffer.from("第一行\n", "utf8")]));
    const plain = p("read_plain.txt");
    fs.writeFileSync(plain, "第一行\n", "utf8");
    assert.ok(/第一行/.test(readTool({ filePath: bom, charset: "utf8bom" }, dir).output));
    assert.ok(/第一行/.test(readTool({ filePath: plain, charset: "utf8bom" }, dir).output));
  });

  t('patch Add File with charset="utf8bom" writes a BOM', () => {
    const f = p("patch_add.txt");
    const patchText = ["*** Begin Patch", `*** Add File: ${f}`, "+新增内容", "*** End Patch"].join("\n");
    const r = patchTool({ patchText, charset: "utf8bom" }, dir);
    assert.ok(/Success\. Updated the following files/.test(r.output), r.output);
    assert.ok(!/Warning:/.test(r.output), r.output);
    assert.ok(hasBom(f));
  });

  t("patch Update on a plain UTF-8 file adds the BOM and warns", () => {
    const f = p("patch_update.txt");
    fs.writeFileSync(f, "alpha\nbeta\n", "utf8");
    const patchText = ["*** Begin Patch", `*** Update File: ${f}`, "@@", "-beta", "+gamma", "*** End Patch"].join("\n");
    const r = patchTool({ patchText, charset: "utf8bom" }, dir);
    assert.ok(/Success\. Updated the following files/.test(r.output), r.output);
    assert.ok(BOM_WARNING.test(r.output), r.output);
    assert.ok(Array.isArray(r.metadata.charsetWarnings) && r.metadata.charsetWarnings.length === 1, JSON.stringify(r.metadata.charsetWarnings));
    assert.ok(hasBom(f));
    assert.strictEqual(lf(utf8Body(f)), "alpha\ngamma\n");
  });

  t("patch Update on a BOM file keeps it and does not warn", () => {
    const f = p("patch_bom.txt");
    fs.writeFileSync(f, Buffer.concat([BOM, Buffer.from("alpha\nbeta\n", "utf8")]));
    const patchText = ["*** Begin Patch", `*** Update File: ${f}`, "@@", "-beta", "+gamma", "*** End Patch"].join("\n");
    const r = patchTool({ patchText, charset: "utf8bom" }, dir);
    assert.ok(/Success\. Updated the following files/.test(r.output), r.output);
    assert.ok(!/Warning:/.test(r.output), r.output);
    assert.ok(hasBom(f) && !utf8Body(f).startsWith("\uFEFF"));
  });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
