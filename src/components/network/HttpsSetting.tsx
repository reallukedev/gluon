"use client";
import * as React from "react";
import { Lock, LockSlash, Page } from "iconoir-react";
import type { HttpsModeT, OwnCertInfo, OwnCertState } from "@/lib/network-types";
import { Button } from "@/components/ui/Button";
import { Field, Input, TextArea, Segmented } from "@/components/ui/Field";
import { StateLine } from "@/components/ui/StateLine";
import { certbotFiles, httpsSummary, type HttpsForm } from "./https-form";
import h from "./https.module.css";

/**
 * Who handles HTTPS for an address. Quiet by default: one line saying Gluon gets the certificate,
 * with the other ways a click away, each saying plainly who does what.
 */

export type SiteKind = "web" | "chat" | "voice" | "redirect";

interface Props {
  host: string;
  kind: SiteKind;
  value: HttpsForm;
  onChange: (f: HttpsForm) => void;
  /** The certificate already stored for this address, when it uses its own. */
  stored?: OwnCertState;
  errors: Record<string, string>;
  checking: boolean;
  onCheck: () => void;
}

const OPTIONS: { mode: HttpsModeT; title: string; text: (host: string) => string; only?: SiteKind }[] = [
  { mode: "auto", title: "Gluon gets a certificate", text: () => "The web server here gets one from Let's Encrypt and renews it on its own. Pick this unless something else already handles HTTPS." },
  { mode: "own", title: "I have my own certificate", text: () => "You supply it, from certbot, another tool or your organisation. Gluon serves it and warns you before it ends, but can't renew it." },
  {
    mode: "http",
    title: "Plain HTTP, HTTPS is handled in front",
    text: (host) => `For a tunnel, another proxy or a load balancer in front of this server. Without one, browsers mark http://${host || "the address"} as not secure.`,
  },
  {
    mode: "none",
    title: "The chat server handles its own",
    only: "chat",
    text: () => "No web page here at all, so the web server never asks for a certificate. Use this when the domain's website lives somewhere else.",
  },
];

