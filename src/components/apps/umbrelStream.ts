import { reduceStream, type StreamEvent, type StreamState } from "@/components/ui/StreamLog";
import type { AppSummary } from "@/server/docker/apps";

type UmbrelState = NonNullable<AppSummary["umbrel"]>["state"];

export function umbrelBusy(state: UmbrelState | undefined | null): state is "installing" | "updating" | "uninstalling" {
  return state === "installing" || state === "updating" || state === "uninstalling";
}

const PCT = /^(.*?)\s*·\s*(\d{1,3})%$/;

/** One line per state, not one for every percent. */
export function reduceUmbrelStream(st: StreamState, e: StreamEvent): StreamState {
  if (e.type === "done" || e.type === "error") return { ...reduceStream(st, e), progress: null };
  if (e.type !== "line") return reduceStream(st, e);
  const m = PCT.exec(e.text);
  const word = m?.[1] || e.text;
  const last = st.lines[st.lines.length - 1];
  const lines = last?.text === word ? st.lines : [...st.lines, { text: word, err: e.stream === "err" }];
  const progress = m ? { done: Math.min(100, Number(m[2])), total: 100, current: e.text } : null;
  return { ...st, lines, progress };
}

export function currentLine(st: StreamState): string | null {
  return st.progress?.current ?? st.lines[st.lines.length - 1]?.text ?? st.steps[st.steps.length - 1]?.text ?? null;
}
