// Maps `pnpm test` arguments to vitest arguments: always a single run, and
// `--filter <package>` selects the vitest project of that name.
export function vitestArgs(argv) {
  const args = ["run"];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--filter") {
      args.push("--project", argv[++i]);
    } else if (arg.startsWith("--filter=")) {
      args.push("--project", arg.slice("--filter=".length));
    } else {
      args.push(arg);
    }
  }
  return args;
}
