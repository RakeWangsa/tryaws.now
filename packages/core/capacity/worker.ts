// WPU-B3: the release of capacity is worker code (the failure step of a create and the destroy step run
// it as worker_rw). It lives behind its own subpath, `@tc/core/capacity-worker`, and not in the barrel
// of `@tc/core` that the web and admin apps import, so the apps cannot reach it by accident (R1).
export * from "./release";
