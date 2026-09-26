import "server-only";

/**
 * A tolerant, non-validating XML reader for feeds. It never expands custom entities or fetches DTDs (so no XXE or
 * "billion laughs"), caps depth and node count, and recovers from common feed breakage (unclosed tags, stray &).
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Named entities commonly found in feed text (after XML decoding, HTML in descriptions uses these). */
const HTML_ENTITIES: Record<string, string> = {
  ...XML_ENTITIES,
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  times: "×",
  divide: "÷",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  aacute: "á",
  agrave: "à",
  acirc: "â",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  ccedil: "ç",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  oslash: "ø",
  aring: "å",
  aelig: "æ",
  zwj: "‍",
  zwnj: "‌",
  shy: "",
};

export function decodeEntities(s: string, html = false): string {
  if (!s.includes("&")) return s;
  const table = html ? HTML_ENTITIES : XML_ENTITIES;
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return table[e] ?? (html ? m : (HTML_ENTITIES[e] ?? m));
  });
}

const ATTR = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

export function parseXml(src: string, limits = { maxNodes: 50_000, maxDepth: 64 }): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let nodes = 0;
  let i = 0;
  const n = src.length;
  const top = () => stack[stack.length - 1]!;

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      top().text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      top().text += src.slice(i + 9, end === -1 ? n : end);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<!", i)) {
      // DOCTYPE (possibly with an internal subset): skipped entirely, entities are never defined.
      let depth = 0;
      let j = i + 2;
      for (; j < n; j++) {
        const c = src[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    const gt = src.indexOf(">", i);
    if (gt === -1) break;
    const inner = src.slice(i + 1, gt);
    i = gt + 1;
    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      // Pop to the matching open element; ignore stray closers.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^[^\s/>]+/.exec(body);
    if (!nameMatch) {
      top().text += decodeEntities(`<${inner}>`);
      continue;
    }
    if (++nodes > limits.maxNodes) break;
    const node: XmlNode = { name: nameMatch[0], attrs: {}, children: [], text: "" };
    const rest = body.slice(nameMatch[0].length);
    ATTR.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATTR.exec(rest))) {
      const v = m[2] ?? "";
      node.attrs[m[1]!] = decodeEntities(/^["']/.test(v) ? v.slice(1, -1) : v);
    }
    top().children.push(node);
    if (!selfClosing && stack.length < limits.maxDepth) stack.push(node);
  }
  return root;
}

// ------------------------------------------------------------------ helpers

export const child = (n: XmlNode | undefined, ...names: string[]) => n?.children.find((c) => names.includes(c.name));
export const children = (n: XmlNode | undefined, ...names: string[]) => n?.children.filter((c) => names.includes(c.name)) ?? [];

/** Text content including descendants (for elements that contain inline XHTML). */
export function textOf(n: XmlNode | undefined): string {
  if (!n) return "";
  if (!n.children.length) return n.text;
  let s = n.text;
  for (const c of n.children) s += textOf(c);
  return s;
}

/** HTML → plain text: drop scripts/styles/tags, decode entities, collapse whitespace. */
export function htmlToText(html: string, max = 280): string {
  let s = html
    .replace(/<(script|style|noscript|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  s = decodeEntities(s, true).replace(/\s+/g, " ").trim();
  if (s.length > max) s = `${s.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
  return s;
}
