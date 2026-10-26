import type { MoveEvent, MoveStage } from "@/lib/app-move-types";
import { emptyStream, reduceStream, type StreamState } from "@/components/ui/StreamLog";

export interface MoveView {
  stage: MoveStage | null;
  stream: StreamState;
  result: Extract<MoveEvent, { type: "result" }> | null;
}

export const emptyMove: MoveView = { stage: null, stream: emptyStream, result: null };

export function reduceMove(v: MoveView, e: MoveEvent): MoveView {
  switch (e.type) {
    case "stage":
      return { ...v, stage: e.stage };
    case "result":
      return { ...v, result: e, stream: reduceStream(v.stream, { type: "done", ok: e.ok, message: e.message }) };
    case "error":
      return { ...v, result: { type: "result", ok: false, rolledBack: false, newId: null, message: e.message }, stream: reduceStream(v.stream, e) };
    default:
      return { ...v, stream: reduceStream(v.stream, e) };
  }
}

export const replay = (events: MoveEvent[]) => events.reduce(reduceMove, emptyMove);

/** Moves whose outcome the person has already seen (in the dialog or a toast), by job start time. */
const seen = new Set<string>();
export const jobKey = (j: { appId: string; startedAt: number }) => `${j.appId}:${j.startedAt}`;
export const markSeen = (j: { appId: string; startedAt: number }) => void seen.add(jobKey(j));
export const wasSeen = (j: { appId: string; startedAt: number }) => seen.has(jobKey(j));
