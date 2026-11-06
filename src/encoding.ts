import * as fs from "fs";
import * as path from "path";
import { bomInfo, decodeBuffer, encodeBuffer, charsetLabel, detectCharset, resolveCharset, isPlainGbk, type CharsetInfo } from "./charset";

export interface DetectedFile {
  encoding: string;
  bom: boolean;
  text: string;
  binary: boolean;
  charsetInfo?: CharsetInfo;
  // Only for GB18030-family files: the existing bytes are plain GBK (no
  // GB18030 four-byte extension). Writers must keep GB18030-only characters out
  // of such a file, or GBK-only readers (MSVC, ...) can no longer decode it.
  gbkLevel?: boolean;
}

// Detect a buffer's charset. Kept for callers that only need the name/offset.
export function detectEncoding(buf: Buffer): { encoding: string; bom: boolean; offset: number } {
  const bom = bomInfo(buf);
  if (bom) return { encoding: bom.encoding, bom: true, offset: bom.offset };
  return { encoding: detectCharset(buf).encoding, bom: false, offset: 0 };
}

const BINARY_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar", ".war", ".7z", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".bin", ".dat", ".obj", ".o", ".a", ".lib", ".wasm", ".pyc", ".pyo"]);

export function isBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isBinaryBuffer(filePath: string, bytes: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  if (bytes.length === 0) return false;
  // BOM-tagged UTF-16/32 is text even though it contains NUL bytes.
  if (bomInfo(bytes)) return false;
  let nonPrintable = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true;
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) nonPrintable++;
  }
  return nonPrintable / bytes.length > 0.3;
}

// Cheap binary sniff: decide from the file's first chunk whether it is binary,
// so callers can skip opaque data files (DICOM, .pdb, ...) without reading them
// in full. Consistent with isBinaryBuffer: a NUL byte means binary, unless the
// head carries a UTF-16/32 BOM.
export const SNIFF_BYTES = 8192;
export function headLooksBinary(filePath: string): boolean {
  if (isBinaryPath(filePath)) return true;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(SNIFF_BYTES);
    const n = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
    if (n === 0) return false;
    const head = buf.subarray(0, n);
    if (bomInfo(head)) return false;
    return head.includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

// Decode an already-read buffer. Split out from readFileDetected so callers that
// already hold the bytes (e.g. grep's scanner) do not read the file twice.
export function decodeDetected(filePath: string, buf: Buffer, requested?: string): DetectedFile {
  if (isBinaryPath(filePath)) {
    return { encoding: "binary", bom: false, text: "", binary: true };
  }
  if (isBinaryBuffer(filePath, buf)) {
    return { encoding: "binary", bom: false, text: "", binary: true };
  }
  const resolved = resolveCharset(buf, requested);
  const bom = bomInfo(buf);
  const useBom = !!bom && bom.encoding === resolved.encoding;
  let text = decodeBuffer(buf.subarray(useBom && bom ? bom.offset : 0), resolved.encoding);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { encoding: resolved.encoding, bom: useBom, text, binary: false, charsetInfo: resolved.info };
}

// Read a file, decoding with its detected charset. When `requested` is given the
// charset is validated first (see charset.resolveCharset): a certain detection
// that contradicts it, or an impossible requested charset, throws.
export function readFileDetected(filePath: string, requested?: string): DetectedFile {
  // Skip known-binary extensions without reading the file at all.
  if (isBinaryPath(filePath)) {
    return { encoding: "binary", bom: false, text: "", binary: true };
  }
  const buf = fs.readFileSync(filePath);
  const out = decodeDetected(filePath, buf, requested);
  // Single-file callers only (grep scans through decodeDetected directly), so the
  // extra GBK round-trip does not slow down bulk scanning.
  if (!out.binary && out.encoding === "gb18030") out.gbkLevel = isPlainGbk(buf);
  return out;
}

function withBom(out: Buffer, encoding: string, bom: boolean): Buffer {
  if (!bom) return out;
  if (encoding === "utf8") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), out]);
  if (encoding === "utf16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), out]);
  if (encoding === "utf16be") return Buffer.concat([Buffer.from([0xfe, 0xff]), out]);
  if (encoding === "utf32le") return Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), out]);
  if (encoding === "utf32be") return Buffer.concat([Buffer.from([0x00, 0x00, 0xfe, 0xff]), out]);
  return out;
}

export function writeFileEncoded(filePath: string, text: string, encoding: string, bom: boolean): void {
  let out: Buffer;
  try {
    out = encodeBuffer(text, encoding);
  } catch (e) {
    throw new Error(`Cannot encode the content as ${charsetLabel(encoding)}: ${(e as Error).message}`);
  }
  // Refuse to silently change a file's encoding. If the bytes cannot be decoded
  // back to the exact text, the charset cannot represent the content.
  if (decodeBuffer(out, encoding) !== text) {
    throw new Error(
      `Cannot write the content using the file's encoding ${charsetLabel(encoding)}: it contains characters with no representation in that charset. ` +
        `Pass an explicit charset (for example charset="utf-8") to change the file's encoding, or remove those characters.`,
    );
  }
  fs.writeFileSync(filePath, withBom(out, encoding, bom));
}

export function encodeForNewFile(text: string, encoding: string, bom: boolean): Buffer {
  return withBom(encodeBuffer(text, encoding), encoding, bom);
}
