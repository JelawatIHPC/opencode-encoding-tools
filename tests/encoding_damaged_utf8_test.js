// A UTF-8 file with a couple of damaged bytes must still be read as UTF-8
// (with U+FFFD at the damage), instead of decoding the whole file as a
// single-byte charset and turning it into mojibake. Real non-UTF-8 text must
// still be detected as such.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const iconv = require("iconv-lite");
const { readFileDetected, detectEncoding } = require("../dist/encoding.js");

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

const dir = path.join(os.tmpdir(), "enctools-damaged-utf8-" + Date.now());
fs.mkdirSync(dir, { recursive: true });

const GOOD = "// 手写版 next_permutation：生成字典序的下一个排列，统计合法解数\n".repeat(4);
const J = (n) => path.join(dir, n);

// Corrupt exactly one character the way a GBK round-trip does: replace the
// third byte of 列 (E5 88 97) with '?'.
const damaged = Buffer.from(GOOD, "utf8");
const at = damaged.indexOf(Buffer.from([0xe5, 0x88, 0x97]));
damaged[at + 2] = 0x3f;
fs.writeFileSync(J("damaged.cpp"), damaged);

const gbk = iconv.encode(GOOD, "gbk");
fs.writeFileSync(J("real_gbk.txt"), gbk);

const tiny = Buffer.from("中文", "utf8");
tiny[2] = 0x3f; // 中 = E4 B8 AD
fs.writeFileSync(J("tiny_damaged.txt"), tiny);

(async () => {
  const d = readFileDetected(J("damaged.cpp"));
  t("almost-valid UTF-8 is decoded as UTF-8", () => {
    assert.strictEqual(d.encoding, "utf8");
  });
  t("the readable text survives (no wholesale mojibake)", () => {
    assert.ok(d.text.includes("手写版 next_permutation"), JSON.stringify(d.text.slice(0, 40)));
    assert.ok(!d.text.includes("æ"), "must not be cp1252 mojibake");
  });
  t("the damaged byte shows as U+FFFD instead of corrupting its neighbours", () => {
    assert.ok(d.text.includes("排\uFFFD"), JSON.stringify(d.text.slice(0, 40)));
  });
  t("the file is not treated as binary", () => {
    assert.strictEqual(d.binary, false);
  });

  t("a genuine GBK file is still not treated as UTF-8", () => {
    const g = readFileDetected(J("real_gbk.txt"));
    assert.notStrictEqual(g.encoding, "utf8");
    assert.notStrictEqual(detectEncoding(gbk).encoding, "utf8");
  });

  t("a tiny file with too little multibyte content still falls back to detection", () => {
    const s = readFileDetected(J("tiny_damaged.txt"));
    assert.notStrictEqual(s.encoding, "utf8");
  });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