export function HttpsSetting({ host, kind, value: f, onChange, stored, errors, checking, onCheck }: Props) {
  const [open, setOpen] = React.useState(f.mode !== "auto" || !!errors.https);
  const panelId = React.useId();
  const set = (patch: Partial<HttpsForm>) => onChange({ ...f, ...patch });
  const options = OPTIONS.filter((o) => !o.only || o.only === kind);
  React.useEffect(() => {
    if (Object.keys(errors).some((k) => ["https", "cert", "key", "certFile", "keyFile"].includes(k))) setOpen(true);
  }, [errors]);

  const panel = React.useRef<HTMLDivElement>(null);
  const opened = React.useRef(open);
  React.useEffect(() => {
    // Bring the choices into view when someone opens them, not when the editor starts open.
    if (open && !opened.current) panel.current?.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    opened.current = open;
  }, [open]);

  const showStored = f.mode === "own" && !!stored?.stored && !f.replacing && f.source === "paste";
  const plainLock = f.mode === "http" ? <LockSlash /> : <Lock />;

  return (
    <div className={h.wrap}>
      <div className={h.row}>
        <span className={h.icon} aria-hidden>
          {plainLock}
        </span>
        <span className={h.rowText}>
          <span className={h.rowLabel}>HTTPS</span>
          <span className={h.rowValue}>{httpsSummary(f, stored)}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={panelId}>
          {open ? "Done" : "Change"}
        </Button>
      </div>

      {open && (
        <div className={`${h.panel} appear`} id={panelId} ref={panel}>
          <div className={h.options} role="radiogroup" aria-label={`Who handles HTTPS for ${host || "this address"}`}>
            {options.map((o) => {
              const on = f.mode === o.mode;
              return (
                <button key={o.mode} type="button" role="radio" aria-checked={on} className={h.opt} data-on={on ? "" : undefined} onClick={() => set({ mode: o.mode })}>
                  <span className={h.radio} aria-hidden />
                  <span className={h.optText}>
                    <span className={h.optTitle}>{o.title}</span>
                    <span className={h.optSub}>{o.text(host)}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {errors.https && <p className={h.error}>{errors.https}</p>}

          {f.mode === "own" && (
            <div className={h.own}>
              <Segmented
                aria-label="Where the certificate comes from"
                value={f.source}
                onChange={(v) => set({ source: v, checked: null, ...(v === "files" && !f.certFile ? { certFile: certbotFiles(host).cert, keyFile: certbotFiles(host).key } : {}) })}
                options={[
                  { value: "paste", label: "Paste it" },
                  { value: "files", label: "Files on this server" },
                ]}
              />
              {f.source === "paste" ? (
                showStored ? (
                  <div className={h.stored}>
                    <CertFacts info={stored!.stored!} host={host} />
                    <div className={h.actions}>
                      <Button size="sm" onClick={() => set({ replacing: true, checked: null })}>
                        Replace it
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <PemField label="Certificate and its chain" placeholder="-----BEGIN CERTIFICATE-----" value={f.cert} error={errors.cert} onText={(cert) => set({ cert })} description="fullchain.pem if it comes from certbot." />
                    <PemField label="Private key" placeholder="-----BEGIN PRIVATE KEY-----" value={f.key} error={errors.key} onText={(key) => set({ key })} description="It stays on this server, readable only by the web server. Gluon never shows it again." />
                    {stored?.stored && f.replacing && (
                      <div className={h.actions}>
                        <Button size="sm" variant="ghost" onClick={() => set({ replacing: false, cert: "", key: "", checked: null })}>
                          Keep the current one
                        </Button>
                      </div>
                    )}
                  </>
                )
              ) : (
                <>
                  <Field label="Certificate file" error={errors.certFile} description="The full chain. Gluon copies it for the web server, and again whenever it changes, so renewals carry over.">
                    <Input value={f.certFile} onChange={(e) => set({ certFile: e.target.value.trim(), checked: null })} mono spellCheck={false} autoCapitalize="off" placeholder={certbotFiles(host).cert} />
                  </Field>
                  <Field label="Key file" error={errors.keyFile}>
                    <Input value={f.keyFile} onChange={(e) => set({ keyFile: e.target.value.trim(), checked: null })} mono spellCheck={false} autoCapitalize="off" placeholder={certbotFiles(host).key} />
                  </Field>
                  {stored?.error && <p className={h.error}>{stored.error}</p>}
                </>
              )}

              {!showStored && (
                <div className={h.check}>
                  {f.checked ? (
                    <CertFacts info={f.checked.info} host={host} />
                  ) : (
                    <>
                      <Button size="sm" loading={checking} onClick={onCheck}>
                        Check the certificate
                      </Button>
                      <span className={h.faint}>Gluon also checks it before saving.</span>
                    </>
                  )}
                </div>
              )}
              {f.source === "files" && !f.checked && stored?.stored && <CertFacts info={stored.stored} host={host} label="Serving now" />}
            </div>
          )}
          {f.mode === "http" && (
            <p className={h.faint}>
              The web server answers on port 80 only and never redirects to HTTPS. Make sure what&rsquo;s in front of it sends visitors here over HTTPS, or they&rsquo;ll see &ldquo;Not secure&rdquo;.
            </p>
          )}
          {f.mode === "none" && (
            <p className={h.faint}>
              Gluon stops copying certificates into the chat server, and web chat can&rsquo;t be published at {host || "this domain"}. The chat server needs its own certificate for {host || "the domain"}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PemField({ label, value, error, onText, placeholder, description }: { label: string; value: string; error?: string; onText: (t: string) => void; placeholder: string; description: string }) {
  const file = React.useRef<HTMLInputElement>(null);
  return (
    <div className={h.pem}>
      <Field label={label} error={error} description={description}>
        <TextArea value={value} onChange={(e) => onText(e.target.value)} rows={4} mono spellCheck={false} autoCapitalize="off" autoComplete="off" placeholder={placeholder} className={h.pemText} />
      </Field>
      <Button size="sm" variant="ghost" icon={<Page />} className={h.open} onClick={() => file.current?.click()}>
        Open a file
      </Button>
      <input
        ref={file}
        type="file"
        hidden
        accept=".pem,.crt,.cer,.key,.txt,application/x-pem-file"
        onChange={async (e) => {
          const picked = e.target.files?.[0];
          e.target.value = "";
          if (picked && picked.size < 64 * 1024) onText(await picked.text());
        }}
      />
    </div>
  );
}

const longDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

/** What a certificate covers and when it ends. The key is never part of this. */
export function CertFacts({ info, host, label }: { info: OwnCertInfo; host: string; label?: string }) {
  const state = info.daysLeft < 0 ? "unhealthy" : info.daysLeft < 21 ? "attention" : "running";
  const days = `${info.daysLeft} day${info.daysLeft === 1 ? "" : "s"}`;
  return (
    <div className={h.facts}>
      <StateLine state={state} label={info.daysLeft < 0 ? `${label ? `${label}: e` : "E"}xpired` : label ? `${label}, ends in ${days}` : `Covers ${host}, ends in ${days}`} />
      <dl className={h.dl}>
        <div>
          <dt>Names</dt>
          <dd className="mono">{info.names.slice(0, 4).join(", ")}{info.names.length > 4 ? ` +${info.names.length - 4}` : ""}</dd>
        </div>
        <div>
          <dt>Issued by</dt>
          <dd>{info.issuer ?? "Unknown"}{info.selfSigned ? " (itself)" : ""}</dd>
        </div>
        <div>
          <dt>Valid until</dt>
          <dd>{longDay(info.validTo)}</dd>
        </div>
        <div>
          <dt>Fingerprint</dt>
          <dd className={`mono ${h.fp}`} title={info.fingerprint}>
            {info.fingerprint.split(":").slice(0, 8).join(":")}…
          </dd>
        </div>
      </dl>
      {info.warnings.map((w) => (
        <span key={w} className={h.warn}>
          <StateLine state="attention" label={w} />
        </span>
      ))}
    </div>
  );
}
