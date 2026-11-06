import * as fs from "fs";
import * as path from "path";
import { createTwoFilesPatch, diffLines } from "diff";
import { readFileDetected, writeFileEncoded } from "./encoding";
import { trimDiff } from "./write";
import { analyzeText, detectEol, normalizeTo, mixedEolWarning, defaultEol, type Eol } from "./eol";
import { normalizeCharsetParam, resolveCharsetForContent, assertEncodable, assertRepertoireCompatible, chooseWritableEncoding, charsetWarningText, type CharsetInfo } from "./charset";

export interface PatchParams {
  patchText: string;
  charset?: string;
}

export interface ToolReturn {
  title: string;
  output: string;
  metadata: any;
}

export type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; move_path?: string; chunks: UpdateFileChunk[] };

export interface UpdateFileChunk {
  old_lines: string[];
  new_lines: string[];
  change_context?: string;
  is_end_of_file?: boolean;
}

export function patchTool(params: PatchParams, cwd: string): ToolReturn {
  if (!params.patchText) throw new Error("patchText is required");
  let hunks: Hunk[];
  try {
    hunks = parsePatch(params.patchText).hunks;
  } catch (e) {
    throw new Error(`apply_patch verification failed: ${(e as Error).message}`);
  }
  if (hunks.length === 0) {
    const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (normalized === "*** Begin Patch\n*** End Patch") throw new Error("patch rejected: empty patch");
    throw new Error("apply_patch verification failed: no hunks found");
  }

  const requested = normalizeCharsetParam(params.charset);
  const fileChanges: any[] = [];
  const failures: Array<{ path: string; reason: string }> = [];
  const charsetWarnings: Array<{ path: string; text: string }> = [];
  let totalDiff = "";

  for (const hunk of hunks) {
    const filePath = path.resolve(cwd, hunk.path);
    try {
    switch (hunk.type) {
      case "add": {
        const oldContent = "";
        const rawContent = hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`;
        // New files adopt the platform line ending (CRLF on Windows).
        const newContent = normalizeTo(rawContent, defaultEol);
        // The requested charset (when given) becomes the new file's encoding.
        const encoding = requested ? resolveCharsetForContent(newContent, requested) : "utf8";
        assertEncodable(newContent, encoding);
        // charset="gbk"/"gb2312" also constrains a brand-new file's repertoire.
        assertRepertoireCompatible(newContent, params.charset, undefined);
        const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent));
        let additions = 0, deletions = 0;
        for (const change of diffLines(oldContent, newContent)) {
          if (change.added) additions += change.count || 0;
          if (change.removed) deletions += change.count || 0;
        }
        fileChanges.push({ filePath, oldContent, newContent, type: "add", diff, additions, deletions, encoding, bom: false });
        totalDiff += diff + "\n";
        break;
      }
      case "update": {
        const stats = fs.statSync(filePath, { throwIfNoEntry: false });
        if (!stats || stats.isDirectory()) throw new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`);
        const source = readFileDetected(filePath, requested);
        const oldContent = source.text;
        let newContent = oldContent;
        try {
          const fileUpdate = deriveNewContentsFromChunks(filePath, hunk.chunks, source.text);
          newContent = fileUpdate.content;
        } catch (e) {
          const hint = !requested && source.charsetInfo?.warn ? `\n${charsetWarningText(source.charsetInfo as CharsetInfo, source.encoding)}` : "";
          throw new Error(`apply_patch verification failed: ${(e as Error).message}${hint}`);
        }
        const loose = !requested && source.charsetInfo?.warn === true;
        let writeEncoding = source.encoding;
        if (loose) {
          writeEncoding = chooseWritableEncoding(source.charsetInfo as CharsetInfo, newContent);
          charsetWarnings.push({ path: path.relative(cwd, filePath).replaceAll("\\", "/"), text: charsetWarningText(source.charsetInfo as CharsetInfo, writeEncoding) });
        } else {
          assertEncodable(newContent, source.encoding);
        }
        assertRepertoireCompatible(newContent, params.charset, source.gbkLevel);
        const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent));
        let additions = 0, deletions = 0;
        for (const change of diffLines(oldContent, newContent)) {
          if (change.added) additions += change.count || 0;
          if (change.removed) deletions += change.count || 0;
        }
        const movePath = hunk.move_path ? path.resolve(cwd, hunk.move_path) : undefined;
        fileChanges.push({ filePath, oldContent, newContent, type: hunk.move_path ? "move" : "update", movePath, diff, additions, deletions, encoding: writeEncoding, bom: source.bom });
        totalDiff += diff + "\n";
        break;
      }
      case "delete": {
        const source = readFileDetected(filePath);
        const contentToDelete = source.text;
        const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""));
        const deletions = contentToDelete.split("\n").length;
        fileChanges.push({ filePath, oldContent: contentToDelete, newContent: "", type: "delete", diff: deleteDiff, additions: 0, deletions, encoding: source.encoding, bom: source.bom });
        totalDiff += deleteDiff + "\n";
        break;
      }
    }
    } catch (e) {
      failures.push({ path: path.relative(cwd, filePath).replaceAll("\\", "/"), reason: (e as Error).message.replace(/^apply_patch verification failed:\s*/, "") });
    }
  }

  const files = fileChanges.map((c) => ({
    filePath: c.filePath,
    relativePath: path.relative(cwd, c.movePath ?? c.filePath).replaceAll("\\", "/"),
    type: c.type,
    patch: c.diff,
    additions: c.additions,
    deletions: c.deletions,
    ...(c.movePath ? { movePath: c.movePath } : {}),
  }));

  // Apply
  const updates: Array<{ file: string; event: string }> = [];
  for (const change of fileChanges) {
    switch (change.type) {
      case "add":
        fs.mkdirSync(path.dirname(change.filePath), { recursive: true });
        writeFileEncoded(change.filePath, change.newContent, change.encoding, change.bom);
        updates.push({ file: change.filePath, event: "add" });
        break;
      case "update":
        writeFileEncoded(change.filePath, change.newContent, change.encoding, change.bom);
        updates.push({ file: change.filePath, event: "change" });
        break;
      case "move":
        fs.mkdirSync(path.dirname(change.movePath), { recursive: true });
        writeFileEncoded(change.movePath, change.newContent, change.encoding, change.bom);
        fs.rmSync(change.filePath);
        updates.push({ file: change.filePath, event: "unlink" });
        updates.push({ file: change.movePath, event: "add" });
        break;
      case "delete":
        fs.rmSync(change.filePath);
        updates.push({ file: change.filePath, event: "unlink" });
        break;
    }
  }

  const summaryLines = fileChanges.map((c) => {
    if (c.type === "add") return `A ${path.relative(cwd, c.filePath).replaceAll("\\", "/")}`;
    if (c.type === "delete") return `D ${path.relative(cwd, c.filePath).replaceAll("\\", "/")}`;
    const target = c.movePath ?? c.filePath;
    return `M ${path.relative(cwd, target).replaceAll("\\", "/")}`;
  });
  const failureLines = failures.map((f) => `${f.path}: ${f.reason}`);
  let output: string;
  if (fileChanges.length > 0) {
    output = `Success. Updated the following files:\n${summaryLines.join("\n")}`;
  } else {
    output = "No files were updated.";
  }
  if (failures.length > 0) {
    output += `\n\nSkipped ${failures.length} file(s): each file's charset is validated independently, so files that fail are skipped while the rest are applied.\n${failureLines.join("\n")}`;
  }
  const metadata: any = { diff: totalDiff, files, diagnostics: {}, ...(failures.length > 0 ? { failures } : {}) };
  if (charsetWarnings.length > 0) {
    output += `\n\n${charsetWarnings.map((w) => `${w.path}: ${w.text}`).join("\n")}`;
    metadata.charsetWarnings = charsetWarnings;
  }
  if (analyzeText(params.patchText).mixed) {
    const warning = mixedEolWarning();
    output += `\n\n${warning}`;
    metadata.warning = warning;
  }
  return { title: fileChanges.length > 0 ? `Success. Updated the following files:\n${summaryLines.join("\n")}` : "No files were updated.", output, metadata };
}

