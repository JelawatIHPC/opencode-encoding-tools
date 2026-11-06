import * as fs from "fs";
import * as path from "path";
import { readFileDetected } from "./encoding";
import { normalizeCharsetParam } from "./charset";

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`;

export interface ReadParams {
  filePath: string;
  offset?: number;
  limit?: number;
  charset?: string;
}

export interface ToolReturn {
  title: string;
  output: string;
  metadata: any;
  attachments?: any[];
}

export function readTool(params: ReadParams, cwd: string): ToolReturn {
  let filepath = params.filePath;
  if (!path.isAbsolute(filepath)) filepath = path.resolve(cwd, filepath);
  if (process.platform === "win32") filepath = path.normalize(filepath);
  const title = path.relative(cwd, filepath) || filepath;
  const stat = fs.statSync(filepath, { throwIfNoEntry: false }) as fs.Stats | undefined;
  if (!stat) {
    throw new Error(`File not found: ${filepath}`);
  }

  if (stat.isDirectory()) {
    const items = fs.readdirSync(filepath, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
      .sort((a, b) => a.localeCompare(b));
    const limit = params.limit ?? DEFAULT_READ_LIMIT;
    const offset = params.offset || 1;
    const start = offset - 1;
    const sliced = items.slice(start, start + limit);
    const truncated = start + sliced.length < items.length;
    return {
      title,
      output: [`<path>${filepath}</path>`, `<type>directory</type>`, `<entries>`, sliced.join("\n"), truncated ? `\n(Showing ${sliced.length} of ${items.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length})` : `\n(${items.length} entries)`, `</entries>`].join("\n"),
      metadata: { preview: sliced.slice(0, 20).join("\n"), truncated, loaded: [], display: { type: "directory", path: filepath, entries: sliced, offset, totalEntries: items.length, truncated } },
    };
  }

  const detected = readFileDetected(filepath, normalizeCharsetParam(params.charset));
  if (detected.binary) {
    throw new Error(`Cannot read binary file: ${filepath}`);
  }

  const rawLines = splitLines(detected.text);
  const limit = params.limit ?? DEFAULT_READ_LIMIT;
  const offset = params.offset || 1;
  let count = 0;
  const raw: string[] = [];
  let bytes = 0;
  let more = false;
  let cut = false;
  for (const line of rawLines) {
    count += 1;
    if (count < offset) continue;
    if (raw.length >= limit) {
      more = true;
      continue;
    }
    const out = line.length > MAX_LINE_LENGTH ? line.substring(0, MAX_LINE_LENGTH) + `... (line truncated to ${MAX_LINE_LENGTH} chars)` : line;
    const size = Buffer.byteLength(out, "utf-8") + (raw.length > 0 ? 1 : 0);
    if (bytes + size <= MAX_BYTES) {
      raw.push(out);
      bytes += size;
    } else {
      cut = true;
      more = true;
      break;
    }
  }

  if (count < offset && !(count === 0 && offset === 1)) {
    throw new Error(`Offset ${offset} is out of range for this file (${count} lines)`);
  }

  let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>\n"].join("\n");
  output += raw.map((line, i) => `${i + offset}: ${line}`).join("\n");
  const last = offset + raw.length - 1;
  const next = last + 1;
  const truncated = more || cut;
  if (cut) output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${offset}-${last}. Use offset=${next} to continue.)`;
  else if (more) output += `\n\n(Showing lines ${offset}-${last} of ${count}. Use offset=${next} to continue.)`;
  else output += `\n\n(End of file - total ${count} lines)`;
  output += "\n</content>";

  return {
    title,
    output,
    metadata: { preview: raw.slice(0, 20).join("\n"), truncated, loaded: [], charset: detected.encoding, display: { type: "file", path: filepath, text: raw.join("\n"), lineStart: offset, lineEnd: last, totalLines: count, truncated } },
  };
}

export function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
