// SST reads this file at the repository root. SST 4 refuses every static import in a file named
// sst.config.ts (pkg/js/js.go, esbuild plugin "DisallowImports": any command, even `sst secret set`,
// fails with "Your sst.config.ts has top level imports"). So this file holds no import or re-export:
// both functions load the app from infra/app.ts with a dynamic import, which SST allows (VERIFY result
// of 2026-11-13, source of sst v4.17.2; tests/repo/sst-config.test.mjs pins it). `app` may be async
// (platform/src/config.ts: `app(input: AppInput): App | Promise<App>`).
//
// The environment is read here only and handed to infra/app.ts.
export default $config({
  async app(input) {
    const { appConfig } = await import("./infra/app");
    return appConfig(input?.stage ?? "", process.env);
  },
  async run() {
    const { runApp } = await import("./infra/app");
    return runApp(process.env);
  },
});
