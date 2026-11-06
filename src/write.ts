import * as fs from "fs";
import * as path from "path";
import { createTwoFilesPatch, diffLines } from "diff";
import { readFileDetected, writeFileEncoded } from "./encoding";
import { analyzeText, detectEol, normalizeTo, eolName, mixedEolWarning, defaultEol, type Eol } from "./eol";
import { normalizeCharsetParam, resolveCharsetForContent, assertEncodable, assertRepertoireCompatible, chooseWritableEncoding, charsetWarningText, type CharsetInfo } from "./charset";

export interface WriteParams {
  content: string;
  filePath: string;
  charset?: string;
}

export interface ToolReturn {
  title: string;
  output: string;
  metadata: any;
}

export function writeTool(params: WriteParams, cwd: string, defaultEncoding = "utf-8"): ToolReturn {
  const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.join(cwd, params.filePath);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const requested = normalizeCharsetParam(params.charset);
  const exists = fs.existsSync(filepath);
  const source = exists ? readFileDetected(filepath, requested) : { text: "", encoding: defaultEncoding, bom: false, binary: false, charsetInfo: undefined as CharsetInfo | undefined };
  const oldText = exists ? source.text : "";
  // Existing files keep their own line ending; new files use the platform default (CRLF on Windows).
  const eolInfo = analyzeText(params.content);
  const fileEol: Eol = exists ? detectEol(source.text) : defaultEol;
  const newText = normalizeTo(params.content, fileEol);
  const desiredBom = exists ? source.bom : false;
  let desiredEncoding = exists && source.encoding !== "binary" ? source.encoding : requested ? resolveCharsetForContent(newText, requested) : defaultEncoding;

  // A non-authoritative (non-UTF-8, <100) file is a warning case: still write,
  // choosing an encoding that can represent the content. Otherwise an explicit
  // charset must be representable (refuse rather than silently change encoding).
  const loose = exists && !requested && source.charsetInfo?.warn === true && !source.charsetInfo.definite;
  if (loose) {
    desiredEncoding = chooseWritableEncoding(source.charsetInfo as CharsetInfo, newText);
  } else {
    assertEncodable(newText, desiredEncoding);
  }
  // Stay inside the repertoire the model asked for, or the file's plain-GBK level.
  assertRepertoireCompatible(newText, params.charset, exists ? source.gbkLevel : undefined);

  const diff = trimDiff(createTwoFilesPatch(filepath, filepath, oldText, newText));
  // Simulate native permission metadata by returning diff in metadata (CLI prints it)
  writeFileEncoded(filepath, newText, desiredEncoding, desiredBom);

  const warnings: string[] = [];
  if (eolInfo.mixed) warnings.push(mixedEolWarning(fileEol));
  if (exists && !requested && source.charsetInfo?.warn) warnings.push(charsetWarningText(source.charsetInfo, desiredEncoding));
  const metadata: any = { diagnostics: {}, filepath, exists, diff, eol: eolName(fileEol), charset: desiredEncoding };
  let output = "Wrote file successfully.";
  if (warnings.length > 0) {
    output += `\n\n${warnings.join("\n\n")}`;
    metadata.warning = warnings.join("\n\n");
  }

  return {
    title: path.relative(cwd, filepath) || filepath,
    output,
    metadata,
  };
}

export function trimDiff(diff: string): string {
  const lines = diff.split("\n");
  while (lines.length > 0 && lines[0]?.startsWith("Index:")) lines.shift();
  while (lines.length > 0 && lines[0]?.startsWith("===")) lines.shift();
  return lines.join("\n");
}
