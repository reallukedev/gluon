import { commandStart, completionContext, quoteWord, type CompletionContext } from "./tokenize";
import type { DirEntry, SpecArg, SpecNode, SpecOption } from "./types";

/**
 * Suggestions for the command line, from everything we know about the target, ranked together:
 * the person's history, programs on the PATH, subcommands and options of known programs, files and
 * folders, containers and systemd units. Two steps: `analyze` says what's needed for the word under
 * the cursor (so the UI fetches only that), `suggest` ranks what came back.
 */

export type SuggestionKind = "history" | "command" | "subcommand" | "option" | "folder" | "file" | "container" | "unit" | "value";

export interface Suggestion {
  kind: SuggestionKind;
  label: string;
  description?: string;
  /** The whole line after choosing it, and where the cursor goes. */
  line: string;
  caret: number;
  score: number;
}

export interface Analysis {
  ctx: CompletionContext;
  /** The program being typed into (`docker` for `sudo docker ps`), or null at the start of a command. */
  program: string | null;
  /** The command name is the word under the cursor. */
  atCommand: boolean;
  /** Folder to list for path suggestions, as typed ("" is the working folder), or null when paths don't apply. */
  dir: string | null;
  wantsContainers: boolean;
  wantsUnits: boolean;
}

export interface Sources {
  /** Most recent first. */
  history: string[];
  commands: string[] | null;
  spec: SpecNode | null;
  /** The listing of `analysis.dir`. */
  entries: DirEntry[] | null;
  containers: string[];
  units: string[];
}

const BUILTINS = ["cd", "export", "unset", "source", "alias", "pwd", "echo", "printf", "type", "umask", "ulimit", "set", "test", "read", "wait", "jobs", "history", "exit"];
const FOLDER_ONLY = new Set(["cd", "pushd", "rmdir"]);
const CONTAINER_SUBS = new Set(["exec", "logs", "restart", "stop", "start", "kill", "inspect", "rm", "top", "stats", "attach", "pause", "unpause", "port", "diff", "export", "commit", "rename", "update", "wait"]);
const MANY_CONTAINERS = new Set(["restart", "stop", "start", "kill", "rm", "pause", "unpause", "inspect", "stats", "wait", "update"]);
const UNIT_SUBS = new Set(["start", "stop", "restart", "reload", "status", "enable", "disable", "is-active", "is-enabled", "is-failed", "show", "cat", "edit", "mask", "unmask", "kill", "reset-failed", "try-restart", "reload-or-restart", "list-dependencies", "revert"]);

// ------------------------------------------------------------------ matching

/** How well `typed` matches `candidate`: 1 for a prefix, less for looser matches, 0 for none. */
export function matchQuality(candidate: string, typed: string): number {
  if (!typed) return 0.6;
  if (candidate.startsWith(typed)) return candidate === typed ? 0.98 : 1;
  const c = candidate.toLowerCase();
  const t = typed.toLowerCase();
  if (c.startsWith(t)) return 0.9;
  if (t.length >= 2 && c.includes(t)) return 0.55;
  if (t.length >= 3) {
    let k = 0;
    for (const ch of c) if (ch === t[k]) k++;
    if (k === t.length) return 0.3;
  }
  return 0;
}

const WEIGHT: Record<SuggestionKind, number> = {
  history: 1.15,
  subcommand: 1,
  container: 1,
  unit: 1,
  value: 1,
  option: 0.95,
  folder: 0.92,
  file: 0.88,
  command: 0.85,
};

// ------------------------------------------------------------------ spec walking

const names = (x: { name: string[] }) => x.name;

interface SpecState {
  node: SpecNode;
  inherited: SpecOption[];
  used: Set<string>;
  argIndex: number;
  /** The option whose value is being typed (`-n |` or `--tail=|`). */
  pendingOption: SpecOption | null;
  /** The subcommand path, for name-based hints: ["compose", "logs"]. */
  path: string[];
}

function findOption(st: SpecState, name: string): SpecOption | undefined {
  return [...(st.node.options ?? []), ...st.inherited].find((o) => o.name.includes(name));
}

