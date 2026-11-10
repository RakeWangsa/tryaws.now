// Builds the verify baseline: facts copied out of TICON_CLOUD_MEGA_PLAN.md (spec E.1 step 4, G).
// buildBaseline is a pure function of the markdown text. It throws when the plan no longer has
// the shape a rule expects, and never returns a partial baseline.
import { blockAfter, linesOf, sectionRange, tablesIn } from "./md.mjs";

export const PLAN_FILE = "TICON_CLOUD_MEGA_PLAN.md";

export const KIT_FILES = [
  "CLAUDE.md",
  "JOURNEY.md",
  ".worktreeinclude",
  ".github/pull_request_template.md",
  ".github/CODEOWNERS",
  ".claude/settings.json",
  ".claude/hooks/protect-files.sh",
  ".claude/hooks/stop-check.sh",
  ".claude/rules/money.md",
  ".claude/rules/aws.md",
  ".claude/rules/data.md",
  ".claude/rules/ui.md",
  ".claude/rules/admin.md",
  ".claude/rules/lifecycle.md",
  ".claude/rules/server.md",
  ".claude/skills/wp-start/SKILL.md",
  ".claude/skills/wp-verify/SKILL.md",
  ".claude/skills/handoff/SKILL.md",
  ".claude/agents/security-reviewer.md",
  ".claude/agents/money-reviewer.md",
  ".claude/agents/spec-checker.md",
];

// The two vectors the plan states in a sentence. buildBaseline checks the sentence is still there.
const EXTRA = [
  {
    fx: "124.77",
    aws_usd: "5",
    base: 62385,
    korea_vat: 6239,
    bd_vat: 3119,
    processing_fee: 1248,
    total: 72991,
  },
  { fx: "127", aws_usd: "5", bd_vat_base: "subtotal", bd_vat: 3556, total: 74676 },
];
const EXTRA_SENTENCES = [
  "FX 124.77 and aws_usd 5 gives base 62385, steps 6239, 3119, 1248, total 72991.",
  "aws_usd 5 gives bd_vat 3556 and total 74676",
];

const ROUTE_SECTIONS = ["16.8", "16.9", "16.10", "16.12"];

function fail(what) {
  throw new Error(`baseline: ${what}`);
}

function section(markdown, prefix) {
  try {
    return sectionRange(markdown, prefix);
  } catch {
    return fail(`the plan has no heading that starts with "${prefix}"`);
  }
}

/** The first table of a section whose first header cell is `firstHeader`. */
function tableOf(markdown, prefix, firstHeader) {
  const { start, end } = section(markdown, prefix);
  const table = tablesIn(markdown, start, end).find((t) => t.header[0] === firstHeader);
  if (table === undefined)
    fail(`section "${prefix}" has no table whose first header cell is "${firstHeader}"`);
  return table;
}

const ticks = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

function whole(text, what) {
  if (!/^\d+$/.test(text)) fail(`${what} is not a whole number: "${text}"`);
  return Number(text);
}

function version(markdown) {
  const m = /^Version (\S+?),/.exec(linesOf(markdown)[2] ?? "");
  if (m === null) fail('line 3 of the plan does not start with "Version <number>,"');
  return m[1];
}

function pricing(markdown) {
  const fxLine = /^Test vectors \(FX ([0-9.]+)/m.exec(markdown);
  if (fxLine === null) fail('no line starts with "Test vectors (FX "');
  for (const sentence of EXTRA_SENTENCES) {
    if (!markdown.includes(sentence))
      fail(`the plan no longer states the extra vector "${sentence}"`);
  }

  let steps;
  try {
    steps = JSON.parse(blockAfter(markdown, "Launch configuration for market"));
  } catch (error) {
    return fail(`the launch steps block of section 8 did not parse (${error.message})`);
  }
  if (!Array.isArray(steps) || steps.length === 0)
    fail("the launch steps block of section 8 is not a list of steps");

  const table = tableOf(markdown, "8. ", "aws_usd");
  const names = ["aws_usd", "base", "korea_vat", "bd_vat", "processing_fee", "total"];
  if (table.header.join("|") !== names.join("|")) {
    fail(`the test vector table of section 8 has the header "${table.header.join("|")}"`);
  }
  if (table.rows.length === 0) fail("the test vector table of section 8 has no rows");
  const vectors = table.rows.map((row) => {
    if (row.length !== names.length)
      fail(`a test vector row has ${row.length} cells: "${row.join("|")}"`);
    const [aws_usd, ...numbers] = row;
    const [base, korea_vat, bd_vat, processing_fee, total] = numbers.map((n, i) =>
      whole(n, names[i + 1]),
    );
    return { aws_usd, base, korea_vat, bd_vat, processing_fee, total };
  });

  return {
    fx: fxLine[1],
    steps: steps.map(({ code, rate, base }) => ({ code, rate, base })),
    vectors,
    extra: EXTRA,
  };
}

function tables(markdown) {
  const { rows } = tableOf(markdown, "7. ", "Table");
  if (rows.length === 0) fail("the table of section 7 has no rows");
  return rows.map(([first, columns]) => {
    const [name] = ticks(first ?? "");
    if (name === undefined || columns === undefined)
      fail(`a row of section 7 has no table name: "${first}"`);
    return { name, appendOnly: first.includes("(A)"), columns };
  });
}

function routes(markdown) {
  return ROUTE_SECTIONS.flatMap((id) => {
    const { rows } = tableOf(markdown, `${id} `, "Route");
    if (rows.length === 0) fail(`the route table of section ${id} has no rows`);
    return rows.map((row) => ({
      section: id,
      label: row[0].replaceAll("`", ""),
      routes: ticks(row[0]).filter((token) => token.startsWith("/")),
      priority: row.at(-1),
    }));
  });
}

function theme(markdown) {
  const { start, end } = section(markdown, "16.3 ");
  const all = tablesIn(markdown, start, end);
  const first = (header) => {
    const table = all.find((t) => t.header[0] === header);
    if (table === undefined)
      fail(`section 16.3 has no table whose first header cell is "${header}"`);
    return table.rows.map((row) => row[0]);
  };
  return { shipped: first("Shipped"), neverShipped: first("Never shipped") };
}

function secretNames(markdown) {
  const { rows } = tableOf(markdown, "B.3 ", "Secret name");
  const names = rows.flatMap((row) => ticks(row[0]).filter((token) => /^[A-Z]/.test(token)));
  if (names.length === 0) fail("the secret table of B.3 names no secret");
  return names;
}

export function buildBaseline(markdown) {
  return {
    source: { file: PLAN_FILE, version: version(markdown) },
    pricing: pricing(markdown),
    tables: tables(markdown),
    routes: routes(markdown),
    theme: theme(markdown),
    secretNames: secretNames(markdown),
    kitFiles: [...KIT_FILES],
  };
}
