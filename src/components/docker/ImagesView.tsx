"use client";
import * as React from "react";
import Link from "next/link";
import { MoreHoriz, CloudDownload, Trash, NavArrowRight, Copy, Refresh, Label as TagIcon } from "iconoir-react";
import { api, useApi } from "@/lib/client/api";
import { copyText } from "@/lib/client/clipboard";
import { listJoin } from "@/lib/format";
import { useFormat } from "@/components/PrefsProvider";
import { Page, PageHeader, Empty } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { Checkbox, Segmented } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { useConfirm, type ConfirmOptions } from "@/components/ui/Dialog";
import { StateLine } from "@/components/ui/StateLine";
import { CopyButton } from "@/components/ui/CopyButton";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import type { DockerImage, ImagesResponse } from "@/lib/docker-types";
import { AppsSectionTabs } from "./AppsSectionTabs";
import { CleanupDialog } from "./CleanupDialog";
import { PullDialog } from "./PullDialog";
import { FilterInput, LoadError, firstError, type InitialError, SortHead, TableSkeleton, UsedBy, appHref, appWords, containerHref, isReauthCancel, useQueryParam, useSelection } from "./shared";
import s from "./docker.module.css";

type Filter = "all" | "used" | "unused";
type Sort = "created" | "name" | "size";

const COLUMNS = "18px minmax(240px, 2.3fr) minmax(170px, 1.5fr) 104px 112px 68px";
const PAGE = 150;

/** "ghcr.io/immich-app/immich-server" + ":v3.2.2", the tag quieter than the name. */
function RefName({ image }: { image: DockerImage }) {
  const t = image.tags[0];
  if (t) {
    const colon = t.lastIndexOf(":");
    const slash = t.lastIndexOf("/");
    const [repo, tag] = colon > slash ? [t.slice(0, colon), t.slice(colon)] : [t, ""];
    return (
      <span className={s.name} title={image.tags.join("\n")}>
        {repo}
        <span className={s.tag}>{tag}</span>
      </span>
    );
  }
  if (image.repo) {
    return (
      <span className={s.name} title={image.repo}>
        {image.repo}
        <span className={s.tag}> (no tag)</span>
      </span>
    );
  }
  return <span className={`${s.name} ${s.nameFaint}`}>{image.built ? "Leftover build" : "Untagged image"}</span>;
}

export const imageName = (i: DockerImage) => i.tags[0] ?? (i.repo ? `${i.repo} (untagged)` : `untagged image ${i.short}`);

function noteFor(i: DockerImage): string | null {
  if (i.guard) return i.guard.message;
  if (i.olderOf) return `Older version of ${i.olderOf.name}'s image`;
  if (i.use === "leftover") return i.built ? "Left over from rebuilding an image" : "No tag; nothing refers to it";
  if (i.baseOf.length && !i.containers.length) return `Base of ${listJoin(i.baseOf.slice(0, 2))}`;
  return null;
}

