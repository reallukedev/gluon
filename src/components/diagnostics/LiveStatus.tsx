"use client";
import s from "./diagnostics.module.css";

/** "Live" / "Paused" / "Reconnecting…" with the same line mark the log viewer uses. */
export function LiveStatus({ status, paused }: { status: "connecting" | "live" | "offline"; paused?: boolean }) {
  return (
    <span className={s.status} data-status={paused ? "paused" : status} aria-live="polite">
      {status === "live" ? (paused ? "Paused" : "Live") : status === "connecting" ? "Connecting…" : "Reconnecting…"}
    </span>
  );
}