// Parser implementation (adapted from OpenCode src/patch/index.ts)
function parsePatchHeader(lines: string[], startIdx: number): { filePath: string; movePath?: string; nextIdx: number } | null {
  const line = lines[startIdx];
  if (line.startsWith("*** Add File:")) {
    const filePath = line.slice("*** Add File:".length).trim();
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
  }
  if (line.startsWith("*** Delete File:")) {
    const filePath = line.slice("*** Delete File:".length).trim();
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
  }
  if (line.startsWith("*** Update File:")) {
    const filePath = line.slice("*** Update File:".length).trim();
    let movePath: string | undefined;
    let nextIdx = startIdx + 1;
    if (nextIdx < lines.length && lines[nextIdx].startsWith("*** Move to:")) {
      movePath = lines[nextIdx].slice("*** Move to:".length).trim();
      nextIdx++;
    }
    return filePath ? { filePath, movePath, nextIdx } : null;
  }
  return null;
}

function parseUpdateFileChunks(lines: string[], startIdx: number): { chunks: UpdateFileChunk[]; nextIdx: number } {
  const chunks: UpdateFileChunk[] = [];
  let i = startIdx;
  while (i < lines.length && !lines[i].startsWith("***")) {
    if (lines[i].startsWith("@@")) {
      const contextLine = lines[i].substring(2).trim();
      i++;
      const oldLines: string[] = [];
      const newLines: string[] = [];
      let isEndOfFile = false;
      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("***")) {
        const changeLine = lines[i];
        if (changeLine === "*** End of File") {
          isEndOfFile = true;
          i++;
          break;
        }
        if (changeLine.startsWith(" ")) {
          const content = changeLine.substring(1);
          oldLines.push(content);
          newLines.push(content);
        } else if (changeLine.startsWith("-")) {
          oldLines.push(changeLine.substring(1));
        } else if (changeLine.startsWith("+")) {
          newLines.push(changeLine.substring(1));
        }
        i++;
      }
      chunks.push({ old_lines: oldLines, new_lines: newLines, change_context: contextLine || undefined, is_end_of_file: isEndOfFile || undefined });
    } else {
      i++;
    }
  }
  return { chunks, nextIdx: i };
}

