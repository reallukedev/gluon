"use client";
import { Notice } from "@/components/ui/Surface";
import { Disclosure } from "@/components/ui/Disclosure";
import s from "./diagnostics.module.css";

/** "Live" / "Paused" / "Reconnecting…" with the same line mark the log viewer uses. */
export function LiveStatus({ status, paused }: { status: "connecting" | "live" | "offline"; paused?: boolean }) {
  return (
    <span className={s.status} data-status={paused ? "paused" : status} aria-live="polite">
      {status === "live" ? (paused ? "Paused" : "Live") : status === "connecting" ? "Connecting…" : "Reconnecting…"}
    </span>
  );
}

/**
 * A live list's stream failed. With a reading on screen it says so and keeps it; without one it is
 * the whole state. The raw reason is for the admin who wants it, so it waits behind Details.
 */
export function StreamError({ what, error, stale }: { what: string; error: string; stale: boolean }) {
  return (
    <Notice tone="fault" title={stale ? `The ${what} stopped updating` : `Couldn't read the ${what}`}>
      {stale ? "Showing the last reading. Retrying." : "Retrying every few seconds."}
      <Disclosure summary="Details">
        <span className="mono">{error}</span>
      </Disclosure>
    </Notice>
  );
}
