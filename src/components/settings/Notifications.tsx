"use client";
import * as React from "react";
import Link from "next/link";
import { Plus } from "iconoir-react";
import type { ChannelKind, ChannelView, SubscriptionFilter, SubscriptionsResponse, TestResult } from "@/lib/alerts-types";
import { CHANNEL_KINDS, MEMBER_CHANNEL_KINDS } from "@/lib/alerts-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { Empty, Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Checkbox, Input, Segmented, SettingRow, Switch } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { StateLine } from "@/components/ui/StateLine";
import { ChannelDialog, KIND_ICON } from "@/components/alerts/ChannelDialog";
import { ChannelList } from "@/components/alerts/ChannelList";
import { SentTab } from "@/components/alerts/SentTab";
import { alertsHref } from "@/lib/settings-links";
import s from "./notifications.module.css";

const SUBS_URL = "/api/alerts/subscriptions";
const CHANNELS_URL = "/api/alerts/channels";

/** Settings → Notifications: your own channels, and what each channel you use tells you. */
export function Notifications() {
  const { viewer } = usePrefs();
  const admin = viewer.role === "admin";
  const subs = useApi<SubscriptionsResponse>(SUBS_URL);
  const channels = useApi<ChannelView[]>(CHANNELS_URL);
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ChannelView | null>(null);
  const refresh = () => {
    void subs.mutate();
    void channels.mutate();
  };

  const mine = (channels.data ?? []).filter((c) => c.owner === viewer.id);
  const error = subs.error ?? channels.error;
  const loading = (!subs.data || !channels.data) && !error;
  const edit = (c: ChannelView | null) => {
    setEditing(c);
    setOpen(true);
  };

  if (error && (!subs.data || !channels.data)) {
    return (
      <Notice tone="fault" title="Couldn't load your notification settings">
        {error.message} Try again in a moment.
      </Notice>
    );
  }

  return (
    <div className={s.stack}>
      <Panel
        title={admin ? "Your own channels" : "Where to reach you"}
        meta={
          mine.length > 0 ? (
            <Button size="sm" icon={<Plus />} onClick={() => edit(null)}>
              Add
            </Button>
          ) : undefined
        }
        flush
      >
        {loading ? (
          <div style={{ padding: 18, display: "grid", gap: 12 }}>
            <Skeleton height={40} />
          </div>
        ) : mine.length === 0 ? (
          <Empty title={admin ? "No personal channels" : "Nowhere to reach you yet"} action={<Button onClick={() => edit(null)}>Add a way to reach you</Button>}>
            {admin
              ? "Server-wide channels (Settings → Alerts → Notifications) are usually enough. Add one here for alerts only you should get, like your own phone."
              : "Get a message on your phone (with the free ntfy app) or by email when one of your apps stops working, and when someone replies to a problem you reported."}
          </Empty>
        ) : (
          <ChannelList channels={mine} onEdit={edit} onChange={refresh} />
        )}
      </Panel>

      {subs.data && <WhatYouGet data={subs.data} onChange={refresh} />}

      {!admin && mine.length > 0 && <SentTab compact />}

      <ChannelDialog
        open={open}
        onOpenChange={setOpen}
        channel={editing}
        scope="personal"
        admin={admin}
        kinds={admin ? [...CHANNEL_KINDS] : MEMBER_CHANNEL_KINDS}
        emailVias={subs.data?.mailSetups ?? []}
        onSaved={async (c) => {
          refresh();
          // A new personal channel is only useful once it's switched on for something.
          if (!editing) {
            try {
              await api.put(SUBS_URL, { channelId: c.id, filter: defaults(admin, Intl.DateTimeFormat().resolvedOptions().timeZone) });
              void subs.mutate();
            } catch {
              /* the switch below still works */
            }
          }
        }}
      />
    </div>
  );
}

const defaults = (_admin: boolean, tz: string): Partial<SubscriptionFilter> => ({
  severities: ["fault", "attention"],
  subjects: "all",
  resolved: true,
  reports: true,
  digest: false,
  quiet: null,
  tz,
});

function WhatYouGet({ data, onChange }: { data: SubscriptionsResponse; onChange: () => void }) {
  const admin = data.role === "admin";
  if (data.channels.length === 0) {
    return admin ? (
      <Panel title="What you're told">
        <p className={s.hint}>
          Add a channel first, here or in <Link href={alertsHref("notifications")}>Alerts → Notifications</Link>. Then choose here which alerts it sends you.
        </p>
      </Panel>
    ) : null;
  }
  return (
    <Panel title={admin ? "What you're told" : "What you're told about"} flush>
      <ul className={s.subs} role="list">
        {data.channels.map((c) => (
          <SubscriptionRow key={c.id} channel={c} sub={data.subscriptions.find((x) => x.channelId === c.id)?.filter ?? null} data={data} onChange={onChange} />
        ))}
      </ul>
    </Panel>
  );
}

