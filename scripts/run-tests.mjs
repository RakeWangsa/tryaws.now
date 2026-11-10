import { spawn } from "node:child_process";
import { vitestArgs } from "./lib/test-args.mjs";

const child = spawn("vitest", vitestArgs(process.argv.slice(2)), {
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
