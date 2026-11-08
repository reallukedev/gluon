"use client";
import { Notice } from "@/components/ui/Surface";
import { Disclosure } from "@/components/ui/Disclosure";
import s from "./diagnostics.module.css";

export function LiveStatus({ status, paused }: { status: "connecting" | "live" | "offline"; paused?: boolean }) {
  return (
    <span className={s.status} data-status={paused ? "paused" : status} aria-live="polite">
      {status === "live" ? (paused ? "Paused" : "Live") : status === "connecting" ? "Connecting…" : "Reconnecting…"}
    </span>
  );
}

/** The raw reason waits behind Details for the admin who wants it. */
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
