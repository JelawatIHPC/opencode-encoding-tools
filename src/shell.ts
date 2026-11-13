import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import chardet from "chardet";
import iconv from "iconv-lite";
import { bomInfo, canonicalizeCharset } from "./charset";

// `shell`: backs the native `shell` tool name with a charset-adaptive
// implementation. Instead of letting the host decode child stdout as UTF-8
// (which mangles GBK/cp936), we spawn the process ourselves, capture the RAW
// bytes, and decode with charset detection. No encoding prologue is injected.
//
// Decode order: BOM -> strict UTF-8 -> confident chardet -> per-line/console
// code page. The console code page is the key fallback: PowerShell and native
// tools on a Chinese Windows emit cp936, and chardet often mis-guesses short
// GBK text.

export interface ShellParams {
  command: string;
  workdir?: string;
  timeout?: number;
  background?: boolean;
}

// Optional host hooks. `notify` injects a completion message into the session,
// using the same mechanism as the native shell (Session.synthetic).
export interface ShellHooks {
  sessionID?: string;
  notify?: (event: { sessionID: string; description: string; text: string; metadata: any }) => Promise<unknown> | unknown;
}

export interface ToolReturn {
  title: string;
  output: string;
  metadata: any;
}

const IS_WIN = process.platform === "win32";
const DEFAULT_TIMEOUT = 120_000;
// Native tool-output truncation defaults (opencode `tool_output` config):
// 2000 lines / 51200 bytes. Unlike a plain head cut, the TAIL is kept because
// errors and summaries land at the end of the output.
const MAX_PREVIEW_LINES = 2000;
const MAX_PREVIEW_BYTES = 51200;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const DETECT_SAMPLE_BYTES = 256 * 1024;
const MAX_LINE_DECODE_BYTES = 8 * 1024 * 1024;

// Native shell status/notice texts, kept verbatim for parity.
const RUNNING_NOTICE =
  "You will be notified automatically when the command finishes. The notification will include the command's output. " +
  "Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. " +
  "Repeatedly sleeping and reading or searching the output file is polling, not useful work. " +
  "You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. " +
  "Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes.";

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

function shellInvocation(command: string): { file: string; args: string[] } {
  if (IS_WIN) return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
  return { file: "/bin/sh", args: ["-c", command] };
}

// The console output code page PowerShell emits in (cp936 on Chinese Windows).
// Queried once and cached.
let cachedConsoleEnc: string | undefined;
export function consoleEncoding(): string {
  if (cachedConsoleEnc) return cachedConsoleEnc;
  if (!IS_WIN) return (cachedConsoleEnc = "utf8");
  try {
    const r = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding.WebName"], { encoding: "utf8", windowsHide: true });
    cachedConsoleEnc = canonicalizeCharset((r.stdout || "").trim()) || "gb18030";
  } catch {
    cachedConsoleEnc = "gb18030";
  }
  return cachedConsoleEnc as string;
}

export interface DecodeResult {
  text: string;
  encoding: string;
  source: string;
  confidence?: number;
}

export function decodeShellOutput(buf: Buffer): DecodeResult {
  if (buf.length === 0) return { text: "", encoding: "utf8", source: "empty" };
  const bom = bomInfo(buf);
  if (bom) return { text: iconv.decode(buf.subarray(bom.offset), bom.encoding), encoding: bom.encoding, source: "bom" };
  try {
    return { text: UTF8_FATAL.decode(buf), encoding: "utf8", source: "utf8" };
  } catch {
    /* not UTF-8 */
  }
  const sample = buf.length > DETECT_SAMPLE_BYTES ? buf.subarray(0, DETECT_SAMPLE_BYTES) : buf;
  let matches: Array<{ confidence: number; name: string }> = [];
  try {
    matches = (chardet.analyse(sample) ?? [])
      .filter((m: any) => !!m && m.confidence > 0)
      .map((m: any) => ({ confidence: m.confidence, name: m.name as string }));
  } catch {
    /* ignore */
  }
  const cp = consoleEncoding();
  const top = matches[0];
  if (top) {
    const enc = canonicalizeCharset(top.name);
    // Only trust a *confident* detection, and not when it merely re-confirms the
    // console code page: falling through to the per-line path then decodes pure
    // console-CP text identically while still rescuing mixed UTF-8 lines.
    if (enc && enc !== "utf8" && enc !== cp && top.confidence >= 90) {
      return { text: iconv.decode(buf, enc), encoding: enc, source: "chardet", confidence: top.confidence };
    }
  }
  // No injection is used, so one command may blend encodings (e.g. GBK
  // PowerShell text plus a UTF-8-emitting native tool). Decode line by line:
  // each line that is valid UTF-8 stays UTF-8, otherwise use the console code
  // page. 0x0A is a newline in every ASCII-compatible encoding.
  if (buf.length <= MAX_LINE_DECODE_BYTES) {
    const mixed = decodePerLineAdaptive(buf, cp);
    if (mixed) return mixed;
  }
  return { text: iconv.decode(buf, cp), encoding: cp, source: "console" };
}

