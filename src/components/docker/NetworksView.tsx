"use client";
import * as React from "react";
import Link from "next/link";
import { MoreHoriz, Trash, NavArrowRight, Plus, Link as LinkIcon } from "iconoir-react";
import { api, useApi, ApiError } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Page, PageHeader, Empty } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { Field, Input, Segmented, SettingRow, Switch } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { StateLine } from "@/components/ui/StateLine";
import { CopyButton } from "@/components/ui/CopyButton";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import type { Attachable, DockerNetwork, NetworkMember, NetworksResponse } from "@/lib/docker-types";
import { AppsSectionTabs } from "./AppsSectionTabs";
import { FilterInput, LoadError, TableSkeleton, UsedBy, appHref, appWords, containerHref, firstError, isReauthCancel, useQueryParam, type InitialError } from "./shared";
import s from "./docker.module.css";

type Filter = "all" | "custom" | "empty";

const COLUMNS = "minmax(220px, 2fr) minmax(160px, 1.2fr) minmax(180px, 1.8fr) 68px";

function flags(n: DockerNetwork): string {
  const out = [n.driver === "bridge" ? "Bridge" : n.driver === "host" ? "The server's own network" : n.driver === "null" ? "No network" : n.driver];
  if (n.internal) out.push("no internet");
  if (n.attachable) out.push("others can join");
  if (n.ipv6) out.push("IPv6");
  return out.join(" · ");
}

function whose(n: DockerNetwork): string | null {
  if (n.builtin) return "Docker's own";
  if (n.app) return appWords(n.app);
  if (n.project) return `${n.project} stack`;
  return null;
}

