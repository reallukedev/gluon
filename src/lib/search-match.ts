/**
 * Forgiving text matching for universal search, shared by the palette and the server. Ignores case,
 * accents and punctuation, accepts words in any order, and tolerates a typo or two in longer words.
 * Scores run 0 (no match) to 1 (the exact name), so results from different places can be ranked together.
 */

const MARKS = /\p{M}+/gu;
const SEP = /[^\p{L}\p{N}]+/gu;

/** "Café-Bar Ünïcode" → "cafe bar unicode". */
export function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/œ/g, "oe")
    .replace(/ł/g, "l")
    .replace(SEP, " ")
    .trim();
}

export interface Query {
  raw: string;
  folded: string;
  /** folded without spaces ("home bridge" → "homebridge"). */
  compact: string;
  tokens: string[];
}

export function prepare(q: string): Query {
  const folded = fold(q);
  const tokens = folded ? [...new Set(folded.split(" "))] : [];
  // Longer words first: they say more, and checking them first fails fast.
  tokens.sort((a, b) => b.length - a.length);
  return { raw: q, folded, compact: folded.replace(/ /g, ""), tokens };
}

export interface Fields {
  label: string;
  /** Other names and words people might type ("audit log" for Activity). */
  keywords?: string;
  /** The second line (a path, a summary). Counts for less than the name. */
  hint?: string;
}

/** Typos allowed in a typed word of this length. Short words must be right. */
function typos(len: number): number {
  return len >= 8 ? 2 : len >= 4 ? 1 : 0;
}

/** Optimal string alignment distance, giving up once it passes `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  const n = a.length;
  const m = b.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m]!;
}

const words = (folded: string) => (folded ? folded.split(" ") : []);

/** Does a typed word start one of these words? */
const prefixOf = (t: string, ws: string[]) => ws.some((w) => w.startsWith(t));

/** A typed word that is a word in the list (or the start of one) with a typo or two. */
function nearly(t: string, ws: string[]): boolean {
  const max = typos(t.length);
  if (!max) return false;
  for (const w of ws) {
    if (w.length < t.length - max) continue;
    // Compare with the start of the word at a few lengths, so a half-typed word with a typo still counts.
    for (let k = t.length - 1; k <= t.length + 1; k++) {
      if (k < 1 || k > w.length) continue;
      if (editDistance(t, w.slice(0, k), max) <= max) return true;
    }
  }
  return false;
}

/** Letters of the query appear in order in the name, starting with its first letter ("jlf" → Jellyfin). */
function subsequence(q: string, label: string): boolean {
  if (!q || q[0] !== label[0]) return false;
  let i = 0;
  for (const ch of label) if (ch === q[i] && ++i === q.length) return true;
  return false;
}

/** How well `fields` match the query, 0–1. */
export function matchScore(q: Query, f: Fields): number {
  if (!q.folded) return 0;
  const label = fold(f.label);
  if (!label) return 0;
  if (label === q.folded) return 1;
  const lw = words(label);
  const compactLabel = label.replace(/ /g, "");
  if (label.startsWith(q.folded)) return 0.95 - Math.min(0.05, (label.length - q.folded.length) / 400);
  if (compactLabel === q.compact) return 0.95;
  if (compactLabel.startsWith(q.compact)) return 0.9;

  // Every typed word starts a word of the name, in any order.
  if (q.tokens.every((t) => prefixOf(t, lw))) return 0.86;
  if (label.includes(q.folded)) return 0.8;
  // Initials: "hb" → Home Bridge, "dsm" → Docker Storage Manager.
  if (q.compact.length >= 2 && lw.length >= q.compact.length && lw.map((w) => w[0]).join("").startsWith(q.compact)) return 0.78;

  const kw = words(fold(f.keywords ?? ""));
  const hw = words(fold(f.hint ?? ""));
  const named = [...lw, ...kw];
  if (q.tokens.every((t) => prefixOf(t, named))) return 0.72;
  const all = [...named, ...hw];
  if (q.tokens.every((t) => prefixOf(t, all))) return 0.6;
  const hay = `${label} ${kw.join(" ")} ${hw.join(" ")}`;
  if (q.tokens.every((t) => hay.includes(t))) return 0.5;

  // Typos: every typed word nearly matches a word (the name's words count for more).
  if (q.tokens.every((t) => prefixOf(t, lw) || nearly(t, lw))) return 0.5;
  if (q.tokens.every((t) => prefixOf(t, named) || nearly(t, named))) return 0.42;
  if (q.compact.length >= 2 && label.length <= 48 && subsequence(q.compact, compactLabel)) return 0.3;
  return 0;
}

/** Score many things at once, dropping non-matches, best first (stable for ties). */
export function rank<T>(q: Query, list: readonly T[], fields: (x: T) => Fields, min = 0.01): { item: T; score: number }[] {
  const out: { item: T; score: number; i: number }[] = [];
  list.forEach((item, i) => {
    const score = matchScore(q, fields(item));
    if (score >= min) out.push({ item, score, i });
  });
  out.sort((a, b) => b.score - a.score || a.i - b.i);
  return out.map(({ item, score }) => ({ item, score }));
}

/** Little words around a command that say nothing about what it's for ("show the logs for jellyfin"). */
const FILLERS = new Set(["the", "for", "of", "my", "a", "an", "go", "to", "show", "please", "now"]);

/**
 * "restart jelly" → the verb's meaning ("restart") and what's left to match against ("jelly"). The
 * first word that starts a verb (3+ letters, so "rest jelly" works while typing) is the verb; other
 * verb words and filler words around it are dropped. With no verb, or nothing left after it, the query is returned as is.
 */
export function splitVerb(q: Query, verbs: Record<string, string>): { verb: string | null; rest: Query } {
  const names = Object.keys(verbs);
  let verb: string | null = null;
  const keep: string[] = [];
  for (const w of q.folded.split(" ")) {
    const v = w.length >= 3 ? names.find((x) => x.startsWith(w)) : names.find((x) => x === w);
    // The first verb decides; any later verb word ("why won't … open") is dropped like a filler.
    if (v) verb ??= verbs[v]!;
    else if (!FILLERS.has(w)) keep.push(w);
  }
  if (!verb || !keep.length) return { verb: null, rest: q };
  return { verb, rest: prepare(keep.join(" ")) };
}

/** "go to notifications", "settings sidebar", "open apps" → the place's name ("notifications"). */
export function placeQuery(q: Query): Query | null {
  const m = /^(?:go to|goto|go|open|show|settings)\s+(.+)$/.exec(q.folded);
  return m ? prepare(m[1]!) : null;
}
