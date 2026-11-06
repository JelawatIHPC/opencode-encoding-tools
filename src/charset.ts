import iconv from "iconv-lite";
import chardet from "chardet";

// Character-set resolution policy:
//   * UTF-8 (a BOM, or bytes that decode as strict UTF-8) is never questioned and
//     never warned about. The modern common case must stay completely silent.
//   * A non-UTF-8 file whose best chardet candidate scores 100 is authoritative
//     and silent.
//   * Any other non-UTF-8 file is still read/written with the best candidate, but
//     write/edit/patch append a warning telling the model the guessed charset and
//     how to silence it with the `charset` parameter.
// A model-supplied `charset` is only hard-rejected when the detection is
// authoritative; otherwise it is accepted when *possible* for the bytes.

export interface CharsetCandidate {
  encoding: string;
  label: string;
  confidence: number;
}

export interface CharsetInfo {
  encoding: string;
  // Authoritative: a conflicting model-supplied charset is rejected.
  definite: boolean;
  // The model did not specify a charset and tools should warn (non-UTF-8, < 100).
  warn: boolean;
  source: "bom" | "utf8" | "gb18030-4byte" | "chardet" | "fallback";
  confidence?: number;
  candidates?: CharsetCandidate[];
}

export interface CharsetResolution {
  encoding: string;
  modelRequested: boolean;
  info: CharsetInfo;
}

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

// Only a perfect chardet score counts as authoritative ("< 100 is unreliable").
const SILENT_CONFIDENCE = 100;
// Below this, the warning lists the top candidates instead of a single guess.
const LOW_CONFIDENCE = 50;
const MAX_CANDIDATES = 6;
const MAX_SHOWN = 4;

// CJK labels chardet may report, in tie-break preference order. Chinese
// (GB18030) is preferred first because this build targets Chinese Windows.
const CJK_PREFERENCE = ["GB18030", "Big5", "Shift_JIS", "EUC-JP", "EUC-KR"];

// Human-facing list of accepted charset names, used in tool descriptions and
// error messages.
export const CHARSET_HELP =
  "utf-8, gb18030 (alias gbk/gb2312/cp936), big5, shift_jis, euc-jp, euc-kr, " +
  "utf-16le, utf-16be, utf-32le, utf-32be, windows-1252 (alias latin1/iso-8859-1), " +
  "windows-1251, iso-8859-5/6/7/8, koi8-r";

const LABELS: Record<string, string> = {
  utf8: "UTF-8",
  utf16le: "UTF-16LE",
  utf16be: "UTF-16BE",
  utf32le: "UTF-32LE",
  utf32be: "UTF-32BE",
  gb18030: "GB18030/GBK/GB2312",
  big5: "Big5",
  shiftjis: "Shift_JIS",
  eucjp: "EUC-JP",
  euckr: "EUC-KR",
  windows1252: "Windows-1252",
  windows1251: "Windows-1251",
  iso88591: "ISO-8859-1",
  iso88592: "ISO-8859-2",
  iso88595: "ISO-8859-5",
  iso88596: "ISO-8859-6",
  iso88597: "ISO-8859-7",
  iso88598: "ISO-8859-8",
  koi8r: "KOI8-R",
};

export function charsetLabel(enc: string): string {
  return LABELS[enc] ?? enc;
}

// Alias -> canonical internal key (lowercase, alphanumeric only). The canonical
// key doubles as a valid iconv-lite name, so decoding/encoding needs no extra map.
const DIRECT: Record<string, string> = {
  utf8: "utf8",
  utf8bom: "utf8",
  ascii: "utf8",
  usascii: "utf8",
  utf16: "utf16le",
  utf16le: "utf16le",
  ucs2: "utf16le",
  ucs2le: "utf16le",
  unicode: "utf16le",
  utf16be: "utf16be",
  ucs2be: "utf16be",
  unicodebe: "utf16be",
  utf32: "utf32le",
  utf32le: "utf32le",
  utf32be: "utf32be",
  gb2312: "gb18030",
  gbk: "gb18030",
  gb18030: "gb18030",
  cp936: "gb18030",
  csgb2312: "gb18030",
  gb231280: "gb18030",
  xgbk: "gb18030",
  big5: "big5",
  big5hkscs: "big5",
  cp950: "big5",
  shiftjis: "shiftjis",
  sjis: "shiftjis",
  windows31j: "shiftjis",
  mskanji: "shiftjis",
  cp932: "shiftjis",
  eucjp: "eucjp",
  euckr: "euckr",
  cp949: "euckr",
  uhc: "euckr",
  ksc5601: "euckr",
  latin1: "windows1252",
  iso88591: "windows1252",
  windows1252: "windows1252",
  cp1252: "windows1252",
  ansi: "windows1252",
  windows1251: "windows1251",
  cp1251: "windows1251",
  iso88595: "iso88595",
  iso88596: "iso88596",
  iso88597: "iso88597",
  iso88598: "iso88598",
  koi8r: "koi8r",
};

