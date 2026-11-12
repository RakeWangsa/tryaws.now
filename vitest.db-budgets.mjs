// Time budgets of the projects whose tests use the shared local PostgreSQL (WPU-H1).
//
// Why: every test file makes a database of its own (CREATE DATABASE, which waits for a checkpoint, then
// the migrations), and some files make one per case (ledger/check, ledger-audit, roles). `pnpm test`
// runs the projects in parallel, so a case that needs about 1 s alone needs more than the 5 s default
// of a test (10 s of a hook) when the server is busy: a run with four test runs at once timed out
// `ledger/check > keeps the exact count and cuts the list at maxFindings` at 5000 ms. The test was right;
// the budget was smaller than the set-up. A hung test still fails, only later.
export const dbBudgets = { testTimeout: 30_000, hookTimeout: 60_000 };
