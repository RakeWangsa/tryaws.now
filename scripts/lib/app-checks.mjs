// Pure checks for scripts/smoke-apps.mjs (WPU-T4 Task 10). No I/O: they read strings and Headers.

const SYMBOL_KIND = { ƒ: "dynamic", "○": "static", "●": "ssg", "◐": "partial" };
const ROUTE_LINE = /^\s*[┌├└]\s+([○●◐ƒ])\s+(\S+)/u;

// The route table that `next build` prints: `┌ ƒ /path`, `├ ○ /_not-found`, `└ ƒ /api/x`.
export function parseRouteTable(output) {
  const routes = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = ROUTE_LINE.exec(line);
    if (match) routes.push({ path: match[2], kind: SYMBOL_KIND[match[1]] });
  }
  return { routes };
}

// R16: a table that cannot be read is a problem, not a pass.
export function checkRouteTable(output) {
  const { routes } = parseRouteTable(output);
  if (routes.length === 0) return ["no routes parsed from the build output"];
  return routes
    .filter((route) => route.kind !== "dynamic")
    .map((route) => `route ${route.path} is ${route.kind}, expected dynamic`);
}

// The attributes of one start tag as a Map (lower-case names; a bare attribute has the value "").
function attributesOf(tag) {
  const attributes = new Map();
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const inner = tag.replace(/^<[^\s>/]+/, "").replace(/\/?>$/, "");
  for (const match of inner.matchAll(pattern)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function startTags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}(?=[\\s>/])[^>]*>`, "gi"))].map((m) => m[0]);
}

// headers: a Headers-like object with get(name) -> string | null.
// expect: { app, locale, stylesheets: string[], bodyAttributes: Record<string, string> }.
export function checkHtml(html, headers, expect) {
  const problems = [];
  const source = String(html);

  const reportOnly = headers.get("content-security-policy-report-only");
  const nonceMatch = reportOnly === null ? null : /'nonce-([^']+)'/.exec(reportOnly);
  const nonce = nonceMatch === null ? null : nonceMatch[1];
  if (reportOnly === null) {
    problems.push("the content-security-policy-report-only header is missing");
  } else if (nonce === null) {
    problems.push("the report-only policy has no 'nonce-...' source");
  }
  if (headers.get("content-security-policy") !== null) {
    problems.push("an enforced content-security-policy header is present (must be report-only)");
  }

  for (const tag of startTags(source, "script")) {
    if (nonce === null || attributesOf(tag).get("nonce") !== nonce) {
      problems.push(`a <script> element has no nonce equal to the header's: ${tag.slice(0, 80)}`);
    }
  }

  if (source.includes(' style="')) problems.push('an inline style="..." attribute is present');

  const htmlTag = startTags(source, "html")[0];
  const lang = htmlTag === undefined ? undefined : attributesOf(htmlTag).get("lang");
  if (lang !== expect.locale) {
    problems.push(
      `<html lang> is ${JSON.stringify(lang)}, expected ${JSON.stringify(expect.locale)}`,
    );
  }

  const sheets = startTags(source, "link")
    .map(attributesOf)
    .filter((a) => (a.get("rel") ?? "").split(/\s+/).includes("stylesheet"))
    .map((a) => a.get("href") ?? "")
    .filter((href) => href.startsWith("/theme"));
  if (JSON.stringify(sheets) !== JSON.stringify(expect.stylesheets)) {
    problems.push(
      `theme stylesheets are ${JSON.stringify(sheets)}, expected ${JSON.stringify(expect.stylesheets)}`,
    );
  }

  const boxes = source.split('class="box-container limit-width"').length - 1;
  if (boxes !== 1)
    problems.push(`found ${boxes} div.box-container.limit-width, expected exactly 1`);

  const body = startTags(source, "body")[0];
  if (body === undefined) {
    problems.push("there is no <body> element");
  } else {
    const bodyAttributes = attributesOf(body);
    for (const [name, value] of Object.entries(expect.bodyAttributes)) {
      if (bodyAttributes.get(name) !== value) problems.push(`<body> lacks ${name}="${value}"`);
    }
  }

  for (const match of source.matchAll(/\s(src|href|action)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = match[2] ?? match[3] ?? "";
    if (/^(https?:)?\/\//i.test(value)) {
      problems.push(`an external ${match[1].toLowerCase()} attribute: ${value.slice(0, 80)}`);
    }
  }

  if (source.includes("/theme/assets/js"))
    problems.push("a reference to /theme/assets/js is present");

  if (headers.get("x-content-type-options") === null) {
    problems.push("the x-content-type-options header is missing");
  }
  return problems;
}
