"use client";
import * as React from "react";
import Link from "next/link";
import { MoreHoriz, Trash, NavArrowRight, Folder, Plus, Copy } from "iconoir-react";
import { api, useApi, ApiError } from "@/lib/client/api";
import { copyText } from "@/lib/client/clipboard";
import { useFormat } from "@/components/PrefsProvider";
import { Page, PageHeader, Empty, Skeleton } from "@/components/ui/Surface";
import { Button, IconButton, LinkButton } from "@/components/ui/Button";
import { Checkbox, Field, Input, Segmented } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { StateLine } from "@/components/ui/StateLine";
import { CopyButton } from "@/components/ui/CopyButton";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import type { DockerVolume, VolumeSizes, VolumesResponse } from "@/lib/docker-types";
import { AppsSectionTabs } from "./AppsSectionTabs";
import { CleanupDialog } from "./CleanupDialog";
import { FilterInput, LoadError, SortHead, TableSkeleton, UsedBy, appHref, appWords, containerHref, firstError, isReauthCancel, useQueryParam, useSelection, type InitialError } from "./shared";
import s from "./docker.module.css";

type Filter = "all" | "used" | "unused";
type Sort = "name" | "size" | "created";

const COLUMNS = "18px minmax(220px, 2.2fr) minmax(170px, 1.6fr) 96px 112px 68px";

const volName = (v: DockerVolume) => (v.anonymous ? `unnamed volume ${v.name.slice(0, 12)}` : v.name);
const filesHref = (p: string) => `/files?path=${encodeURIComponent(p)}`;

function noteFor(v: DockerVolume): string | null {
  if (v.guard) return v.guard.message;
  if (!v.containers.length && v.app) return `Was ${v.app.name}'s`;
  if (!v.containers.length && v.project) return `From the ${v.project} stack`;
  if (!v.containers.length && v.anonymous) return "Scratch space an image asked for";
  return null;
}

