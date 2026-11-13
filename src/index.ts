import * as path from "path";
import * as fs from "fs";
import { readTool } from "./read";
import { writeTool } from "./write";
import { grepTool } from "./grep";
import { editTool } from "./edit";
import { patchTool } from "./patch";
import { shellTool } from "./shell";

function nativeFor(editor: any, id: string) {
  return editor.get(id);
}

// The runtime plugin-tool adapter expects execute() to return `{ content, metadata }`
// when the tool declares no output schema (see the V2 docs Tool example). Our inner
// tools return the legacy `{ title, output, metadata }` shape, so adapt it here.
function toResult(result: { output: string; metadata?: any }) {
  return {
    content: result.output,
    ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
  };
}

// ---------------------------------------------------------------------------
// Batch digest coordinator (PoC)
//
// Host limitation: when several plugin tools fail in the same assistant message
// ("batch"), the host attributes every rejection to the first call, so the model
// sees one wrong error repeated. Successes are delivered correctly.
//
// Workaround: group calls by context.messageID so every *failing* call throws the
// SAME ordered digest of the whole batch. Cross-talk then collapses identical
// messages, and the model still gets the full, ordered picture. Successful calls
// return their own content unchanged (and never wait).
// ---------------------------------------------------------------------------

type SlotStatus = "pending" | "ok" | "err";

interface BatchSlot {
  id: string;
  idx: number;
  label: string;
  status: SlotStatus;
  text: string;
}

interface Batch {
  mid: string;
  order: string[];
  slots: Map<string, BatchSlot>;
  pending: number;
  collectUntil: number;
  allDone: Promise<void>;
  resolveAll: () => void;
  resolved: boolean;
  collectTimer?: any;
}

const BATCH_GRACE_MS = 30; // window for concurrent siblings to register (entries land within ~1ms)
const BATCH_MAX_WAIT_MS = 5000; // hard cap so a slow sibling cannot hang a failure forever
// Digest text budget, adaptive to batch size: more calls -> shorter per-call cap.
const DIGEST_TOTAL_CHARS = 2000;
const DIGEST_MAX_LINE = 500;
const DIGEST_MIN_LINE = 80;

const batches = new Map<string, Batch>();

function callIndex(id: string): number {
  const m = /^call_(\d+)/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function getBatch(mid: string): Batch {
  const existing = batches.get(mid);
  if (existing) return existing;
  let resolveAll: () => void = () => {};
  const allDone = new Promise<void>((r) => (resolveAll = r));
  const b: Batch = { mid, order: [], slots: new Map(), pending: 0, collectUntil: Date.now() + BATCH_GRACE_MS, allDone, resolveAll, resolved: false };
  batches.set(mid, b);
  // Safety net: always release waiters eventually, then clean up.
  const timer: any = setTimeout(() => {
    b.resolved = true;
    b.resolveAll();
    setTimeout(() => batches.delete(mid), 60_000);
  }, BATCH_MAX_WAIT_MS);
  timer?.unref?.();
  return b;
}

function register(b: Batch, id: string, label: string): BatchSlot {
  const slot: BatchSlot = { id, idx: callIndex(id), label, status: "pending", text: "" };
  b.slots.set(id, slot);
  b.order.push(id);
  b.pending += 1;
  return slot;
}

// Resolve the batch only when nothing is left pending AND the registration
// window has elapsed. The window timer re-checks `pending`, because a fast
// (synchronous) failure can drive it to 0 before its siblings even register.
function maybeResolve(b: Batch): void {
  if (b.resolved || b.pending > 0) return;
  const wait = b.collectUntil - Date.now();
  if (wait <= 0) {
    b.resolved = true;
    b.resolveAll();
    return;
  }
  if (b.collectTimer) return;
  b.collectTimer = setTimeout(() => {
    b.collectTimer = undefined;
    maybeResolve(b);
  }, wait);
  b.collectTimer?.unref?.();
}

function settle(b: Batch, slot: BatchSlot, status: SlotStatus, text: string): void {
  slot.status = status;
  slot.text = text;
  b.pending -= 1;
  maybeResolve(b);
}

// Per-call text cap, adaptive to the batch size (more calls -> shorter lines).
function digestLineCap(n: number): number {
  if (n <= 1) return DIGEST_MAX_LINE;
  return Math.max(DIGEST_MIN_LINE, Math.min(DIGEST_MAX_LINE, Math.floor(DIGEST_TOTAL_CHARS / n)));
}

function batchDigest(b: Batch): string {
  const slots = [...b.slots.values()].sort((a, z) => a.idx - z.idx || b.order.indexOf(a.id) - b.order.indexOf(z.id));
  const cap = digestLineCap(slots.length);
  const failed = slots.filter((s) => s.status === "err").length;
  const lines = slots.map((s, i) => {
    const tag = s.status === "ok" ? "ok " : s.status === "err" ? "ERR" : "…  ";
    const flat = (s.text || "").replace(/\s*\r?\n\s*/g, " ⏎ ").trim();
    const shown = flat.length > cap ? flat.slice(0, cap) + "…" : flat;
    return `  [${i + 1}] ${s.label.padEnd(7)} ${tag} ${shown}`;
  });
  return `Batch: ${slots.length} call(s), ${failed} failed\n${lines.join("\n")}`;
}

function contentText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (p && p.type === "text" && typeof p.text === "string" ? p.text : p && p.type === "file" ? `<file ${p.name ?? ""}>` : ""))
      .filter(Boolean)
      .join(" ");
  }
  if (content === undefined || content === null) return "";
  return String(content);
}

