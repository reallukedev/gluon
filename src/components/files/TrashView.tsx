"use client";
import * as React from "react";
import { MoreHoriz, Trash, Undo } from "iconoir-react";
import type { FileJob, TrashItem, TrashSummary } from "@/lib/files-types";
import { api, ApiError } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Button, IconButton } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { useConfirm } from "@/components/ui/Dialog";
import { Empty, Notice, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { KindIcon, baseName, parentOf } from "./lib";
import s from "./files.module.css";

interface Props {
  data: TrashSummary | undefined;
  error: ApiError | undefined;
  isAdmin: boolean;
  refresh: () => void;
  onJob: (job: FileJob) => void;
  onNavigate: (path: string) => void;
}

/** What's been moved to the trash, per drive; restore with conflict handling; admins delete for good. */
export function TrashView({ data, error, isAdmin, refresh, onJob, onNavigate }: Props) {
  const fmt = useFormat();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [confirm, confirmNode] = useConfirm();
  const items = data?.items ?? [];
  const chosen = items.filter((i) => selected.has(i.id));

  async function restore(list: TrashItem[], conflict: "fail" | "rename" = "fail") {
    try {
      const r = await api.post<{ restored: { id: string; path: string }[] }>("/api/files/trash/restore", { ids: list.map((i) => i.id), conflict });
      setSelected(new Set());
      refresh();
      const first = r.restored[0];
      toast.success(r.restored.length === 1 ? `Restored ${baseName(first!.path)}` : `Restored ${fmt.plural(r.restored.length, "item")}`, first ? { action: { label: "Show", onClick: () => onNavigate(parentOf(first.path)) } } : undefined);
    } catch (e) {
      if (e instanceof ApiError && e.code === "conflict") {
        const clash = list.find((i) => i.id === e.details?.id) ?? list[0]!;
        confirm({
          title: `Something called “${clash.name}” is already there`,
          description: <>Something new is at <span className="mono">{clash.originalPath}</span>. Gluon won't replace it.</>,
          consequences: [`${list.length > 1 ? "Items that clash are" : "It's"} restored next to it as “${clash.name.replace(/(\.[^.]+)?$/, " (restored)$1")}”.`, "Nothing is overwritten."],
          confirmLabel: "Restore with a new name",
          variant: "primary",
          onConfirm: () => restore(list, "rename"),
        });
        return;
      }
      toast.error("Couldn't restore", { description: e instanceof Error ? e.message : undefined });
    }
  }

  function deleteForever(list: TrashItem[] | "all") {
    const n = list === "all" ? items.length : list.length;
    const bytes = (list === "all" ? items : list).reduce((a, i) => a + (i.size ?? 0), 0);
    const byFs = list === "all" ? (data?.byFilesystem ?? []) : [];
    confirm({
      title: list === "all" ? "Empty the trash?" : n === 1 ? `Delete “${list[0]!.name}” forever?` : `Delete ${fmt.plural(n, "item")} forever?`,
      consequences: [
        `Permanently deletes ${fmt.plural(n, "item")}${bytes ? ` (${fmt.bytes(bytes)})` : ""}.`,
        ...byFs.map((f) => `Frees ${fmt.bytes(f.bytes)} on ${f.fsRoot}.`),
        "This can't be undone.",
      ],
      confirmLabel: list === "all" ? "Empty trash" : "Delete forever",
      holdMs: list === "all" ? 1200 : undefined,
      onConfirm: async () => {
        const r = await api.del<{ job: FileJob }>("/api/files/trash", list === "all" ? { all: true } : { ids: list.map((i) => i.id) });
        onJob(r.job);
        setSelected(new Set());
      },
    });
  }

  if (error) {
    return (
      <Notice tone="fault" title="Can't open the trash">
        {error.message}
      </Notice>
    );
  }
  if (!data) {
    return (
      <div className={s.table}>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={s.trashRow}>
            <span />
            <Skeleton width={`${40 + ((i * 11) % 40)}%`} />
          </div>
        ))}
      </div>
    );
  }
  if (!items.length) {
    return (
      <Empty title="The trash is empty">
        Things you delete in Files land here first, on the same drive they came from, so you can put them back. {isAdmin ? "Emptying the trash frees their space." : "Only admins can delete things for good."}
      </Empty>
    );
  }

  const allSelected = selected.size === items.length;
  return (
    <div className={s.stack}>
      {data.byFilesystem.length > 0 && (
        <ul className={s.trashFs} aria-label="Space held by the trash">
          {data.byFilesystem.map((f) => (
            <li key={f.fsRoot}>
              <span className="mono">{f.fsRoot}</span>
              <span className="num muted">
                {fmt.bytes(f.bytes)} · {fmt.plural(f.items, "item")}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className={s.trashTools}>
        <Button size="sm" icon={<Undo />} disabled={!chosen.length} onClick={() => void restore(chosen)}>
          Restore{chosen.length ? ` ${chosen.length}` : ""}
        </Button>
        {isAdmin && (
          <>
            <Button size="sm" variant="danger" disabled={!chosen.length} onClick={() => deleteForever(chosen)}>
              Delete forever
            </Button>
            <span className={s.spacer} />
            <Button size="sm" variant="danger" icon={<Trash />} onClick={() => deleteForever("all")}>
              Empty trash
            </Button>
          </>
        )}
      </div>
      <div className={s.table} role="table" aria-label="Trash">
        <div className={`${s.trashRow} ${s.trashHead}`} role="row">
          <span role="columnheader">
            <Checkbox checked={allSelected} indeterminate={!allSelected && selected.size > 0} onChange={(c) => setSelected(new Set(c ? items.map((i) => i.id) : []))} />
          </span>
          <span role="columnheader">Name</span>
          <span role="columnheader">Was in</span>
          <span role="columnheader">Deleted</span>
          <span role="columnheader" className={s.sizeCol}>
            Size
          </span>
          <span role="columnheader" className="sr-only">
            Actions
          </span>
        </div>
        {items.map((i) => (
          <div key={i.id} className={s.trashRow} role="row" data-missing={i.present ? undefined : ""}>
            <span role="cell">
              <Checkbox
                checked={selected.has(i.id)}
                onChange={(c) => {
                  const n = new Set(selected);
                  if (c) n.add(i.id);
                  else n.delete(i.id);
                  setSelected(n);
                }}
              />
            </span>
            <span role="cell" className={s.nameCell}>
              <KindIcon kind={i.isDir ? "folder" : "other"} className={s.kindIcon} />
              <span className={s.nameText}>
                <span className="truncate" title={i.name}>
                  {i.name}
                </span>
                {!i.present && <span className={s.linkNote}>removed outside Gluon</span>}
              </span>
            </span>
            <span role="cell" className="mono truncate" title={i.originalPath}>
              {parentOf(i.originalPath)}
            </span>
            <span role="cell" className="num muted">
              <Time ts={i.deletedAt} />
              {i.deletedByName && isAdmin && ` · ${i.deletedByName}`}
            </span>
            <span role="cell" className={`${s.sizeCol} num`}>
              {i.size !== null ? fmt.bytes(i.size) : ""}
            </span>
            <span role="cell" className={s.rowActions}>
              <Menu
                trigger={
                  <IconButton label={`${i.name} actions`} size="sm" tooltip={false}>
                    <MoreHoriz />
                  </IconButton>
                }
                items={[
                  { label: i.originalTaken ? "Restore with a new name" : "Restore", icon: <Undo />, onSelect: () => void restore([i], i.originalTaken ? "rename" : "fail"), disabled: !i.present },
                  { label: "Show original folder", onSelect: () => onNavigate(parentOf(i.originalPath)) },
                  ...(isAdmin ? (["separator", { label: "Delete forever", icon: <Trash />, danger: true, onSelect: () => deleteForever([i]) }] as const) : []),
                ]}
              />
            </span>
          </div>
        ))}
      </div>
      {confirmNode}
    </div>
  );
}
