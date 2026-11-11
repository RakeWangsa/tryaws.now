import js from "@eslint/js";
import tseslint from "typescript-eslint";

const awsSdkClients = [
  "@aws-sdk/client-lightsail",
  "@aws-sdk/client-route-53",
  "@aws-sdk/client-route-53-domains",
  "@aws-sdk/client-sts",
  "@aws-sdk/client-cost-explorer",
  "@aws-sdk/credential-providers",
];

// Each group matches the bare package and every sub-path of it.
const withSubpaths = (names) => names.flatMap((n) => [n, `${n}/*`]);

// Flat config does not merge a rule across matching blocks (the last block wins), so each
// file scope below gets exactly one block that carries every restriction that applies to it.
// The path forms: packages/aws from anywhere, a sibling `aws` package reached with `../`
// (from inside packages/), and every function package, which may import @tc/aws itself.
const R1_PATH_FORMS = [
  "**/packages/aws",
  "**/packages/aws/**",
  "../**/aws",
  "../**/aws/**",
  "**/functions/**",
];
const R1 = {
  message: "R1: the web tier never provisions. Only functions/ may import @tc/aws.",
  group: ["@tc/aws", "@tc/aws/*", "@tc/fn-*", "@tc/fn-*/*", ...R1_PATH_FORMS],
};
const SDK = {
  message: "Spec section 4: these AWS SDK clients are used only inside packages/aws.",
  group: withSubpaths(awsSdkClients),
};
const PURE_CORE = {
  message: "packages/core is pure logic: no AWS and no HTTP (spec section 5).",
  group: [
    "@aws-sdk/*",
    "@tc/aws",
    "@tc/aws/*",
    "next",
    "next/*",
    "http",
    "https",
    "node:http",
    "node:https",
    "undici",
    "axios",
    "node-fetch",
  ],
};

const DECIMAL = {
  message:
    "R4: decimal math lives only in packages/core/pricing. Everywhere else money is bigint paisa.",
  group: ["big.js", "decimal.js", "decimal.js-light", "bignumber.js"],
};
// packages/core already bans the SDK clients and @tc/aws through PURE_CORE, so R1 adds the
// function packages and the path forms.
const R1_PATHS = { ...R1, group: ["@tc/fn-*", "@tc/fn-*/*", ...R1_PATH_FORMS] };

// R1 for dynamic imports: no-restricted-imports does not check import() (ESLint 10.14.0).
const R1_DYNAMIC_SOURCE =
  "/^@tc\\/aws(\\/|$)|^@tc\\/fn-|(^|\\/)packages\\/aws(\\/|$)|(^|\\/)functions\\/|^\\.\\.\\/(.*\\/)?aws(\\/|$)/";
const R1_DYNAMIC = {
  selector: `ImportExpression[source.value=${R1_DYNAMIC_SOURCE}]`,
  message: R1.message,
};

const restrict = (...patterns) => ({
  "no-restricted-imports": ["error", { patterns }],
});

export default tseslint.config(
  {
    ignores: [
      "design/**",
      "docs/**",
      ".claude/**",
      "**/dist/**",
      "**/node_modules/**",
      "coverage/**",
      "**/.next/**",
      "**/.open-next/**",
      "**/.sst/**",
      ".superpowers/**",
      ".remember/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Repo scripts and tests run on Node.
    files: ["**/*.mjs"],
    languageOptions: { globals: { process: "readonly" } },
  },
  {
    // apps/** and packages/** (except aws and core): R1, the SDK rule and R4.
    files: ["apps/**", "packages/**"],
    ignores: ["packages/aws/**", "packages/core/**"],
    rules: restrict(R1, SDK, DECIMAL),
  },
  {
    // packages/aws: R4 only (it is the one place that may import the SDK clients).
    files: ["packages/aws/**"],
    rules: restrict(DECIMAL),
  },
  {
    // packages/core except pricing: pure logic and R4.
    files: ["packages/core/**"],
    ignores: ["packages/core/pricing/**"],
    rules: restrict(PURE_CORE, R1_PATHS, DECIMAL),
  },
  {
    // packages/core/pricing: pure logic, and the only scope that may import a decimal library.
    files: ["packages/core/pricing/**"],
    rules: restrict(PURE_CORE, R1_PATHS),
  },
  {
    // Dynamic imports, block A: every file of apps/ and packages/ except tests. The source must
    // be a string literal, so the boundary can be checked. Flat config keeps only the last
    // matching block's no-restricted-syntax, so blocks A and B match disjoint files.
    files: ["apps/**", "packages/**"],
    ignores: ["packages/aws/**", "**/*.test.ts", "**/*.test.tsx", "**/*.test.mjs"],
    rules: {
      "no-restricted-syntax": [
        "error",
        R1_DYNAMIC,
        {
          selector: 'ImportExpression:not([source.type="Literal"])',
          message:
            "R1: dynamic imports in apps/ and packages/ take a string literal, so the boundary can be checked.",
        },
      ],
    },
  },
  {
    // Dynamic imports, block B: test files (not bundled) get only the R1 path selector.
    files: ["apps/**/*.test.*", "packages/**/*.test.*"],
    ignores: ["packages/aws/**"],
    rules: { "no-restricted-syntax": ["error", R1_DYNAMIC] },
  },
  {
    // functions/** and everything else outside apps/ and packages/: the SDK rule and R4.
    files: ["**/*"],
    ignores: ["apps/**", "packages/**"],
    rules: restrict(SDK, DECIMAL),
  },
);
