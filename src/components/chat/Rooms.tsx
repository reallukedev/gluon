"use client";
import * as React from "react";
import { MoreHoriz, Copy, Trash, Plus } from "iconoir-react";
import type { ChatHostSnapshot, ChatRoom } from "@/lib/chat-types";
import { api, ApiError } from "@/lib/client/api";
import { copyText } from "@/lib/client/clipboard";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { AffixInput, Field, Input, Switch, TextArea } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { Select } from "@/components/ui/Select";
import { Notice, Panel } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import { Jid } from "./Credentials";
import s from "./chat.module.css";

const base = (appId: string) => `/api/chat/${encodeURIComponent(appId)}`;
const quiet = (e: unknown) => e instanceof ApiError && e.code === "reauth_cancelled";
const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

function kind(r: ChatRoom) {
  const words = [r.membersOnly ? "Members only" : "Anyone with the address can join", r.public ? "listed" : null].filter(Boolean);
  return words.join(", ");
}

export function Rooms({ appId, host, onChanged }: { appId: string; host: ChatHostSnapshot; onChanged: () => void }) {
  const [confirm, confirmNode] = useConfirm();
  const [making, setMaking] = React.useState(false);
  const service = host.groupsHost!;

  const close = (r: ChatRoom) =>
    confirm({
      title: `Close ${r.name ?? r.jid}?`,
      consequences: [r.occupants ? `${r.occupants} ${r.occupants === 1 ? "person is" : "people are"} in it now and will be told it closed.` : "Nobody is in it right now.", "Its history on the server is deleted.", "Anyone can make a group chat with the same address again later."],
      confirmLabel: "Close group chat",
      variant: "danger",
      onConfirm: async () => {
        try {
          await api.del(`${base(appId)}/rooms`, { jid: r.jid });
          toast.success(`Closed ${r.name ?? r.jid}`);
          onChanged();
        } catch (e) {
          if (!quiet(e)) throw e;
        }
      },
    });

  return (
    <Panel
      title="Group chats"
      meta={
        <Button size="sm" icon={<Plus />} onClick={() => setMaking(true)}>
          New group chat
        </Button>
      }
      flush
    >
      {host.rooms.length === 0 ? (
        <div className={s.empty}>
          <p>No group chats yet. Make one here, or create it from any chat app; it shows up here either way.</p>
        </div>
      ) : (
        <ul className={s.rooms}>
          {host.rooms.map((r) => (
            <li key={r.jid} className={s.room}>
              <span className={s.roomText}>
                <span className={s.roomName}>{r.name ?? r.jid.split("@")[0]}</span>
                <span className={`${s.roomSub} mono`} title={r.description ?? undefined}>
                  <Jid jid={r.jid} />
                </span>
                <span className={s.roomSub}>{kind(r)}</span>
              </span>
              <span className={`${s.roomCount} num`}>{r.occupants === 0 ? <span className={s.muted}>Nobody in it</span> : `${r.occupants} in it now`}</span>
              <Menu
                trigger={
                  <IconButton label={`Actions for ${r.name ?? r.jid}`} size="sm">
                    <MoreHoriz />
                  </IconButton>
                }
                items={[
                  { label: "Copy address", icon: <Copy />, onSelect: () => void copyText(r.jid).then((ok) => (ok ? toast.success("Copied", { description: r.jid }) : toast.error("Couldn't copy"))) },
                  "separator",
                  { label: "Close group chat…", icon: <Trash />, danger: true, onSelect: () => close(r) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      {confirmNode}
      <NewRoomDialog open={making} onOpenChange={setMaking} appId={appId} service={service} host={host} onCreated={onChanged} />
    </Panel>
  );
}

function NewRoomDialog({ open, onOpenChange, appId, service, host, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; appId: string; service: string; host: ChatHostSnapshot; onCreated: () => void }) {
  const [name, setName] = React.useState("");
  const [room, setRoom] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [description, setDescription] = React.useState("");
  const [membersOnly, setMembersOnly] = React.useState(true);
  const [listed, setListed] = React.useState(false);
  const owners = host.accounts.filter((a) => a.enabled);
  const [owner, setOwner] = React.useState<string>("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [general, setGeneral] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setRoom("");
    setTouched(false);
    setDescription("");
    setMembersOnly(true);
    setListed(false);
    setOwner(owners.find((a) => a.role === "owner" || a.role === "admin")?.jid ?? owners[0]?.jid ?? "");
    setErrors({});
    setGeneral(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const address = touched ? room : slug(name);

  async function create() {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Give it a name.";
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(address)) e.room = "Use lowercase letters, numbers, dots, dashes or underscores.";
    setErrors(e);
    setGeneral(null);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await api.post<{ jid: string }>(`${base(appId)}/rooms`, { service, room: address, name: name.trim(), description: description.trim() || null, public: listed, membersOnly: membersOnly && !!owner, owner: owner || null });
      toast.success(`Made ${name.trim()}`, { description: r.jid });
      onCreated();
      onOpenChange(false);
    } catch (err) {
      if (quiet(err)) return;
      if (err instanceof ApiError && err.field) setErrors({ [err.field]: err.message });
      else setGeneral(err instanceof Error ? err.message : "The group chat wasn't made.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title="New group chat"
      description="It stays until you close it, even when everyone leaves."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void create()}>
            Make group chat
          </Button>
        </>
      }
    >
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        {general && (
          <Notice tone="fault" title="The group chat wasn't made">
            {general}
          </Notice>
        )}
        <Field label="Name" error={errors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Family" autoFocus />
        </Field>
        <Field label="Address" error={errors.room} description="What people join. Apps also find it by name.">
          <AffixInput
            mono
            after={`@${service}`}
            value={address}
            onChange={(e) => {
              setTouched(true);
              setRoom(e.target.value.replace(/\s/g, "").toLowerCase());
            }}
            spellCheck={false}
            autoCapitalize="off"
            placeholder="family"
          />
        </Field>
        <Field label="Description" optional>
          <TextArea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={400} />
        </Field>
        {owners.length > 0 && (
          <Field label="Owner" description="Can invite people, change the room and remove messages, from their chat app.">
            <Select aria-label="Owner" value={owner} onChange={setOwner} options={owners.map((a) => ({ value: a.jid, label: a.jid }))} />
          </Field>
        )}
        <div className={`${s.setting} ${s.settingFlat}`} data-toggle="">
          <div className={s.settingText}>
            <span className={s.settingTitle}>Members only</span>
            <p className={s.settingDesc}>{owners.length ? "Only people the owner adds can join. Turn off for a room anyone with the address can walk into." : "Needs an owner to add people, so add an account first."}</p>
          </div>
          <div className={s.settingControl}>
            <Switch checked={membersOnly && owners.length > 0} disabled={owners.length === 0} onChange={setMembersOnly} aria-label="Members only" />
          </div>
        </div>
        <div className={`${s.setting} ${s.settingFlat}`} data-toggle="">
          <div className={s.settingText}>
            <span className={s.settingTitle}>List it</span>
            <p className={s.settingDesc}>Show it when people browse this server&rsquo;s group chats.</p>
          </div>
          <div className={s.settingControl}>
            <Switch checked={listed} onChange={setListed} aria-label="List it" />
          </div>
        </div>
      </form>
    </Dialog>
  );
}