export function canonicalizeCharset(name: string | null | undefined): string | null {
  if (name == null) return null;
  const raw = String(name).trim();
  if (!raw) return null;
  const v = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (DIRECT[v]) return DIRECT[v];
  // Any other name iconv-lite knows; canonicalize to the same alnum key iconv
  // will use internally so comparisons stay stable. Matching is case-insensitive
  // and ignores '-'/'_'/' ' and other separators.
  try {
    if (iconv.encodingExists(v)) return v;
  } catch {}
  return null;
}

export function bomInfo(buf: Buffer): { encoding: string; offset: number } | null {
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00) return { encoding: "utf32le", offset: 4 };
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xfe && buf[3] === 0xff) return { encoding: "utf32be", offset: 4 };
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { encoding: "utf8", offset: 3 };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: "utf16le", offset: 2 };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { encoding: "utf16be", offset: 2 };
  return null;
}

export function decodeBuffer(buf: Buffer, enc: string): string {
  if (enc === "utf8") return buf.toString("utf8");
  return iconv.decode(buf, enc);
}

export function encodeBuffer(text: string, enc: string): Buffer {
  if (enc === "utf8") return Buffer.from(text, "utf8");
  return iconv.encode(text, enc);
}

function hasNonAsciiByte(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) if (buf[i] >= 0x80) return true;
  return false;
}

// Damage assessment for a buffer that is not *strictly* valid UTF-8. Real
// non-UTF-8 text (GBK/Big5/...) has a high share of invalid sequences, whereas
// a UTF-8 file with a few truncated characters has very few. Distinguishing the
// two avoids decoding an almost-perfect UTF-8 file as a single-byte charset,
// which turns the whole file into mojibake over one or two bad bytes.
function utf8Damage(buf: Buffer): { invalidStarts: number; validMultibyte: number } {
  let i = 0;
  let invalidStarts = 0;
  let validMultibyte = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    const need = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : 0;
    let ok = need > 0;
    for (let k = 1; ok && k <= need; k++) {
      const c = buf[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) ok = false;
    }
    if (ok) {
      validMultibyte++;
      i += need + 1;
    } else {
      invalidStarts++;
      i++;
      // Do not count the orphaned continuation bytes of the same bad sequence.
      while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++;
    }
  }
  return { invalidStarts, validMultibyte };
}

// Index of the first byte that makes the buffer invalid UTF-8, or -1.
function firstInvalidUtf8(buf: Buffer): number {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    let n: number;
    if (b >= 0xc2 && b <= 0xdf) n = 1;
    else if (b >= 0xe0 && b <= 0xef) n = 2;
    else if (b >= 0xf0 && b <= 0xf4) n = 3;
    else return i;
    if (i + n >= buf.length) return i;
    for (let j = 1; j <= n; j++) {
      const c = buf[i + j];
      if (c < 0x80 || c > 0xbf) return i;
    }
    const c1 = buf[i + 1];
    if (b === 0xe0 && c1 < 0xa0) return i;
    if (b === 0xed && c1 > 0x9f) return i;
    if (b === 0xf0 && c1 < 0x90) return i;
    if (b === 0xf4 && c1 > 0x8f) return i;
    i += n + 1;
  }
  return -1;
}

// Decode only if the buffer is fully valid in `enc`: no replacement characters
// and a byte-exact re-encode. Returns null when the bytes are not valid `enc`.
export function strictDecode(buf: Buffer, enc: string): string | null {
  if (enc === "utf8") {
    try {
      return UTF8_FATAL.decode(buf);
    } catch {
      return null;
    }
  }
  let text: string;
  try {
    text = iconv.decode(buf, enc);
  } catch {
    return null;
  }
  if (text.indexOf("\uFFFD") >= 0) return null;
  let round: Buffer;
  try {
    round = iconv.encode(text, enc);
  } catch {
    return null;
  }
  return round.length === buf.length && round.equals(buf) ? text : null;
}

