import js from "@eslint/js";
import tseslint from "typescript-eslint";

const awsSdkClients = [
  "@aws-sdk/client-lightsail",
  "@aws-sdk/client-route-53",
  "@aws-sdk/client-route-53-domains",
  "@aws-sdk/client-sts",
  "@aws-sdk/client-cost-explorer",
];

// Each group matches the bare package and every sub-path of it.
const withSubpaths = (names) => names.flatMap((n) => [n, `${n}/*`]);

// Flat config does not merge a rule across matching blocks (the last block wins), so each
// file scope below gets exactly one block that carries every restriction that applies to it.
const R1 = {
  message: "R1: the web tier never provisions. Only functions/ may import @tc/aws.",
  group: ["@tc/aws", "@tc/aws/*", "**/packages/aws", "**/packages/aws/**"],
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
    // apps/** and packages/** (except aws and core): R1 and the SDK rule.
    files: ["apps/**", "packages/**"],
    ignores: ["packages/aws/**", "packages/core/**"],
    rules: restrict(R1, SDK),
  },
  {
    // packages/core: pure logic. Its list already covers the SDK clients and @tc/aws.
    files: ["packages/core/**"],
    rules: restrict(PURE_CORE, { ...R1, group: ["**/packages/aws", "**/packages/aws/**"] }),
  },
  {
    // functions/** and everything else outside apps/ and packages/: the SDK rule only.
    files: ["**/*"],
    ignores: ["apps/**", "packages/**"],
    rules: restrict(SDK),
  },
);
