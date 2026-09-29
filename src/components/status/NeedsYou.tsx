"use client";
import * as React from "react";
import Link from "next/link";
import { MoreHoriz } from "iconoir-react";
import type { Finding, Remedy } from "@/server/findings";
import { Button, IconButton, LinkButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { api, ApiError } from "@/lib/client/api";
import { Empty } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import s from "./status.module.css";

/** Run a finding's remedy: navigate, or confirm (if needed) and call the server. */
export function RemedyButton({ remedy, findingId, variant = "secondary", onDone }: { remedy: Remedy; findingId: string | null; variant?: "secondary" | "attention" | "primary"; onDone?: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();
  if (remedy.href) {
    return (
      <LinkButton href={remedy.href} variant={variant === "attention" ? "secondary" : variant} size="sm">
        {remedy.label}
      </LinkButton>
    );
  }
  const run = async () => {
    const r = await api.post<{ message: string }>("/api/remedies", { action: remedy.action, params: remedy.params ?? {}, findingId });
    toast.success(r.message);
    onDone?.();
  };
  const go = async () => {
    if (remedy.confirm) {
      confirm({
        title: remedy.confirm.title,
        consequences: remedy.confirm.consequences,
        typeToConfirm: remedy.confirm.typeToConfirm,
        confirmLabel: remedy.label,
        variant: "dangerSolid",
        onConfirm: run,
      });
      return;
    }
    setBusy(true);
    try {
      await run();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) toast.error(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant={variant === "attention" ? "secondary" : variant} size="sm" loading={busy} onClick={() => void go()}>
        {remedy.label}
      </Button>
      {confirmNode}
    </>
  );
}

const SETTLE_MS = 250;
const LEAVE_MS = 220;

interface Leaving {
  f: Finding;
  index: number;
  /** Fixed (the doubled line settles into one before it goes), not just hidden or snoozed. */
  resolved: boolean;
}

/**
 * Items that disappear from `findings` stay on screen briefly: a fixed one's doubled line
 * settles into a single line, then it slides out; the rows below close the gap by transform.
 */
function useLeaving(findings: Finding[], hiddenByMe: React.RefObject<Set<string>>) {
  const [leaving, setLeaving] = React.useState<Leaving[]>([]);
  const prev = React.useRef(findings);
  React.useEffect(() => {
    const before = prev.current;
    prev.current = findings;
    const now = new Set(findings.map((f) => f.id));
    const gone = before.map((f, index) => ({ f, index })).filter((x) => !now.has(x.f.id));
    if (!gone.length) return;
    const added = gone.map(({ f, index }) => ({ f, index, resolved: !hiddenByMe.current.delete(f.id) }));
    setLeaving((l) => [...l.filter((x) => !now.has(x.f.id) && !added.some((y) => y.f.id === x.f.id)), ...added]);
    const ms = added.some((x) => x.resolved) ? SETTLE_MS + LEAVE_MS + 40 : LEAVE_MS + 40;
    const t = setTimeout(() => setLeaving((l) => l.filter((x) => !added.some((y) => y.f.id === x.f.id))), ms);
    return () => clearTimeout(t);
  }, [findings, hiddenByMe]);
  // Leaving items keep their old place in the list.
  const rows: { f: Finding; leaving?: Leaving }[] = findings.map((f) => ({ f }));
  for (const l of [...leaving].sort((a, b) => a.index - b.index)) {
    if (findings.some((f) => f.id === l.f.id)) continue;
    rows.splice(Math.min(l.index, rows.length), 0, { f: l.f, leaving: l });
  }
  return rows;
}

/** Rows that move because one above them left glide into place (transform only). */
function useFlip(list: React.RefObject<HTMLUListElement | null>, key: string) {
  const tops = React.useRef(new Map<string, number>());
  React.useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>(":scope > li[data-id]")];
    const next = new Map<string, number>();
    for (const li of items) {
      const top = li.offsetTop;
      next.set(li.dataset.id!, top);
      const old = tops.current.get(li.dataset.id!);
      if (old === undefined || old === top || li.hasAttribute("data-leaving")) continue;
      li.style.transition = "none";
      li.style.transform = `translateY(${old - top}px)`;
      void li.offsetHeight;
      li.style.transition = "";
      li.style.transform = "";
    }
    tops.current = next;
  }, [list, key]);
}

export function NeedsYou({ findings, onChange, checkedAt }: { findings: Finding[]; onChange: () => void; checkedAt: number }) {
  const hiddenByMe = React.useRef(new Set<string>());
  const listRef = React.useRef<HTMLUListElement>(null);
  const rows = useLeaving(findings, hiddenByMe);
  useFlip(listRef, rows.map((r) => r.f.id + (r.leaving ? "~" : "")).join(","));

  async function op(f: Finding, body: Record<string, unknown>, message: string) {
    hiddenByMe.current.add(f.id);
    try {
      await api.post(`/api/findings/${encodeURIComponent(f.id)}`, body);
      toast.info(message, {
        action:
          body.op !== "restore"
            ? {
                label: "Undo",
                onClick: () => void api.post(`/api/findings/${encodeURIComponent(f.id)}`, { op: "restore" }).then(onChange),
              }
            : undefined,
      });
      onChange();
    } catch (e) {
      hiddenByMe.current.delete(f.id);
      toast.error(e instanceof Error ? e.message : "That didn't work.");
    }
  }

  if (!rows.length) {
    return (
      <Empty title="Nothing needs you.">
        Gluon checks disks, apps, certificates and updates around the clock. Last checked at <Time ts={checkedAt} kind="time" />.
      </Empty>
    );
  }

  return (
    <ul className={s.needs} role="list" ref={listRef}>
      {rows.map(({ f, leaving }) => (
        <li
          key={f.id}
          className={s.need}
          id={f.id}
          data-id={f.id}
          data-severity={f.severity}
          data-resolved={leaving?.resolved ? "" : undefined}
          data-leaving={leaving ? "" : undefined}
          aria-hidden={leaving ? true : undefined}
        >
          <span className={s.needMark} role="img" aria-label={leaving?.resolved ? "Fixed" : f.severity === "fault" ? "Broken" : "Needs you"} />
          <div className={s.needText}>
            <p className={s.needTitle}>{f.title}</p>
            {f.cause && <p className={s.needCause}>{f.cause}</p>}
            <p className={s.needMeta}>
              {f.subject && !/^(?=.*[A-Z])[A-Za-z0-9_-]{12}$/.test(f.subject) && <span className="mono">{f.subject}</span>}
              <span>
                First noticed <Time ts={f.firstSeen} />
              </span>
            </p>
          </div>
          <div className={s.needActions}>
            {f.remedy && <RemedyButton remedy={f.remedy} findingId={f.id} onDone={onChange} />}
            <Menu
              trigger={
                <IconButton label={`More options for “${f.title}”`} size="sm">
                  <MoreHoriz />
                </IconButton>
              }
              items={[
                { label: "Remind me tomorrow", onSelect: () => void op(f, { op: "snooze", hours: 24 }, "Snoozed until tomorrow") },
                { label: "Remind me next week", onSelect: () => void op(f, { op: "snooze", hours: 24 * 7 }, "Snoozed for a week") },
                "separator",
                { label: "This isn't a problem", description: "Hide it until it changes", onSelect: () => void op(f, { op: "dismiss" }, "Hidden") },
              ]}
            />
          </div>
        </li>
      ))}
      <li className={s.needsFoot} data-id="__foot">
        <Link href="/alerts">All alerts and history</Link>
      </li>
    </ul>
  );
}