export function ImagesView({ initial, initialError, initialQuery }: { initial: ImagesResponse | null; initialError: InitialError; initialQuery: string }) {
  const fmt = useFormat();
  const { data, error: liveError, mutate, isValidating } = useApi<ImagesResponse>("/api/docker/images", { refresh: 20_000, fallbackData: initial ?? undefined });
  const error = liveError ?? firstError(data, initialError);
  const [q, setQ] = useQueryParam(initialQuery);
  const term = React.useDeferredValue(q.trim().toLowerCase());
  const [filter, setFilter] = React.useState<Filter>("all");
  const [sort, setSort] = React.useState<Sort>("created");
  const [open, setOpen] = React.useState<string | null>(null);
  const [limit, setLimit] = React.useState(PAGE);
  const [pull, setPull] = React.useState<{ ref: string | null } | null>(null);
  const [cleanup, setCleanup] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();
  const images = data?.images;
  const needTotal = !!data && data.total === null;
  const { data: disk } = useApi<{ images: { bytes: number } }>(needTotal ? "/api/docker/disk" : null, { revalidateOnFocus: false });
  const total = data?.total ?? disk?.images.bytes ?? null;

  const selectable = (images ?? []).filter((i) => (i.use === "unused" || i.use === "leftover") && !i.guard).map((i) => i.id);
  const { selected, setSelected, toggle } = useSelection(selectable);

  const unused = (images ?? []).filter((i) => i.use === "unused" || i.use === "leftover");
  const unusedBytes = unused.filter((i) => !i.guard).reduce((a, i) => a + i.own, 0);
  const shown = (images ?? [])
    .filter((i) => {
      if (filter === "used" && !i.containers.length) return false;
      if (filter === "unused" && i.containers.length) return false;
      if (!term) return true;
      return (
        i.tags.some((t) => t.toLowerCase().includes(term)) ||
        (i.repo?.toLowerCase().includes(term) ?? false) ||
        i.id.includes(term) ||
        (i.app?.name.toLowerCase().includes(term) ?? false) ||
        i.containers.some((c) => c.name.toLowerCase().includes(term))
      );
    })
    .sort((a, b) => (sort === "size" ? b.size - a.size : sort === "name" ? imageName(a).localeCompare(imageName(b)) : b.created - a.created));

  const summary = !images ? (
    error ? "Gluon couldn't get the list from Docker." : "Asking Docker…"
  ) : images.length === 0 ? (
    "No images yet."
  ) : (
    <>
      <b>
        {fmt.plural(images.length, "image")}
        {total !== null ? (
          <>
            {" "}
            use <span className="num">{fmt.bytes(total)}</span>.
          </>
        ) : (
          "."
        )}
      </b>{" "}
      {unused.length === 0 ? "Every one is used by a container." : <>{unused.length === 1 ? "1 isn't" : `${unused.length} aren't`} used by anything{unusedBytes > 0 ? <>, freeing at least <span className="num">{fmt.bytes(unusedBytes)}</span> if removed</> : null}.</>}
    </>
  );

  // ---------------------------------------------------------------- actions

  async function checkNewer(i: DockerImage, tag: string) {
    const t = toast.loading(`Asking the registry about ${tag}…`);
    try {
      const r = await api.post<{ status: "same" | "newer" | "missing" | "unknown"; message: string | null }>(`/api/docker/images/${encodeURIComponent(i.id)}/check`, { tag });
      if (r.status === "newer") {
        toast.dismiss(t);
        toast.info(`A newer ${tag} is available`, { description: i.containers.length ? "Download it, then update the app that uses it to switch." : undefined, action: { label: "Download", onClick: () => setPull({ ref: tag }) } });
      }
      else if (r.status === "same") toast.update(t, "success", { title: `${tag} is the newest version` });
      else if (r.status === "missing") toast.update(t, "info", { title: `The registry doesn't have ${tag}`, description: "It was built on this server, or it's private." });
      else toast.update(t, "error", { title: "The registry didn't answer", description: r.message ?? undefined });
    } catch (e) {
      toast.update(t, "error", { title: "Couldn't check", description: e instanceof Error ? e.message : undefined });
    }
  }

  async function del(i: DockerImage, body: { tag?: string; withContainers?: boolean; confirm?: string }) {
    try {
      const r = await api.del<{ message: string }>(`/api/docker/images/${encodeURIComponent(i.id)}`, body);
      toast.success(r.message);
      if (!body.tag) setOpen((o) => (o === i.id ? null : o));
      void mutate();
    } catch (e) {
      if (isReauthCancel(e)) return;
      throw e;
    }
  }

  function askRemove(i: DockerImage) {
    const name = imageName(i);
    const running = i.use === "running";
    if (running || i.guard?.level === "block") return;
    const stopped = i.containers;
    const platformApps = [...new Set(stopped.map((c) => c.app).filter((a) => a && (a.source === "umbrel" || a.source === "casaos")).map((a) => a!.name))];
    const consequences: React.ReactNode[] = [];
    if (i.guard?.level === "warn") consequences.push(<b>{i.guard.message}</b>);
    if (stopped.length) {
      consequences.push(
        <span>
          {stopped.length === 1 ? "Its stopped container goes too" : `Its ${stopped.length} stopped containers go too`}: <span className="mono">{stopped.map((c) => c.name).join(", ")}</span>. {stopped.length === 1 ? "Its" : "Their"} own file changes are deleted; volumes and folders stay.
        </span>,
      );
      const owners = new Map(stopped.filter((c) => c.app).map((c) => [c.app!.id, c.app!]));
      for (const a of owners.values()) {
        if (a.source === "umbrel") consequences.push(`Umbrel downloads the image again and recreates ${stopped.length === 1 ? "it" : "them"} when ${a.name} next starts.`);
        else if (a.source === "casaos") consequences.push(`CasaOS recreates ${stopped.length === 1 ? "it" : "them"} (and downloads the image) the next time ${a.name} starts.`);
      }
    }
    if (i.olderOf) consequences.push(`${i.olderOf.name} keeps running on its current image.`);
    if (i.tags.length && i.built) consequences.push("It was built on this server, so getting it back means building it again.");
    else if (i.tags.length) consequences.push(`If something needs it later, Docker downloads ${i.tags[0]} again.`);
    if (i.own > 0) consequences.push(`Frees about ${fmt.bytes(i.own)}${i.shared ? ` (${fmt.bytes(i.shared)} is shared with other images and stays)` : ""}.`);
    const opts: ConfirmOptions = {
      title: stopped.length ? `Remove ${name} and its ${stopped.length === 1 ? "container" : "containers"}?` : `Remove ${name}?`,
      description: platformApps.length ? `${listJoin(platformApps)} ${platformApps.length === 1 ? "is" : "are"} managed by ${stopped.find((c) => c.app?.source === "umbrel") ? "Umbrel" : "CasaOS"}.` : undefined,
      consequences,
      confirmLabel: stopped.length ? "Remove both" : "Remove image",
      typeToConfirm: i.guard?.level === "warn" ? name : undefined,
      holdMs: i.guard?.level === "warn" ? 1400 : undefined,
      onConfirm: () => del(i, { withContainers: stopped.length > 0, confirm: i.guard?.level === "warn" ? name : undefined }),
    };
    confirm(opts);
  }

  function askUntag(i: DockerImage, tag: string) {
    confirm({
      title: `Remove the tag ${tag}?`,
      consequences: [`The image stays, as ${i.tags.filter((t) => t !== tag).join(", ")}.`, "Anything that asks for this tag by name gets it downloaded again."],
      confirmLabel: "Remove tag",
      variant: "danger",
      onConfirm: () => del(i, { tag }),
    });
  }

  function askRemoveSelected() {
    const list = (images ?? []).filter((i) => selected.has(i.id));
    const bytes = list.reduce((a, i) => a + i.own, 0);
    const built = list.filter((i) => i.tags.length && i.built);
    confirm({
      title: `Remove ${fmt.plural(list.length, "image")}?`,
      consequences: [
        <span>
          <span className="mono">{list.slice(0, 4).map(imageName).join(", ")}</span>
          {list.length > 4 ? ` and ${list.length - 4} more` : ""}.
        </span>,
        "No container uses them. Anything that needs one later downloads it again.",
        ...(built.length ? [`${listJoin(built.map(imageName).slice(0, 3))} ${built.length === 1 ? "was" : "were"} built on this server and can't be downloaded again.`] : []),
        `Frees at least ${fmt.bytes(bytes)}.`,
      ],
      confirmLabel: `Remove ${fmt.plural(list.length, "image")}`,
      onConfirm: async () => {
        try {
          const r = await api.post<{ message: string; skipped: { label: string; reason: string }[] }>("/api/docker/cleanup", { kind: "images", ids: list.map((i) => i.id) });
          if (r.skipped.length) toast.info(r.message, { description: r.skipped.map((k) => `${k.label}: ${k.reason}`).join(" ") });
          else toast.success(r.message);
          setSelected(new Set());
          void mutate();
        } catch (e) {
          if (!isReauthCancel(e)) throw e;
        }
      },
    });
  }

  const menuFor = (i: DockerImage): MenuEntry[] => {
    const tag = i.tags[0];
    const removeBlocked = i.use === "running" || i.guard?.level === "block";
    return [
      ...(tag
        ? ([
            { label: "Check for a newer version", icon: <Refresh />, onSelect: () => void checkNewer(i, tag) },
            { label: `Download ${tag} again`, description: i.containers.length ? "Apps switch to it when they're updated" : undefined, icon: <CloudDownload />, onSelect: () => setPull({ ref: tag }) },
            "separator",
          ] as MenuEntry[])
        : []),
      { label: "Copy image ID", icon: <Copy />, onSelect: () => void copyText(i.id).then(() => toast.success("Copied the image ID")) },
      ...(i.tags.length > 1 && i.guard?.level !== "block" ? ([{ kind: "sub", label: "Remove a tag", icon: <TagIcon />, items: i.tags.map((t) => ({ label: t, onSelect: () => askUntag(i, t) })) }] as MenuEntry[]) : []),
      "separator",
      {
        label: i.containers.length && !removeBlocked ? "Remove with its containers…" : "Remove image…",
        description: i.guard?.level === "block" ? i.guard.message : i.use === "running" ? `${i.app?.name ?? "A container"} is running on it` : undefined,
        icon: <Trash />,
        danger: true,
        disabled: removeBlocked,
        onSelect: () => askRemove(i),
      },
    ];
  };

  // ---------------------------------------------------------------- render

  const allShownSelectable = shown.filter((i) => selectable.includes(i.id));
  const allOn = allShownSelectable.length > 0 && allShownSelectable.every((i) => selected.has(i.id));
  const someOn = allShownSelectable.some((i) => selected.has(i.id));
  const chosen = (images ?? []).filter((i) => selected.has(i.id));

  return (
    <Page>
      <AppsSectionTabs current="images" />
      <PageHeader
        title="Images"
        summary={summary}
        actions={
          <>
            {unused.some((i) => !i.guard) && (
              <Button icon={<Trash />} onClick={() => setCleanup(true)}>
                Remove unused…
              </Button>
            )}
            <Button variant="primary" icon={<CloudDownload />} onClick={() => setPull({ ref: null })}>
              Download image
            </Button>
          </>
        }
      />

      {error && (
        <div style={{ marginBottom: 16 }}>
          <LoadError error={error} what="images" onRetry={() => void mutate()} retrying={isValidating} />
        </div>
      )}

      {images && images.length > 0 && (
        <div className={s.toolbar}>
          <FilterInput value={q} onChange={setQ} placeholder="Filter by name, tag, app or ID" label="Filter images" />
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
                { value: "created", label: "Newest first" },
                { value: "name", label: "Sort by name" },
                { value: "size", label: "Largest first" },
              ]}
            />
          </span>
        </div>
      )}

      {!images ? (
        error ? null : <TableSkeleton columns={COLUMNS} check />
      ) : images.length === 0 ? (
        <Empty title="No images on this server yet" action={<Button icon={<CloudDownload />} onClick={() => setPull({ ref: null })}>Download image</Button>}>
          Images are the packaged programs containers run from. Installing an app downloads its images; you can also download one here by name.
        </Empty>
      ) : shown.length === 0 ? (
        <Empty title={term ? `Nothing matches “${q.trim()}”` : filter === "unused" ? "Every image is in use" : "No image is in use"}>
          {term ? "Try part of the name, a tag, an app or an image ID." : filter === "unused" ? "Each one runs at least one container, so there's nothing to clean up." : "Start an app and its images show up here."}
        </Empty>
      ) : (
        <div className={`${s.table} ${s.images}`} role="table" aria-label="Images" aria-rowcount={shown.length + 1}>
          <div className={s.headRow} role="row">
            <span role="columnheader" className={s.check}>
              <Checkbox
                checked={allOn}
                indeterminate={!allOn && someOn}
                disabled={!allShownSelectable.length}
                onChange={(c) => setSelected(c ? new Set([...selected, ...allShownSelectable.map((i) => i.id)]) : new Set([...selected].filter((id) => !allShownSelectable.some((i) => i.id === id))))}
              />
              <span className="sr-only">Select all unused</span>
            </span>
            <SortHead k="name" label="Image" sort={sort} setSort={setSort} asc />
            <span role="columnheader">Used by</span>
            <SortHead k="size" label="Size" sort={sort} setSort={setSort} end />
            <SortHead k="created" label="Created" sort={sort} setSort={setSort} end />
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {shown.slice(0, limit).map((i) => {
            const isOpen = open === i.id;
            const canPick = selectable.includes(i.id);
            return (
              <div key={i.id} className={s.group} data-open={isOpen ? "" : undefined} data-selected={selected.has(i.id) ? "" : undefined} role="rowgroup">
                <div
                  role="row"
                  className={s.row}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a,button,[role=menu],[role=checkbox],label")) return;
                    setOpen(isOpen ? null : i.id);
                  }}
                >
                  <span role="cell" className={s.check}>
                    {canPick ? <Checkbox checked={selected.has(i.id)} onChange={(c) => toggle(i.id, c)} /> : null}
                    {canPick && <span className="sr-only">Select {imageName(i)}</span>}
                  </span>
                  <span role="cell" className={s.nameCell}>
                    <button type="button" className={s.nameButton} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : i.id)}>
                      <NavArrowRight className={s.chevron} strokeWidth={2} aria-hidden />
                      <RefName image={i} />
                    </button>
                    <span className={s.sub}>
                      <span className="mono">{i.short}</span>
                      {i.tags.length > 1 && ` · ${i.tags.length} tags`}
                      {i.app && !i.containers.length && i.olderOf ? null : i.app ? ` · ${appWords(i.app)}` : ""}
                    </span>
                  </span>
                  <span role="cell" className={s.useCol}>
                    <UsedBy refs={i.containers} empty={i.use === "leftover" ? "Not used" : "Not used"} note={noteFor(i)} />
                  </span>
                  <span role="cell" className={s.numCell}>
                    {fmt.bytes(i.size)}
                    {i.shared !== null && i.shared > 1024 * 1024 && <small>{fmt.bytes(i.shared)} shared</small>}
                  </span>
                  <span role="cell" className={s.dateCell}>
                    <Time ts={i.created} />
                  </span>
                  <span role="cell" className={s.actions}>
                    <Menu
                      trigger={
                        <IconButton label={`${imageName(i)} actions`} size="sm">
                          <MoreHoriz />
                        </IconButton>
                      }
                      items={menuFor(i)}
                    />
                  </span>
                </div>
                {isOpen && <ImageDetail image={i} onRemove={() => askRemove(i)} onPull={(ref) => setPull({ ref })} />}
              </div>
            );
          })}
          {shown.length > limit && (
            <div className={s.more}>
              <Button variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>
                Show {Math.min(PAGE, shown.length - limit)} more of {shown.length - limit}
              </Button>
            </div>
          )}
        </div>
      )}

      {chosen.length > 0 && (
        <div className={s.selectionBar} role="region" aria-label="Selected images">
          <span className="num">
            {fmt.plural(chosen.length, "image")} · at least {fmt.bytes(chosen.reduce((a, i) => a + i.own, 0))}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <Button variant="danger" size="sm" icon={<Trash />} onClick={askRemoveSelected}>
            Remove selected…
          </Button>
        </div>
      )}

      <PullDialog open={!!pull} imageRef={pull?.ref ?? null} onClose={() => setPull(null)} onDone={() => void mutate()} />
      <CleanupDialog kind="images" open={cleanup} onClose={() => setCleanup(false)} onDone={() => void mutate()} />
      {confirmNode}
    </Page>
  );
}

