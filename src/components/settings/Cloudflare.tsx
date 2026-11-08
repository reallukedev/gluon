"use client";
import * as React from "react";
import { MoreHoriz, OpenNewWindow, Refresh, Trash, KeyBack, Globe, Plus } from "iconoir-react";
import { api, ApiError, useApi } from "@/lib/client/api";
import { AppIcon } from "@/components/apps/AppIcon";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { Field, Input, SettingRow, Switch } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { Select } from "@/components/ui/Select";
import { StateLine, type LineState } from "@/components/ui/StateLine";
import { Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { edgeCovered, type CloudflareStatus, type DdnsHandoff, type DnsRecordT, type HandoffReason, type ManagedName, type TokenCheck } from "@/lib/cloudflare-types";
import c from "./cloudflare.module.css";

export const CLOUDFLARE_ICON = "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/cloudflare.svg";
const TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

/** The panel's summary line, also used by the section header. */
export function cloudflareSummary(cf: CloudflareStatus | undefined): string | null {
  if (!cf?.connected || !cf.zone) return null;
  const s = cf.sync;
  if (s.problems.length || s.names.some((n) => n.state === "conflict" || n.state === "error")) return "Cloudflare needs a look.";
  return `Cloudflare keeps ${cf.zone.name} pointed here.`;
}

export function useCloudflare(enabled = true) {
  // While a check is running, look again sooner.
  const [fast, setFast] = React.useState(false);
  const res = useApi<CloudflareStatus>(enabled ? "/api/cloudflare" : null, { refresh: fast ? 3_000 : 60_000 });
  const running = !!res.data?.sync.running;
  React.useEffect(() => setFast(running), [running]);
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
  const [busy, setBusy] = React.useState<null | string>(null);
  const [adding, setAdding] = React.useState(0);
  const [addOpen, setAddOpen] = React.useState(false);
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
            <span className={c.line}>DNS records for every public address, kept on this network&rsquo;s address, from one API token.</span>
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
  const handoff = data.handoff;
  const errors = sync.names.filter((n) => n.state === "error");
  const live = sync.names.filter((n) => n.want.length > 0);
  const direct = live.filter((n) => n.want.some((w) => !w.proxied) && n.name !== zone.name);
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
            : { state: "running", text: `${live.length === 1 ? "1 name points" : `${live.length} names point`} at ${sync.ipv4 ?? "this network"}${data.proxied ? `, ${direct.length ? `all but ${direct.length === 1 ? direct[0]!.name : `${direct.length}`} through Cloudflare` : "all through Cloudflare"}` : ""}.` };

  function toggleProxy(on: boolean) {
    const go = () => run("proxied", () => api.patch<CloudflareStatus>("/api/cloudflare", { proxied: on }), () => (on ? "Web addresses go through Cloudflare" : "Web addresses go straight here"));
    if (on) return void go();
    confirm({
      title: "Stop proxying through Cloudflare?",
      consequences: [`Names under ${zone.name} point straight at ${sync.ipv4 ?? "this network's address"}, so anyone can see it.`, `${zone.name} itself stays proxied.`],
      confirmLabel: "Stop proxying",
      onConfirm: go,
    });
  }

  function takeOver(h: DdnsHandoff) {
    const go = () =>
      run("takeover", () => api.post<CloudflareStatus>("/api/cloudflare/takeover"), (st) =>
        st.handoff?.safe ? (h.running ? `${h.container} can be stopped` : `Gluon keeps every name ${h.container} did`) : "Gluon took over what it could",
      );
    // While it runs, Gluon only gets ready; once it has stopped, Gluon starts writing straight away.
    if (h.running) return void go();
    confirm({
      title: `Take over from ${h.container}?`,
      consequences: [`Gluon starts updating ${h.names.length === 1 ? h.names[0]!.name : `its ${h.names.length} names`} now, and brings their records in line with its own settings.`],
      confirmLabel: "Take over",
      onConfirm: go,
    });
  }

  function unkeep(name: string) {
    confirm({
      title: `Stop keeping ${name}?`,
      consequences: ["Gluon removes its records from Cloudflare."],
      confirmLabel: "Stop keeping",
      variant: "danger",
      onConfirm: async () => {
        const st = await api.del<CloudflareStatus>(`/api/cloudflare/names?name=${encodeURIComponent(name)}`);
        void mutate(st, { revalidate: false });
        toast.success(`Gluon stopped keeping ${name}`);
      },
    });
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
            { label: "Change main domain", description: "The one that holds your base domain", icon: <Globe />, onSelect: () => setConnecting("zone") },
            "separator",
            { label: "Disconnect", icon: <Trash />, danger: true, onSelect: disconnect },
          ]}
        />
      }
    >
      <div className={c.head}>
        <AppIcon src={CLOUDFLARE_ICON} name="Cloudflare" size={32} />
        <div className={c.headText}>
          <span className={c.title}>
            <span className="truncate">{zone.name}</span>
            <span className={c.account}>
              {data.zones.length > 1 ? `and ${data.zones.length - 1} more domain${data.zones.length === 2 ? "" : "s"} · ` : ""}
              {zone.accountName}
            </span>
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

      {handoff && <Handoff h={handoff} busy={busy === "takeover"} onTakeOver={() => takeOver(handoff)} />}

      {data.network && (
        <div className={c.block}>
          <SettingRow label="Proxy through Cloudflare" description="Hides your home's address. Uploads stop at 100 MB and video streaming isn't allowed, so mark addresses like Jellyfin Direct on the Network page. Chat and voice always go direct.">
            <Switch checked={data.proxied} disabled={busy === "proxied"} onChange={toggleProxy} aria-label="Proxy through Cloudflare" />
          </SettingRow>
        </div>
      )}

      {sync.names.length > 0 && (
        <ul className={c.names} aria-label={`DNS records Gluon keeps in ${zone.name}`}>
          {sync.names.map((n) => (
            <NameRow
              key={n.name}
              n={n}
              waitingOn={handoff?.container ?? "cloudflare-ddns"}
              busy={busy === `adopt:${n.name}`}
              onAdopt={() => run(`adopt:${n.name}`, () => api.post("/api/cloudflare/adopt", { names: [n.name] }), () => `Gluon manages ${n.name}`)}
              onRemove={n.kept ? () => unkeep(n.name) : undefined}
            />
          ))}
        </ul>
      )}

      {data.network && (
        <div className={c.block}>
          <SettingRow label="Other names" description="Kept pointed here alongside your addresses, like play.example.com or *.mc.example.com.">
            <Button
              size="sm"
              icon={<Plus />}
              onClick={() => {
                setAdding((n) => n + 1);
                setAddOpen(true);
              }}
            >
              Add name
            </Button>
          </SettingRow>
        </div>
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
      <AddNameDialog
        key={`add-${adding}`}
        open={addOpen}
        cf={data}
        onClose={() => setAddOpen(false)}
        onAdded={(st, name) => {
          setAddOpen(false);
          void mutate(st, { revalidate: false });
          toast.success(`Gluon keeps ${name} pointed here`);
        }}
      />
      {confirmNode}
    </Panel>
  );
}

