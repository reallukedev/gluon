"use client";
import * as React from "react";
import dynamic from "next/dynamic";
import type { ChannelKind, ChannelView, SubscriptionFilter, SubscriptionsResponse, TestResult } from "@/lib/alerts-types";
import { CHANNEL_KINDS } from "@/lib/alerts-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { usePrefs } from "@/components/PrefsProvider";
import { KIND_ICON } from "@/components/alerts/kinds";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field, Input, Segmented } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Actions, PartError, StepHead, useFlow } from "../flow";
import o from "../onboarding.module.css";

// Only opened for the less common kinds ("Set up another way"): its code loads after the step shows.
const ChannelDialog = dynamic(() => import("@/components/alerts/ChannelDialog").then((m) => m.ChannelDialog), { ssr: false });

const SUBS_URL = "/api/alerts/subscriptions";
/** The "Send through" choice for entering mail server details instead. */
const OWN_SERVER = "own";

/** What a new channel sends: every problem, when it clears, and household reports. Same as Settings. */
const defaultFilter = (tz: string): Partial<SubscriptionFilter> => ({
  severities: ["fault", "attention"],
  subjects: "all",
  resolved: true,
  reports: true,
  digest: false,
  quiet: null,
  tz,
});

type Mode = "ntfy" | "email";
interface Draft {
  topic: string;
  server: string;
  to: string;
  via: string;
  host: string;
  port: string;
  security: "starttls" | "tls" | "none";
  user: string;
  pass: string;
  from: string;
}

