"use client";
import * as React from "react";
import Link from "next/link";
import { Refresh } from "iconoir-react";
import type { WidgetProps } from "../types";
import type { StatusPayload } from "@/server/status";
import type { Finding, Remedy } from "@/server/findings";
import { api, ApiError, useApi, STATUS_KEY, STATUS_REFRESH } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { Button, LinkButton } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/Dialog";
import { Skeleton } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import { MoodCoil, type Mood } from "@/components/brand/MoodCoil";
import { shortName } from "@/lib/app-names";
import { Age, WidgetState } from "./kit";
import { useHome } from "../context";
import h from "./statusHero.module.css";

/**
 * Home's status hero: one plain sentence about the server, why, and the fix right under it. The coil beside it
 * carries the mood: open and breathing when all is well, wound tight in sodium when something needs you.
 * This is the one place on Home that names a problem; the app shelf and the uptime list only mark it.
 */

const SETTLE_MS = 60_000;

const worst = (f: Finding) => (f.severity === "fault" ? 0 : f.severity === "attention" ? 1 : 2);

/** "It's running but its web page stopped answering (connection refused)." → its first sentence, no aside. */
function plainWhy(f: Finding): string {
  const text = (f.cause ?? f.title).replace(/\s*\([^)]*\)/g, "").trim();
  const first = /^.+?[.!?](\s|$)/.exec(text)?.[0]?.trim() ?? text;
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

function upFor(seconds: number | null): string | null {
  if (!seconds || seconds < 60) return null;
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `Up ${days} ${days === 1 ? "day" : "days"}.`;
  const hours = Math.floor(seconds / 3600);
  return hours >= 1 ? `Up ${hours} ${hours === 1 ? "hour" : "hours"}.` : "Up a few minutes.";
}

interface Settled {
  id: string;
  /** The app's short name, or null for a finding that isn't about one app. */
  name: string | null;
  at: number;
  /** Server time of the first status read after the fix; a check after it that still finds the problem ends "back up". */
  since: number | null;
}

/** "All 8 apps are happy." or "8 running, 1 stopped.", counting apps like Status does: old copies left out. */
function appsLine(apps: StatusPayload["apps"], nameOf: (id: string) => string | null): string | null {
  const ids = new Set(apps.map((a) => a.id));
  const current = apps.filter((a) => !(a.copyOf && ids.has(a.copyOf.id)));
  const n = current.length;
  if (!n) return null;
  const stopped = current.filter((a) => a.line === "stopped").length;
  if (stopped) return `${n - stopped} running, ${stopped} stopped.`;
  return n === 1 ? `${nameOf(current[0]!.id) ?? "Your one app"} is happy.` : `All ${n} apps are happy.`;
}

interface Say {
  mood: Mood;
  headline: string;
  why: string | null;
  lead?: Finding;
  more?: number;
}

function sayFor(data: StatusPayload, admin: boolean, serverName: string, settled: Settled | null): Say {
  const nameOf = (id: string | null) => {
    const app = id ? data.apps.find((a) => a.id === id) : undefined;
    return app ? shortName(app.name, serverName) : null;
  };
  if (data.appsUnavailable) return { mood: "fault", headline: data.verdict.headline, why: data.verdict.detail || null };

  if (!admin) {
    if (data.verdict.tone !== "ok") return { mood: data.verdict.tone === "fault" ? "fault" : "tense", headline: data.verdict.headline, why: data.verdict.detail || null };
    const line = appsLine(data.apps, nameOf);
    if (!line) return { mood: "calm", headline: "The server is up.", why: "No apps are shared with you yet. Ask the admin for the ones you use." };
    return { mood: "calm", headline: line, why: null };
  }

  const open = [...data.findings].filter((f) => f.id !== settled?.id).sort((a, b) => worst(a) - worst(b));
  const lead = open[0];
  if (!lead) {
    if (settled) return { mood: "calm", headline: settled.name ? `${settled.name} is back up.` : "That's fixed.", why: "Checking it again in a minute." };
    const up = upFor(data.uptime);
    return {
      mood: "calm",
      headline: appsLine(data.apps, nameOf) ?? "The server is running.",
      why: ["Nothing needs you.", up].filter(Boolean).join(" "),
    };
  }
  const mood: Mood = lead.severity === "fault" ? "fault" : "tense";
  if (open.length > 1) {
    return { mood, headline: `${open.length} things need a hand.`, why: `First: ${lead.title.replace(/\.$/, "")}.`, lead, more: open.length - 1 };
  }
  const app = nameOf(lead.subject);
  const allElseFine = data.apps.every((a) => a.id === lead.subject || a.line === "running");
  return {
    mood,
    headline: app ? `${app} needs a hand.` : `${lead.title.replace(/\.$/, "")}.`,
    why: [app || lead.cause ? plainWhy(lead) : null, allElseFine && data.apps.length > 1 ? "Everything else is fine." : null].filter(Boolean).join(" ") || null,
    lead,
  };
}

