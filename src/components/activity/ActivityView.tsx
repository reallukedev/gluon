"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowUp, Search, Server, Xmark } from "iconoir-react";
import type { ActivityItem, ActivityPage } from "@/lib/people-types";
import { api, useApi, useStream } from "@/lib/client/api";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { Empty, Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Segmented } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { Avatar } from "@/components/people/bits";
import { SectionHeader } from "@/components/settings/SectionHeader";
import { outcomeOf, sameRun, targetLink, type Names } from "./targets";
import s from "./activity.module.css";

type Kind = "all" | "user" | "system";
type Result = "all" | "failed";
interface Person {
  id: string;
  name: string;
  username: string;
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = React.useState(v);
  React.useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function dayLabel(ts: number, date: (ts: number, o?: { weekday?: boolean; year?: boolean }) => string) {
  const now = Date.now();
  if (date(ts) === date(now)) return "Today";
  if (date(ts) === date(now - 86_400_000)) return "Yesterday";
  return date(ts, { weekday: true, year: new Date(ts).getFullYear() !== new Date(now).getFullYear() });
}

/** A run of entries that say the same thing, newest first. Most runs are one entry. */
interface Run {
  key: number;
  items: ActivityItem[];
}

/** Scrolled further than this, new entries wait above instead of pushing the page down. */
const HOLD_BELOW = 240;

/**
 * Who did what to which thing, and what the server noticed: a live timeline grouped by day, with
 * its filters. Lives in Settings → Activity (its summary goes in the section's header).
 */
export function ActivityView({ initial, people, initialTarget, initialUser, pageSize }: { initial: ActivityPage; people: Person[]; initialTarget: string; initialUser: string; pageSize: number }) {
  const fmt = useFormat();
  const { serverName } = usePrefs();
  const [kind, setKind] = React.useState<Kind>("all");
  const [result, setResult] = React.useState<Result>("all");
  const [user, setUser] = React.useState(initialUser);
  const [target, setTarget] = React.useState(initialTarget);
  const [text, setText] = React.useState("");
  const q = useDebounced(text.trim(), 300);

  const params = new URLSearchParams();
  if (kind !== "all") params.set("kind", kind);
  if (result === "failed") params.set("outcome", "failed");
  if (user) params.set("user", user);
  if (target) params.set("target", target);
  if (q) params.set("q", q);
  const filterKey = params.toString();
  const initialKey = React.useMemo(() => {
    const p = new URLSearchParams();
    if (initialUser) p.set("user", initialUser);
    if (initialTarget) p.set("target", initialTarget);
    return p.toString();
  }, [initialUser, initialTarget]);

  const { data: first, error, isLoading, mutate } = useApi<ActivityPage>(`/api/activity?${filterKey}${filterKey ? "&" : ""}limit=${pageSize}`, {
    fallbackData: filterKey === initialKey ? initial : undefined,
    revalidateOnFocus: false,
    keepPreviousData: true,
  });
  const { data: apps } = useApi<{ id: string; name: string }[]>("/api/apps", { revalidateOnFocus: false });
  const names: Names = React.useMemo(
    () => ({ people: new Map(people.map((p) => [p.id, p.name])), apps: new Map((apps ?? []).map((a) => [a.id, a.name])) }),
    [people, apps],
  );

  const [live, setLive] = React.useState<ActivityItem[]>([]);
  const [held, setHeld] = React.useState<ActivityItem[]>([]);
  const [older, setOlder] = React.useState<ActivityItem[]>([]);
  const [next, setNext] = React.useState<number | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [moreError, setMoreError] = React.useState<string | null>(null);
  const fresh = React.useRef(new Set<number>());

  React.useEffect(() => {
    setLive([]);
    setHeld([]);
    setOlder([]);
    setNext(undefined);
    setMoreError(null);
    fresh.current.clear();
  }, [filterKey]);

  const status = useStream(
    `/api/activity/stream${filterKey ? `?${filterKey}` : ""}`,
    {
      activity: (d) => {
        const e = d as ActivityItem;
        // Someone reading further down shouldn't have the page pushed under them.
        if (window.scrollY > HOLD_BELOW) {
          setHeld((h) => (h.some((x) => x.id === e.id) ? h : [e, ...h].slice(0, 200)));
          return;
        }
        fresh.current.add(e.id);
        setLive((l) => (l.some((x) => x.id === e.id) ? l : [e, ...l].slice(0, 500)));
      },
    },
    [filterKey],
  );

  const showHeld = React.useCallback(() => {
    for (const e of held) fresh.current.add(e.id);
    setLive((l) => [...held.filter((e) => !l.some((x) => x.id === e.id)), ...l].slice(0, 500));
    setHeld([]);
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduce";
    window.scrollTo({ top: 0, behavior: calm ? "auto" : "smooth" });
  }, [held]);
  // Scrolling back to the top shows what arrived meanwhile.
  React.useEffect(() => {
    if (!held.length) return;
    const onScroll = () => window.scrollY < 40 && showHeld();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [held.length, showHeld]);

  const cursor = next === undefined ? (first?.next ?? null) : next;
  const loadMore = React.useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const p = await api.get<ActivityPage>(`/api/activity?${filterKey}${filterKey ? "&" : ""}limit=${pageSize}&before=${cursor}`);
      setOlder((o) => [...o, ...p.items]);
      setNext(p.next);
    } catch (e) {
      setMoreError(e instanceof Error ? e.message : "Couldn't load older entries.");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, filterKey, pageSize]);