function ImageDetail({ image: i, onRemove, onPull }: { image: DockerImage; onRemove: () => void; onPull: (ref: string) => void }) {
  const fmt = useFormat();
  const blocked = i.use === "running" || i.guard?.level === "block";
  return (
    <div className={`${s.detail} appear`} role="region" aria-label={`${imageName(i)} details`}>
      <div className={s.detailGrid}>
        <dl className={s.kv}>
          <dt>ID</dt>
          <dd>
            <span className={s.refList}>
              <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span className={s.monoWrap}>{i.id}</span>
                <CopyButton value={i.id} label="Copy image ID" />
              </span>
            </span>
          </dd>
          {i.tags.length > 0 && (
            <>
              <dt>{i.tags.length === 1 ? "Tag" : "Tags"}</dt>
              <dd>
                <ul className={s.refList}>
                  {i.tags.map((t) => (
                    <li key={t}>
                      <span className={s.monoWrap}>{t}</span>
                      <CopyButton value={t} label={`Copy ${t}`} />
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          {i.digests.length > 0 && (
            <>
              <dt>{i.digests.length === 1 ? "Digest" : "Digests"}</dt>
              <dd>
                <ul className={s.refList}>
                  {i.digests.map((d) => (
                    <li key={d}>
                      <span className={s.monoWrap} title={d}>
                        {d.split("@")[0]}@{(d.split("@")[1] ?? "").slice(0, 19)}…
                      </span>
                      <CopyButton value={d} label="Copy digest" />
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          <dt>Created</dt>
          <dd>
            <Time ts={i.created} kind="dateTime" />
          </dd>
          <dt>Size</dt>
          <dd className="num">
            {fmt.bytes(i.size)}
            {i.shared !== null && i.shared > 0 && (
              <span className={s.faint}>
                {" "}
                · {fmt.bytes(i.shared)} shared with other images, {fmt.bytes(i.own)} its own
              </span>
            )}
          </dd>
          {i.baseOf.length > 0 && (
            <>
              <dt>Base of</dt>
              <dd className={s.monoWrap}>{i.baseOf.join(", ")}</dd>
            </>
          )}
          {i.app && (
            <>
              <dt>App</dt>
              <dd>
                <Link href={appHref(i.app)}>{appWords(i.app)}</Link>
                {i.olderOf && <span className={s.faint}> · an older version of its image</span>}
              </dd>
            </>
          )}
        </dl>
        <div>
          <p className={s.detailHead}>{i.containers.length ? `Used by ${fmt.plural(i.containers.length, "container")}` : "Not used by any container"}</p>
          {i.containers.length > 0 ? (
            <ul className={s.ctrList}>
              {i.containers.map((c) => (
                <li key={c.id}>
                  <span className={s.ctrMain}>
                    <StateLine state={c.line} size={13} />
                    <Link href={containerHref(c)} className="mono">
                      {c.name}
                    </Link>
                    {c.app && (
                      <span className={s.ctrMeta}>
                        <Link href={appHref(c.app)}>{appWords(c.app)}</Link>
                      </span>
                    )}
                  </span>
                  <span className={s.ctrEnd}>{c.state === "running" ? "Running" : c.state === "exited" ? "Stopped" : c.state}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.faint} style={{ fontSize: "var(--text-sm)" }}>
              {i.use === "leftover" ? "When an image is rebuilt or updated, the old one loses its tag and stays behind. It's safe to remove." : "Nothing runs from it right now. Removing it only matters if you plan to start something from it again."}
            </p>
          )}
          <div className={s.detailActions}>
            {i.tags[0] && (
              <Button size="sm" icon={<CloudDownload />} onClick={() => onPull(i.tags[0]!)}>
                Download again
              </Button>
            )}
            <Button size="sm" variant="danger" icon={<Trash />} disabled={blocked} onClick={onRemove}>
              {i.containers.length && !blocked ? "Remove with its containers…" : "Remove image…"}
            </Button>
          </div>
          {(i.guard || i.use === "running") && (
            <p className={s.below}>{i.guard ? i.guard.message : `It can't be removed while ${i.app?.name ?? "a container"} runs on it.`}</p>
          )}
        </div>
      </div>
    </div>
  );
}
