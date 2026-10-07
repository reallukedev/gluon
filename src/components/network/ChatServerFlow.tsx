"use client";
import * as React from "react";
import { ChatBubble, Globe, Lock, Server } from "iconoir-react";
import type { ChatServerCandidate, NetworkStatus, RouteT, RoutesResponse, SubdomainRouteT } from "@/lib/network-types";
import { ApiError } from "@/lib/client/api";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input, Switch } from "@/components/ui/Field";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { FlowSteps } from "@/components/ui/FlowSteps";
import type { Commit } from "./NetworkView";
import { bare, newRouteId, THIS_SERVER, useChatServers } from "./shared";
import { HttpsSetting } from "./HttpsSetting";
import { DnsHelp } from "./DnsHelp";
import { certUploads, hasNewCert, httpsFieldOf, httpsFormFrom, httpsSetting, httpsSummary, verifyHttps, type HttpsForm } from "./https-form";
import f from "./flow.module.css";
import c from "./chat.module.css";

/**
 * A chat server (XMPP) on the internet: which server → its domain → federation, web side and the
 * certificate → review. Chat apps connect straight to the server; Caddy only holds the domain's
 * certificate (which Gluon copies into the server) and fronts its optional web side.
 */

export type ChatTarget = { mode: "new" } | { mode: "edit"; id: string } | { mode: "convert"; id: string };

type Step = "server" | "address" | "options" | "review";
const STEPS: Step[] = ["server", "address", "options", "review"];
const STEP_NAME: Record<Step, string> = { server: "Server", address: "Domain", options: "Settings", review: "Review" };

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DIR_RE = /^(\/[A-Za-z0-9._-]+)+$/;

interface Form {
  container: string | null;
  backendHost: string;
  c2s: string;
  domain: string;
  name: string;
  federation: boolean;
  s2s: string;
  web: boolean;
  http: string;
  sync: boolean;
  syncDir: string;
  app: string | null;
  https: HttpsForm;
}

const portOk = (p: string) => /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535;

function fromRoute(r: SubdomainRouteT, convert: boolean): Form {
  const x = r.xmpp;
  return {
    container: x?.cert_sync?.container ?? null,
    backendHost: r.backend.host,
    c2s: String(r.backend.port),
    domain: r.host,
    name: r.name,
    federation: convert ? true : x?.s2s_port != null,
    s2s: String(x?.s2s_port ?? 5269),
    web: !!x?.http_port,
    http: String(x?.http_port ?? 5280),
    sync: !!x?.cert_sync,
    syncDir: x?.cert_sync?.dir ?? "/etc/prosody/certs",
    app: r.app ?? null,
    https: httpsFormFrom(r),
  };
}

interface Props {
  target: ChatTarget;
  data: RoutesResponse;
  /** Live checks, to say whether the domain's DNS is already in place. */
  status: NetworkStatus | undefined;
  commit: Commit;
  onClose: () => void;
  onReload: () => void;
}

