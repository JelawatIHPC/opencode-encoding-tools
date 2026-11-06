const fs = require("fs");
const path = require("path");
const { shellTool, decodeShellOutput, consoleEncoding } = require("../dist/shell.js");

const D = path.join(require("os").tmpdir(), "enctools-tests", "shelltest");
fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(D, { recursive: true });

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("PASS " + label); }
  else { fail++; console.log("FAIL " + label + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); }
}

async function main() {
  console.log("consoleEncoding() = " + consoleEncoding());

  // 1) pure ASCII
  {
    const r = await shellTool({ command: '"hello ascii"' }, D);
    check("ascii", r.output.trim() === "hello ascii", r.output);
  }

  // 2) PowerShell Chinese (console CP path)
  {
    const r = await shellTool({ command: '"中文测试 abc 123"' }, D);
    check("ps-chinese", r.output.trim() === "中文测试 abc 123", { out: r.output, meta: r.metadata });
  }

  // 3) native cmd Chinese
  {
    const r = await shellTool({ command: 'cmd /c "echo 中文cmd输出"' }, D);
    check("native-cmd", r.output.includes("中文cmd输出"), { out: r.output, meta: r.metadata });
  }

  // 4) native python Chinese
  {
    const r = await shellTool({ command: 'python -c "print(\'中文py输出\')"' }, D);
    check("native-python", r.output.includes("中文py输出"), { out: r.output, meta: r.metadata });
  }

  // 5) stderr merged
  {
    const r = await shellTool({ command: '[Console]::Error.WriteLine("ERR 中文错误"); "OUT 中文"' }, D);
    check("stderr-merged", r.output.includes("ERR 中文错误") && r.output.includes("OUT 中文"), r.output);
  }

  // 6) non-zero exit
  {
    const r = await shellTool({ command: 'cmd /c "exit 7"' }, D);
    check("nonzero-exit", /Exited with code/.test(r.output) && r.metadata.exitCode !== 0, { out: r.output, code: r.metadata.exitCode });
  }

  // 7) workdir
  {
    const sub = path.join(D, "sub dir");
    fs.mkdirSync(sub, { recursive: true });
    const r = await shellTool({ command: "(Get-Location).Path", workdir: sub }, D);
    check("workdir", r.output.trim().toLowerCase() === sub.toLowerCase(), { out: r.output, want: sub });
  }

  // 8) timeout
  {
    const r = await shellTool({ command: "Start-Sleep -Seconds 5; 'done'", timeout: 800 }, D);
    check("timeout", r.metadata.timedOut === true && /Timed out before completion \(800 ms\)/.test(r.output), { out: r.output, meta: r.metadata });
  }

  // 9) large output -> RAW-byte spill + preview, file content correct
  {
    const r = await shellTool({ command: '1..4000 | ForEach-Object { "行 $_ 中文内容 abcdefghijklmnopqrstuvwxyz" }' }, D);
    const ok = r.metadata.truncated === true && r.metadata.fullOutputPath && fs.existsSync(r.metadata.fullOutputPath);
    let fileOk = false, rawOk = false, markerOk = false;
    if (ok) {
      const iconv = require("iconv-lite");
      const raw = fs.readFileSync(r.metadata.fullOutputPath);
      const gbk = iconv.decode(raw, "gb18030");
      fileOk = gbk.includes("中文内容") && gbk.includes("行 4000");
      rawOk = !raw.toString("utf8").includes("中文内容"); // raw cp936 bytes, not transcoded UTF-8
      markerOk = r.output.includes("[output truncated]");
    }
    check("large-spill", ok && fileOk && rawOk && markerOk, { meta: r.metadata, preview: r.output.slice(0, 120) });
  }

  // 10) explicit UTF-8 child output still detected as utf8
  {
    const r = await shellTool({ command: '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "中文UTF8"' }, D);
    check("forced-utf8", r.output.includes("中文UTF8") && r.metadata.encoding === "utf8", { out: r.output, meta: r.metadata });
  }

  // 11) abort
  {
    const ctrl = new AbortController();
    const p = shellTool({ command: "Start-Sleep -Seconds 5; 'done'", timeout: 0 }, D, ctrl.signal);
    setTimeout(() => ctrl.abort(), 400);
    const r = await p;
    check("abort", r.metadata.aborted === true && /(^|\n)Cancelled\s*$/.test(r.output), { out: r.output, meta: r.metadata });
  }

  // 11b) background -> native-parity text + streaming file
  {
    const r = await shellTool({ command: '"bg"' , background: true }, D);
    const outOk =
      /Command moved to the background \(shell ID: /.test(r.output) &&
      /Output is streaming to: /.test(r.output) &&
      r.output.includes("You will be notified automatically when the command finishes.");
    const fileOk = !!r.metadata.outputPath && fs.existsSync(r.metadata.outputPath);
    check("background", !!(outOk && fileOk && r.metadata.shellID), { out: r.output.slice(0, 140), meta: r.metadata });
  }

  // 12) decode unit cases
  {
    const gbk = require("iconv-lite").encode("中文测试", "gb18030");
    const d = decodeShellOutput(gbk);
    check("decode-gbk-unit", d.text === "中文测试", d);
    const u8 = Buffer.from("中文测试", "utf8");
    const d2 = decodeShellOutput(u8);
    check("decode-utf8-unit", d2.text === "中文测试" && d2.encoding === "utf8", d2);
  }

  // 14) mixed encodings in one command (no injection): GBK PS line + UTF-8 python line
  {
    const r = await shellTool({ command: `"PS中文abc"; python -c "print('PY中文xyz')"` }, D);
    check("mixed-per-line", r.output.includes("PS中文abc") && r.output.includes("PY中文xyz"), { out: r.output, meta: r.metadata });
  }

  // 14b) GBK-dominant mixed stream: a UTF-8 line must survive even when chardet
  // would otherwise pick GB18030 for the whole buffer (it equals the console CP).
  {
    const r = await shellTool({ command: `"PS中文一"; "PS中文二"; "PS中文三"; python -c "print('PY中文xyz')"` }, D);
    check("mixed-gbk-dominant", r.output.includes("PS中文一") && r.output.includes("PS中文三") && r.output.includes("PY中文xyz"), { out: r.output, meta: r.metadata });
  }

  // 15) workdir ~ expansion (B1)
  {
    const os = require("os");
    const home = os.homedir();
    const r = await shellTool({ command: "(Get-Location).Path", workdir: "~" }, D);
    check("workdir-tilde", r.output.trim().toLowerCase() === home.toLowerCase(), { out: r.output, want: home });
    const docs = path.join(home, "Documents");
    const r2 = await shellTool({ command: "(Get-Location).Path", workdir: "~\\Documents" }, D);
    check("workdir-tilde-sub", r2.output.trim().toLowerCase() === docs.toLowerCase(), { out: r2.output, want: docs });
  }

  // 16) invalid workdir -> clear error (B3)
  {
    let msg1 = "";
    try { await shellTool({ command: '"x"', workdir: path.join(D, "nope-does-not-exist") }, D); } catch (e) { msg1 = e.message; }
    check("workdir-missing-msg", /Working directory does not exist/.test(msg1), msg1);
    const f = path.join(D, "afile.txt");
    fs.writeFileSync(f, "x");
    let msg2 = "";
    try { await shellTool({ command: '"x"', workdir: f }, D); } catch (e) { msg2 = e.message; }
    check("workdir-file-msg", /Working directory is not a directory/.test(msg2), msg2);
  }

  // 17) tail truncation: preview keeps the end, spill keeps everything (B2)
  {
    const r = await shellTool({ command: '1..5000 | ForEach-Object { "L$_ mark" }' }, D);
    const m = r.output.match(/\[showing lines (\d+)-(\d+) of (\d+); full output saved to (.+?)\]/);
    const total = m ? Number(m[3]) : -1;
    const endLine = m ? Number(m[2]) : -1;
    const hasLast = /(^|\n)L5000 mark\r?\n?/.test(r.output);
    const hasFirst = /(^|\n)L1 mark\r?\n?/.test(r.output);
    let fileHasAll = false;
    if (r.metadata.fullOutputPath && fs.existsSync(r.metadata.fullOutputPath)) {
      const txt = fs.readFileSync(r.metadata.fullOutputPath, "utf8");
      fileHasAll = txt.includes("L1 mark") && txt.includes("L5000 mark");
    }
    check(
      "tail-truncation",
      r.metadata.truncated === true && total === 5000 && endLine === 5000 && hasLast && !hasFirst && fileHasAll,
      { m: m ? m.slice(1) : null, hasLast, hasFirst, fileHasAll, meta: r.metadata },
    );
  }

  // 18) empty command -> "(no output)", no throw (B4)
  {
    let ok = false, out = "";
    try {
      const r = await shellTool({ command: "" }, D);
      out = r.output;
      ok = r.output.trim() === "(no output)";
    } catch (e) { out = "THREW " + e.message; }
    check("empty-command", ok, out);
  }

  // 19) negative timeout rejected in code (schema no longer declares `minimum`)
  {
    let msg = "";
    try { await shellTool({ command: '"x"', timeout: -5 }, D); } catch (e) { msg = e.message; }
    check("timeout-negative-rejected", /greater than or equal to 0/.test(msg), msg);
  }

  // 20) background completion notification: <shell ...> structure + decoded output
  {
    let captured = null;
    const r = await shellTool({ command: '"notif 中文"', background: true }, D, undefined, {
      sessionID: "s_test",
      notify: (e) => { captured = e; },
    });
    for (let i = 0; i < 50 && !captured; i++) await new Promise((res) => setTimeout(res, 100));
    const t = captured && captured.text;
    const okStruct = !!t && /^<shell id="sh_/.test(t) && /state="completed"/.test(t) && /command="/.test(t) && t.endsWith("</shell>") && t.includes("notif 中文");
    const okMeta = !!captured && captured.metadata && captured.metadata.source === "shell" && captured.metadata.state === "completed";
    check("background-notification", okStruct && okMeta, { text: t, meta: captured && captured.metadata, out: r.output.slice(0, 50) });
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("CRASH", e); process.exit(2); });
