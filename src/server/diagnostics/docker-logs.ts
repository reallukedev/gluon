import "server-only";
import type Docker from "dockerode";
import { docker } from "../docker/client";

/**
 * Reading `docker logs` through the Docker API. Containers without a TTY send a multiplexed stream:
 * frames of [stream(1) 0 0 0 size(4, BE)] + payload. Containers with a TTY send raw bytes.
 */

export interface FoundContainer {
  id: string;
  name: string;
  tty: boolean;
  running: boolean;
  info: Docker.ContainerInspectInfo;
}

/** Find a container by exact name, falling back to a predicate over the list (e.g. image match). */
export async function findContainer(name: string, fallback?: (c: Docker.ContainerInfo) => boolean): Promise<FoundContainer | null> {
  const inspect = async (idOrName: string): Promise<FoundContainer | null> => {
    try {
      const info = await docker().getContainer(idOrName).inspect();
      return { id: info.Id, name: info.Name.replace(/^\//, ""), tty: !!info.Config.Tty, running: !!info.State.Running, info };
    } catch {
      return null;
    }
  };
  const direct = await inspect(name);
  if (direct) return direct;
  if (!fallback) return null;
  try {
    const list = await docker().listContainers({ all: true });
    const hit = list.find(fallback);
    return hit ? inspect(hit.Id) : null;
  } catch {
    return null;
  }
}

/** Streaming demultiplexer. Feed chunks; get back decoded text payloads in order. */
export class Demuxer {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly tty: boolean) {}

  push(chunk: Buffer): string {
    if (this.tty) return chunk.toString("utf8");
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let out = "";
    while (this.buf.length >= 8) {
      const type = this.buf[0]!;
      // Not a frame header after all (TTY container we misjudged): pass through raw.
      if (type > 2 || this.buf[1] !== 0 || this.buf[2] !== 0 || this.buf[3] !== 0) {
        out += this.buf.toString("utf8");
        this.buf = Buffer.alloc(0);
        break;
      }
      const size = this.buf.readUInt32BE(4);
      if (this.buf.length < 8 + size) break;
      out += this.buf.subarray(8, 8 + size).toString("utf8");
      this.buf = this.buf.subarray(8 + size);
    }
    return out;
  }
}

/** Last `tail` log lines of a container (stdout + stderr interleaved as Docker stored them). */
export async function containerLogLines(c: FoundContainer, opts: { tail?: number; timestamps?: boolean; since?: number } = {}): Promise<string[]> {
  const raw = (await docker()
    .getContainer(c.id)
    .logs({ stdout: true, stderr: true, follow: false, tail: opts.tail ?? 300, timestamps: opts.timestamps ?? false, since: opts.since ?? 0 })) as unknown as Buffer;
  const text = new Demuxer(c.tty).push(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
  return text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);
}

/**
 * Follow a container's logs line by line. Resolves once the stream is open; `onEnd` fires when it
 * closes (container stopped/restarted, Docker restarted). Returns a stop function.
 */
export async function followContainerLogs(
  c: FoundContainer,
  opts: { since?: number; tail?: number },
  onLine: (line: string) => void,
  onEnd: (err?: Error) => void,
): Promise<() => void> {
  const stream = (await docker()
    .getContainer(c.id)
    .logs({ stdout: true, stderr: true, follow: true, timestamps: false, ...(opts.since ? { since: opts.since } : {}), ...(opts.tail !== undefined ? { tail: opts.tail } : {}) })) as unknown as NodeJS.ReadableStream & { destroy?: () => void };
  const demux = new Demuxer(c.tty);
  let pending = "";
  let ended = false;
  const finish = (err?: Error) => {
    if (ended) return;
    ended = true;
    if (pending) onLine(pending);
    pending = "";
    onEnd(err);
  };
  stream.on("data", (chunk: Buffer) => {
    pending += demux.push(chunk);
    let i: number;
    while ((i = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, i).replace(/\r$/, "");
      pending = pending.slice(i + 1);
      if (line) onLine(line);
    }
    // Guard against a runaway line without newlines.
    if (pending.length > 256 * 1024) pending = "";
  });
  stream.on("end", () => finish());
  stream.on("close", () => finish());
  stream.on("error", (e: Error) => finish(e));
  return () => {
    ended = true;
    try {
      stream.destroy?.();
    } catch {
      /* ignore */
    }
  };
}
