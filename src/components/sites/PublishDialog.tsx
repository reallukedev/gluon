"use client";
import * as React from "react";
import { api, ApiError } from "@/lib/client/api";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { AffixInput, Checkbox, Field } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { toast } from "@/components/ui/Toast";
import { useFormat } from "@/components/PrefsProvider";
import { HttpsSetting } from "@/components/network/HttpsSetting";
import { DnsHelp } from "@/components/network/DnsHelp";
import { certUploads, hasNewCert, httpsFieldOf, httpsFormFrom, httpsSetting, verifyHttps, type HttpsForm } from "@/components/network/https-form";
import { formatBytes, plural } from "@/lib/format";
import { SITE_LIMITS, type SiteDetail } from "@/lib/sites-types";
import type { SubdomainRouteT } from "@/lib/network-types";
import s from "./publish.module.css";

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

interface Props {
  site: SiteDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Open on the address fields, to move a published site. */
  changeAddress?: boolean;
  /** Something to do before publishing, like saving the open file. */
  beforePublish?: () => Promise<boolean>;
  unsavedFile: string | null;
  /** The draft has an index.html at the top; without one there's no front page to publish. */
  hasIndex: boolean;
  onPublished: (d: SiteDetail) => void;
}

/**
 * Publishing: the first time, choose the address (the same rules and HTTPS choices as Network);
 * after that, one button that copies the draft live. The address can be changed here too.
 */