export function VolumesView({ initial, initialError, initialQuery }: { initial: VolumesResponse | null; initialError: InitialError; initialQuery: string }) {
  const fmt = useFormat();
  const { data, error: liveError, mutate, isValidating } = useApi<VolumesResponse>("/api/docker/volumes", { refresh: 20_000, fallbackData: initial ?? undefined });
  const error = liveError ?? firstError(data, initialError);
  const { data: sizes, error: sizeError, mutate: mutateSizes } = useApi<VolumeSizes>(data ? "/api/docker/volumes/sizes" : null, { refresh: 120_000, revalidateOnFocus: false });
  const [q, setQ] = useQueryParam(initialQuery);
  const term = React.useDeferredValue(q.trim().toLowerCase());
  const [filter, setFilter] = React.useState<Filter>("all");
  const [sort, setSort] = React.useState<Sort>("name");
  const [open, setOpen] = React.useState<string | null>(null);
  const [cleanup, setCleanup] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();
  const volumes = data?.volumes;
  const sizeOf = (v: DockerVolume) => (sizes ? (sizes.sizes[v.name] ?? null) : undefined);

  const selectable = (volumes ?? []).filter((v) => !v.containers.length && !v.guard).map((v) => v.name);
  const { selected, setSelected, toggle } = useSelection(selectable);
  const unused = (volumes ?? []).filter((v) => !v.containers.length);
  const totalBytes = sizes && volumes ? volumes.reduce((a, v) => a + (sizes.sizes[v.name] ?? 0), 0) : null;
  const unusedBytes = sizes ? unused.reduce((a, v) => a + (sizes.sizes[v.name] ?? 0), 0) : null;

  const shown = (volumes ?? [])
    .filter((v) => {
      if (filter === "used" && !v.containers.length) return false;
      if (filter === "unused" && v.containers.length) return false;
      if (!term) return true;
      return v.name.toLowerCase().includes(term) || (v.app?.name.toLowerCase().includes(term) ?? false) || (v.project?.toLowerCase().includes(term) ?? false) || v.containers.some((c) => c.name.toLowerCase().includes(term) || c.destination.toLowerCase().includes(term));
    })
    .sort((a, b) =>
      sort === "size" ? (sizeOf(b) ?? -1) - (sizeOf(a) ?? -1) : sort === "created" ? (b.created ?? 0) - (a.created ?? 0) : Number(a.anonymous) - Number(b.anonymous) || a.name.localeCompare(b.name),
    );

  const summary = !volumes ? (
    error ? "Gluon couldn't get the list from Docker." : "Asking Docker…"
  ) : volumes.length === 0 ? (
    "No volumes."
  ) : (
    <>
      <b>
        {fmt.plural(volumes.length, "volume")}
        {totalBytes !== null ? (
          <>
            {" "}
            hold <span className="num">{fmt.bytes(totalBytes)}</span>.
          </>
        ) : (
          "."
        )}
      </b>{" "}
      {unused.length === 0 ? (
        "Every one is used by a container."
      ) : (
        <>
          {unused.length === 1 ? "1 isn't" : `${unused.length} aren't`} used by any container
          {unusedBytes !== null && unusedBytes > 0 ? (
            <>
              {" "}
              (<span className="num">{fmt.bytes(unusedBytes)}</span>)
            </>
          ) : null}
          .
        </>
      )}
    </>
  );

  async function remove(v: DockerVolume, typed?: string) {
    try {
      const r = await api.del<{ message: string }>(`/api/docker/volumes/${encodeURIComponent(v.name)}`, { confirm: typed });
      toast.success(r.message);
      setOpen((o) => (o === v.name ? null : o));
      void mutate();
      void mutateSizes();
    } catch (e) {
      if (!isReauthCancel(e)) throw e;
    }
  }

  function askRemove(v: DockerVolume) {
    if (v.containers.length || v.guard?.level === "block") return;
    const size = sizeOf(v);
    confirm({
      title: v.anonymous ? "Delete this unnamed volume?" : `Delete the volume ${v.name}?`,
      consequences: [
        ...(v.guard?.level === "warn" ? [<b key="g">{v.guard.message}</b>] : []),
        size ? `Everything in it is deleted: ${fmt.bytes(size)}. This can't be undone.` : "Everything in it is deleted. This can't be undone.",
        ...(v.app ? [`It was ${appWords(v.app)}'s. If ${v.app.name} is reinstalled or started again, it starts with an empty volume.`] : []),
        ...(v.mountpoint ? [<span key="m">To look inside first, open <span className="mono">{v.mountpoint}</span> in Files.</span>] : []),
      ],
      confirmLabel: "Delete volume",
      typeToConfirm: v.anonymous && !v.guard ? undefined : v.name,
      // Gluon's own data: type the name and hold the button.
      holdMs: v.guard?.level === "warn" ? 1400 : undefined,
      onConfirm: () => remove(v, v.anonymous && !v.guard ? undefined : v.name),
    });
  }

  function askRemoveSelected() {
    const list = (volumes ?? []).filter((v) => selected.has(v.name));
    const named = list.filter((v) => !v.anonymous);
    const bytes = sizes ? list.reduce((a, v) => a + (sizes.sizes[v.name] ?? 0), 0) : null;
    confirm({
      title: `Delete ${fmt.plural(list.length, "volume")}?`,
      consequences: [
        <span>
          <span className="mono">{list.slice(0, 4).map(volName).join(", ")}</span>
          {list.length > 4 ? ` and ${list.length - 4} more` : ""}.
        </span>,
        `Everything in ${list.length === 1 ? "it" : "them"} is deleted${bytes ? ` (${fmt.bytes(bytes)})` : ""}. This can't be undone.`,
        ...(named.length ? [`${named.length === 1 ? "One has" : `${named.length} have`} a name, so ${named.length === 1 ? "it" : "they"} may hold an app's data.`] : []),
      ],
      typeToConfirm: named.length ? "delete" : undefined,
      confirmLabel: `Delete ${fmt.plural(list.length, "volume")}`,
      onConfirm: async () => {
        try {
          const r = await api.post<{ message: string; skipped: { label: string; reason: string }[] }>("/api/docker/cleanup", { kind: "volumes", ids: list.map((v) => v.name) });
          if (r.skipped.length) toast.info(r.message, { description: r.skipped.map((k) => `${k.label}: ${k.reason}`).join(" ") });
          else toast.success(r.message);
          setSelected(new Set());
          void mutate();
          void mutateSizes();
        } catch (e) {
          if (!isReauthCancel(e)) throw e;
        }
      },
    });
  }

  const menuFor = (v: DockerVolume): MenuEntry[] => [
    ...(v.mountpoint ? [{ label: "Show in Files", icon: <Folder />, href: filesHref(v.mountpoint) }] : []),
    { label: "Copy name", icon: <Copy />, onSelect: () => void copyText(v.name).then(() => toast.success("Copied the volume name")) },
    "separator",
    {
      label: "Delete volume…",
      icon: <Trash />,
      danger: true,
      disabled: !!v.containers.length || v.guard?.level === "block",
      description: v.guard?.level === "block" ? v.guard.message : v.containers.length ? `${v.containers[0]!.app?.name ?? v.containers[0]!.name} uses it` : undefined,
      onSelect: () => askRemove(v),
    },
  ];

  const pickable = shown.filter((v) => selectable.includes(v.name));
  const allOn = pickable.length > 0 && pickable.every((v) => selected.has(v.name));
  const someOn = pickable.some((v) => selected.has(v.name));
  const chosen = (volumes ?? []).filter((v) => selected.has(v.name));

  return (
    <Page>
      <AppsSectionTabs current="volumes" />
      <PageHeader
        title="Volumes"
        summary={summary}
        actions={
          <>
            {unused.some((v) => !v.guard) && (
              <Button icon={<Trash />} onClick={() => setCleanup(true)}>
                Remove unused…
              </Button>
            )}
            <Button icon={<Plus />} onClick={() => setCreating(true)}>
              Create volume
            </Button>
          </>
        }
      />

      {error && (
        <div style={{ marginBottom: 16 }}>
          <LoadError error={error} what="volumes" onRetry={() => void mutate()} retrying={isValidating} />
        </div>
      )}

      {volumes && volumes.length > 0 && (
        <div className={s.toolbar}>
          <FilterInput value={q} onChange={setQ} placeholder="Filter by name, app or path inside" label="Filter volumes" />
          <Segmented
            aria-label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "used", label: "In use" },
              { value: "unused", label: unused.length ? `Unused ${unused.length}` : "Unused" },
            ]}
          />
          <span className={s.sortSelect}>
            <Select
              aria-label="Sort by"
              value={sort}
              onChange={setSort}
              options={[
                { value: "name", label: "Sort by name" },
                { value: "size", label: "Largest first" },
                { value: "created", label: "Newest first" },
              ]}
            />
          </span>
        </div>
      )}

      {!volumes ? (
        error ? null : <TableSkeleton columns={COLUMNS} check />
      ) : volumes.length === 0 ? (
        <Empty title="No volumes on this server" action={<Button icon={<Plus />} onClick={() => setCreating(true)}>Create volume</Button>}>
          Volumes are storage Docker manages for containers, kept apart from the container so it survives updates. Apps that use folders on your disks (most CasaOS and Umbrel apps) don&apos;t need them.
        </Empty>
      ) : shown.length === 0 ? (
        <Empty title={term ? `Nothing matches “${q.trim()}”` : filter === "unused" ? "Every volume is in use" : "No volume is in use"}>
          {term ? "Try part of the name, an app, or a path inside a container." : filter === "unused" ? "Each one is mounted by a container, so there's nothing to clean up." : "Start an app that uses volumes and they show up here."}
        </Empty>
      ) : (
        <div className={`${s.table} ${s.volumes}`} role="table" aria-label="Volumes" aria-rowcount={shown.length + 1}>
          <div className={s.headRow} role="row">
            <span role="columnheader" className={s.check}>
              <Checkbox
                checked={allOn}
                indeterminate={!allOn && someOn}
                disabled={!pickable.length}
                onChange={(c) => setSelected(c ? new Set([...selected, ...pickable.map((v) => v.name)]) : new Set([...selected].filter((n) => !pickable.some((v) => v.name === n))))}
              />
              <span className="sr-only">Select all unused</span>
            </span>
            <SortHead k="name" label="Volume" sort={sort} setSort={setSort} asc />
            <span role="columnheader">Used by</span>
            <SortHead k="size" label="Size" sort={sort} setSort={setSort} end />
            <SortHead k="created" label="Created" sort={sort} setSort={setSort} end />
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {shown.map((v) => {
            const isOpen = open === v.name;
            const canPick = selectable.includes(v.name);
            const size = sizeOf(v);
            return (
              <div key={v.name} className={s.group} data-open={isOpen ? "" : undefined} data-selected={selected.has(v.name) ? "" : undefined} role="rowgroup">
                <div
                  role="row"
                  className={s.row}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a,button,[role=menu],[role=checkbox],label")) return;
                    setOpen(isOpen ? null : v.name);
                  }}
                >
                  <span role="cell" className={s.check}>
                    {canPick && <Checkbox checked={selected.has(v.name)} onChange={(c) => toggle(v.name, c)} />}
                    {canPick && <span className="sr-only">Select {volName(v)}</span>}
                  </span>
                  <span role="cell" className={s.nameCell}>
                    <button type="button" className={s.nameButton} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : v.name)}>
                      <NavArrowRight className={s.chevron} strokeWidth={2} aria-hidden />
                      {v.anonymous ? <span className={`${s.name} ${s.nameFaint}`}>Unnamed volume</span> : <span className={s.name} title={v.name}>{v.name}</span>}
                    </button>
                    <span className={s.sub}>
                      {v.anonymous && <span className="mono">{v.name.slice(0, 12)}</span>}
                      {v.anonymous && (v.app || v.driver !== "local") ? " · " : ""}
                      {v.app ? appWords(v.app) : !v.anonymous && v.project ? `${v.project} stack` : ""}
                      {v.driver !== "local" ? `${v.app || v.project ? " · " : ""}${v.driver} driver` : ""}
                      {!v.anonymous && !v.app && !v.project && v.driver === "local" ? "Local" : ""}
                    </span>
                  </span>
                  <span role="cell" className={s.useCol}>
                    <UsedBy refs={v.containers} empty="Not used" note={noteFor(v)} />
                  </span>
                  <span role="cell" className={s.numCell}>
                    {size === undefined ? sizeError ? <span className={s.faint}>–</span> : <Skeleton width={52} height={12} style={{ marginLeft: "auto" }} /> : size === null ? <span className={s.faint} title="Docker couldn't measure it">–</span> : fmt.bytes(size)}
                  </span>
                  <span role="cell" className={s.dateCell}>
                    {v.created ? <Time ts={v.created} /> : <span className={s.faint}>–</span>}
                  </span>
                  <span role="cell" className={s.actions}>
                    <Menu
                      trigger={
                        <IconButton label={`${volName(v)} actions`} size="sm">
                          <MoreHoriz />
                        </IconButton>
                      }
                      items={menuFor(v)}
                    />
                  </span>
                </div>
                {isOpen && <VolumeDetail volume={v} size={size} onRemove={() => askRemove(v)} />}
              </div>
            );
          })}
        </div>
      )}
      {volumes && volumes.length > 0 && sizeError && <p className={s.below}>Docker couldn&apos;t measure the volumes: {sizeError.message}</p>}

      {chosen.length > 0 && (
        <div className={s.selectionBar} role="region" aria-label="Selected volumes">
          <span className="num">
            {fmt.plural(chosen.length, "volume")}
            {sizes ? ` · ${fmt.bytes(chosen.reduce((a, v) => a + (sizes.sizes[v.name] ?? 0), 0))}` : ""}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <Button variant="danger" size="sm" icon={<Trash />} onClick={askRemoveSelected}>
            Delete selected…
          </Button>
        </div>
      )}

      <CreateVolumeDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          void mutate();
          void mutateSizes();
        }}
      />
      <CleanupDialog
        kind="volumes"
        open={cleanup}
        onClose={() => setCleanup(false)}
        onDone={() => {
          void mutate();
          void mutateSizes();
        }}
      />
      {confirmNode}
    </Page>
  );
}

