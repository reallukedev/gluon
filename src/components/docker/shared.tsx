"use client";
import * as React from "react";
import Link from "next/link";
import { Search } from "iconoir-react";
import { ApiError } from "@/lib/client/api";
import { sourceName } from "@/lib/app-names";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { StateLine } from "@/components/ui/StateLine";
import type { AppRef, ContainerRef } from "@/lib/docker-types";
import s from "./docker.module.css";

export const appHref = (a: AppRef) => `/apps/${encodeURIComponent(a.id)}`;
export const containerHref = (c: { id: string }) => `/apps/containers/${c.id.slice(0, 12)}`;

/** "Immich" or "Immich from CasaOS" when the source matters (Umbrel and CasaOS own their apps). */
export function appWords(a: AppRef): string {
  return a.source === "umbrel" || a.source === "casaos" ? `${a.name} (${sourceName(a.source)})` : a.name;
}

export type InitialError = { code: string; message: string } | null;

/** The server page's own error, until the client's first answer replaces it. */
export function firstError(data: unknown, initial: InitialError): ApiError | undefined {
  return !data && initial ? new ApiError(initial.code, initial.message, initial.code === "not_found" ? 404 : initial.code === "docker_down" ? 503 : 500) : undefined;
}

/** An error from a list endpoint, with what to do about it. */
export function LoadError({ error, what, onRetry, retrying }: { error: unknown; what: string; onRetry: () => void; retrying?: boolean }) {
  const e = error instanceof ApiError ? error : null;
  const down = e?.code === "docker_down";
  const offline = e?.code === "network";
  return (
    <Notice
      tone="fault"
      title={down ? "Docker isn't answering" : offline ? "Can't reach Gluon" : `Couldn't load ${what}`}
      action={
        <Button size="sm" loading={retrying} onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {down ? (
        <>
          Gluon talks to Docker through <span className="mono">/var/run/docker.sock</span>. Check that Docker is running on the server (<span className="mono">systemctl status docker</span>) and that Gluon&apos;s container still has the socket mounted.
        </>
      ) : (
        (e?.message ?? (error instanceof Error ? error.message : "Something went wrong."))
      )}
    </Notice>
  );
}

/** Who uses a resource: a state line for the busiest container, and the apps by name. */
export function UsedBy({ refs, empty, note }: { refs: ContainerRef[]; empty: React.ReactNode; note?: React.ReactNode }) {
  if (!refs.length) {
    return (
      <span className={s.useCell}>
        <span className={s.notUsed}>{empty}</span>
        {note && <span className={s.useNote}>{note}</span>}
      </span>
    );
  }
  const running = refs.filter((r) => r.state === "running");
  const line = running.length ? (running.some((r) => r.line === "unhealthy") ? "unhealthy" : "running") : refs.some((r) => r.line === "unhealthy") ? "unhealthy" : "stopped";
  // One entry per app; containers without an app by name.
  const seen = new Set<string>();
  const parts: React.ReactNode[] = [];
  const appNames = new Map<string, Set<string>>();
  const nameKey = (n: string) => n.toLowerCase();
  for (const r of refs) if (r.app) appNames.set(nameKey(r.app.name), new Set([...(appNames.get(nameKey(r.app.name)) ?? []), r.app.id]));
  for (const r of refs) {
    const key = r.app?.id ?? `c:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Two installs with one name (Immich from Umbrel and from CasaOS) say which is which.
    const clash = r.app && (appNames.get(nameKey(r.app.name))?.size ?? 0) > 1;
    parts.push(
      r.app ? (
        <Link key={key} href={appHref(r.app)} title={appWords(r.app)}>
          {clash ? `${r.app.name} (${sourceName(r.app.source)})` : r.app.name}
        </Link>
      ) : (
        <Link key={key} href={containerHref(r)} className="mono" title={r.name}>
          {r.name}
        </Link>
      ),
    );
  }
  const shown = parts.slice(0, 2);
  const rest = parts.length - shown.length;
  const neverStarted = refs.every((r) => r.state === "created");
  const stateWord = running.length ? (running.length === refs.length ? "" : `${running.length} of ${refs.length} running · `) : neverStarted ? "Not started · " : refs.length === 1 ? "Stopped · " : "All stopped · ";
  return (
    <span className={s.useCell}>
      <span className={s.useLine}>
        <StateLine state={line} size={13} />
        <span className={s.useNames}>
          {stateWord}
          {shown.map((p, i) => (
            <React.Fragment key={i}>
              {i > 0 && ", "}
              {p}
            </React.Fragment>
          ))}
          {rest > 0 && ` and ${rest} more`}
        </span>
      </span>
      {note && <span className={s.useNote}>{note}</span>}
    </span>
  );
}

export function FilterInput({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <label className={s.filter}>
      <Search aria-hidden />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
    </label>
  );
}

export function SortHead<T extends string>({ k, label, sort, setSort, asc, end }: { k: T; label: string; sort: T; setSort: (v: T) => void; asc?: boolean; end?: boolean }) {
  return (
    <span role="columnheader" aria-sort={sort === k ? (asc ? "ascending" : "descending") : "none"} className={end ? s.headEnd : undefined}>
      <button type="button" className={s.sortButton} data-on={sort === k ? "" : undefined} data-asc={asc ? "" : undefined} onClick={() => setSort(k)}>
        {label}
      </button>
    </span>
  );
}

/** Rows of hairline skeletons shaped like a table's rows. */
export function TableSkeleton({ columns, rows = 6, check }: { columns: string; rows?: number; check?: boolean }) {
  return (
    <div className={s.table} aria-busy="true" aria-label="Loading">
      <div className={s.headRow} style={{ gridTemplateColumns: columns }}>
        {check && <span />}
        <Skeleton width={60} height={9} />
        <Skeleton width={70} height={9} />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={s.skelRow} style={{ gridTemplateColumns: columns }}>
          {check && <Skeleton width={17} height={17} radius={4} />}
          <span className={s.skelName}>
            <Skeleton width={`${50 + ((i * 37) % 35)}%`} height={13} />
            <Skeleton width={`${28 + ((i * 23) % 20)}%`} height={10} />
          </span>
          <Skeleton width={`${40 + ((i * 29) % 40)}%`} height={12} />
        </div>
      ))}
    </div>
  );
}

/** Row selection that forgets ids which are no longer selectable. */
export function useSelection(selectable: string[]) {
  const [sel, setSel] = React.useState<Set<string>>(new Set());
  const key = selectable.join("|");
  React.useEffect(() => {
    const ok = new Set(selectable);
    setSel((cur) => {
      const next = new Set([...cur].filter((id) => ok.has(id)));
      return next.size === cur.size ? cur : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const toggle = React.useCallback((id: string, on: boolean) => {
    setSel((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  return { selected: sel, setSelected: setSel, toggle };
}

/** Keep `?q=` in the address so a search from ⌘K lands filtered, without adding history entries. */
export function useQueryParam(initial: string) {
  const [q, setQ] = React.useState(initial);
  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (q.trim()) url.searchParams.set("q", q.trim());
    else url.searchParams.delete("q");
    window.history.replaceState(window.history.state, "", url);
  }, [q]);
  return [q, setQ] as const;
}

export const isReauthCancel = (e: unknown) => e instanceof ApiError && e.code === "reauth_cancelled";