export function NetworksView({ initial, initialError, initialQuery }: { initial: NetworksResponse | null; initialError: InitialError; initialQuery: string }) {
  const fmt = useFormat();
  const { data, error: liveError, mutate, isValidating } = useApi<NetworksResponse>("/api/docker/networks", { refresh: 20_000, fallbackData: initial ?? undefined });
  const error = liveError ?? firstError(data, initialError);
  const [q, setQ] = useQueryParam(initialQuery);
  const term = React.useDeferredValue(q.trim().toLowerCase());
  const [filter, setFilter] = React.useState<Filter>("all");
  const [open, setOpen] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [connectTo, setConnectTo] = React.useState<DockerNetwork | null>(null);
  const [confirm, confirmNode] = useConfirm();
  const networks = data?.networks;
  const candidates = data?.containers ?? [];

  const custom = (networks ?? []).filter((n) => !n.builtin);
  const empty = custom.filter((n) => !n.containers.length);
  const shown = (networks ?? []).filter((n) => {
    if (filter === "custom" && n.builtin) return false;
    if (filter === "empty" && (n.builtin || n.containers.length)) return false;
    if (!term) return true;
    return (
      n.name.toLowerCase().includes(term) ||
      n.subnets.some((x) => x.subnet.includes(term) || (x.gateway ?? "").includes(term)) ||
      n.containers.some((c) => c.name.toLowerCase().includes(term) || (c.ipv4 ?? "").includes(term) || (c.app?.name.toLowerCase().includes(term) ?? false)) ||
      (n.app?.name.toLowerCase().includes(term) ?? false)
    );
  });
  const connected = new Set((networks ?? []).flatMap((n) => n.containers.map((c) => c.id))).size;

  const summary = !networks ? (
    error ? "Gluon couldn't get the list from Docker." : "Asking Docker…"
  ) : (
    <>
      <b>
        {fmt.plural(custom.length, "network")} besides Docker&apos;s own, connecting {fmt.plural(connected, "container")}.
      </b>{" "}
      {empty.length ? `${empty.length === 1 ? "1 has" : `${empty.length} have`} nothing connected.` : ""}
    </>
  );

  async function remove(n: DockerNetwork, typed?: string) {
    try {
      const r = await api.del<{ message: string }>(`/api/docker/networks/${encodeURIComponent(n.id)}`, { confirm: typed });
      toast.success(r.message);
      setOpen((o) => (o === n.id ? null : o));
      void mutate();
    } catch (e) {
      if (!isReauthCancel(e)) throw e;
    }
  }

  function askRemove(n: DockerNetwork) {
    if (n.builtin || n.containers.length) return;
    confirm({
      title: `Remove the network ${n.name}?`,
      consequences: [
        ...(n.guard?.level === "warn" ? [<b key="g">{n.guard.message}</b>] : []),
        "Nothing is connected to it, so nothing loses its connection now.",
        n.project ? `If the ${n.project} stack starts again, Compose creates it again.` : "Apps whose Compose file names it as external won't start until it exists again.",
      ],
      confirmLabel: "Remove network",
      typeToConfirm: n.guard?.level === "warn" ? n.name : undefined,
      onConfirm: () => remove(n, n.guard?.level === "warn" ? n.name : undefined),
    });
  }

  function askDisconnect(n: DockerNetwork, c: NetworkMember) {
    const cand = candidates.find((x) => x.id === c.id);
    const last = (cand?.networks.length ?? 2) <= 1;
    confirm({
      title: `Disconnect ${c.name} from ${n.name}?`,
      consequences: [
        `${c.name} can no longer reach other containers on ${n.name}, and they can't reach it.`,
        ...(c.app ? [`${c.app.name} may stop working properly if its parts talk over this network.`] : []),
        ...(last ? [`It's ${c.name}'s only network: it'll have no network at all until it's connected again.`] : []),
        ...(n.project ? [`Recreating the ${n.project} stack connects it again.`] : []),
      ],
      confirmLabel: "Disconnect",
      onConfirm: async () => {
        try {
          const r = await api.post<{ message: string }>(`/api/docker/networks/${encodeURIComponent(n.id)}/disconnect`, { container: c.id });
          toast.success(r.message);
          void mutate();
        } catch (e) {
          if (!isReauthCancel(e)) throw e;
        }
      },
    });
  }

  const menuFor = (n: DockerNetwork): MenuEntry[] => [
    { label: "Connect a container…", icon: <LinkIcon />, disabled: n.driver === "host" || n.driver === "null", onSelect: () => setConnectTo(n) },
    "separator",
    {
      label: "Remove network…",
      icon: <Trash />,
      danger: true,
      disabled: n.builtin || !!n.containers.length,
      description: n.builtin ? "Docker's own networks stay" : n.containers.length ? "Disconnect its containers first" : undefined,
      onSelect: () => askRemove(n),
    },
  ];

  return (
    <Page>
      <AppsSectionTabs current="networks" />
      <PageHeader
        title="Networks"
        summary={summary}
        actions={
          <Button icon={<Plus />} onClick={() => setCreating(true)}>
            Create network
          </Button>
        }
      />

      {error && (
        <div style={{ marginBottom: 16 }}>
          <LoadError error={error} what="networks" onRetry={() => void mutate()} retrying={isValidating} />
        </div>
      )}

      {networks && networks.length > 0 && (
        <div className={s.toolbar}>
          <FilterInput value={q} onChange={setQ} placeholder="Filter by name, address or container" label="Filter networks" />
          <Segmented
            aria-label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "custom", label: "Not Docker's own" },
              { value: "empty", label: empty.length ? `Empty ${empty.length}` : "Empty" },
            ]}
          />
        </div>
      )}

      {!networks ? (
        error ? null : <TableSkeleton columns={COLUMNS} />
      ) : shown.length === 0 ? (
        <Empty title={term ? `Nothing matches “${q.trim()}”` : filter === "empty" ? "Every network has something connected" : "Only Docker's own networks"}>
          {term ? "Try a network name, an address like 172.20, or a container." : filter === "empty" ? "There's nothing to tidy up here." : "Compose creates a network for each stack; you can also create one to let containers from different stacks reach each other by name."}
        </Empty>
      ) : (
        <div className={`${s.table} ${s.networks}`} role="table" aria-label="Networks" aria-rowcount={shown.length + 1}>
          <div className={s.headRow} role="row">
            <span role="columnheader">Network</span>
            <span role="columnheader">Addresses</span>
            <span role="columnheader">Connected</span>
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {shown.map((n) => {
            const isOpen = open === n.id;
            const who = whose(n);
            return (
              <div key={n.id} className={s.group} data-open={isOpen ? "" : undefined} role="rowgroup">
                <div
                  role="row"
                  className={s.row}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a,button,[role=menu]")) return;
                    setOpen(isOpen ? null : n.id);
                  }}
                >
                  <span role="cell" className={s.nameCell}>
                    <button type="button" className={s.nameButton} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : n.id)}>
                      <NavArrowRight className={s.chevron} strokeWidth={2} aria-hidden />
                      <span className={s.name} title={n.name}>
                        {n.name}
                      </span>
                    </button>
                    <span className={s.sub}>
                      {flags(n)}
                      {who ? ` · ${who}` : ""}
                    </span>
                  </span>
                  <span role="cell" className={s.subnetCell}>
                    {n.subnets.length ? (
                      <>
                        <span className={s.monoWrap}>{n.subnets.map((x) => x.subnet).join(", ")}</span>
                        {n.subnets[0]?.gateway && <span>gateway <span className="mono">{n.subnets[0].gateway}</span></span>}
                      </>
                    ) : (
                      <span className={s.faint}>{n.driver === "host" ? "The server's addresses" : "None"}</span>
                    )}
                  </span>
                  <span role="cell" className={s.useCol}>
                    <UsedBy refs={n.containers} empty={n.driver === "null" ? "–" : "Nothing connected"} note={n.containers.length > 1 ? fmt.plural(n.containers.length, "container") : null} />
                  </span>
                  <span role="cell" className={s.actions}>
                    <Menu
                      trigger={
                        <IconButton label={`${n.name} actions`} size="sm">
                          <MoreHoriz />
                        </IconButton>
                      }
                      items={menuFor(n)}
                    />
                  </span>
                </div>
                {isOpen && <NetworkDetail network={n} onRemove={() => askRemove(n)} onConnect={() => setConnectTo(n)} onDisconnect={(c) => askDisconnect(n, c)} />}
              </div>
            );
          })}
        </div>
      )}

      <CreateNetworkDialog open={creating} onClose={() => setCreating(false)} onCreated={() => void mutate()} />
      <ConnectDialog network={connectTo} candidates={candidates} onClose={() => setConnectTo(null)} onDone={() => void mutate()} />
      {confirmNode}
    </Page>
  );
}

