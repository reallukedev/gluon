"use client";
import * as React from "react";
import { MoreHoriz, Copy, OpenNewWindow, EditPencil, Trash, AppWindow } from "iconoir-react";
import type { RouteStatus } from "@/lib/network-types";
import type { LineState } from "@/lib/types";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton, LinkButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { AppIcon } from "@/components/apps/AppIcon";
import { LoginCell } from "./AppList";
import { healthOf, type Address, type AppEntry } from "./model";
import { bare, copyText } from "./shared";
import s from "./network.module.css";

/**
 * One app's place on the internet: the chain a visit takes (DNS, certificate, web server, app) with
 * each link's state, every address that leads to it, and whether a login protects it.
 */

interface Props {
  entry: AppEntry;
  baseDomain: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  busy: boolean;
  statusLoading: boolean;
  checkedAt: number | null;
  onEdit: (routeId: string) => void;
  onEditFallback: () => void;
  onToggleAddress: (a: Address, on: boolean) => void;
  onRemoveAddress: (a: Address) => void;
  onRemoveApp: (e: AppEntry) => void;
  onMarkLogin: (e: AppEntry, v: "yes" | "no") => void;
  onHomeOnly: (e: AppEntry) => void;
}

const ROLE: Record<Address["role"], string> = {
  main: "Main address",
  fallback: "Main address",
  shortLink: "Short link: redirects to the main address",
  path: "A path on the main domain",
  subdomain: "Another name for it",
  redirect: "Short link",
};

function chain(st: RouteStatus | undefined, redirect: boolean): { name: string; state: LineState; label: string; title: string }[] | null {
  if (!st) return null;
  if (!st.enabled) return null;
  const out: { name: string; state: LineState; label: string; title: string }[] = [];
  const d = st.dns;
  out.push(
    !d
      ? { name: "DNS", state: "unknown", label: "Not checked", title: "" }
      : d.status === "ok"
        ? { name: "DNS", state: "running", label: d.proxied ? "Through Cloudflare" : "Points to your router", title: d.message }
        : d.status === "missing"
          ? { name: "DNS", state: "unhealthy", label: "No record", title: d.message }
          : d.status === "mismatch"
            ? { name: "DNS", state: "attention", label: "Points elsewhere", title: d.message }
            : { name: "DNS", state: "unknown", label: "Lookup failed", title: d.message },
  );
  const t = st.tls;
  out.push(
    !t
      ? { name: "Certificate", state: "unknown", label: "Not checked", title: "" }
      : t.status === "ok"
        ? { name: "Certificate", state: "running", label: `${t.daysLeft} days left`, title: `${t.message}${t.issuer ? ` (${t.issuer})` : ""}` }
        : t.status === "expiring"
          ? { name: "Certificate", state: "attention", label: `Ends in ${t.daysLeft} d`, title: t.message }
          : t.status === "expired"
            ? { name: "Certificate", state: "unhealthy", label: "Expired", title: t.message }
            : t.status === "pending"
              ? t.issueError
                ? { name: "Certificate", state: "attention", label: "Couldn't be issued", title: t.issueError }
                : { name: "Certificate", state: "starting", label: "Being issued", title: t.message }
              : { name: "Certificate", state: "attention", label: t.status === "invalid" ? "Not trusted" : "Check failed", title: t.message },
  );
  const h = st.http;
  out.push(
    !h
      ? { name: "Web server", state: "unknown", label: "Not checked", title: "" }
      : h.error
        ? { name: "Web server", state: "unhealthy", label: "Not serving it", title: h.error }
        : h.status && h.status >= 500
          ? { name: "Web server", state: "unhealthy", label: `Error ${h.status}`, title: `The web server answered with an error page (HTTP ${h.status}).` }
          : h.status && h.status >= 300 && h.status < 400
            ? { name: "Web server", state: "running", label: redirect ? "Redirects" : "Answers", title: `HTTP ${h.status}${h.location ? ` → ${h.location}` : ""}${h.ms !== null ? ` in ${h.ms} ms` : ""}` }
            : { name: "Web server", state: "running", label: h.ms !== null ? `Answers in ${h.ms} ms` : "Answers", title: `HTTP ${h.status}` },
  );
  if (!redirect) {
    const b = st.backend;
    out.push(
      !b
        ? { name: st.app?.name ?? "App", state: "unknown", label: "Not checked", title: "" }
        : b.reachable
          ? { name: st.app?.name ?? "App", state: "running", label: `Answering on :${b.port}`, title: `${b.host}:${b.port}${b.ms !== null ? `, ${b.ms} ms` : ""}` }
          : { name: st.app?.name ?? "App", state: "unhealthy", label: `Not answering on :${b.port}`, title: b.error ?? "" },
    );
  }
  return out;
}

