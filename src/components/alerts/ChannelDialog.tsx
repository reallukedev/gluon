"use client";
import * as React from "react";
import { Plus, Trash } from "iconoir-react";
import type { ChannelKind, ChannelView, TestResult, XmppServersResponse } from "@/lib/alerts-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { Dialog } from "@/components/ui/Dialog";
import { Disclosure } from "@/components/ui/Disclosure";
import { Button, IconButton } from "@/components/ui/Button";
import { Checkbox, Field, Input, Segmented } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Notice } from "@/components/ui/Surface";
import { toast } from "@/components/ui/Toast";
import { KIND_ICON } from "./kinds";
import s from "./alerts.module.css";

export { KIND_ICON };
export const KIND_INFO: Record<ChannelKind, { label: string; hint: string }> = {
  ntfy: { label: "ntfy", hint: "Free push to the ntfy app" },
  pushover: { label: "Pushover", hint: "Push to the Pushover app" },
  email: { label: "Email", hint: "Messages to an inbox" },
  webhook: { label: "Webhook", hint: "Discord, Slack or your own" },
  xmpp: { label: "XMPP chat", hint: "Messages in your chat app" },
};

const NTFY_PRIORITIES = [
  { value: "1", label: "Min (no sound)" },
  { value: "2", label: "Low" },
  { value: "3", label: "Default" },
  { value: "4", label: "High" },
  { value: "5", label: "Urgent (breaks through)" },
];
const PUSHOVER_PRIORITIES = [
  { value: "-2", label: "Silent" },
  { value: "-1", label: "Quiet" },
  { value: "0", label: "Normal" },
  { value: "1", label: "High (ignores quiet hours on the phone)" },
];
type Pri = { fault: string; attention: string; resolved: string; digest: string };

interface Draft {
  kind: ChannelKind;
  name: string;
  // ntfy
  server: string;
  topic: string;
  auth: "none" | "token" | "basic";
  token: string;
  username: string;
  password: string;
  ntfyPri: Pri;
  // pushover
  userKey: string;
  appToken: string;
  device: string;
  pushPri: Pri;
  // email
  mode: "via" | "smtp";
  via: string;
  host: string;
  port: string;
  security: "tls" | "starttls" | "none";
  allowSelfSigned: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
  // webhook
  format: "json" | "discord" | "slack";
  url: string;
  headers: { name: string; value: string; saved: boolean }[];
  // xmpp
  xmode: "server" | "account";
  /** "<app>|<domain>" of a chat server Gluon runs. */
  xfrom: string;
  jid: string;
  xpass: string;
  xserver: string;
  allowUntrusted: boolean;
  xto: string;
  xrooms: string;
  nick: string;
}

type Cfg = Record<string, unknown>;
/** Fields that render their own error message. */
const FIELDS = new Set(["name", ...["server", "topic", "token", "username", "password", "userKey", "appToken", "device", "to", "via", "host", "port", "user", "pass", "from", "url", "headers", "app", "domain", "jid", "rooms", "nick", "mode"].map((f) => `config.${f}`)]);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const priOf = (v: unknown, d: Pri): Pri => {
  const o = (v ?? {}) as Record<string, number>;
  return { fault: String(o.fault ?? d.fault), attention: String(o.attention ?? d.attention), resolved: String(o.resolved ?? d.resolved), digest: String(o.digest ?? d.digest) };
};

