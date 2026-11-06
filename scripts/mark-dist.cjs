// tsc emits CommonJS (see tsconfig.json) for the local test build, while the
// package itself is ESM ("type": "module"). Mark dist/ so Node loads the test
// build as CommonJS.
const fs = require("fs");
const path = require("path");

const dist = path.join(__dirname, "..", "dist");
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, "package.json"), JSON.stringify({ type: "commonjs" }) + "\n");
