import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { Duplex, Writable } from "node:stream";
import { docker } from "../docker/client";
import { dockerError } from "../dockerx/core";
import { host } from "../host/exec";

/**
 * A program running with a terminal (a PTY), wherever it runs: inside a container (Docker gives it
 * the PTY), on the server through Gluon's own container (the same, entering the host with nsenter),
 * or, when Gluon runs outside Docker in development, locally through a small Python PTY helper.
 */
export interface Proc {
  write(data: string): void;
  resize(rows: number, cols: number): void;
  onData(cb: (text: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  /** Send a signal to the process group led by `pid` (from the wrapper's marker), where it runs. */
  signal(pid: number, sig: "INT" | "TERM" | "HUP" | "KILL"): Promise<void>;
  /** Let go of the connection. */
  destroy(): void;
}

export type Place = { kind: "container"; id: string } | { kind: "self"; id: string } | { kind: "local" };

export const NSENTER = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--"];
export const HOST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Signals a process group, falling back to the single process; fixed script, numbers as arguments. */
const KILL_SCRIPT = `kill -s "$1" -- "-$2" 2>/dev/null || kill -s "$1" "-$2" 2>/dev/null; kill -s "$1" "$2" 2>/dev/null; true`;

export interface StartOptions {
  argv: string[];
  env: Record<string, string>;
  rows: number;
  cols: number;
}

class Emitter {
  private dataCbs: ((t: string) => void)[] = [];
  private exitCbs: ((c: number | null) => void)[] = [];
  private exited = false;
  onData(cb: (t: string) => void) {
    this.dataCbs.push(cb);
  }
  onExit(cb: (c: number | null) => void) {
    this.exitCbs.push(cb);
  }
  data(t: string) {
    if (t) for (const cb of this.dataCbs) cb(t);
  }
  exit(code: number | null) {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitCbs) cb(code);
  }
}

// ---------------------------------------------------------------- Docker exec (containers and the host)

async function dockerProc(containerId: string, o: StartOptions, signalPlace: Place): Promise<Proc> {
  const ctr = docker().getContainer(containerId);
  let exec: Awaited<ReturnType<typeof ctr.exec>>;
  let stream: Duplex;
  try {
    exec = await ctr.exec({
      Cmd: o.argv,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: Object.entries(o.env).map(([k, v]) => `${k}=${v}`),
      ConsoleSize: [o.rows, o.cols],
    } as Parameters<typeof ctr.exec>[0]);
    stream = (await exec.start({ hijack: true, stdin: true, Tty: true } as Parameters<typeof exec.start>[0])) as unknown as Duplex;
  } catch (e) {
    throw dockerError(e, "Couldn't start the shell");
  }
  const em = new Emitter();
  const dec = new StringDecoder("utf8");
  stream.on("data", (b: Buffer) => em.data(dec.write(b)));
  let ended = false;
  const finish = async () => {
    if (ended) return;
    ended = true;
    em.data(dec.end());
    let code: number | null = null;
    // Docker can take a moment to record the exit code after the stream ends.
    for (let i = 0; i < 5; i++) {
      try {
        const st = await exec.inspect();
        if (!st.Running) {
          code = st.ExitCode ?? null;
          break;
        }
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    em.exit(code);
  };
  stream.on("end", () => void finish());
  stream.on("close", () => void finish());
  stream.on("error", () => void finish());
  return {
    write: (d) => {
      if (!ended) stream.write(d);
    },
    resize: (rows, cols) => {
      if (!ended) exec.resize({ h: rows, w: cols }).catch(() => undefined);
    },
    onData: (cb) => em.onData(cb),
    onExit: (cb) => em.onExit(cb),
    signal: (pid, sig) => signalIn(signalPlace, pid, sig),
    destroy: () => {
      stream.destroy();
      void finish();
    },
  };
}

/** Run a short command without a terminal inside a container and collect what it prints. */
export async function captureInContainer(id: string, argv: string[], opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<{ stdout: string; code: number | null }> {
  const ctr = docker().getContainer(id);
  let exec: Awaited<ReturnType<typeof ctr.exec>>;
  let stream: NodeJS.ReadableStream;
  try {
    exec = await ctr.exec({ Cmd: argv, AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false });
    stream = (await exec.start({ hijack: true, stdin: false })) as NodeJS.ReadableStream;
  } catch (e) {
    throw dockerError(e, "Couldn't ask the container");
  }
  const max = opts.maxBytes ?? 2 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  const out = {
    write(b: Buffer) {
      if (size < max) {
        chunks.push(b);
        size += b.length;
      }
      return true;
    },
  };
  const sink = { write: () => true };
  docker().modem.demuxStream(stream, out as unknown as Writable, sink as unknown as Writable);
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      (stream as unknown as Duplex).destroy?.();
      resolve();
    }, opts.timeoutMs ?? 8000);
    const done = () => {
      clearTimeout(t);
      resolve();
    };
    stream.on("end", done);
    stream.on("close", done);
    stream.on("error", done);
  });
  let code: number | null = null;
  try {
    const st = await exec.inspect();
    code = st.Running ? null : (st.ExitCode ?? null);
  } catch {
    /* gone */
  }
  return { stdout: Buffer.concat(chunks).toString("utf8"), code };
}

