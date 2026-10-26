"use client";
import * as React from "react";
import type { Issue, RuntimeState, CustomAppStatus } from "@/lib/builder-types";
import type { LineState } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import s from "./builder.module.css";

const ORDER = { error: 0, warning: 1, info: 2 } as const;
export const sortIssues = (list: Issue[]) => [...list].sort((a, b) => ORDER[a.level] - ORDER[b.level] || (a.line ?? 0) - (b.line ?? 0));

/** Issues for one field (exact) or a whole group (prefix match with a trailing dot). */
export function issuesAt(issues: Issue[], field: string, prefix = false): Issue[] {
  return issues.filter((i) => i.field === field || (prefix && i.field?.startsWith(`${field}.`)));
}

/** The first error for a field, as <Field error=…> wants it. */
export const errorAt = (issues: Issue[], field: string) => issues.find((i) => i.field === field && i.level === "error")?.message ?? null;

/** Warnings and notes shown under a field or row (errors go through Field's own error line). */
export function FieldNotes({ issues, errors = false, onFix }: { issues: Issue[]; errors?: boolean; onFix?: (fixId: string) => void }) {
  const shown = issues.filter((i) => errors || i.level !== "error");
  if (!shown.length) return null;
  return (
    <div className={s.stackTight}>
      {shown.map((i) => (
        <p key={i.id} className={s.note} data-level={i.level}>
          <span>
            {i.message}
            {i.fix && onFix && (
              <>
                {" "}
                <button type="button" className={s.link} onClick={() => onFix(i.fix!.id)}>
                  {i.fix.label}
                </button>
              </>
            )}
          </span>
        </p>
      ))}
    </div>
  );
}

export function IssueList({ issues, onGo, onFix, empty }: { issues: Issue[]; onGo?: (i: Issue) => void; onFix?: (fixId: string) => void; empty?: React.ReactNode }) {
  if (!issues.length) return empty ? <p className={s.hint}>{empty}</p> : null;
  return (
    <ul className={s.issues}>
      {sortIssues(issues).map((i) => (
        <li key={i.id} className={s.issue} data-level={i.level}>
          <span className={s.issueMark} aria-hidden />
          <span className={s.issueText}>
            <span className="sr-only">{i.level === "error" ? "Problem: " : i.level === "warning" ? "Warning: " : "Note: "}</span>
            {onGo && (i.line || i.field) ? (
              <button type="button" className={s.issueGo} onClick={() => onGo(i)}>
                {i.message}
              </button>
            ) : (
              i.message
            )}
          </span>
          {i.fix && onFix ? (
            <Button size="sm" className={s.issueFix} onClick={() => onFix(i.fix!.id)}>
              {i.fix.label}
            </Button>
          ) : (
            <span />
          )}
        </li>
      ))}
    </ul>
  );
}

export function IssueCount({ issues }: { issues: Issue[] }) {
  const errors = issues.filter((i) => i.level === "error").length;
  const warnings = issues.filter((i) => i.level === "warning").length;
  if (errors) return <span className={`${s.issueCount} num`}>{errors === 1 ? "1 problem to fix" : `${errors} problems to fix`}</span>;
  if (warnings) return <span className={`${s.issueCount} num`} data-level="warning">{warnings === 1 ? "Ready, with 1 warning" : `Ready, with ${warnings} warnings`}</span>;
  return <span className={s.issueCount} data-level="ok">Ready to publish</span>;
}

/** How a custom app reads in lists and headers: the StateLine and its words. */
export function runtimeLine(status: CustomAppStatus, rt: RuntimeState | null, job: { kind: string } | null): { line: LineState; label: string } {
  if (job) return { line: "starting", label: job.kind === "build" ? "Building" : job.kind === "remove" ? "Removing" : "Publishing" };
  if (status === "draft" || !rt) return { line: "stopped", label: "Draft" };
  const busy: Record<string, string> = { installing: "Installing", updating: "Updating", uninstalling: "Uninstalling", starting: "Starting", stopping: "Stopping", restarting: "Restarting" };
  if (busy[rt.state]) return { line: "starting", label: rt.progress ? `${busy[rt.state]} · ${Math.round(rt.progress)}%` : busy[rt.state]! };
  if (rt.state === "ready" || rt.state === "running") return { line: "running", label: "Running" };
  if (rt.state === "stopped") return { line: "stopped", label: "Stopped" };
  if (rt.state === "not-installed") return { line: "attention", label: rt.target === "umbrel" ? "Not installed" : "Not running" };
  if (rt.state === "unhealthy") return { line: "unhealthy", label: "Unhealthy" };
  return { line: "unknown", label: rt.target === "umbrel" ? "Umbrel isn't answering" : "Unknown" };
}

export const SOURCE_WORDS = { image: "Docker image", compose: "Compose file", github: "GitHub" } as const;