export function PublishDialog({ site, open, onOpenChange, changeAddress, beforePublish, unsavedFile, hasIndex, onPublished }: Props) {
  const fmt = useFormat();
  const base = site.baseDomain ?? "";
  const had = site.address;
  const [editing, setEditing] = React.useState(!had || !!changeAddress);
  const underBase = (h: string) => !!base && h.endsWith(`.${base}`) && !h.slice(0, -base.length - 1).includes(".");
  const [custom, setCustom] = React.useState(had ? !underBase(had.host) : false);
  const [label, setLabel] = React.useState(had ? (underBase(had.host) ? had.host.slice(0, -base.length - 1) : had.host) : slug(site.name));
  const prevRoute = had ? ({ type: "subdomain", host: had.host, https: had.httpsSetting } as SubdomainRouteT) : undefined;
  const [https, setHttps] = React.useState<HttpsForm>(() => httpsFormFrom(prevRoute));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [checking, setChecking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const host = (custom ? label : label && base ? `${label}.${base}` : label).trim().toLowerCase();
  const taken = site.taken.find((t) => t.host === host);
  const availability: { state: "running" | "unhealthy"; text: string } | null = (() => {
    if (!editing || !label) return null;
    if (custom ? !HOST_RE.test(host) : !LABEL_RE.test(label)) return { state: "unhealthy", text: custom ? "Enter a full name, like www.example.com." : "Use letters, numbers and dashes; it can't start or end with a dash." };
    if (custom && base && (host === base || underBase(host))) return { state: "unhealthy", text: `For names under ${base}, untick “Use my own domain”.` };
    if (taken) return { state: "unhealthy", text: `Already used by ${taken.name}.` };
    if (had && host === had.host) return { state: "running", text: "Its current address." };
    return { state: "running", text: custom ? "Free." : "Free. The wildcard DNS record already covers it, so there's nothing to set up." };
  })();
  const scheme = editing ? (https.mode === "http" ? "http" : "https") : had?.https === "http" ? "http" : "https";
  const url = `${scheme}://${editing ? host || "…" : had!.host}`;
  const noIndex = !hasIndex;
  const replacing = site.state === "live";
  const live = site.versions.find((v) => v.live);

  async function publish() {
    setError(null);
    if (editing) {
      if (!availability || availability.state !== "running") {
        setErrors({ host: availability?.text ?? "Choose the address people will open." });
        return;
      }
    }
    let form = https;
    if (editing && https.mode === "own" && hasNewCert(https, prevRoute, undefined, host)) {
      setChecking(true);
      const v = await verifyHttps(https, host);
      setChecking(false);
      if ("errors" in v) {
        setErrors(v.errors);
        return;
      }
      form = v.form;
      setHttps(v.form);
    }
    if (beforePublish && !(await beforePublish())) return;
    setBusy(true);
    try {
      const body = editing ? { host, https: httpsSetting(form) ?? null, certs: certUploads(form, host, hasNewCert(form, prevRoute, undefined, host)) } : {};
      const d = await api.post<SiteDetail>(`/api/sites/${site.id}/publish`, body);
      onPublished(d);
      onOpenChange(false);
      toast.success(replacing ? "Published your changes" : `${site.name} is live`, { description: d.address?.url.replace(/^https?:\/\//, "") });
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      const field = e instanceof ApiError ? e.field : undefined;
      const hf = httpsFieldOf(field);
      if (field === "host") setErrors({ host: (e as Error).message });
      else if (hf) setErrors({ [hf]: (e as Error).message });
      else setError(e instanceof Error ? e.message : "It didn't publish.");
    } finally {
      setBusy(false);
    }
  }

  const draft = `${plural(site.draft.files, "file")}, ${formatBytes(site.draft.bytes)}`;
  const title = editing && had ? "Change the address" : replacing ? "Publish your changes" : site.state === "off" ? "Put it back online" : "Publish";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={title}
      description={site.state === "draft" ? "Choose where people will find it. You can change this later." : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void publish()} loading={busy || checking} disabled={noIndex}>
            {editing && had ? "Move and publish" : replacing ? "Publish changes" : "Publish"}
          </Button>
        </>
      }
    >
      <div className={s.body}>
        {site.addressesUnavailable && <Notice tone="fault">{site.addressesUnavailable}</Notice>}
        {noIndex && <Notice tone="attention" title="There's no index.html at the top of the site">It&rsquo;s the page people see when they open the address. Make one, or rename your front page to index.html, then publish.</Notice>}
        {editing ? (
          <div className={s.address}>
            <Field label="Address" error={errors.host}>
              {custom ? (
                <AffixInput before={`${https.mode === "http" ? "http" : "https"}://`} value={label} onChange={(e) => (setLabel(e.target.value.trim().toLowerCase()), setErrors({}))} mono placeholder="www.example.com" spellCheck={false} autoCapitalize="off" autoComplete="off" />
              ) : (
                <AffixInput before={`${https.mode === "http" ? "http" : "https"}://`} after={`.${base}`} value={label} onChange={(e) => (setLabel(e.target.value.replace(/[^A-Za-z0-9-]/g, "").toLowerCase()), setErrors({}))} mono placeholder="blog" spellCheck={false} autoCapitalize="off" autoComplete="off" />
              )}
            </Field>
            {availability && !errors.host && (
              <span className={s.avail} aria-live="polite">
                <span aria-hidden>
                  <StateLine state={availability.state} />
                </span>
                <span>{availability.text}</span>
              </span>
            )}
            <Checkbox checked={custom} onChange={(v) => (setCustom(v), setLabel(v ? (label && base && !label.includes(".") ? "" : label) : slug(site.name)), setErrors({}))}>
              Use my own domain
            </Checkbox>
            {custom && availability?.state === "running" && host !== had?.host && <DnsHelp host={host} baseDomain={base} purpose="web" publicIp={null} />}
            <HttpsSetting
              host={host}
              kind="web"
              value={https}
              onChange={(v) => (setHttps(v), setErrors({}))}
              errors={errors}
              checking={checking}
              onCheck={() =>
                void (async () => {
                  setChecking(true);
                  const v = await verifyHttps(https, host);
                  setChecking(false);
                  if ("errors" in v) setErrors(v.errors);
                  else setHttps(v.form);
                })()
              }
            />
          </div>
        ) : (
          <div className={s.where}>
            <span className={s.whereLabel}>Address</span>
            <span className={s.whereUrl}>{url.replace(/^https:\/\//, "")}</span>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Change
            </Button>
          </div>
        )}
        <p className={s.recap}>
          {replacing
            ? `Copies the draft (${draft}) and serves it at ${url.replace(/^https:\/\//, "")} in place of the version ${live ? `published ${fmt.relative(live.createdAt)}` : "there now"}.`
            : `Copies the draft (${draft}) and serves it at ${url.replace(/^https:\/\//, "")}.`}{" "}
          Gluon keeps the last {SITE_LIMITS.versions} versions, so you can go back to one.
        </p>
        {unsavedFile && <p className={s.recap}>Your changes to {unsavedFile} are saved first.</p>}
        {error && <Notice tone="fault">{error}</Notice>}
      </div>
    </Dialog>
  );
}
