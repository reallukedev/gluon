/**
 * Gluon's wrapper around every command prints two private escape sequences (OSC 7771 with the
 * shell's process id, OSC 7770 with the exit code and folder at the end), tagged with a nonce so a
 * program can't fake them. This filter takes them out of the output, even when they arrive split
 * across chunks.
 */

export type Marker = { kind: "pid"; pid: number } | { kind: "done"; code: number; cwd: string };

const HEAD = "\x1b]777";
const MAX_PENDING = 8192;

export class MarkerFilter {
  private pending = "";
  constructor(private readonly nonce: string) {}

  push(chunk: string): { text: string; markers: Marker[] } {
    let buf = this.pending + chunk;
    this.pending = "";
    const markers: Marker[] = [];
    let out = "";
    for (;;) {
      const at = buf.indexOf(HEAD);
      if (at < 0) break;
      const bell = buf.indexOf("\x07", at);
      if (bell < 0) {
        if (buf.length - at > MAX_PENDING) break; // not ours after all; let it through
        out += buf.slice(0, at);
        this.pending = buf.slice(at);
        return { text: out, markers };
      }
      const body = buf.slice(at + 2, bell); // "7771;nonce;pid"
      const m = this.parse(body);
      if (m) {
        markers.push(m);
        out += buf.slice(0, at);
      } else {
        out += buf.slice(0, bell + 1);
      }
      buf = buf.slice(bell + 1);
    }
    // Hold back a tail that could be the start of a marker.
    let keep = 0;
    for (let n = Math.min(HEAD.length, buf.length); n > 0; n--) {
      if (HEAD.startsWith(buf.slice(buf.length - n))) {
        keep = n;
        break;
      }
    }
    this.pending = buf.slice(buf.length - keep);
    out += buf.slice(0, buf.length - keep);
    return { text: out, markers };
  }

  /** Whatever was held back, once the stream has ended. */
  flush(): string {
    const p = this.pending;
    this.pending = "";
    return p;
  }

  private parse(body: string): Marker | null {
    const parts = body.split(";");
    if (parts[1] !== this.nonce) return null;
    if (parts[0] === "7771" && parts.length === 3 && /^\d+$/.test(parts[2]!)) return { kind: "pid", pid: Number(parts[2]) };
    if (parts[0] === "7770" && parts.length >= 4 && /^\d+$/.test(parts[2]!)) return { kind: "done", code: Number(parts[2]), cwd: parts.slice(3).join(";") };
    return null;
  }
}