function VolumeDetail({ volume: v, size, onRemove }: { volume: DockerVolume; size: number | null | undefined; onRemove: () => void }) {
  const fmt = useFormat();
  const blocked = !!v.containers.length || v.guard?.level === "block";
  const extraLabels = Object.keys(v.labels).filter((k) => !k.startsWith("com.docker."));
  return (
    <div className={`${s.detail} appear`} role="region" aria-label={`${volName(v)} details`}>
      <div className={s.detailGrid}>
        <dl className={s.kv}>
          <dt>Name</dt>
          <dd>
            <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span className={s.monoWrap}>{v.name}</span>
              <CopyButton value={v.name} label="Copy name" />
            </span>
          </dd>
          {v.mountpoint && (
            <>
              <dt>On the server</dt>
              <dd>
                <Link href={filesHref(v.mountpoint)} className={s.monoWrap}>
                  {v.mountpoint}
                </Link>
              </dd>
            </>
          )}
          <dt>Size</dt>
          <dd className="num">{size === undefined ? "Measuring…" : size === null ? "Docker couldn't measure it" : fmt.bytes(size)}</dd>
          <dt>Driver</dt>
          <dd>
            {v.driver}
            {Object.keys(v.options).length > 0 && <span className={`${s.faint} mono`}> {Object.entries(v.options).map(([k, val]) => `${k}=${val}`).join(" ")}</span>}
          </dd>
          {v.created && (
            <>
              <dt>Created</dt>
              <dd>
                <Time ts={v.created} kind="dateTime" />
              </dd>
            </>
          )}
          {v.project && (
            <>
              <dt>Compose</dt>
              <dd>
                <span className="mono">{v.project}</span>
                {v.composeName && <span className={s.faint}> · volume <span className="mono">{v.composeName}</span></span>}
              </dd>
            </>
          )}
          {v.app && (
            <>
              <dt>App</dt>
              <dd>
                <Link href={appHref(v.app)}>{appWords(v.app)}</Link>
              </dd>
            </>
          )}
          {extraLabels.length > 0 && (
            <>
              <dt>Labels</dt>
              <dd className={s.monoWrap}>{extraLabels.map((k) => `${k}=${v.labels[k]}`).join("  ")}</dd>
            </>
          )}
        </dl>
        <div>
          <p className={s.detailHead}>{v.containers.length ? `Mounted by ${fmt.plural(v.containers.length, "container")}` : "Not mounted by any container"}</p>
          {v.containers.length > 0 ? (
            <ul className={s.ctrList}>
              {v.containers.map((c) => (
                <li key={`${c.id}:${c.destination}`}>
                  <span className={s.ctrMain}>
                    <StateLine state={c.line} size={13} />
                    <Link href={containerHref(c)} className="mono">
                      {c.name}
                    </Link>
                    <span className={s.ctrMeta}>
                      at <span className="mono">{c.destination}</span>
                      {c.rw ? "" : ", read-only"}
                    </span>
                  </span>
                  <span className={s.ctrEnd}>{c.app ? <Link href={appHref(c.app)}>{c.app.name}</Link> : c.state === "running" ? "Running" : "Stopped"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.faint} style={{ fontSize: "var(--text-sm)" }}>
              {v.anonymous
                ? "Unnamed volumes are created when an image asks for storage and no one names it. Once their container is gone, nothing uses them again."
                : "Its data stays until you delete it. An app that's reinstalled with the same Compose name picks it up again."}
            </p>
          )}
          <div className={s.detailActions}>
            {v.mountpoint && (
              <LinkButton size="sm" icon={<Folder />} href={filesHref(v.mountpoint)}>
                Show in Files
              </LinkButton>
            )}
            <Button size="sm" variant="danger" icon={<Trash />} disabled={blocked} onClick={onRemove}>
              Delete volume…
            </Button>
          </div>
          {blocked && <p className={s.below}>{v.guard?.level === "block" ? v.guard.message : "It can't be deleted while a container uses it, even a stopped one."}</p>}
        </div>
      </div>
    </div>
  );
}

function CreateVolumeDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setName("");
      setErr(null);
    }
  }, [open]);
  async function create(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ message: string }>("/api/docker/volumes", { name });
      toast.success(r.message);
      onCreated();
      onClose();
    } catch (x) {
      setErr(x instanceof ApiError || x instanceof Error ? x.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Create a volume"
      description="An empty local volume. Name it in a Compose file's volumes section (as external) to use it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void create()}>
            Create volume
          </Button>
        </>
      }
    >
      <form onSubmit={create} className={s.form}>
        <Field label="Name" error={err} description="Letters, digits, dots, dashes and underscores.">
          <Input mono value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="media-cache" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={128} />
        </Field>
      </form>
    </Dialog>
  );
}
