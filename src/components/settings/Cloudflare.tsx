"use client";
import * as React from "react";
import { MoreHoriz, OpenNewWindow, Refresh, RefreshDouble, Trash, KeyBack, Globe } from "iconoir-react";
import { api, ApiError, useApi } from "@/lib/client/api";
import { AppIcon } from "@/components/apps/AppIcon";
import { Button, IconButton, LinkButton } from "@/components/ui/Button";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { Field, Input, SettingRow, Switch } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { Select } from "@/components/ui/Select";
import { StateLine, type LineState } from "@/components/ui/StateLine";
import { Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import type { CloudflareStatus, DnsRecordT, ManagedName, TokenCheck } from "@/lib/cloudflare-types";
import c from "./cloudflare.module.css";

export const CLOUDFLARE_ICON = "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/cloudflare.svg";
const TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

/** The panel's summary line, also used by the section header. */
export function cloudflareSummary(cf: CloudflareStatus | undefined): string | null {
  if (!cf?.connected || !cf.zone) return null;
  const s = cf.sync;
  const down = !!cf.tunnel && (!cf.tunnel.container?.running || cf.tunnel.status === "down");
  if (down || s.problems.length || s.names.some((n) => n.state === "conflict" || n.state === "error")) return `Cloudflare needs a look.`;
  if (cf.tunnel) return `Cloudflare carries ${cf.zone.name} through a tunnel.`;
  return `Cloudflare keeps ${cf.zone.name} pointed here.`;
}

export function useCloudflare(enabled = true) {
  // While the tunnel is starting, look again sooner.
  const [fast, setFast] = React.useState(false);
  const res = useApi<CloudflareStatus>(enabled ? "/api/cloudflare" : null, { refresh: fast ? 5_000 : 60_000 });
  const t = res.data?.tunnel;
  const settling = !!t && (t.status !== "healthy" || !t.container?.running);
  React.useEffect(() => setFast(settling || !!res.data?.sync.running), [settling, res.data?.sync.running]);
  return res;
}

// ================================================================= panel

export function CloudflarePanel() {
  const { data, error, mutate } = useCloudflare();
  const [connecting, setConnectingState] = React.useState<"new" | "token" | "zone" | null>(null);
  // Each opening starts fresh; while closing, the dialog keeps its mode so it can animate out.
  const [opened, setOpened] = React.useState<{ mode: "new" | "token" | "zone"; n: number }>({ mode: "new", n: 0 });
  const setConnecting = (m: "new" | "token" | "zone" | null) => {
    if (m) setOpened((o) => ({ mode: m, n: o.n + 1 }));
    setConnectingState(m);
  };
  const [busy, setBusy] = React.useState<null | "sync" | "tunnel" | "restart" | "ipv6" | string>(null);
  const [confirm, confirmNode] = useConfirm();

  const run = async (what: string, fn: () => Promise<CloudflareStatus>, done?: (s: CloudflareStatus) => string | null) => {
    setBusy(what);
    try {
      const s = await fn();
      void mutate(s, { revalidate: false });
      const msg = done?.(s);
      if (msg) toast.success(msg);
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      toast.error("That didn't work", { description: e instanceof ApiError ? e.message : undefined });
      void mutate();
    } finally {
      setBusy(null);
    }
  };

  if (error && !data) {
    return (
      <Panel id="cloudflare" title="Cloudflare">
        <Notice tone="fault" title="Couldn't load Cloudflare" action={<Button size="sm" onClick={() => mutate()}>Try again</Button>}>
          {error.message}
        </Notice>
      </Panel>
    );
  }
  if (!data) {
    return (
      <Panel id="cloudflare" title="Cloudflare" flush>
        <div className={c.head}>
          <Skeleton width={32} height={32} radius={8} />
          <span style={{ display: "grid", gap: 6 }}>
            <Skeleton width={160} height={13} />
            <Skeleton width={260} height={11} />
          </span>
        </div>
      </Panel>
    );
  }

  const dialog = (
    <ConnectDialog
      key={opened.n}
      open={!!connecting}
      mode={opened.mode}
      current={data}
      onClose={() => setConnecting(null)}
      onConnected={(s) => {
        setConnecting(null);
        void mutate(s, { revalidate: false });
        toast.success(opened.mode === "new" ? `Connected ${s.zone?.name ?? "Cloudflare"}` : "Saved");
      }}
    />
  );

  if (!data.connected || !data.zone) {
    return (
      <Panel id="cloudflare" title="Cloudflare" flush>
        <div className={c.head}>
          <AppIcon src={CLOUDFLARE_ICON} name="Cloudflare" size={32} />
          <div className={c.headText}>
            <span className={c.line}>DNS records, dynamic DNS and a tunnel, all from one API token.</span>
          </div>
          <div className={c.headActions}>
            <Button variant="primary" size="sm" onClick={() => setConnecting("new")}>
              Connect Cloudflare
            </Button>
          </div>
        </div>
        {dialog}
      </Panel>
    );
  }

  const zone = data.zone;
  const sync = data.sync;
  const conflicts = sync.names.filter((n) => n.state === "conflict");
  const errors = sync.names.filter((n) => n.state === "error");
  const live = sync.names.filter((n) => n.want.length > 0);
  const tunnel = data.tunnel;
  const straight = live.filter((n) => n.want.some((w) => w.type === "A"));
  const tokenProblem = sync.problems.some((p) => /token/i.test(p));

  const summary: { state: LineState; text: string } = !data.network
    ? { state: "attention", text: "Set up public addresses on the Network page first. DNS follows them." }
    : sync.at === null
      ? { state: "starting", text: "Checking DNS…" }
      : sync.problems.length
        ? { state: "unhealthy", text: sync.problems[0]! }
        : errors.length
          ? { state: "unhealthy", text: `Cloudflare refused ${errors.length === 1 ? `the change to ${errors[0]!.name}` : `${errors.length} changes`}.` }
          : conflicts.length
            ? { state: "attention", text: `${conflicts.length === 1 ? `${conflicts[0]!.name} has records` : `${conflicts.length} names have records`} Gluon didn't make.` }
            : tunnel
              ? { state: "running", text: `Visitors come in through the tunnel${straight.length ? `, except ${straight.length === 1 ? straight[0]!.name : `${straight.length} names`}, which ${straight.length === 1 ? "goes" : "go"} straight to ${sync.ipv4 ?? "this network"}` : ""}.` }
              : { state: "running", text: `${live.length === 1 ? "1 name points" : `${live.length} names point`} at ${sync.ipv4 ?? "this network"}.` };

  const tunnelLine: { state: LineState; text: string } | null = !tunnel
    ? null
    : !tunnel.container
      ? { state: "unhealthy", text: "cloudflared isn't on this server any more." }
      : !tunnel.container.running
        ? { state: "unhealthy", text: tunnel.container.state === "restarting" ? "cloudflared keeps restarting." : tunnel.container.state === "created" ? "cloudflared hasn't started." : "cloudflared stopped." }
        : tunnel.status === "healthy"
          ? { state: "running", text: `Connected to Cloudflare${tunnel.connections > 1 ? ` in ${tunnel.connections} places` : ""}.` }
          : tunnel.status === "degraded"
            ? { state: "attention", text: "Connected, but some of its links to Cloudflare are down." }
            : { state: "starting", text: "Connecting to Cloudflare…" };

  function toggleTunnel(on: boolean) {
    if (on) {
      confirm({
        title: "Turn on the tunnel?",
        consequences: [
          `Web addresses in ${zone.name} reach this server through Cloudflare. Nothing needs forwarding on the router for them.`,
          "Uploads over 100 MB fail and video streaming isn't allowed. Mark an address Direct on the Network page to keep it off the tunnel.",
          "Chat and voice addresses still go straight to this network.",
        ],
        confirmLabel: "Turn on tunnel",
        onConfirm: () => run("tunnel", () => api.post<CloudflareStatus>("/api/cloudflare/tunnel", { action: "enable" }), () => "The tunnel is on"),
      });
    } else {
      confirm({
        title: "Turn off the tunnel?",
        consequences: [
          `DNS points at ${sync.ipv4 ?? "this network's address"} again, so port 443 has to be forwarded to this server.`,
          "Caddy gets its own certificates again, which can take a minute.",
          "The tunnel is removed from Cloudflare.",
        ],
        confirmLabel: "Turn off tunnel",
        variant: "danger",
        onConfirm: () => run("tunnel", () => api.del<CloudflareStatus>("/api/cloudflare/tunnel"), () => "The tunnel is off"),
      });
    }
  }

  function disconnect() {
    confirm({
      title: "Disconnect Cloudflare?",
      consequences: ["Records Gluon made stay in Cloudflare and keep working, but stop following this network's address.", "Gluon forgets the token."],
      confirmLabel: "Disconnect",
      variant: "danger",
      onConfirm: async () => {
        const s = await api.del<CloudflareStatus>("/api/cloudflare");
        void mutate(s, { revalidate: false });
        toast.success("Disconnected Cloudflare");
      },
    });
  }

  return (
    <Panel
      id="cloudflare"
      title="Cloudflare"
      flush
      meta={
        <Menu
          trigger={
            <IconButton label="Cloudflare options" size="sm">
              <MoreHoriz />
            </IconButton>
          }
          items={[
            { label: "Replace token", icon: <KeyBack />, onSelect: () => setConnecting("token") },
            { label: "Use another domain", icon: <Globe />, disabled: !!tunnel, description: tunnel ? "Turn the tunnel off first" : undefined, onSelect: () => setConnecting("zone") },
            "separator",
            { label: "Disconnect", icon: <Trash />, danger: true, disabled: !!tunnel, description: tunnel ? "Turn the tunnel off first" : undefined, onSelect: disconnect },
          ]}
        />
      }
    >
      <div className={c.head}>
        <AppIcon src={CLOUDFLARE_ICON} name="Cloudflare" size={32} />
        <div className={c.headText}>
          <span className={c.title}>
            <span className="truncate">{zone.name}</span>
            <span className={c.account}>{zone.accountName}</span>
          </span>
          <span className={c.state} aria-live="polite">
            <StateLine state={summary.state} size={11} />
            <span className={c.stateText}>
              {summary.text}
              {sync.at && !sync.running ? (
                <span className={c.when}>
                  {" "}
                  Checked <Time ts={sync.at} />.
                </span>
              ) : null}
            </span>
          </span>
        </div>
        <div className={c.headActions}>
          {tokenProblem && (
            <Button size="sm" icon={<KeyBack />} onClick={() => setConnecting("token")}>
              Replace token
            </Button>
          )}
          {conflicts.length > 1 && (
            <Button size="sm" loading={busy === "adopt:all"} onClick={() => run("adopt:all", () => api.post("/api/cloudflare/adopt", { names: conflicts.map((n) => n.name) }), () => `Gluon manages ${conflicts.length} more names`)}>
              Manage all
            </Button>
          )}
          <Button size="sm" icon={<Refresh />} loading={busy === "sync" || sync.running} disabled={!data.network} onClick={() => run("sync", () => api.post("/api/cloudflare/sync"))}>
            Check now
          </Button>
        </div>
      </div>

      {data.ddnsContainer && (
        <div className={c.pad}>
          <Notice title={`${data.ddnsContainer} is still running`}>Gluon updates these records itself now, so it can be stopped from Apps.</Notice>
        </div>
      )}

      {data.network && (
        <div className={c.block}>
          <SettingRow
            label="Cloudflare Tunnel"
            description={tunnel ? undefined : "Reach this server without forwarding ports on the router. Uploads stop at 100 MB and video streaming isn't allowed."}
          >
            <Switch checked={!!tunnel || busy === "tunnel"} disabled={busy === "tunnel"} onChange={toggleTunnel} aria-label="Cloudflare Tunnel" />
          </SettingRow>
          {busy === "tunnel" && !tunnel ? (
            <p className={`${c.tunnelLine} appear`} data-motion-gentle="">
              <StateLine state="starting" size={11} /> Making the tunnel and starting cloudflared…
            </p>
          ) : tunnelLine ? (
            <div className={`${c.tunnelLine} appear`} data-motion-gentle="">
              <StateLine state={tunnelLine.state} size={11} />
              <span>{tunnelLine.text}</span>
              {tunnel && (!tunnel.container?.running || tunnel.status === "down" || tunnel.status === "inactive") && (
                <Button size="sm" icon={<RefreshDouble />} loading={busy === "restart"} onClick={() => run("restart", () => api.post<CloudflareStatus>("/api/cloudflare/tunnel", { action: "restart" }), () => "Restarted cloudflared")}>
                  Restart cloudflared
                </Button>
              )}
            </div>
          ) : null}
        </div>
      )}

      {sync.names.length > 0 && (
        <ul className={c.names} aria-label={`DNS records Gluon keeps in ${zone.name}`}>
          {sync.names.map((n) => (
            <NameRow
              key={n.name}
              n={n}
              busy={busy === `adopt:${n.name}`}
              onAdopt={() => run(`adopt:${n.name}`, () => api.post("/api/cloudflare/adopt", { names: [n.name] }), () => `Gluon manages ${n.name}`)}
            />
          ))}
        </ul>
      )}

      {data.network && (
        <div className={c.block}>
          <SettingRow label="IPv6" description="Also publish this server's IPv6 address, for names that point straight here.">
            <Switch
              checked={data.ipv6}
              disabled={busy === "ipv6"}
              onChange={(v) => run("ipv6", () => api.patch<CloudflareStatus>("/api/cloudflare", { ipv6: v }))}
              aria-label="Publish IPv6 addresses"
            />
          </SettingRow>
        </div>
      )}
      {dialog}
      {confirmNode}
    </Panel>
  );
}

function describe(r: DnsRecordT[]): string {
  if (!r.length) return "Nothing";
  if (r.some((x) => x.type === "CNAME" && x.content.endsWith(".cfargotunnel.com"))) return "Tunnel";
  return r.map((x) => (x.type === "CNAME" ? x.content : `${x.content}${x.proxied ? " via Cloudflare" : ""}`)).join(", ");
}

const NAME_STATE: Record<ManagedName["state"], LineState> = { ok: "running", changed: "running", conflict: "attention", error: "unhealthy" };

function NameRow({ n, busy, onAdopt }: { n: ManagedName; busy: boolean; onAdopt: () => void }) {
  const removing = n.want.length === 0;
  const text =
    n.state === "conflict"
      ? `Has ${describe(n.have)}. Gluon would set ${describe(n.want).toLowerCase() === "tunnel" ? "the tunnel" : describe(n.want)}.`
      : n.state === "error"
        ? (n.message ?? "Cloudflare refused the change.")
        : removing
          ? "Removed"
          : describe(n.want);
  return (
    <li className={c.name} data-state={n.state}>
      <span className={c.nameMain}>
        <span className={`${c.host} mono`} title={n.name}>
          {n.name}
        </span>
        <span className={c.why}>{n.why}</span>
      </span>
      <span className={c.value} data-fault={n.state === "error" ? "" : undefined}>
        <StateLine state={removing && n.state !== "error" ? "stopped" : NAME_STATE[n.state]} size={11} />
        <span className={n.state === "conflict" || n.state === "error" || text === "Tunnel" || removing ? undefined : "mono"}>{text}</span>
        {n.state === "changed" && !removing && <span className={c.updated}>Updated</span>}
      </span>
      {n.state === "conflict" && (
        <Button size="sm" loading={busy} onClick={onAdopt}>
          Let Gluon manage
        </Button>
      )}
    </li>
  );
}

// ================================================================= connect

const PERMISSIONS: [string, string, string, boolean][] = [
  ["Zone", "DNS", "Edit", true],
  ["Zone", "Zone", "Read", true],
  ["Account", "Cloudflare Tunnel", "Edit", false],
];

function ConnectDialog({ open, mode, current, onClose, onConnected }: { open: boolean; mode: "new" | "token" | "zone"; current: CloudflareStatus; onClose: () => void; onConnected: (s: CloudflareStatus) => void }) {
  const needsToken = mode !== "zone";
  const [token, setToken] = React.useState("");
  const [check, setCheck] = React.useState<TokenCheck | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [zoneId, setZoneId] = React.useState<string | null>(mode === "zone" ? null : (current.zone?.id ?? null));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const seq = React.useRef(0);

  // Check the token as soon as it's pasted; a newer paste wins over an older answer.
  const runCheck = React.useCallback(async (t: string, z: string | null) => {
    const n = ++seq.current;
    setChecking(true);
    setError(null);
    try {
      const r = await api.post<TokenCheck>("/api/cloudflare/check", { token: t, zoneId: z });
      if (n !== seq.current) return;
      setCheck(r);
      setZoneId((cur) => (cur && r.zones.some((x) => x.id === cur) ? cur : r.suggested));
    } catch (e) {
      if (n === seq.current) setError(e instanceof ApiError ? e.message : "Couldn't check the token.");
    } finally {
      if (n === seq.current) setChecking(false);
    }
  }, []);

  React.useEffect(() => {
    if (!needsToken) return;
    const t = token.trim();
    if (t.length < 20) {
      seq.current++;
      setCheck(null);
      setChecking(false);
      return;
    }
    const timer = setTimeout(() => void runCheck(t, zoneId), 450);
    return () => clearTimeout(timer);
    // Re-check when the token changes; a different domain is re-checked through onZone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, needsToken, runCheck]);

  // Moving domains: the server checks the saved token and lists what it can see.
  React.useEffect(() => {
    if (needsToken || !open) return;
    const n = ++seq.current;
    setChecking(true);
    api
      .post<TokenCheck>("/api/cloudflare/check", { saved: true })
      .then((r) => {
        if (n !== seq.current) return;
        setCheck(r);
        setZoneId((cur) => cur ?? r.zones.find((z) => z.id !== current.zone?.id)?.id ?? null);
      })
      .catch((e) => n === seq.current && setError(e instanceof ApiError ? e.message : "Couldn't list the token's domains."))
      .finally(() => n === seq.current && setChecking(false));
  }, [needsToken, open, current.zone?.id]);

  const zoneList = check?.zones ?? [];
  const onZone = (z: string) => {
    setZoneId(z);
    if (token.trim().length >= 20) void runCheck(token.trim(), z);
  };

  async function save() {
    if (!zoneId) return;
    setSaving(true);
    setError(null);
    try {
      const s = await api.post<CloudflareStatus>("/api/cloudflare", { token: needsToken ? token.trim() : undefined, zoneId });
      onConnected(s);
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_cancelled") return;
      setError(e instanceof ApiError ? e.message : "Couldn't connect.");
    } finally {
      setSaving(false);
    }
  }

  // Moving domains is checked again on save; the checks shown are for the pasted token.
  const ready = !!zoneId && check?.ok === true && (needsToken ? check.dnsEdit === true : zoneId !== current.zone?.id);
  const zone = zoneList.find((z) => z.id === zoneId) ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={mode === "token" ? "Replace Cloudflare token" : mode === "zone" ? "Use another domain" : "Connect Cloudflare"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!ready || checking} onClick={() => void save()}>
            {mode === "new" ? "Connect" : "Save"}
          </Button>
        </>
      }
    >
      <form
        className={c.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void save();
        }}
      >
        {needsToken && (
          <>
            <div className={c.make}>
              <div className={c.makeHead}>
                <span>Make a token with these permissions</span>
                <a className={c.external} href={TOKENS_URL} target="_blank" rel="noreferrer">
                  Open Cloudflare <OpenNewWindow aria-hidden />
                </a>
              </div>
              <ul className={c.perms}>
                {PERMISSIONS.map(([scope, what, level, required]) => (
                  <li key={what} className={c.perm} data-optional={required ? undefined : ""}>
                    <span>{scope}</span>
                    <span>{what}</span>
                    <span>{level}</span>
                    <span className={c.permNote}>{required ? "" : "for the tunnel"}</span>
                  </li>
                ))}
              </ul>
            </div>
            <Field label="API token" error={check && !check.ok ? check.message : null}>
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste it here"
                autoComplete="off"
                spellCheck={false}
                mono
                autoFocus
              />
            </Field>
          </>
        )}

        {checking && !check && (
          <p className={c.checking} aria-live="polite">
            <StateLine state="starting" size={11} /> Checking the token…
          </p>
        )}

        {check?.ok && (
          <ul className={c.checks} aria-live="polite">
            <li className={c.check} data-motion-gentle="" style={{ "--i": 0 } as React.CSSProperties}>
              {zoneList.length > 1 ? (
                <Field label="Domain" description={current.baseDomain && zone && !(current.baseDomain === zone.name || current.baseDomain.endsWith(`.${zone.name}`)) ? `Your public addresses are under ${current.baseDomain}, which isn't in this domain.` : undefined}>
                  <Select aria-label="Domain" value={zoneId ?? ""} onChange={onZone} options={zoneList.map((z) => ({ value: z.id, label: z.name }))} placeholder="Pick a domain" />
                </Field>
              ) : (
                <>
                  <StateLine state="running" size={11} />
                  <span>
                    Can see <b>{zone?.name}</b>
                  </span>
                </>
              )}
            </li>
            {needsToken && check.dnsEdit !== null && (
              <li className={c.check} data-motion-gentle="" style={{ "--i": 1 } as React.CSSProperties}>
                <StateLine state={check.dnsEdit ? "running" : "unhealthy"} size={11} />
                <span>{check.dnsEdit ? "Can change DNS" : "Can't change DNS. Add Zone · DNS · Edit to the token."}</span>
              </li>
            )}
            {needsToken && check.tunnels !== null && (
              <li className={c.check} data-motion-gentle="" style={{ "--i": 2 } as React.CSSProperties}>
                <StateLine state={check.tunnels ? "running" : "stopped"} size={11} />
                <span>{check.tunnels ? "Can run a tunnel" : "No tunnel. Add Account · Cloudflare Tunnel · Edit to use one."}</span>
              </li>
            )}
          </ul>
        )}

        {error && <Notice tone="fault">{error}</Notice>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