function walk(spec: SpecNode | null, args: string[]): SpecState | null {
  if (!spec) return null;
  const st: SpecState = { node: spec, inherited: [], used: new Set(), argIndex: 0, pendingOption: null, path: [] };
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!;
    if (w.startsWith("-") && w !== "-" && w !== "--") {
      const name = w.includes("=") ? w.slice(0, w.indexOf("=")) : w;
      const opt = findOption(st, name);
      if (opt) {
        for (const n of opt.name) st.used.add(n);
        if (opt.args?.length && !w.includes("=")) {
          if (k === args.length - 1) st.pendingOption = opt;
          k++;
        }
      }
      continue;
    }
    const sub = st.node.subcommands?.find((s) => s.name.includes(w));
    if (sub) {
      st.inherited = [...st.inherited, ...(st.node.options ?? []).filter((o) => o.persistent)];
      st.node = sub;
      st.used = new Set();
      st.argIndex = 0;
      st.path.push(w);
      continue;
    }
    st.argIndex++;
  }
  return st;
}

function argAt(node: SpecNode, i: number): SpecArg | null {
  const list = node.args ?? [];
  if (!list.length) return null;
  if (i < list.length) return list[i]!;
  const last = list[list.length - 1]!;
  return last.variadic ? last : null;
}

const takesPaths = (a: SpecArg | null) => !!a?.template?.length;

// ------------------------------------------------------------------ analyze

