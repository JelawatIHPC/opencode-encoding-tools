// The shell tool must refuse commands that rewrite files behind the tools' back.
// PowerShell's text cmdlets re-encode whatever they write (BOM added or dropped,
// or a fallback to UTF-16LE) and collapse CRLF to LF, which is what silently
// corrupted a CRLF source file in practice. Deletion is refused too: it is
// irreversible, so the recycle bin is the required route.
//
// `>` / `>>` redirection is intentionally NOT guarded: the project build
// convention relies on `> $null`, and redirection is constrained by the project
// instructions (AGENTS.md) instead of by the tool.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { shellTool } = require("../dist/shell.js");

let pass = 0;
let fail = 0;
// Every case is async (the tool spawns processes), so the runner MUST await.
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log("  ok   " + name);
  } catch (e) {
    fail++;
    console.log("  FAIL " + name + ": " + (e && e.message));
  }
}

const dir = path.join(os.tmpdir(), "enctools-shell-guard-" + Date.now());
fs.mkdirSync(dir, { recursive: true });

async function rejects(command, re) {
  let err;
  try {
    await shellTool({ command }, dir);
  } catch (e) {
    err = e;
  }
  assert.ok(err, "expected the command to be refused: " + command);
  assert.ok(re.test(err.message), "unexpected message for " + command + ": " + err.message);
  return err;
}

const BYPASS = /put the command in a script file for legitimate case\.$/;