function hasNonAsciiByte(b: Buffer): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] >= 0x80) return true;
  return false;
}

function decodePerLineAdaptive(buf: Buffer, cp: string): DecodeResult | null {
  const segs = buf.toString("latin1").split("\n");
  const used = new Set<string>();
  const out: string[] = [];
  for (const seg of segs) {
    const line = Buffer.from(seg, "latin1");
    if (!hasNonAsciiByte(line)) {
      out.push(seg);
      continue;
    }
    try {
      out.push(UTF8_FATAL.decode(line));
      used.add("utf8");
    } catch {
      out.push(iconv.decode(line, cp));
      used.add(cp);
    }
  }
  if (used.size === 0) return null;
  const encoding = used.size > 1 ? `mixed(${[...used].join("+")})` : [...used][0];
  return { text: out.join("\n"), encoding, source: "per-line" };
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    /* ignore */
  }
}

// Resolve a workdir the same way the host's directory resolver does for the
// native shell: expand a leading `~` to the home directory, then resolve
// relative paths against the current working directory.
function resolveWorkdir(workdir: string | undefined, cwd: string): string {
  if (!workdir) return cwd;
  let w = workdir;
  if (w === "~") w = os.homedir();
  else if (w.startsWith("~/") || w.startsWith("~\\")) w = path.join(os.homedir(), w.slice(2));
  return path.isAbsolute(w) ? path.normalize(w) : path.resolve(cwd, w);
}

// Validate up front so a bad workdir reports something useful instead of the
// opaque ENOENT from uv_spawn (`spawn powershell.exe ENOENT`).
function assertWorkdir(dir: string): void {
  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(dir, { throwIfNoEntry: false }) as fs.Stats | undefined;
  } catch {
    st = undefined;
  }
  if (!st) throw new Error(`Working directory does not exist: ${dir}`);
  if (!st.isDirectory()) throw new Error(`Working directory is not a directory: ${dir}`);
}

// ---------------------------------------------------------------------------
// Write-command guard
//
// A shell text pipeline (Get-Content | Set-Content, Out-File, Add-Content) is the
// easiest way to silently change a file's bytes: PowerShell re-encodes on the way
// out (adding or dropping a BOM, switching to UTF-16LE) and its universal-newline
// handling collapses CRLF to LF. A dedicated tool already preserves encoding, BOM
// and per-line EOL, so these commands are refused outright. Deleting files is
// likewise routed to the recycle bin: an unrecoverable delete is never what a
// task actually needs.
//
// Every entry matches at a *command position* (start of a statement, after a
// pipe/separator, after an opening bracket, or after `=`/`,`), never as a bare
// substring. That keeps read-only work usable — `Select-String -Pattern
// "Set-Content"` and a filename like `mySet-Content.py` must not be refused —
// while still catching every real invocation, including `| Out-File`.
//
// `>` / `>>` redirection is deliberately NOT guarded here: the project's build
// convention relies on `> $null`, and shell redirection is constrained by the
// project instructions instead of by the tool.
// ---------------------------------------------------------------------------

// A statement starts at the beginning of the command, after a pipe or statement
// separator, after an opening bracket, or after `=`/`,` (an assignment right-hand
// side). `$(` covers subexpressions; `$rm = 1` stays allowed because `$` is not a
// statement boundary.
const STMT_PREFIX = "(?:^|[|;&\\n({=,]|\\$\\()";