  const sentinel = React.useRef<HTMLLIElement>(null);
  React.useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && void loadMore(), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  // Rebuilt only when entries arrive, not on every keystroke in the search box: the rows are memoized
  // and keep their runs, so typing doesn't re-render the whole timeline.
  const firstItems = first?.items;
  const items = React.useMemo(() => {
    const seen = new Set<number>();
    return [...live, ...(firstItems ?? []), ...older].filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  }, [live, firstItems, older]);

  const groups = React.useMemo(() => {
    const out: { key: string; ts: number; runs: Run[]; count: number; problems: number }[] = [];
    for (const it of items) {
      const key = fmt.date(it.at, { year: true });
      let g = out[out.length - 1];
      if (!g || g.key !== key) out.push((g = { key, ts: it.at, runs: [], count: 0, problems: 0 }));
      g.count++;
      if (it.outcome === "failed" && !it.action.endsWith(".resolved")) g.problems++;
      const last = g.runs[g.runs.length - 1];
      if (last && sameRun(last.items[0]!, it)) last.items.push(it);
      else g.runs.push({ key: it.id, items: [it] });
    }
    return out;
  }, [items, fmt]);

  const todayKey = fmt.date(Date.now(), { year: true });
  const today = groups[0]?.key === todayKey ? groups[0] : null;
  const complete = !cursor || (groups.length > 1 && groups[0]?.key === todayKey);
  const latest = items[0];
  const summary = filterKey ? (
    "Showing only what matches your filters."
  ) : today ? (
    <>
      <b>
        {complete ? "" : "At least "}
        {fmt.plural(today.count, "thing")} happened today
      </b>
      {today.problems ? `, ${today.problems} went wrong` : ""}.{latest ? " " : ""}
      {latest && (
        <>
          Latest <Time ts={latest.at} />.
        </>
      )}
    </>
  ) : (
    "Nothing has happened yet today."
  );

  const personName = people.find((p) => p.id === user)?.name;
  const filtered = !!filterKey;
  const clearAll = () => {
    setKind("all");
    setResult("all");
    setUser("");
    setTarget("");
    setText("");
  };

