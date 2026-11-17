# The Antler theme: bring your own

The look of the panel and of the public pages is the **Antler** theme, version 4.5.0, a commercial
theme sold on Envato Market. It is a paid third-party product. It is **not part of this repository**
and no right to it comes with the code. Everything else is: the code, the tests, `tc.css` (our own
tokens and rules), the self-hosted fonts and the brand files in `design/brand/`.

Two folders hold the theme. A public checkout does not have them:

| Folder                      | What it is                                                                     |
| --------------------------- | ------------------------------------------------------------------------------ |
| `design/mockup/`            | The licensed original: the HTML pages, the WHMCS templates, `template/assets/` |
| `packages/ui/theme/assets/` | The 55 files that `pnpm theme:sync` copies from it (the allow-list of 16.3)    |

Both are listed in `.gitignore`. Do not commit them and do not use `git add -f` on them.

## What works without the theme

A checkout without the two folders installs, lints, typechecks and tests, and `next build` works.

| Command                                       | Without the theme                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm install`, `pnpm lint`, `pnpm typecheck` | Unchanged                                                                                              |
| `pnpm format:check`                           | Unchanged                                                                                              |
| `pnpm test`, `pnpm verify --quick`            | Run in full. The tests that read the theme skip, and each skip says why (see below)                    |
| `pnpm theme:sync --stage import`              | Prints one notice, writes nothing, exits 0                                                             |
| `pnpm theme:sync --stage publish`             | The theme-less mode: writes `tc.css` and the self-hosted fonts to `apps/*/public/theme/`, exits 0      |
| `pnpm --filter @tc/web build` (and `admin`)   | Runs the publish stage first, so the build works. The pages carry no theme styling and look unfinished |

The theme-less mode is chosen only when the whole folder `packages/ui/theme/assets/` is absent. A
folder that is there is read in full and refused when it is damaged, so a licensed checkout does not
fall back by accident (R16).

### What the tests skip

A test that needs the theme skips itself with `it.skipIf` or `describe.skipIf`, behind the helper
`packages/ui/theme/present.ts` (`@tc/ui/theme-present`). It asks one question: do `design/mockup/template`
and `packages/ui/theme/assets` exist? The skipped tests are the ones that compare something with the
theme: the cross-checks of the screens against the mockup pages (`*-anchors` tests), the check that every
CSS class a component uses is defined by the theme, the manifest, import and publish checks against the
real files, and the checks of `tc.css` against the theme's values.

One check is not a skip but a pass that is not evaluated: `unknownClasses()` in
`packages/ui/test/render.tsx` returns an empty list without the theme, so that the other assertions of
the same component test still run. It writes one line to stderr per test file when that happens
(`unknownClasses: not evaluated, ...`). The full check runs wherever the theme is present.

To see every skip and its name, run `pnpm test --reporter verbose`.

## Use your own licensed copy

1. Buy your own licence for Antler 4.5.0 on Envato Market and read its terms. This repository does not
   grant any right to the theme, and the licence you buy decides what you may do with it.
2. Unpack the package so that `design/mockup/` holds what the package holds: `template/` (with
   `template/assets/` and the HTML pages), `whmcs-template/` and `order-form/`. The tests are written
   against 4.5.0 byte for byte; another version fails the import checks on purpose.
3. Run `pnpm install`, then `pnpm theme:sync`. It imports the allow-list of 16.3 to
   `packages/ui/theme/assets/`, rewrites `packages/ui/theme/script-hashes.txt` and publishes
   `apps/web/public/theme/` and `apps/admin/public/theme/`. `pnpm theme:sync --check` writes nothing and
   exits 1 when a copy differs.
4. Run `pnpm test`. The tests that were skipped now run.
5. Keep the theme out of your commits. Never commit it, and never publish a build with `assets/js`,
   jQuery or any script of the theme (U2). `pnpm theme:scan <folder>` scans a build output for them.

## Not in a public checkout

Besides the theme, the owner's working notes are left out of a public checkout: `JOURNEY.md`,
`.remember/`, `.superpowers/`, `docs/screens/`, `docs/analysis/`, `docs/audit/`, `docs/legal-drafts/`,
`docs/superpowers/` and `docs/section-15-evidence.md`. The tests that read them skip or tolerate their
absence. `docs/spec/`, `docs/runbooks/`, `.claude/` and `design/brand/` stay.

`packages/ui/theme/script-hashes.txt` stays. It lists the path, size and SHA-256 of the theme's scripts so
that the build-output scan can prove that none of them reached a build, without the theme itself.