function parseAddFileContent(lines: string[], startIdx: number): { content: string; nextIdx: number } {
  let content = "";
  let i = startIdx;
  while (i < lines.length && !lines[i].startsWith("***")) {
    if (lines[i].startsWith("+")) content += lines[i].substring(1) + "\n";
    i++;
  }
  if (content.endsWith("\n")) content = content.slice(0, -1);
  return { content, nextIdx: i };
}

function stripHeredoc(input: string): string {
  const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  if (heredocMatch) return heredocMatch[2];
  return input;
}

export function parsePatch(patchText: string): { hunks: Hunk[] } {
  const cleaned = stripHeredoc(patchText.trim());
  const lines = cleaned.split("\n");
  const hunks: Hunk[] = [];
  const beginMarker = "*** Begin Patch";
  const endMarker = "*** End Patch";
  const beginIdx = lines.findIndex((line) => line.trim() === beginMarker);
  const endIdx = lines.findIndex((line) => line.trim() === endMarker);
  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) throw new Error("Invalid patch format: missing Begin/End markers");
  let i = beginIdx + 1;
  while (i < endIdx) {
    const header = parsePatchHeader(lines, i);
    if (!header) {
      i++;
      continue;
    }
    if (lines[i].startsWith("*** Add File:")) {
      const { content, nextIdx } = parseAddFileContent(lines, header.nextIdx);
      hunks.push({ type: "add", path: header.filePath, contents: content });
      i = nextIdx;
    } else if (lines[i].startsWith("*** Delete File:")) {
      hunks.push({ type: "delete", path: header.filePath });
      i = header.nextIdx;
    } else if (lines[i].startsWith("*** Update File:")) {
      const { chunks, nextIdx } = parseUpdateFileChunks(lines, header.nextIdx);
      hunks.push({ type: "update", path: header.filePath, move_path: header.movePath, chunks });
      i = nextIdx;
    } else {
      i++;
    }
  }
  return { hunks };
}

