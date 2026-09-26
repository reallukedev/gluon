import "server-only";
import { execFile, spawn, type ChildProcess } from "node:child_process";

/**
 * Host command execution.
 *
 * Gluon runs in a privileged container with the host PID namespace. `host()` runs a program
 * inside the host's mount/UTS/IPC/network/PID namespaces via nsenter, so it sees the real
 * filesystem, systemd and docker compose exactly as an SSH session would. `local()` runs a
 * program shipped in the container image (smartctl, lsblk…).
 *
 * Always an argument array. Never a shell string.
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
const HOST_ENV: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV, PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };

function runFile(file: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const label = [file, ...args].join(" ").slice(0, 300);
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        env: { ...HOST_ENV, ...opts.env } as NodeJS.ProcessEnv,
        cwd: opts.cwd,
        encoding: "utf8",
        killSignal: "SIGKILL",
      },
      (err: (Error & { code?: number | string; killed?: boolean }) | null, stdout: string, stderr: string) => {
        if (err) {
          const code = typeof err.code === "number" ? err.code : null;
          if (code !== null && opts.okCodes?.includes(code)) return resolve({ stdout, stderr });
          const timedOut = (err as { killed?: boolean }).killed && !code;
          const msg = timedOut ? `Timed out: ${label}` : stderr.trim().split("\n").slice(-3).join(" ") || err.message;
          return reject(new CommandError(msg, label, code, stdout, stderr));
        }
        resolve({ stdout, stderr });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** Run a program on the host (inside the host namespaces). */
export function host(cmd: string, args: string[] = [], opts?: RunOptions) {
  if ((process.env.GLUON_NO_NSENTER ?? process.env.TEND_NO_NSENTER) === "1") return runFile(cmd, args, opts);
  return runFile("nsenter", [...NSENTER, cmd, ...args], opts);
}

/** Run a program from the container image. */
export function local(cmd: string, args: string[] = [], opts?: RunOptions) {
  return runFile(cmd, args, opts);
}

/** Spawn a long-running host process (log follow, apt upgrade…) for streaming. */
export function hostSpawn(cmd: string, args: string[] = [], env?: Record<string, string>): ChildProcess {
  const full = (process.env.GLUON_NO_NSENTER ?? process.env.TEND_NO_NSENTER) === "1" ? [cmd, ...args] : ["nsenter", ...NSENTER, cmd, ...args];
  return spawn(full[0]!, full.slice(1), {
    env: { ...HOST_ENV, ...env } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function localSpawn(cmd: string, args: string[] = []): ChildProcess {
  return spawn(cmd, args, { env: { ...HOST_ENV }, stdio: ["ignore", "pipe", "pipe"] });
}

/** Split a stream into lines, calling back per line. Returns a flush function. */
export function lineReader(onLine: (line: string) => void) {
  let buf = "";
  return {
    push(chunk: Buffer | string) {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ""));
        buf = buf.slice(i + 1);
      }
    },
    flush() {
      if (buf) onLine(buf);
      buf = "";
    },
  };
}
