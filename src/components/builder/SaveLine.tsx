"use client";
import { Time } from "@/components/ui/Time";
import s from "./builder.module.css";

/** Whether the draft is saved: a short line that turns dashed while saving and red when it can't. */
export function SaveLine({ state, savedAt, error, onRetry }: { state: string; savedAt: number; error: string | null; onRetry: () => void }) {
  return (
    <p className={s.saveState} data-state={state} aria-live="polite">
      <span className={s.saveDot} aria-hidden />
      {state === "saving" || state === "dirty" ? (
        "Saving…"
      ) : state === "error" ? (
        <span>
          Not saved: {error}{" "}
          <button type="button" className={s.link} onClick={onRetry}>
            Try again
          </button>
        </span>
      ) : state === "conflict" ? (
        "Not saved: changed elsewhere"
      ) : (
        <span>
          Saved <Time ts={savedAt} />
        </span>
      )}
    </p>
  );
}