// Encode only if every character round-trips; null when some character has no
// representation in `enc`.
export function strictEncode(text: string, enc: string): Buffer | null {
  let buf: Buffer;
  try {
    buf = encodeBuffer(text, enc);
  } catch {
    return null;
  }
  const back = strictDecode(buf, enc);
  return back !== null && back === text ? buf : null;
}

// Is it *possible* that the bytes are `enc`? When not, explain why so the model
// can correct itself.
export function validatePossible(buf: Buffer, enc: string): { ok: boolean; reason?: string } {
  if (strictDecode(buf, enc) !== null) return { ok: true };
  if (enc === "utf8") {
    const off = firstInvalidUtf8(buf);
    return { ok: false, reason: off >= 0 ? `invalid UTF-8 sequence at byte offset ${off} (0x${buf[off].toString(16).padStart(2, "0")})` : "the bytes are not valid UTF-8" };
  }
  let loose: string | null = null;
  try {
    loose = iconv.decode(buf, enc);
  } catch {
    loose = null;
  }
  if (loose === null) return { ok: false, reason: `the bytes cannot be decoded as ${charsetLabel(enc)}` };
  if (loose.indexOf("\uFFFD") >= 0) return { ok: false, reason: `a byte has no valid mapping in ${charsetLabel(enc)}` };
  return { ok: false, reason: `the byte sequence decodes but is not canonical ${charsetLabel(enc)} (it does not round-trip)` };
}

// Count GB18030 four-byte sequences, or -1 when the bytes are not structurally
// GB18030 at all. Such a sequence (81-FE 30-39 81-FE 30-39) cannot appear in a
// GBK/Big5/Shift_JIS stream — there a lead byte must be followed by >= 0x40 — and
// practically never in single-byte text, so it is a decisive signal.
function gb18030FourByteSequences(buf: Buffer): number {
  let i = 0;
  let count = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    if (b < 0x81 || b > 0xfe) return -1;
    const b2 = buf[i + 1];
    if (b2 !== undefined && b2 >= 0x30 && b2 <= 0x39) {
      const b3 = buf[i + 2];
      const b4 = buf[i + 3];
      if (b3 === undefined || b4 === undefined || b3 < 0x81 || b3 > 0xfe || b4 < 0x30 || b4 > 0x39) return -1;
      count++;
      i += 4;
      continue;
    }
    if (b2 !== undefined && b2 >= 0x40 && b2 <= 0xfe && b2 !== 0x7f) {
      i += 2;
      continue;
    }
    return -1;
  }
  return count;
}