function SubscriptionRow({
  channel,
  sub,
  data,
  onChange,
}: {
  channel: SubscriptionsResponse["channels"][number];
  sub: SubscriptionFilter | null;
  data: SubscriptionsResponse;
  onChange: () => void;
}) {
  const { timeZone } = usePrefs();
  const fmt = useFormat();
  const admin = data.role === "admin";
  const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [draft, setDraft] = React.useState<SubscriptionFilter | null>(sub);
  const [busy, setBusy] = React.useState<"toggle" | "save" | "test" | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [tested, setTested] = React.useState<TestResult | null>(null);
  const on = !!sub;

  React.useEffect(() => setDraft(sub), [sub]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(sub);
  const set = <K extends keyof SubscriptionFilter>(k: K, v: SubscriptionFilter[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  async function toggle(next: boolean) {
    setBusy("toggle");
    setErr(null);
    try {
      if (next) await api.put(SUBS_URL, { channelId: channel.id, filter: defaults(admin, tz) });
      else await api.del(SUBS_URL, { channelId: channel.id });
      onChange();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) toast.error(e instanceof Error ? e.message : "Couldn't change that.");
    } finally {
      setBusy(null);
    }
  }
  async function save() {
    if (!draft) return;
    setBusy("save");
    setErr(null);
    try {
      await api.put(SUBS_URL, { channelId: channel.id, filter: { ...draft, tz } });
      toast.success(`Saved what “${channel.name}” tells you`);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setBusy(null);
    }
  }
  async function test() {
    setBusy("test");
    setTested(null);
    try {
      setTested(await api.post<TestResult>("/api/alerts/channels/test", { id: channel.id }));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) setTested({ ok: false, message: e instanceof Error ? e.message : "Couldn't send a test.", latencyMs: 0 });
    } finally {
      setBusy(null);
    }
  }

  const title = channel.name;
  const switchLabel = admin ? `Send alerts to ${channel.name}` : `Tell me on ${channel.name} when my apps stop working`;
  const digestAt = fmt.time(new Date(2000, 0, 1, data.digest.hour, 0));

  return (
    <li className={s.sub}>
      <div className={s.subHead}>
        <span className={s.kindIcon} aria-hidden>
          {KIND_ICON[channel.kind as ChannelKind]}
        </span>
        <span className={s.subText}>
          <span className={s.subName} title={title}>
            {title}
          </span>
          <span className={s.subSub}>
            {!channel.enabled
              ? "This channel is turned off."
              : on
                ? admin
                  ? describeAdmin(sub!)
                  : "Tells you when your apps stop working."
                : admin
                  ? channel.owner
                    ? "Your channel. Not sending you anything yet."
                    : "Server-wide. Not sending you anything."
                  : "Not telling you anything yet."}
          </span>
        </span>
        <Switch checked={on} onChange={(v) => void toggle(v)} disabled={busy === "toggle" || !channel.enabled} aria-label={switchLabel} />
      </div>

      {on && draft && channel.enabled && (
        <div className={s.subBody}>
          {admin ? (
            <div className={s.group}>
              <span className="label">Send me</span>
              <div className={s.checks}>
                <Checkbox checked={draft.severities.includes("fault")} onChange={(v) => set("severities", v ? [...new Set([...draft.severities, "fault" as const])] : draft.severities.filter((x) => x !== "fault"))}>
                  When something is broken
                </Checkbox>
                <Checkbox
                  checked={draft.severities.includes("attention")}
                  onChange={(v) => set("severities", v ? [...new Set([...draft.severities, "attention" as const])] : draft.severities.filter((x) => x !== "attention"))}
                >
                  When something needs attention
                </Checkbox>
              </div>
            </div>
          ) : null}

          <div className={s.group}>
            <span className="label">{admin ? "About" : "Which apps"}</span>
            <Segmented
              aria-label="Which apps"
              value={draft.subjects === "all" ? "all" : "some"}
              onChange={(v) => set("subjects", v === "all" ? "all" : draft.subjects === "all" ? [] : draft.subjects)}
              options={[
                { value: "all", label: admin ? "Everything" : "All my apps" },
                { value: "some", label: "Only some apps" },
              ]}
            />
            {draft.subjects !== "all" &&
              (data.subjects.length === 0 ? (
                <p className={s.hint}>{admin ? "No apps found." : "No apps have been shared with you yet."}</p>
              ) : (
                <div className={s.apps}>
                  {data.subjects.map((a) => {
                    const list = draft.subjects as string[];
                    return (
                      <Checkbox key={a.id} checked={list.includes(a.id)} onChange={(v) => set("subjects", v ? [...list, a.id] : list.filter((x) => x !== a.id))}>
                        <span className={s.appCheck}>
                          <span title={a.name}>{a.name}</span>
                        </span>
                      </Checkbox>
                    );
                  })}
                </div>
              ))}
            {admin && draft.subjects !== "all" && <p className={s.hint}>Problems that aren't about an app (disks, memory, updates) aren't sent with this choice.</p>}
          </div>

          <div className={s.rows}>
            <SettingRow label={admin ? "When a problem clears" : "Tell me when they're working again"} description={admin ? "A short “resolved” message after each alert." : undefined}>
              <Switch checked={draft.resolved} onChange={(v) => set("resolved", v)} aria-label="When a problem clears" />
            </SettingRow>
            <SettingRow label={admin ? "Problem reports from the household" : "Tell me when someone replies to my reports"}>
              <Switch checked={draft.reports} onChange={(v) => set("reports", v)} aria-label="Problem reports" />
            </SettingRow>
            {admin && (
              <SettingRow
                label="Daily summary"
                description={
                  data.digest.enabled ? (
                    `Every day at ${digestAt}: what's open, uptime and anything notable.`
                  ) : (
                    <>
                      The daily summary is turned off for the server. Turn it on in <Link href="/settings/server">Settings → Server</Link>.
                    </>
                  )
                }
              >
                <Switch checked={draft.digest} onChange={(v) => set("digest", v)} disabled={!data.digest.enabled} aria-label="Daily summary" />
              </SettingRow>
            )}
            <SettingRow label="Quiet hours" description={draft.quiet ? undefined : "Hold messages overnight and send them in the morning."}>
              <Switch checked={!!draft.quiet} onChange={(v) => set("quiet", v ? { from: "22:00", to: "07:00", bypassFaults: admin } : null)} aria-label="Quiet hours" />
            </SettingRow>
          </div>

          {draft.quiet && (
            <div className={s.group}>
              <div className={s.quiet}>
                <span>From</span>
                <Input type="time" className={`${s.time} num`} value={draft.quiet.from} onChange={(e) => e.target.value && set("quiet", { ...draft.quiet!, from: e.target.value })} aria-label="Quiet hours start" />
                <span>to</span>
                <Input type="time" className={`${s.time} num`} value={draft.quiet.to} onChange={(e) => e.target.value && set("quiet", { ...draft.quiet!, to: e.target.value })} aria-label="Quiet hours end" />
              </div>
              <Checkbox checked={draft.quiet.bypassFaults} onChange={(v) => set("quiet", { ...draft.quiet!, bypassFaults: v })}>
                {admin ? "Still tell me straight away when something is broken" : "Still tell me straight away if an app stops working"}
              </Checkbox>
              <p className={s.hint}>
                Times are in {tz.replace(/_/g, " ")}
                {sub?.tz && sub.tz !== tz ? ` (saved as ${sub.tz.replace(/_/g, " ")}; saving updates it)` : ""}. Messages held during quiet hours are sent when they end, unless the problem has already cleared.
              </p>
            </div>
          )}

          {err && (
            <Notice tone="fault" title="Couldn't save">
              {err}
            </Notice>
          )}
          <div className={s.foot}>
            <span className={s.hint} aria-live="polite">
              {tested ? (
                <span className={s.tested} data-ok={tested.ok ? "" : undefined}>
                  <StateLine state={tested.ok ? "running" : "unhealthy"} label={false} size={12} />
                  {tested.ok ? tested.message : `Didn't go through. ${tested.message}`}
                </span>
              ) : dirty ? (
                "You have unsaved changes."
              ) : (
                ""
              )}
            </span>
            <Button size="sm" loading={busy === "test"} onClick={() => void test()}>
              Send a test
            </Button>
            <Button size="sm" variant="primary" disabled={!dirty} loading={busy === "save"} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function describeAdmin(f: SubscriptionFilter): string {
  const sev = f.severities.length === 2 ? "Every alert" : f.severities[0] === "fault" ? "Broken things" : f.severities[0] === "attention" ? "Things needing attention" : "No alerts";
  const bits = [f.subjects === "all" ? sev : `${sev} about ${f.subjects.length} app${f.subjects.length === 1 ? "" : "s"}`];
  if (f.reports) bits.push("household reports");
  if (f.digest) bits.push("daily summary");
  let out = bits.join(", ");
  if (f.quiet) out += `. Quiet ${f.quiet.from}–${f.quiet.to}`;
  return `${out}.`;
}
