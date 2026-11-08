import "server-only";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * `host()` runs a program inside the host's namespaces via nsenter, so it sees the real filesystem,
 * systemd and docker compose as an SSH session would. `local()` runs one shipped in the image. Always
 * an argument array, never a shell string.
 */

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly cmd: string,
    public readonly code: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

export interface RunOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  input?: string;
  env?: Record<string, string>;
  /** Treat these exit codes as success (e.g. grep's 1). */
  okCodes?: number[];
  cwd?: string;
}

const NSENTER = ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--"];
const NO_NSENTER = (process.env.GLUON_NO_NSENTER ?? process.env.TEND_NO_NSENTER) === "1";
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
// Without nsenter (development on a laptop) "the host" is this machine, so keep its own PATH and
// Docker settings; in the container the host's environment is never inherited.
const HOST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: process.env.NODE_ENV,
  PATH: NO_NSENTER && process.env.PATH ? `${SYSTEM_PATH}:${process.env.PATH}` : SYSTEM_PATH,
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  ...(NO_NSENTER ? Object.fromEntries(["DOCKER_HOST", "DOCKER_CONFIG", "HOME"].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))) : {}),
};

const MAX_STDERR = 1024 * 1024;

/**
 * Each command runs in its own process group so a timeout kills everything it started: nsenter
 * forks the real program, and a SIGKILL sent only to nsenter would leave that child running.
 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/** Make `child.kill()` signal the whole group while the leader is still alive. */
function groupKillable(child: ChildProcess): ChildProcess {
  const own = child.kill.bind(child);
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, signal ?? "SIGTERM");
        return true;
      } catch {
        // Fall back to the leader alone.
      }
    }
    return own(signal);
  }) as ChildProcess["kill"];
  return child;
}

function runFile(file: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const label = [file, ...args].join(" ").slice(0, 300);
  const maxBuffer = opts.maxBuffer ?? 16 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        env: { ...HOST_ENV, ...opts.env } as NodeJS.ProcessEnv,
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (e) {
      return reject(new CommandError(e instanceof Error ? e.message : String(e), label, null, "", ""));
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGKILL");
    }, timeoutMs);
    child.stdout!.on("data", (d: Buffer) => {
      outLen += d.length;
      if (outLen > maxBuffer) {
        if (!overflow) {
          overflow = true;
          killGroup(child, "SIGKILL");
        }
        return;
      }
      out.push(d);
    });
    child.stderr!.on("data", (d: Buffer) => {
      // Keep only the head of a runaway stderr; the message uses its last lines anyway.
      if (errLen < MAX_STDERR) err.push(d);
      errLen += d.length;
    });
    // A program that exits before reading its input makes the write fail with EPIPE.
    child.stdin!.on("error", () => {});
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnErr?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (spawnErr) return reject(new CommandError(spawnErr.message, label, null, stdout, stderr));
      if (timedOut) return reject(new CommandError(`Timed out: ${label}`, label, null, stdout, stderr));
      if (overflow) return reject(new CommandError(`Output too large: ${label}`, label, null, stdout, stderr));
      if (code === 0) return resolve({ stdout, stderr });
      if (code !== null && opts.okCodes?.includes(code)) return resolve({ stdout, stderr });
      const msg = stderr.trim().split("\n").slice(-3).join(" ") || (signal ? `Killed by ${signal}: ${label}` : `Exited with code ${code}: ${label}`);
      reject(new CommandError(msg, label, code, stdout, stderr));
    };
    child.on("error", (e) => finish(null, null, e));
    child.on("close", (code, signal) => finish(code, signal));
    // A daemon the command left behind can hold the pipes open; don't wait on it forever.
    child.on("exit", (code, signal) => {
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, 5000).unref?.();
    });
  });
}

export function host(cmd: string, args: string[] = [], opts?: RunOptions) {
  if (NO_NSENTER) return runFile(cmd, args, opts);
  return runFile("nsenter", [...NSENTER, cmd, ...args], opts);
}

export function local(cmd: string, args: string[] = [], opts?: RunOptions) {
  return runFile(cmd, args, opts);
}

/** Spawn a long-running host process (log follow, apt upgrade…) for streaming. */
export function hostSpawn(cmd: string, args: string[] = [], env?: Record<string, string>): ChildProcess {
  const full = NO_NSENTER ? [cmd, ...args] : ["nsenter", ...NSENTER, cmd, ...args];
  return groupKillable(
    spawn(full[0]!, full.slice(1), {
      env: { ...HOST_ENV, ...env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }),
  );
}

export function localSpawn(cmd: string, args: string[] = []): ChildProcess {
  return groupKillable(spawn(cmd, args, { env: { ...HOST_ENV }, stdio: ["ignore", "pipe", "pipe"], detached: true }));
}

/** Split a stream into lines, calling back per line. Returns a flush function. */
export function lineReader(onLine: (line: string) => void) {
  let buf = "";
  return {
    push(chunk: Buffer | string) {
      buf += chunk.toString();
      let start = 0;
      let i: number;
      while ((i = buf.indexOf("\n", start)) >= 0) {
        onLine(buf.slice(start, i).replace(/\r$/, ""));
        start = i + 1;
      }
      if (start) buf = buf.slice(start);
    },
    flush() {
      if (buf) onLine(buf);
      buf = "";
    },
  };
}
