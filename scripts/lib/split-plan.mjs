// Splits the plan into one Markdown file per section, and compares that split with a folder.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { headings, linesOf } from "./md.mjs";

const DEFAULT_SOURCE = "TICON_CLOUD_MEGA_PLAN.md";
const FOLDER_THRESHOLD = 150;

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseSectionHeading(text) {
  const m = /^([A-Z]|\d+)\.\s+(.*)$/.exec(text);
  if (m === null) throw new Error(`Section heading has no id: "${text}"`);
  const id = /^\d+$/.test(m[1]) ? m[1].padStart(2, "0") : m[1];
  return { id, title: m[2] };
}

function parseSubHeading(text) {
  const m = /^((?:[A-Z]|\d+)\.\d+)\.?\s+(.*)$/.exec(text);
  if (m === null) throw new Error(`Subsection heading has no id: "${text}"`);
  return { id: m[1], title: m[2] };
}

export function sectionFileName(headingText) {
  const { id, title } = parseSectionHeading(headingText);
  return `${id}-${slug(title)}.md`;
}

function stamp(source, range) {
  const where = range === null ? "" : ` lines ${range.start}-${range.end}`;
  return `<!-- GENERATED, do not edit. Source: ${source}${where}. Change the plan, then run pnpm spec:split. -->`;
}

function render(source, range, bodyLines) {
  return [stamp(source, range), "", ...bodyLines, ""].join("\n");
}

function cell(text) {
  return text.replaceAll("|", "\\|");
}

/** Splits the plan. Keys are paths relative to docs/spec/, in the order described in the plan. */
export function splitPlan(markdown, source = DEFAULT_SOURCE) {
  const lines = linesOf(markdown);
  const all = headings(markdown);
  const boundaries = all.filter((h) => h.level <= 2);

  const sections = [];
  const inSection = new Array(lines.length).fill(false);
  boundaries.forEach((h, i) => {
    if (h.level !== 2) return;
    const next = boundaries[i + 1];
    const end = next === undefined ? lines.length : next.n - 1;
    sections.push({ heading: h, start: h.n, end });
    for (let n = h.n; n <= end; n++) inSection[n - 1] = true;
  });

  const files = new Map();
  const index = [];

  const headerLines = lines.filter((_, i) => !inSection[i]);
  files.set("_plan-header.md", render(source, null, headerLines));
  index.push({ file: "_plan-header.md", heading: "Title block and Part headings", range: "" });

  for (const section of sections) {
    const { start, end, heading } = section;
    const name = sectionFileName(heading.text);
    const add = (file, from, to, title) => {
      files.set(file, render(source, { start: from, end: to }, lines.slice(from - 1, to)));
      index.push({ file, heading: title, range: `${from}-${to}` });
    };
    add(name, start, end, heading.text);

    if (end - start + 1 <= FOLDER_THRESHOLD) continue;
    const subs = all.filter((h) => h.level === 3 && h.n > start && h.n <= end);
    if (subs.length === 0) continue;
    const { id } = parseSectionHeading(heading.text);
    add(`${id}/${id}-intro.md`, start, subs[0].n - 1, `${heading.text} (intro)`);
    subs.forEach((sub, i) => {
      const parsed = parseSubHeading(sub.text);
      const to = i + 1 < subs.length ? subs[i + 1].n - 1 : end;
      add(`${id}/${parsed.id}-${slug(parsed.title)}.md`, sub.n, to, sub.text);
    });
  }

  const rows = index.map((r) => `| \`${r.file}\` | ${cell(r.heading)} | ${r.range} |`);
  files.set(
    "INDEX.md",
    render(source, null, [
      "# Specification index",
      "",
      "| File | Heading | Plan lines |",
      "| --- | --- | --- |",
      ...rows,
    ]),
  );
  return files;
}

function listFiles(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listFiles(join(dir, entry.name), rel));
    else found.push(rel);
  }
  return found;
}

export function diffAgainstDisk(files, dir) {
  const onDisk = new Set(listFiles(dir));
  const missing = [];
  const changed = [];
  for (const [name, content] of files) {
    if (!onDisk.has(name)) missing.push(name);
    else if (readFileSync(join(dir, name), "utf8") !== content) changed.push(name);
  }
  const stray = [...onDisk].filter((name) => !files.has(name));
  return { missing: missing.sort(), changed: changed.sort(), stray: stray.sort() };
}

function removeEmptyFolders(dir, root) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyFolders(join(dir, entry.name), root);
  }
  if (dir !== root && readdirSync(dir).length === 0) rmdirSync(dir);
}

export function writeSpec(files, dir) {
  const { stray } = diffAgainstDisk(files, dir);
  for (const [name, content] of files) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  for (const name of stray) rmSync(join(dir, name));
  removeEmptyFolders(dir, dir);
  return { written: files.size, removed: stray };
}