/** The fix, as the page's one primary button. Destructive fixes confirm first; the server re-asks for a password when it must. */
function Fix({ remedy, finding, onFixed }: { remedy: Remedy; finding: Finding; onFixed: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();
  const icon = /restart/i.test(remedy.action) ? <Refresh /> : undefined;
  if (remedy.href) {
    return (
      <LinkButton href={remedy.href} variant="primary" icon={icon}>
        {remedy.label}
      </LinkButton>
    );
  }
  const run = async () => {
    const r = await api.post<{ message: string }>("/api/remedies", { action: remedy.action, params: remedy.params ?? {}, findingId: finding.id });
    toast.success(r.message);
    onFixed();
  };
  const go = async () => {
    if (remedy.confirm) {
      confirm({ title: remedy.confirm.title, consequences: remedy.confirm.consequences, typeToConfirm: remedy.confirm.typeToConfirm, confirmLabel: remedy.label, variant: "dangerSolid", onConfirm: run });
      return;
    }
    setBusy(true);
    try {
      await run();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) toast.error(`Couldn't ${remedy.label.charAt(0).toLowerCase()}${remedy.label.slice(1)}`, { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="primary" icon={icon} loading={busy} onClick={() => void go()}>
        {remedy.label}
      </Button>
      {confirmNode}
    </>
  );
}

export function StatusWidget({ size }: WidgetProps) {
  const { viewer, serverName } = usePrefs();
  const home = useHome();
  const admin = viewer.role === "admin";
  const { data, error, mutate } = useApi<StatusPayload>(STATUS_KEY, { refresh: STATUS_REFRESH });
  // A fix that worked: the coil lets go and the sentence says so while the next checks confirm it.
  const [settled, setSettled] = React.useState<Settled | null>(null);
  React.useEffect(() => {
    if (!settled) return;
    const t = setTimeout(() => setSettled(null), Math.max(0, settled.at + SETTLE_MS - Date.now()));
    return () => clearTimeout(t);
  }, [settled]);
  // A check after the fix still found it, so it isn't back up: say so straight away.
  const since = settled?.since;
  const reopened = since != null && !!data?.findings.some((f) => f.id === settled!.id && f.lastSeen > since);
  React.useEffect(() => {
    if (reopened) setSettled(null);
  }, [reopened]);
  const fixed = React.useCallback(
    (id: string, name: string | null) => {
      setSettled({ id, name, at: Date.now(), since: null });
      void mutate().then((fresh) => setSettled((st) => (st?.id === id ? { ...st, since: fresh?.checkedAt ?? null } : st)));
    },
    [mutate],
  );

  if (!data && error) {
    if (error.status === 403) return <WidgetState title="Status is for admins here">Whoever runs the server hasn&apos;t shared it with the household.</WidgetState>;
    return (
      <WidgetState
        line="unknown"
        title="Can't check the server"
        action={
          <Button size="sm" variant="ghost" onClick={() => void mutate()}>
            Try again
          </Button>
        }
      >
        {admin ? error.message : "It didn't answer just now. It tries again on its own."}
      </WidgetState>
    );
  }

  const say = data ? sayFor(data, admin, serverName, reopened ? null : settled) : null;
  const lead = say?.lead;
  const leadName = lead?.subject ? (data!.apps.find((a) => a.id === lead.subject)?.name ?? null) : null;
  // One tree for loading and ready, so the coil mounts once and sketches itself in once.
  return (
    <div className={h.hero} data-size={size} data-mood={say?.mood} aria-busy={data ? undefined : true}>
      {!data || !say ? (
        <div key="loading" className={h.words} aria-label="Checking the server">
          <Skeleton width="70%" height={30} />
          <Skeleton width="50%" height={14} />
        </div>
      ) : (
        <div key="ready" className={`${h.words} appear`} data-motion-gentle="">
          <p className={h.say} role="status">
            {say.headline}
          </p>
          {(say.why || data.checkedAt) && (
            <p className={h.why}>
              {say.why}
              <Age at={data.checkedAt} expectMs={60_000} className={h.age} />
            </p>
          )}
          {admin && lead && size !== "s" && (
            <div className={h.act}>
              {lead.remedy && <Fix remedy={lead.remedy} finding={lead} onFixed={() => fixed(lead.id, leadName ? shortName(leadName, serverName) : null)} />}
              <Link href={`/status#${encodeURIComponent(lead.id)}`} className={h.more}>
                {say.more ? (say.more === 1 ? "See both" : `See all ${say.more + 1}`) : "What happened?"}
              </Link>
            </div>
          )}
          {admin && lead && size === "s" && (
            <Link href="/status" className={h.more}>
              What happened?
            </Link>
          )}
        </div>
      )}
      <div className={h.coil}>
        <MoodCoil mood={say?.mood ?? "quiet"} draw={home.entrance} />
      </div>
    </div>
  );
}