export function detectCharset(buf: Buffer): CharsetInfo {
  const bom = bomInfo(buf);
  if (bom) return { encoding: bom.encoding, definite: true, warn: false, source: "bom" };
  try {
    UTF8_FATAL.decode(buf);
    // Valid UTF-8 is definitive when it has non-ASCII bytes. Pure ASCII is valid
    // in almost every charset, so it is neither authoritative nor a warning.
    return { encoding: "utf8", definite: hasNonAsciiByte(buf), warn: false, source: "utf8" };
  } catch {}

  // Almost-valid UTF-8: a handful of damaged bytes (e.g. a truncated multi-byte
  // sequence) must not make us decode the whole file as a single-byte charset —
  // that turns readable text into mojibake. Require real multi-byte UTF-8
  // content and damage that is a minority of it: genuine GBK/Big5/Shift_JIS
  // text has more invalid sequences than valid ones (measured ~4:1), while a
  // damaged UTF-8 file is around 1:10.
  const damage = utf8Damage(buf);
  if (damage.validMultibyte >= 16 && damage.invalidStarts * 2 <= damage.validMultibyte) {
    return { encoding: "utf8", definite: true, warn: false, source: "utf8" };
  }

  // A GB18030 file that uses the four-byte extension is not plain GBK, and
  // chardet frequently guesses a single-byte charset for it (a few CJK
  // characters among mostly ASCII code is weak evidence for CJK). Decoding it as
  // windows-1252 would turn the whole file into mojibake — and, worse, the next
  // edit would re-encode that mojibake as GB18030. The four-byte sequence is
  // decisive, so require only that the bytes strictly decode.
  if (gb18030FourByteSequences(buf) > 0 && strictDecode(buf, "gb18030") !== null) {
    return { encoding: "gb18030", definite: true, warn: false, source: "gb18030-4byte" };
  }

  let matches: Array<{ confidence: number; name: string }> = [];
  try {
    matches = (chardet.analyse(buf) ?? [])
      .filter((m) => !!m && m.confidence > 0)
      .map((m) => ({ confidence: m.confidence, name: m.name as string }));
  } catch {}

  if (matches.length > 0) {
    const top = matches[0];
    const candidates: CharsetCandidate[] = [];
    for (const m of matches) {
      const enc = canonicalizeCharset(m.name);
      if (!enc || enc === "utf8") continue;
      if (candidates.some((c) => c.encoding === enc)) continue;
      candidates.push({ encoding: enc, label: charsetLabel(enc), confidence: m.confidence });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    let encoding = candidates[0]?.encoding ?? "gb18030";
    // Low confidence: chardet often reports the wrong CJK set for short files.
    // Prefer a detected CJK encoding (GB18030 first) as the working guess.
    if (top.confidence <= 20) {
      for (const name of CJK_PREFERENCE) {
        if (matches.some((m) => m.name === name)) {
          const enc = canonicalizeCharset(name);
          if (enc) {
            encoding = enc;
            break;
          }
        }
      }
    }
    const definite = top.confidence >= SILENT_CONFIDENCE;
    return { encoding, definite, warn: !definite, source: "chardet", confidence: top.confidence, candidates };
  }
  // Final fallback: GB18030 (Chinese Windows common), which is a superset of GBK.
  return { encoding: "gb18030", definite: false, warn: true, source: "fallback", candidates: [] };
}

// For a non-authoritative detection, pick an encoding that can actually
// represent the content: the detected one if possible, else the best CJK
// candidate (GB18030 first, the Chinese-Windows default), else any candidate
// that can, else UTF-8. Used so a warned write/edit still succeeds.
export function chooseWritableEncoding(info: CharsetInfo, text: string): string {
  if (strictEncode(text, info.encoding) !== null) return info.encoding;
  const cands = info.candidates ?? [];
  for (const name of CJK_PREFERENCE) {
    const enc = canonicalizeCharset(name);
    if (enc && cands.some((c) => c.encoding === enc) && strictEncode(text, enc) !== null) return enc;
  }
  for (const c of cands) {
    if (c.encoding !== info.encoding && strictEncode(text, c.encoding) !== null) return c.encoding;
  }
  return "utf8";
}

// Model-facing warning appended by write/edit/patch when a non-UTF-8 file's
// charset is not authoritative and the model did not specify one.
export function charsetWarningText(info: CharsetInfo, used?: string): string {
  const cands = info.candidates ?? [];
  const shown = cands.slice(0, MAX_SHOWN);
  const low = (info.confidence ?? 0) < LOW_CONFIDENCE;
  const fallback = info.source === "fallback" || cands.length === 0;
  let base: string;
  if (fallback) {
    base = "Warning: this file is not UTF-8, and no charset candidate was detected. A fallback (GB18030) was assumed.";
  } else if (low) {
    const list = shown.map((c) => `${c.label} (${c.confidence}%)`).join(", ");
    base = `Warning: this file is not UTF-8, and its charset is hard to pin down — it may be too short, mostly ASCII, or a byte pattern several charsets share. Most likely candidates: ${list}.`;
  } else {
    base = `Warning: this file is not UTF-8. Auto-detected charset: ${charsetLabel(info.encoding)} (${info.confidence}%).`;
  }
  if (used && used !== info.encoding) {
    base += ` The guessed charset could not represent the content, so it was written as ${charsetLabel(used)} instead.`;
  }
  const example = used && used !== info.encoding ? used : cands[0]?.encoding ?? info.encoding;
  const tail = fallback ? "the GB18030 fallback is used." : low ? "the best candidate is used." : "the detected charset is used.";
  base += ` If you know the file's real encoding, pass the charset parameter (for example charset="${example}") to silence this warning; otherwise ${tail}`;
  return base;
}

export function unknownCharsetMessage(name: string): string {
  return `Unknown charset "${name}". Supported charsets: ${CHARSET_HELP}.`;
}

// Canonicalize the optional `charset` parameter. Unknown names are rejected.
export function normalizeCharsetParam(charset?: string): string | undefined {
  if (charset == null || String(charset).trim() === "") return undefined;
  const canon = canonicalizeCharset(charset);
  if (!canon) throw new Error(unknownCharsetMessage(charset));
  return canon;
}

// Resolve the charset to use for an existing file's bytes.
export function resolveCharset(buf: Buffer, requested: string | undefined): CharsetResolution {
  const info = detectCharset(buf);
  if (!requested) return { encoding: info.encoding, modelRequested: false, info };
  const canon = canonicalizeCharset(requested);
  if (!canon) throw new Error(unknownCharsetMessage(requested));
  if (info.definite) {
    if (canon === info.encoding) return { encoding: canon, modelRequested: true, info };
    // Accept when an alias/superset decodes to exactly the same text.
    const a = strictDecode(buf, canon);
    const b = strictDecode(buf, info.encoding);
    if (a !== null && b !== null && a === b) return { encoding: info.encoding, modelRequested: true, info };
    throw new Error(
      `Charset mismatch: this file's encoding is determined to be ${charsetLabel(info.encoding)}, ` +
        `but the requested charset is ${charsetLabel(canon)}. The request was rejected to avoid corrupting the file. ` +
        `Omit the charset parameter (the file reads correctly as ${charsetLabel(info.encoding)}), or set charset="${info.encoding}".`,
    );
  }
  const check = validatePossible(buf, canon);
  if (!check.ok) {
    throw new Error(
      `Requested charset ${charsetLabel(canon)} is impossible for this file: ${check.reason}. ` +
        `Auto-detection was inconclusive, so the requested charset was rejected. ` +
        `Use the file's real encoding, or omit the charset parameter to let detection decide.`,
    );
  }
  return { encoding: canon, modelRequested: true, info };
}

// Resolve the charset to use for brand-new content (no existing bytes).
export function resolveCharsetForContent(text: string, requested: string | undefined): string {
  if (!requested) return "utf8";
  const canon = canonicalizeCharset(requested);
  if (!canon) throw new Error(unknownCharsetMessage(requested));
  if (strictEncode(text, canon) === null) {
    throw new Error(
      `Cannot encode the content as ${charsetLabel(canon)}: it contains characters with no representation in that charset. ` +
        `Omit the charset parameter to write UTF-8, or choose a charset that covers all characters.`,
    );
  }
  return canon;
}

// GBK files are handled internally as GB18030 (a superset that shares GBK's
// two-byte mapping and adds a four-byte extension for the rest of Unicode). That
// makes "can this charset represent the text?" always true for them, so a
// character GBK lacks (e.g. U+26A0 "⚠") is silently written as a GB18030
// four-byte sequence such as 81 37 B2 32. Every GBK-only consumer — MSVC,
// Notepad's ANSI mode, most Chinese Windows editors — then rejects the whole
// file, because 0x81 0x37 is not a valid GBK pair. So when the existing bytes
// are plain GBK, keep the new content inside the GBK repertoire as well.
export function isPlainGbk(buf: Buffer): boolean {
  return strictDecode(buf, "gbk") !== null;
}

function charsOutside(text: string, enc: string, max: number): { chars: string[]; truncated: boolean } {
  const chars: string[] = [];
  let truncated = false;
  for (const ch of text) {
    if (strictEncode(ch, enc) !== null) continue;
    if (chars.length >= max) {
      truncated = true;
      break;
    }
    chars.push(ch);
  }
  return { chars, truncated };
}

function describeTagged(ch: string, reason: "gbk" | "gb18030"): string {
  return `"${ch}" (${reason === "gbk" ? "GBK-only" : "GB18030-only"})`;
}

export function assertGbkCompatible(text: string, plainGbk: boolean): void {
  if (!plainGbk) return;
  if (strictEncode(text, "gbk") !== null) return;
  const { chars, truncated } = charsOutside(text, "gbk", 3);
  const shown = chars.length > 0 ? chars.map((ch) => describeTagged(ch, "gb18030")).join(", ") + (truncated ? ", …" : "") : "some characters";
  throw new Error(
    `Cannot write the content into this GBK file: it contains ${shown}. ` +
      `Writing it would make the whole file undecodable as GBK. ` +
      `Remove those characters, or pass charset="gb18030" to intentionally allow it, ` +
      `or convert the file to UTF-8 in advance.`,
  );
}

// GBK/GB2312 nicknames denote a specific repertoire. They canonicalize to
// GB18030 (GBK is its two-byte subset, GB2312 a subset of GBK), so the original
// spelling has to be kept around: charset="gbk" must not silently allow
// four-byte characters, and charset="gb2312" must not allow GBK-only ones.
const GB2312_NICKNAMES = new Set(["gb2312", "gb231280", "csgb2312", "chinese", "isoir58", "euccn"]);
const GBK_NICKNAMES = new Set(["gbk", "cp936", "xgbk"]);

export type Repertoire = "gb2312" | "gbk";

export function requestedRepertoire(charset?: string): Repertoire | null {
  if (charset == null) return null;
  const v = String(charset).trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!v) return null;
  if (GB2312_NICKNAMES.has(v)) return "gb2312";
  if (GBK_NICKNAMES.has(v)) return "gbk";
  return null;
}