// Build a command-position matcher. Group 1 (plain form) / group 2 (call-operator
// form) capture the matched name so the error can echo the alias the model used
// (`ri` rather than a generic `Remove-Item`). The trailing lookahead keeps
// `Set-ContentX` and `mySet-Content` from matching.
function cmd(names: string[]): RegExp {
  const alt = names.join("|");
  return new RegExp(`(?:${STMT_PREFIX}\\s*(${alt})|&\\s*['"](${alt})['"])(?=[\\s|;&)(]|$)`, "i");
}

interface ForbiddenCommand {
  // Prefix used when the matcher cannot report a name (fixed-flag forms).
  name: string;
  command: RegExp;
  message: (matched: string) => string;
}

const FORBIDDEN_COMMANDS: ForbiddenCommand[] = [
  {
    name: "Out-File",
    command: cmd(["Out-File"]),
    message: (m) =>
      `${m} is disabled because it may change file encoding silently. ` +
      `Use the write/edit/patch tools, or put the command in a script file for legitimate case.`,
  },
  {
    name: "Set-Content",
    command: cmd(["Set-Content"]),
    message: (m) =>
      `${m} is disabled because it may change file encoding silently. ` +
      `Use the write/edit/patch tools, or put the command in a script file for legitimate case.`,
  },
  {
    name: "Add-Content",
    command: cmd(["Add-Content"]),
    message: (m) =>
      `${m} is disabled because it may create mixed encoding silently. ` +
      `Use the write/edit/patch tools, or put the command in a script file for legitimate case.`,
  },
  {
    name: "Clear-Content",
    command: cmd(["Clear-Content"]),
    message: (m) =>
      `${m} is disabled because it deletes content irreversibly. ` +
      `Use the write tool with the intended content instead, or put the command in a script file for legitimate case.`,
  },
  {
    name: "Remove-Item",
    // PowerShell resolves ri/rm/del/erase/rd/rmdir to Remove-Item, so the aliases
    // must be covered too.
    command: cmd(["Remove-Item", "ri", "rm", "del", "erase", "rd", "rmdir"]),
    message: (m) =>
      `${m} is disabled because it deletes file or directory irreversibly. ` +
      `Move the target to the recycle bin via \`[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile\` or ` +
      `\`[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory\` instead.`,
  },
  {
    name: ".NET file write",
    command: cmd([
      "\\[System\\.IO\\.File\\]::WriteAllText",
      "\\[System\\.IO\\.File\\]::WriteAllBytes",
      "\\[System\\.IO\\.File\\]::WriteAllLines",
      "\\[System\\.IO\\.File\\]::AppendAllText",
      "\\[System\\.IO\\.File\\]::AppendAllLines",
      "\\[System\\.IO\\.File\\]::Delete",
      "\\[System\\.IO\\.Directory\\]::Delete",
    ]),
    message: () =>
      `Direct .NET file writes are disabled because it may change file encoding silently. ` +
      `Use the write/edit/patch tools, or put the command in a script file for legitimate case.`,
  },
  {
    name: "sed -i",
    command: new RegExp(`${STMT_PREFIX}\\s*sed\\s+(?:-[A-Za-z]*i[A-Za-z]*\\b|--in-place)`, "i"),
    message: () =>
      `In-place sed is disabled because it rewrites the file with sed's own byte handling. ` +
      `Use the edit/patch tools, or put the command in a script file for legitimate case.`,
  },
  {
    name: "truncate",
    command: new RegExp(`${STMT_PREFIX}\\s*truncate\\s+-`, "i"),
    message: () =>
      `truncate is disabled because it changes a file's size in place, destroying its content with no way back. ` +
      `Use the write/edit/patch tools, or put the command in a script file for legitimate case.`,
  },
  {
    name: "dd",
    command: new RegExp(`${STMT_PREFIX}\\s*dd\\s[^\\n]*\\b(?:if|of)=`, "i"),
    message: () =>
      `dd is disabled because it writes raw bytes over a file, destroying its content and charset. ` +
      `Use the write/edit/patch tools, or put the command in a script file for legitimate case.`,
  },
];

