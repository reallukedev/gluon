"use client";
import * as React from "react";
import Link from "next/link";
import { Plus } from "iconoir-react";
import type { ChannelKind, ChannelView, KindPreset, NotifyKind, SubscriptionFilter, SubscriptionsResponse, TestResult } from "@/lib/alerts-types";
import { CHANNEL_KINDS, KIND_GROUPS, KIND_INFO, MEMBER_CHANNEL_KINDS, MEMBER_KIND_INFO, NOTIFY_KINDS, defaultKinds, kindsFor, presetOf } from "@/lib/alerts-types";
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
      {/* Admins mostly use server-wide channels, so what they're told comes first; members need a way to be reached first. */}
      {admin && subs.data && <WhatYouGet data={subs.data} onChange={refresh} />}

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
              ? "Server-wide channels (Settings → Alerts → Channels) are usually enough. Add one here for alerts only you should get, like your own phone."
              : "Get a message on your phone (with the free ntfy app), by email or in your chat app when one of your apps stops working, and when someone replies to a problem you reported."}
          </Empty>
        ) : (
          <ChannelList channels={mine} onEdit={edit} onChange={refresh} />
        )}
      </Panel>

      {!admin && subs.data && <WhatYouGet data={subs.data} onChange={refresh} />}

      {!admin && mine.length > 0 && <SentTab compact />}

      <ChannelDialog
        open={open}
        onOpenChange={setOpen}
        channel={editing}
        scope="personal"
        admin={admin}
        kinds={admin ? [...CHANNEL_KINDS] : MEMBER_CHANNEL_KINDS}
        emailVias={subs.data?.mailSetups ?? []}
        onSaved={() => refresh()}
      />
    </div>
  );
}

/** A new subscription: problems only (admins) or "my apps" (members). Stated in the UI as the default. */
export const defaults = (role: "admin" | "member", tz: string): Partial<SubscriptionFilter> => ({ kinds: defaultKinds(role), subjects: "all", quiet: null, tz });