export function AppDetails({ entry: e, baseDomain, open, onOpenChange, busy, statusLoading, checkedAt, onEdit, onEditFallback, onToggleAddress, onRemoveAddress, onRemoveApp, onMarkLogin, onHomeOnly }: Props) {
  const main = e.main;
  const links = chain(main.status, main.route?.type === "redirect");
  const addresses = [main, ...e.also];
  const note = main.route?.note;
  const copy = (url: string) => void copyText(url).then((ok) => (ok ? toast.success("Copied", { description: url }) : toast.error("Couldn't copy", { description: url })));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title={
        <span className={s.dTitle}>
          <AppIcon src={e.icon} name={e.name} size={28} />
          {e.name}
        </span>
      }
      description={e.isFallback ? `Answers ${baseDomain} and anything no other address claims.` : e.on ? bare(main.url) : "Not on the internet right now. Its settings are kept."}
      footer={
        <>
          {e.appId && (
            <LinkButton variant="ghost" href={`/apps/${encodeURIComponent(e.appId)}`} icon={<AppWindow />}>
              Go to the app
            </LinkButton>
          )}
          <Button variant="primary" icon={<EditPencil />} onClick={() => (e.isFallback ? onEditFallback() : onEdit(main.id))}>
            {e.isFallback ? "Change the app" : "Edit"}
          </Button>
        </>
      }
    >
      <div className={s.dBody}>
        {e.on && (
          <section className={s.dSection} aria-label="How a visit gets there">
            <div className={s.dHead}>
              <h3 className={s.dSub}>How a visit gets there</h3>
              {checkedAt && (
                <span className={s.faint}>
                  Checked <Time ts={checkedAt} />
                </span>
              )}
            </div>
            {!links ? (
              statusLoading ? (
                <Skeleton height={58} radius={8} />
              ) : (
                <p className={s.faint}>Not checked yet.</p>
              )
            ) : (
              <ol className={s.chain}>
                {links.map((l) => (
                  <li key={l.name} className={s.chainHop} title={l.title || undefined}>
                    <span className={s.chainName}>{l.name}</span>
                    <StateLine state={l.state} label={l.label} />
                  </li>
                ))}
              </ol>
            )}
            {e.health.state && e.health.state !== "running" && e.health.sentence && <p className={s.dSentence}>{e.health.sentence}</p>}
          </section>
        )}

        <section className={s.dSection}>
          <h3 className={s.dSub}>Addresses</h3>
          <ul className={s.addrs} role="list">
            {addresses.map((a) => {
              const h = healthOf(a.status, a.route?.type === "redirect");
              return (
                <li key={a.id} className={s.addr} data-off={a.enabled ? undefined : ""}>
                  <span className={s.addrMain}>
                    <a className={s.url} href={a.url} target="_blank" rel="noopener noreferrer" title={a.url}>
                      {a.role === "fallback" ? baseDomain : bare(a.url)}
                    </a>
                    <span className={s.cellSub}>
                      {ROLE[a.role]} · {a.lane === "direct" ? "direct" : "through Cloudflare"}
                    </span>
                  </span>
                  <span className={s.addrState} title={h?.sentence}>
                    {!a.enabled ? <StateLine state="stopped" label="Off" /> : h ? <StateLine state={h.state} label={h.label} /> : statusLoading ? <Skeleton width={80} height={12} /> : null}
                  </span>
                  <span className={s.addrSwitch}>
                    {a.role !== "fallback" && <Switch checked={a.enabled} onChange={(on) => onToggleAddress(a, on)} disabled={busy} aria-label={`${bare(a.url)} on the internet`} />}
                  </span>
                  <span className={s.addrMenu}>
                    <Menu
                      trigger={
                        <IconButton label={`${bare(a.url)} actions`} size="sm">
                          <MoreHoriz />
                        </IconButton>
                      }
                      items={[
                        { label: "Open", icon: <OpenNewWindow />, onSelect: () => window.open(a.url, "_blank", "noopener"), disabled: !a.enabled },
                        { label: "Copy address", icon: <Copy />, onSelect: () => copy(a.url) },
                        ...(a.role === "fallback"
                          ? [{ label: "Change the app", icon: <EditPencil />, onSelect: onEditFallback }]
                          : [
                              { label: "Edit", icon: <EditPencil />, onSelect: () => onEdit(a.id) },
                              "separator" as const,
                              { label: "Remove this address", icon: <Trash />, danger: true, onSelect: () => onRemoveAddress(a) },
                            ]),
                      ]}
                    />
                  </span>
                </li>
              );
            })}
            {e.extras.map((x, i) => (
              <li key={`x${i}`} className={s.addr}>
                <span className={s.addrMain}>
                  <span className={`${s.cellText} mono`} title={x.paths.join(" ")}>
                    {bare(main.url)}
                    {x.paths[0]}
                    {x.paths.length > 1 ? ` +${x.paths.length - 1}` : ""}
                  </span>
                  <span className={s.cellSub} title={x.note}>
                    Goes to {x.app ?? "another app"} on port {x.port}
                    {x.note ? ` · ${x.note}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        {!e.isRedirect && (
          <section className={s.dSection}>
            <h3 className={s.dSub}>Login</h3>
            <div className={s.dLogin}>
              <LoginCell l={e.login} />
              {e.login.evidence && <p className={s.faint}>{e.login.evidence}</p>}
              {e.login.adminTool && e.on && <p className={s.faint}>It can change this server or your home, so use a strong password and two-factor sign-in if it offers it. Keeping it home-only is safer.</p>}
              {e.on && e.needsLogin && <p className={s.dWarn}>Anyone who finds {bare(main.url)} can use it.</p>}
              {e.on && e.appId && (e.login.tone === "unknown" || e.login.tone === "none" || e.login.tone === "login") && (
                <div className={s.dActions}>
                  {e.login.tone !== "login" && (
                    <Button size="sm" onClick={() => onMarkLogin(e, "yes")} disabled={busy}>
                      It has its own login
                    </Button>
                  )}
                  {e.login.tone !== "none" && (
                    <>
                      {e.login.tone === "login" && <span className={s.faint}>Not right?</span>}
                      <Button size="sm" variant={e.login.tone === "login" ? "ghost" : "secondary"} onClick={() => onMarkLogin(e, "no")} disabled={busy}>
                        It has no login
                      </Button>
                    </>
                  )}
                  {!e.isFallback && (e.needsLogin || e.login.adminTool) && (
                    <Button size="sm" onClick={() => onHomeOnly(e)} disabled={busy}>
                      Make it home-only
                    </Button>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {note && (
          <section className={s.dSection}>
            <h3 className={s.dSub}>Note</h3>
            <p className={s.dNote}>{note}</p>
          </section>
        )}

        {!e.isFallback && (
          <section className={s.dDanger}>
            <p className={s.faint}>{e.on ? "Take every address above off the internet. The app keeps running at home, and History can bring the addresses back." : "Delete these addresses. The app keeps running at home, and History can bring them back."}</p>
            <Button size="sm" variant="danger" onClick={() => onRemoveApp(e)} disabled={busy}>
              {e.on ? "Remove from the internet" : "Remove the addresses"}
            </Button>
          </section>
        )}
      </div>
    </Dialog>
  );
}
