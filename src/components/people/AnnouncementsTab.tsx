"use client";
import * as React from "react";
import { Megaphone, MoreHoriz, Plus } from "iconoir-react";
import type { Announcement } from "@/lib/people-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Empty, Panel, Skeleton } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { Field, Input, Segmented, TextArea } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { Select } from "@/components/ui/Select";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { errorMessage, LoadError } from "./bits";
import s from "./people.module.css";

const URL_ALL = "/api/household/announcements?all=1";

/** Banners everyone sees at the top of Gluon ("Power cut tonight at 10"). */
export function AnnouncementsTab() {
  const { data, error, isLoading, mutate } = useApi<Announcement[]>(URL_ALL, { refresh: 60_000 });
  const [editing, setEditing] = React.useState<Announcement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();
  const edit = (a: Announcement | null) => {
    setEditing(a);
    setOpen(true);
  };
  const takeDown = (a: Announcement) =>
    confirm({
      title: a.active ? "Take this announcement down?" : "Delete this announcement?",
      consequences: a.active ? ["It disappears for everyone straight away."] : ["It's removed from this list."],
      confirmLabel: a.active ? "Take down" : "Delete",
      variant: a.active ? "primary" : "dangerSolid",
      onConfirm: async () => {
        await api.del(`/api/household/announcements/${encodeURIComponent(a.id)}`);
        toast.success(a.active ? "Taken down" : "Deleted");
        void mutate();
      },
    });

  const active = (data ?? []).filter((a) => a.active);
  const ended = (data ?? []).filter((a) => !a.active);

  if (error && !data) return <LoadError what="announcements" error={error} />;

  return (
    <>
      <Panel
        title="Showing now"
        meta={
          <Button size="sm" variant="primary" icon={<Plus />} onClick={() => edit(null)}>
            New announcement
          </Button>
        }
        flush
      >
        {isLoading && !data ? (
          <div className={s.skeletons}>
            <Skeleton height={44} />
          </div>
        ) : active.length === 0 ? (
          <Empty title="Nothing announced" action={<Button icon={<Megaphone />} onClick={() => edit(null)}>Write an announcement</Button>}>
            Announcements appear as a banner for everyone in the household, e.g. “Power cut tonight from 10, everything will be off for an hour.” Tie one to an app and
            only people who use that app see it.
          </Empty>
        ) : (
          <AnnList items={active} onEdit={edit} onRemove={takeDown} />
        )}
      </Panel>
      {ended.length > 0 && (
        <Panel title="Ended" meta={<span className="num">{ended.length}</span>} flush>
          <AnnList items={ended} onEdit={edit} onRemove={takeDown} />
        </Panel>
      )}
      <AnnouncementDialog open={open} onOpenChange={setOpen} ann={editing} onSaved={() => void mutate()} />
      {confirmNode}
    </>
  );
}

function AnnList({ items, onEdit, onRemove }: { items: Announcement[]; onEdit: (a: Announcement) => void; onRemove: (a: Announcement) => void }) {
  return (
    <ul className={s.anns} role="list">
      {items.map((a) => (
        <li key={a.id} className={s.ann} data-ended={a.active ? undefined : ""}>
          <div>
            <p className={s.annMsg}>{a.message}</p>
            <p className={s.annSub}>
              {a.active ? <StateLine state="running" label="Showing" size={11} /> : <StateLine state="stopped" label="Ended" size={11} />}
              <span>{a.appName ? `Only for people who use ${a.appName}` : "Everyone"}</span>
              <span>
                {a.until ? (
                  <>
                    {a.active ? "until" : "ended"} <Time ts={a.until} kind="dateTime" />
                  </>
                ) : (
                  "until taken down"
                )}
              </span>
              <span>
                by {a.createdByName ?? "someone"} <Time ts={a.createdAt} />
              </span>
            </p>
          </div>
          <Menu
            trigger={
              <IconButton label="Announcement actions" size="sm">
                <MoreHoriz />
              </IconButton>
            }
            items={[
              { label: a.active ? "Edit" : "Show again", onSelect: () => onEdit(a) },
              { label: a.active ? "Take down" : "Delete", danger: !a.active, onSelect: () => onRemove(a) },
            ]}
          />
        </li>
      ))}
    </ul>
  );
}

type Until = "none" | "1h" | "tonight" | "tomorrow" | "week" | "custom";

