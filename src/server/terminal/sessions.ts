import "server-only";
import crypto from "node:crypto";
import os from "node:os";
import { AppError } from "../errors";
import { audit } from "../audit";
import type { User } from "../auth/users";
import type { Zone } from "../net-zone";
import { MarkerFilter } from "@/lib/terminal/markers";
import { looksSecret } from "@/lib/terminal/redact";
import type { ExitReason, TermEvent } from "@/lib/terminal/types";
import { HOST_PATH, startProc, type Proc } from "./proc";
import { probeTarget, type Resolved } from "./targets";

/**
 * Running commands and terminal sessions, held in memory (on globalThis so dev reloads keep them).
 * Each one belongs to the admin who opened it, streams to the request that opened it, and is
 * killed when that stream closes, when it's stopped, or when it sits idle too long.
 */

export type Mode = "run" | "shell";

interface Session {
  id: string;
  userId: string;
  mode: Mode;
  target: Resolved;
  proc: Proc;
  pid: number | null;
  startedAt: number;
  lastActive: number;
  timer: ReturnType<typeof setInterval>;
  close: (reason: ExitReason) => void;
}

type G = typeof globalThis & { __gluonTerminals?: Map<string, Session> };
const g = globalThis as G;
const sessions = (g.__gluonTerminals ??= new Map());

const MAX_PER_USER = 8;
const MAX_OUTPUT = 1024 * 1024;
const RUN_IDLE_MS = 30 * 60_000;
const RUN_MAX_MS = 3 * 60 * 60_000;
const SHELL_IDLE_MS = 60 * 60_000;
const SHELL_MAX_MS = 12 * 60 * 60_000;

/**
 * Commands mode: start in the folder we were in, say our pid, run the command with `eval` (so `cd`
 * and variables behave as typed), then report the exit code and the folder we ended up in.
 * The command arrives as an argument, never pasted into the script.
 */
const RUN_SCRIPT = `__g_n=$1; __g_c=$3
cd -- "$2" 2>/dev/null || cd 2>/dev/null
printf '\\033]7771;%s;%s\\007' "$__g_n" "$$"
shift 3
eval "$__g_c"
__g_rc=$?
printf '\\033]7770;%s;%s;%s\\007' "$__g_n" "$__g_rc" "$(pwd)"
exit $__g_rc`;

/** Terminal mode: say our pid, go to the folder, become a login shell. */
const SHELL_SCRIPT = `printf '\\033]7771;%s;%s\\007' "$1" "$$"; cd -- "$2" 2>/dev/null; exec "$3" -l`;

/** Commands mode has no pager to scroll: programs print everything instead of waiting in less. */
const RUN_ENV = { PAGER: "cat", GIT_PAGER: "cat", MANPAGER: "cat", SYSTEMD_PAGER: "", SYSTEMD_COLORS: "1", DEBIAN_FRONTEND: "readline" };

export interface OpenInput {
  user: User;
  ip: string;
  zone: Zone;
  mode: Mode;
  target: Resolved;
  command?: string;
  cwd?: string | null;
  rows: number;
  cols: number;
}

export function countFor(userId: string) {
  let n = 0;
  for (const s of sessions.values()) if (s.userId === userId) n++;
  return n;
}

/** What the audit log keeps of a command: the text, unless it looked like it carried a secret. */
function auditCommand(command: string): string {
  if (looksSecret(command)) return `${command.trim().split(/\s+/)[0]} … (hidden: it looked like it had a password or token in it)`;
  return command.length > 500 ? `${command.slice(0, 500)}…` : command;
}

/**
 * Start a command or a shell and stream it. Everything that can fail with a message (no shell, too
 * many open) fails before the stream starts, so it comes back as an ordinary error.
 */
