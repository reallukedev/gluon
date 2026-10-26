"use client";
import * as React from "react";
import { Globe, Lock, Headset } from "iconoir-react";
import type { NetworkStatus, RouteT, RoutesResponse, SubdomainRouteT, VoiceServerCandidate } from "@/lib/network-types";
import { ApiError } from "@/lib/client/api";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Notice, Skeleton } from "@/components/ui/Surface";
import type { Commit } from "./NetworkView";
import { bare, newRouteId, MUMBLE_PORT, THIS_SERVER, useVoiceServers } from "./shared";
import { HttpsSetting } from "./HttpsSetting";
import { DnsHelp } from "./DnsHelp";
import { certUploads, hasNewCert, httpsFieldOf, httpsFormFrom, httpsSetting, verifyHttps } from "./https-form";
import f from "./flow.module.css";
import c from "./chat.module.css";

/**
 * A voice server (Mumble) at an address. Voice apps connect straight to Mumble's port; the web
 * server keeps a certificate for the name and shows browsers a page with a mumble:// link.
 */

export type VoiceTarget = { mode: "new" } | { mode: "edit"; id: string } | { mode: "convert"; id: string };

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const portOk = (p: string) => /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535;

export function VoiceServerFlow({ target, data, status, commit, onClose, onReload }: { target: VoiceTarget; data: RoutesResponse; status: NetworkStatus | undefined; commit: Commit; onClose: () => void; onReload: () => void }) {
  const cfg = data.config;
  const base = cfg.base_domain;
  const existing = target.mode !== "new" ? cfg.routes.find((r): r is SubdomainRouteT => r.id === target.id && r.type === "subdomain") : undefined;
  const converting = target.mode === "convert";
  const servers = useVoiceServers(true);
  const list = servers.data?.servers;

  const [open, setOpenState] = React.useState(true);
  const setOpen = (o: boolean) => {
    setOpenState(o);
    if (!o) setTimeout(onClose, 250);
  };
  const [container, setContainer] = React.useState<string | null>(null);
  const [app, setApp] = React.useState<string | null>(existing?.app ?? null);
  const [port, setPort] = React.useState(String(existing?.voice?.port ?? MUMBLE_PORT));
  const [domain, setDomain] = React.useState(existing?.host ?? `voice.${base}`);
  const [name, setName] = React.useState(existing?.name ?? "Voice");
  const [https, setHttps] = React.useState(() => httpsFormFrom(existing));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [general, setGeneral] = React.useState<string | null>(null);
  const [stale, setStale] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [checkingCert, setCheckingCert] = React.useState(false);

  const choose = (sv: VoiceServerCandidate) => {
    setContainer(sv.container);
    setApp(sv.project);
    if (sv.port) setPort(String(sv.port));
    setErrors({});
  };
  // Start on the Mumble this server runs: the one behind the address when converting, or the only one.
  const picked = React.useRef(false);
  React.useEffect(() => {
    if (picked.current || !list) return;
    picked.current = true;
    const running = list.filter((s) => s.running);
    const match = existing ? running.find((s) => s.port === (existing.voice?.port ?? MUMBLE_PORT) || s.ports.includes(existing.backend.port) || (!!existing.app && s.project === existing.app)) : running.length === 1 ? running[0] : undefined;
    if (match) choose(match);
  }, [list, existing]);

  const host = domain.trim().toLowerCase().replace(/\.$/, "");
  const takenBy = cfg.routes.find((r) => r.type === "subdomain" && r.id !== existing?.id && r.host === host);
  const covered = host.endsWith(`.${base}`) && !host.slice(0, -base.length - 1).includes(".");
  const knownDns = status?.routes.find((r) => r.host === host && r.dns)?.dns ?? (covered && status?.wildcard?.status === "ok" ? status.wildcard : null);
  const storedCert = existing ? data.certs?.[existing.id] : undefined;
  const newCert = hasNewCert(https, existing, storedCert, host);
  const server = list?.find((s) => s.container === container) ?? null;

  function check(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!portOk(port)) e.port = "Enter the port Mumble listens on, usually 64738.";
    if (!HOST_RE.test(host)) e.domain = "Enter a domain like voice.example.com.";
    else if (host === base) e.domain = `${base} already shows your apps. Use a name of its own, like voice.${base}.`;
    else if (takenBy) e.domain = `${host} is already used by ${takenBy.name}.`;
    if (!name.trim()) e.name = "Give it a name, like Voice.";
    return e;
  }

  async function verifyCert() {
    if (!newCert) return https;
    setCheckingCert(true);
    try {
      const r = await verifyHttps(https, host);
      if ("errors" in r) {
        setErrors(r.errors);
        return null;
      }
      setHttps(r.form);
      return r.form;
    } finally {
      setCheckingCert(false);
    }
  }

  async function save() {
    const e = check();
    setErrors(e);
    setGeneral(null);
    if (Object.keys(e).length) return;
    const checked = await verifyCert();
    if (!checked) return;
    const setting = httpsSetting(checked);
    const route: SubdomainRouteT = {
      id: existing?.id ?? newRouteId(name),
      type: "subdomain",
      name: name.trim(),
      enabled: existing?.enabled ?? true,
      ...(app ? { app } : {}),
      ...(existing?.note ? { note: existing.note } : {}),
      host,
      backend: { host: THIS_SERVER, port: Number(port), tls: false },
      voice: { port: Number(port) },
      ...(setting ? { https: setting } : {}),
    };
    const routes: RouteT[] = existing ? cfg.routes.map((r) => (r.id === existing.id ? route : r)) : [...cfg.routes, route];
    setSaving(true);
    try {
      await commit(routes, { success: converting ? `${host} is set up as a voice server.` : existing ? `Saved ${host}.` : `${host} is a voice server now.`, certs: certUploads(checked, host, newCert) });
      setOpen(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "stale") setStale(true);
      else if (err instanceof ApiError && httpsFieldOf(err.field)) setErrors({ [httpsFieldOf(err.field)!]: err.message });
      else if (err instanceof ApiError && err.field) setErrors({ [err.field === "host" ? "domain" : err.field === "voice_port" || err.field === "port" ? "port" : err.field]: err.message });
      else setGeneral(err instanceof Error ? err.message : "That didn't save.");
    } finally {
      setSaving(false);
    }
  }

  const link = `mumble://${host || `voice.${base}`}${Number(port) === MUMBLE_PORT ? "" : `:${port}`}`;
  const title = converting ? "Set it up as a voice server" : existing ? `Edit ${existing.name}` : "Put a voice server on the internet";
  const description =
    converting && existing
      ? `${bare(data.urls[existing.id] ?? "")} sends browsers to port ${existing.backend.port}, which only Mumble understands. This keeps the address and sets it up for voice apps.`
      : "Voice apps connect straight to Mumble. Gluon keeps a certificate for the name and checks that people outside can get through.";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !saving && setOpen(o)}
      title={title}
      description={description}
      size="wide"
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving || checkingCert} onClick={() => void save()}>
            {converting ? "Set it up" : existing ? "Save changes" : "Put it on the internet"}
          </Button>
        </>
      }
    >
      <form
        className={f.flow}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
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
        <div className={f.section}>
          <p className={f.q}>Which voice server should people reach?</p>
          {!list && !servers.error ? (
            <div className={c.servers}>
              <Skeleton height={60} radius={8} />
            </div>
          ) : (
            <div className={c.servers} role="radiogroup" aria-label="Voice server">
              {(list ?? []).map((sv) => {
                const on = container === sv.container;
                return (
                  <button key={sv.container} type="button" role="radio" aria-checked={on} className={f.pick} data-on={on ? "" : undefined} onClick={() => choose(sv)} title={`${sv.container} (${sv.image})`}>
                    <span className={c.serverIcon} aria-hidden>
                      <Headset />
                    </span>
                    <span className={f.pickText}>
                      <span className={f.pickName}>{sv.container}</span>
                      <span className={`${f.pickSub} mono`}>
                        {sv.running ? "" : "stopped · "}
                        {sv.image}
                      </span>
                    </span>
                    <span className={`${c.serverPorts} mono`}>{sv.port ? `:${sv.port}` : "no port"}</span>
                  </button>
                );
              })}
              <button type="button" role="radio" aria-checked={container === null} className={f.pick} data-on={container === null ? "" : undefined} onClick={() => setContainer(null)}>
                <span className={f.pickOther} aria-hidden>
                  :
                </span>
                <span className={f.pickText}>
                  <span className={f.pickName}>Another port on this server</span>
                  <span className={f.pickSub}>Enter the port Mumble listens on</span>
                </span>
              </button>
            </div>
          )}
          {list && list.length === 0 && <p className={f.faint}>Gluon didn&rsquo;t find a Mumble container on this server. If yours runs here under another image, enter its port.</p>}
          {server && !server.udp && server.port && (
            <Notice tone="attention" title={`${server.container} only publishes TCP`}>
              Voice goes over UDP when it can. Without it Mumble still works over TCP, but with more delay. Publish UDP {server.port} in the app&rsquo;s settings too.
            </Notice>
          )}
          {(container === null || !!errors.port) && (
            <div className={f.row2}>
              <Field label="Port voice apps connect to" error={errors.port} description="Usually 64738, TCP and UDP.">
                <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" mono placeholder="64738" />
              </Field>
            </div>
          )}

          <Field label="Domain" error={errors.domain} description={`People type it into Mumble as the server address.`}>
            <Input value={domain} onChange={(e) => setDomain(e.target.value.replace(/\s/g, ""))} mono placeholder={`voice.${base}`} spellCheck={false} autoCapitalize="off" />
          </Field>
          {HOST_RE.test(host) && !takenBy && host !== base && <DnsHelp host={host} baseDomain={base} purpose="voice" known={knownDns} publicIp={status?.publicIp ?? null} />}
          <Field label="Name" error={errors.name} description="Shown in Gluon.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Voice" />
          </Field>
          <HttpsSetting
            host={host}
            kind="voice"
            value={https}
            onChange={(v) => {
              setHttps(v);
              setErrors({});
            }}
            stored={existing?.host === host ? storedCert : undefined}
            errors={errors}
            checking={checkingCert}
            onCheck={() => {
              setErrors({});
              void verifyCert();
            }}
          />
          <ul className={c.after} aria-label="What happens when you save">
            <li>
              <Globe aria-hidden />
              <span>
                Your router has to forward port <span className="mono">{port || MUMBLE_PORT}</span>, TCP and UDP, to this server. Once it&rsquo;s saved, Gluon tries it through your internet address and tells you if it doesn&rsquo;t get through.
              </span>
            </li>
            <li>
              <Lock aria-hidden />
              <span>
                {https.mode === "http"
                  ? `The web page at ${host || "the domain"} is plain HTTP, so there's no certificate here for Mumble to use.`
                  : `The web server keeps a certificate for ${host || "the domain"}, which Mumble can use so apps don't ask people to accept a self-signed one.`}
              </span>
            </li>
            <li>
              <Headset aria-hidden />
              <span>
                Browsers that open {host || "the domain"} get a short page with a <span className="mono">{link}</span> link instead of an error.
              </span>
            </li>
          </ul>
        </div>
      </form>
    </Dialog>
  );
}
