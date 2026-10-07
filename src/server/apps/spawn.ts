import "server-only";
import { hostSpawn, lineReader } from "../host/exec";

export interface SpawnLimits {
  /** Killed after this long, whatever it's doing. */
  timeoutMs: number;
  /** Killed when this aborts (the request went away). */
  signal?: AbortSignal;
}

export interface SpawnResult {
  code: number;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * A host command with its output streamed line by line, stopped on a timer or when the request
 * goes away: SIGTERM first, SIGKILL if it hasn't gone 10 seconds later. Never a shell string.
 */
export function spawnLines(cmd: string, args: string[], onLine: (line: string, stream: "out" | "err") => void, limits: SpawnLimits): Promise<SpawnResult> {
  return new Promise((resolve) => {
    if (limits.signal?.aborted) return resolve({ code: 1, timedOut: false, aborted: true });
    const child = hostSpawn(cmd, args);
    const out = lineReader((l) => onLine(l, "out"));
    const err = lineReader((l) => onLine(l, "err"));
    let timedOut = false;
    let aborted = false;
    let hard: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      hard = setTimeout(() => child.kill("SIGKILL"), 10_000);
      hard.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, limits.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    limits.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d) => out.push(d));
    child.stderr?.on("data", (d) => err.push(d));
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(hard);
      limits.signal?.removeEventListener("abort", onAbort);
      out.flush();
      err.flush();
      resolve({ code, timedOut, aborted });
    };
    child.on("close", (code) => finish(code ?? 1));
    child.on("error", () => finish(1));
  });
}