// ================================================================= cloudflare-ddns

const REASON: Record<Exclude<HandoffReason, "differs">, string> = {
  "not-kept": "Gluon doesn't keep it yet",
  foreign: "Its records aren't Gluon's yet",
  outside: "Gluon's token can't see this domain",
  "read-only": "Gluon's token can't change this domain's DNS",
  error: "Cloudflare refused Gluon's last change",
};

/** What stands between cloudflare-ddns and its removal; "can be stopped" only when nothing does. */
function Handoff({ h, busy, onTakeOver }: { h: DdnsHandoff; busy: boolean; onTakeOver: () => void }) {
  const waiting = h.names.filter((n) => n.reason && n.reason !== "differs");
  const differs = h.names.filter((n) => n.reason === "differs");
  const where = h.project ? `the ${h.project} compose project` : "its compose file";
  if (h.safe) {
    return (
      <div className={c.pad}>
        {h.running ? (
          <Notice title={`${h.container} can be stopped`}>
            Gluon keeps {h.names.length === 1 ? h.names[0]!.name : `all ${h.names.length} names it updates`}, with the same records, and takes over within a minute of it stopping. Remove it from {where}, or stop it from Apps.
          </Notice>
        ) : (
          <Notice title={`${h.container} is stopped`}>Gluon keeps {h.names.length === 1 ? h.names[0]!.name : `every name ${h.container} updated`}, so it can be removed from {where}.</Notice>
        )}
      </div>
    );
  }
  // Only differences left: stopping it works, but changes these records, so say what changes.
  if (!waiting.length && !h.deleteOnStop && !h.blocked) {
    return (
      <div className={c.pad}>
        <Notice title={`Stopping ${h.container} changes ${differs.length === 1 ? "a record" : `${differs.length} names`}`}>
          <ul className={c.handoff}>
            {differs.map((n) => (
              <li key={n.name}>
                <span className="mono">{n.name}</span>
                <span className={c.reason}>
                  {describe(n.have)} becomes {describe(n.want)}
                </span>
              </li>
            ))}
          </ul>
          {h.ipv6Differs && <p className={c.after}>Turn on IPv6 below to keep the IPv6 records.</p>}
        </Notice>
      </div>
    );
  }
  const title = waiting.length ? `${h.container} keeps ${waiting.length === 1 ? "a name" : `${waiting.length} names`} Gluon doesn't yet` : `Don't stop ${h.container} yet`;
  return (
    <div className={c.pad}>
      <Notice
        tone="attention"
        title={title}
        action={
          h.canTakeOver ? (
            <Button size="sm" variant="primary" loading={busy} onClick={onTakeOver}>
              Take over
            </Button>
          ) : undefined
        }
      >
        <ul className={c.handoff}>
          {waiting.map((n) => (
            <li key={n.name}>
              <span className="mono">{n.name}</span>
              <span className={c.reason}>{REASON[n.reason as Exclude<HandoffReason, "differs">]}</span>
            </li>
          ))}
          {h.deleteOnStop && (
            <li>
              <span>It deletes its records when it stops. Remove DELETE_ON_STOP from {where} and recreate it first.</span>
            </li>
          )}
          {h.blocked && (
            <li>
              <span>{h.blocked}</span>
            </li>
          )}
        </ul>
      </Notice>
    </div>
  );
}

