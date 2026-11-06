// A GBK file must not silently receive characters that only exist in GB18030's
// four-byte extension: the file would no longer decode as GBK, which breaks
// MSVC and every other GBK-only reader. Such writes must be refused unless the
// model explicitly asks for charset="gb18030" (or another charset entirely).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const iconv = require("iconv-lite");
const { editTool } = require("../dist/edit.js");
const { writeTool } = require("../dist/write.js");
const { patchTool } = require("../dist/patch.js");
const { readFileDetected } = require("../dist/encoding.js");
const { strictDecode } = require("../dist/charset.js");

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

const dir = path.join(os.tmpdir(), "enctools-gbk-guard-" + Date.now());
fs.mkdirSync(dir, { recursive: true });
const p = (n) => path.join(dir, n);

const GBK_TEXT = "#pragma once\r\n// 示例文本：名称、编号、备注\r\nstruct Example { int a; };\r\n";
const WARN = "\u26A0"; // ⚠ — present in GB18030 (81 37 B2 32), absent from GBK
const GBK_ONLY = "\u9555"; // 镕 — in GBK (E9 46), absent from GB2312
const GB2312_CH = "\u4E2D"; // 中 — in both

function makePlainGbk(name, text = GBK_TEXT) {
  const file = p(name);
  fs.writeFileSync(file, iconv.encode(text, "gbk"));
  return file;
}