export function ChatServerFlow({ target, data, status, commit, onClose, onReload }: Props) {
  const cfg = data.config;
  const base = cfg.base_domain;
  const existing = target.mode !== "new" ? cfg.routes.find((r): r is SubdomainRouteT => r.id === target.id && r.type === "subdomain") : undefined;
  const converting = target.mode === "convert";
  const servers = useChatServers(true);

  const [open, setOpenState] = React.useState(true);
  const setOpen = (o: boolean) => {
    setOpenState(o);
    if (!o) setTimeout(onClose, 250);
  };
  const [form, setForm] = React.useState<Form>(() =>
    existing
      ? fromRoute(existing, converting)
      : { container: null, backendHost: THIS_SERVER, c2s: "5222", domain: `chat.${base}`, name: "Chat", federation: true, s2s: "5269", web: false, http: "5280", sync: false, syncDir: "/etc/prosody/certs", app: null, https: httpsFormFrom(undefined) },
  );
  const [step, setStep] = React.useState<Step>(existing && !converting ? "review" : "server");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [general, setGeneral] = React.useState<string | null>(null);
  const [stale, setStale] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [checkingCert, setCheckingCert] = React.useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((x) => ({ ...x, [k]: v }));
    setErrors((e) => {
      if (!e[k]) return e;
      const { [k]: _, ...rest } = e;
      return rest;
    });
  };

  const list = servers.data?.servers;
  const picked = list?.find((s) => s.container === form.container) ?? null;

  function choose(sv: ChatServerCandidate) {
    setForm((x) => ({
      ...x,
      container: sv.container,
      backendHost: THIS_SERVER,
      c2s: String(sv.ports.c2s ?? 5222),
      s2s: String(sv.ports.s2s ?? 5269),
      federation: x.federation && sv.ports.s2s !== null,
      http: String(sv.ports.http ?? 5280),
      sync: sv.canSync,
      syncDir: sv.certDir,
      app: sv.project ?? null,
    }));
    setErrors({});
  }

  // Start on the chat server this machine runs: the one already on the address's port when
  // converting, or the only running one for a new address. Edits keep what was saved.
  const autoPicked = React.useRef(false);
  React.useEffect(() => {
    if (autoPicked.current || !list || (existing && !converting)) return;
    autoPicked.current = true;
    // A list that arrives after the person moved on mustn't overwrite what they've set.
    if (step !== "server") return;
    const running = list.filter((s) => s.running);
    const match = converting ? running.find((s) => s.ports.c2s === existing!.backend.port) : running.length === 1 ? running[0] : undefined;
    if (match) choose(match);
  }, [list, existing, converting, step]); // eslint-disable-line react-hooks/exhaustive-deps

  const domain = form.domain.trim().toLowerCase().replace(/\.$/, "");
  const covered = domain.endsWith(`.${base}`) && !domain.slice(0, -base.length - 1).includes(".");
  const takenBy = cfg.routes.find((r) => r.type === "subdomain" && r.id !== existing?.id && r.host === domain);
  const domainChanged = !!existing && !converting && existing.host !== domain;
  const knownDns = status?.routes.find((r) => r.host === domain && r.dns)?.dns ?? null;
  const mode = form.https.mode;
  // Without a certificate in Caddy there's nothing to copy, and with no web side nothing to publish.
  const canSync = mode === "auto" || mode === "own";
  const sync = form.sync && canSync;
  const web = form.web && mode !== "none";
  const storedCert = existing ? data.certs?.[existing.id] : undefined;
  const prevRoute = existing;
  const newCert = hasNewCert(form.https, prevRoute, storedCert, domain);

  function check(s: Step): Record<string, string> {
    const e: Record<string, string> = {};
    if (s === "server") {
      if (!portOk(form.c2s)) e.c2s = "Enter the port chat apps sign in on, usually 5222.";
    }
    if (s === "address") {
      if (!HOST_RE.test(domain)) e.domain = "Enter a domain like chat.example.com.";
      else if (domain === base) e.domain = `${base} already shows your apps. Use a name of its own, like chat.${base}.`;
      else if (takenBy) e.domain = `${domain} is already used by ${takenBy.name}.`;
      if (!form.name.trim()) e.name = "Give it a name, like Chat.";
    }
    if (s === "options") {
      if (form.federation && !portOk(form.s2s)) e.s2s = "Enter the port other servers connect to, usually 5269.";
      else if (form.federation && form.s2s === form.c2s) e.s2s = "This can't be the same port chat apps sign in on.";
      if (web && !portOk(form.http)) e.http = "Enter the chat server's web port, usually 5280.";
      else if (web && form.http === form.c2s) e.http = "This can't be the same port chat apps sign in on.";
      else if (web && form.federation && form.http === form.s2s) e.http = "This can't be the same port other servers connect to.";
      if (sync && !form.container) e.sync = "Pick the chat server's container on the first step, or turn this off.";
      if (sync && !DIR_RE.test(form.syncDir.trim())) e.syncDir = "Enter a folder inside the container, like /etc/prosody/certs.";
    }
    return e;
  }

  const idx = STEPS.indexOf(step);

  async function verifyCert(): Promise<HttpsForm | null> {
    if (!newCert) return form.https;
    setCheckingCert(true);
    try {
      const r = await verifyHttps(form.https, domain);
      if ("errors" in r) {
        setErrors(r.errors);
        setStep("options");
        return null;
      }
      setForm((x) => ({ ...x, https: r.form }));
      return r.form;
    } finally {
      setCheckingCert(false);
    }
  }

  async function go(to: Step) {
    const i = STEPS.indexOf(to);
    if (i > idx) {
      for (const s of STEPS.slice(0, i)) {
        const e = check(s);
        if (Object.keys(e).length) {
          setErrors(e);
          setStep(s);
          return;
        }
      }
      if (STEPS.indexOf("options") < i && !(await verifyCert())) return;
    }
    setErrors({});
    setStep(to);
  }

  function build(): RouteT[] {
    const route: SubdomainRouteT = {
      id: existing?.id ?? newRouteId(form.name),
      type: "subdomain",
      name: form.name.trim(),
      enabled: existing?.enabled ?? true,
      ...(form.app ? { app: form.app } : {}),
      ...(existing?.note ? { note: existing.note } : {}),
      host: domain,
      backend: { host: form.backendHost, port: Number(form.c2s), tls: false },
      xmpp: {
        s2s_port: form.federation ? Number(form.s2s) : null,
        http_port: web ? Number(form.http) : null,
        cert_sync: sync && form.container ? { container: form.container, dir: form.syncDir.trim() } : null,
      },
      ...(httpsSetting(form.https) ? { https: httpsSetting(form.https) } : {}),
    };
    return existing ? cfg.routes.map((r) => (r.id === existing.id ? route : r)) : [...cfg.routes, route];
  }

  async function save() {
    setGeneral(null);
    for (const s of STEPS) {
      const e = check(s);
      if (Object.keys(e).length) {
        setErrors(e);
        setStep(s);
        return;
      }
    }
    const checked = await verifyCert();
    if (!checked) return;
    setSaving(true);
    try {
      const success = converting ? `${domain} is set up as a chat server.` : existing ? `Saved ${domain}.` : `${domain} is a chat server now. Its certificate arrives within a minute.`;
      await commit(build(), { success, certs: certUploads(checked, domain, newCert) });
      setOpen(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "stale") setStale(true);
      else if (e instanceof ApiError && httpsFieldOf(e.field)) {
        setErrors({ [httpsFieldOf(e.field)!]: e.message });
        setStep("options");
      } else if (e instanceof ApiError && e.field) {
        const map: Record<string, [string, Step]> = {
          host: ["domain", "address"],
          name: ["name", "address"],
          port: ["c2s", "server"],
          backend_host: ["c2s", "server"],
          s2s_port: ["s2s", "options"],
          http_port: ["http", "options"],
          cert_container: ["sync", "options"],
          cert_dir: ["syncDir", "options"],
        };
        const [key, at] = map[e.field] ?? [e.field, step];
        setErrors({ [key]: e.message });
        setStep(at);
      } else setGeneral(e instanceof Error ? e.message : "That didn't save.");
    } finally {
      setSaving(false);
    }
  }

  const last = idx === STEPS.length - 1;
  const title = converting ? "Set it up as a chat server" : existing ? `Edit ${existing.name}` : "Put a chat server on the internet";
  const description = converting && existing
    ? `${bare(data.urls[existing.id] ?? "")} points web visitors at port ${existing.backend.port}, which only chat apps understand. This keeps the address and sets it up the way XMPP expects.`
    : "Chat apps connect straight to the server. Gluon publishes its domain, keeps its certificate current and checks it can be reached.";
  const primary = last ? (existing ? "Save changes" : "Put it on the internet") : "Continue";
  const ports = [form.c2s, ...(form.federation ? [form.s2s] : [])];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !saving && setOpen(o)}
      title={title}
      description={description}
      size="wide"
      footer={
        <>
          {idx > 0 ? (
            <Button variant="ghost" onClick={() => void go(STEPS[idx - 1]!)} disabled={saving}>
              Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button variant="primary" loading={saving || checkingCert} onClick={() => (last ? void save() : void go(STEPS[idx + 1]!))}>
            {primary}
          </Button>
        </>
      }
    >
      <form
        className={f.flow}
        onSubmit={(e) => {
          e.preventDefault();
          if (last) void save();
          else void go(STEPS[idx + 1]!);
        }}
      >
        <FlowSteps label="Steps" steps={STEPS.map((k) => ({ key: k, label: STEP_NAME[k] }))} current={step} working={saving} />

        {stale && (
          <Notice
            tone="attention"
            title="The addresses changed somewhere else"
            action={
              <Button
                size="sm"
                onClick={() => {
                  onReload();
                  setStale(false);
                }}
              >
                Reload
              </Button>
            }
          >
            Reload the latest list, then save again. What you entered here is kept.
          </Notice>
        )}
        {general && (
          <Notice tone="fault" title="That didn't save">
            {general}
          </Notice>
        )}

        <div className={f.stage}>
          <div className={`${f.body} appear`} key={step}>
            {step === "server" && (
              <div className={f.section}>
                <p className={f.q}>Which chat server should people reach?</p>
                {!list && !servers.error ? (
                  <div className={c.servers}>
                    <Skeleton height={68} radius={8} />
                    <Skeleton height={68} radius={8} />
                  </div>
                ) : (
                  <div className={c.servers} role="radiogroup" aria-label="Chat server">
                    {(list ?? []).map((sv) => {
                      const on = form.container === sv.container;
                      return (
                        <button key={sv.container} type="button" role="radio" aria-checked={on} className={f.pick} data-on={on ? "" : undefined} onClick={() => choose(sv)} title={`${sv.container} (${sv.image})`}>
                          <span className={c.serverIcon} aria-hidden>
                            <ChatBubble />
                          </span>
                          <span className={f.pickText}>
                            <span className={f.pickName}>{sv.container}</span>
                            <span className={`${f.pickSub} mono`}>
                              {sv.running ? "" : "stopped · "}
                              {sv.image}
                            </span>
                          </span>
                          <span className={`${c.serverPorts} mono`}>{sv.ports.c2s ? `:${sv.ports.c2s}` : "no client port"}</span>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={form.container === null}
                      className={f.pick}
                      data-on={form.container === null ? "" : undefined}
                      onClick={() => setForm((x) => ({ ...x, container: null, sync: false, app: null }))}
                    >
                      <span className={f.pickOther} aria-hidden>
                        :
                      </span>
                      <span className={f.pickText}>
                        <span className={f.pickName}>Another port on this server</span>
                        <span className={f.pickSub}>Enter the port chat apps sign in on</span>
                      </span>
                    </button>
                  </div>
                )}
                {servers.error && <p className={f.faint}>Gluon couldn&rsquo;t look for chat servers ({servers.error.message}). Enter the port it listens on instead.</p>}
                {list && list.length === 0 && <p className={f.faint}>Gluon didn&rsquo;t find a Prosody, ejabberd or Snikket container on this server. If yours runs here under another image, enter its client port.</p>}
                {picked && !picked.ports.c2s && (
                  <Notice tone="attention" title={`${picked.container} doesn't publish a client port`}>
                    Chat apps need to reach port 5222 on this server. Publish it in the app&rsquo;s settings, or enter the port it uses below.
                  </Notice>
                )}
                {(form.container === null || (picked && !picked.ports.c2s) || !!errors.c2s) && (
                  <div className={f.row2}>
                    <Field label="Port chat apps sign in on" error={errors.c2s} description="Usually 5222.">
                      <Input value={form.c2s} onChange={(e) => set("c2s", e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" mono placeholder="5222" />
                    </Field>
                  </div>
                )}
              </div>
            )}

            {step === "address" && (
              <div className={f.section}>
                <p className={f.q}>What&rsquo;s the chat server&rsquo;s domain?</p>
                <Field label="Domain" error={errors.domain} description={`People's chat addresses end in it, like you@${domain || `chat.${base}`}.`}>
                  <Input value={form.domain} onChange={(e) => set("domain", e.target.value.replace(/\s/g, ""))} mono placeholder={`chat.${base}`} spellCheck={false} autoCapitalize="off" />
                </Field>
                {HOST_RE.test(domain) && !takenBy && domain !== base && (
                  <DnsHelp host={domain} baseDomain={base} purpose="chat" known={knownDns ?? (covered && status?.wildcard?.status === "ok" ? status.wildcard : null)} publicIp={status?.publicIp ?? null} />
                )}
                {domainChanged && (
                  <Notice tone="attention" title="This changes everyone's chat address">
                    Accounts on {existing!.host} don&rsquo;t move to {domain} by themselves. Change the chat server&rsquo;s own VirtualHost to match, or people won&rsquo;t be able to sign in.
                  </Notice>
                )}
                <Field label="Name" error={errors.name} description="Shown in Gluon.">
                  <Input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={60} placeholder="Chat" />
                </Field>
              </div>
            )}

            {step === "options" && (
              <div className={f.section}>
                <div className={c.option}>
                  <div className={c.optionText}>
                    <span className={c.optionTitle}>Talk to other chat servers</span>
                    <span className={f.faint}>Lets people here chat with people on other XMPP servers. Other servers connect to this port.</span>
                  </div>
                  <Switch checked={form.federation} onChange={(v) => set("federation", v)} aria-label="Talk to other chat servers" />
                  {form.federation && (
                    <Field label="Federation port" error={errors.s2s} className={c.optionField}>
                      <Input value={form.s2s} onChange={(e) => set("s2s", e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" mono placeholder="5269" />
                    </Field>
                  )}
                </div>

                <div className={c.option}>
                  <div className={c.optionText}>
                    <span className={c.optionTitle}>Web chat and file uploads</span>
                    <span className={f.faint}>
                      Sends {domain || "the domain"}&rsquo;s web traffic to the chat server&rsquo;s own web port, for browser chat apps (BOSH, WebSocket) and shared files. Turn on only if the server has those modules enabled.
                    </span>
                  </div>
                  <Switch checked={web} onChange={(v) => set("web", v)} disabled={mode === "none"} aria-label="Web chat and file uploads" />
                  {mode === "none" && <span className={`${f.faint} ${c.optionField}`}>Off while there&rsquo;s no web side here (see HTTPS below).</span>}
                  {web && (
                    <Field label="Chat server's web port" error={errors.http} className={c.optionField}>
                      <Input value={form.http} onChange={(e) => set("http", e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" mono placeholder="5280" />
                    </Field>
                  )}
                </div>

                <HttpsSetting
                  host={domain}
                  kind="chat"
                  value={form.https}
                  onChange={(v) => {
                    set("https", v);
                    setErrors({});
                  }}
                  stored={prevRoute?.host === domain ? storedCert : undefined}
                  errors={errors}
                  checking={checkingCert}
                  onCheck={() => {
                    setErrors({});
                    void verifyCert();
                  }}
                />

                <div className={c.option}>
                  <div className={c.optionText}>
                    <span className={c.optionTitle}>Keep its certificate current</span>
                    <span className={f.faint} hidden={!canSync}>
                      {!form.container
                        ? "Pick the chat server's container on the first step to turn this on."
                        : mode === "own"
                          ? `If the certificate in ${form.container} gets close to expiring, Gluon copies yours in and reloads it. A certificate that another tool keeps current is left alone.`
                          : `Caddy renews ${domain || "the domain"}'s certificate on its own. If the one in ${form.container} gets close to expiring, Gluon copies Caddy's in and reloads it, so chat apps never see an expired one. A certificate that another tool keeps current is left alone.`}
                    </span>
                    {errors.sync && <span className={f.error}>{errors.sync}</span>}
                  </div>
                  <Switch checked={sync} onChange={(v) => set("sync", v)} disabled={!canSync || (!form.sync && (!form.container || (picked ? !picked.canSync : false)))} aria-label="Keep its certificate current" />
                  {!canSync && <span className={`${f.faint} ${c.optionField}`}>{mode === "none" ? "Off: the chat server handles its own certificate." : "Off: with plain HTTP there's no certificate here to copy."}</span>}
                  {sync && form.container && (
                    <Field label="Certificate folder in the container" error={errors.syncDir} className={c.optionField} description={`Gluon writes ${domain || "domain"}.crt and .key here.`}>
                      <Input value={form.syncDir} onChange={(e) => set("syncDir", e.target.value.trim())} mono spellCheck={false} autoCapitalize="off" />
                    </Field>
                  )}
                  {picked && !picked.canSync && <span className={f.faint}>Gluon can only reload Prosody for now, so {picked.container} keeps managing its own certificate.</span>}
                </div>

              </div>
            )}

            {step === "review" && (
              <div className={f.section}>
                <div className={c.hero}>
                  <span className={c.heroIcon} aria-hidden>
                    <ChatBubble />
                  </span>
                  <span className={c.heroText}>
                    <span className={c.heroJid}>
                      you<span className={c.at}>@</span>
                      {domain}
                    </span>
                    <span className={f.faint}>What people type into a chat app to sign in.</span>
                  </span>
                </div>
                <dl className={f.recap}>
                  <Recap label="Server" onChange={() => void go("server")}>
                    {form.container ?? "On this server"} <span className={`${f.dim} mono`}>:{form.c2s}</span>
                  </Recap>
                  <Recap label="Domain" onChange={() => void go("address")}>
                    {domain}
                  </Recap>
                  <Recap label="Federation" onChange={() => void go("options")}>
                    {form.federation ? (
                      <>
                        On <span className={`${f.dim} mono`}>:{form.s2s}</span>
                      </>
                    ) : (
                      "Off, only people on this server"
                    )}
                  </Recap>
                  <Recap label="Web side" onChange={() => void go("options")}>
                    {web ? (
                      <>
                        BOSH and WebSocket <span className={`${f.dim} mono`}>:{form.http}</span>
                      </>
                    ) : mode === "none" ? (
                      "None here"
                    ) : (
                      "A short page that says it's a chat server"
                    )}
                  </Recap>
                  <Recap label="HTTPS" onChange={() => void go("options")}>
                    {httpsSummary(form.https, prevRoute?.host === domain ? storedCert : undefined)}
                  </Recap>
                  <Recap label="Certificate" onChange={() => void go("options")}>
                    {sync && form.container ? `Gluon copies ${mode === "own" ? "yours" : "Caddy's"} into ${form.container} before it can expire` : "The chat server manages its own"}
                  </Recap>
                </dl>
                <ul className={c.after} aria-label="What happens when you save">
                  <li>
                    <Lock aria-hidden />
                    <span>
                      {mode === "none"
                        ? `The web server doesn't answer for ${domain} at all, so the chat server needs its own certificate for it.`
                        : mode === "http"
                          ? `${domain}'s web page is plain HTTP; whatever is in front of this server handles HTTPS. The chat server needs its own certificate.`
                          : `${mode === "own" ? `The web server serves your certificate for ${domain}` : `Caddy keeps a certificate for ${domain}`}${sync && form.container ? `. Gluon checks ${form.container}'s every six hours and copies ${mode === "own" ? "yours" : "Caddy's"} in before it can expire.` : "."}`}
                    </span>
                  </li>
                  <li>
                    <Globe aria-hidden />
                    <span>
                      Your router has to forward port{ports.length > 1 ? "s" : ""}{" "}
                      {ports.map((p, i) => (
                        <React.Fragment key={p}>
                          {i > 0 && " and "}
                          <span className="mono">{p}</span>
                        </React.Fragment>
                      ))}{" "}
                      to this server. Once it&rsquo;s saved, Gluon tries them through your internet address and tells you if one doesn&rsquo;t get through.
                    </span>
                  </li>
                  {converting && mode !== "none" && (
                    <li>
                      <Server aria-hidden />
                      <span>Web visitors to {domain} see a short page saying it&rsquo;s a chat server, instead of an error.</span>
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function Recap({ label, onChange, children }: { label: string; onChange: () => void; children: React.ReactNode }) {
  return (
    <div className={f.recapRow}>
      <dt>{label}</dt>
      <dd>{children}</dd>
      <Button size="sm" variant="ghost" onClick={onChange} aria-label={`Change the ${label.toLowerCase()}`}>
        Change
      </Button>
    </div>
  );
}
