export type Eol = "\n" | "\r\n";

// New files adopt the platform convention: CRLF on Windows, LF elsewhere.
export const defaultEol: Eol = process.platform === "win32" ? "\r\n" : "\n";

export function eolName(eol: Eol): string {
  return eol === "\r\n" ? "CRLF" : "LF";
}

// Dominant line ending of an existing file. Mirrors the native heuristic:
// any CRLF present means the file is treated as CRLF.
export function detectEol(text: string): Eol {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

// Inspect a model-provided string. Pure LF / pure CRLF (or no newline) is
// "clean"; mixing LF with CRLF (or lone CR) is flagged.
export function analyzeText(text: string): { eol: Eol | null; mixed: boolean } {
  const crlf = (text.match(/\r\n/g) || []).length;
  const rest = text.replace(/\r\n/g, "");
  const loneLf = (rest.match(/\n/g) || []).length;
  const loneCr = (rest.match(/\r/g) || []).length;
  const kinds = (crlf > 0 ? 1 : 0) + (loneLf > 0 ? 1 : 0) + (loneCr > 0 ? 1 : 0);
  if (kinds === 0) return { eol: null, mixed: false };
  if (kinds === 1) return { eol: crlf > 0 ? "\r\n" : "\n", mixed: false };
  return { eol: null, mixed: true };
}

// Normalize any line-ending style to the requested one.
export function normalizeTo(text: string, eol: Eol): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return eol === "\n" ? normalized : normalized.replace(/\n/g, "\r\n");
}

// EOL-insensitive replacement. Matching happens on a normalized view (CRLF and
// lone CR become LF), so an oldString written with any line-ending style — or
// copied out of a file that mixes CRLF and LF — still matches. Match offsets
// are mapped back to the original text, so every byte outside the matched
// region keeps its exact line ending: a mixed file is never reserialized.
export function replaceEolInsensitive(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { replacements: number; text: string } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    map.push(i);
    if (text[i] === "\r") {
      norm += "\n";
      if (text[i + 1] === "\n") i++;
    } else {
      norm += text[i];
    }
  }
  map.push(text.length);

  const needle = normalizeTo(oldString, "\n");
  const replacement = normalizeTo(newString, "\n");
  const spans: Array<[number, number]> = [];
  if (needle.length > 0) {
    let offset = 0;
    for (;;) {
      const at = norm.indexOf(needle, offset);
      if (at === -1) break;
      spans.push([at, at + needle.length]);
      offset = at + needle.length;
    }
  }

  // Apply from the end so earlier offsets stay valid.
  const chosen = replaceAll ? spans : spans.slice(0, 1);
  let out = text;
  for (let k = chosen.length - 1; k >= 0; k--) {
    const [s, e] = chosen[k];
    const start = map[s];
    const end = map[e];
    // Insert with the line-ending style the matched region actually used, so a
    // mixed file keeps its local convention; fall back to the file's dominant.
    const matched = text.slice(start, end);
    const local: Eol = matched.includes("\r\n") ? "\r\n" : matched.includes("\n") ? "\n" : detectEol(text);
    const insert = local === "\n" ? replacement : replacement.replace(/\n/g, "\r\n");
    out = out.slice(0, start) + insert + out.slice(end);
  }
  return { replacements: spans.length, text: out };
}

// Model-facing warning appended to a successful tool result. `eol` is the
// target file's style; omit it for multi-file tools such as patch.
export function mixedEolWarning(eol?: Eol): string {
  const parts = ["Warning: the text you provided mixes LF and CRLF line endings."];
  parts.push(
    eol
      ? `This file uses ${eolName(eol)}; the content was normalized to ${eolName(eol)} automatically.`
      : "The content was normalized to each target file's own line-ending style automatically.",
  );
  parts.push("Provide a single, consistent line-ending style (all LF or all CRLF); both are accepted and converted automatically.");
  return parts.join(" ");
}
