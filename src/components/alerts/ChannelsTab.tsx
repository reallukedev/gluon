"use client";
import * as React from "react";
import Link from "next/link";
import { Plus } from "iconoir-react";
import type { ChannelView } from "@/lib/alerts-types";
import { CHANNEL_KINDS } from "@/lib/alerts-types";
import { useApi } from "@/lib/client/api";
import { Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import type { ChannelKind } from "@/lib/alerts-types";
import { ChannelDialog, KIND_ICON, KIND_INFO } from "./ChannelDialog";
import { ChannelList } from "./ChannelList";
import { CHANNELS_URL } from "./shared";
import s from "./alerts.module.css";

/** Server-wide channels (admins manage), plus a read-out of household members' personal ones. */
export function ChannelsTab({ highlight }: { highlight: string | null }) {
  const { data, error, isLoading, mutate } = useApi<ChannelView[]>(CHANNELS_URL, { refresh: 30_000 });
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ChannelView | null>(null);
  const [kind, setKind] = React.useState<ChannelKind | null>(null);

  React.useEffect(() => {
    if (highlight && data) document.getElementById(`channel-${highlight}`)?.scrollIntoView({ block: "center" });
  }, [highlight, data]);

  const all = data ?? [];
  const server = all.filter((c) => c.owner === null);
  const personal = all.filter((c) => c.owner !== null);
  const vias = server.filter((c) => c.kind === "email" && !c.config.via).map((c) => ({ id: c.id, name: c.name }));
  const edit = (c: ChannelView | null, k: ChannelKind | null = null) => {
    setEditing(c);
    setKind(k);
    setOpen(true);
  };

  if (error && !data) {
    return (
      <Notice tone="fault" title="Couldn't load channels">
        {error.message} Try again in a moment.
      </Notice>
    );
  }

  return (
    <>
      <Panel
        title="Server-wide channels"
        meta={
          server.length > 0 ? (
            <Button size="sm" variant="primary" icon={<Plus />} onClick={() => edit(null)}>
              Add channel
            </Button>
          ) : undefined
        }
        flush
      >
        {isLoading && !data ? (
          <div className={s.skeletons}>
            <Skeleton height={48} />
            <Skeleton height={48} />
          </div>
        ) : server.length === 0 ? (
          <div className={s.firstChannel}>
            <p className={s.firstChannelText}>
              <b>Nothing is sent anywhere yet.</b> Choose where alerts should go. You can send a test before saving, and pick which alerts each channel gets in
              Settings → Notifications.
            </p>
            <div className={s.kindGrid}>
              {CHANNEL_KINDS.map((k) => (
                <button key={k} type="button" className={s.kindChoice} onClick={() => edit(null, k)}>
                  {KIND_ICON[k]}
                  {KIND_INFO[k].label}
                  <small>{NEEDS[k]}</small>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ChannelList channels={server} onEdit={edit} onChange={() => void mutate()} highlight={highlight} />
        )}
      </Panel>

      {server.length > 0 && (
        <p className={s.muted} style={{ fontSize: "var(--text-sm)" }}>
          Choose which alerts reach you, quiet hours and the daily summary in <Link href="/settings/notifications">Settings → Notifications</Link>.
        </p>
      )}

      {personal.length > 0 && (
        <Panel title="Personal channels" meta={<span className="num">{personal.length}</span>} flush>
          <ChannelList channels={personal} onEdit={edit} onChange={() => void mutate()} showOwner highlight={highlight} />
        </Panel>
      )}

      <ChannelDialog
        open={open}
        onOpenChange={setOpen}
        channel={editing}
        scope="server"
        admin
        kinds={[...CHANNEL_KINDS]}
        emailVias={vias.filter((v) => v.id !== editing?.id)}
        onSaved={() => void mutate()}
        initialKind={kind}
      />
    </>
  );
}

const NEEDS: Record<ChannelKind, string> = {
  ntfy: "Free. Install the ntfy app and pick a topic.",
  pushover: "Paid app. Needs your user key and an app token.",
  email: "Any mail account. Needs its mail server details.",
  webhook: "Discord, Slack or your own service.",
};
