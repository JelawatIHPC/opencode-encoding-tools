import * as fs from "fs";
import * as path from "path";
import { createTwoFilesPatch, diffLines } from "diff";
import { readFileDetected, writeFileEncoded } from "./encoding";
import { trimDiff } from "./write";
import { analyzeText, detectEol, replaceEolInsensitive, mixedEolWarning, type Eol } from "./eol";
import { normalizeCharsetParam, assertEncodable, assertRepertoireCompatible, chooseWritableEncoding, charsetWarningText, requestsUtf8Bom, bomAddedWarning, type CharsetInfo } from "./charset";

export interface EditParams {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  charset?: string;
}

export interface ToolReturn {
  title: string;
  output: string;
  metadata: any;
}

const normalizeLineEndings = (text: string) => text.replace(/\r\n/g, "\n");

export function countOccurrences(content: string, search: string): number {
  if (search === "") return content.length + 1;
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count++;
    offset += search.length;
  }
  return count;
}

function previewLines(value: string, prefix: "+" | "-"): string[] {
  const lines = normalizeLineEndings(value).split("\n");
  const shown = lines.slice(0, 6).map((line) => `${prefix}${line.length > 240 ? `${line.slice(0, 240)}...` : line}`);
  if (lines.length > shown.length) shown.push(`${prefix}...`);
  return shown;
}

// Encoding-aware replacement for the native exact-edit tool. Mirrors native
// edit semantics (unique match unless replaceAll, line-ending normalization,
// validation errors) but reads/writes with the file's detected charset + BOM.
export function editTool(params: EditParams, cwd: string): ToolReturn {
  const filepath = path.isAbsolute(params.path) ? params.path : path.resolve(cwd, params.path);
  const stat = fs.statSync(filepath, { throwIfNoEntry: false });
  if (!stat || stat.isDirectory()) throw new Error(`File not found: ${filepath}`);
  if (params.oldString === params.newString) throw new Error("No changes to apply: oldString and newString are identical.");
  if (params.oldString === "") throw new Error("oldString must not be empty. Use write to create or overwrite a file.");

  const requested = normalizeCharsetParam(params.charset);
  const bomRequested = requestsUtf8Bom(params.charset);
  const source = readFileDetected(filepath, requested);
  if (source.binary) throw new Error(`Cannot edit binary file: ${filepath}`);

  const ending: Eol = detectEol(source.text);
  const oldInfo = analyzeText(params.oldString);
  const newInfo = analyzeText(params.newString);
  // Match with line endings normalized, then splice into the original text so a
  // mixed-EOL file keeps every untouched byte. (Rewriting the oldString's
  // newlines to the file's dominant EOL made any LF-only region of a CRLF file
  // unmatchable.)
  const applied = replaceEolInsensitive(source.text, params.oldString, params.newString, params.replaceAll === true);
  const replacements = applied.replacements;
  if (replacements === 0) {
    const hint = !requested && source.charsetInfo?.warn ? `\n\n${charsetWarningText(source.charsetInfo, source.encoding)}` : "";
    throw new Error("Could not find oldString in the file. It must match exactly, including whitespace and indentation." + hint);
  }
  if (replacements > 1 && params.replaceAll !== true) {
    throw new Error("Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true.");
  }
  const replaced = applied.text;

  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(source.text, replaced)) {
    if (change.added) additions += change.count || 0;
    if (change.removed) deletions += change.count || 0;
  }

  const loose = !requested && source.charsetInfo?.warn === true && !source.charsetInfo.definite;
  let writeEncoding = source.encoding;
  if (loose) {
    writeEncoding = chooseWritableEncoding(source.charsetInfo as CharsetInfo, replaced);
  } else {
    assertEncodable(replaced, source.encoding);
  }
  // Stay inside the repertoire the model asked for (gbk / gb2312), or — with no
  // explicit charset — the existing file's own plain-GBK level.
  assertRepertoireCompatible(replaced, params.charset, source.gbkLevel);
  writeFileEncoded(filepath, replaced, writeEncoding, bomRequested || source.bom);

  const patch = trimDiff(createTwoFilesPatch(filepath, filepath, source.text, replaced));
  let output = [`Edited file successfully: ${filepath}`, `Replacements: ${replacements}`, "```diff", ...previewLines(params.oldString, "-"), ...previewLines(params.newString, "+"), "```"].join("\n");
  const metadata: any = { files: [{ file: filepath, patch, status: "modified", additions, deletions }], replacements, diff: patch, eol: ending === "\r\n" ? "CRLF" : "LF", charset: writeEncoding };
  const warnings: string[] = [];
  if (oldInfo.mixed || newInfo.mixed) warnings.push(mixedEolWarning(ending));
  if (bomRequested && !source.bom) warnings.push(bomAddedWarning());
  if (!requested && source.charsetInfo?.warn) warnings.push(charsetWarningText(source.charsetInfo, writeEncoding));
  if (warnings.length > 0) {
    output += `\n\n${warnings.join("\n\n")}`;
    metadata.warning = warnings.join("\n\n");
  }
  return {
    title: `Edited ${filepath}`,
    output,
    metadata,
  };
}