  return (
    <>
    <SectionHeader summary={summary} />
    <div className={s.view}>
      <div className={s.toolbar}>
        <label className={s.filter}>
          <Search aria-hidden />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search what happened" aria-label="Search activity" spellCheck={false} />
        </label>
        <Segmented
          aria-label="Who"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "Everyone" },
            { value: "user", label: "People" },
            { value: "system", label: "The server" },
          ]}
        />
        <Select aria-label="Person" value={user} onChange={setUser} options={[{ value: "", label: "Any person" }, ...people.map((p) => ({ value: p.id, label: p.name }))]} />
        <Segmented
          aria-label="Result"
          value={result}
          onChange={setResult}
          options={[
            { value: "all", label: "Any result" },
            { value: "failed", label: "Went wrong" },
          ]}
        />
        {target && (
          <span className={s.chip}>
            <span className="mono" title={target}>
              {names.apps.get(target) ?? names.people.get(target) ?? target}
            </span>
            <IconButton label="Clear this filter" size="sm" tooltip={false} onClick={() => setTarget("")}>
              <Xmark />
            </IconButton>
          </span>
        )}
        <span className={s.live} title={status === "live" ? "New entries appear as they happen" : undefined}>
          {status === "live" ? <StateLine state="running" label="Live" size={12} /> : status === "connecting" ? <StateLine state="starting" label="Connecting" size={12} /> : <StateLine state="paused" label="Reconnecting" size={12} />}
        </span>
      </div>

      {held.length > 0 && (
        <div className={s.heldWrap}>
          <Button size="sm" className={s.held} icon={<ArrowUp />} onClick={showHeld}>
            {fmt.plural(held.length, "new entry", "new entries")}
          </Button>
        </div>
      )}

      {error && !first ? (
        <Notice tone="fault" title="Couldn't load activity" action={<Button size="sm" onClick={() => void mutate()}>Try again</Button>}>
          {error.message}
        </Notice>
      ) : (
        <Panel flush>
          {isLoading && !first ? (
            <div className={s.skeletons}>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className={s.skelRow}>
                  <Skeleton width={56} height={12} />
                  <Skeleton width={28} height={28} radius={14} />
                  <span style={{ display: "grid", gap: 8 }}>
                    <Skeleton width={`${50 + ((i * 17) % 40)}%`} height={14} />
                    <Skeleton width="30%" height={11} />
                  </span>
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <Empty title={filtered ? "Nothing matches" : "Nothing recorded yet"} action={filtered ? <Button onClick={clearAll}>Show everything</Button> : undefined}>
              {filtered
                ? `Try fewer filters${personName ? ` or someone other than ${personName}` : ""}.`
                : "Everything people change (restarts, settings, sign-ins) and everything the server notices on its own shows up here as it happens."}
            </Empty>
          ) : (
            <ol className={`${s.list} appear`} aria-live="polite" aria-relevant="additions">
              {groups.map((g) => (
                <React.Fragment key={g.key}>
                  <li className={s.day}>
                    <span className="label">{dayLabel(g.ts, fmt.date)}</span>
                    <span className={`${s.dayCount} num`}>
                      {fmt.plural(g.count, "entry", "entries")}
                      {g.problems ? ` · ${g.problems} went wrong` : ""}
                    </span>
                  </li>
                  {g.runs.map((r) => (
                    <Row key={r.key} run={r} fresh={fresh.current.has(r.items[0]!.id)} names={names} serverName={serverName} onPerson={setUser} onTarget={setTarget} />
                  ))}
                </React.Fragment>
              ))}
              {cursor ? (
                <li ref={sentinel} className={s.sentinel}>
                  {moreError ? (
                    <Button size="sm" onClick={() => void loadMore()}>
                      {moreError} Try again
                    </Button>
                  ) : (
                    "Loading older entries…"
                  )}
                </li>
              ) : (
                items.length > 20 && <li className={s.sentinel}>That's everything Gluon has kept (a year).</li>
              )}
            </ol>
          )}
        </Panel>
      )}
    </div>
    </>
  );
}