// ================================================================= other names

function AddNameDialog({ open, cf, onClose, onAdded }: { open: boolean; cf: CloudflareStatus; onClose: () => void; onAdded: (s: CloudflareStatus, name: string) => void }) {
  const [name, setName] = React.useState("");
  const [proxied, setProxied] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const clean = name.trim().toLowerCase().replace(/\.$/, "");
  const bare = clean.replace(/^\*\./, "");
  const zone = cf.zones.filter((z) => bare === z.name || bare.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0] ?? null;
  // Cloudflare's free certificate only covers one level under the domain.
  const canProxy = !!zone && edgeCovered(clean.replace(/^\*\./, "x."), zone.name);

  async function save() {
    if (!clean) return;
    setSaving(true);
    setError(null);
    try {
      onAdded(await api.post<CloudflareStatus>("/api/cloudflare/names", { name: clean, proxied: proxied && canProxy }), clean);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't add it.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add name"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!clean} onClick={() => void save()}>
            Add
          </Button>
        </>
      }
    >
      <form
        className={c.form}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" error={error ?? (clean && !zone ? `Gluon's token can't see ${bare}'s domain.` : null)}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="play.example.com" autoComplete="off" spellCheck={false} mono autoFocus />
        </Field>
        {canProxy && (
          <SettingRow label="Proxy through Cloudflare" description="Only for websites. Games, chat and voice need it off.">
            <Switch checked={proxied} onChange={setProxied} aria-label="Proxy through Cloudflare" />
          </SettingRow>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function describe(r: DnsRecordT[]): string {
  if (!r.length) return "Nothing";
  if (r.some((x) => x.type === "CNAME" && x.content.endsWith(".cfargotunnel.com"))) return "Tunnel";
  return r.map((x) => (x.type === "CNAME" ? x.content : `${x.content}${x.proxied ? " via Cloudflare" : ""}`)).join(", ");
}

const NAME_STATE: Record<ManagedName["state"], LineState> = { ok: "running", changed: "running", conflict: "attention", error: "unhealthy", deferred: "paused" };

function NameRow({ n, busy, waitingOn, onAdopt, onRemove }: { n: ManagedName; busy: boolean; waitingOn: string; onAdopt: () => void; onRemove?: () => void }) {
  const removing = n.want.length === 0;
  const text =
    n.state === "conflict"
      ? `Has ${describe(n.have)}. Gluon would set ${describe(n.want)}.`
      : n.state === "error"
        ? (n.message ?? "Cloudflare refused the change.")
        : removing
          ? "Removed"
          : n.state === "deferred"
            ? describe(n.have.length ? n.have : n.want)
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
        {n.state === "deferred" && <span className={c.waiting}>{waitingOn} updates it for now</span>}
      </span>
      {n.state === "conflict" ? (
        <Button size="sm" loading={busy} onClick={onAdopt}>
          Let Gluon manage
        </Button>
      ) : onRemove ? (
        <IconButton label={`Stop keeping ${n.name}`} size="sm" onClick={onRemove}>
          <Trash />
        </IconButton>
      ) : null}
    </li>
  );
}

// ================================================================= connect

const PERMISSIONS: [string, string, string, boolean][] = [
  ["Zone", "DNS", "Edit", true],
  ["Zone", "Zone", "Read", true],
  ["Zone", "Zone Settings", "Read", false],
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
                    <span className={c.permNote}>{required ? "" : "to check SSL mode"}</span>
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
          </ul>
        )}

        {error && <Notice tone="fault">{error}</Notice>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
