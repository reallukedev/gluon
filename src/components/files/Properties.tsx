"use client";
import * as React from "react";
import { Refresh, UserCrown } from "iconoir-react";
import type { AppUse, FileEntry, FilesystemInfo, FolderSize } from "@/lib/files-types";
import { api, useApi } from "@/lib/client/api";
import { useFormat, useViewer } from "@/components/PrefsProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { DefinitionList, Notice, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { CopyButton } from "@/components/ui/CopyButton";
import { copyText as copyToClipboard } from "@/lib/client/clipboard";
import { AppIcon } from "@/components/apps/AppIcon";
import { KIND_LABEL, KindIcon, isDirLike } from "./lib";
import s from "./files.module.css";

type Stat = FileEntry & { real: string; access: "read" | "write"; fs: FilesystemInfo | null; protectedReason: string | null };

/** Copy from a menu item (where the item can't show "Copied" itself): works over plain http too. */
export function copyText(text: string, what = "Path") {
  void copyToClipboard(text).then((ok) => (ok ? toast.success(`${what} copied`) : toast.error("Couldn't copy. Select the text and copy it by hand.")));
}

/** Everything about one file or folder: size, dates, owner, drive, and which apps use it. */
export function Properties({ path, focus, onClose, onFixOwnership }: { path: string | null; focus?: "apps" | "size"; onClose: () => void; onFixOwnership?: (path: string) => void }) {
  const fmt = useFormat();
  const viewer = useViewer();
  const { data: st, error } = useApi<Stat>(path ? `/api/files/stat?path=${encodeURIComponent(path)}` : null, { keepPreviousData: false });
  const dir = st ? isDirLike(st) : false;
  const appsRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (focus === "apps" && st) appsRef.current?.scrollIntoView({ block: "nearest" });
  }, [focus, st]);

  return (
    <Dialog open={!!path} onOpenChange={(o) => !o && onClose()} title={st?.name ?? "Properties"} description={st ? KIND_LABEL[st.kind] : undefined} size="wide">
      {error ? (
        <Notice tone="fault" title="Can't read this item">
          {error.message}
        </Notice>
      ) : !st ? (
        <div style={{ display: "grid", gap: 12 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} width={`${50 + ((i * 13) % 45)}%`} />
          ))}
        </div>
      ) : (
        <div className={s.props}>
          <div className={s.propsHead}>
            <KindIcon kind={st.kind} type={st.type} className={s.propsIcon} />
            <div className={s.propsPath}>
              <span className="mono" title={st.path}>
                {st.path}
              </span>
              <CopyButton value={st.path} label="Copy path" />
            </div>
          </div>
          <DefinitionList
            items={[
              ["Size", dir ? <FolderSizeValue path={st.path} autoStart={focus === "size"} /> : <span className="num">{fmt.bytes(st.size)} <span className="muted">({(st.size ?? 0).toLocaleString()} bytes)</span></span>],
              ["Modified", <Time key="m" ts={st.mtime} kind="dateTime" />],
              ["Owner", <span key="o" className="mono">{st.owner ?? st.uid}:{st.group ?? st.gid} <span className="muted">({st.uid}:{st.gid})</span></span>],
              ["Permissions", <span key="p" className="mono">{st.mode} <span className="muted">{st.perms.toString(8).padStart(4, "0")}</span></span>],
              ...(st.link
                ? ([["Link to", <span key="l" className="mono">{st.link.target}{st.link.broken ? " (broken: the target is missing)" : st.link.outside ? " (outside your shared folders)" : ""}</span>]] as [React.ReactNode, React.ReactNode][])
                : []),
              ...(st.real !== st.path ? ([["Real location", <span key="r" className="mono">{st.real}</span>]] as [React.ReactNode, React.ReactNode][]) : []),
              ...(st.fs
                ? ([[
                    "Drive",
                    <span key="d">
                      <span className="mono">{st.fs.mount}</span> <span className="muted num">· {fmt.bytes(st.fs.avail)} free of {fmt.bytes(st.fs.size)} · {st.fs.fstype}{st.fs.readOnly ? " · read-only" : ""}</span>
                    </span>,
                  ]] as [React.ReactNode, React.ReactNode][])
                : []),
              ["Your access", st.protectedReason ? "View only. " + st.protectedReason : st.access === "write" ? "Can view and change" : "Can view"],
            ]}
          />
          {viewer.role === "admin" && dir && (
            <div ref={appsRef}>
              <UsedBy path={st.path} onFixOwnership={onFixOwnership} />
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function FolderSizeValue({ path, autoStart }: { path: string; autoStart?: boolean }) {
  const fmt = useFormat();
  const [started, setStarted] = React.useState(!!autoStart);
  const url = `/api/files/size?path=${encodeURIComponent(path)}`;
  const { data, mutate } = useApi<FolderSize>(started ? url : null, { refreshInterval: (d) => (d?.running ? 2000 : 0), revalidateOnFocus: false });
  const running = !!data?.running;
  if (!started) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setStarted(true)}>
        Calculate
      </Button>
    );
  }
  if (!data) return <Skeleton width={120} />;
  return (
    <span className={s.sizeValue}>
      {data.bytes !== null ? (
        <span className="num">
          {fmt.bytes(data.bytes)}
          {data.partial && <span className="muted"> or more (some folders couldn't be read)</span>}
        </span>
      ) : (
        !running && <span className="muted">{data.error ?? "Not measured yet"}</span>
      )}
      {running ? (
        <span className="muted">Measuring…</span>
      ) : (
        data.computedAt && (
          <span className="muted">
            as of <Time ts={data.computedAt} />
          </span>
        )
      )}
      {!running && (
        <IconButton
          label="Measure again"
          size="sm"
          onClick={() =>
            void api.get<FolderSize>(`${url}&refresh=1`).then((d) => mutate(d, { revalidate: false }))
          }
        >
          <Refresh />
        </IconButton>
      )}
    </span>
  );
}

const RELATION: Record<AppUse["relation"], string> = { this: "uses this folder", within: "uses a folder above", below: "uses a folder inside" };

/** One row per app: its containers often mount the same folder more than once. */
function byApp(uses: AppUse[]) {
  const apps = new Map<string, { first: AppUse; rw: boolean; relations: Set<AppUse["relation"]>; mounts: Map<string, AppUse> }>();
  for (const u of uses) {
    const a = apps.get(u.appId) ?? { first: u, rw: false, relations: new Set(), mounts: new Map() };
    a.rw ||= u.rw;
    a.relations.add(u.relation);
    a.mounts.set(`${u.source}\n${u.destination}`, u);
    apps.set(u.appId, a);
  }
  return [...apps.values()];
}

export function UsedBy({ path, onFixOwnership }: { path: string; onFixOwnership?: (path: string) => void }) {
  const { data, error } = useApi<{ path: string; uses: AppUse[] }>(`/api/files/used-by?path=${encodeURIComponent(path)}`);
  return (
    <div className={s.usedBy}>
      <div className={s.usedByHead}>
        <h3 className={s.subTitle}>Used by apps</h3>
        {onFixOwnership && data && data.uses.length > 0 && (
          <Button size="sm" icon={<UserCrown />} onClick={() => onFixOwnership(path)}>
            Fix ownership
          </Button>
        )}
      </div>
      {error ? (
        <Notice tone="fault">{error.message}</Notice>
      ) : !data ? (
        <Skeleton height={48} />
      ) : data.uses.length === 0 ? (
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          No app uses this folder.
        </p>
      ) : (
        <ul className={`${s.usedList} appear`}>
          {byApp(data.uses).map(({ first: u, rw, relations, mounts }) => {
            const runsAs = u.runsAs ? (u.runsAs.root ? "runs as root" : `runs as ${u.runsAs.user ?? u.runsAs.uid}:${u.runsAs.group ?? u.runsAs.gid}`) : null;
            return (
              <li key={u.appId} className={s.usedRow}>
                <AppIcon src={u.icon} name={u.appName} size={28} />
                <div className={s.usedText}>
                  <span>
                    <b>{u.appName}</b>{" "}
                    <span className="muted">
                      {[...relations].map((r) => RELATION[r]).join(", ")}
                      {!rw && ", read-only"}
                    </span>
                  </span>
                  {[...mounts.values()].map((m) => (
                    <span key={`${m.source}-${m.destination}`} className="mono muted truncate" title={`${m.source} → ${m.destination}`}>
                      {m.containerPath ?? `${m.source} → ${m.destination}`}
                    </span>
                  ))}
                  {(runsAs || u.containerState !== "running") && <span className="muted">{[runsAs, u.containerState !== "running" ? u.containerState : null].filter(Boolean).join(" · ")}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
