import type { LineState } from "@/lib/types";

/** Just enough of an app to say what state it's in. */
interface Stateful {
  line: LineState;
  summary: string;
  containers: { state?: string; line: LineState }[];
  copyOf?: unknown;
  umbrel?: { state: string } | null;
}

/** "part" or "parts": a container, in words a household member would use. */
export const parts = (n: number) => (n === 1 ? "1 part" : `${n} parts`);

/**
 * What's wrong with an app, in plain words, or null when nothing is. Docker's words (unhealthy,
 * restarting, containers) stay on the detail page and in tooltips.
 */
export function trouble(a: Stateful): string | null {
  if (a.line !== "unhealthy" || a.copyOf) return null;
  const n = a.containers.length;
  const bad = a.containers.filter((c) => c.line === "unhealthy" || c.line === "stopped");
  if (!n || !bad.length) return a.summary;
  const restarting = bad.filter((c) => c.state === "restarting").length;
  const stopped = bad.filter((c) => c.line === "stopped").length;
  if (n === 1) return restarting ? "Keeps restarting" : stopped ? "Stopped by itself" : "Not responding";
  if (restarting === n) return "Keeps restarting";
  if (bad.length === n) return "Not responding";
  const what = restarting ? "keeps restarting" : stopped === bad.length ? "stopped" : "isn't responding";
  return bad.length === 1 ? `1 of ${parts(n)} ${what}` : `${bad.length} of ${n} parts ${restarting ? "keep restarting" : stopped === bad.length ? "stopped" : "aren't responding"}`;
}

/** The state word for a row or a header: the plain trouble when there is some, otherwise the server's word. */
export function stateWord(a: Stateful): string {
  return trouble(a) ?? a.summary;
}