function WhatYouGet({ data, onChange }: { data: SubscriptionsResponse; onChange: () => void }) {
  const admin = data.role === "admin";
  if (data.channels.length === 0) {
    return admin ? (
      <Panel title="What you're told">
        <p className={s.hint}>
          Add a channel first, here or in <Link href={alertsHref("notifications")}>Alerts → Channels</Link>. Then choose here what it sends you.
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
  const role = data.role;
  const admin = role === "admin";
  const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [draft, setDraft] = React.useState<SubscriptionFilter | null>(sub);
  const [busy, setBusy] = React.useState<"toggle" | "save" | "test" | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [tested, setTested] = React.useState<TestResult | null>(null);
  /** "Choose" stays picked while someone ticks boxes, even when the ticks happen to match a preset. */
  const [choosing, setChoosing] = React.useState(false);
  /** The editor is folded away until someone wants to change it; the line under the name says what it sends. */
  const [open, setOpen] = React.useState(false);
  const on = !!sub;

  // Reset only when the saved filter really changes: saving another channel hands every row a new
  // (equal) object, and an identity dependency would wipe this row's unsaved edits.
  const subKey = JSON.stringify(sub);
  React.useEffect(() => {
    setDraft(sub);
    setChoosing(!!sub && presetOf(sub.kinds, role) === "custom");
  }, [subKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== JSON.stringify(sub);
  const set = <K extends keyof SubscriptionFilter>(k: K, v: SubscriptionFilter[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const setKinds = (next: NotifyKind[]) => set("kinds", NOTIFY_KINDS.filter((k) => next.includes(k)));
  const toggleKinds = (keys: NotifyKind[], v: boolean) => draft && setKinds(v ? [...new Set([...draft.kinds, ...keys])] : draft.kinds.filter((k) => !keys.includes(k)));

  async function toggle(next: boolean) {
    setBusy("toggle");
    setErr(null);
    try {
      if (next) await api.put(SUBS_URL, { channelId: channel.id, filter: defaults(role, tz) });
      else await api.del(SUBS_URL, { channelId: channel.id });
      setOpen(next);
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
      await api.put(SUBS_URL, { channelId: channel.id, filter: { kinds: draft.kinds, subjects: draft.subjects, quiet: draft.quiet, tz } });
      toast.success(`Saved what “${channel.name}” tells you`);
      setOpen(false);
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

  const switchLabel = admin ? `Send alerts to ${channel.name}` : `Tell me on ${channel.name} when my apps stop working`;
  const digestAt = fmt.time(new Date(2000, 0, 1, data.digest.hour, 0));
  const preset: KindPreset = !draft ? "problems" : choosing ? "custom" : presetOf(draft.kinds, role);
  const aboutApps = !!draft && draft.kinds.some((k) => KIND_INFO[k].apps);

  return (
    <li className={s.sub}>
      <div className={s.subHead}>
        <span className={s.kindIcon} aria-hidden>
          {KIND_ICON[channel.kind as ChannelKind]}
        </span>
        <span className={s.subText}>
          <span className={s.subName} title={channel.name}>
            {channel.name}
          </span>
          <span className={s.subSub}>
            {!channel.enabled
              ? "This channel is turned off."
              : on
                ? describe(sub!, role)
                : admin
                  ? channel.owner
                    ? "Your channel. Not sending you anything yet."
                    : "Server-wide. Not sending you anything."
                  : "Not telling you anything yet."}
          </span>
        </span>
        <span className={s.subActions}>
          {on && channel.enabled && (
            // Hidden, not removed, while there are unsaved changes: the row keeps its shape.
            <Button size="sm" variant="ghost" className={s.change} data-hidden={dirty ? "" : undefined} aria-hidden={dirty || undefined} tabIndex={dirty ? -1 : undefined} aria-expanded={open} aria-controls={`${channel.id}-edit`} onClick={() => setOpen((o) => !o)}>
              {open ? "Close" : "Change"}
            </Button>
          )}
          <Switch checked={on} onChange={(v) => void toggle(v)} disabled={busy === "toggle" || !channel.enabled} aria-label={switchLabel} />
        </span>
      </div>

      {on && draft && channel.enabled && (open || dirty) && (
        <div className={s.subBody} id={`${channel.id}-edit`}>
          {admin ? (
            <div className={s.group}>
              <span className="label" id={`${channel.id}-about`}>
                Tell me about
              </span>
              <Segmented
                aria-label="Tell me about"
                value={preset}
                onChange={(v) => {
                  if (v === "custom") return setChoosing(true);
                  setChoosing(false);
                  setKinds(v === "all" ? kindsFor("admin") : defaultKinds("admin"));
                }}
                options={[
                  { value: "problems", label: "Problems only" },
                  { value: "all", label: "Everything" },
                  { value: "custom", label: "Choose" },
                ]}
              />
              {preset === "problems" && (
                <p className={s.hint}>Things that broke or need you, warnings about sign-ins, failed Gluon updates and household reports, and a message when each problem clears. This is the default.</p>
              )}
              {preset === "all" && (
                <p className={s.hint}>All of that, plus available and installed updates{data.digest.enabled ? ", the daily summary" : ""} and new chat accounts.</p>
              )}
              {preset === "custom" && (
                <div className={s.kindGroups}>
                  {KIND_GROUPS.map((g) => (
                    <fieldset key={g.key} className={s.kindGroup}>
                      <legend className="label">{g.label}</legend>
                      {NOTIFY_KINDS.filter((k) => KIND_INFO[k].group === g.key).map((k) => {
                        const digestOff = k === "digest" && !data.digest.enabled;
                        return (
                          <Checkbox key={k} checked={draft.kinds.includes(k)} disabled={digestOff && !draft.kinds.includes(k)} onChange={(v) => toggleKinds([k], v)}>
                            <span className={s.kindText}>
                              <span>{KIND_INFO[k].label}</span>
                              <small>
                                {k === "digest" ? (
                                  digestOff ? (
                                    <>
                                      Turned off for the server. Turn it on in <Link href="/settings/server">Settings → Server</Link>.
                                    </>
                                  ) : (
                                    `Every day at ${digestAt}: what's open, uptime and anything notable.`
                                  )
                                ) : (
                                  KIND_INFO[k].hint
                                )}
                              </small>
                            </span>
                          </Checkbox>
                        );
                      })}
                    </fieldset>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className={s.group}>
              <span className="label">Tell me</span>
              <div className={s.memberKinds}>
                <Checkbox checked={draft.kinds.includes("fault") || draft.kinds.includes("attention")} onChange={(v) => toggleKinds(["fault", "attention"], v)}>
                  <span className={s.kindText}>
                    <span>When my apps stop working</span>
                    <small>Gluon tells whoever looks after the server too.</small>
                  </span>
                </Checkbox>
                {(["resolved", "reports", "app.updated"] as const).map((k) => (
                  <Checkbox key={k} checked={draft.kinds.includes(k)} onChange={(v) => toggleKinds([k], v)}>
                    <span className={s.kindText}>
                      <span>{MEMBER_KIND_INFO[k]!.label}</span>
                      <small>{MEMBER_KIND_INFO[k]!.hint}</small>
                    </span>
                  </Checkbox>
                ))}
              </div>
            </div>
          )}

          {aboutApps && (
            <div className={s.group}>
              <span className="label" id={`${channel.id}-apps`}>
                {admin ? "Which apps" : "About"}
              </span>
              <Segmented
                aria-label="Which apps"
                value={draft.subjects === "all" ? "all" : "some"}
                onChange={(v) => set("subjects", v === "all" ? "all" : draft.subjects === "all" ? [] : draft.subjects)}
                options={[
                  { value: "all", label: admin ? "All apps" : "All my apps" },
                  { value: "some", label: "Only some apps" },
                ]}
              />
              {draft.subjects !== "all" &&
                (data.subjects.length === 0 ? (
                  <p className={s.hint}>{admin ? "No apps found." : "No apps have been shared with you yet."}</p>
                ) : (
                  <div className={s.apps}>
                    {data.subjects.map((a) => {
                      const picked = draft.subjects as string[];
                      return (
                        <Checkbox key={a.id} checked={picked.includes(a.id)} onChange={(v) => set("subjects", v ? [...picked, a.id] : picked.filter((x) => x !== a.id))}>
                          <span className={s.appCheck}>
                            <span title={a.name}>{a.name}</span>
                          </span>
                        </Checkbox>
                      );
                    })}
                  </div>
                ))}
              {admin && draft.subjects !== "all" && (
                <p className={s.hint}>Narrows problems and app updates. Problems that aren&apos;t about an app (disks, memory) stop coming; sign-in, Gluon and chat server messages still do.</p>
              )}
            </div>
          )}

          <div className={s.rows}>
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
                {admin ? "Still tell me straight away when something breaks" : "Still tell me straight away if an app stops working"}
              </Checkbox>
              <p className={s.hint}>
                Times are in {tz.replace(/_/g, " ")}
                {sub?.tz && sub.tz !== tz ? ` (saved as ${sub.tz.replace(/_/g, " ")}; saving updates it)` : ""}. Messages held overnight go out when quiet hours end, unless the problem has already cleared.
                {admin ? " Updates and everything else wait too." : ""}
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
                draft.kinds.length === 0 ? (
                  "Nothing is chosen. Pick something, or turn this channel off for you."
                ) : (
                  "You have unsaved changes."
                )
              ) : (
                ""
              )}
            </span>
            {dirty && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(sub);
                  setChoosing(!!sub && presetOf(sub.kinds, role) === "custom");
                }}
              >
                Undo changes
              </Button>
            )}
            <Button size="sm" loading={busy === "test"} onClick={() => void test()}>
              Send a test
            </Button>
            <Button size="sm" variant="primary" disabled={!dirty || draft.kinds.length === 0} loading={busy === "save"} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** One line for the row: what this channel tells you. */
export function describe(f: SubscriptionFilter, role: "admin" | "member"): string {
  let out: string;
  if (role !== "admin") {
    const bits: string[] = [];
    if (f.kinds.includes("fault") || f.kinds.includes("attention")) bits.push("when your apps stop working");
    if (f.kinds.includes("resolved")) bits.push("when they're back");
    if (f.kinds.includes("app.updated")) bits.push("when they're updated");
    if (f.kinds.includes("reports")) bits.push("replies to your reports");
    out = bits.length ? `Tells you ${bits.join(", ")}` : "Tells you nothing";
  } else {
    const preset = presetOf(f.kinds, role);
    if (preset === "all") out = "Everything";
    else if (preset === "problems") out = "Problems only";
    else {
      const groups = KIND_GROUPS.filter((g) => f.kinds.some((k) => KIND_INFO[k].group === g.key)).map((g) => g.label.toLowerCase());
      out = `Chosen: ${groups.join(", ")}`;
      out = out.charAt(0).toUpperCase() + out.slice(1);
    }
  }
  if (f.subjects !== "all") out += `, about ${f.subjects.length} app${f.subjects.length === 1 ? "" : "s"}`;
  if (f.quiet) out += `. Quiet ${f.quiet.from}–${f.quiet.to}`;
  return `${out}.`;
}
