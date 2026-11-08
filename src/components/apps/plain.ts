import type { LineState } from "@/lib/types";

interface Stateful {
  line: LineState;
  summary: string;
  containers: { state?: string; line: LineState }[];
  copyOf?: unknown;
  umbrel?: { state: string } | null;
}

export const parts = (n: number) => (n === 1 ? "1 part" : `${n} parts`);

/** Docker's words (unhealthy, restarting, containers) stay on the detail page and in tooltips. */
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

export function stateWord(a: Stateful): string {
  return trouble(a) ?? a.summary;
}