// Run one tool call as part of a batch. Successful calls return immediately; a
// failing call waits (bounded) for its siblings and throws the shared digest.
async function runInBatch<T>(messageID: string | undefined, callID: string | undefined, label: string, run: () => Promise<T>): Promise<T> {
  if (!messageID || !callID) return run();
  const b = getBatch(messageID);
  const slot = register(b, callID, label);
  try {
    const res = await run();
    settle(b, slot, "ok", contentText((res as any)?.content));
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    settle(b, slot, "err", msg);
    if (b.slots.size <= 1) throw err; // single-call batch: keep the raw error semantics
    await Promise.race([b.allDone, new Promise<void>((r) => setTimeout(r, BATCH_MAX_WAIT_MS))]);
    throw new Error(batchDigest(b));
  }
}

function imageMime(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}

function isPdf(buf: Buffer, filepath: string): boolean {
  return buf.subarray(0, 4).toString("latin1") === "%PDF" || path.extname(filepath).toLowerCase() === ".pdf";
}

const CHARSET_DESCRIPTION = 'Generally not required: character set, default utf-8. "utf8bom" (alias "utf-8-sig") means UTF-8 with a BOM.';
const CHARSET_WRITE_DESCRIPTION = CHARSET_DESCRIPTION + " A missing BOM is added with a warning.";

// The native tools' input schemas are redacted to a stub function when exposed to
// plugins, so an extra property cannot be merged in. We therefore declare the
// schemas explicitly, preserving the native fields plus `charset`. `grep` keeps
// the native schema because it takes no charset (it spans many files).
const READ_INPUT = {
  type: "object",
  properties: {
    path: { type: "string", description: "The file or directory path to read." },
    offset: { type: "number", description: "Line number to start reading from (1-based)." },
    limit: { type: "number", description: "Maximum number of lines to read." },
    charset: { type: "string", description: CHARSET_DESCRIPTION },
  },
  required: ["path"],
  additionalProperties: false,
};

const WRITE_INPUT = {
  type: "object",
  properties: {
    path: { type: "string", description: "The file path to write to (created if missing)." },
    content: { type: "string", description: "The full file content to write." },
    charset: { type: "string", description: CHARSET_WRITE_DESCRIPTION },
  },
  required: ["path", "content"],
  additionalProperties: false,
};

const EDIT_INPUT = {
  type: "object",
  properties: {
    path: { type: "string", description: "The file path to edit." },
    oldString: { type: "string", description: "Exact text to replace. Must match uniquely unless replaceAll is true." },
    newString: { type: "string", description: "Replacement text." },
    replaceAll: { type: "boolean", description: "Replace every occurrence of oldString." },
    charset: { type: "string", description: CHARSET_WRITE_DESCRIPTION },
  },
  required: ["path", "oldString", "newString"],
  additionalProperties: false,
};

const PATCH_INPUT = {
  type: "object",
  properties: {
    patchText: { type: "string", description: "The full patch text (*** Begin Patch ... *** End Patch)." },
    charset: { type: "string", description: CHARSET_WRITE_DESCRIPTION },
  },
  required: ["patchText"],
  additionalProperties: false,
};