const Row = React.memo(function Row({ run, fresh, names, serverName, onPerson, onTarget }: { run: Run; fresh: boolean; names: Names; serverName: string; onPerson: (id: string) => void; onTarget: (t: string) => void }) {
  const fmt = useFormat();
  const e = run.items[0]!;
  const n = run.items.length;
  const oldest = run.items[n - 1]!;
  const person = e.kind === "user";
  const who = person ? ((e.userId && names.people.get(e.userId)) ?? e.username ?? "Someone") : serverName;
  const out = outcomeOf(e);
  const text = out.kind === "cleared" ? e.summary.replace(/^Resolved:\s*/, "") : e.summary;
  const summary = person ? text.charAt(0).toLowerCase() + text.slice(1) : text;
  const link = targetLink(e, names);
  const hasDetail = e.detail !== null && e.detail !== undefined && !(typeof e.detail === "object" && Object.keys(e.detail as object).length === 0);

  return (
    <li className={s.row} data-kind={e.kind} data-outcome={out.kind} data-fresh={fresh ? "" : undefined} data-motion-gentle={fresh ? "" : undefined}>
      <span className={s.time}>
        <Time ts={e.at} kind="time" className="num" />
        {n > 1 && fmt.time(oldest.at) !== fmt.time(e.at) && (
          <span className={`${s.timeFrom} num`}>
            from <Time ts={oldest.at} kind="time" />
          </span>
        )}
      </span>
      <span className={s.actor}>
        {person ? (
          <Avatar name={who} size={28} />
        ) : (
          <span className={s.serverTile} title={`${serverName}, on its own`}>
            <Server aria-hidden />
          </span>
        )}
      </span>
      <div className={s.main}>
        <p className={s.text}>
          {person ? (
            e.userId ? (
              <button type="button" className={s.who} onClick={() => onPerson(e.userId!)} title={`Only show ${who}`}>
                {who}
              </button>
            ) : (
              <b className={s.whoStatic}>{who}</b>
            )
          ) : (
            <span className="sr-only">{serverName}: </span>
          )}
          {person ? " " : ""}
          {summary}
          {n > 1 && <span className={`${s.times} num`}> · {n} times</span>}
        </p>
        <div className={s.sub}>
          <Time ts={e.at} kind="time" className={`${s.subTime} num`} />
          {!person && <span>Noticed by {serverName}</span>}
          {link &&
            (link.href ? (
              <Link href={link.href} className={s.target} title={e.target ?? undefined}>
                {link.label}
              </Link>
            ) : (
              <span className="mono truncate" title={link.label}>
                {link.label}
              </span>
            ))}
          {e.target && (
            <button type="button" className={s.only} onClick={() => onTarget(e.target!)}>
              only this
            </button>
          )}
          {person && e.zone === "away" && <span>from outside home</span>}
          <Disclosure summary="Details" className={s.inlineDisclosure}>
            <div className={s.details}>
              <dl className={s.detailList}>
                <dt>Recorded as</dt>
                <dd className="mono">{e.action}</dd>
                {e.ip && e.ip !== "unknown" && (
                  <>
                    <dt>From</dt>
                    <dd className="mono">
                      {e.ip}
                      {e.zone ? ` (${e.zone === "away" ? "outside home" : "at home"})` : ""}
                    </dd>
                  </>
                )}
                {n > 1 && (
                  <>
                    <dt>Each time</dt>
                    <dd className="num">{run.items.map((x) => fmt.time(x.at)).join(", ")}</dd>
                  </>
                )}
              </dl>
              {hasDetail && <pre>{typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail, null, 2)}</pre>}
            </div>
          </Disclosure>
        </div>
      </div>
      <span className={s.outcome} data-kind={out.kind}>
        {out.kind !== "ok" && (
          <>
            <StateLine state={out.kind === "cleared" ? "running" : "unhealthy"} label={false} size={12} />
            {out.label}
          </>
        )}
      </span>
    </li>
  );
});
