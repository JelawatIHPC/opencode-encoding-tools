import * as fs from "fs";
import { readTool } from "./read";
import { writeTool } from "./write";
import { grepTool } from "./grep";
import { patchTool } from "./patch";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

const [, , cmd, ...rest] = process.argv;
const cwd = process.cwd();

async function main() {
  switch (cmd) {
    case "read": {
      const filePath = arg(rest, "--path")!;
      const offset = arg(rest, "--offset") ? Number(arg(rest, "--offset")) : undefined;
      const limit = arg(rest, "--limit") ? Number(arg(rest, "--limit")) : undefined;
      const r = readTool({ filePath, offset, limit, charset: arg(rest, "--charset") }, cwd);
      console.log(r.output);
      break;
    }
    case "write": {
      const filePath = arg(rest, "--path")!;
      const content = arg(rest, "--content") ?? fs.readFileSync(arg(rest, "--content-file")!, "utf-8");
      const r = writeTool({ filePath, content, charset: arg(rest, "--charset") }, cwd);
      console.log(r.output);
      break;
    }
    case "grep": {
      const r = await grepTool({
        pattern: arg(rest, "--pattern")!,
        path: arg(rest, "--path"),
        include: arg(rest, "--include"),
        literal: flag(rest, "--literal"),
        caseSensitive: flag(rest, "--caseSensitive"),
        limit: arg(rest, "--limit") ? Number(arg(rest, "--limit")) : undefined,
      }, cwd);
      console.log(r.output);
      break;
    }
    case "patch": {
      const patchText = arg(rest, "--text") ?? fs.readFileSync(arg(rest, "--file")!, "utf-8");
      const r = patchTool({ patchText, charset: arg(rest, "--charset") }, cwd);
      console.log(r.output);
      break;
    }
    default:
      console.error("Usage: node dist/cli.js <read|write|grep|patch> ...");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(2);
});
