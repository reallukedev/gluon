import "server-only";
import { docker } from "./client";

export interface LogLine {
  t: number;
  container: string;
  stream: "out" | "err";
  text: string;
  level: "error" | "warn" | "info" | "debug" | null;
}

const LEVEL: [RegExp, LogLine["level"]][] = [
  [/\b(fatal|panic|crit(ical)?|emerg|error|err|exception|traceback|failed)\b|level[=:]"?(error|fatal)/i, "error"],
  [/\b(warn(ing)?)\b|level[=:]"?warn/i, "warn"],
  [/\b(debug|trace)\b|level[=:]"?(debug|trace)/i, "debug"],
  [/\b(info|notice)\b|level[=:]"?info/i, "info"],
];

export function guessLevel(text: string, stream: "out" | "err"): LogLine["level"] {
  for (const [re, lvl] of LEVEL) if (re.test(text.slice(0, 300))) return lvl;
  return stream === "err" ? null : null;
}

/**
 * Docker's multiplexed log stream (non-TTY containers): 8-byte headers [stream, 0,0,0, size(4)].
 * TTY containers send raw bytes. Returns a function you push chunks into.
 */
function demuxer(tty: boolean, onLine: (stream: "out" | "err", raw: string) => void) {
  let buf = Buffer.alloc(0);
  const partial = { out: "", err: "" };
  const emitText = (stream: "out" | "err", text: string) => {
    const joined = partial[stream] + text;
    const parts = joined.split("\n");
    partial[stream] = parts.pop() ?? "";
    for (const p of parts) onLine(stream, p.replace(/\r$/, ""));
  };
  return {
    push(chunk: Buffer) {
      if (tty) return emitText("out", chunk.toString("utf8"));
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const size = buf.readUInt32BE(4);
        if (buf.length < 8 + size) break;
        const stream = buf[0] === 2 ? "err" : "out";
        emitText(stream, buf.subarray(8, 8 + size).toString("utf8"));
        buf = buf.subarray(8 + size);
      }
    },
    flush() {
      for (const s of ["out", "err"] as const) if (partial[s]) onLine(s, partial[s]);
    },
  };
}

function parseLine(container: string, stream: "out" | "err", raw: string): LogLine {
  // With timestamps: true, each line starts with an RFC3339Nano timestamp and a space.
  const sp = raw.indexOf(" ");
  const ts = sp > 0 ? Date.parse(raw.slice(0, sp)) : NaN;
  const text = Number.isFinite(ts) ? raw.slice(sp + 1) : raw;
  return { t: Number.isFinite(ts) ? ts : Date.now(), container, stream, text, level: guessLevel(text, stream) };
}

/** Recent lines for one container (non-following). */
export async function tailLogs(containerId: string, name: string, opts: { tail?: number; since?: number } = {}): Promise<LogLine[]> {
  const c = docker().getContainer(containerId);
  const info = await c.inspect();
  const buf = (await c.logs({
    stdout: true,
    stderr: true,
    timestamps: true,
    tail: opts.tail ?? 500,
    since: opts.since ? Math.floor(opts.since / 1000) : 0,
    follow: false,
  })) as unknown as Buffer;
  const out: LogLine[] = [];
  const d = demuxer(!!info.Config.Tty, (stream, raw) => out.push(parseLine(name, stream, raw)));
  d.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)));
  d.flush();
  return out;
}

/** Follow logs; returns a stop function. */
export async function followLogs(containerId: string, name: string, onLine: (l: LogLine) => void, opts: { since?: number } = {}): Promise<() => void> {
  const c = docker().getContainer(containerId);
  const info = await c.inspect();
  const stream = (await c.logs({
    stdout: true,
    stderr: true,
    timestamps: true,
    follow: true,
    tail: 0,
    since: opts.since ? Math.floor(opts.since / 1000) : Math.floor(Date.now() / 1000),
  })) as unknown as NodeJS.ReadableStream & { destroy?: () => void };
  const d = demuxer(!!info.Config.Tty, (s, raw) => onLine(parseLine(name, s, raw)));
  stream.on("data", (chunk: Buffer) => d.push(chunk));
  stream.on("end", () => d.flush());
  return () => {
    try {
      stream.destroy?.();
    } catch {
      /* closed */
    }
  };
}