(async () => {
  // ---- refused: text pipelines that rewrite files in place ----
  await t("Set-Content is refused", async () => {
    const e = await rejects("Get-Content a.txt | Set-Content a.txt", /^Set-Content: Set-Content is disabled/);
    assert.ok(/may change file encoding silently/.test(e.message), e.message);
    assert.ok(BYPASS.test(e.message), e.message);
    assert.ok(/write\/edit\/patch tools/.test(e.message), e.message);
  });
  await t("Out-File is refused", async () => {
    const e = await rejects("'x' | Out-File a.txt", /^Out-File: Out-File is disabled/);
    assert.ok(/may change file encoding silently/.test(e.message), e.message);
  });
  await t("Add-Content is refused and mentions mixed encoding", async () => {
    const e = await rejects("Add-Content -Path a.txt -Value 'x'", /^Add-Content: Add-Content is disabled/);
    assert.ok(/may create mixed encoding silently/.test(e.message), e.message);
  });
  await t("Clear-Content is refused and mentions irreversible deletion", async () => {
    const e = await rejects("Clear-Content a.txt", /^Clear-Content: Clear-Content is disabled/);
    assert.ok(/deletes content irreversibly/.test(e.message), e.message);
    assert.ok(/write tool with the intended content/.test(e.message), e.message);
  });

  // ---- refused: destruction ----
  await t("Remove-Item is refused and points at the recycle-bin API", async () => {
    const e = await rejects("Remove-Item a.txt", /^Remove-Item: Remove-Item is disabled/);
    assert.ok(/deletes file or directory irreversibly/.test(e.message), e.message);
    assert.ok(/Microsoft\.VisualBasic\.FileIO\.FileSystem\]::DeleteFile/.test(e.message), e.message);
    assert.ok(/Microsoft\.VisualBasic\.FileIO\.FileSystem\]::DeleteDirectory/.test(e.message), e.message);
    assert.ok(!/script file/.test(e.message), "the delete message must not suggest a script bypass");
  });
  await t("the message echoes the alias the model actually used", async () => {
    for (const [c, alias] of [
      ["ri a.txt", "ri"],
      ["del a.txt", "del"],
      ["rm a.txt", "rm"],
      ["erase a.txt", "erase"],
      ["rd some-dir", "rd"],
      ["rmdir some-dir", "rmdir"],
    ]) {
      const e = await rejects(c, new RegExp("^" + alias + ": " + alias + " is disabled"));
      assert.ok(/deletes file or directory irreversibly/.test(e.message), e.message);
    }
  });
  await t("an alias after a pipe or separator is also caught", async () => {
    for (const c of ["Get-ChildItem | rm", "'x'; del a.txt", "$(ri a.txt)", "if (Test-Path a.txt) { del a.txt }"]) {
      await rejects(c, /^(?:rm|del|ri): /);
    }
  });
  await t("the quoted call-operator form is caught", async () => {
    await rejects("& 'ri' a.txt", /^ri: /);
  });

  // ---- refused: other in-place byte edits ----
  await t("in-place sed is refused", async () => {
    const e = await rejects("sed -i 's/a/b/' a.txt", /^sed -i: In-place sed is disabled/);
    assert.ok(/sed's own byte handling/.test(e.message), e.message);
    assert.ok(/edit\/patch tools/.test(e.message), e.message);
  });
  await t("dd with of= is refused", async () => {
    await rejects("dd if=/dev/zero of=a.bin bs=1 count=1", /^dd: dd is disabled/);
  });
  await t("truncate is refused", async () => {
    await rejects("truncate -s 0 a.txt", /^truncate: truncate is disabled/);
  });
  await t(".NET file writes are refused", async () => {
    const e = await rejects("[System.IO.File]::WriteAllText('a.txt', 'x')", /^\[System\.IO\.File\]::WriteAllText: /);
    assert.ok(/may change file encoding silently/.test(e.message), e.message);
    await rejects("[System.IO.File]::AppendAllText('a.txt', 'x')", /^\[System\.IO\.File\]::AppendAllText: /);
    await rejects("[System.IO.Directory]::Delete('sub')", /^\[System\.IO\.Directory\]::Delete: /);
  });

  // ---- `>` is NOT guarded any more ----
  await t("redirection to a file is allowed (AGENTS.md governs it)", async () => {
    const r = await shellTool({ command: "echo hi > out.txt; Get-Content out.txt" }, dir);
    assert.strictEqual(r.metadata.exitCode, 0, r.output);
    assert.ok(/hi/.test(r.output), r.output);
  });
  await t("append redirection is allowed too", async () => {
    const r = await shellTool({ command: "echo more >> out.txt; Get-Content out.txt" }, dir);
    assert.ok(/more/.test(r.output), r.output);
  });
  await t('"> $null" and "2>&1" still work', async () => {
    const a = await shellTool({ command: "'noise' > $null; 'done'" }, dir);
    assert.ok(/done/.test(a.output), a.output);
    const b = await shellTool({ command: "& cmd /c 'echo hi' 2>&1" }, dir);
    assert.ok(/hi/.test(b.output), b.output);
  });

  // ---- allowed: read-only work ----
  await t("read-only cmdlets still run", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n", "utf8");
    const r = await shellTool({ command: "Get-Content a.txt" }, dir);
    assert.ok(/hello/.test(r.output), r.output);
    const g = await shellTool({ command: "Select-String -Path a.txt -Pattern hello" }, dir);
    assert.ok(/hello/.test(g.output), g.output);
  });

  // ---- the guard matches command positions, not raw substrings ----
  await t("a pattern that merely mentions Set-Content is allowed", async () => {
    fs.writeFileSync(path.join(dir, "b.txt"), "x Set-Content y\n", "utf8");
    const r = await shellTool({ command: `Select-String -Path b.txt -Pattern "Set-Content"` }, dir);
    assert.ok(/Set-Content/.test(r.output), r.output);
  });
  await t("a filename containing the word is allowed", async () => {
    fs.writeFileSync(path.join(dir, "mySet-Content.py"), "print(1)\n", "utf8");
    const r = await shellTool({ command: "Get-ChildItem mySet-Content.py" }, dir);
    assert.ok(/mySet-Content\.py/.test(r.output), r.output);
  });
  await t("a longer name that merely starts alike is allowed", async () => {
    const r = await shellTool({ command: '"Set-ContentExtra is not a cmdlet"' }, dir);
    assert.ok(/Set-ContentExtra/.test(r.output), r.output);
  });
  await t("a string literal naming the cmdlet is allowed", async () => {
    const r = await shellTool({ command: `"Out-File is the old way"` }, dir);
    assert.ok(/Out-File/.test(r.output), r.output);
  });
  await t("short aliases do not fire inside ordinary words", async () => {
    for (const c of ["echo 'this is a form field'", "echo 'model '", "echo 'safari '", "echo 'tri '"]) {
      const r = await shellTool({ command: c }, dir);
      assert.strictEqual(r.metadata.exitCode, 0, c + " -> " + r.output);
    }
  });
  await t("a variable assignment named after a cmdlet is allowed", async () => {
    // `$Set-Content` is not a valid PowerShell variable name (the hyphen is an
    // operator), so only genuinely valid names are checked here.
    for (const c of ["$rm = 1; 'ok'", "$del = 2; 'ok'", "$ri = 3; 'ok'", "$OutFile = 4; 'ok'"]) {
      const r = await shellTool({ command: c }, dir);
      assert.strictEqual(r.metadata.exitCode, 0, c + " -> " + r.output);
    }
  });

  // ---- the refusal happens before anything runs ----
  await t("a refused command leaves the target untouched", async () => {
    const file = path.join(dir, "keep.txt");
    fs.writeFileSync(file, "original\r\n", "utf8");
    const before = fs.readFileSync(file);
    await rejects(`Remove-Item ${file}`, /^Remove-Item: /);
    await rejects(`'x' | Set-Content ${file}`, /^Set-Content: /);
    assert.ok(fs.readFileSync(file).equals(before), "the file must be untouched");
  });
  await t("a refused delete really does not delete", async () => {
    const file = path.join(dir, "survivor.txt");
    fs.writeFileSync(file, "still here\n", "utf8");
    for (const c of [`Remove-Item ${file}`, `ri ${file}`, `del ${file}`, `rm ${file}`]) {
      await rejects(c, /^(?:Remove-Item|ri|del|rm): /);
      assert.ok(fs.existsSync(file), "the file must still exist after: " + c);
    }
  });

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
