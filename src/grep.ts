import * as fs from "fs";
import * as path from "path";
import micromatch from "micromatch";
import { decodeDetected, isBinaryPath, headLooksBinary, isBinaryBuffer } from "./encoding";
import { strictDecode } from "./charset";

export interface GrepParams {
  pattern: string;
  path?: string;
  include?: string;
  literal?: boolean;
  caseSensitive?: boolean;
  limit?: number;
}

export interface ToolReturn {
  title: string;
  output: string;
  metadata: any;
}

// The scan is bounded by wall-clock time plus periodic yielding, so a huge tree
// cannot stall the server's event loop (an earlier implementation walked the
// whole tree synchronously and made the client declare the event stream
// "stalled" and restart the service). Skipping hidden/binary files and honoring
// ignore files mirrors ripgrep's defaults. There is deliberately no file-size,
// byte or file-count cap: content-binary files are rejected by a cheap head
// sniff (headLooksBinary), and everything else is bounded by the time budget.
// ENCTOOLS_GREP_TIME_BUDGET_MS overrides the budget (used by tests).
const TIME_BUDGET_MS = (() => {
  const v = Number(process.env.ENCTOOLS_GREP_TIME_BUDGET_MS);
  return Number.isFinite(v) && v > 0 ? v : 45000;
})();
// Cooperative yielding: the scan gives the event loop a turn after this much of
// its own work, so a large tree never stalls the server (an earlier
// implementation walked the tree synchronously and made the client declare the
// event stream "stalled" and restart the service).
const YIELD_AFTER_MS = 8;

// Only files at least this large are worth a pre-read sniff: opening a small
// file twice (sniff + read) costs more than simply reading it and classifying
// from the buffer, which is what the scanner does.
const SNIFF_MIN_BYTES = 256 * 1024;

const IGNORE_FILES = [".gitignore", ".ignore", ".rgignore"];

// CJK encodings tried (in order) to improve the display of an uncertain file.
const CJK_ENCODINGS = ["gb18030", "big5", "shiftjis", "eucjp", "euckr"];
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
// Require a run of consecutive CJK characters this long before treating a
// single-byte-guessed file as CJK. Isolated CJK chars commonly appear when
// single-byte text (Latin/Cyrillic/Greek) is mis-decoded as GB18030, so a run
// requirement avoids mangling those files.
const CJK_RUN_MIN = 5;

function maxCjkRun(text: string): number {
  let best = 0;
  let cur = 0;
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) {
      cur++;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

interface IgnoreRule {
  baseDir: string;
  negated: boolean;
  dirOnly: boolean;
  glob: string;
}

function setImmediateP(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof (globalThis as any).setImmediate === "function") (globalThis as any).setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

// Parse one ignore file into rules. Supports the common .gitignore subset:
// comments, blank lines, `!` negation, trailing `/` (directory only), leading
// `/` or an inner `/` (anchored), and `*`/`**`/`?` globs via micromatch.
function parseIgnoreFile(dir: string, file: string): IgnoreRule[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (let line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    line = line.replace(/\\#/g, "#").replace(/\s+$/, "");
    if (!line) continue;
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.replace(/\/+$/, "");
    let anchored = false;
    if (line.startsWith("/")) {
      anchored = true;
      line = line.replace(/^\/+/, "");
    } else if (line.includes("/")) {
      anchored = true;
    }
    if (!line) continue;
    const glob = anchored ? line : `**/${line}`;
    rules.push({ baseDir: dir, negated, dirOnly, glob });
  }
  return rules;
}

function loadIgnore(dir: string, parent: IgnoreRule[]): IgnoreRule[] {
  let rules = parent;
  for (const name of IGNORE_FILES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) rules = rules.concat(parseIgnoreFile(dir, file));
  }
  return rules;
}

function isIgnored(full: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    const rel = toPosix(path.relative(r.baseDir, full));
    if (rel.startsWith("..")) continue;
    if (micromatch.isMatch(rel, r.glob, { dot: true })) ignored = !r.negated;
  }
  return ignored;
}

