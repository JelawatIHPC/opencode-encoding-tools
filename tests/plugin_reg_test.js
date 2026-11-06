// Windows-only: the commands below are PowerShell syntax and rely on the
// console code page being a GBK-family code page.
if (process.platform !== "win32") {
  console.log("skipped: Windows-only shell registration test");
  process.exit(0);
}

const path = require("path");
const os = require("os");
const fs = require("fs");
const plugin = require("../dist/index.js").default;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("PASS " + label); }
  else { fail++; console.log("FAIL " + label + (detail !== undefined ? "  -> " + JSON.stringify(detail) : "")); }
}

(async () => {
  const tools = {};
  const fakeCtx = {
    location: { directory: process.cwd() },
    tool: {
      transform: async (cb) => {
        const stub = { name: "x", description: "x", input: {}, options: { codemode: false }, id: "x" };
        const editor = {
          // native tools are exposed with an opaque function-stub input
          get: (id) => (id === "shell" ? { name: "shell", description: "shell", input: function () {}, options: { codemode: false } } : stub),
          add: (t) => { tools[t.name] = t; },
          remove: (id) => { delete tools[id]; },
        };
        cb(editor);
        return { dispose: async () => {} };
      },
    },
  };
  await plugin.setup(fakeCtx);

  check("shell-registered", !!tools["shell"], Object.keys(tools));
  const schema = tools["shell"] && tools["shell"].input;
  check(
    "schema-timeout-no-minimum",
    !!(schema && schema.properties && schema.properties.timeout && schema.properties.timeout.minimum === undefined),
    schema && schema.properties && schema.properties.timeout,
  );
  check(
    "schema-required-command-only",
    !!(schema && Array.isArray(schema.required) && schema.required.length === 1 && schema.required[0] === "command"),
    schema && schema.required,
  );

  const context = { directory: process.cwd() };
  const dir = path.join(os.tmpdir(), "enctools-tests", "shellreg");
  fs.mkdirSync(dir, { recursive: true });

  const r = await tools["shell"].execute({ command: '"注册中文测试"' }, context);
  check("exec-chinese", !!(r.content && r.content.includes("注册中文测试")), r);

  const r2 = await tools["shell"].execute({ command: "" }, context);
  check("exec-empty-no-output", r2.content.trim() === "(no output)", r2.content);

  const r3 = await tools["shell"].execute({ command: '1..5000 | ForEach-Object { "L$_ m" }' }, context);
  check(
    "exec-tail-kept",
    /\[showing lines \d+-5000 of 5000;/.test(r3.content) && /L5000 m/.test(r3.content),
    r3.content.slice(-160),
  );

  const r4 = await tools["shell"].execute({ command: "(Get-Location).Path", workdir: "~" }, context);
  check("exec-workdir-tilde", r4.content.trim().toLowerCase() === os.homedir().toLowerCase(), { out: r4.content, want: os.homedir() });

  let msg = "";
  try {
    await tools["shell"].execute({ command: '"x"', workdir: path.join(dir, "missing-xyz") }, context);
  } catch (e) { msg = e.message; }
  check("exec-workdir-bad", /Working directory does not exist/.test(msg), msg);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