export function analyze(line: string, cursor: number, spec: SpecNode | null = null): Analysis {
  const ctx = completionContext(line, cursor);
  const words = ctx.words.map((w) => w.value);
  const start = commandStart(words);
  const atCommand = start >= words.length && !ctx.redirect;
  const program = atCommand ? null : (words[start] ?? null)?.replace(/^.*\//, "") ?? null;
  const cur = ctx.current.value;
  const looksPath = /^(\.{1,2}\/|~|\/)/.test(cur) || cur.includes("/");
  const dirOf = (v: string) => (v.includes("/") ? v.slice(0, v.lastIndexOf("/") + 1) : "");

  let dir: string | null = null;
  let wantsContainers = false;
  let wantsUnits = false;

  if (ctx.redirect || (atCommand && looksPath)) dir = dirOf(cur);
  else if (!atCommand && program) {
    const args = words.slice(start + 1);
    const st = walk(spec, args);
    const prev = args[args.length - 1];
    const sub = st?.path[0] ?? args.find((a) => !a.startsWith("-"));
    if ((program === "docker" || program === "podman") && sub && CONTAINER_SUBS.has(sub) && !cur.startsWith("-") && !st?.pendingOption) {
      // `docker exec web sh`: only the first word after exec is a container; `docker restart a b`: all are.
      const after = st ? st.argIndex : Math.max(0, args.filter((x) => !x.startsWith("-")).length - 1);
      wantsContainers = MANY_CONTAINERS.has(sub) || after === 0;
    }
    if (program === "systemctl" && sub && UNIT_SUBS.has(sub) && !cur.startsWith("-")) wantsUnits = true;
    if (program === "journalctl" && (prev === "-u" || prev === "--unit" || cur.startsWith("--unit="))) wantsUnits = true;
    if (!cur.startsWith("-") || cur.includes("=")) {
      const pending = st?.pendingOption ?? null;
      const arg = pending ? (pending.args?.[0] ?? null) : st ? argAt(st.node, st.argIndex) : null;
      if (looksPath || FOLDER_ONLY.has(program) || takesPaths(arg) || (!st && !wantsContainers && !wantsUnits)) dir = dirOf(cur);
      if (arg && /container/i.test(arg.name ?? "") && (program === "docker" || program === "podman")) wantsContainers = true;
    }
  }
  return { ctx, program, atCommand, dir, wantsContainers, wantsUnits };
}

// ------------------------------------------------------------------ suggest

function replaceWord(line: string, cursor: number, ctx: CompletionContext, value: string, final: boolean): { line: string; caret: number } {
  const q = ctx.current.openQuote;
  let text = q ? q + quoteWord(value, q) + (final ? q : "") : quoteWord(value, null);
  const after = line.slice(cursor);
  if (final && !/^\s/.test(after)) text += " ";
  const before = line.slice(0, ctx.current.start);
  return { line: before + text + after, caret: before.length + text.length };
}

export function suggest(line: string, cursor: number, a: Analysis, src: Sources, limit = 40): Suggestion[] {
  const out: Suggestion[] = [];
  const typed = a.ctx.current.value;
  const seen = new Set<string>();
  const add = (kind: SuggestionKind, label: string, value: string, quality: number, opts: { description?: string; final?: boolean; bonus?: number } = {}) => {
    if (quality <= 0) return;
    const key = `${kind === "history" ? "h" : "w"}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    const r = replaceWord(line, cursor, a.ctx, value, opts.final ?? true);
    // Picking it would change nothing: not worth showing.
    if (r.line === line && kind !== "history") return;
    out.push({ kind, label, description: opts.description, ...r, score: quality * WEIGHT[kind] + (opts.bonus ?? 0) });
  };

  // History: whole commands that start with what's typed so far.
  const before = line.slice(0, cursor);
  const prefix = before.trimStart();
  src.history.forEach((h, i) => {
    if (h === prefix || !h.startsWith(prefix) || line.slice(cursor).trim()) return;
    if (!prefix && i >= 8) return;
    const key = `h:${h}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind: "history", label: h, line: h, caret: h.length, score: WEIGHT.history * (prefix ? 1 : 0.7) - i * 0.004 });
  });

  if (a.atCommand) {
    if (typed) {
      for (const c of [...BUILTINS, ...(src.commands ?? [])]) add("command", c, c, matchQuality(c, typed) >= 0.9 ? matchQuality(c, typed) : 0);
    }
  } else if (a.program) {
    const words = a.ctx.words.map((w) => w.value);
    const args = words.slice(commandStart(words) + 1);
    const st = walk(src.spec, args);
    if (st) {
      const eq = typed.indexOf("=");
      const pending = st.pendingOption ?? (typed.startsWith("-") && eq > 0 ? (findOption(st, typed.slice(0, eq)) ?? null) : null);
      if (pending && pending.args?.[0]?.suggestions) {
        const head = eq > 0 && typed.startsWith("-") ? typed.slice(0, eq + 1) : "";
        const val = head ? typed.slice(eq + 1) : typed;
        for (const s of pending.args[0].suggestions) add("value", s.name, head + s.name, matchQuality(s.name, val), { description: s.description });
      } else if (typed.startsWith("-") && !pending) {
        for (const o of [...(st.node.options ?? []), ...st.inherited]) {
          if (!o.repeatable && o.name.some((n) => st.used.has(n))) continue;
          // Show the long name when typing "--", the short one otherwise.
          const pick = (typed.startsWith("--") ? o.name.find((n) => n.startsWith("--")) : undefined) ?? o.name.find((n) => matchQuality(n, typed) >= 0.9) ?? o.name[0]!;
          const q = Math.max(...o.name.map((n) => matchQuality(n, typed)));
          const wantsValue = !!o.args?.length && pick.startsWith("--");
          add("option", o.name.join(", "), wantsValue && typed.includes("=") ? `${pick}=` : pick, q >= 0.9 || typed.length >= 3 ? q : 0, { description: o.description, final: true });
        }
      } else if (!pending) {
        for (const s of st.node.subcommands ?? []) {
          const q = Math.max(...s.name.map((n) => matchQuality(n, typed)));
          const pick = s.name.find((n) => matchQuality(n, typed) === q) ?? s.name[0]!;
          add("subcommand", pick, pick, typed ? q : 0.6, { description: s.description });
        }
        const arg = argAt(st.node, st.argIndex);
        for (const s of arg?.suggestions ?? []) add("value", s.name, s.name, matchQuality(s.name, typed), { description: s.description });
      }
    }
    if (a.wantsContainers) for (const c of src.containers) add("container", c, c, matchQuality(c, typed), { description: "Container" });
    if (a.wantsUnits) {
      for (const u of src.units) {
        const short = u.replace(/\.service$/, "");
        // "jelly" finds jellyfin.service; insert it as people type it, without ".service".
        add("unit", u, typed.endsWith(".service") || !u.endsWith(".service") ? u : short, Math.max(matchQuality(u, typed), matchQuality(short, typed)));
      }
    }
  }

  if (a.dir !== null && src.entries) {
    const base = typed.slice(a.dir.length);
    const folderOnly = !!a.program && FOLDER_ONLY.has(a.program) && !a.atCommand;
    for (const e of src.entries) {
      if (folderOnly && !e.dir) continue;
      if (e.name.startsWith(".") && !base.startsWith(".")) continue;
      add(e.dir ? "folder" : "file", e.dir ? `${e.name}/` : e.name, `${a.dir}${e.name}${e.dir ? "/" : ""}`, matchQuality(e.name, base), { final: !e.dir });
    }
  }

  out.sort((x, y) => y.score - x.score || x.label.length - y.label.length || x.label.localeCompare(y.label));
  return out.slice(0, limit);
}