function draftFrom(ch: ChannelView | null, kind: ChannelKind, vias: { id: string }[]): Draft {
  const c: Cfg = ch?.config ?? {};
  const sec = ch?.secrets ?? {};
  return {
    kind,
    name: ch?.name ?? "",
    server: str(c.server) || "https://ntfy.sh",
    topic: str(c.topic),
    auth: sec.token ? "token" : str(c.username) ? "basic" : "none",
    token: "",
    username: str(c.username),
    password: "",
    ntfyPri: priOf(c.priorities, { fault: "5", attention: "3", resolved: "2", digest: "2" }),
    userKey: "",
    appToken: "",
    device: str(c.device),
    pushPri: priOf(c.priorities, { fault: "1", attention: "0", resolved: "-1", digest: "-1" }),
    mode: ch ? (str(c.via) ? "via" : "smtp") : vias.length ? "via" : "smtp",
    via: str(c.via) || vias[0]?.id || "",
    host: str(c.host),
    port: c.port ? String(c.port) : "",
    security: (str(c.security) as Draft["security"]) || "starttls",
    allowSelfSigned: !!c.allowSelfSigned,
    user: str(c.user),
    pass: "",
    from: str(c.from),
    to: Array.isArray(c.to) ? (c.to as string[]).join(", ") : "",
    format: (str(c.format) as Draft["format"]) || "json",
    url: "",
    headers: Array.isArray(c.headers) ? (c.headers as { name: string; value: string | null }[]).map((h) => ({ name: h.name, value: "", saved: !!h.value })) : [],
    xmode: kind === "xmpp" && str(c.mode) === "account" ? "account" : "server",
    xfrom: str(c.app) && str(c.domain) ? `${str(c.app)}|${str(c.domain)}` : "",
    jid: str(c.jid),
    xpass: "",
    xserver: kind === "xmpp" ? str(c.server) : "",
    allowUntrusted: !!c.allowUntrusted,
    xto: Array.isArray(c.to) && kind === "xmpp" ? (c.to as string[]).join(", ") : "",
    xrooms: Array.isArray(c.rooms) ? (c.rooms as string[]).join(", ") : "",
    nick: str(c.nick) || "Gluon",
  };
}

const list = (v: string) => v.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

/** Build the config to send. Secrets left empty are omitted (the server keeps the saved one). */
function configOf(d: Draft, editing: boolean): Cfg {
  const secret = (v: string) => (v.trim() ? v.trim() : editing ? undefined : null);
  switch (d.kind) {
    case "ntfy":
      return {
        server: d.server.trim(),
        topic: d.topic.trim(),
        token: d.auth === "token" ? secret(d.token) : null,
        username: d.auth === "basic" ? d.username.trim() || null : null,
        password: d.auth === "basic" ? secret(d.password) : null,
        priorities: Object.fromEntries(Object.entries(d.ntfyPri).map(([k, v]) => [k, Number(v)])),
      };
    case "pushover":
      return {
        userKey: secret(d.userKey),
        appToken: secret(d.appToken),
        device: d.device.trim() || null,
        priorities: Object.fromEntries(Object.entries(d.pushPri).map(([k, v]) => [k, Number(v)])),
      };
    case "email": {
      const to = d.to.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
      if (d.mode === "via") return { via: d.via, to, host: null, port: null, user: null, pass: null, from: null };
      return {
        via: null,
        host: d.host.trim(),
        port: d.port ? Number(d.port) : null,
        security: d.security,
        allowSelfSigned: d.allowSelfSigned,
        user: d.user.trim() || null,
        pass: d.user.trim() ? secret(d.pass) : null,
        from: d.from.trim() || null,
        to,
      };
    }
    case "webhook":
      return {
        format: d.format,
        url: secret(d.url),
        headers: d.format === "json" ? d.headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.value.trim() ? h.value.trim() : h.saved ? undefined : null })) : [],
      };
    case "xmpp": {
      const [app, domain] = d.xfrom.split("|");
      const common = { to: list(d.xto), rooms: list(d.xrooms), nick: d.nick.trim() || "Gluon" };
      if (d.xmode === "server") return { mode: "server", app: app || null, domain: domain || null, ...common };
      return { mode: "account", jid: d.jid.trim(), password: secret(d.xpass), server: d.xserver.trim() || null, allowUntrusted: d.allowUntrusted, ...common };
    }
  }
}

export interface ChannelDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Editing this channel; null = adding one. */
  channel: ChannelView | null;
  scope: "server" | "personal";
  /** The viewer is an admin (may enter mail server details). */
  admin: boolean;
  kinds: ChannelKind[];
  /** Server-wide email channels a new email channel can send through. */
  emailVias: { id: string; name: string }[];
  onSaved: (c: ChannelView) => void;
  /** Start a new channel on this kind (skips the "where should alerts go?" step). */
  initialKind?: ChannelKind | null;
}