async function signalIn(place: Place, pid: number, sig: string): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const args = ["sh", "-c", KILL_SCRIPT, "gluon", sig, String(pid)];
  try {
    if (place.kind === "container") await captureInContainer(place.id, args, { timeoutMs: 4000 });
    else if (place.kind === "self") await host(args[0]!, args.slice(1), { timeoutMs: 4000 });
    else {
      try {
        process.kill(-pid, sig === "INT" ? "SIGINT" : sig === "TERM" ? "SIGTERM" : sig === "HUP" ? "SIGHUP" : "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* it may be gone already */
  }
}

// ---------------------------------------------------------------- local PTY (development, outside Docker)

/**
 * Node has no PTY of its own and the dev machine isn't in Docker, so a few lines of Python make one:
 * fd 0/1 carry the terminal, fd 3 takes "rows cols" lines to resize it.
 */
const PY_PTY = String.raw`
import os, pty, sys, select, signal, struct, fcntl, termios
rows, cols = int(sys.argv[1]), int(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[3], sys.argv[3:])
def size(r, c):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
    try: os.killpg(os.getpgid(pid), signal.SIGWINCH)
    except Exception: pass
size(rows, cols)
buf = b""
fds = [0, fd, 3]
while True:
    try: r, _, _ = select.select(fds, [], [])
    except InterruptedError: continue
    if fd in r:
        try: data = os.read(fd, 65536)
        except OSError: data = b""
        if not data: break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data:
            fds.remove(0)
            try: os.kill(pid, signal.SIGHUP)
            except Exception: pass
        else: os.write(fd, data)
    if 3 in r:
        data = os.read(3, 4096)
        if not data: fds.remove(3)
        buf += data
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            p = line.split()
            if len(p) == 2: size(int(p[0]), int(p[1]))
_, st = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(st))
`;

function localProc(o: StartOptions): Proc {
  const child: ChildProcess = spawn("python3", ["-c", PY_PTY, String(o.rows), String(o.cols), ...o.argv], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? HOST_PATH, HOME: os.homedir(), USER: os.userInfo().username, LANG: "en_US.UTF-8", ...o.env } as unknown as NodeJS.ProcessEnv,
    cwd: os.homedir(),
  });
  const em = new Emitter();
  const dec = new StringDecoder("utf8");
  child.stdout!.on("data", (b: Buffer) => em.data(dec.write(b)));
  child.stderr!.on("data", (b: Buffer) => em.data(dec.write(b)));
  child.on("error", () => em.exit(null));
  child.on("exit", (code) => {
    em.data(dec.end());
    em.exit(code);
  });
  const ctl = child.stdio[3] as Writable;
  return {
    write: (d) => {
      if (child.exitCode === null) child.stdin!.write(d);
    },
    resize: (rows, cols) => {
      if (child.exitCode === null) ctl.write(`${rows} ${cols}\n`);
    },
    onData: (cb) => em.onData(cb),
    onExit: (cb) => em.onExit(cb),
    signal: (pid, sig) => signalIn({ kind: "local" }, pid, sig),
    destroy: () => {
      if (child.exitCode === null) child.kill("SIGHUP");
    },
  };
}

export function startProc(place: Place, o: StartOptions): Promise<Proc> {
  if (place.kind === "local") return Promise.resolve(localProc(o));
  if (place.kind === "container") return dockerProc(place.id, o, place);
  // The host: a terminal from Docker in Gluon's own container, entering the host's namespaces.
  return dockerProc(place.id, { ...o, argv: [...NSENTER, "env", "-i", ...Object.entries(o.env).map(([k, v]) => `${k}=${v}`), ...o.argv] }, place);
}
