// Small Markdown helpers. Line numbers are 1-based. Lines inside a fenced code block are
// never headings, markers or tables.

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Splits text into lines, dropping the empty last element of a text that ends in a newline. */
export function linesOf(markdown) {
  const lines = markdown.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Fenced blocks as 0-based line indexes; `close` is -1 when the fence is never closed. */
function fences(lines) {
  const blocks = [];
  let open = null;
  lines.forEach((line, i) => {
    const m = FENCE.exec(line);
    if (open === null) {
      if (m !== null) open = { open: i, marker: m[1] };
    } else if (
      m !== null &&
      m[1][0] === open.marker[0] &&
      m[1].length >= open.marker.length &&
      line.trim() === m[1]
    ) {
      blocks.push({ open: open.open, close: i });
      open = null;
    }
  });
  if (open !== null) blocks.push({ open: open.open, close: -1 });
  return blocks;
}

/** For every line, whether it lies inside a fenced block (the fence lines themselves count). */
function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  for (const { open, close } of fences(lines)) {
    for (let i = open; i <= (close === -1 ? lines.length - 1 : close); i++) mask[i] = true;
  }
  return mask;
}

export function headings(markdown) {
  const lines = linesOf(markdown);
  const mask = fenceMask(lines);
  const found = [];
  lines.forEach((line, i) => {
    if (mask[i]) return;
    const m = HEADING.exec(line);
    if (m !== null) found.push({ n: i + 1, level: m[1].length, text: m[2] });
  });
  return found;
}

export function sectionRange(markdown, prefix) {
  const all = headings(markdown);
  const index = all.findIndex((h) => h.text.startsWith(prefix));
  if (index === -1) throw new Error(`No heading starts with "${prefix}"`);
  const last = linesOf(markdown).length;
  const next = all.slice(index + 1).find((h) => h.level <= all[index].level);
  return { start: all[index].n, end: next === undefined ? last : next.n - 1 };
}

export function blockAfter(markdown, lineStartsWith) {
  const lines = linesOf(markdown);
  const mask = fenceMask(lines);
  const marker = lines.findIndex((line, i) => !mask[i] && line.startsWith(lineStartsWith));
  if (marker === -1) throw new Error(`No line outside a fence starts with "${lineStartsWith}"`);
  const block = fences(lines).find((f) => f.open > marker);
  if (block === undefined) throw new Error(`No fenced block after "${lineStartsWith}"`);
  const end = block.close === -1 ? lines.length : block.close;
  return lines
    .slice(block.open + 1, end)
    .map((l) => `${l}\n`)
    .join("");
}

function cellsOf(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((c) => c.trim());
}

export function tablesIn(markdown, start, end) {
  const lines = linesOf(markdown);
  const mask = fenceMask(lines);
  const tables = [];
  for (let i = start - 1; i < Math.min(end, lines.length); i++) {
    if (mask[i] || !lines[i].trim().startsWith("|")) continue;
    const separator = lines[i + 1];
    if (separator === undefined || mask[i + 1] || !SEPARATOR.test(separator)) continue;
    const rows = [];
    let j = i + 2;
    while (j < lines.length && !mask[j] && lines[j].trim().startsWith("|")) {
      rows.push(cellsOf(lines[j]));
      j++;
    }
    tables.push({ n: i + 1, header: cellsOf(lines[i]), rows });
    i = j - 1;
  }
  return tables;
}
