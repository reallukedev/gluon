"use client";
import * as React from "react";
import { MoreHoriz, MicrophoneMute, SoundOff, ArrowRight, LogOut, Microphone, SoundHigh, Copy } from "iconoir-react";
import { copyText } from "@/lib/client/clipboard";
import { toast } from "@/components/ui/Toast";
import type { VoiceLive, VoiceUser } from "@/server/voice/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Panel } from "@/components/ui/Surface";
import { Tooltip } from "@/components/ui/Tooltip";
import { ApiError } from "@/lib/client/api";
import { act, initial, quiet, shortDuration } from "./client";
import { channelPath } from "./tree";
import s from "./voice.module.css";

/** Who's connected right now, where they are, and the few things an admin does to them. */
export function People({ appId, live, rootName, onChanged }: { appId: string; live: VoiceLive; rootName: string | null; onChanged: () => void }) {
  const [kicking, setKicking] = React.useState<VoiceUser | null>(null);
  const byId = React.useMemo(() => new Map(live.channels.map((c) => [c.id, c])), [live.channels]);

  async function run(op: Parameters<typeof act>[1]) {
    if (await act(appId, op)) onChanged();
  }

  function items(u: VoiceUser): MenuEntry[] {
    const others = live.channels.filter((c) => c.id !== u.channel).sort((a, b) => channelPath(a, byId).localeCompare(channelPath(b, byId)));
    const out: MenuEntry[] = [];
    out.push({
      kind: "sub",
      label: "Move to",
      icon: <ArrowRight />,
      items: others.length ? others.map((c) => ({ label: c.id === 0 ? (rootName ?? c.name) : channelPath(c, byId), onSelect: () => void run({ op: "move", session: u.session, channel: c.id }) })) : [{ label: "There's no other channel", disabled: true }],
    });
    out.push(
      u.mute
        ? { label: "Unmute", description: "Let them talk again", icon: <Microphone />, onSelect: () => void run({ op: "mute", session: u.session, on: false }) }
        : { label: "Mute", description: "They can still hear everyone", icon: <MicrophoneMute />, onSelect: () => void run({ op: "mute", session: u.session, on: true }) },
      u.deaf
        ? { label: "Undeafen", icon: <SoundHigh />, onSelect: () => void run({ op: "deafen", session: u.session, on: false }) }
        : { label: "Deafen", description: "They can't hear or talk", icon: <SoundOff />, onSelect: () => void run({ op: "deafen", session: u.session, on: true }) },
    );
    const addr = u.address;
    if (addr) out.push({ label: "Copy their address", description: addr, icon: <Copy />, onSelect: () => void copyText(addr).then((ok) => (ok ? toast.success("Copied", { description: addr }) : toast.error("Couldn't copy"))) });
    out.push("separator", { label: "Remove from the server…", icon: <LogOut />, danger: true, onSelect: () => setKicking(u) });
    return out;
  }

  const sorted = [...live.users].sort((a, b) => (byId.get(a.channel)?.name ?? "").localeCompare(byId.get(b.channel)?.name ?? "") || a.name.localeCompare(b.name));

  return (
    <Panel title="Who's here now" meta={<span className={s.num}>{live.users.length}</span>} flush>
      {sorted.length === 0 ? (
        <div className={s.empty}>
          <p>Nobody is connected. People show up here the moment they join, with the channel they&rsquo;re in.</p>
        </div>
      ) : (
        <ul className={s.list} aria-live="polite">
          {sorted.map((u) => (
            <li key={u.session} className={s.row}>
              <div className={s.who}>
                <span className={s.mark} data-guest={u.userId < 0 ? "" : undefined} aria-hidden>
                  {initial(u.name)}
                </span>
                <div className={s.whoText}>
                  <span className={s.name} title={u.address ? `${u.name}, from ${u.address}` : u.name}>
                    {u.name}
                  </span>
                  <span className={s.sub2}>
                    <span>in {u.channel === 0 && rootName ? rootName : (byId.get(u.channel)?.name ?? "a channel")}</span>
                    <span>
                      {u.idleSecs < 15 ? "talking or just spoke" : `quiet ${shortDuration(u.idleSecs)}`}
                      {u.onlineSecs >= 60 ? `, here ${shortDuration(u.onlineSecs)}` : ""}
                    </span>
                    {(u.client || u.os) && <span>{[u.client, u.os].filter(Boolean).join(" on ")}</span>}
                    {u.userId < 0 && <span>not registered</span>}
                  </span>
                </div>
              </div>
              <div className={s.end}>
                <Flags u={u} />
                <Menu trigger={<IconButton label={`Actions for ${u.name}`} size="sm" variant="ghost"><MoreHoriz /></IconButton>} items={items(u)} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <KickDialog appId={appId} user={kicking} onClose={() => setKicking(null)} onDone={onChanged} />
    </Panel>
  );
}

/** Muted and deafened, by themselves or by an admin. Icons with names, never colour alone. */
function Flags({ u }: { u: VoiceUser }) {
  const flags: { key: string; label: string; icon: React.ReactNode; by: "self" | "admin" }[] = [];
  if (u.deaf) flags.push({ key: "deaf", label: "Deafened by an admin", icon: <SoundOff />, by: "admin" });
  else if (u.selfDeaf) flags.push({ key: "sdeaf", label: "Deafened themselves", icon: <SoundOff />, by: "self" });
  if (u.mute && !u.deaf) flags.push({ key: "mute", label: "Muted by an admin", icon: <MicrophoneMute />, by: "admin" });
  else if (u.selfMute && !u.selfDeaf && !u.deaf) flags.push({ key: "smute", label: "Muted themselves", icon: <MicrophoneMute />, by: "self" });
  if (u.suppress && !u.mute) flags.push({ key: "sup", label: "Can't talk in this channel", icon: <MicrophoneMute />, by: "admin" });
  if (!flags.length) return null;
  return (
    <span className={s.flags}>
      {flags.map((f) => (
        <Tooltip key={f.key} content={f.label}>
          <span className={s.flag} data-by={f.by} role="img" aria-label={f.label} tabIndex={0}>
            {f.icon}
          </span>
        </Tooltip>
      ))}
    </span>
  );
}

function KickDialog({ appId, user, onClose, onDone }: { appId: string; user: VoiceUser | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const last = React.useRef(user);
  if (user) last.current = user;
  const u = user ?? last.current;

  React.useEffect(() => {
    if (user) {
      setReason("");
      setError(null);
    }
  }, [user]);

  async function go() {
    if (!u) return;
    setBusy(true);
    setError(null);
    try {
      if (await act(appId, { op: "kick", session: u.session, reason }, { inline: true })) {
        onDone();
        onClose();
      }
    } catch (e) {
      if (!quiet(e)) setError(e instanceof ApiError ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={!!user}
      onOpenChange={(o) => !o && onClose()}
      title={u ? `Remove ${u.name} from the server?` : ""}
      description="They're disconnected now and see your reason. They can join again unless you also change the password."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="dangerSolid" loading={busy} onClick={() => void go()}>
            Remove {u?.name}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <Field label="Reason" optional error={error}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Shown to them in their Mumble app" />
        </Field>
      </form>
    </Dialog>
  );
}