function NetworkDetail({ network: n, onRemove, onConnect, onDisconnect }: { network: DockerNetwork; onRemove: () => void; onConnect: () => void; onDisconnect: (c: NetworkMember) => void }) {
  const fmt = useFormat();
  const canConnect = n.driver !== "host" && n.driver !== "null";
  return (
    <div className={`${s.detail} appear`} role="region" aria-label={`${n.name} details`}>
      <div className={s.detailGrid}>
        <dl className={s.kv}>
          <dt>ID</dt>
          <dd>
            <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span className={s.monoWrap}>{n.short}</span>
              <CopyButton value={n.id} label="Copy network ID" />
            </span>
          </dd>
          <dt>Kind</dt>
          <dd>
            {n.driver === "bridge" ? "Bridge: containers on it reach each other by name, and the internet through the server" : n.driver === "host" ? "Containers here use the server's own network directly" : n.driver === "null" ? "Containers here have no network" : n.driver}
            {n.scope !== "local" ? ` (${n.scope})` : ""}
          </dd>
          {n.subnets.map((x) => (
            <React.Fragment key={x.subnet}>
              <dt>Range</dt>
              <dd>
                <span className="mono">{x.subnet}</span>
                {x.gateway && (
                  <span className={s.faint}>
                    {" "}
                    · gateway <span className="mono">{x.gateway}</span>
                  </span>
                )}
              </dd>
            </React.Fragment>
          ))}
          <dt>Internet</dt>
          <dd>{n.internal ? "No: it's internal, containers only reach each other" : n.driver === "null" ? "No" : "Yes"}</dd>
          <dt>Joining</dt>
          <dd>{n.attachable ? "Any container can be connected" : n.builtin ? "Set when a container is created" : "Containers can be connected here; standalone ones started with docker run too"}</dd>
          {n.created && (
            <>
              <dt>Created</dt>
              <dd>
                <Time ts={n.created} kind="dateTime" />
              </dd>
            </>
          )}
          {n.app && (
            <>
              <dt>App</dt>
              <dd>
                <Link href={appHref(n.app)}>{appWords(n.app)}</Link>
              </dd>
            </>
          )}
        </dl>
        <div>
          <p className={s.detailHead}>{n.containers.length ? `${fmt.plural(n.containers.length, "container")} connected` : "Nothing connected"}</p>
          {n.containers.length > 0 && (
            <ul className={s.ctrList}>
              {n.containers.map((c) => (
                <li key={c.id}>
                  <span className={s.ctrMain}>
                    <StateLine state={c.line} size={13} />
                    <Link href={containerHref(c)} className="mono">
                      {c.name}
                    </Link>
                    {(c.ipv4 || c.ipv6) && (
                      <span className={`${s.ctrMeta} mono`}>
                        {c.ipv4}
                        {c.ipv4 && c.ipv6 ? " · " : ""}
                        {c.ipv6}
                      </span>
                    )}
                    {!c.ipv4 && !c.ipv6 && n.driver !== "host" && <span className={s.ctrMeta}>{c.state === "running" ? "No address" : "Gets an address when it starts"}</span>}
                  </span>
                  <span className={s.ctrEnd}>
                    {c.app && <Link href={appHref(c.app)}>{c.app.name}</Link>}
                    {(!n.builtin || n.name === "bridge") && !c.primary && !c.self && !c.platform ? (
                      <Button size="sm" variant="ghost" onClick={() => onDisconnect(c)} aria-label={`Disconnect ${c.name}`}>
                        Disconnect
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className={s.detailActions}>
            {canConnect && (
              <Button size="sm" icon={<LinkIcon />} onClick={onConnect}>
                Connect a container…
              </Button>
            )}
            {!n.builtin && (
              <Button size="sm" variant="danger" icon={<Trash />} disabled={!!n.containers.length} onClick={onRemove}>
                Remove network…
              </Button>
            )}
          </div>
          {n.containers.some((c) => c.primary) && (
            <p className={s.below}>
              Containers created on this network stay on it: their published ports go through it. Change that in their app&apos;s Compose file.
            </p>
          )}
          {n.builtin ? <p className={s.below}>One of Docker&apos;s own networks. It&apos;s always there.</p> : n.containers.length ? <p className={s.below}>Remove it once nothing is connected.</p> : null}
        </div>
      </div>
    </div>
  );
}

function CreateNetworkDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = React.useState("");
  const [subnet, setSubnet] = React.useState("");
  const [gateway, setGateway] = React.useState("");
  const [internal, setInternal] = React.useState(false);
  const [attachable, setAttachable] = React.useState(true);
  const [err, setErr] = React.useState<{ field?: string; message: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setName("");
      setSubnet("");
      setGateway("");
      setInternal(false);
      setAttachable(true);
      setErr(null);
    }
  }, [open]);
  async function create(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ message: string }>("/api/docker/networks", { name, subnet: subnet || null, gateway: gateway || null, internal, attachable });
      toast.success(r.message);
      onCreated();
      onClose();
    } catch (x) {
      setErr({ field: x instanceof ApiError ? x.field : undefined, message: x instanceof Error ? x.message : "That didn't work." });
    } finally {
      setBusy(false);
    }
  }
  const fieldErr = (f: string) => (err && (err.field === f || (!err.field && f === "name")) ? err.message : null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Create a network"
      description="A bridge network: containers on it reach each other by name. Use it to let apps from different stacks talk."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void create()}>
            Create network
          </Button>
        </>
      }
    >
      <form onSubmit={create} className={s.form}>
        <Field label="Name" error={fieldErr("name")}>
          <Input mono value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="media" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={63} />
        </Field>
        <div className={s.formRow}>
          <Field label="Address range" optional error={fieldErr("subnet")} description="Leave empty and Docker picks a free one.">
            <Input mono value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="172.40.0.0/24" autoComplete="off" spellCheck={false} maxLength={40} />
          </Field>
          <Field label="Gateway" optional error={fieldErr("gateway")} description="Inside the range.">
            <Input mono value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="172.40.0.1" autoComplete="off" spellCheck={false} maxLength={40} disabled={!subnet.trim()} />
          </Field>
        </div>
        <SettingRow label="Internal only" description="Containers on it can't reach the internet, only each other.">
          <Switch checked={internal} onChange={setInternal} aria-label="Internal only" />
        </SettingRow>
        <SettingRow label="Others can join" description="Standalone containers (docker run) can be connected too, not only Compose ones.">
          <Switch checked={attachable} onChange={setAttachable} aria-label="Others can join" />
        </SettingRow>
      </form>
    </Dialog>
  );
}