// A GB18030 file that already uses the four-byte extension is allowed to keep
// using it: it was never decodable as plain GBK.
function makeGb18030(name) {
  const file = p(name);
  fs.writeFileSync(file, iconv.encode(`// ${WARN} 警告：本文件已是 GB18030\r\nstruct Example { int a; };\r\n`, "gb18030"));
  return file;
}

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
  t("edit refuses a GB18030-only character (⚠) in a plain GBK file", () => {
    const file = makePlainGbk("edit_warn.h");
    const before = fs.readFileSync(file);
    const e = expectThrow(
      () => editTool({ path: file, oldString: "struct Example { int a; };", newString: `// ${WARN} 注意\r\nstruct Example { int a; };` }, dir),
      /Cannot write the content into this GBK file/,
    );
    assert.ok(e.message.includes('"⚠" (GB18030-only)'), e.message);
    assert.ok(!e.message.includes("U+"), "no U+ code in the listing: " + e.message);
    assert.ok(e.message.includes('charset="gb18030"'), e.message);
    assert.ok(fs.readFileSync(file).equals(before), "the file must be left untouched");
  });

  t("the same edit with ordinary Chinese is still allowed (file stays GBK)", () => {
    const file = makePlainGbk("edit_ok.h");
    const r = editTool({ path: file, oldString: "struct Example { int a; };", newString: "// 注意：禁止写入非GBK字符\r\nstruct Example { int a; };" }, dir);
    assert.ok(/Edited file successfully/.test(r.output), r.output);
    const after = fs.readFileSync(file);
    assert.ok(strictDecode(after, "gbk") !== null, "file must still be valid GBK");
    assert.ok(after.includes(iconv.encode("禁止写入非GBK字符", "gbk")));
  });

  t("a GB18030 file that already has four-byte characters accepts ⚠", () => {
    const file = makeGb18030("already18030.h");
    const r = editTool({ path: file, oldString: "struct Example { int a; };", newString: `// ${WARN} ${WARN} 双警告\r\nstruct Example { int a; };` }, dir);
    assert.ok(/Edited file successfully/.test(r.output), r.output);
    assert.ok(strictDecode(fs.readFileSync(file), "gb18030") !== null, "file must stay valid GB18030");
  });

  t('charset="gb18030" is an explicit opt-in and writes the four-byte character', () => {
    const file = makePlainGbk("opt_in.h");
    const r = editTool({ path: file, oldString: "struct Example { int a; };", newString: `// ${WARN} 注意\r\nstruct Example { int a; };`, charset: "gb18030" }, dir);
    assert.ok(/Edited file successfully/.test(r.output), r.output);
    const after = fs.readFileSync(file);
    assert.ok(strictDecode(after, "gb18030") !== null, "file must be valid GB18030");
    assert.ok(strictDecode(after, "gbk") === null, "the opt-in is expected to leave GBK territory");
  });

  // charset="gbk"/"cp936" canonicalize to gb18030 internally, but the model asked
  // for GBK: the GBK repertoire must still be enforced.
  for (const alias of ["gbk", "cp936"]) {
    t(`charset="${alias}" still enforces the GBK repertoire`, () => {
      const file = makePlainGbk(`alias_${alias}.h`);
      const before = fs.readFileSync(file);
      expectThrow(
        () => editTool({ path: file, oldString: "struct Example { int a; };", newString: `// ${WARN} 注意\r\nstruct Example { int a; };`, charset: alias }, dir),
        /Cannot write the content into this GBK file/,
      );
      assert.ok(fs.readFileSync(file).equals(before), "the file must be left untouched");
    });
  }

  // charset="gb2312" asks for GB2312 specifically: GBK-only characters must be
  // refused too, not just GB18030 four-byte ones.
  t('charset="gb2312" refuses a GBK-only character (镕)', () => {
    const file = makePlainGbk("gb2312_gbkonly.h");
    const before = fs.readFileSync(file);
    const e = expectThrow(
      () => editTool({ path: file, oldString: "struct Example { int a; };", newString: `// ${GBK_ONLY} 注意\r\nstruct Example { int a; };`, charset: "gb2312" }, dir),
      /Cannot write the content into this GB2312 file/,
    );
    assert.ok(e.message.includes('"镕" (GBK-only)'), e.message);
    assert.ok(!e.message.includes("U+9555"), "no U+ code in the listing: " + e.message);
    assert.ok(e.message.includes('charset="gbk"/charset="gb18030" to allow more repertoire'), e.message);
    assert.ok(fs.readFileSync(file).equals(before), "the file must be left untouched");
  });

  t('charset="gb2312" also refuses ⚠', () => {
    const file = makePlainGbk("gb2312_fourbyte.h");
    const e = expectThrow(
      () => editTool({ path: file, oldString: "struct Example { int a; };", newString: `// ${WARN} 注意\r\nstruct Example { int a; };`, charset: "gb2312" }, dir),
      /Cannot write the content into this GB2312 file/,
    );
    assert.ok(e.message.includes('"⚠" (GB18030-only)'), e.message);
  });

  t('charset="gb2312" accepts ordinary GB2312 Chinese', () => {
    const file = makePlainGbk("gb2312_ok.h");
    const r = editTool({ path: file, oldString: "struct Example { int a; };", newString: `// ${GB2312_CH}文注释：合法\r\nstruct Example { int a; };`, charset: "gb2312" }, dir);
    assert.ok(/Edited file successfully/.test(r.output), r.output);
    assert.ok(strictDecode(fs.readFileSync(file), "gbk") !== null, "file must still be valid GBK");
  });

  t('charset="gbk" still accepts the GBK-only character (镕)', () => {
    const file = makePlainGbk("gbk_repertoire.h");
    const r = editTool({ path: file, oldString: "struct Example { int a; };", newString: `// ${GBK_ONLY} 注意\r\nstruct Example { int a; };`, charset: "gbk" }, dir);
    assert.ok(/Edited file successfully/.test(r.output), r.output);
    assert.ok(fs.readFileSync(file).includes(iconv.encode(GBK_ONLY, "gbk")));
  });

  t('new file with charset="gb2312" also refuses 镕 and creates nothing', () => {
    const file = p("new_gb2312.h");
    expectThrow(() => writeTool({ filePath: file, content: `// ${GBK_ONLY}\r\n`, charset: "gb2312" }, dir), /this GB2312 file/);
    assert.strictEqual(fs.existsSync(file), false, "the file must not be created");
  });

  t("more than three offending characters are elided with …", () => {
    const file = makePlainGbk("gb2312_many.h");
    const many = GBK_ONLY + WARN + "\u5586" + "\u2713"; // 镕 ⚠ 喆 ✓
    const e = expectThrow(
      () => editTool({ path: file, oldString: "struct Example { int a; };", newString: `// ${many}\r\nstruct Example { int a; };`, charset: "gb2312" }, dir),
      /Cannot write the content into this GB2312 file/,
    );
    assert.ok(e.message.includes(", …"), e.message);
    assert.ok(e.message.includes('"镕" (GBK-only)'), e.message);
    assert.ok(e.message.includes('"⚠" (GB18030-only)'), e.message);
    assert.ok(!e.message.includes("\u2713"), "only three characters are listed: " + e.message);
  });

  t("the GBK message elides after three characters too", () => {
    const file = makePlainGbk("gbk_many.h");
    const many = `${WARN} \u2713 \u2705 \u26A1`; // ⚠ ✓ ✅ ⚡ — none in GBK
    const e = expectThrow(
      () => editTool({ path: file, oldString: "struct Example { int a; };", newString: `// ${many}\r\nstruct Example { int a; };` }, dir),
      /Cannot write the content into this GBK file/,
    );
    assert.ok(e.message.includes(", …"), e.message);
    assert.ok(e.message.includes('"⚠" (GB18030-only)'), e.message);
    assert.ok(!e.message.includes("U+"), "no U+ code in the listing: " + e.message);
    assert.ok(!e.message.includes("\u26A1"), "only three characters are listed: " + e.message);
  });

  t('the "GB2312-80" alias is enforced too', () => {
    const file = makePlainGbk("gb2312_80.h");
    expectThrow(
      () => editTool({ path: file, oldString: "struct Example { int a; };", newString: `// ${GBK_ONLY}\r\nstruct Example { int a; };`, charset: "GB2312-80" }, dir),
      /this GB2312 file/,
    );
  });

  t("the GB2312 cell table covers exactly 7445 characters", () => {
    const { isGb2312Cell, isGb2312Compatible } = require("../dist/charset.js");
    let cells = 0;
    for (let b1 = 0xa1; b1 <= 0xf7; b1++) {
      for (let b2 = 0xa1; b2 <= 0xfe; b2++) {
        if (!isGb2312Cell(b1, b2)) continue;
        cells++;
        const ch = iconv.decode(Buffer.from([b1, b2]), "gbk");
        assert.ok(iconv.encode(ch, "gbk").equals(Buffer.from([b1, b2])), `cell ${b1.toString(16)}${b2.toString(16)} must round-trip through GBK`);
        assert.ok(isGb2312Compatible(ch), `cell ${b1.toString(16)}${b2.toString(16)} (${ch}) must be accepted`);
      }
    }
    assert.strictEqual(cells, 7445);
    // Boundaries and holes.
    assert.strictEqual(isGb2312Cell(0xa1, 0xa1), true); // 　 ideographic space
    assert.strictEqual(isGb2312Cell(0xa1, 0xfe), true); // 〓
    assert.strictEqual(isGb2312Cell(0xa2, 0xa1), false); // ⅰ — GBK-only
    assert.strictEqual(isGb2312Cell(0xd7, 0xf9), true); // 座 (last level-1 hanzi)
    assert.strictEqual(isGb2312Cell(0xd7, 0xfa), false); // unassigned
    assert.strictEqual(isGb2312Cell(0xf7, 0xfe), true); // 齄 (last hanzi)
    assert.strictEqual(isGb2312Cell(0xf8, 0xa1), false); // unassigned zone
  });

  t("write refuses the full-file rewrite for the same reason", () => {
    const file = makePlainGbk("write_warn.h");
    const before = fs.readFileSync(file);
    expectThrow(() => writeTool({ filePath: file, content: GBK_TEXT + `// ${WARN}\r\n` }, dir), /Cannot write the content into this GBK file/);
    assert.ok(fs.readFileSync(file).equals(before), "the file must be left untouched");
  });

  t('write of a new file with charset="gbk" also refuses ⚠ and creates nothing', () => {
    const file = p("new_gbk.h");
    expectThrow(() => writeTool({ filePath: file, content: `// ${WARN}\r\n`, charset: "gbk" }, dir), /Cannot write the content into this GBK file/);
    assert.strictEqual(fs.existsSync(file), false, "the file must not be created");
  });

  t('write of a new file with charset="utf-8" is not affected', () => {
    const file = p("new_utf8.h");
    const r = writeTool({ filePath: file, content: `// ${WARN}\r\n`, charset: "utf-8" }, dir);
    assert.ok(/Wrote file successfully/.test(r.output), r.output);
    assert.ok(fs.readFileSync(file).toString("utf8").includes(WARN));
  });

  t("patch reports the file as skipped and leaves it untouched", () => {
    const file = makePlainGbk("patch_warn.h");
    const before = fs.readFileSync(file);
    const patchText = [
      "*** Begin Patch",
      `*** Update File: ${file}`,
      "@@",
      "-struct Example { int a; };",
      `+// ${WARN} 注意`,
      "+struct Example { int a; };",
      "*** End Patch",
    ].join("\n");
    const r = patchTool({ patchText }, dir);
    assert.ok(/Skipped 1 file/.test(r.output), r.output);
    assert.ok(r.metadata.failures && r.metadata.failures.length === 1, JSON.stringify(r.metadata.failures));
    assert.ok(/GB18030-only/.test(r.metadata.failures[0].reason), r.metadata.failures[0].reason);
    assert.ok(fs.readFileSync(file).equals(before), "the file must be left untouched");
  });

  t('patch Add File with charset="gbk" refuses ⚠', () => {
    const file = p("patch_new_gbk.h");
    const patchText = ["*** Begin Patch", `*** Add File: ${file}`, `+// ${WARN} 注意`, "*** End Patch"].join("\n");
    const r = patchTool({ patchText, charset: "gbk" }, dir);
    assert.ok(/Skipped 1 file/.test(r.output), r.output);
    assert.ok(/GB18030-only/.test(r.metadata.failures[0].reason), r.metadata.failures[0].reason);
    assert.strictEqual(fs.existsSync(file), false, "the file must not be created");
  });

  t("reading a plain GBK file is unaffected and still reports GBK-family + plain level", () => {
    const file = makePlainGbk("read_ok.h");
    const d = readFileDetected(file);
    assert.strictEqual(d.encoding, "gb18030");
    assert.strictEqual(d.gbkLevel, true);
    assert.strictEqual(d.binary, false);
    assert.ok(d.text.includes("示例文本"));
    const g = readFileDetected(makeGb18030("read_18030.h"));
    assert.strictEqual(g.encoding, "gb18030");
    assert.strictEqual(g.gbkLevel, false);
  });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
