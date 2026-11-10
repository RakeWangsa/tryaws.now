import { expect, it } from "vitest";
import { blockAfter, headings, sectionRange, tablesIn } from "./md.mjs";

const md = [
  "# Title",
  "",
  "## A. One",
  "`file.json`:",
  "",
  "```json",
  '{ "a": 1 }',
  "## Not a heading",
  "```",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| `x` | 1 |",
  "| y | two words |",
  "",
  "### A.1 Sub",
  "t",
  "## B. Two",
  "end",
].join("\n");

it("lists headings outside fences only", () => {
  expect(headings(md)).toEqual([
    { n: 1, level: 1, text: "Title" },
    { n: 3, level: 2, text: "A. One" },
    { n: 16, level: 3, text: "A.1 Sub" },
    { n: 18, level: 2, text: "B. Two" },
  ]);
});
it("finds a section's line range", () => {
  expect(sectionRange(md, "A. One")).toEqual({ start: 3, end: 17 });
  expect(sectionRange(md, "A.1")).toEqual({ start: 16, end: 17 });
  expect(sectionRange(md, "B.")).toEqual({ start: 18, end: 19 });
  expect(() => sectionRange(md, "Z.")).toThrow();
});
it("returns the fenced block after a marker line", () => {
  expect(blockAfter(md, "`file.json`")).toBe('{ "a": 1 }\n## Not a heading\n');
  expect(() => blockAfter(md, "`missing`")).toThrow();
});
it("parses the tables in a line range", () => {
  expect(tablesIn(md, 3, 17)).toEqual([
    {
      n: 11,
      header: ["Name", "Value"],
      rows: [
        ["`x`", "1"],
        ["y", "two words"],
      ],
    },
  ]);
});
