const os = require("os");
const path = require("path");
const { shellTool } = require("../dist/shell.js");

const names = ["X1_ALPHA", "X2_BRAVO", "X3_CHARLIE"];
const dirs = names.map((n) => path.join(os.homedir(), n));

(async () => {
  // Fire all rejects concurrently; each must report its OWN path.
  const results = await Promise.all(
    dirs.map((d) =>
      shellTool({ command: '"x"', workdir: d }, process.cwd())
        .then((r) => "OK " + r.output)
        .catch((e) => "ERR " + e.message),
    ),
  );
  results.forEach((r, i) => console.log("call" + (i + 1), "->", r));
  const ok = results.every((r, i) => r.includes(names[i]));
  console.log(ok ? "CONCURRENT-RAW: PASS (no cross-talk)" : "CONCURRENT-RAW: FAIL (cross-talk!)");
  process.exit(ok ? 0 : 1);
})();
