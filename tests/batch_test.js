const path = require("path");
const os = require("os");
const fs = require("fs");
const plugin = require("../dist/index.js").default;

let pass = 0, fail = 0;
const check = (l, c, d) => {
  if (c) { pass++; console.log("PASS " + l); }
  else { fail++; console.log("FAIL " + l + (d !== undefined ? "  -> " + JSON.stringify(d) : "")); }
};

(async () => {
  const tools = {};
  const stub = (id) => ({ name: id, description: id, input: {}, options: {}, id });
  const fakeCtx = {
    location: { directory: process.cwd() },
    tool: {
      transform: async (cb) => {
        const editor = { get: stub, add: (t) => { tools[t.name] = t; }, remove: (id) => { delete tools[id]; } };
        cb(editor);
        return { dispose: async () => {} };
      },
    },
  };
  await plugin.setup(fakeCtx);
  console.log("tools:", Object.keys(tools).join(","));

  const dir = path.join(os.tmpdir(), "enctools-tests", "batchtest");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "x.txt");
  fs.writeFileSync(file, "hello\n");

  const run = (p) => p.then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, msg: e.message }));
  const ctx = (mid, i) => ({ directory: dir, messageID: mid, id: `call_0${i}_zzz` });

  // batch 1: 1 ok + 2 err (read ok, read missing, grep bad regex)
  {
    const [a, b, c] = await Promise.all([
      run(tools["read"].execute({ path: file }, ctx("m_b1", 0))),
      run(tools["read"].execute({ path: path.join(dir, "missing.txt") }, ctx("m_b1", 1))),
      run(tools["grep"].execute({ pattern: "[", path: dir }, ctx("m_b1", 2))),
    ]);
    check("b1-call0-ok-content", a.ok && typeof a.r.content === "string", a);
    check("b1-call1-err", !b.ok, b);
    check("b1-call2-err", !c.ok, c);
    const d1 = b.ok ? null : b.msg;
    const d2 = c.ok ? null : c.msg;
    check("b1-two-errors-identical", !!d1 && d1 === d2, { d1, d2 });
    check("b1-digest-order", !!d1 && /\[1\]\s+\S+\s+ok\b/.test(d1) && /\[2\]\s+\S+\s+ERR\b/.test(d1) && /\[3\]\s+\S+\s+ERR\b/.test(d1), d1);
    check("b1-digest-has-no-ids", !!d1 && !/msg_[0-9a-f]/i.test(d1) && !/call_\d+_/.test(d1) && !/Batch digest \(/.test(d1), d1);
    check("b1-digest-details", !!d1 && d1.includes("missing.txt") && d1.includes("Invalid regular expression"), d1);
  }

  // batch 2: single call -> raw error, no digest
  {
    const s = await run(tools["read"].execute({ path: path.join(dir, "nope.txt") }, ctx("m_b2", 0)));
    check("b2-single-raw-error", !s.ok && /File not found/.test(s.msg) && !/Batch digest/.test(s.msg), s);
  }

  // batch 3: patch failure + read ok (tests patch routing + patch digest)
  {
    const [p, r] = await Promise.all([
      run(tools["patch"].execute({ patchText: "definitely not a valid patch" }, ctx("m_b3", 0))),
      run(tools["read"].execute({ path: file }, ctx("m_b3", 1))),
    ]);
    check("b3-read-ok", r.ok, r);
    check("b3-patch-failed", !p.ok, p);
    check("b3-digest-order", !p.ok && /\[1\]\s+\S+\s+ERR\b/.test(p.msg) && /\[2\]\s+\S+\s+ok\b/.test(p.msg), p.ok ? p : p.msg);
  }

  check("patch-tools-registered", !!tools["patch"] && !!tools["apply_patch"], Object.keys(tools));

  // batch 4: a long success line is truncated in the digest (adaptive cap)
  {
    const big = path.join(dir, "big.txt");
    fs.writeFileSync(big, "x".repeat(3000) + "\n");
    const [o, e] = await Promise.all([
      run(tools["read"].execute({ path: big }, ctx("m_b4", 0))),
      run(tools["read"].execute({ path: path.join(dir, "nope2.txt") }, ctx("m_b4", 1))),
    ]);
    check("b4-long-ok-truncated", !e.ok && e.msg.includes("…"), e.ok ? e : e.msg);
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
