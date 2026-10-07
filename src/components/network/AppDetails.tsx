"use client";
import * as React from "react";
import { MoreHoriz, Copy, OpenNewWindow, EditPencil, Trash, AppWindow, ChatBubble } from "iconoir-react";
import type { RouteStatus, XmppStatus } from "@/lib/network-types";
import { api } from "@/lib/client/api";
import type { LineState } from "@/lib/types";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton, LinkButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { AppIcon } from "@/components/apps/AppIcon";
import { LoginCell } from "./AppList";
import { healthOf, type Address, type AppEntry } from "./model";
import { bare, copyText, THIS_SERVER, XMPP_CLIENT_PORTS } from "./shared";
import s from "./network.module.css";
import c from "./chat.module.css";

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
  onSetUpChat: (routeId: string) => void;
  onRecheck: () => void;
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

type Link = { name: string; state: LineState; label: string; title: string };

function dnsLink(d: RouteStatus["dns"]): Link {
  return !d
    ? { name: "DNS", state: "unknown", label: "Not checked", title: "" }
    : d.status === "ok"
      ? { name: "DNS", state: "running", label: d.proxied ? "Through Cloudflare" : "Points to your router", title: d.message }
      : d.status === "missing"
        ? { name: "DNS", state: "unhealthy", label: "No record", title: d.message }
        : d.status === "mismatch"
          ? { name: "DNS", state: "attention", label: "Points elsewhere", title: d.message }
          : { name: "DNS", state: "unknown", label: "Lookup failed", title: d.message };
}

/** A port on the chat server: does it answer, and is the certificate it presents good. */
function portLink(name: string, p: XmppStatus["c2s"]): Link {
  if (!p.reachable) return { name, state: "unhealthy", label: `Not answering on :${p.port}`, title: p.error ?? "" };
  if (p.error) return { name, state: "unhealthy", label: "Refuses chat apps", title: p.error };
  const t = p.tls;
  if (!t) return { name, state: "unknown", label: `Answers on :${p.port}`, title: "" };
  if (t.status === "ok") return { name, state: "running", label: `:${p.port}, ${t.daysLeft} days left`, title: t.message };
  if (t.status === "expiring") return { name, state: "attention", label: `Certificate ends in ${t.daysLeft} day${t.daysLeft === 1 ? "" : "s"}`, title: t.message };
  return { name, state: "unhealthy", label: t.status === "expired" ? "Certificate expired" : "Certificate not trusted", title: t.message };
}

/** How a chat app reaches the server: the name, the sign-in port, and other servers. */
function chatChain(st: RouteStatus | undefined): Link[] | null {
  if (!st?.enabled || !st.xmpp) return null;
  const x = st.xmpp;
  const out = [dnsLink(st.dns), portLink("Sign-in", x.c2s)];
  if (x.s2s) out.push(portLink("Other servers", x.s2s));
  if (x.certSync) out.push({ name: "Certificate copy", state: x.certSync.ok ? "running" : "attention", label: x.certSync.ok ? "Up to date" : "Needs a look", title: x.certSync.message });
  return out;
}

