"use client";
import * as React from "react";
import { MoreHoriz, EditPencil, Trash, Home, FolderPlus } from "iconoir-react";
import type { VoiceChannel, VoiceLive } from "@/server/voice/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { Field, Input, TextArea } from "@/components/ui/Field";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Select } from "@/components/ui/Select";
import { Panel } from "@/components/ui/Surface";
import { ApiError } from "@/lib/client/api";
import { act, people, quiet } from "./client";
import { channelPath, layoutTree, subtree, type TreeRow } from "./tree";
import s from "./voice.module.css";

export type ChannelEdit = { kind: "create"; parent: number } | { kind: "edit"; id: number };

const RAIL = 22;
const railX = (level: number) => 18 + (level - 1) * RAIL + 6;

/** The channel tree, drawn in hairlines, with how many people are in each channel. */
export function Channels({ appId, live, rootName, onEdit, onChanged }: { appId: string; live: VoiceLive; rootName: string | null; onEdit: (e: ChannelEdit) => void; onChanged: () => void }) {
  const [confirm, confirmNode] = useConfirm();
  const rows = React.useMemo(() => layoutTree(live.channels, live.users), [live.channels, live.users]);
  const byId = React.useMemo(() => new Map(live.channels.map((c) => [c.id, c])), [live.channels]);
  const nameOf = (c: VoiceChannel) => (c.id === 0 && rootName ? rootName : c.name);

  const askDelete = (r: TreeRow) => {
    const parent = byId.get(r.channel.parent);
    const inside = r.descendants;
    confirm({
      title: `Delete ${r.channel.name}?`,
      consequences: [
        r.total === 0 ? "Nobody is in it right now." : `${people(r.total)} in it ${r.total === 1 ? "moves" : "move"} up to ${parent ? nameOf(parent) : "the channel above"}.`,
        inside ? `The ${inside === 1 ? "channel" : `${inside} channels`} inside it ${inside === 1 ? "goes" : "go"} too.` : "There are no channels inside it.",
        ...(subtree(r.channel.id, live.channels).has(live.defaultChannel) ? [`New people land in ${nameOf(byId.get(0) ?? r.channel)} instead.`] : []),
        "Its description and permissions are deleted. Mumble can't undo this.",
      ],
      confirmLabel: "Delete channel",
      variant: "dangerSolid",
      onConfirm: async () => {
        if (await act(appId, { op: "channel.delete", id: r.channel.id })) onChanged();
      },
    });
  };

  function items(r: TreeRow): MenuEntry[] {
    const c = r.channel;
    const out: MenuEntry[] = [{ label: "Add a channel inside…", icon: <FolderPlus />, onSelect: () => onEdit({ kind: "create", parent: c.id }) }];
    if (c.id !== 0) out.push({ label: "Edit…", description: "Name, where it sits, description", icon: <EditPencil />, onSelect: () => onEdit({ kind: "edit", id: c.id }) });
    if (c.id !== live.defaultChannel) {
      out.push({
        label: "Make new people land here",
        icon: <Home />,
        onSelect: () => void act(appId, { op: "channel.default", id: c.id }).then((ok) => ok && onChanged()),
      });
    }
    if (c.id !== 0) out.push("separator", { label: "Delete…", icon: <Trash />, danger: true, onSelect: () => askDelete(r) });
    return out;
  }

  return (
    <Panel title="Channels" meta={live.channels.length > 1 ? <span className={s.num}>{live.channels.length - 1}</span> : undefined} flush>
      <ul className={s.tree}>
        {rows.map((r) => {
          const c = r.channel;
          const isDefault = c.id === live.defaultChannel;
          return (
            <li key={c.id} className={s.node} style={{ "--depth": r.depth } as React.CSSProperties} data-root={c.id === 0 ? "" : undefined} data-empty={r.total === 0 && c.id !== 0 ? "" : undefined}>
              {(r.depth > 0 || r.descendants > 0) && (
                <span className={s.guides} aria-hidden>
                  {r.rails.map((on, i) => {
                    const level = i + 1;
                    if (level === r.depth) return <span key={i} className={s.elbow} data-last={String(r.last)} style={{ left: railX(level) }} />;
                    return on ? <span key={i} style={{ left: railX(level) }} /> : null;
                  })}
                  {r.descendants > 0 && <span className={s.trunk} style={{ left: railX(r.depth + 1) }} />}
                </span>
              )}
              <div className={s.nodeMain}>
                <span className={s.nodeName} title={c.description ? stripTags(c.description) : undefined}>
                  {nameOf(c)}
                </span>
                {r.here.length > 0 && (
                  <span className={s.count}>
                    {r.here.length}
                    <span className="sr-only"> {r.here.length === 1 ? "person" : "people"} here</span>
                  </span>
                )}
                {isDefault && (
                  <span className={s.landing} title="New people land here">
                    <Home aria-hidden />
                    <span className={s.landingText}>New people land here</span>
                  </span>
                )}
              </div>
              <Menu trigger={<IconButton label={`Actions for ${nameOf(c)}`} size="sm" variant="ghost"><MoreHoriz /></IconButton>} items={items(r)} />
              {r.here.length > 0 && <span className={s.nodePeople}>{r.here.map((u) => u.name).join(", ")}</span>}
            </li>
          );
        })}
      </ul>
      {live.channels.length <= 1 && (
        <div className={s.panelNote}>
            <p className={s.hint}>Everyone talks in one room until you add channels. People can move between channels themselves in their Mumble app.</p>
          </div>
      )}
      {confirmNode}
    </Panel>
  );
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

/** Create a channel, or rename, move and describe one. */
export function ChannelDialog({ appId, live, edit, onClose, onChanged }: { appId: string; live: VoiceLive; edit: ChannelEdit | null; onClose: () => void; onChanged: () => void }) {
  const byId = React.useMemo(() => new Map(live.channels.map((c) => [c.id, c])), [live.channels]);
  const [name, setName] = React.useState("");
  const [parent, setParent] = React.useState("0");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const last = React.useRef(edit);
  if (edit) last.current = edit;
  const e = edit ?? last.current;
  const current = e?.kind === "edit" ? byId.get(e.id) : undefined;

  // Fill the form each time it opens (not on every poll, which would wipe what's typed).
  const openKey = edit ? JSON.stringify(edit) : null;
  React.useEffect(() => {
    if (!edit) return;
    setError(null);
    if (edit.kind === "create") {
      setName("");
      setParent(String(edit.parent));
      setDescription("");
    } else {
      const c = byId.get(edit.id);
      setName(c?.name ?? "");
      setParent(String(c?.parent ?? 0));
      setDescription(c?.description ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  const blocked = current ? subtree(current.id, live.channels) : new Set<number>();
  const options = live.channels
    .filter((c) => !blocked.has(c.id))
    .map((c) => ({ value: String(c.id), label: c.id === 0 ? "The top level" : channelPath(c, byId) }))
    .sort((a, b) => (a.value === "0" ? -1 : b.value === "0" ? 1 : a.label.localeCompare(b.label)));

  async function save() {
    if (!e) return;
    setBusy(true);
    setError(null);
    try {
      const ok =
        e.kind === "create"
          ? await act(appId, { op: "channel.create", name, parent: Number(parent) }, { inline: true })
          : await act(
              appId,
              {
                op: "channel.update",
                id: e.id,
                ...(name !== current?.name ? { name } : {}),
                ...(Number(parent) !== current?.parent ? { parent: Number(parent) } : {}),
                ...(description !== (current?.description ?? "") ? { description } : {}),
              },
              { inline: true },
            );
      if (ok) {
        onChanged();
        onClose();
      }
    } catch (err) {
      if (!quiet(err)) setError(err instanceof ApiError ? { message: err.message, field: err.field } : { message: "That didn't work." });
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (f: string) => (error && (error.field === f || (!error.field && f === "name")) ? error.message : null);
  const title = e?.kind === "create" ? "New channel" : `Edit ${current?.name ?? "channel"}`;

  return (
    <Dialog
      open={!!edit}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void save()}>
            {e?.kind === "create" ? "Add channel" : "Save"}
          </Button>
        </>
      }
    >
      <form
        className={s.dialogStack}
        onSubmit={(ev) => {
          ev.preventDefault();
          if (name.trim()) void save();
        }}
      >
        <Field label="Name" error={fieldError("name")}>
          <Input value={name} onChange={(ev) => setName(ev.target.value)} maxLength={100} autoFocus autoComplete="off" placeholder="Games" />
        </Field>
        <Field label="Inside" error={fieldError("parent")} description={current && blocked.size > 1 ? "The channels inside it move along with it." : undefined}>
          <Select aria-label="Inside" value={parent} onChange={setParent} options={options} />
        </Field>
        {e?.kind === "edit" && (
          <Field label="Description" optional error={fieldError("description")} description="Shown when someone points at the channel in their Mumble app. Simple HTML works here.">
            <TextArea value={description} onChange={(ev) => setDescription(ev.target.value)} rows={3} maxLength={5000} />
          </Field>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
