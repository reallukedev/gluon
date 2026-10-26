"use client";
import * as React from "react";
import type { NetworkStatus, RoutesResponse, SubdomainRouteT } from "@/lib/network-types";
import { ApiError } from "@/lib/client/api";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";
import type { Commit } from "./NetworkView";
import { bare, newRouteId, THIS_SERVER } from "./shared";
import { HttpsSetting } from "./HttpsSetting";
import { DnsHelp } from "./DnsHelp";
import { certUploads, hasNewCert, httpsFieldOf, httpsFormFrom, httpsSetting, verifyHttps } from "./https-form";
import f from "./flow.module.css";

/** A whole domain that sends visitors somewhere else, keeping the path ("old.example.com → new.example.com"). */

export type HostRedirectTarget = { mode: "new" } | { mode: "edit"; id: string };

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~%/-]*)?$/;

export function HostRedirectFlow({ target, data, status, commit, onClose, onReload }: { target: HostRedirectTarget; data: RoutesResponse; status: NetworkStatus | undefined; commit: Commit; onClose: () => void; onReload: () => void }) {
  const cfg = data.config;
  const existing = target.mode === "edit" ? cfg.routes.find((r): r is SubdomainRouteT => r.id === target.id && r.type === "subdomain") : undefined;
  const [open, setOpenState] = React.useState(true);
  const setOpen = (o: boolean) => {
    setOpenState(o);
    if (!o) setTimeout(onClose, 250);
  };
  const [host, setHost] = React.useState(existing?.host ?? "");
  const [to, setTo] = React.useState(existing?.redirect_to ?? `https://${cfg.base_domain}`);
  const [name, setName] = React.useState(existing?.name ?? "");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [general, setGeneral] = React.useState<string | null>(null);
  const [stale, setStale] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [https, setHttps] = React.useState(() => httpsFormFrom(existing));
  const [checkingCert, setCheckingCert] = React.useState(false);

  const domain = host.trim().toLowerCase().replace(/\.$/, "");
  const dest = to.trim().replace(/\/+$/, "");
  const storedCert = existing ? data.certs?.[existing.id] : undefined;
  const newCert = hasNewCert(https, existing, storedCert, domain);
  const knownDns = status?.routes.find((r) => r.host === domain && r.dns)?.dns ?? null;

  async function verifyCert() {
    if (!newCert) return https;
    setCheckingCert(true);
    try {
      const r = await verifyHttps(https, domain);
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

  function check(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!HOST_RE.test(domain)) e.host = "Enter a domain like old.example.com.";
    else if (domain === cfg.base_domain) e.host = `${cfg.base_domain} answers with the app for everything else. Pick another domain.`;
    else if (cfg.routes.some((r) => r.type === "subdomain" && r.id !== existing?.id && r.host === domain)) e.host = `${domain} is already used by another address.`;
    if (!URL_RE.test(dest)) e.to = "Enter where to send people, like https://example.com.";
    else if (new URL(dest).hostname.toLowerCase() === domain) e.to = "A domain can't redirect to itself.";
    if (!name.trim()) e.name = "Give it a name, like Old address.";
    return e;
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
      ...(existing?.app ? { app: existing.app } : {}),
      ...(existing?.note ? { note: existing.note } : {}),
      host: domain,
      // Unused while it redirects; kept so turning the redirect off later has somewhere sensible to point.
      backend: existing?.backend ?? { host: THIS_SERVER, port: 80, tls: false },
      redirect_to: dest,
      ...(setting ? { https: setting } : {}),
    };
    setSaving(true);
    try {
      await commit(existing ? cfg.routes.map((r) => (r.id === existing.id ? route : r)) : [...cfg.routes, route], { success: `${domain} now sends people to ${bare(dest)}.`, certs: certUploads(checked, domain, newCert) });
      setOpen(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "stale") setStale(true);
      else if (err instanceof ApiError && httpsFieldOf(err.field)) setErrors({ [httpsFieldOf(err.field)!]: err.message });
      else if (err instanceof ApiError && err.field) setErrors({ [err.field === "redirect_to" ? "to" : err.field]: err.message });
      else setGeneral(err instanceof Error ? err.message : "That didn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !saving && setOpen(o)}
      title={existing ? `Edit ${existing.name}` : "Redirect a domain"}
      description="Everyone who opens this domain is sent to another address, keeping the rest of the link."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving || checkingCert} onClick={() => void save()}>
            {existing ? "Save changes" : "Add the redirect"}
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
          <Field label="Domain" error={errors.host}>
            <Input value={host} onChange={(e) => setHost(e.target.value.replace(/\s/g, ""))} mono placeholder="old.example.com" spellCheck={false} autoCapitalize="off" autoFocus={!existing} />
          </Field>
          {!errors.host && <DnsHelp host={domain} baseDomain={cfg.base_domain} purpose="web" known={knownDns} publicIp={status?.publicIp ?? null} />}
          <Field label="Sends people to" error={errors.to} description={`${domain || "old.example.com"}/photos goes to ${dest || "https://example.com"}/photos.`}>
            <Input value={to} onChange={(e) => setTo(e.target.value.trim())} mono placeholder="https://example.com" spellCheck={false} autoCapitalize="off" />
          </Field>
          <Field label="Name" error={errors.name} description="Shown in Gluon.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Old address" />
          </Field>
          <HttpsSetting
            host={domain}
            kind="redirect"
            value={https}
            onChange={(v) => {
              setHttps(v);
              setErrors({});
            }}
            stored={existing?.host === domain ? storedCert : undefined}
            errors={errors}
            checking={checkingCert}
            onCheck={() => {
              setErrors({});
              void verifyCert();
            }}
          />
        </div>
      </form>
    </Dialog>
  );
}
