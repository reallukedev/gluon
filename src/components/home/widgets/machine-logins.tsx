"use client";
// "Who's connected": people signed in to the machine over SSH or at its keyboard. Admin-only: the
// widget is hidden from members in the catalog and on Home, and its API refuses anyone but admins.
import Link from "next/link";
import { registerWidget } from "../widgetStore";
import type { WidgetProps } from "../types";
import type { LiveLogins, LiveSession } from "@/lib/system-types";
import { useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { KIND_ORDER, KIND_WORDS, ZONE_WORDS } from "@/components/system/loginWords";
import { WidgetState } from "./kit";
import { Preview } from "../previews";
import w from "@/components/system/loginsWidget.module.css";

interface Person {
  user: string;
  sessions: LiveSession[];
  away: boolean;
  since: number;
  /** The most telling session: a terminal beats a tunnel. */
  lead: LiveSession;
}

function people(sessions: LiveSession[]): Person[] {
  const m = new Map<string, LiveSession[]>();
  for (const x of sessions) (m.get(x.user) ?? m.set(x.user, []).get(x.user)!).push(x);
  return [...m.entries()]
    .map(([user, list]) => {
      const sorted = [...list].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.idleSeconds ?? 1e9) - (b.idleSeconds ?? 1e9));
      return {
        user,
        sessions: list,
        away: list.some((x) => x.from.zone === "away"),
        since: Math.min(...list.map((x) => x.startedAt)),
        lead: sorted[0]!,
      };
    })
    .sort((a, b) => Number(b.away) - Number(a.away) || a.since - b.since);
}

function doing(x: LiveSession): string {
  if (x.running && x.running.label !== "At the prompt") return x.running.label ?? x.running.program;
  if (x.kind === "shell" || x.kind === "console") return x.idleSeconds !== null && x.idleSeconds > 600 ? "Idle at the prompt" : "At the prompt";
  return KIND_WORDS[x.kind];
}

function MachineLogins({ size }: WidgetProps) {
  const fmt = useFormat();
  const { data, error } = useApi<LiveLogins>("/api/system/logins", {
    refresh: 15_000,
  });

  if (!data) {
    if (error) {
      return (
        <WidgetState line={error.status === 403 ? undefined : "unknown"} title="Can't see who's connected">
          {error.status === 403 ? "Only admins can see this." : "Gluon couldn't ask the machine just now. It tries again on its own."}
        </WidgetState>
      );
    }
    return (
      <div className={w.body}>
        <Skeleton width="60%" height={18} />
        <Skeleton width="80%" height={12} />
        <Skeleton width="70%" height={12} />
      </div>
    );
  }

  const list = people(data.sessions);
  const away = list.filter((p) => p.away);
  const compact = size === "s";
  const max = size === "s" ? 0 : size === "m" || size === "w" ? 2 : 5;

  if (!list.length) {
    return (
      <div className={w.body}>
        <p className={w.headline}>
          <StateLine state="stopped" label={false} size={18} />
          <span>Nobody is signed in</span>
        </p>
        <p className={w.sub}>Nobody is using SSH or the server's keyboard right now.</p>
        {!compact && (
          <Link href="/system?tab=sign-ins" className={w.more}>
            Recent sign-ins
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className={w.body}>
      <p className={w.headline}>
        <StateLine state={away.length ? "attention" : "running"} label={false} size={18} />
        <span>
          <span className="num">{list.length}</span> {list.length === 1 ? "person" : "people"} connected
        </span>
      </p>
      <p className={w.sub}>
        {away.length ? (
          <b className={w.away}>{away.map((p) => p.user).join(", ")} from outside your home</b>
        ) : compact ? (
          list.map((p) => p.user).join(", ")
        ) : (
          `${fmt.plural(data.sessions.length, "session")}, all from ${list.every((p) => p.sessions.every((x) => x.from.zone === "local")) ? "the server itself" : "home"}`
        )}
      </p>
      {max > 0 && (
        <ul className={w.list}>
          {list.slice(0, max).map((p) => (
            <li key={p.user} className={w.row}>
              <StateLine state={p.away ? "attention" : "running"} label={false} size={12} />
              <span className={w.rowText}>
                <span className={w.rowTitle}>
                  <b>{p.user}</b>
                  <span className={w.dim}>
                    {" "}
                    · {p.lead.from.ip ?? ZONE_WORDS[p.lead.from.zone]}
                    {p.sessions.length > 1 ? ` · ${p.sessions.length} sessions` : ""}
                  </span>
                </span>
                <span className={w.rowMeta}>
                  {doing(p.lead)} · signed in <Time ts={p.since} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {!compact && (
        <Link href="/system?tab=sign-ins" className={w.more}>
          {list.length > max ? `All ${list.length} on Sign-ins` : "See sign-ins"}
        </Link>
      )}
    </div>
  );
}

registerWidget({
  type: "system.logins",
  name: "Who's connected",
  description: "People signed in to the machine over SSH or at its keyboard, and what they're doing.",
  category: "Server",
  sizes: ["s", "m", "t", "l", "w"],
  defaultSize: "m",
  defaultConfig: {},
  adminOnly: true,
  title: () => "Who's connected",
  Component: MachineLogins,
  preview: <Preview of="logins" />,
});
