"use client";
import * as React from "react";
import { Folder, NavArrowUp } from "iconoir-react";
import type { Listing } from "@/lib/files-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input, Segmented } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "./bits";
import s from "./people.module.css";

/**
 * Share a folder: browse to it, name it, choose view or change. With `userId` it's for that person;
 * otherwise the dialog asks who (from `members`).
 */
export function ShareFolderDialog({
  open,
  onOpenChange,
  userId,
  members,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userId?: string;
  members: { id: string; name: string }[];
  onSaved: () => void;
}) {
  const [who, setWho] = React.useState(userId ?? members[0]?.id ?? "");
  const name = members.find((m) => m.id === who)?.name ?? "them";
  const [path, setPath] = React.useState("");
  const [browse, setBrowse] = React.useState("/");
  const [label, setLabel] = React.useState("");
  const [access, setAccess] = React.useState<"read" | "write">("read");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<{ message: string; field?: string } | null>(null);
  const { data: listing, error: listErr, isLoading } = useApi<Listing>(open ? `/api/files/list?path=${encodeURIComponent(browse)}&limit=400&foldersFirst=1` : null);

  React.useEffect(() => {
    if (open) {
      setWho(userId ?? members[0]?.id ?? "");
      setPath("");
      setBrowse("/");
      setLabel("");
      setAccess("read");
      setErr(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId]);

  const go = (p: string) => {
    setBrowse(p);
    setPath(p === "/" ? "" : p);
    setErr(null);
  };

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.post("/api/people/grants", { userId: who, path: path.trim(), label: label.trim() || null, access });
      toast.success(`Shared ${label.trim() || path} with ${name}`);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) setErr({ message: errorMessage(e), field: e instanceof ApiError ? e.field : undefined });
    } finally {
      setBusy(false);
    }
  }

  const dirs = (listing?.entries ?? []).filter((e) => e.type === "dir" || (e.type === "symlink" && e.link?.type === "dir"));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title={userId ? `Share a folder with ${name}` : "Share a folder"}
      description="They'll see it in Files. Everything inside it is included."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!path.trim() || !who} onClick={() => void save()}>
            Share folder
          </Button>
        </>
      }
    >
      <div className={s.form}>
        {!userId && members.length > 1 && (
          <Field label="With">
            <Segmented aria-label="Share with" value={who} onChange={setWho} options={members.map((m) => ({ value: m.id, label: m.name }))} />
          </Field>
        )}
        <div className={s.picker}>
          <div className={s.crumbs}>
            {(listing?.breadcrumbs ?? [{ name: "/", path: "/" }]).map((c, i, arr) => (
              <React.Fragment key={c.path}>
                <button type="button" className={s.crumb} onClick={() => go(c.path)}>
                  {i === 0 ? "/" : c.name}
                </button>
                {i > 0 && i < arr.length - 1 && <span className={s.muted}>/</span>}
              </React.Fragment>
            ))}
          </div>
          {listErr ? (
            <p className={s.pickerEmpty}>{listErr.message}</p>
          ) : isLoading && !listing ? (
            <div className={s.skeletons}>
              <Skeleton height={20} />
              <Skeleton height={20} />
              <Skeleton height={20} />
            </div>
          ) : (
            <ul className={s.dirs} role="list" aria-label="Folders">
              {listing?.parent && (
                <li>
                  <button type="button" className={s.dir} onClick={() => go(listing.parent!)}>
                    <NavArrowUp aria-hidden />
                    <span>Up one level</span>
                  </button>
                </li>
              )}
              {dirs.map((d) => (
                <li key={d.path}>
                  <button type="button" className={s.dir} onClick={() => go(d.path)} title={d.path}>
                    <Folder aria-hidden />
                    <span>{d.name}</span>
                  </button>
                </li>
              ))}
              {dirs.length === 0 && <li className={s.pickerEmpty}>No folders in here.</li>}
            </ul>
          )}
        </div>
        <Field label="Folder" error={err?.field === "path" ? err.message : null} description="Pick above, or type a path.">
          <Input mono value={path} onChange={(e) => setPath(e.target.value)} placeholder="/mnt/hdd2/films" spellCheck={false} autoCapitalize="off" />
        </Field>
        <div className={s.row2}>
          <Field label="Name it" optional description="What they see instead of the path.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="e.g. Films" />
          </Field>
          <Field label="They can">
            <Segmented
              aria-label="Access"
              value={access}
              onChange={setAccess}
              options={[
                { value: "read", label: "View" },
                { value: "write", label: "View and change" },
              ]}
            />
          </Field>
        </div>
        {access === "write" && <Notice tone="neutral">They'll be able to add, rename, move and delete files in this folder (deleted files go to the trash first).</Notice>}
        {err && err.field !== "path" && (
          <p className={s.error} role="alert">
            {err.message}
          </p>
        )}
      </div>
    </Dialog>
  );
}