// GB2312 covers 7445 characters on a 94x94 cell grid: rows 1-9 hold symbols,
// rows 16-87 hanzi, rows 10-15 and 88-94 are unassigned. Each row is filled from
// column 1 onwards, with holes in five symbol rows. Generated from an
// authoritative GB2312 codec (Python's 'gb2312'): 7445 assigned cells.
const GB2312_ROW_MAX = [94, 92, 94, 83, 86, 56, 81, 73, 79, 0, 0, 0, 0, 0, 0, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 89, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94, 94];
const GB2312_GAPS: Record<number, number[]> = { 2: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 67, 68, 79, 80], 6: [25, 26, 27, 28, 29, 30, 31, 32], 7: [34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48], 8: [27, 28, 29, 30, 31, 32, 33, 34, 35, 36], 9: [1, 2, 3] };
const GB2312_GAP_SETS = new Map(Object.entries(GB2312_GAPS).map(([row, cols]) => [Number(row), new Set(cols)] as const));

export function isGb2312Cell(b1: number, b2: number): boolean {
  const row = b1 - 0xa0;
  const col = b2 - 0xa0;
  const max = GB2312_ROW_MAX[row - 1] ?? 0;
  if (max === 0 || col < 1 || col > max) return false;
  const gaps = GB2312_GAP_SETS.get(row);
  return !gaps || !gaps.has(col);
}