function assertWriteSafe(command: string): void {
  for (const f of FORBIDDEN_COMMANDS) {
    const m = f.command.exec(command);
    if (!m) continue;
    // Echo the alias the model actually used (`del`, `ri`, ...); fall back to the
    // entry's canonical name when the matcher carries no capture group.
    const matched = m[1] || m[2] || f.name;
    throw new Error(`${matched}: ${f.message(matched)}`);
  }
}

interface Preview {
  body: string;
  truncated: boolean;
  startLine: number;
  totalLines: number;
}

// Keep the TAIL of the output, bounded by MAX_PREVIEW_LINES lines and
// MAX_PREVIEW_BYTES bytes, mirroring the native shell's truncation.
function previewTail(text: string): Preview {
  const endsNL = text.endsWith("\n");
  const all = text.split("\n");
  if (endsNL) all.pop();
  const totalLines = all.length;
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= MAX_PREVIEW_BYTES && totalLines <= MAX_PREVIEW_LINES) {
    return { body: text, truncated: false, startLine: 1, totalLines };
  }
  const kept = all.length > MAX_PREVIEW_LINES ? all.slice(-MAX_PREVIEW_LINES) : all.slice();
  let body = kept.join("\n");
  while (kept.length > 1 && Buffer.byteLength(body, "utf8") > MAX_PREVIEW_BYTES) {
    kept.shift();
    body = kept.join("\n");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_PREVIEW_BYTES) body = body.slice(-MAX_PREVIEW_BYTES);
  return { body, truncated: true, startLine: totalLines - kept.length + 1, totalLines };
}

function shellId(): string {
  return "sh_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

function outputFilePath(id: string): string {
  const dir = path.join(os.tmpdir(), "opencode", "shell");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, id + ".out");
}

// Spill the RAW stdout/stderr bytes (not a re-encoded copy), so the file is an
// exact dump of what the command wrote.
function spillRaw(buf: Buffer): string {
  const file = outputFilePath(shellId());
  fs.writeFileSync(file, buf);
  return file;
}

// Build the completion notification for a finished background command. Mirrors
// the native shell's `k9(...)`: the message body is a `<shell ...>` block, and
// the metadata carries `{source:"shell", shellID, state, ...}`. Unlike native, the
// output is decoded with our charset detection, so the body is not mojibake.
function buildCompletionNotice(id: string, command: string, raw: Buffer, code: number | null, outFile: string): { message: string; metadata: any } {
  let text = "";
  try {
    text = decodeShellOutput(raw).text;
  } catch {
    text = "";
  }
  let body = text || "(no output)";
  let truncated = false;
  if (text) {
    const preview = previewTail(text);
    if (preview.truncated) {
      truncated = true;
      body = `${preview.body || "(no output)"}\n\n[showing lines ${preview.startLine}-${preview.totalLines} of ${preview.totalLines}; full output saved to ${outFile}]\n[output truncated]`;
    }
  }
  const suffix = code === 0 ? "" : code === null || code === undefined ? "\n\nExited with code unknown" : `\n\nExited with code ${code}`;
  const state = "completed";
  const message = `<shell id="${id}" state="${state}" command="${command}">\n${body}${suffix}\n</shell>`;
  const metadata: any = {
    source: "shell",
    shellID: id,
    state,
    command,
    outputPath: outFile,
    ...(truncated ? { truncated: true } : {}),
    ...(code !== 0 && code !== null && code !== undefined ? { exit: code } : {}),
  };
  return { message, metadata };
}

