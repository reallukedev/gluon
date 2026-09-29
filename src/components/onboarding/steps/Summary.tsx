"use client";
import * as React from "react";
import Link from "next/link";
import type { OnboardingSummary } from "@/lib/onboarding";
import { listJoin } from "@/lib/format";
import { useApi } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Actions, PartError, StepHead, hourLabel, useAdminPlan, useFlow } from "../flow";
import o from "../onboarding.module.css";

interface Line {
  key: string;
  label: string;
  set: boolean;
  pending?: boolean;
  text: React.ReactNode;
  where: { href: string; label: string };
}

/**
 * Admin, last: how things stand, read back from the server (not from what was clicked), with where
 * each one lives for later. Things left alone say so plainly.
 */
export function Summary() {
  const plan = useAdminPlan();
  const { finish, leaving } = useFlow();
  const { prefs } = usePrefs();
  const { data, error, mutate } = useApi<OnboardingSummary>("/api/onboarding/summary", { revalidateOnFocus: false });

  const lines: Line[] = [];
  if (data?.updates) {
    const u = data.updates;
    const channel = u.channel === "nightly" ? "Nightly builds" : "Stable releases";
    lines.push({
      key: "updates",
      label: "Updates",
      set: u.touched,
      text: !u.touched
        ? "Not chosen. Gluon follows Stable and tells you when an update is ready."
        : !u.auto
          ? `${channel}. Gluon tells you when one is ready and waits for you.`
          : u.channel === "nightly" && u.nightlyTiming === "asap"
            ? `${channel}, installed automatically as they land.`
            : `${channel}, installed automatically around ${hourLabel(u.hour, prefs.clock)}.`,
      where: { href: "/settings/updates", label: "Settings → Updates" },
    });
  }
  if (data) {
    lines.push({
      key: "alerts",
      label: "Alerts",
      set: data.alerts.length > 0,
      text: data.alerts.length ? `Problems reach you on ${listJoin(data.alerts.map((a) => a.name))}.` : "Problems only show up in Gluon, on Status. Nothing is sent to you.",
      where: { href: "/settings/notifications", label: "Settings → Notifications" },
    });
  }
  if (data?.invites) {
    const { waiting, joined } = data.invites;
    const names = (xs: { name: string | null }[]) => listJoin(xs.map((x) => x.name ?? "someone"));
    const parts: string[] = [];
    if (joined.length) parts.push(`${names(joined)} ${joined.length === 1 ? "has" : "have"} joined.`);
    if (waiting.length) parts.push(`Waiting for ${names(waiting)} to use ${waiting.length === 1 ? "their invite" : "their invites"}.`);
    lines.push({
      key: "people",
      label: "Household",
      set: joined.length + waiting.length > 0,
      // Invites out but nobody in yet: the dashed "on its way" line.
      pending: !joined.length && waiting.length > 0,
      text: parts.length ? parts.join(" ") : "Just you for now.",
      where: { href: "/settings/people", label: "Settings → People" },
    });
  }
  if (data && (data.mfa || plan.steps.includes("security"))) {
    lines.push({
      key: "mfa",
      label: "Two-step sign-in",
      set: data.mfa,
      text: data.mfa ? "On. Signing in asks for a code from your phone." : "Off. Worth turning on, since Gluon can be reached from outside.",
      where: { href: "/settings/security", label: "Settings → Security" },
    });
  }

  return (
    <>
      <StepHead title={`${plan.serverName} is set up`}>
        <p>Here&apos;s how things stand. All of it can be changed later, in the place named on each line.</p>
      </StepHead>

      {error && !data ? (
        <PartError message={`Couldn't read back what was set up. ${error.message}`} onRetry={() => void mutate()} />
      ) : !data ? (
        <ul className={o.summary} aria-busy>
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className={o.summaryRow}>
              <Skeleton width={2} height={14} radius={1} />
              <span className={o.summaryText}>
                <Skeleton width={90} height={12} />
                <Skeleton width="80%" height={12} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className={`${o.summary} appear`}>
          {lines.map((l) => (
            <li key={l.key} className={o.summaryRow}>
              <StateLine state={l.pending ? "starting" : l.set ? "running" : "stopped"} label={false} />
              <span className={o.summaryText}>
                <b>{l.label}</b>
                <span>{l.text}</span>
              </span>
              <Link
                className={o.summaryWhere}
                href={l.where.href}
                onClick={(e) => {
                  // Following a link from here finishes first run too (a new tab just opens the page).
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  finish(l.where.href);
                }}
              >
                {l.where.label}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className={o.note}>From here on Gluon keeps watching. Anything that needs you shows up in Status, with its fix.</p>

      <Actions
        primary={
          <Button variant="primary" onClick={() => finish()} loading={leaving}>
            Open Home
          </Button>
        }
      />
    </>
  );
}
