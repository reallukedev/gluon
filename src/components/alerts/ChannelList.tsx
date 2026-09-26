"use client";
import * as React from "react";
import { MoreHoriz, EditPencil, Trash, Pause, Play } from "iconoir-react";
import type { ChannelView, TestResult } from "@/lib/alerts-types";
import { api, ApiError } from "@/lib/client/api";
import { Button, IconButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { useConfirm } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { KIND_ICON } from "./ChannelDialog";
import { errorMessage } from "./shared";
import s from "./alerts.module.css";

/** A list of channels with health, a test button and edit/turn off/remove. */
export function ChannelList({ channels, onEdit, onChange, showOwner, highlight }: { channels: ChannelView[]; onEdit: (c: ChannelView) => void; onChange: () => void; showOwner?: boolean; highlight?: string | null }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  /** The last test per channel, shown right under it. */
  const [tests, setTests] = React.useState<Record<string, TestResult & { at: number }>>({});
  const [confirm, confirmNode] = useConfirm();

  async function test(c: ChannelView) {
    setBusy(c.id);
    setTests((cur) => {
      const next = { ...cur };
      delete next[c.id];
      return next;
    });
    try {
      const r = await api.post<TestResult>("/api/alerts/channels/test", { id: c.id });
      setTests((t) => ({ ...t, [c.id]: { ...r, at: Date.now() } }));
      onChange();
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      setTests((t) => ({ ...t, [c.id]: { ok: false, message: errorMessage(e), latencyMs: 0, at: Date.now() } }));
    } finally {
      setBusy(null);
    }
  }
  async function toggle(c: ChannelView) {
    try {
      await api.patch(`/api/alerts/channels/${encodeURIComponent(c.id)}`, { enabled: !c.enabled });
      toast.success(c.enabled ? `Turned off “${c.name}”` : `Turned on “${c.name}”`, { description: c.enabled ? "Nothing is sent to it until you turn it back on." : undefined });
      onChange();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) toast.error(errorMessage(e));
    }
  }
  const remove = (c: ChannelView) =>
    confirm({
      title: `Remove “${c.name}”?`,
      consequences: ["Alerts stop going there, including any waiting to be sent.", "Everyone's choices for this channel are removed too.", "Its sent history stays in the log."],
      confirmLabel: "Remove channel",
      onConfirm: async () => {
        await api.del(`/api/alerts/channels/${encodeURIComponent(c.id)}`);
        toast.success(`Removed “${c.name}”`);
        onChange();
      },
    });

  return (
    <>
      <ul className={`${s.channels} appear`} role="list">
        {channels.map((c) => {
          const h = c.health;
          const t = tests[c.id];
          return (
            <li key={c.id} id={`channel-${c.id}`} className={s.channel} data-off={c.enabled ? undefined : ""} style={highlight === c.id ? { background: "var(--panel-2)" } : undefined}>
              <span className={s.kindIcon} aria-hidden>
                {KIND_ICON[c.kind]}
              </span>
              <div className={s.channelText}>
                <span className={s.channelName}>
                  <span className="truncate" title={c.name}>
                    {c.name}
                  </span>
                  {showOwner && c.ownerName && <small>{c.ownerName}'s</small>}
                </span>
                <span className={s.channelSub}>
                  <span className="mono" title={c.summary}>
                    {c.summary}
                  </span>
                  {!c.enabled ? (
                    <StateLine state="paused" label="Off" size={11} />
                  ) : h.failing ? (
                    <StateLine state="unhealthy" label="Not getting through" size={11} />
                  ) : h.lastSentAt ? (
                    <span>
                      last message <Time ts={h.lastSentAt} />
                    </span>
                  ) : (
                    <span>nothing sent yet</span>
                  )}
                </span>
                {c.enabled && h.failing && h.lastError && <span className={s.channelErr}>{h.lastError}</span>}
              </div>
              <div className={s.channelActions}>
                <Button size="sm" loading={busy === c.id} disabled={!c.enabled} onClick={() => void test(c)}>
                  {busy === c.id ? "Sending…" : "Send a test"}
                </Button>
                {c.editable && (
                  <Menu
                    trigger={
                      <IconButton label={`${c.name} actions`} size="sm">
                        <MoreHoriz />
                      </IconButton>
                    }
                    items={[
                      { label: "Edit", icon: <EditPencil />, onSelect: () => onEdit(c) },
                      c.enabled ? { label: "Turn off", icon: <Pause />, onSelect: () => void toggle(c) } : { label: "Turn on", icon: <Play />, onSelect: () => void toggle(c) },
                      "separator",
                      { label: "Remove", icon: <Trash />, danger: true, onSelect: () => remove(c) },
                    ]}
                  />
                )}
              </div>
              <div className={s.testLine} aria-live="polite">
                {t && (
                  <span className={s.testResultLine} data-ok={t.ok ? "" : undefined}>
                    <StateLine state={t.ok ? "running" : "unhealthy"} label={false} size={12} />
                    <span>
                      <b>{t.ok ? "Test sent" : "Didn't go through"}</b>
                      {t.ok && t.latencyMs ? ` in ${t.latencyMs < 1000 ? `${t.latencyMs} ms` : `${(t.latencyMs / 1000).toFixed(1)} s`}` : ""}. {t.ok ? t.message.replace(/^Sent\.\s*/, "") : t.message}
                    </span>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {confirmNode}
    </>
  );
}