function untilFrom(choice: Until, custom: string): number | null {
  const now = new Date();
  switch (choice) {
    case "none":
      return null;
    case "1h":
      return Date.now() + 3_600_000;
    case "tonight": {
      const d = new Date(now);
      d.setHours(23, 59, 0, 0);
      return d.getTime();
    }
    case "tomorrow": {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(23, 59, 0, 0);
      return d.getTime();
    }
    case "week":
      return Date.now() + 7 * 86_400_000;
    case "custom":
      return custom ? new Date(custom).getTime() : NaN;
  }
}

/** yyyy-mm-ddThh:mm in local time, for datetime-local inputs. */
function localInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function AnnouncementDialog({ open, onOpenChange, ann, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; ann: Announcement | null; onSaved: () => void }) {
  const fmt = useFormat();
  const { data: apps } = useApi<{ id: string; name: string }[]>(open ? "/api/apps" : null);
  const [message, setMessage] = React.useState("");
  const [app, setApp] = React.useState("");
  const [until, setUntil] = React.useState<Until>("none");
  const [custom, setCustom] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<{ message: string; field?: string } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setMessage(ann?.message ?? "");
    setApp(ann?.appId ?? "");
    const future = ann?.until && ann.until > Date.now();
    setUntil(ann?.active && future ? "custom" : "none");
    setCustom(ann?.active && future ? localInput(ann.until!) : localInput(Date.now() + 86_400_000));
    setErr(null);
  }, [open, ann]);

  const untilTs = untilFrom(until, custom);
  async function save() {
    if (Number.isNaN(untilTs)) return setErr({ message: "Pick when it should stop showing.", field: "until" });
    setBusy(true);
    setErr(null);
    const body = { message: message.trim(), appId: app || null, until: untilTs };
    try {
      if (ann?.active) await api.patch(`/api/household/announcements/${encodeURIComponent(ann.id)}`, body);
      else await api.post("/api/household/announcements", body);
      toast.success(ann?.active ? "Announcement updated" : "Announcement posted", { description: ann?.active ? undefined : "Everyone it's for sees it now." });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) setErr({ message: errorMessage(e), field: e instanceof ApiError ? e.field : undefined });
    } finally {
      setBusy(false);
    }
  }
  const appName = apps?.find((a) => a.id === app)?.name;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={ann?.active ? "Edit announcement" : "New announcement"}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!message.trim()} onClick={() => void save()}>
            {ann?.active ? "Save" : "Post it"}
          </Button>
        </>
      }
    >
      <div className={s.form}>
        <Field label="Message" error={err?.field === "message" ? err.message : null} description={`${message.length} of 500`}>
          <TextArea rows={3} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. Power cut tonight from 10. Everything will be off for about an hour." autoFocus />
        </Field>
        <Field label="Who sees it">
          <Select aria-label="Who sees it" value={app} onChange={setApp} options={[{ value: "", label: "Everyone" }, ...(apps ?? []).map((a) => ({ value: a.id, label: `People who use ${a.name}` }))]} />
        </Field>
        <Field label="Show it" error={err?.field === "until" ? err.message : null}>
          <Segmented
            aria-label="Show it until"
            value={until}
            onChange={setUntil}
            options={[
              { value: "none", label: "Until I take it down" },
              { value: "1h", label: "1 hour" },
              { value: "tonight", label: "Today" },
              { value: "tomorrow", label: "Tomorrow" },
              { value: "custom", label: "Until…" },
            ]}
          />
        </Field>
        {until === "custom" && (
          <Field label="Until" error={null}>
            <Input type="datetime-local" className="num" value={custom} min={localInput(Date.now())} onChange={(e) => setCustom(e.target.value)} />
          </Field>
        )}
        <div style={{ display: "grid", gap: 8 }}>
          <span className="label">Preview</span>
          <div className={s.banner} role="note">
            {message.trim() ? message : <span className={s.bannerEmpty}>Your message appears here.</span>}
          </div>
          <p className={s.hint}>
            {appName ? `Shown to people who use ${appName}` : "Shown to everyone"}
            {untilTs && !Number.isNaN(untilTs) ? ` until ${fmt.dateTime(untilTs)}` : " until you take it down"}.
          </p>
        </div>
        {err && !err.field && (
          <p className={s.error} role="alert">
            {err.message}
          </p>
        )}
      </div>
    </Dialog>
  );
}
