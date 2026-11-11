import js from "@eslint/js";
import tseslint from "typescript-eslint";

export const awsSdkClients = [
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
  message: "Spec section 4: these AWS SDK packages are used only inside packages/aws.",
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
  "/^@tc\\/aws(\\/|$)|^@tc\\/fn-|(^|\\/)packages\\/aws(\\/|$)|(^|\\/)functions\\/|^\\.\\.\\/(.*\\/)?aws(\\/|$)/i";
const R1_DYNAMIC = {
  selector: `ImportExpression[source.value=${R1_DYNAMIC_SOURCE}]`,
  message: R1.message,
};
const R1_DYNAMIC_TEMPLATE = {
  selector: `ImportExpression > TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked=${R1_DYNAMIC_SOURCE}]`,
  message: R1.message,
};
// Built from the list above, so the two cannot drift.
const SDK_DYNAMIC_SOURCE = `/^(${awsSdkClients.map((n) => n.replaceAll("/", "\\/")).join("|")})(\\/|$)/i`;
const SDK_DYNAMIC = {
  selector: `ImportExpression[source.value=${SDK_DYNAMIC_SOURCE}]`,
  message: SDK.message,
};
const SDK_DYNAMIC_TEMPLATE = {
  selector: `ImportExpression > TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked=${SDK_DYNAMIC_SOURCE}]`,
  message: SDK.message,
};
const NO_HIDDEN_LOADER = {
  selector:
    'CallExpression[callee.name="createRequire"], CallExpression[callee.property.name=/^(createRequire|getBuiltinModule)$/]',
  message:
    "R1: createRequire and getBuiltinModule load modules that the import rules cannot check.",
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
    // Dynamic imports, block A: every file of apps/ and packages/ except tests (and except
    // packages/aws). The source must be a string literal, so the boundary can be checked.
    // Flat config keeps only the last matching block's no-restricted-syntax, so blocks A and B
    // match disjoint files (B matches exactly what A ignores).
    files: ["apps/**", "packages/**"],
    ignores: ["packages/aws/**", "**/*.test.ts", "**/*.test.tsx", "**/*.test.mjs"],
    rules: {
      "no-restricted-syntax": [
        "error",
        R1_DYNAMIC,
        SDK_DYNAMIC,
        NO_HIDDEN_LOADER,
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
    files: ["apps/**/*.test.{ts,tsx,mjs}", "packages/**/*.test.{ts,tsx,mjs}"],
    ignores: ["packages/aws/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        R1_DYNAMIC,
        R1_DYNAMIC_TEMPLATE,
        SDK_DYNAMIC,
        SDK_DYNAMIC_TEMPLATE,
        NO_HIDDEN_LOADER,
      ],
    },
  },
  {
    // Code built from text cannot be checked by any import rule.
    // no-implied-eval sees a bare setTimeout("...") only once the config declares the globals of the runtime; until then it catches the globalThis. and window. forms.
    files: ["apps/**", "packages/**"],
    rules: { "no-eval": "error", "no-implied-eval": "error", "no-new-func": "error" },
  },
  {
    // functions/** and everything else outside apps/ and packages/: the SDK rule and R4.
    files: ["**/*"],
    ignores: ["apps/**", "packages/**"],
    rules: { ...restrict(SDK, DECIMAL), "no-restricted-syntax": ["error", SDK_DYNAMIC] },
  },
);