function ConnectDialog({ network, candidates, onClose, onDone }: { network: DockerNetwork | null; candidates: Attachable[]; onClose: () => void; onDone: () => void }) {
  const [container, setContainer] = React.useState("");
  const [ip, setIp] = React.useState("");
  const [err, setErr] = React.useState<{ field?: string; message: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const open = !!network;
  const options = React.useMemo(
    () =>
      network
        ? candidates
            .filter((c) => !network.containers.some((m) => m.id === c.id) && !c.self)
            .map((c) => ({ value: c.id, label: c.app && c.app.name.toLowerCase() !== c.name.toLowerCase() ? `${c.name} · ${c.app.name}` : c.name, description: c.state === "running" ? undefined : "Stopped" }))
        : [],
    [network, candidates],
  );
  React.useEffect(() => {
    if (open) {
      setContainer("");
      setIp("");
      setErr(null);
    }
  }, [open]);
  const chosen = candidates.find((c) => c.id === container);
  async function connect(e?: React.FormEvent) {
    e?.preventDefault();
    if (!network) return;
    if (!container) {
      setErr({ field: "container", message: "Choose a container." });
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ message: string }>(`/api/docker/networks/${encodeURIComponent(network.id)}/connect`, { container, ip: ip || null });
      toast.success(r.message);
      onDone();
      onClose();
    } catch (x) {
      setErr({ field: x instanceof ApiError ? x.field : undefined, message: x instanceof Error ? x.message : "That didn't work." });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={network ? `Connect a container to ${network.name}` : "Connect a container"}
      description="It keeps its other networks. Containers on the server's own network (host mode) can't join others, so they aren't listed."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!options.length} onClick={() => void connect()}>
            Connect
          </Button>
        </>
      }
    >
      {options.length === 0 ? (
        <p className={s.resultLine}>Every container that can join a network is already on this one.</p>
      ) : (
        <form onSubmit={connect} className={s.form}>
          <Field label="Container" error={err?.field === "container" || (!err?.field && err) ? err.message : null} description={chosen?.platform ? "Part of Umbrel. Umbrel may undo network changes when it restarts the app." : chosen?.app?.source === "casaos" || chosen?.app?.source === "umbrel" ? `${chosen.app.name}'s installer may undo this when it recreates the container.` : undefined}>
            <Select aria-label="Container" value={container} onChange={setContainer} options={options} placeholder="Choose a container" />
          </Field>
          {network && network.subnets.length > 0 && (
            <Field label="Fixed address" optional error={err?.field === "ip" ? err.message : null} description={`Inside ${network.subnets[0]!.subnet}. Leave empty and Docker picks one.`}>
              <Input mono value={ip} onChange={(e) => setIp(e.target.value)} placeholder="Automatic" autoComplete="off" spellCheck={false} maxLength={40} />
            </Field>
          )}
        </form>
      )}
    </Dialog>
  );
}
