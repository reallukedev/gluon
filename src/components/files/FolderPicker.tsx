"use client";
import * as React from "react";
import { FolderPlus, NavArrowRight, NavArrowUp } from "iconoir-react";
import type { Listing, Places } from "@/lib/files-types";
import { api, useApi } from "@/lib/client/api";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import { KindIcon, PlaceIcon, isDirLike, joinPath } from "./lib";
import s from "./files.module.css";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  confirmLabel: (folderName: string) => string;
  initialPath: string;
  places: Places | undefined;
  onPick: (path: string) => void;
}

/** Browse to a destination folder (for Copy to…/Move to…). Only folders you can change are choosable. */
export function FolderPicker({ open, onOpenChange, title, confirmLabel, initialPath, places, onPick }: Props) {
  const [path, setPath] = React.useState(initialPath);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  React.useEffect(() => {
    if (open) setPath(initialPath);
  }, [open, initialPath]);
  const { data, error, isLoading, mutate } = useApi<Listing>(open ? `/api/files/list?path=${encodeURIComponent(path)}&limit=1000&sort=name` : null, { keepPreviousData: false });
  const dirs = (data?.entries ?? []).filter(isDirLike);
  const writable = data?.access === "write" && !data.protectedReason;
  const shortcuts = [...(places?.pins ?? []), ...(places?.places ?? [])].filter((p) => !p.missing);

  async function create() {
    try {
      const e = await api.post<{ path: string }>("/api/files/mkdir", { path, name });
      setCreating(false);
      setName("");
      await mutate();
      setPath(e.path);
    } catch (err) {
      toast.error("Couldn't create the folder", { description: err instanceof Error ? err.message : undefined });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="wide"
      footerStart={
        writable ? (
          <Button variant="ghost" size="sm" icon={<FolderPlus />} onClick={() => setCreating(true)}>
            New folder
          </Button>
        ) : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!writable}
            onClick={() => {
              onPick(data?.path ?? path);
              onOpenChange(false);
            }}
          >
            {confirmLabel(data?.name ?? path)}
          </Button>
        </>
      }
    >
      <div className={s.picker}>
        <nav className={s.pickerPlaces} aria-label="Places">
          {shortcuts.map((p) => (
            <button key={p.id} type="button" className={s.pickerPlace} data-active={p.path === path ? "" : undefined} onClick={() => setPath(p.path)} title={p.path}>
              <PlaceIcon kind={p.kind} />
              <span className="truncate">{p.label}</span>
            </button>
          ))}
        </nav>
        <div className={s.pickerMain}>
          <div className={s.pickerHead}>
            <IconButton label="Up one folder" size="sm" disabled={!data?.parent} onClick={() => data?.parent && setPath(data.parent)}>
              <NavArrowUp />
            </IconButton>
            <span className="mono truncate" title={data?.path ?? path}>
              {data?.path ?? path}
            </span>
          </div>
          {creating && (
            <form
              className={s.pickerNew}
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) void create();
              }}
            >
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Folder name" aria-label="New folder name" />
              <Button type="submit" size="sm" variant="primary" disabled={!name.trim()}>
                Create
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </form>
          )}
          <div className={s.pickerList} role="list">
            {error ? (
              <div style={{ padding: 12 }}>
                <Notice tone="fault" title="Can't open this folder">
                  {error.message}
                </Notice>
              </div>
            ) : isLoading || !data ? (
              Array.from({ length: 6 }, (_, i) => (
                <div key={i} className={s.pickerRow}>
                  <Skeleton width={`${40 + ((i * 17) % 40)}%`} />
                </div>
              ))
            ) : dirs.length === 0 ? (
              <p className="muted" style={{ padding: "14px 12px", fontSize: "var(--text-sm)" }}>
                No folders inside. {writable ? "Choose this folder, or create one." : ""}
              </p>
            ) : (
              dirs.map((d) => (
                <button key={d.path} type="button" role="listitem" className={s.pickerRow} onClick={() => setPath(joinPath(data.path, d.name))} title={d.name}>
                  <KindIcon kind="folder" />
                  <span className="truncate">{d.name}</span>
                  <NavArrowRight className={s.pickerChevron} />
                </button>
              ))
            )}
          </div>
          {data && !writable && (
            <p className="muted" style={{ fontSize: "var(--text-sm)", marginTop: 10 }}>
              {data.protectedReason ?? "You can't put things here. Choose a folder you can change."}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
