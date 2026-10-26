"use client";
import * as React from "react";
import { MoreHoriz, Refresh } from "iconoir-react";
import type { GamePort, GamesStatus, McChangeResult, McDefault, McRoute } from "@/lib/games-types";
import type { RouterStatus } from "@/lib/router-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { Button, IconButton, LinkButton } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { useConfirm } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { Empty, Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { AddressDialog } from "./games/AddressDialog";
import { FallbackDialog } from "./games/FallbackDialog";
import { GamePortDialog } from "./games/GamePortDialog";
import { RoutesHistory } from "./games/RoutesHistory";
import { dnsProblem, forwarding, GAMES_URL, leadSentence, playersLine, protoText, rangeText, ROUTER_URL, targetName, type Forwarding } from "./games/model";
import s from "./games.module.css";

type Open = { kind: "address"; edit: McRoute | null } | { kind: "fallback" } | { kind: "port"; edit: GamePort | null } | { kind: "history" } | null;

const quiet = (e: unknown) => e instanceof ApiError && e.code === "reauth_cancelled";
const FILTER_FROM = 9;

/**
 * Network → Game servers. Minecraft Java servers share port 25565 through mc-router, which sends
 * each player to a server by the address they typed; this lists those addresses, checks each one
 * the way a player's server list does, and edits mc-router's routes file. Other games get a port
 * of their own, which the router's Port forwarding panel then forwards.
 */
