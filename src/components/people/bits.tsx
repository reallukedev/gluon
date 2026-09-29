"use client";
import * as React from "react";
import { Notice } from "@/components/ui/Surface";
import s from "./people.module.css";

/** SWR key for the household's problem reports (the People tabs' count and the Reports tab share it). */
export const REPORTS_URL = "/api/household/reports?status=all&limit=300";

/** A person's initial in a hairline circle. */
export function Avatar({ name, size = 34, off }: { name: string; size?: number; off?: boolean }) {
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span className={s.avatar} style={{ "--size": `${size}px` } as React.CSSProperties} data-off={off ? "" : undefined} aria-hidden>
      {letter}
    </span>
  );
}

/** "Safari on iPhone" from a user agent. */
export function device(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl|wget|python|node/i.test(ua) ? "Script" : "Browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export const errorMessage = (e: unknown, fallback = "That didn't work.") => (e instanceof Error ? e.message : fallback);
export const roleLabel = (r: "admin" | "member") => (r === "admin" ? "Admin" : "Household");

export function LoadError({ what, error }: { what: string; error: Error }) {
  return (
    <Notice tone="fault" title={`Couldn't load ${what}`}>
      {errorMessage(error)} Try again in a moment.
    </Notice>
  );
}

export type ReportStage = "sent" | "seen" | "fixed";
export const reportStage = (r: { resolvedAt: number | null; acknowledgedAt: number | null }): ReportStage => (r.resolvedAt ? "fixed" : r.acknowledgedAt ? "seen" : "sent");

const STAGES: { id: ReportStage; label: string }[] = [
  { id: "sent", label: "Sent" },
  { id: "seen", label: "Seen" },
  { id: "fixed", label: "Fixed" },
];

/** Sent → Seen → Fixed as three hairline marks on a rule: reached ones solid, the rest dashed. */
export function ReportSteps({ stage }: { stage: ReportStage }) {
  const at = STAGES.findIndex((x) => x.id === stage);
  return (
    <ol className={s.steps} aria-label={`Progress: ${STAGES[at]!.label.toLowerCase()}`}>
      {STAGES.map((x, i) => (
        <li key={x.id} data-reached={i <= at ? "" : undefined} data-current={i === at ? "" : undefined} aria-current={i === at ? "step" : undefined}>
          <i aria-hidden />
          {x.label}
        </li>
      ))}
    </ol>
  );
}