function makeMatcher(params: GrepParams): (line: string) => boolean {
  if (params.literal) {
    if (params.caseSensitive === false) {
      const needle = params.pattern.toLowerCase();
      return (line) => line.toLowerCase().includes(needle);
    }
    const needle = params.pattern;
    return (line) => line.includes(needle);
  }
  const flags = params.caseSensitive === false ? "i" : "";
  const re = new RegExp(params.pattern, flags);
  return (line) => re.test(line);
}

export async function grepTool(params: GrepParams, cwd: string, signal?: AbortSignal): Promise<ToolReturn> {
  if (!params.pattern) throw new Error("pattern is required");

  const requested = params.path ? (path.isAbsolute(params.path) ? params.path : path.join(cwd, params.path)) : cwd;
  const info = fs.statSync(requested, { throwIfNoEntry: false });
  if (!info) throw new Error(`Path not found: ${requested}`);
  const root = info.isDirectory() ? requested : path.dirname(requested);
  const limit = params.limit ?? 100;
  const match = makeMatcher(params);

  const matches: { path: string; line: number; text: string }[] = [];
  const start = Date.now();
  let scannedFiles = 0;
  let includeMatched = 0;
  let includeFiltered = 0;
  let filesRead = 0;
  let bytesRead = 0;
  let hitLimit = false;
  let timedOut = false;
  let aborted = false;
  let sliceStart = Date.now();
  const budget = { skippedBinary: 0, timedOut: false };

  const collect = (full: string, text: string): number => {
    const lines = text.split(/\r\n|\r|\n/);
    let added = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!match(lines[i])) continue;
      matches.push({ path: path.resolve(full), line: i + 1, text: lines[i] });
      added++;
      if (matches.length >= limit) break;
    }
    return added;
  };

  // Returns false to signal "stop scanning".
  const considerFile = (full: string): boolean => {
    if (matches.length >= limit) return false;
    if (isBinaryPath(full)) return true;
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      return true;
    }
    if (!st.isFile()) return true; // e.g. a junction/symlink whose target is a directory
    // Read every candidate at most once. Large opaque files (DICOM .dcm, .pdb,
    // .ilk, ...) are rejected by a cheap head sniff so they are never read in
    // full; everything else is read and classified from the buffer.
    let buf: Buffer;
    try {
      if (st.size > SNIFF_MIN_BYTES && headLooksBinary(full)) {
        budget.skippedBinary++;
        return true;
      }
      buf = fs.readFileSync(full);
    } catch {
      return true;
    }
    if (isBinaryBuffer(full, buf)) {
      budget.skippedBinary++;
      return true;
    }
    filesRead++;
    bytesRead += st.size;
    const detected = decodeDetected(full, buf);
    if (detected.binary) return true;

    const getBuf = (): Buffer | null => buf;

    const info2 = detected.charsetInfo;
    let text = detected.text;
    if (info2?.warn) {
      // Conservative display upgrade: when the encoding is uncertain and the
      // primary guess is a single-byte (non-CJK) charset, prefer a CJK decode
      // that round-trips and actually contains CJK characters. This fixes the
      // mojibake display for short GBK/Big5 files even in ASCII-pattern mode.
      if (!CJK_ENCODINGS.includes(detected.encoding) && detected.encoding !== "utf8" && (info2.confidence ?? 0) < 40) {
        const b = getBuf();
        if (b) {
          for (const enc of CJK_ENCODINGS) {
            const t = strictDecode(b, enc);
            if (t && maxCjkRun(t) >= CJK_RUN_MIN) {
              text = t;
              break;
            }
          }
        }
      }
      if (collect(full, text) === 0) {
        // Non-ASCII pattern that the primary/upgraded decode missed: try the
        // detector's candidates plus the CJK fallbacks.
        const b = getBuf();
        if (b) {
          const order: string[] = [];
          for (const c of info2.candidates ?? []) order.push(c.encoding);
          order.push(...CJK_ENCODINGS);
          const seen = new Set<string>([detected.encoding]);
          for (const enc of order) {
            if (seen.has(enc)) continue;
            seen.add(enc);
            const t = strictDecode(b, enc);
            if (t === null) continue;
            if (collect(full, t) > 0) break;
          }
        }
      }
    } else {
      collect(full, text);
    }
    return matches.length < limit;
  };

  if (info.isFile()) {
    considerFile(requested);
  } else {
    const stack: Array<{ dir: string; rules: IgnoreRule[] }> = [{ dir: root, rules: loadIgnore(root, []) }];
    scan: while (stack.length > 0) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      if (Date.now() - start > TIME_BUDGET_MS) {
        timedOut = true;
        budget.timedOut = true;
        break;
      }
      const { dir, rules } = stack.pop() as { dir: string; rules: IgnoreRule[] };
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue; // hidden (rg default)
        const full = path.join(dir, entry.name);
        const isDir = entry.isDirectory();
        if (isIgnored(full, isDir, rules)) continue;
        if (isDir) {
          stack.push({ dir: full, rules: loadIgnore(full, rules) });
          continue;
        }
        // Do not follow symlinks/junctions (ripgrep's default). On Windows a
        // directory junction reports isDirectory() === false and only
        // isSymbolicLink() === true, so without this it would be handed to the
        // file reader and throw EISDIR, aborting the entire search.
        if (entry.isSymbolicLink()) continue;
        scannedFiles++;
        if (params.include) {
          // gitignore/ripgrep semantics: a glob without a slash matches the
          // basename at any depth (so "*.cpp" is recursive — that is what users
          // expect, and what ripgrep's `-g '*.cpp'` does); a glob that contains
          // a slash is matched against the path relative to the searched root.
          const target = params.include.includes("/") ? toPosix(path.relative(root, full)) : entry.name;
          if (!micromatch.isMatch(target, params.include, { dot: true })) {
            includeFiltered++;
            continue;
          }
        }
        includeMatched++;
        // Give the event loop a turn between slices (so a huge scan cannot
        // stall the server) and re-check the time budget per file, not just
        // per directory.
        if (Date.now() - sliceStart >= YIELD_AFTER_MS) {
          await setImmediateP();
          sliceStart = Date.now();
          if (sliceStart - start > TIME_BUDGET_MS) {
            timedOut = true;
            budget.timedOut = true;
            break scan;
          }
        }
        if (!considerFile(full)) break scan;
      }
    }
  }

  if (aborted) throw new Error("Tool execution interrupted: grep");
  if (matches.length >= limit) hitLimit = true;
  const budgetHit = budget.timedOut;

  // Human-readable detail of why the search stopped early, with its scale.
  const budgetSummary = (): string => {
    const parts: string[] = [];
    const secs = TIME_BUDGET_MS / 1000;
    if (budget.timedOut) parts.push(`timed out after ${Number.isInteger(secs) ? secs + "s" : TIME_BUDGET_MS + "ms"}`);
    parts.push(`scanned ${scannedFiles} file(s), read ${filesRead}`);
    return parts.join("; ");
  };

  const meta = { matches: matches.length, truncated: hitLimit, budgetHit, budget, timedOut, scannedFiles, includeMatched, includeFiltered, filesRead, bytesRead };
  if (matches.length === 0) {
    let why: string;
    if (budgetHit) {
      why = `No matches — search was cut short (${budgetSummary()})`;
    } else if (params.include && includeMatched === 0) {
      // Distinguish "the include filter excluded everything" from a genuine
      // no-match, so a too-narrow pattern is not mistaken for "nothing is there".
      why =
        `No files found — the include pattern "${params.include}" matched none of the ${scannedFiles} file(s) scanned` +
        (params.include.includes("/") ? ` (patterns with "/" are matched relative to the searched root, e.g. "Code/*.cpp").` : ".");
    } else {
      why = "No files found";
    }
    return { title: params.pattern, output: why, metadata: meta };
  }

  matches.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)));
  const output = [`Found ${matches.length} matches${hitLimit ? " (more matches available)" : ""}`];
  let current = "";
  for (const m of matches) {
    if (current !== m.path) {
      if (current !== "") output.push("");
      current = m.path;
      output.push(`${m.path}:`);
    }
    output.push(`  Line ${m.line}: ${m.text}`);
  }
  if (hitLimit) {
    output.push("");
    output.push("(Results truncated. Consider using a more specific path or pattern.)");
  }
  // Independent of the match limit: say so when the scan itself stopped early.
  if (budgetHit) {
    output.push("");
    output.push(`(Search was cut short — ${budgetSummary()}. Results may be incomplete.)`);
  }
  return { title: params.pattern, output: output.join("\n"), metadata: meta };
}