export function ChannelDialog({ open, onOpenChange, channel, scope, admin, kinds, emailVias, onSaved, initialKind }: ChannelDialogProps) {
  const [picked, setPicked] = React.useState<ChannelKind | null>(channel?.kind ?? null);
  const [d, setD] = React.useState<Draft>(() => draftFrom(channel, channel?.kind ?? kinds[0]!, emailVias));
  const [busy, setBusy] = React.useState<"save" | "test" | null>(null);
  const [err, setErr] = React.useState<{ message: string; field?: string } | null>(null);
  const [test, setTest] = React.useState<TestResult | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const k = channel?.kind ?? (initialKind && kinds.includes(initialKind) ? initialKind : kinds.length === 1 ? kinds[0]! : null);
    setPicked(k);
    setD(draftFrom(channel, k ?? kinds[0]!, emailVias));
    setErr(null);
    setTest(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, channel]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    setTest(null);
  };
  const editing = !!channel;
  const fe = (...fields: string[]) => (err?.field && fields.some((f) => err.field === `config.${f}` || err.field === f) ? err.message : null);
  const saved = (k: string) => !!channel?.secrets?.[k];
  const secretHint = (k: string) => (saved(k) ? `Saved (${String(channel?.config?.[k] ?? "hidden")}). Leave empty to keep it.` : undefined);

  function choose(k: ChannelKind) {
    setPicked(k);
    setD(draftFrom(null, k, emailVias));
  }

  async function run(kind: "save" | "test") {
    setBusy(kind);
    setErr(null);
    if (kind === "test") setTest(null);
    const config = configOf(d, editing);
    try {
      if (kind === "test") {
        const r = await api.post<TestResult>("/api/alerts/channels/test", editing ? { id: channel!.id, config } : { kind: d.kind, scope, config });
        setTest(r);
      } else {
        const name = d.name.trim() || defaultName(d);
        const r = editing
          ? await api.patch<ChannelView>(`/api/alerts/channels/${encodeURIComponent(channel!.id)}`, { name, config })
          : await api.post<ChannelView>("/api/alerts/channels", { kind: d.kind, name, scope, enabled: true, config });
        toast.success(editing ? `Saved “${r.name}”` : `Added “${r.name}”`, { description: editing ? undefined : scope === "personal" ? (admin ? "It sends you problems only. Change that below." : "It tells you when your apps stop working. Change that below.") : "It sends you problems only. Change that in Settings → Notifications." });
        onSaved(r);
        onOpenChange(false);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      setErr({ message: e instanceof Error ? e.message : "That didn't work.", field: e instanceof ApiError ? e.field : undefined });
    } finally {
      setBusy(null);
    }
  }

  const unknownErr = err && (!err.field || !FIELDS.has(err.field)) ? err.message : null;
  const title = editing
    ? `Edit “${channel!.name}”`
    : picked === "xmpp"
      ? "Send alerts to a chat app"
      : picked
        ? `Add ${KIND_INFO[picked].label}`
        : scope === "server"
          ? "Add a server-wide channel"
          : "Add a way to reach you";

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={!picked ? "Where should alerts go?" : undefined}
      footerStart={
        picked ? (
          <Button onClick={() => void run("test")} loading={busy === "test"} disabled={busy === "save"}>
            Send a test
          </Button>
        ) : undefined
      }
      footer={
        <>
          {!editing && picked && kinds.length > 1 && (
            <Button variant="ghost" onClick={() => setPicked(null)} disabled={!!busy}>
              Back
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={!!busy}>
            Cancel
          </Button>
          {picked && (
            <Button variant="primary" loading={busy === "save"} disabled={busy === "test"} onClick={() => void run("save")}>
              {editing ? "Save" : "Add channel"}
            </Button>
          )}
        </>
      }
    >
      {!picked ? (
        <div className={s.kindGrid}>
          {kinds.map((k) => (
            <button key={k} type="button" className={s.kindChoice} aria-pressed={false} onClick={() => choose(k)}>
              {KIND_ICON[k]}
              {KIND_INFO[k].label}
              <small>{KIND_INFO[k].hint}</small>
            </button>
          ))}
        </div>
      ) : (
        <form
          className={s.form}
          onSubmit={(e) => {
            e.preventDefault();
            void run("save");
          }}
        >
          <div data-field="name">
            <Field label="Name" error={fe("name")} description="How it's listed in Gluon.">
              <Input value={d.name} onChange={(e) => set("name", e.target.value)} placeholder={defaultName(d)} maxLength={60} />
            </Field>
          </div>

          {d.kind === "ntfy" && (
            <>
              <div className={s.row2}>
                <div data-field="config.server">
                  <Field label="Server" error={fe("server")} description="ntfy.sh, or your own ntfy server.">
                    <Input mono value={d.server} onChange={(e) => set("server", e.target.value)} spellCheck={false} autoCapitalize="off" inputMode="url" />
                  </Field>
                </div>
                <div data-field="config.topic">
                  <Field label="Topic" error={fe("topic")} description="Subscribe to the same topic in the ntfy app.">
                    <Input mono value={d.topic} onChange={(e) => set("topic", e.target.value)} placeholder="home-alerts-7f3k" spellCheck={false} autoCapitalize="off" />
                  </Field>
                </div>
              </div>
              {d.server.includes("ntfy.sh") && (
                <p className={s.note}>
                  Topics on ntfy.sh are public: anyone who guesses the name can read them. Use a long, random topic or an access token.
                </p>
              )}
              <Field label="Sign-in">
                <Segmented
                  aria-label="ntfy sign-in"
                  value={d.auth}
                  onChange={(v) => set("auth", v)}
                  options={[
                    { value: "none", label: "None" },
                    { value: "token", label: "Access token" },
                    { value: "basic", label: "Username & password" },
                  ]}
                />
              </Field>
              {d.auth === "token" && (
                <div data-field="config.token">
                  <Field label="Access token" error={fe("token")} description={secretHint("token") ?? "Starts with tk_. Create one in the ntfy app under Account → Access tokens."}>
                    <Input mono type="password" autoComplete="off" value={d.token} onChange={(e) => set("token", e.target.value)} placeholder={saved("token") ? "••••••••" : "tk_…"} />
                  </Field>
                </div>
              )}
              {d.auth === "basic" && (
                <div className={s.row2}>
                  <div data-field="config.username">
                    <Field label="Username" error={fe("username")}>
                      <Input value={d.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" autoCapitalize="off" />
                    </Field>
                  </div>
                  <div data-field="config.password">
                    <Field label="Password" error={fe("password")} description={secretHint("password")}>
                      <Input type="password" autoComplete="new-password" value={d.password} onChange={(e) => set("password", e.target.value)} placeholder={saved("password") ? "••••••••" : undefined} />
                    </Field>
                  </div>
                </div>
              )}
              <PriorityFields value={d.ntfyPri} onChange={(v) => set("ntfyPri", v)} options={NTFY_PRIORITIES} />
            </>
          )}

          {d.kind === "pushover" && (
            <>
              <div data-field="config.userKey">
                <Field label="Your user key" error={fe("userKey")} description={secretHint("userKey") ?? "Shown on pushover.net after you sign in."}>
                  <Input mono autoComplete="off" value={d.userKey} onChange={(e) => set("userKey", e.target.value)} placeholder={saved("userKey") ? "••••••••" : undefined} spellCheck={false} />
                </Field>
              </div>
              <div data-field="config.appToken">
                <Field label="Application token" error={fe("appToken")} description={secretHint("appToken") ?? "Create an application called Gluon at pushover.net/apps/build."}>
                  <Input mono autoComplete="off" value={d.appToken} onChange={(e) => set("appToken", e.target.value)} placeholder={saved("appToken") ? "••••••••" : undefined} spellCheck={false} />
                </Field>
              </div>
              <div data-field="config.device">
                <Field label="Only this device" optional error={fe("device")} description="Leave empty to send to all your devices.">
                  <Input value={d.device} onChange={(e) => set("device", e.target.value)} maxLength={64} />
                </Field>
              </div>
              <PriorityFields value={d.pushPri} onChange={(v) => set("pushPri", v)} options={PUSHOVER_PRIORITIES} />
            </>
          )}

          {d.kind === "email" && (
            <>
              <div data-field="config.to">
                <Field label="Send to" error={fe("to")} description="One or more addresses, separated by commas.">
                  <Input value={d.to} onChange={(e) => set("to", e.target.value)} placeholder="you@example.com" inputMode="email" autoCapitalize="off" spellCheck={false} />
                </Field>
              </div>
              {emailVias.length > 0 && (
                <Field label="Send it using">
                  <Segmented
                    aria-label="Mail server"
                    value={d.mode}
                    onChange={(v) => set("mode", v)}
                    options={[
                      { value: "via", label: "The server's mail setup" },
                      ...(admin ? [{ value: "smtp" as const, label: "A mail server I enter" }] : []),
                    ]}
                  />
                </Field>
              )}
              {d.mode === "via" && emailVias.length > 0 ? (
                <div data-field="config.via">
                  <Field label="Mail setup" error={fe("via")}>
                    <Select aria-label="Mail setup" value={d.via} onChange={(v) => set("via", v)} options={emailVias.map((v) => ({ value: v.id, label: v.name }))} />
                  </Field>
                </div>
              ) : !admin ? (
                <Notice tone="attention" title="Email isn't set up on this server yet">
                  Ask whoever looks after the server to add an email channel. Until then, use ntfy.
                </Notice>
              ) : (
                <>
                  <div className={s.row3}>
                    <div data-field="config.host" className={s.span2}>
                      <Field label="Mail server (SMTP)" error={fe("host")}>
                        <Input mono value={d.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.fastmail.com" spellCheck={false} autoCapitalize="off" />
                      </Field>
                    </div>
                    <div data-field="config.port">
                      <Field label="Port" optional error={fe("port")}>
                        <Input
                          className="num"
                          inputMode="numeric"
                          value={d.port}
                          onChange={(e) => set("port", e.target.value.replace(/\D/g, "").slice(0, 5))}
                          placeholder={d.security === "tls" ? "465" : d.security === "starttls" ? "587" : "25"}
                        />
                      </Field>
                    </div>
                  </div>
                  <Field label="Security">
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
                  </Field>
                  <div className={s.row2}>
                    <div data-field="config.user">
                      <Field label="Username" optional error={fe("user")}>
                        <Input value={d.user} onChange={(e) => set("user", e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
                      </Field>
                    </div>
                    <div data-field="config.pass">
                      <Field label="Password" error={fe("pass")} description={secretHint("pass") ?? "Often an app password, not your normal one."}>
                        <Input type="password" autoComplete="new-password" value={d.pass} onChange={(e) => set("pass", e.target.value)} disabled={!d.user.trim()} placeholder={saved("pass") ? "••••••••" : undefined} />
                      </Field>
                    </div>
                  </div>
                  <div data-field="config.from">
                    <Field label="From" optional error={fe("from")} description="Defaults to the username.">
                      <Input value={d.from} onChange={(e) => set("from", e.target.value)} placeholder="Gluon <gluon@example.com>" autoCapitalize="off" spellCheck={false} />
                    </Field>
                  </div>
                  <Checkbox checked={d.allowSelfSigned} onChange={(v) => set("allowSelfSigned", v)}>
                    Accept a self-signed certificate (a relay on the home network)
                  </Checkbox>
                </>
              )}
            </>
          )}

          {d.kind === "webhook" && (
            <>
              <Field label="Format">
                <Segmented
                  aria-label="Webhook format"
                  value={d.format}
                  onChange={(v) => set("format", v)}
                  options={[
                    { value: "discord", label: "Discord" },
                    { value: "slack", label: "Slack" },
                    { value: "json", label: "Plain JSON" },
                  ]}
                />
              </Field>
              <div data-field="config.url">
                <Field
                  label="Webhook address"
                  error={fe("url")}
                  description={
                    secretHint("url") ??
                    (d.format === "discord"
                      ? "In Discord: channel settings → Integrations → Webhooks → Copy Webhook URL."
                      : d.format === "slack"
                        ? "From a Slack app's Incoming Webhooks page (starts with https://hooks.slack.com/)."
                        : "Gluon POSTs a JSON object with event, level, title, body and link.")
                  }
                >
                  <Input mono type="password" autoComplete="off" value={d.url} onChange={(e) => set("url", e.target.value)} placeholder={saved("url") ? String(channel?.config?.url ?? "") : "https://…"} spellCheck={false} />
                </Field>
              </div>
              {d.format === "json" && (
                <Disclosure summary="Extra headers" defaultOpen={d.headers.length > 0} variant="panel">
                  <div className={s.disclosureBody}>
                    <div className={s.headerList} data-field="config.headers">
                      {d.headers.map((h, i) => (
                        <div key={i} className={s.headerRow}>
                          <Input mono aria-label="Header name" value={h.name} placeholder="Authorization" onChange={(e) => set("headers", d.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                          <Input
                            mono
                            type="password"
                            aria-label="Header value"
                            autoComplete="off"
                            value={h.value}
                            placeholder={h.saved ? "Saved. Leave empty to keep" : "Bearer …"}
                            onChange={(e) => set("headers", d.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                          />
                          <IconButton label="Remove header" size="sm" onClick={() => set("headers", d.headers.filter((_, j) => j !== i))}>
                            <Trash />
                          </IconButton>
                        </div>
                      ))}
                      {fe("headers") && <p className={s.error}>{fe("headers")}</p>}
                      <div>
                        <Button size="sm" icon={<Plus />} onClick={() => set("headers", [...d.headers, { name: "", value: "", saved: false }])} disabled={d.headers.length >= 8}>
                          Add header
                        </Button>
                      </div>
                    </div>
                  </div>
                </Disclosure>
              )}
            </>
          )}

          {d.kind === "xmpp" && <XmppFields d={d} set={set} fe={fe} admin={admin} secretHint={secretHint} saved={saved} />}

          {editing && d.kind === "ntfy" && d.auth === "none" && (channel!.secrets.token || channel!.secrets.password) && (
            <p className={s.note}>
              Saving removes the stored sign-in.
            </p>
          )}
          {unknownErr && (
            <p className={s.error} role="alert">
              {unknownErr}
            </p>
          )}
          {/* Phones show the dialog as a sheet without the footer's left side, so the test lives here too. */}
          <div className={s.phoneTest}>
            <Button block onClick={() => void run("test")} loading={busy === "test"} disabled={busy === "save"}>
              Send a test
            </Button>
          </div>
          {test && (
            <div className={s.testResult}>
              <Notice tone={test.ok ? "neutral" : "fault"} title={test.ok ? "Test sent" : "The test didn't go through"}>
                {test.message}
                {test.ok ? "" : " Nothing was saved."}
              </Notice>
            </div>
          )}
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}

function PriorityFields({ value, onChange, options }: { value: Pri; onChange: (v: Pri) => void; options: { value: string; label: string }[] }) {
  return (
    <Disclosure summary="How loud each message is" variant="panel">
      <div className={s.disclosureBody}>
        <div className={s.row2}>
          {(
            [
              ["fault", "Something is broken"],
              ["attention", "Something needs attention"],
              ["resolved", "A problem cleared"],
              ["digest", "Daily summary"],
            ] as const
          ).map(([k, label]) => (
            <Field key={k} label={label}>
              <Select aria-label={label} value={value[k]} onChange={(v) => onChange({ ...value, [k]: v })} options={options} />
            </Field>
          ))}
        </div>
      </div>
    </Disclosure>
  );
}

function defaultName(d: Draft): string {
  switch (d.kind) {
    case "ntfy":
      return d.topic ? `ntfy · ${d.topic}` : "Phone (ntfy)";
    case "pushover":
      return d.device ? `Pushover · ${d.device}` : "Phone (Pushover)";
    case "email":
      return d.to.split(/[\s,;]+/)[0] || "Email";
    case "webhook":
      return d.format === "discord" ? "Discord" : d.format === "slack" ? "Slack" : "Webhook";
    case "xmpp": {
      const first = list(d.xrooms)[0] ?? list(d.xto)[0];
      return first ? `Chat · ${first.split("@")[0]}` : "Chat";
    }
  }
}

type SetDraft = <K extends keyof Draft>(k: K, v: Draft[K]) => void;

function XmppFields({
  d,
  set,
  fe,
  admin,
  secretHint,
  saved,
}: {
  d: Draft;
  set: SetDraft;
  fe: (...f: string[]) => string | null;
  admin: boolean;
  secretHint: (k: string) => string | undefined;
  saved: (k: string) => boolean;
}) {
  const { data, error, isLoading } = useApi<XmppServersResponse>("/api/alerts/xmpp");
  const servers = data?.servers ?? [];
  const choices = servers.flatMap((sv) => sv.domains.map((dm) => ({ value: `${sv.app}|${dm.domain}`, label: servers.length > 1 || sv.domains.length > 1 ? `${dm.domain} (${sv.name})` : dm.domain, sv, dm })));
  const chosen = choices.find((c) => c.value === d.xfrom) ?? null;
  const none = !isLoading && choices.length === 0;

  // Pick the only chat server there is; with none, an admin starts on "an account".
  React.useEffect(() => {
    if (d.xmode !== "server" || isLoading) return;
    if (!d.xfrom && choices[0]) set("xfrom", choices[0].value);
    else if (none && admin && !d.xfrom) set("xmode", "account");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, choices.length]);

  const sender = chosen ? `gluon@${chosen.dm.domain}` : null;
  const people = d.xmode === "server" ? (chosen?.dm.accounts ?? []) : [];
  const rooms = d.xmode === "server" ? (chosen?.dm.rooms ?? []) : [];
  const stopped = servers.filter((sv) => sv.problem);

  return (
    <>
      {admin && (
        <Field label="Send from" description={d.xmode === "account" ? "Gluon signs in as this account to send. A separate account just for alerts works best." : undefined}>
          <Segmented
            aria-label="Send from"
            value={d.xmode}
            onChange={(v) => set("xmode", v)}
            options={[
              { value: "server", label: "This server's chat server" },
              { value: "account", label: "An XMPP account" },
            ]}
          />
        </Field>
      )}

      {d.xmode === "server" ? (
        none ? (
          <Notice tone="attention" title={stopped.length ? `${stopped[0]!.name} can't be reached` : "No chat server here yet"}>
            {stopped.length
              ? `${stopped[0]!.problem} Start it, then come back.`
              : admin
                ? "Gluon sends through a Prosody chat server it runs. Set one up from Apps, or send from an XMPP account you already have."
                : "Ask whoever looks after the server to set up a chat server. Until then, use ntfy or email."}
          </Notice>
        ) : error && !data ? (
          <Notice tone="fault" title="Couldn't read the chat servers">
            {error.message}
          </Notice>
        ) : (
          <div data-field="config.domain">
            <Field
              label="Chat server"
              error={fe("app", "domain")}
              description={
                sender
                  ? `Messages come from ${sender}. Gluon creates that account the first time it sends, so people can add it as a contact. If this chat server stops, it can't tell you so: keep a second channel too, like ntfy or email.`
                  : "Loading the chat servers…"
              }
            >
              {choices.length > 1 ? (
                <Select aria-label="Chat server" value={d.xfrom} onChange={(v) => set("xfrom", v)} options={choices.map((c) => ({ value: c.value, label: c.label }))} />
              ) : (
                <p className={s.staticValue}>
                  <span className="mono">{chosen?.dm.domain ?? "…"}</span>
                  {chosen && <span className={s.muted}> on {chosen.sv.name}</span>}
                </p>
              )}
            </Field>
          </div>
        )
      ) : (
        <>
          <div className={s.row2}>
            <div data-field="config.jid">
              <Field label="Address" error={fe("jid")}>
                <Input mono value={d.jid} onChange={(e) => set("jid", e.target.value)} placeholder="alerts@chat.example.com" autoCapitalize="off" spellCheck={false} autoComplete="off" inputMode="email" />
              </Field>
            </div>
            <div data-field="config.password">
              <Field label="Password" error={fe("password")} description={secretHint("password")}>
                <Input type="password" autoComplete="new-password" value={d.xpass} onChange={(e) => set("xpass", e.target.value)} placeholder={saved("password") ? "••••••••" : undefined} />
              </Field>
            </div>
          </div>
          <Disclosure summary="Connection" defaultOpen={!!d.xserver || d.allowUntrusted} variant="panel">
            <div className={s.disclosureBody}>
              <div data-field="config.server">
                <Field label="Server" optional error={fe("server")} description="Leave empty to find it from the address, like chat apps do.">
                  <Input mono value={d.xserver} onChange={(e) => set("xserver", e.target.value)} placeholder="chat.example.com:5222" autoCapitalize="off" spellCheck={false} />
                </Field>
              </div>
              <Checkbox checked={d.allowUntrusted} onChange={(v) => set("allowUntrusted", v)}>
                Accept its certificate even if it isn&apos;t trusted (a self-signed one on your own server)
              </Checkbox>
            </div>
          </Disclosure>
        </>
      )}

      {(d.xmode === "account" || !none) && (
        <>
          <div data-field="config.to">
            <Field
              label="Send to"
              error={fe("to")}
              description={admin ? (people.length ? "Tick people on this server, or type any chat address. Each gets its own chat." : "One or more chat addresses, separated by commas. Each gets its own chat.") : "Your chat address."}
            >
              <Input mono value={d.xto} onChange={(e) => set("xto", e.target.value)} placeholder={`you@${chosen?.dm.domain ?? "chat.example.com"}`} autoCapitalize="off" spellCheck={false} inputMode="email" />
            </Field>
            {admin && people.length > 0 && <Picks known={people} value={d.xto} onChange={(v) => set("xto", v)} label="People on this chat server" />}
          </div>
          {admin && (
            <div data-field="config.rooms">
              <Field
                label="Group chats"
                optional
                error={fe("rooms")}
                description={d.xmode === "server" ? "Also post in a group chat on this server, like a household one." : "Also post in a group chat. Gluon joins just long enough to post, and needs to be a member of members-only ones."}
              >
                <Input mono value={d.xrooms} onChange={(e) => set("xrooms", e.target.value)} placeholder={rooms[0] ?? "family@rooms.chat.example.com"} autoCapitalize="off" spellCheck={false} />
              </Field>
              {rooms.length > 0 && <Picks known={rooms} value={d.xrooms} onChange={(v) => set("xrooms", v)} label="Group chats on this chat server" />}
            </div>
          )}
          {admin && list(d.xrooms).length > 0 && (
            <div data-field="config.nick">
              <Field label="Name in group chats" error={fe("nick")}>
                <Input value={d.nick} onChange={(e) => set("nick", e.target.value)} maxLength={40} />
              </Field>
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Known addresses as checkboxes that add to or take from the typed list, which stays the one source of truth. */
function Picks({ known, value, onChange, label }: { known: string[]; value: string; onChange: (v: string) => void; label: string }) {
  const chosen = list(value);
  return (
    <div className={s.picks} role="group" aria-label={label}>
      {known.map((jid) => {
        const [user, host] = jid.split("@");
        return (
          <Checkbox key={jid} checked={chosen.includes(jid)} onChange={(v) => onChange((v ? [...chosen, jid] : chosen.filter((x) => x !== jid)).join(", "))}>
            <span className={s.pickText} title={jid}>
              {user}
              <span className={s.muted}>@{host}</span>
            </span>
          </Checkbox>
        );
      })}
    </div>
  );
}