const SHELL_INPUT = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command string to execute" },
    workdir: {
      type: "string",
      description:
        "Working directory to execute the command in. Defaults to the current working directory. " +
        "When possible, avoid changing directories in the command and set the working directory here instead.",
    },
    timeout: {
      type: "number",
      description:
        "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. " +
        "Background commands have no timeout by default.",
    },
    background: {
      type: "boolean",
      description:
        "Run the command in the background and return immediately (useful for dev servers and long-running builds). " +
        "You do not need to use '&' at the end of the command when using this parameter. " +
        "You will be notified when it completes. DO NOT poll for completion.",
    },
  },
  required: ["command"],
  additionalProperties: false,
};

export default {
  id: "opencode-encoding-tools",
  async setup(ctx: any) {
    // The tool execution context does not expose the working directory, so capture
    // the per-location directory from setup. The plugin instance is scoped to its
    // location, so this is the correct base for resolving relative paths.
    const directory: string = ctx.location?.directory ?? process.cwd();

    const reg = await ctx.tool.transform((editor: any) => {
      const nativeShell = nativeFor(editor, "shell");

      // `shell`: our charset-adaptive implementation now backs the native tool
      // name (there is no separate `shell2`). Same interface as the native shell,
      // but the process is spawned here and its RAW stdout/stderr bytes are
      // decoded with charset detection (BOM -> strict UTF-8 -> confident chardet
      // -> console code page), fixing GBK/cp936 mojibake.
      if (nativeShell) {
        editor.remove("shell");
        editor.add({
          name: "shell",
          description: nativeShell.description,
          input: SHELL_INPUT,
          options: nativeShell.options ?? { codemode: false },
          async execute(input: any, context: any) {
            return runInBatch(context?.messageID, context?.id, "shell", async () =>
              toResult(
                await shellTool(input, directory, context?.signal, {
                  sessionID: context?.sessionID,
                  notify: ctx.session?.synthetic ? (event: any) => ctx.session.synthetic(event) : undefined,
                }),
              ),
            );
          },
        });
      }

      for (const id of ["read", "write", "grep", "edit"]) {
        const native = nativeFor(editor, id);
        if (!native) continue;
        const inputSchema = id === "read" ? READ_INPUT : id === "write" ? WRITE_INPUT : id === "edit" ? EDIT_INPUT : native.input;
        editor.remove(id);
        editor.add({
          name: native.name,
          description: native.description,
          input: inputSchema,
          options: native.options,
          async execute(input: any, context: any) {
            return runInBatch<any>(context?.messageID, context?.id, id, async () => {
              if (id === "read") {
                const filepath = path.isAbsolute(input.path) ? input.path : path.join(directory, input.path);
                const stat = fs.statSync(filepath, { throwIfNoEntry: false });
                if (stat && stat.isFile()) {
                  const buf = fs.readFileSync(filepath);
                  const mime = imageMime(buf) ?? (isPdf(buf, filepath) ? "application/pdf" : undefined);
                  if (mime) {
                    // Native read hands images/PDFs to the model as attachments.
                    return {
                      content: [
                        { type: "text", text: mime === "application/pdf" ? "PDF read successfully" : "Image read successfully" },
                        { type: "file", uri: `data:${mime};base64,${buf.toString("base64")}`, mime, name: path.basename(filepath) },
                      ],
                    };
                  }
                }
                return toResult(readTool({ ...input, filePath: input.path }, directory));
              }
              if (id === "write") return toResult(writeTool({ content: input.content, filePath: input.path, charset: input.charset }, directory));
              if (id === "grep") return toResult(await grepTool(input, directory, context?.signal));
              if (id === "edit") return toResult(editTool(input, directory));
              throw new Error(`Unknown tool: ${id}`);
            });
          },
        });
      }

      for (const id of ["patch", "apply_patch"]) {
        const native = nativeFor(editor, id);
        if (!native) continue;
        editor.remove(id);
        editor.add({
          name: native.name,
          description: native.description,
          input: PATCH_INPUT,
          options: native.options,
          async execute(input: any, context: any) {
            return runInBatch<any>(context?.messageID, context?.id, id, async () => toResult(patchTool(input, directory)));
          },
        });
      }
    });
    return async () => { await reg.dispose(); };
  },
};
