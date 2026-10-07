/**
 * A small terminal screen for command output: enough of what a terminal does that colours, progress
 * bars (\r), `docker pull`'s redrawn lines (cursor up, erase line) and `clear` come out right in a
 * plain block of text. Colours are kept as the 16 ANSI slots (256 and true colours are mapped onto
 * the nearest), so they can be drawn with the theme's own colours in light and dark.
 */

export interface Run {
  text: string;
  /** Packed style; read it with `styleOf`. */
  s: number;
}

export interface StyleAttrs {
  fg: number | null;
  bg: number | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

const NONE = 16;
const DEFAULT_STYLE = NONE | (NONE << 5);
const BOLD = 1 << 10;
const DIM = 1 << 11;
const ITALIC = 1 << 12;
const UNDERLINE = 1 << 13;
const INVERSE = 1 << 14;

export function styleOf(s: number): StyleAttrs {
  const fg = s & 31;
  const bg = (s >> 5) & 31;
  return { fg: fg === NONE ? null : fg, bg: bg === NONE ? null : bg, bold: !!(s & BOLD), dim: !!(s & DIM), italic: !!(s & ITALIC), underline: !!(s & UNDERLINE), inverse: !!(s & INVERSE) };
}

export const isPlainStyle = (s: number) => s === DEFAULT_STYLE;

// xterm's default 16 colours, for mapping 256-colour and true-colour values onto a slot.
const BASE: [number, number, number][] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

export function nearestSlot(r: number, g: number, b: number): number {
  let best = 7;
  let bestD = Infinity;
  for (let i = 0; i < 16; i++) {
    const [R, G, B] = BASE[i]!;
    const d = (r - R) ** 2 * 0.3 + (g - G) ** 2 * 0.59 + (b - B) ** 2 * 0.11;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function slot256(n: number): number {
  if (n < 16) return n;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return v < 60 ? 0 : v < 160 ? 8 : v < 220 ? 7 : 15;
  }
  const i = n - 16;
  const c = [Math.floor(i / 36), Math.floor(i / 6) % 6, i % 6].map((x) => (x ? 55 + x * 40 : 0)) as [number, number, number];
  return nearestSlot(...c);
}

interface Line {
  chars: string[];
  styles: number[];
  rev: number;
}

const MAX_LINES = 20_000;

export class AnsiScreen {
  private lines: Line[] = [{ chars: [], styles: [], rev: 0 }];
  private row = 0;
  private col = 0;
  private style = DEFAULT_STYLE;
  private pending = "";
  private saved: [number, number] = [0, 0];
  private rev = 0;
  private cache = new Map<Line, { rev: number; runs: Run[] }>();
  /** Lines dropped from the top to stay under the cap. */
  dropped = 0;
  /** The program switched to the alternate screen (a full-screen program). */
  altScreen = false;

  /** `rows` is the height the program was told, for absolute cursor moves. */
  constructor(private rows = 24) {}

  setRows(rows: number) {
    this.rows = rows;
  }

  get lineCount() {
    return this.lines.length;
  }

  /** Changes on every write that touched the screen. */
  get version() {
    return this.rev;
  }

  write(data: string) {
    if (!data) return;
    this.rev++;
    const text = this.pending + data;
    this.pending = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      const code = ch.charCodeAt(0);
      if (code === 0x1b) {
        const used = this.escape(text, i);
        if (used < 0) {
          this.pending = text.slice(i);
          break;
        }
        i += used;
        continue;
      }
      if (code === 0x0a) {
        this.newline();
      } else if (code === 0x0d) {
        this.col = 0;
      } else if (code === 0x08) {
        this.col = Math.max(0, this.col - 1);
      } else if (code === 0x09) {
        const to = (Math.floor(this.col / 8) + 1) * 8;
        while (this.col < to) this.put(" ");
      } else if (code >= 0x20 && code !== 0x7f) {
        this.put(ch);
      }
      // Other control characters (bell, shift in/out) draw nothing.
      i++;
    }
    this.trim();
  }

  /** Runs of same-styled text for line `i`, cached until the line changes. */
  runs(i: number): Run[] {
    const line = this.lines[i];
    if (!line) return [];
    const hit = this.cache.get(line);
    if (hit && hit.rev === line.rev) return hit.runs;
    const runs: Run[] = [];
    let text = "";
    let s = -1;
    for (let k = 0; k < line.chars.length; k++) {
      const st = line.styles[k]!;
      if (st !== s && text) {
        runs.push({ text, s });
        text = "";
      }
      s = st;
      text += line.chars[k];
    }
    if (text) runs.push({ text, s });
    this.cache.set(line, { rev: line.rev, runs });
    return runs;
  }

  lineRev(i: number): number {
    return this.lines[i]?.rev ?? -1;
  }

  /** Everything as plain text, without trailing blank lines. */
  text(): string {
    const out = this.lines.map((l) => l.chars.join("").replace(/\s+$/, ""));
    while (out.length && !out[out.length - 1]) out.pop();
    return out.join("\n");
  }

  /** The line the cursor is on, as text (to spot "Password:" prompts). */
  currentLine(): string {
    return this.lines[this.row]?.chars.join("") ?? "";
  }

  // ---------------------------------------------------------------- internals

  private line(): Line {
    while (this.lines.length <= this.row) this.lines.push({ chars: [], styles: [], rev: this.rev });
    return this.lines[this.row]!;
  }

  private put(ch: string) {
    const l = this.line();
    while (l.chars.length < this.col) {
      l.chars.push(" ");
      l.styles.push(DEFAULT_STYLE);
    }
    l.chars[this.col] = ch;
    l.styles[this.col] = this.style;
    l.rev = this.rev;
    this.col++;
  }

  private newline() {
    this.row++;
    this.col = 0;
    this.line();
  }

  private trim() {
    const over = this.lines.length - MAX_LINES;
    if (over > 0) {
      this.lines.splice(0, over);
      this.row = Math.max(0, this.row - over);
      this.dropped += over;
    }
  }

  private top() {
    return Math.max(0, this.lines.length - this.rows);
  }

  private erase(l: Line, from: number, to: number) {
    if (from >= l.chars.length) return;
    if (to >= l.chars.length) {
      l.chars.length = from;
      l.styles.length = from;
    } else {
      for (let k = from; k < to; k++) {
        l.chars[k] = " ";
        l.styles[k] = DEFAULT_STYLE;
      }
    }
    l.rev = this.rev;
  }

  /** Handle the escape sequence at `i`; returns its length, or -1 when it's cut off. */
  private escape(text: string, i: number): number {
    const next = text[i + 1];
    if (next === undefined) return -1;
    if (next === "[") {
      let j = i + 2;
      while (j < text.length && /[0-9;?<=>!]/.test(text[j]!)) j++;
      // Intermediate bytes (space, quote) before the final one.
      while (j < text.length && /[ -/]/.test(text[j]!)) j++;
      if (j >= text.length) return text.length - i > 64 ? 2 : -1;
      this.csi(text.slice(i + 2, j), text[j]!);
      return j - i + 1;
    }
    if (next === "]" || next === "P" || next === "_" || next === "^") {
      // OSC / DCS / APC / PM: up to BEL or ST. Titles and links aren't drawn.
      for (let j = i + 2; j < text.length; j++) {
        if (text[j] === "\x07") return j - i + 1;
        if (text[j] === "\x1b" && text[j + 1] === "\\") return j - i + 2;
      }
      return text.length - i > 4096 ? text.length - i : -1;
    }
    if (next === "(" || next === ")" || next === "*" || next === "+" || next === "#" || next === "%") {
      return text.length > i + 2 ? 3 : -1;
    }
    if (next === "7") this.saved = [this.row, this.col];
    else if (next === "8") [this.row, this.col] = this.saved;
    else if (next === "M") this.row = Math.max(0, this.row - 1);
    else if (next === "D") this.row++;
    else if (next === "E") this.newline();
    else if (next === "c") this.reset();
    return 2;
  }

  private reset() {
    this.lines = [{ chars: [], styles: [], rev: this.rev }];
    this.row = 0;
    this.col = 0;
    this.style = DEFAULT_STYLE;
  }

  private csi(params: string, final: string) {
    if (params.startsWith("?")) {
      if (final === "h" && /(^|;)(1049|1047|47)(;|$)/.test(params.slice(1))) this.altScreen = true;
      return;
    }
    if (/^[<=>]/.test(params)) return;
    const nums = params.split(";").map((p) => (p === "" ? NaN : Number(p)));
    const n = (k = 0, d = 1) => (Number.isFinite(nums[k]) && nums[k]! > 0 ? nums[k]! : d);
    switch (final) {
      case "m":
        this.sgr(params === "" ? [0] : nums.map((x) => (Number.isFinite(x) ? x : 0)));
        return;
      case "A":
        this.row = Math.max(this.top(), this.row - n());
        return;
      case "B":
        this.row += n();
        this.line();
        return;
      case "C":
        this.col += n();
        return;
      case "D":
        this.col = Math.max(0, this.col - n());
        return;
      case "E":
        this.row += n();
        this.col = 0;
        this.line();
        return;
      case "F":
        this.row = Math.max(this.top(), this.row - n());
        this.col = 0;
        return;
      case "G":
      case "`":
        this.col = n() - 1;
        return;
      case "d":
        this.row = this.top() + n() - 1;
        this.line();
        return;
      case "H":
      case "f":
        this.row = this.top() + n(0) - 1;
        this.col = n(1) - 1;
        this.line();
        return;
      case "K": {
        const l = this.line();
        const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
        if (mode === 0) this.erase(l, this.col, Infinity);
        else if (mode === 1) this.erase(l, 0, this.col + 1);
        else this.erase(l, 0, Infinity);
        return;
      }
      case "J": {
        const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
        if (mode === 2 || mode === 3) {
          // `clear`: start over, as a terminal's visible screen would.
          this.reset();
          return;
        }
        const l = this.line();
        if (mode === 0) {
          this.erase(l, this.col, Infinity);
          this.lines.length = this.row + 1;
        } else this.erase(l, 0, this.col + 1);
        return;
      }
      case "s":
        this.saved = [this.row, this.col];
        return;
      case "u":
        [this.row, this.col] = this.saved;
        return;
      default:
        return;
    }
  }

  private sgr(codes: number[]) {
    let s = this.style;
    const setFg = (v: number) => (s = (s & ~31) | v);
    const setBg = (v: number) => (s = (s & ~(31 << 5)) | (v << 5));
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k]!;
      if (c === 0) s = DEFAULT_STYLE;
      else if (c === 1) s |= BOLD;
      else if (c === 2) s |= DIM;
      else if (c === 3) s |= ITALIC;
      else if (c === 4) s |= UNDERLINE;
      else if (c === 7) s |= INVERSE;
      else if (c === 21 || c === 22) s &= ~(BOLD | DIM);
      else if (c === 23) s &= ~ITALIC;
      else if (c === 24) s &= ~UNDERLINE;
      else if (c === 27) s &= ~INVERSE;
      else if (c >= 30 && c <= 37) setFg(c - 30);
      else if (c >= 90 && c <= 97) setFg(c - 90 + 8);
      else if (c === 39) setFg(NONE);
      else if (c >= 40 && c <= 47) setBg(c - 40);
      else if (c >= 100 && c <= 107) setBg(c - 100 + 8);
      else if (c === 49) setBg(NONE);
      else if (c === 38 || c === 48) {
        const set = c === 38 ? setFg : setBg;
        if (codes[k + 1] === 5 && codes[k + 2] !== undefined) {
          set(slot256(codes[k + 2]!));
          k += 2;
        } else if (codes[k + 1] === 2 && codes[k + 4] !== undefined) {
          set(nearestSlot(codes[k + 2]!, codes[k + 3]!, codes[k + 4]!));
          k += 4;
        }
      }
    }
    this.style = s;
  }
}
