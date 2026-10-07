"use client";
import * as React from "react";
import type { ChatHostSnapshot, ChatSettings, HistoryKeep, SignUp } from "@/lib/chat-types";
import { api, ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { AffixInput, Field, Input, Segmented, Switch, TextArea } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Panel } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import s from "./chat.module.css";

const HISTORY_OPTIONS: { value: HistoryKeep; label: string }[] = [
  { value: "off", label: "Don't keep history" },
  { value: "1w", label: "A week" },
  { value: "1m", label: "A month" },
  { value: "3m", label: "Three months" },
  { value: "1y", label: "A year" },
  { value: "never", label: "Forever" },
];

const SIGN_UP: Record<SignUp, string> = {
  closed: "You add accounts here or send invite links. Nobody can sign up on their own.",
  invite: "Members can also make invite links in their chat app for friends and family. Nobody can sign up without one.",
  open: "Anyone who finds the server can make an account from a chat app. Spammers look for servers like this.",
};

/**
 * Saving settings, shared by the form and the "Turn on" buttons in What chat apps can do. Changes
 * that add or remove a group chat or file service restart Prosody, so those ask first and say how
 * many people get bumped.
 */
export function useSettingsSaver(appId: string, host: ChatHostSnapshot, rev: string, onSaved: () => void) {
  const [saving, setSaving] = React.useState(false);
  const [restart, setRestart] = React.useState<{ next: ChatSettings; online: number; changes: string[] } | null>(null);

  const save = React.useCallback(
    async (next: ChatSettings, confirmRestart = false): Promise<boolean> => {
      setSaving(true);
      try {
        const r = await api.put<{ restarted: boolean; notes: string[] }>(`/api/chat/${encodeURIComponent(appId)}/settings`, { host: host.host, settings: next, restart: confirmRestart, rev });
        toast.success(r.restarted ? "Saved, and the chat server restarted" : "Chat settings saved", r.notes.length ? { description: r.notes.join(" "), timeout: 9000 } : undefined);
        onSaved();
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === "stale") {
          toast.attention("The chat settings changed somewhere else", { description: "Gluon reloaded them. Make your change again.", timeout: 8000 });
          onSaved();
          return false;
        }
        if (e instanceof ApiError && e.code === "needs_restart") {
          const d = (e.details ?? {}) as { online?: number; changes?: string[] };
          setRestart({ next, online: d.online ?? 0, changes: d.changes ?? [] });
          return false;
        }
        if (!(e instanceof ApiError && e.code === "reauth_cancelled")) toast.error("Settings weren't saved", { description: e instanceof Error ? e.message : undefined });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [appId, host.host, rev, onSaved],
  );

  const node = (
    <ConfirmDialog
      open={!!restart}
      onOpenChange={(o) => !o && setRestart(null)}
      title="Restart the chat server?"
      description={restart?.changes.length ? `Prosody needs a restart for ${restart.changes.join(" and ")}.` : undefined}
      consequences={[
        restart?.online ? `${restart.online} connected device${restart.online === 1 ? " drops" : "s drop"} for a few seconds, then reconnect by themselves.` : "Nobody is connected right now.",
        host.settings.history === "off" ? "Messages sent while it restarts reach people once they're back online." : "No messages are lost: apps fetch what they missed.",
      ]}
      confirmLabel="Save and restart"
      onConfirm={async () => {
        if (restart) await save(restart.next, true);
      }}
    />
  );
  return { save, saving, node };
}

type Saver = ReturnType<typeof useSettingsSaver>;

function Setting({ title, desc, control, children, id, toggle }: { title: string; desc: React.ReactNode; control?: React.ReactNode; children?: React.ReactNode; id?: string; toggle?: boolean }) {
  return (
    <div className={s.setting} id={id} data-toggle={toggle ? "" : undefined}>
      <div className={s.settingText}>
        <span className={s.settingTitle}>{title}</span>
        <p className={s.settingDesc}>{desc}</p>
      </div>
      {control && <div className={s.settingControl}>{control}</div>}
      {children}
    </div>
  );
}

export function ChatSettingsForm({ host, disabled, saver, multipleHosts, onCalls }: { host: ChatHostSnapshot; disabled: boolean; saver: Saver; multipleHosts: boolean; onCalls: () => void }) {
  const initial = host.settings;
  const [v, setV] = React.useState<ChatSettings>(initial);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const set = <K extends keyof ChatSettings>(k: K, val: ChatSettings[K]) => setV((x) => ({ ...x, [k]: val }));
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  function validate(): boolean {
    const e: Record<string, string> = {};
    const name = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
    if (v.groups.on && !host.ownComponents.muc && !name.test(v.groups.host)) e.groups = "Use an address like rooms." + host.host;
    if (v.files.on && !host.ownComponents.files && !name.test(v.files.host)) e.files = "Use an address like upload." + host.host;
    if (v.files.on && (!Number.isFinite(v.files.maxMb) || v.files.maxMb < 1 || v.files.maxMb > 2048)) e.maxMb = "Between 1 and 2048 MB.";
    if (v.contact && !/^(?:(?:xmpp:|mailto:)?[^\s@]+@[^\s@]+|https?:\/\/\S+)$/.test(v.contact.trim())) e.contact = "Use a chat or email address, like you@example.com.";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const off = disabled || saver.saving;

  return (
    <Panel title="Settings" meta={multipleHosts ? <span className={s.muted}>For every chat domain on this server</span> : undefined} flush>
      <div className={s.settings}>
        <Setting title="Who can make an account" desc={SIGN_UP[v.signUp]}>
          <div className={s.signUp}>
            <Segmented
              aria-label="Who can make an account"
              disabled={off}
              value={v.signUp}
              onChange={(x) => set("signUp", x)}
              options={[
                { value: "closed", label: "Only you" },
                { value: "invite", label: "You and members invite" },
                { value: "open", label: "Anyone" },
              ]}
            />
          </div>
        </Setting>

        <Setting
          title="Message history"
          desc={v.history === "off" ? "Messages only reach devices that are online when they arrive, and new devices start empty." : "Kept on the server so every device shows the same conversation, and a new phone gets the past messages."}
          control={
            v.history === "custom" ? (
              <span className={s.muted}>Set in the config file</span>
            ) : (
              <Select aria-label="Message history" disabled={off} value={v.history} onChange={(x) => set("history", x)} options={HISTORY_OPTIONS} />
            )
          }
        />

        <Setting
          toggle
          title="Group chats"
          desc={host.ownComponents.muc ? `Set up in Prosody's config file at ${host.ownComponents.muc}.` : "Rooms several people chat in. Each one gets an address like family@" + v.groups.host + "."}
          control={!host.ownComponents.muc && <Switch checked={v.groups.on} disabled={off} onChange={(on) => set("groups", { ...v.groups, on })} aria-label="Group chats" />}
        >
          {v.groups.on && !host.ownComponents.muc && (
            <div className={s.settingMore}>
              <Field label="Address for group chats" error={errors.groups}>
                <Input mono value={v.groups.host} disabled={off} onChange={(e) => set("groups", { ...v.groups, host: e.target.value.trim().toLowerCase() })} spellCheck={false} autoCapitalize="off" />
              </Field>
              <Field label="Who can make new ones">
                <Segmented
                  aria-label="Who can make group chats"
                  disabled={off}
                  value={v.groups.whoCreates}
                  onChange={(x) => set("groups", { ...v.groups, whoCreates: x })}
                  options={[
                    { value: "everyone", label: "Everyone here" },
                    { value: "admins", label: "Admins" },
                  ]}
                />
              </Field>
            </div>
          )}
        </Setting>

        <Setting
          toggle
          title="Photos and files"
          desc={host.ownComponents.files ? `Set up in Prosody's config file at ${host.ownComponents.files}.` : `Uploads go through https://${host.host}, so Gluon points that address at the chat server's web port. Files are deleted after the time you choose.`}
          control={!host.ownComponents.files && <Switch checked={v.files.on} disabled={off} onChange={(on) => set("files", { ...v.files, on })} aria-label="Photos and files" />}
        >
          {v.files.on && !host.ownComponents.files && (
            <div className={s.settingMore}>
              <Field label="Largest file" error={errors.maxMb}>
                <AffixInput after="MB" inputMode="numeric" value={String(v.files.maxMb)} disabled={off} onChange={(e) => set("files", { ...v.files, maxMb: Number(e.target.value.replace(/\D/g, "").slice(0, 4)) || 0 })} />
              </Field>
              <Field label="Keep files for">
                <Select
                  aria-label="Keep files for"
                  disabled={off}
                  value={String(v.files.keepDays) as "7" | "30" | "90" | "365" | "0"}
                  onChange={(x) => set("files", { ...v.files, keepDays: Number(x) })}
                  options={[
                    { value: "7", label: "A week" },
                    { value: "30", label: "A month" },
                    { value: "90", label: "Three months" },
                    { value: "365", label: "A year" },
                    { value: "0", label: "Forever" },
                  ]}
                />
              </Field>
              <Field label="Upload service address" error={errors.files} description="People never type it; apps find it on their own.">
                <Input mono value={v.files.host} disabled={off} onChange={(e) => set("files", { ...v.files, host: e.target.value.trim().toLowerCase() })} spellCheck={false} autoCapitalize="off" />
              </Field>
            </div>
          )}
        </Setting>

        <Setting
          toggle
          title="Notifications when the app is closed"
          desc="iPhone apps like Monal ask Apple to wake them for new messages. Only a short nudge leaves the server, never the message."
          control={<Switch checked={v.push} disabled={off} onChange={(x) => set("push", x)} aria-label="Notifications when the app is closed" />}
        />

        <Setting
          toggle
          title="Chat with other servers"
          desc="People here can talk to anyone on another XMPP server, like email between providers. Needs port 5269 open on your router."
          control={<Switch checked={v.federation} disabled={off} onChange={(x) => set("federation", x)} aria-label="Chat with other servers" />}
        />

        <Setting
          toggle
          title="Chat in a browser"
          desc={`Lets web chat apps like Converse connect through https://${host.host}.`}
          control={<Switch checked={v.web} disabled={off} onChange={(x) => set("web", x)} aria-label="Chat in a browser" />}
        />

        <Setting
          title="Calls across networks"
          desc={v.calls?.on ? "Chat apps get a relay on this server for voice and video calls between homes and on mobile data." : "Calls work on the same network. Between two homes or on mobile data they need a relay on this server."}
          control={
            <Button size="sm" disabled={disabled} onClick={onCalls}>
              {v.calls?.on ? "Check calls" : "Set up calls"}
            </Button>
          }
        />

        <Setting title="Admin contact" desc="Shown to chat apps and other servers that need to reach whoever runs this one, for example about spam.">
          <div className={s.settingMore}>
            <Field label="Chat or email address" optional error={errors.contact}>
              <Input value={v.contact ?? ""} disabled={off} onChange={(e) => set("contact", e.target.value || null)} placeholder={`you@${host.host}`} spellCheck={false} autoCapitalize="off" mono />
            </Field>
          </div>
        </Setting>

        <Setting title="Welcome message" desc="Sent from the server to every new account.">
          <div className={s.settingWide}>
            <Field label="Message" optional>
              <TextArea value={v.welcome ?? ""} disabled={off} onChange={(e) => set("welcome", e.target.value || null)} rows={3} maxLength={1000} placeholder={`Welcome to ${host.host}! Say hi in the family group chat.`} />
            </Field>
          </div>
        </Setting>
      </div>

      {dirty && (
        <div className={s.saveBar} role="region" aria-label="Unsaved chat settings">
          <p>You have unsaved changes.</p>
          <div className={s.saveActions}>
            <Button variant="ghost" disabled={saver.saving} onClick={() => setV(initial)}>
              Discard
            </Button>
            <Button variant="primary" loading={saver.saving} disabled={disabled} onClick={() => validate() && void saver.save(v)}>
              Save settings
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