export async function shellTool(params: ShellParams, cwd: string, signal?: AbortSignal, hooks?: ShellHooks): Promise<ToolReturn> {
  const command = typeof params.command === "string" ? params.command : "";
  // Enforced in code rather than via a schema `minimum` keyword, so the exposed
  // input schema stays identical to the native shell's wording.
  if (typeof params.timeout === "number" && params.timeout < 0) {
    throw new Error("timeout: Expected a value greater than or equal to 0");
  }
  assertWriteSafe(command);
  const workdir = resolveWorkdir(params.workdir, cwd);
  assertWorkdir(workdir);
  const { file, args } = shellInvocation(command);

  if (params.background) {
    const id = shellId();
    const outFile = outputFilePath(id);
    // Native parity: pipe the child's output into the file from the parent (the
    // opencode server is long-lived), rather than handing a raw fd to a detached
    // process — the latter does not capture output reliably on Windows.
    if (!fs.existsSync(outFile)) fs.writeFileSync(outFile, ""); // exist immediately for tailing
    const out = fs.createWriteStream(outFile, { flags: "a" });
    const child = spawn(file, args, { cwd: workdir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (d: Buffer) => out.write(d));
    child.stderr?.on("data", (d: Buffer) => out.write(d));
    child.on("close", (code) => {
      out.end(() => {
        if (!hooks?.notify || !hooks.sessionID) return;
        const sessionID = hooks.sessionID;
        const notify = hooks.notify;
        let notice: { message: string; metadata: any };
        try {
          const raw = fs.existsSync(outFile) ? fs.readFileSync(outFile) : Buffer.alloc(0);
          notice = buildCompletionNotice(id, command, raw, code, outFile);
        } catch (e) {
          notice = {
            message: `<shell id="${id}" state="completed" command="${command}">\n(could not read output: ${(e as Error).message})\n</shell>`,
            metadata: { source: "shell", shellID: id, state: "completed", command, outputPath: outFile },
          };
        }
        Promise.resolve(notify({ sessionID, description: command, text: notice.message, metadata: notice.metadata })).catch(() => {});
      });
    });
    // Native parity: the shell tool returns "moved to the background" and, while
    // the shell is still running, the running notice as well.
    return {
      title: command,
      output: `Command moved to the background (shell ID: ${id}).\nOutput is streaming to: ${outFile}\n${RUNNING_NOTICE}`,
      metadata: { background: true, pid: child.pid, shellID: id, outputPath: outFile, workdir },
    };
  }

  const timeout = params.timeout === undefined ? DEFAULT_TIMEOUT : Math.max(0, params.timeout);

  return await new Promise<ToolReturn>((resolve, reject) => {
    const child = spawn(file, args, { cwd: workdir, windowsHide: true });
    const chunks: Buffer[] = [];
    let captured = 0;
    let overflow = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const onData = (d: Buffer) => {
      if (captured >= MAX_CAPTURE_BYTES) {
        overflow = true;
        return;
      }
      captured += d.length;
      chunks.push(d);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let timer: NodeJS.Timeout | undefined;
    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeout);
    }
    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Failed to run command: ${(err as Error).message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const buf = Buffer.concat(chunks);
      const dec = decodeShellOutput(buf);
      const text = dec.text;
      let output = text || "(no output)";
      let fullOutputPath: string | undefined;
      let truncated = false;

      if (text) {
        const preview = previewTail(text);
        if (preview.truncated) {
          fullOutputPath = spillRaw(buf);
          truncated = true;
          output = `${preview.body || "(no output)"}\n\n[showing lines ${preview.startLine}-${preview.totalLines} of ${preview.totalLines}; full output saved to ${fullOutputPath}]\n[output truncated]`;
        }
      }

      // Status suffix, aligned with the native shell:
      //   timeout -> "Timed out before completion (<ms> ms)"
      //   abort   -> "Cancelled"
      //   exit 0  -> none
      //   exit N  -> "Exited with code N"
      //   unknown -> "Exited with code unknown"
      if (timedOut) output += `\n\nTimed out before completion (${timeout} ms)`;
      else if (aborted) output += `\n\nCancelled`;
      else if (code === 0) {
        /* exit 0: no suffix */
      } else if (code === null || code === undefined) output += `\n\nExited with code unknown`;
      else output += `\n\nExited with code ${code}`;
      if (overflow) output += `\n\n[output exceeded ${Math.round(MAX_CAPTURE_BYTES / 1024 / 1024)}MB capture cap; further output was discarded]`;

      resolve({
        title: command,
        output,
        metadata: {
          exitCode: code,
          encoding: dec.encoding,
          decodeSource: dec.source,
          ...(dec.confidence !== undefined ? { confidence: dec.confidence } : {}),
          timedOut,
          aborted,
          truncated,
          ...(fullOutputPath ? { fullOutputPath } : {}),
          workdir,
        },
      });
    });
  });
}