// GB2312 shares GBK's byte values for the characters it defines, so encode the
// text once with GBK and validate every cell. (iconv-lite's own "gb2312" name is
// an alias of CP936, so it cannot be used for this check.)
export function isGb2312Compatible(text: string): boolean {
  if (strictEncode(text, "gbk") === null) return false; // not even GBK
  const buf = encodeBuffer(text, "gbk");
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x80) continue;
    if (b === 0x80) return false; // euro sign: CP936 only, no GB2312 cell
    if (i + 1 >= buf.length || !isGb2312Cell(b, buf[i + 1])) return false;
    i++;
  }
  return true;
}

// Up to `max` characters, each with a repertoire hint: GBK-only characters can be
// rescued with charset="gbk", GB18030-only ones need charset="gb18030".
function charsOutsideGb2312(text: string, max: number): { shown: string[]; truncated: boolean } {
  const shown: string[] = [];
  let truncated = false;
  for (const ch of text) {
    if (isGb2312Compatible(ch)) continue;
    if (shown.length >= max) {
      truncated = true;
      break;
    }
    shown.push(describeTagged(ch, strictEncode(ch, "gbk") === null ? "gb18030" : "gbk"));
  }
  return { shown, truncated };
}

export function assertGb2312Compatible(text: string): void {
  if (isGb2312Compatible(text)) return;
  const { shown, truncated } = charsOutsideGb2312(text, 3);
  const list = shown.length > 0 ? shown.join(", ") + (truncated ? ", …" : "") : "some characters";
  throw new Error(
    `Cannot write the content into this GB2312 file: it contains ${list}. ` +
      `Writing it would make the file undecodable as GB2312. ` +
      `Remove those characters, or pass charset="gbk"/charset="gb18030" to allow more repertoire, ` +
      `or convert the file to UTF-8 in advance.`,
  );
}

// Whether a write must stay inside the GBK repertoire: the model asked for GBK
// by name, or (with no explicit charset) the existing file is plain GBK.
export function assertRepertoireCompatible(text: string, requested: string | undefined, plainGbk: boolean | undefined): void {
  const rep = requestedRepertoire(requested);
  if (rep === "gb2312") {
    assertGb2312Compatible(text);
    return;
  }
  if (rep === "gbk") {
    assertGbkCompatible(text, true);
    return;
  }
  // An explicit charset other than GBK/GB2312 is the model's own choice.
  if (requested != null && String(requested).trim() !== "") return;
  if (plainGbk === true) assertGbkCompatible(text, true);
}

// Guard a write against silently changing charset.
export function assertEncodable(text: string, enc: string): void {
  if (strictEncode(text, enc) === null) {
    throw new Error(
      `Cannot encode the content as ${charsetLabel(enc)}: it contains characters with no representation in that charset. ` +
        `Pass an explicit charset (for example charset="utf-8") that can represent it, or remove those characters.`,
    );
  }
}