function chain(st: RouteStatus | undefined, redirect: boolean): Link[] | null {
  if (!st) return null;
  if (!st.enabled) return null;
  const out: Link[] = [];
  out.push(dnsLink(st.dns));
  const t = st.tls;
  out.push(
    !t
      ? { name: "Certificate", state: "unknown", label: "Not checked", title: "" }
      : t.status === "ok"
        ? { name: "Certificate", state: "running", label: `${t.daysLeft} days left`, title: `${t.message}${t.issuer ? ` (${t.issuer})` : ""}` }
        : t.status === "expiring"
          ? { name: "Certificate", state: "attention", label: `Ends in ${t.daysLeft} day${t.daysLeft === 1 ? "" : "s"}`, title: t.message }
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

export function AppDetails({ entry: e, baseDomain, open, onOpenChange, busy, statusLoading, checkedAt, onEdit, onEditFallback, onSetUpChat, onRecheck, onToggleAddress, onRemoveAddress, onRemoveApp, onMarkLogin, onHomeOnly }: Props) {
  const main = e.main;
  const route = main.route?.type === "subdomain" ? main.route : null;
  const isChat = !!route?.xmpp;
  // A chat server published like a web app: Caddy sends browsers to a port that only speaks XMPP.
  const chatAsWeb = !!route && !route.xmpp && route.backend.host === THIS_SERVER && XMPP_CLIENT_PORTS.has(route.backend.port);
  const links = isChat ? chatChain(main.status) : chain(main.status, main.route?.type === "redirect");
  const [syncing, setSyncing] = React.useState(false);
  async function checkCertificate() {
    setSyncing(true);
    try {
      const r = await api.post<{ sync: Record<string, { ok: boolean; message: string }> }>("/api/network/xmpp", {});
      const st = r.sync[main.id];
      if (st?.ok) toast.success("Certificate checked", { description: st.message });
      else toast.error("The certificate needs a look", { description: st?.message });
      onRecheck();
    } catch (err) {
      toast.error("Couldn't check the certificate", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setSyncing(false);
    }
  }
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
        {chatAsWeb && (
          <Notice
            tone="attention"
            title="This is a chat server set up as a web app"
            action={
              <Button size="sm" icon={<ChatBubble />} onClick={() => onSetUpChat(main.id)}>
                Set up as a chat server
              </Button>
            }
          >
            Browsers that open {bare(main.url)} are sent to port {route!.backend.port}, which only chat apps understand, so they get an error. Gluon can publish it the way XMPP expects and keep its certificate current.
          </Notice>
        )}
        {e.on && (
          <section className={s.dSection} aria-label={isChat ? "How chat apps connect" : "How a visit gets there"}>
            <div className={s.dHead}>
              <h3 className={s.dSub}>{isChat ? "How chat apps connect" : "How a visit gets there"}</h3>
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

        {isChat && e.on && main.status?.xmpp && <ChatFacts x={main.status.xmpp} syncing={syncing} onCheck={() => void checkCertificate()} />}

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

        {!e.isRedirect && !isChat && (
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

function ChatFacts({ x, syncing, onCheck }: { x: XmppStatus; syncing: boolean; onCheck: () => void }) {
  const srv = [x.srv.client, x.srv.server].filter((r): r is NonNullable<typeof r> => !!r);
  const ports = [x.c2s.port, ...(x.s2s ? [x.s2s.port] : [])];
  // Unset records on the standard ports are normal; one sentence says so instead of one per record.
  const allFallback = srv.every((r) => r.status === "missing");
  return (
    <section className={s.dSection}>
      <h3 className={s.dSub}>Chat server</h3>
      <dl className={c.facts}>
        <div className={c.fact}>
          <dt>Sign in as</dt>
          <dd>
            <span className="mono">name@{x.domain}</span>
          </dd>
        </div>
        <div className={c.fact}>
          <dt>New accounts</dt>
          <dd>
            {x.openRegistration === null ? (
              <span className={c.factNote}>Couldn&rsquo;t tell</span>
            ) : x.openRegistration ? (
              <>
                <StateLine state="attention" label="Anyone can sign up" />
                <span className={c.factNote}>Strangers can create accounts from any chat app. Turn off allow_registration in the chat server&rsquo;s config unless that&rsquo;s the plan.</span>
              </>
            ) : (
              <StateLine state="running" label="Only accounts you create" />
            )}
          </dd>
        </div>
        <div className={c.fact}>
          <dt>DNS (SRV)</dt>
          <dd>
            {allFallback ? (
              <span className={c.factNote}>
                Not set, which is fine: apps{x.s2s ? " and other servers" : ""} find {x.domain} on port{ports.length > 1 ? "s" : ""} {ports.join(" and ")} by themselves.
              </span>
            ) : (
              srv.map((r) => (
                <span key={r.name} className={c.factNote}>
                  {r.message}
                </span>
              ))
            )}
          </dd>
        </div>
        {x.web && (
          <div className={c.fact}>
            <dt>Web chat</dt>
            <dd>
              <StateLine state={x.web.reachable ? "running" : "attention"} label={x.web.reachable ? `Answering on :${x.web.port}` : `Not answering on :${x.web.port}`} />
            </dd>
          </div>
        )}
        {x.certSync && (
          <div className={c.fact}>
            <dt>Certificate copy</dt>
            <dd>
              <span className={c.factNote}>{x.certSync.message}</span>
              <span className={c.syncRow}>
                {x.certSync.checkedAt && (
                  <span className={c.factNote}>
                    Checked <Time ts={x.certSync.checkedAt} />
                  </span>
                )}
                <Button size="sm" loading={syncing} onClick={onCheck}>
                  Check now
                </Button>
              </span>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