/** A topic that's hard to guess: anyone who knows a topic on ntfy.sh can read it. */
function suggestTopic(serverName: string): string {
  const base = serverName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "gluon";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const tail = Array.from(bytes, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
  return `${base}-alerts-${tail}`;
}

/**
 * Admin: where problems reach this person. Alerts are per person, so every admin sees this step.
 * If they already hear about problems somewhere (a channel they're subscribed to), it says where and
 * offers a test. If the server already has channels, one click subscribes. Otherwise: set up ntfy
 * (a topic and the free app) or email right here, send a test, save.
 */
export function NotifyStep() {
  const { next } = useFlow();
  const { serverName, timeZone } = usePrefs();
  const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const subs = useApi<SubscriptionsResponse>(SUBS_URL, { revalidateOnFocus: false });
  const [mode, setMode] = React.useState<Mode>("ntfy");
  const [d, setD] = React.useState<Draft>({ topic: "", server: "https://ntfy.sh", to: "", via: "", host: "", port: "", security: "starttls", user: "", pass: "", from: "" });
  const [busy, setBusy] = React.useState<"test" | "save" | string | null>(null);
  const [err, setErr] = React.useState<{ message: string; field?: string } | null>(null);
  const [tested, setTested] = React.useState<TestResult | null>(null);
  const [dialog, setDialog] = React.useState(false);
  // A channel saved but not yet switched on (the second request failed): don't make it twice.
  const [madeId, setMadeId] = React.useState<string | null>(null);

  // The suggestion is random, so it's made in the browser after the first render.
  React.useEffect(() => setD((x) => (x.topic ? x : { ...x, topic: suggestTopic(serverName) })), [serverName]);
  React.useEffect(() => {
    const first = subs.data?.mailSetups[0]?.id;
    if (first) setD((x) => (x.via ? x : { ...x, via: first }));
  }, [subs.data]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    setTested(null);
    setErr(null);
  };

  const vias = subs.data?.mailSetups ?? [];
  const useVia = mode === "email" && vias.some((v) => v.id === d.via);

  function config(): { kind: ChannelKind; name: string; config: Record<string, unknown> } {
    if (mode === "ntfy") {
      return { kind: "ntfy", name: "Phone (ntfy)", config: { server: d.server.trim() || "https://ntfy.sh", topic: d.topic.trim(), token: null, username: null, password: null } };
    }
    const to = d.to.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (useVia) return { kind: "email", name: to[0] ?? "Email", config: { via: d.via, to, host: null, port: null, user: null, pass: null, from: null } };
    return {
      kind: "email",
      name: to[0] ?? "Email",
      config: {
        via: null,
        host: d.host.trim(),
        port: d.port ? Number(d.port) : null,
        security: d.security,
        allowSelfSigned: false,
        user: d.user.trim() || null,
        pass: d.user.trim() ? d.pass || null : null,
        from: d.from.trim() || null,
        to,
      },
    };
  }

  function precheck(): boolean {
    if (mode === "ntfy" && !d.topic.trim()) {
      setErr({ message: "Choose a topic.", field: "config.topic" });
      return false;
    }
    if (mode === "email") {
      if (!d.to.trim()) {
        setErr({ message: "Enter the address to send to.", field: "config.to" });
        return false;
      }
      if (!useVia && !d.host.trim()) {
        setErr({ message: "Enter your mail server, like smtp.example.com.", field: "config.host" });
        return false;
      }
    }
    return true;
  }

  async function test() {
    if (!precheck()) return;
    setBusy("test");
    setTested(null);
    setErr(null);
    const c = config();
    try {
      setTested(await api.post<TestResult>("/api/alerts/channels/test", { kind: c.kind, scope: "personal", config: c.config }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      if (e instanceof ApiError && e.field) setErr({ message: e.message, field: e.field });
      else setTested({ ok: false, message: e instanceof Error ? e.message : "Couldn't send a test.", latencyMs: 0 });
    } finally {
      setBusy(null);
    }
  }

  async function subscribe(channelId: string) {
    await api.put(SUBS_URL, { channelId, filter: defaultFilter(tz) });
  }

  async function save() {
    if (!precheck()) return;
    setBusy("save");
    setErr(null);
    let id = madeId;
    try {
      if (!id) {
        const c = config();
        const ch = await api.post<ChannelView>("/api/alerts/channels", { kind: c.kind, name: c.name, scope: "personal", enabled: true, config: c.config });
        id = ch.id;
        setMadeId(id);
      }
      await subscribe(id);
      next();
    } catch (e) {
      setBusy(null);
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      const message = e instanceof Error ? e.message : "Couldn't save that.";
      setErr(id ? { message: `Saved, but couldn't switch it on. ${message}` } : { message, field: e instanceof ApiError ? e.field : undefined });
    }
  }

  async function subscribeTo(id: string) {
    setBusy(id);
    setErr(null);
    try {
      await subscribe(id);
      await subs.mutate();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) setErr({ message: e instanceof Error ? e.message : "Couldn't switch that on." });
    } finally {
      setBusy(null);
    }
  }

  const fe = (field: string) => (err?.field === `config.${field}` || err?.field === field ? err.message : null);
  const general = err && !(err.field && /^config\.(topic|server|to|host|port|user|pass|from|via)$/.test(err.field)) ? err.message : null;

  const data = subs.data;
  const subscribed = data?.subscriptions ?? [];
  const serverWide = (data?.channels ?? []).filter((c) => c.owner === null && c.enabled && !subscribed.some((s) => s.channelId === c.id));

  const head = (
    <StepHead title="Where should problems reach you?">
      <p>When something breaks, like an app that stops or a drive that&apos;s nearly full, Gluon can tell you straight away instead of waiting for you to look.</p>
    </StepHead>
  );

  if (subs.error && !data) {
    return (
      <>
        {head}
        <PartError message={`Couldn't read your notification settings. ${subs.error.message}`} onRetry={() => void subs.mutate()} />
        <Actions skip={{ label: "Skip for now", onClick: next }} />
      </>
    );
  }

  if (!data) {
    return (
      <>
        {head}
        <div className={o.stack} aria-busy>
          <Skeleton width={220} height={32} radius={9} />
          <Skeleton height={34} radius={8} />
          <Skeleton width="70%" height={12} />
        </div>
        <Actions />
      </>
    );
  }

  // Already reaching them somewhere: say where, let them try it.
  if (subscribed.length > 0) {
    return (
      <>
        {head}
        <ul className={o.list} aria-label="Where problems reach you">
          {subscribed.map((s) => (
            <SubscribedRow key={s.channelId} id={s.channelId} name={s.channelName} kind={s.channelKind} />
          ))}
        </ul>
        <p className={o.note}>Add more places, quiet hours and what each one sends in Settings → Notifications.</p>
        <Actions
          primary={
            <Button variant="primary" onClick={next}>
              Continue
            </Button>
          }
        />
      </>
    );
  }

  return (
    <>
      {head}

      {serverWide.length > 0 && (
        <section className={o.stack} aria-labelledby="existing-channels">
          <h2 id="existing-channels" className={o.sectionTitle}>
            Already set up on {serverName}
          </h2>
          <ul className={o.list}>
            {serverWide.map((c) => (
              <li key={c.id} className={o.listRow}>
                <span className={o.kind} aria-hidden>
                  {KIND_ICON[c.kind]}
                </span>
                <span className={o.listText}>
                  <b title={c.name}>{c.name}</b>
                  <span>Shared by the whole server. Not sending you anything yet.</span>
                </span>
                <Button size="sm" loading={busy === c.id} disabled={!!busy && busy !== c.id} onClick={() => void subscribeTo(c.id)}>
                  Send alerts to me here
                </Button>
              </li>
            ))}
          </ul>
          <h2 className={o.sectionTitle}>Or add your own</h2>
        </section>
      )}

      <form
        className={o.stack}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void save();
        }}
      >
<div>
        <Segmented
          aria-label="How to reach you"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setTested(null);
            setErr(null);
          }}
          options={[
            { value: "ntfy", label: "Phone (ntfy)" },
            { value: "email", label: "Email" },
          ]}
        />
        </div>

        {mode === "ntfy" ? (
          <div className={o.stack}>
            <ol className={o.howto}>
              <li>
                <span>
                  Install <b>ntfy</b> on your phone. It&apos;s free, for iPhone and Android.
                </span>
              </li>
              <li>
                <span>In the app, subscribe to the topic below.</span>
              </li>
              <li>
                <span>Send a test to check it arrives.</span>
              </li>
            </ol>
            <Field label="Topic" error={fe("topic")} description="Anyone who knows a topic on ntfy.sh can read it, so this one is hard to guess on purpose.">
              <Input mono value={d.topic} onChange={(e) => set("topic", e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={64} />
            </Field>
            <Disclosure summary="Use your own ntfy server" defaultOpen={!!fe("server")}>
              <Field label="Server" error={fe("server")}>
                <Input mono value={d.server} onChange={(e) => set("server", e.target.value)} inputMode="url" autoCapitalize="none" spellCheck={false} />
              </Field>
            </Disclosure>
          </div>
        ) : (
          <div className={o.stack}>
            <Field label="Your email address" error={fe("to")}>
              <Input type="email" value={d.to} onChange={(e) => set("to", e.target.value)} autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} />
            </Field>
            {vias.length > 0 && (
              <Field label="Send through" description="A mail server already set up on this server.">
                <Select
                  aria-label="Send through"
                  value={d.via}
                  onChange={(v) => set("via", v)}
                  options={[...vias.map((v) => ({ value: v.id, label: v.name })), { value: OWN_SERVER, label: "A different mail server…" }]}
                />
              </Field>
            )}
            {!useVia && (
              <fieldset className={o.fieldset}>
                <legend>Mail server</legend>
                <p className={o.note}>The server Gluon sends through: your email provider&apos;s SMTP details, often in its help pages under &ldquo;other mail apps&rdquo;.</p>
                <div className={o.pair}>
                  <Field label="Server" error={fe("host")}>
                    <Input mono value={d.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.example.com" autoCapitalize="none" spellCheck={false} />
                  </Field>
                  <Field label="Port" optional error={fe("port")}>
                    <Input className="num" value={d.port} onChange={(e) => set("port", e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" placeholder={d.security === "tls" ? "465" : "587"} />
                  </Field>
                </div>
                <Segmented
                  aria-label="Connection security"
                  value={d.security}
                  onChange={(v) => set("security", v)}
                  options={[
                    { value: "starttls", label: "STARTTLS" },
                    { value: "tls", label: "TLS" },
                    { value: "none", label: "None" },
                  ]}
                />
                <div className={o.pair}>
                  <Field label="Username" optional error={fe("user")}>
                    <Input value={d.user} onChange={(e) => set("user", e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
                  </Field>
                  <Field label="Password" optional error={fe("pass")}>
                    <Input type="password" value={d.pass} onChange={(e) => set("pass", e.target.value)} autoComplete="new-password" disabled={!d.user.trim()} />
                  </Field>
                </div>
                <Field label="Send from" optional error={fe("from")} description="Leave empty to use the username.">
                  <Input type="email" value={d.from} onChange={(e) => set("from", e.target.value)} placeholder={`gluon@${serverName.toLowerCase()}`} autoCapitalize="none" spellCheck={false} />
                </Field>
              </fieldset>
            )}
          </div>
        )}

        <div className={o.testRow}>
          <Button onClick={() => void test()} loading={busy === "test"} disabled={busy === "save"}>
            Send a test
          </Button>
          <span className={o.testResult} aria-live="polite">
            {tested && (
              <>
                <StateLine state={tested.ok ? "running" : "unhealthy"} size={12} label={false} />
                <span>{tested.ok ? tested.message : `Didn't go through. ${tested.message}`}</span>
              </>
            )}
          </span>
        </div>

        {general && (
          <p className={o.error} role="alert">
            {general}
          </p>
        )}

        <p className={o.note}>
          Pushover, Discord, Slack or a webhook instead?{" "}
          <button type="button" className={o.inlineLink} onClick={() => setDialog(true)}>
            Set up another way
          </button>
        </p>
      </form>

      <Actions
        skip={{ label: "Only show problems here", onClick: next, disabled: !!busy }}
        primary={
          <Button variant="primary" onClick={() => void save()} loading={busy === "save"} disabled={busy === "test"}>
            Save and continue
          </Button>
        }
      />

      <ChannelDialog
        open={dialog}
        onOpenChange={setDialog}
        channel={null}
        scope="personal"
        admin
        kinds={[...CHANNEL_KINDS]}
        emailVias={vias}
        onSaved={async (c) => {
          try {
            await subscribe(c.id);
          } catch {
            /* the channel exists; Settings → Notifications can switch it on */
          }
          void subs.mutate();
        }}
      />
    </>
  );
}

function SubscribedRow({ id, name, kind }: { id: string; name: string; kind: ChannelKind }) {
  const [busy, setBusy] = React.useState(false);
  const [tested, setTested] = React.useState<TestResult | null>(null);
  async function test() {
    setBusy(true);
    setTested(null);
    try {
      setTested(await api.post<TestResult>("/api/alerts/channels/test", { id }));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "reauth_cancelled")) setTested({ ok: false, message: e instanceof Error ? e.message : "Couldn't send a test.", latencyMs: 0 });
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className={o.listRow}>
      <span className={o.kind} aria-hidden>
        {KIND_ICON[kind]}
      </span>
      <span className={o.listText}>
        <b title={name}>{name}</b>
        <span aria-live="polite">
          {tested ? (
            <span className={o.testResult}>
              <StateLine state={tested.ok ? "running" : "unhealthy"} size={12} label={false} />
              {tested.ok ? tested.message : `Didn't go through. ${tested.message}`}
            </span>
          ) : (
            "Problems reach you here."
          )}
        </span>
      </span>
      <Button size="sm" loading={busy} onClick={() => void test()}>
        Send a test
      </Button>
    </li>
  );
}
