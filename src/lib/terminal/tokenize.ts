/**
 * Just enough of a shell's grammar to complete the word under the cursor: words with their quotes
 * and escapes undone, split into commands at | && || ; & and ( ), with redirections noticed.
 */

export interface Word {
  /** The word as the shell would see it (quotes and escapes removed). */
  value: string;
  start: number;
  end: number;
  /** A quote still open at the end of the word. */
  openQuote: '"' | "'" | null;
}

export interface CompletionContext {
  /** Words of the command being typed, before the current one. */
  words: Word[];
  /** The word under the cursor (empty when the cursor follows a space). */
  current: Word;
  /** The current word follows >, < or 2> and so names a file. */
  redirect: boolean;
}

const OPERATOR = /^(\|\||&&|;;|[|;&()\n])/;
const REDIRECT = /^(&>>?|>>?|<<?<?)/;

export function completionContext(line: string, cursor = line.length): CompletionContext {
  const text = line.slice(0, cursor);
  let words: Word[] = [];
  let redirect: boolean;
  let pendingRedirect = false;
  let cur: Word | null = null;
  let quote: '"' | "'" | null = null;
  let i = 0;
  const finish = () => {
    if (!cur) return;
    cur.end = i;
    if (pendingRedirect) {
      // A redirect target isn't an argument: drop it from the words.
      pendingRedirect = false;
    } else words.push(cur);
    cur = null;
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < text.length && /["\\$`]/.test(text[i + 1]!)) cur!.value += text[++i];
      else cur!.value += ch;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      cur ??= { value: "", start: i, end: i, openQuote: null };
      quote = ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      cur ??= { value: "", start: i, end: i, openQuote: null };
      cur.value += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === " " || ch === "\t") {
      finish();
      i++;
      continue;
    }
    const rest = text.slice(i);
    if (ch === ">" || ch === "<" || (ch === "&" && rest[1] === ">")) {
      // `2>` and `&>`: the number belongs to the redirect, not the words.
      if (cur && /^\d$/.test(cur.value) && cur.start === i - 1) cur = null;
      else finish();
      pendingRedirect = true;
      i += rest.match(REDIRECT)?.[0].length || 1;
      if (text[i] === "&") i++;
      continue;
    }
    const op = rest.match(OPERATOR) ?? (rest.startsWith("$(") ? ["$("] : null);
    if (op) {
      finish();
      words = [];
      pendingRedirect = false;
      i += op[0].length;
      continue;
    }
    cur ??= { value: "", start: i, end: i, openQuote: null };
    cur.value += ch;
    i++;
  }
  let current: Word;
  if (cur) {
    const c = cur as Word;
    c.end = text.length;
    c.openQuote = quote;
    current = c;
    redirect = pendingRedirect;
  } else {
    current = { value: "", start: text.length, end: text.length, openQuote: null };
    redirect = pendingRedirect;
  }
  return { words, current, redirect };
}

/** Programs that run the rest of the line as another command. */
const PREFIXES = new Set(["sudo", "doas", "env", "time", "nice", "nohup", "exec", "command", "builtin", "stdbuf", "ionice", "chroot", "timeout", "watch", "xargs", "strace", "unbuffer"]);

/**
 * Where the real command starts: past `sudo`, `env`, `VAR=value` and the options and numeric
 * arguments those take (`timeout 10`, `nice -n 5`), so `sudo -u www docker ps` completes as docker.
 */
export function commandStart(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    if (PREFIXES.has(w)) {
      i++;
      while (i < words.length && (/^-/.test(words[i]!) || /^\d+[smhd]?$/.test(words[i]!) || (w === "sudo" && words[i - 1] === "-u") || (w === "chroot" && words[i - 1] === "chroot"))) {
        // `sudo -u luke` and `chroot /mnt`: their argument is part of the prefix too.
        i++;
      }
      continue;
    }
    break;
  }
  return i;
}

const SAFE = /^[A-Za-z0-9_@%+=:,./~^-]+$/;

/** Write a value so the shell reads it back unchanged, inside an open quote when there is one. */
export function quoteWord(value: string, openQuote: '"' | "'" | null): string {
  if (openQuote === "'") return value.replace(/'/g, `'\\''`);
  if (openQuote === '"') return value.replace(/(["\\$`])/g, "\\$1");
  if (value === "" || SAFE.test(value)) return value;
  return value.replace(/([^A-Za-z0-9_@%+=:,./~^-])/g, "\\$1");
}