export function GameServers() {
  const { data, error, mutate } = useApi<GamesStatus>(GAMES_URL, { refresh: 60_000 });
  const router = useApi<RouterStatus>(ROUTER_URL, { refresh: 120_000 });
  const [open, setOpen] = React.useState<Open>(null);
  const [checking, setChecking] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();

  async function check() {
    setChecking(true);
    try {
      await mutate(await api.post<GamesStatus>(`${GAMES_URL}/check`), { revalidate: false });
    } catch (e) {
      toast.error("Couldn't check the game servers", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setChecking(false);
    }
  }

  async function undo(id: number) {
    try {
      const r = await api.post<McChangeResult>(`${GAMES_URL}/minecraft/history`, { id });
      await mutate(r.status, { revalidate: false });
      toast.success("Put back the way it was");
    } catch (e) {
      if (!quiet(e)) toast.error("Couldn't undo that", { description: e instanceof Error ? e.message : undefined });
    }
  }

  /** After a change to mc-router's file: what it answers now, and a way back. */
  function changed(r: McChangeResult, title: string) {
    void mutate(r.status, { revalidate: false });
    void router.mutate();
    const action = r.undo ? { label: "Undo", onClick: () => void undo(r.undo!) } : undefined;
    const p = r.check?.ping;
    if (!r.applied) toast.attention(title, { description: r.note ?? "mc-router hasn't picked it up yet.", action, timeout: 12_000 });
    else if (r.check && p?.ok) toast.success(title, { description: `It answers: ${[p.version, p.motd?.split("\n")[0]].filter(Boolean).join(", ")}.`, action, timeout: 8000 });
    else if (r.check) toast.attention(title, { description: "Nothing answers there yet. If the server is stopped, start it in Crafty, then check again.", action, timeout: 12_000 });
    else toast.success(title, { action, timeout: 8000 });
  }

  const remove = (route: McRoute, st: GamesStatus) =>
    confirm({
      title: `Remove ${route.host}?`,
      consequences: [
        st.fallback ? `Players who use it reach ${targetName(st.fallback.target, st.fallback.backend).name} instead.` : "Players who use it can't connect any more.",
        "Gluon keeps the file as it was, so you can put it back.",
      ],
      confirmLabel: "Remove address",
      variant: "danger",
      onConfirm: async () => {
        try {
          changed(await api.del<McChangeResult>(`${GAMES_URL}/minecraft`, { host: route.host, rev: st.mcRouter.rev }), `Removed ${route.host}`);
        } catch (e) {
          if (!quiet(e)) throw e;
        }
      },
    });

  const removePort = (p: GamePort) => {
    const need = router.data?.needs.find((n) => n.need.key === p.needKey);
    const ours = need?.status === "forwarded" && need.ours;
    return confirm({
      title: `Remove ${p.name}?`,
      consequences: [
        ours ? `Gluon also stops forwarding ${protoText(p.protocol)} ${rangeText(p.publicMin, p.publicMin + p.hostMax - p.hostMin)} on your router.` : need?.status === "forwarded" ? "The forward on your router stays. Remove it there if nothing else needs it." : "Nothing changes on your router.",
        "The game itself keeps running.",
      ],
      confirmLabel: "Remove game port",
      variant: "danger",
      onConfirm: async () => {
        try {
          // The router forward first: once the entry is gone, Gluon no longer knows it needs it.
          if (ours) await router.mutate(await api.del<RouterStatus>(ROUTER_URL, { key: p.needKey }), { revalidate: false });
          await mutate(await api.del<GamesStatus>(`${GAMES_URL}/ports/${p.id}`), { revalidate: false });
          void router.mutate();
          toast.success(`Removed ${p.name}`);
        } catch (e) {
          if (!quiet(e)) throw e;
        }
      },
    });
  };

  const reload = async () => {
    try {
      changed(await api.put<McChangeResult>(`${GAMES_URL}/minecraft`, { reload: true }), "mc-router read its routes again");
    } catch (e) {
      if (!quiet(e)) toast.error("Couldn't reload mc-router", { description: e instanceof Error ? e.message : undefined });
    }
  };

  const fwd = (key: string) => forwarding(router.data, key, !!router.error);

  return (
    <Panel
      id="game-servers"
      title="Game servers"
      meta={
        data ? (
          <span className={s.meta}>
            {data.checkedAt && (
              <span className={s.checked}>
                Checked <Time ts={data.checkedAt} />
              </span>
            )}
            <IconButton label="Check again" size="sm" loading={checking} onClick={() => void check()}>
              <Refresh />
            </IconButton>
            {data.mcRouter.status !== "missing" && (
              <Menu
                trigger={
                  <IconButton label="More" size="sm">
                    <MoreHoriz />
                  </IconButton>
                }
                items={[
                  { label: "Earlier versions", description: "Of mc-router's routes file", onSelect: () => setOpen({ kind: "history" }), disabled: !data.mcRouter.file },
                  { label: "Reload mc-router", description: "After you edit its file by hand", onSelect: () => void reload(), disabled: data.mcRouter.status !== "running" },
                ]}
              />
            )}
          </span>
        ) : undefined
      }
      flush
    >
      {!data ? (
        <div className={s.pad}>
          {error ? (
            <Notice tone="fault" title="Couldn't look at the game servers" action={<Button size="sm" onClick={() => void mutate()}>Try again</Button>}>
              {error.message}
            </Notice>
          ) : (
            <div className={s.skeleton} aria-busy="true" aria-label="Loading game servers">
              <Skeleton height={14} width="55%" />
              <Skeleton height={52} radius={8} />
              <Skeleton height={52} radius={8} />
            </div>
          )}
        </div>
      ) : (
        <>
          {leadSentence(data) && <p className={s.lead}>{leadSentence(data)}</p>}
          <Minecraft st={data} fwd={fwd(data.javaNeedKey)} onAdd={() => setOpen({ kind: "address", edit: null })} onEdit={(r) => setOpen({ kind: "address", edit: r })} onRemove={(r) => remove(r, data)} onFallback={() => setOpen({ kind: "fallback" })} onHistory={() => setOpen({ kind: "history" })} />
          <OtherGames st={data} fwd={fwd} onAdd={() => setOpen({ kind: "port", edit: null })} onEdit={(p) => setOpen({ kind: "port", edit: p })} onRemove={removePort} />
          <AddressDialog open={open?.kind === "address"} onOpenChange={(o) => !o && setOpen(null)} st={data} edit={open?.kind === "address" ? open.edit : null} onDone={(r, verb) => changed(r, verb === "added" ? `Added ${r.check?.host ?? "the address"}` : `Saved ${r.check?.host ?? "the address"}`)} />
          <FallbackDialog open={open?.kind === "fallback"} onOpenChange={(o) => !o && setOpen(null)} st={data} onDone={(r) => changed(r, r.status.fallback ? `Other addresses reach ${targetName(r.status.fallback.target, r.status.fallback.backend).name}` : "Other addresses are turned away")} />
          <GamePortDialog
            open={open?.kind === "port"}
            onOpenChange={(o) => !o && setOpen(null)}
            st={data}
            edit={open?.kind === "port" ? open.edit : null}
            onDone={(next, name) => {
              void mutate(next, { revalidate: false });
              void router.mutate();
              toast.success(open?.kind === "port" && open.edit ? `Saved ${name}` : `Added ${name}`, { description: "It's in Port forwarding now." });
            }}
          />
          <RoutesHistory open={open?.kind === "history"} onOpenChange={(o) => !o && setOpen(null)} file={data.mcRouter.file} onRestored={(r) => changed(r, "Put back the earlier version")} />
        </>
      )}
      {confirmNode}
    </Panel>
  );
}

// ------------------------------------------------------------------ Minecraft Java

function Minecraft({ st, fwd, onAdd, onEdit, onRemove, onFallback, onHistory }: { st: GamesStatus; fwd: Forwarding; onAdd: () => void; onEdit: (r: McRoute) => void; onRemove: (r: McRoute) => void; onFallback: () => void; onHistory: () => void }) {
  const r = st.mcRouter;
  const [q, setQ] = React.useState("");
  const shown = q.trim() ? st.routes.filter((x) => `${x.host} ${x.backend} ${targetName(x.target, x.backend).name}`.toLowerCase().includes(q.trim().toLowerCase())) : st.routes;
  const canEdit = r.editable && r.status !== "missing";
  // A column of icons only when some server sends one; otherwise names line up on the left.
  const icons = st.routes.some((x) => x.ping?.favicon) || !!st.fallback?.ping?.favicon;

  return (
    <section className={s.section} aria-labelledby="games-java">
      <div className={s.subhead}>
        <h3 id="games-java" className={s.subTitle}>
          Minecraft Java
        </h3>
        {r.status === "missing" && <span className={s.subMeta}>mc-router not installed</span>}
        {r.status !== "missing" && <span className={s.subMeta}>{r.container}{r.version ? ` ${r.version}` : ""}{r.hostPort ? `, port ${r.hostPort}` : ""}</span>}
        {canEdit && st.routes.length > 0 && (
          <Button size="sm" className={s.subAction} onClick={onAdd}>
            Add an address
          </Button>
        )}
      </div>

      {r.status === "missing" ? (
        <div className={s.emptyLine}>
          <p>
            Run <span className="mono">itzg/mc-router</span> with a routes file on this server to give each Java server its own name on port 25565.
          </p>
        </div>
      ) : (
        <>
          {r.status === "stopped" && (
            <div className={s.pad}>
              <Notice tone="fault" title="mc-router is stopped" action={<LinkButton size="sm" href="/apps">Open Apps</LinkButton>}>
                Nobody can join until {r.container} runs again. The addresses below are what it loads when it starts.
              </Notice>
            </div>
          )}
          {r.broken ? (
            <div className={s.pad}>
              <Notice tone="fault" title="The routes file has a mistake" action={<Button size="sm" onClick={onHistory}>Earlier versions</Button>}>
                <p className={s.noticeText}>
                  {r.broken.message} mc-router keeps what it last loaded. Fix <span className="mono">{r.file}</span> by hand or put back an earlier version; Gluon won&rsquo;t write over it.
                </p>
                {r.broken.excerpt && <pre className={s.excerpt}>{r.broken.excerpt}</pre>}
              </Notice>
            </div>
          ) : (
            !r.editable &&
            r.reason && (
              <div className={s.pad}>
                <Notice>{r.reason}</Notice>
              </div>
            )
          )}
          {!r.broken &&
            (st.routes.length === 0 ? (
              <div className={s.emptyWrap}>
                <Empty title="No addresses yet" action={canEdit ? <Button size="sm" onClick={onAdd}>Add an address</Button> : undefined}>
                  Give each server its own address{st.domain ? `, like survival.${st.domain}` : ""}. Players type it in Multiplayer, and mc-router sends them to that server.
                </Empty>
              </div>
            ) : (
              <>
                {st.routes.length >= FILTER_FROM && (
                  <div className={s.filter}>
                    <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an address or server…" aria-label="Find an address or server" type="search" name="find" />
                  </div>
                )}
                <ul className={s.list} aria-label="Minecraft addresses">
                  {shown.map((x) => (
                    <RouteRow key={x.host} route={x} canEdit={canEdit} icons={icons} onEdit={() => onEdit(x)} onRemove={() => onRemove(x)} />
                  ))}
                  {shown.length === 0 && <li className={s.none}>No address matches &ldquo;{q.trim()}&rdquo;.</li>}
                  {!q.trim() && <FallbackRow fallback={st.fallback} canEdit={canEdit} icons={icons} onChange={onFallback} />}
                </ul>
              </>
            ))}
          <div className={s.forward}>
            <span className={s.forwardWhat}>
              From the internet <span className="mono">TCP 25565</span>
            </span>
            <ForwardState f={fwd} />
          </div>
        </>
      )}
    </section>
  );
}

function ServerCell({ target, backend, ping, icons }: { target: McRoute["target"]; backend: string; ping: McRoute["ping"]; icons: boolean }) {
  const t = targetName(target, backend);
  return (
    <span className={s.server}>
      {icons && (ping?.favicon ? <img className={s.icon} src={ping.favicon} alt="" width={20} height={20} /> : <span className={s.icon} aria-hidden />)}
      <span className={s.stack}>
        <span className={s.name}>{t.name}</span>
        <span className={`${s.sub} ${target.kind === "crafty" ? "" : "mono"}`}>{t.sub}</span>
      </span>
    </span>
  );
}

function PingCell({ state, summary, ping, name }: { state: McRoute["state"]; summary: string; ping: McRoute["ping"]; name: string }) {
  // The MOTD shows which server really answered; it adds nothing when it's the name again.
  const motd = ping?.ok ? ping.motd?.split("\n")[0] : null;
  const extra = [motd && motd.toLowerCase() !== name.toLowerCase() ? motd : null, playersLine(ping)].filter(Boolean).join(" · ");
  return (
    <span className={`${s.stack} ${s.ping}`}>
      <StateLine state={state} label={summary} />
      {extra && <span className={`${s.sub} ${s.indent}`}>{extra}</span>}
    </span>
  );
}

function RouteRow({ route, canEdit, icons, onEdit, onRemove }: { route: McRoute; canEdit: boolean; icons: boolean; onEdit: () => void; onRemove: () => void }) {
  const bad = dnsProblem(route.dns);
  return (
    <li className={s.item}>
      <div className={s.row}>
        <span className={s.addr}>
          <span className={s.addrLine}>
            <span className={`${s.host} mono`} title={route.host} translate="no">
              {route.host}
            </span>
            <CopyButton value={route.host} label={`Copy ${route.host}`} />
          </span>
        </span>
        <ServerCell target={route.target} backend={route.backend} ping={route.ping} icons={icons} />
        <PingCell state={route.state} summary={route.summary} ping={route.ping} name={targetName(route.target, route.backend).name} />
        <span className={s.act}>
          {canEdit && (
            <Menu
              trigger={
                <IconButton label={`More for ${route.host}`} size="sm">
                  <MoreHoriz />
                </IconButton>
              }
              items={[
                { label: "Change", description: "Its server or its name", onSelect: onEdit },
                "separator",
                { label: "Remove", danger: true, onSelect: onRemove },
              ]}
            />
          )}
        </span>
      </div>
      {bad && route.dns && (
        <p className={s.fix} data-tone={route.dns.status === "error" ? "neutral" : "attention"}>
          <span className={s.fixMark} aria-hidden />
          <span>{route.dns.message}</span>
        </p>
      )}
    </li>
  );
}

function FallbackRow({ fallback, canEdit, icons, onChange }: { fallback: McDefault | null; canEdit: boolean; icons: boolean; onChange: () => void }) {
  return (
    <li className={s.item}>
      <div className={s.row}>
        <span className={s.addr}>
          <span className={s.name}>Any other address</span>
          <span className={s.sub}>Your IP, or a name not listed</span>
        </span>
        {fallback ? (
          <>
            <ServerCell target={fallback.target} backend={fallback.backend} ping={fallback.ping} icons={icons} />
            <PingCell state={fallback.state} summary={fallback.summary} ping={fallback.ping} name={targetName(fallback.target, fallback.backend).name} />
          </>
        ) : (
          <>
            <span className={s.server}>
              {icons && <span className={s.icon} aria-hidden />}
              <span className={s.stack}>
                <span className={s.name}>Nobody</span>
                <span className={s.sub}>mc-router turns them away</span>
              </span>
            </span>
            <span className={s.ping} />
          </>
        )}
        <span className={s.act}>
          {canEdit && (
            <Menu
              trigger={
                <IconButton label="More for any other address" size="sm">
                  <MoreHoriz />
                </IconButton>
              }
              items={[{ label: "Change", description: "Where players on other addresses go", onSelect: onChange }]}
            />
          )}
        </span>
      </div>
    </li>
  );
}

function ForwardState({ f }: { f: Forwarding }) {
  return (
    <span className={s.fwd}>
      <StateLine state={f.state} label={f.label} />
      {f.fix && (
        <a className={s.fwdLink} href="#port-forwarding">
          Port forwarding
        </a>
      )}
    </span>
  );
}

// ------------------------------------------------------------------ other games

function OtherGames({ st, fwd, onAdd, onEdit, onRemove }: { st: GamesStatus; fwd: (key: string) => Forwarding; onAdd: () => void; onEdit: (p: GamePort) => void; onRemove: (p: GamePort) => void }) {
  return (
    <section className={s.section} aria-labelledby="games-ports">
      <div className={s.subhead}>
        <h3 id="games-ports" className={s.subTitle}>
          Other games
        </h3>
        <span className={s.subMeta}>Each on a port of its own</span>
        <Button size="sm" className={s.subAction} onClick={onAdd}>
          Add a game port
        </Button>
      </div>
      {st.ports.length === 0 ? (
        <div className={s.emptyLine}>
          <p>Bedrock, Valheim and most other games each need a port forwarded. Add one and it shows up under Port forwarding.</p>
        </div>
      ) : (
        <ul className={s.list} aria-label="Game ports">
          {st.ports.map((p) => {
            const publicMax = p.publicMin + (p.hostMax - p.hostMin);
            const join = p.address ? `${p.address}:${p.publicMin}` : null;
            return (
              <li key={p.id} className={s.item}>
                <div className={`${s.row} ${s.portRow}`}>
                  <span className={s.addr}>
                    <span className={s.name}>{p.name}</span>
                    {join ? (
                      <span className={s.addrLine}>
                        <span className={`${s.sub} mono`} title={join} translate="no">
                          {join}
                        </span>
                        <CopyButton value={join} label={`Copy ${join}`} />
                      </span>
                    ) : (
                      <span className={s.sub}>No address set</span>
                    )}
                  </span>
                  <span className={s.stack}>
                    <span className={`${s.ports} mono`}>
                      {protoText(p.protocol)} {rangeText(p.publicMin, publicMax)}
                    </span>
                    <span className={s.sub}>{p.publicMin === p.hostMin ? "Same port on this server" : `To ${rangeText(p.hostMin, p.hostMax)} on this server`}</span>
                  </span>
                  <span className={s.stack}>
                    {p.publishedBy ? (
                      <>
                        <StateLine state={p.publishedBy.running ? "running" : "stopped"} label={p.publishedBy.app ?? p.publishedBy.container} />
                        <span className={`${s.sub} ${s.indent}`}>{p.publishedBy.app ? `${p.publishedBy.container} publishes it` : "Publishes it"}{p.publishedBy.running ? "" : ", stopped"}</span>
                      </>
                    ) : (
                      <>
                        <StateLine state="unknown" label="No container publishes it" />
                        <span className={`${s.sub} ${s.indent}`}>Fine if the game runs outside Docker</span>
                      </>
                    )}
                  </span>
                  <span className={s.stack}>
                    <ForwardState f={fwd(p.needKey)} />
                  </span>
                  <span className={s.act}>
                    <Menu
                      trigger={
                        <IconButton label={`More for ${p.name}`} size="sm">
                          <MoreHoriz />
                        </IconButton>
                      }
                      items={[{ label: "Change", onSelect: () => onEdit(p) }, "separator", { label: "Remove", danger: true, onSelect: () => onRemove(p) }]}
                    />
                  </span>
                </div>
                {p.dns && dnsProblem(p.dns) && (
                  <p className={s.fix} data-tone={p.dns.status === "error" ? "neutral" : "attention"}>
                    <span className={s.fixMark} aria-hidden />
                    <span>{p.dns.message}</span>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