export function deriveNewContentsFromChunks(filePath: string, chunks: UpdateFileChunk[], originalText: string): { content: string } {
  const eol: Eol = detectEol(originalText);
  let originalLines = originalText.split("\n");
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") originalLines.pop();
  const replacements = computeReplacements(originalLines, filePath, chunks);
  let newLines = applyReplacements(originalLines, replacements, eol);
  if (newLines.length === 0 || newLines[newLines.length - 1] !== "") newLines.push("");
  return { content: newLines.join("\n") };
}

function computeReplacements(originalLines: string[], filePath: string, chunks: UpdateFileChunk[]): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.change_context) {
      const contextIdx = seekSequence(originalLines, [chunk.change_context], lineIndex);
      if (contextIdx === -1) throw new Error(`Failed to find context '${chunk.change_context}' in ${filePath}`);
      lineIndex = contextIdx + 1;
    }
    if (chunk.old_lines.length === 0) {
      const insertionIdx = originalLines.length > 0 && originalLines[originalLines.length - 1] === "" ? originalLines.length - 1 : originalLines.length;
      replacements.push([insertionIdx, 0, chunk.new_lines]);
      continue;
    }
    let pattern = chunk.old_lines;
    let newSlice = chunk.new_lines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
    if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1);
      found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
    }
    if (found !== -1) {
      replacements.push([found, pattern.length, newSlice]);
      lineIndex = found + pattern.length;
    } else {
      throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.old_lines.join("\n")}`);
    }
  }
  replacements.sort((a, b) => a[0] - b[0]);
  return replacements;
}

// Existing lines are split/joined on "\n", so each keeps its own terminator
// (a CRLF line keeps its `\r`). Only inserted lines are normalized to the
// file's dominant style — that way a mixed file is never flattened.
function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>, eol: Eol): string[] {
  const normalizeLine = (line: string) => (eol === "\r\n" ? line.replace(/\r$/, "") + "\r" : line.replace(/\r$/, ""));
  const result = [...lines];
  for (let i = replacements.length - 1; i >= 0; i--) {
    const [startIdx, oldLen, newSegment] = replacements[i];
    const original = result.slice(startIdx, startIdx + oldLen);
    // newSegment mixes changed and unchanged ("context") lines, and the patch
    // text carries no information about the original terminators. Reuse the
    // original line — and therefore its own EOL — wherever it is unchanged, so
    // a mixed file keeps its LF-only lines instead of being flattened.
    let oi = 0;
    const segment = newSegment.map((line) => {
      for (let k = oi; k < original.length; k++) {
        if (original[k].replace(/\r$/, "") === line.replace(/\r$/, "")) {
          oi = k + 1;
          return original[k];
        }
      }
      return normalizeLine(line);
    });
    result.splice(startIdx, oldLen);
    for (let j = 0; j < segment.length; j++) result.splice(startIdx + j, 0, segment[j]);
  }
  return result;
}

function normalizeUnicode(str: string): string {
  return str
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ");
}

type Comparator = (a: string, b: string) => boolean;

function tryMatch(lines: string[], pattern: string[], startIndex: number, compare: Comparator, eof: boolean): number {
  if (eof) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex) {
      let matches = true;
      for (let j = 0; j < pattern.length; j++) if (!compare(lines[fromEnd + j], pattern[j])) { matches = false; break; }
      if (matches) return fromEnd;
    }
  }
  for (let i = startIndex; i <= lines.length - pattern.length; i++) {
    let matches = true;
    for (let j = 0; j < pattern.length; j++) if (!compare(lines[i + j], pattern[j])) { matches = false; break; }
    if (matches) return i;
  }
  return -1;
}

function seekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
  if (pattern.length === 0) return -1;
  const exact = tryMatch(lines, pattern, startIndex, (a, b) => a === b, eof);
  if (exact !== -1) return exact;
  const rstrip = tryMatch(lines, pattern, startIndex, (a, b) => a.trimEnd() === b.trimEnd(), eof);
  if (rstrip !== -1) return rstrip;
  const trim = tryMatch(lines, pattern, startIndex, (a, b) => a.trim() === b.trim(), eof);
  if (trim !== -1) return trim;
  return tryMatch(lines, pattern, startIndex, (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()), eof);
}