export async function open(o: OpenInput): Promise<{ id: string; stream: (emit: (e: TermEvent) => void, signal: AbortSignal) => Promise<void> }> {
  if (countFor(o.user.id) >= MAX_PER_USER) {
    throw new AppError("too_many", `You have ${MAX_PER_USER} commands and terminals open already. Stop one or close a tab first.`, 429);
  }
  const probe = await probeTarget(o.target);
  const id = crypto.randomBytes(12).toString("base64url");
  const nonce = crypto.randomBytes(9).toString("hex");
  const cwd = o.cwd && o.cwd.startsWith("/") && o.cwd.length < 1024 && !o.cwd.includes("\0") ? o.cwd : probe.cwd;
  const local = o.target.place.kind === "local";
  const env: Record<string, string> = { TERM: "xterm-256color", COLORTERM: "truecolor" };
  if (o.target.host) {
    Object.assign(env, local ? { HOME: os.homedir(), PATH: process.env.PATH ?? HOST_PATH, SHELL: probe.shell } : { HOME: "/root", USER: "root", LOGNAME: "root", PATH: HOST_PATH, SHELL: probe.shell, LANG: "C.UTF-8" });
  }
  if (o.mode === "run") Object.assign(env, RUN_ENV);
  const argv = o.mode === "run" ? [probe.shell, "-c", RUN_SCRIPT, "gluon", nonce, cwd, o.command ?? ""] : [probe.shell, "-c", SHELL_SCRIPT, "gluon", nonce, cwd, probe.shell];
  const proc = await startProc(o.target.place, { argv, env, rows: o.rows, cols: o.cols });

  const filter = new MarkerFilter(nonce);
  const started = Date.now();
  let emit: ((e: TermEvent) => void) | null = null;
  let buffered = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let sent = 0;
  let truncated = false;
  let doneMarker: { code: number; cwd: string } | null = null;
  let reason: ExitReason = "done";
  let finished = false;
  let resolveEnd: () => void = () => undefined;
  const ended = new Promise<void>((r) => (resolveEnd = r));

  const flush = () => {
    flushTimer = null;
    if (!buffered || !emit) return;
    const data = buffered;
    buffered = "";
    emit({ type: "out", data });
  };
  const push = (text: string) => {
    if (!text) return;
    if (o.mode === "run") {
      if (truncated) return;
      if (sent + text.length > MAX_OUTPUT) {
        text = text.slice(0, Math.max(0, MAX_OUTPUT - sent));
        truncated = true;
      }
      sent += text.length;
    }
    buffered += text;
    if (buffered.length > 64 * 1024) flush();
    else flushTimer ??= setTimeout(flush, 16);
  };

  const session: Session = {
    id,
    userId: o.user.id,
    mode: o.mode,
    target: o.target,
    proc,
    pid: null,
    startedAt: started,
    lastActive: started,
    timer: setInterval(() => {
      const now = Date.now();
      const idle = o.mode === "run" ? RUN_IDLE_MS : SHELL_IDLE_MS;
      const max = o.mode === "run" ? RUN_MAX_MS : SHELL_MAX_MS;
      if (now - session.lastActive > idle) void stop(session, "idle");
      else if (now - started > max) void stop(session, "timeout");
    }, 30_000),
    close: (r) => {
      reason = r;
    },
  };
  sessions.set(id, session);

  proc.onData((raw) => {
    const { text, markers } = filter.push(raw);
    for (const m of markers) {
      if (m.kind === "pid") session.pid = m.pid;
      else doneMarker = { code: m.code, cwd: m.cwd };
    }
    if (o.mode === "run") session.lastActive = Date.now();
    push(text);
  });

  proc.onExit((code) => {
    if (finished) return;
    finished = true;
    push(filter.flush());
    if (flushTimer) clearTimeout(flushTimer);
    flush();
    clearInterval(session.timer);
    sessions.delete(id);
    const ms = Date.now() - started;
    const exitCode = doneMarker?.code ?? code;
    emit?.({ type: "exit", code: exitCode, cwd: doneMarker?.cwd ?? null, ms, truncated, reason });
    const where = o.target.host ? "on the server" : `in ${o.target.label}`;
    if (o.mode === "run") {
      const how = reason === "stopped" ? " (stopped)" : reason === "closed" ? " (stopped when the page closed)" : reason === "idle" || reason === "timeout" ? " (stopped at the time limit)" : exitCode ? ` (exit code ${exitCode})` : "";
      audit(
        o.user,
        {
          action: "terminal.run",
          target: o.target.auditTarget,
          summary: `Ran a command ${where}${how}`,
          detail: { target: o.target.target, command: auditCommand(o.command ?? ""), exitCode, seconds: Math.round(ms / 1000), ended: reason },
          outcome: exitCode === 0 && reason === "done" ? "ok" : "failed",
        },
        { ip: o.ip, zone: o.zone },
      );
    } else {
      audit(
        o.user,
        { action: "terminal.session", target: o.target.auditTarget, summary: `Closed a terminal ${where} after ${minutes(ms)}`, detail: { target: o.target.target, event: "close", seconds: Math.round(ms / 1000), ended: reason } },
        { ip: o.ip, zone: o.zone },
      );
    }
    proc.destroy();
    resolveEnd();
  });

  if (o.mode === "shell") {
    audit(o.user, { action: "terminal.session", target: o.target.auditTarget, summary: `Opened a terminal ${o.target.host ? "on the server" : `in ${o.target.label}`}`, detail: { target: o.target.target, event: "open", shell: probe.shell } }, { ip: o.ip, zone: o.zone });
  }

  return {
    id,
    stream: async (e, signal) => {
      emit = e;
      e({ type: "open", id, shell: probe.shell, cwd });
      flush();
      const onAbort = () => void stop(session, "closed");
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      await ended;
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "less than a minute";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? "" : "s"}${m % 60 ? ` ${m % 60} min` : ""}`;
}

export function get(id: string, userId: string): Session {
  const s = sessions.get(id);
  if (!s || s.userId !== userId) throw new AppError("gone", "That command has finished or the terminal was closed.", 410);
  return s;
}

export function input(s: Session, data: string) {
  s.lastActive = Date.now();
  s.proc.write(data);
}

export function resize(s: Session, rows: number, cols: number) {
  s.proc.resize(rows, cols);
}

/**
 * Stop it: Ctrl-C first (what a person would press), then hang up and terminate the whole process
 * group, then kill it. Resolves once it's gone or we've given up waiting.
 */
export async function stop(s: Session, reason: ExitReason) {
  if (!sessions.has(s.id)) return;
  s.close(reason);
  const gone = () => !sessions.has(s.id);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  if (reason === "stopped") {
    s.proc.write("\x03");
    for (let i = 0; i < 15 && !gone(); i++) await wait(100);
    if (gone()) return;
  }
  if (s.pid) {
    await s.proc.signal(s.pid, "HUP");
    await s.proc.signal(s.pid, "TERM");
    for (let i = 0; i < 20 && !gone(); i++) await wait(100);
    if (!gone()) await s.proc.signal(s.pid, "KILL");
    for (let i = 0; i < 10 && !gone(); i++) await wait(100);
  }
  // Still here (it never said its pid, or the connection is stuck): let go of it.
  if (!gone()) s.proc.destroy();
}
