"use client";
import * as React from "react";
import { Globe, HomeSimple, Folder, Database, Page as FileIcon, Refresh, Play, Square, Journal, OpenNewWindow } from "iconoir-react";
import type { AppDetail, ContainerDetail } from "@/server/docker/detail";
import { useContainerStats, useLive } from "@/lib/client/live";
import { useFormat } from "@/components/PrefsProvider";
import { StateLine, lineLabel } from "@/components/ui/StateLine";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Time } from "@/components/ui/Time";
import type { LineState } from "@/lib/types";
import s from "./diagram.module.css";

// ---------------------------------------------------------------- model

interface AddrNode {
  id: string;
  kind: "public" | "home";
  label: string;
  href: string;
  note?: string;
  /** Container it reaches, and on which host port. */
  target: { ctr: string; port: number } | null;
}

interface CtrNode {
  id: string;
  d: ContainerDetail;
  name: string;
  line: LineState;
  image: string;
  ports: number[];
  network: string | null;
}

interface StoreNode {
  id: string;
  kind: "folder" | "file" | "volume" | "socket";
  label: string;
  full: string;
  href: string | null;
  users: { ctr: string; rw: boolean; dest: string }[];
}

interface StoreGroup {
  dir: string | null;
  nodes: StoreNode[];
}

const ctrLine = (d: ContainerDetail): LineState =>
  d.state === "running" ? (d.health === "unhealthy" ? "unhealthy" : d.health === "starting" ? "starting" : "running") : d.state === "restarting" ? "unhealthy" : d.state === "paused" ? "paused" : "stopped";

/** "ghcr.io/winters27/octo@sha256:…" → "winters27/octo". */
export function shortImage(image: string): string {
  const noDigest = image.split("@")[0]!;
  const parts = noDigest.split("/");
  if (parts.length > 1 && /[.:]/.test(parts[0]!) && parts[0] !== "docker.io") parts.shift();
  else if (parts[0] === "docker.io") parts.shift();
  if (parts[0] === "library") parts.shift();
  return parts.join("/");
}

const UMBREL_SERVICE: Record<string, string> = { app_proxy: "Umbrel app proxy", tor_server: "Umbrel Tor", auth: "Umbrel sign-in" };
const displayName = (d: ContainerDetail) => (d.service && UMBREL_SERVICE[d.service]) || d.service || d.name;

/** Mounts that only tell a container the time. */
const NOISE = new Set(["/etc/localtime", "/etc/timezone"]);
const looksLikeFile = (p: string) => /\.[a-z0-9]{1,6}$/i.test(p.split("/").pop() ?? "");
/** Long paths keep their start and the two folders that name them: "/mnt/hdd1_…/…/media/music". */
function shortPath(p: string, max = 36): string {
  if (p.length <= max) return p;
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  const second = parts[1]!.length > 12 ? `${parts[1]!.slice(0, 11)}…` : parts[1]!;
  return `/${parts[0]}/${second}/${parts.length > 4 ? "…/" : ""}${parts.slice(-2).join("/")}`;
}
const parent = (p: string) => p.replace(/\/[^/]+\/?$/, "") || "/";

function buildModel(app: AppDetail) {
  const ctrs: CtrNode[] = app.details.map((d) => ({
    id: `c:${d.name}`,
    d,
    name: displayName(d),
    line: ctrLine(d),
    image: shortImage(d.image),
    ports: [...new Set(d.ports.map((p) => p.host))].sort((a, b) => a - b),
    network: d.networkMode === "host" ? "host" : (d.networks[0]?.name ?? null),
  }));
  const servesPort = (port: number | null): { ctr: string; port: number } | null => {
    if (port === null) return null;
    const c = ctrs.find((x) => x.ports.includes(port));
    if (c) return { ctr: c.id, port };
    const host = ctrs.find((x) => x.network === "host");
    return host && app.webPort === port ? { ctr: host.id, port } : null;
  };

  const addrs: AddrNode[] = [];
  for (const r of app.routes.filter((x) => x.enabled)) {
    addrs.push({
      id: `a:${r.id}`,
      kind: "public",
      label: r.url.replace(/^https?:\/\//, "").replace(/\/$/, ""),
      href: r.url,
      note: r.onlyPaths?.length ? `Only ${r.onlyPaths.join(", ")}` : r.type === "path" ? "A path on the main address" : undefined,
      target: servesPort(r.port),
    });
  }
  if (app.urls.home) {
    const port = app.webPort ?? Number(/:(\d+)/.exec(app.urls.home)?.[1] ?? NaN);
    addrs.push({ id: "a:home", kind: "home", label: app.urls.home.replace(/^https?:\/\//, ""), href: app.urls.home, note: "On your home network", target: servesPort(Number.isFinite(port) ? port : null) });
  }

  // Storage: one node per source, however many containers share it.
  const byKey = new Map<string, StoreNode>();
  for (const d of app.details) {
    for (const m of d.mounts) {
      if (m.type !== "bind" && m.type !== "volume") continue;
      if (m.type === "bind" && NOISE.has(m.source)) continue;
      const key = m.type === "volume" ? `v:${m.volume ?? m.source}` : `b:${m.source}`;
      let node = byKey.get(key);
      if (!node) {
        if (m.type === "volume") {
          const name = m.volume ?? m.source;
          const anon = /^[0-9a-f]{64}$/.test(name);
          node = { id: key, kind: "volume", label: anon ? `Unnamed volume ${name.slice(0, 8)}` : name, full: name, href: null, users: [] };
        } else if (/docker\.sock$/.test(m.source)) {
          node = { id: key, kind: "socket", label: "Docker's control socket", full: m.source, href: null, users: [] };
        } else {
          const file = looksLikeFile(m.source);
          node = { id: key, kind: file ? "file" : "folder", label: shortPath(m.source), full: m.source, href: `/files?path=${encodeURIComponent(file ? parent(m.source) : m.source)}`, users: [] };
        }
        byKey.set(key, node);
      }
      node.users.push({ ctr: `c:${d.name}`, rw: m.rw, dest: m.destination });
    }
  }
  // Paths that share a parent folder are listed under it, so each row shows the part that differs.
  // Order storage to follow the containers that use it (fewer crossing wires); read-only extras go last.
  const order = new Map(ctrs.map((c, i) => [c.id, i]));
  const weight = (n: StoreNode) => (n.users.some((u) => u.rw) ? 0 : 100) + Math.min(...n.users.map((u) => order.get(u.ctr) ?? 0));
  const nodes = [...byKey.values()].sort((a, b) => weight(a) - weight(b) || a.full.localeCompare(b.full));
  const byDir = new Map<string, StoreNode[]>();
  for (const n of nodes) if (n.kind === "folder" || n.kind === "file") byDir.set(parent(n.full), [...(byDir.get(parent(n.full)) ?? []), n]);
  const groups: StoreGroup[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const dir = n.kind === "folder" || n.kind === "file" ? parent(n.full) : null;
    const siblings = dir ? byDir.get(dir)! : [n];
    if (dir && siblings.length > 1) {
      siblings.forEach((x) => seen.add(x.id));
      groups.push({ dir, nodes: siblings.map((x) => ({ ...x, label: x.full.slice(dir.length + 1) })) });
    } else {
      seen.add(n.id);
      groups.push({ dir: null, nodes: [n] });
    }
  }

  const edges: { from: string; to: string; fromPort?: string }[] = [];
  for (const a of addrs) if (a.target) edges.push({ from: a.id, to: a.target.ctr, fromPort: `${a.target.ctr}:${a.target.port}` });
  for (const n of byKey.values()) for (const u of n.users) edges.push({ from: u.ctr, to: n.id });
  return { addrs, ctrs, groups, edges };
}

// ---------------------------------------------------------------- view

export interface DiagramActions {
  onContainer: (name: string, action: "restart" | "stop" | "start") => void;
  busy: string | null;
  logsHref: (container: string) => string;
}

/**
 * How an app is put together: its addresses on the left, its containers in the middle (each with
 * the ports it publishes), and the folders and volumes they keep data in on the right. Hover or
 * focus any box to trace its connections; containers open their actions.
 */
export function StackDiagram({ app, actions }: { app: AppDetail; actions: DiagramActions }) {
  const model = React.useMemo(() => buildModel(app), [app]);
  const stats = useContainerStats();
  const memTotal = useLive().host.at(-1)?.mem.total ?? null;
  const fmt = useFormat();
  const wrap = React.useRef<HTMLDivElement>(null);
  const [paths, setPaths] = React.useState<{ key: string; d: string; from: string; to: string }[]>([]);
  const [box, setBox] = React.useState({ w: 0, h: 0 });
  const [hot, setHot] = React.useState<string | null>(null);

  const linked = React.useMemo(() => {
    if (!hot) return null;
    const set = new Set([hot]);
    // Trace one hop each way, and through a container to its storage and addresses.
    for (const e of model.edges) {
      if (e.from === hot) set.add(e.to);
      if (e.to === hot) set.add(e.from);
    }
    if (hot.startsWith("a:")) for (const e of model.edges) if (set.has(e.from) && e.from.startsWith("c:")) set.add(e.to);
    return set;
  }, [hot, model.edges]);

  // Draw connectors between measured boxes; wide layouts only (phones read the text instead).
  React.useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const draw = () => {
      const r = el.getBoundingClientRect();
      if (getComputedStyle(el).getPropertyValue("--wires").trim() !== "1") {
        setPaths((p) => (p.length ? [] : p));
        return;
      }
      const at = (sel: string) => el.querySelector<HTMLElement>(sel)?.getBoundingClientRect() ?? null;
      const next = model.edges.flatMap((e, i) => {
        const a = e.fromPort ? at(`[data-port="${CSS.escape(e.fromPort)}"]`) : at(`[data-node="${CSS.escape(e.from)}"]`);
        const src = at(`[data-node="${CSS.escape(e.from)}"]`);
        const b = e.fromPort ? a : at(`[data-node="${CSS.escape(e.to)}"]`);
        if (!src || !b) return [];
        const x1 = src.right - r.left;
        const y1 = src.top + src.height / 2 - r.top;
        const x2 = b.left - r.left;
        const y2 = b.top + b.height / 2 - r.top;
        const mid = Math.max(24, (x2 - x1) / 2);
        return [{ key: `${e.from}>${e.to}>${i}`, from: e.from, to: e.to, d: `M${x1},${y1} C${x1 + mid},${y1} ${x2 - mid},${y2} ${x2},${y2}` }];
      });
      setPaths(next);
      setBox({ w: r.width, h: r.height });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [model]);

  const hover = (id: string) => ({
    onPointerEnter: () => setHot(id),
    onPointerLeave: () => setHot((h) => (h === id ? null : h)),
    onFocus: () => setHot(id),
    onBlur: () => setHot((h) => (h === id ? null : h)),
    "data-node": id,
    "data-dim": linked && !linked.has(id) ? "" : undefined,
    "data-hot": linked?.has(id) ? "" : undefined,
  });
  const reach = (ctr: string) => model.addrs.filter((a) => a.target?.ctr === ctr);
  const uses = (ctr: string) => model.groups.flatMap((g) => g.nodes).filter((n) => n.users.some((u) => u.ctr === ctr));
  const nets = [...new Set(model.ctrs.map((c) => c.network).filter(Boolean))] as string[];
  const sharedNet = nets.length === 1 && model.ctrs.length > 1 ? nets[0]! : null;

  return (
    <div className={s.outer}>
    <div className={s.wrap} ref={wrap} role="group" aria-label={`How ${app.name} is put together`}>
      <svg className={s.wires} width={box.w} height={box.h} aria-hidden>
        {paths.map((p) => (
          <path key={p.key} d={p.d} data-hot={linked && linked.has(p.from) && linked.has(p.to) ? "" : undefined} data-dim={linked && !(linked.has(p.from) && linked.has(p.to)) ? "" : undefined} />
        ))}
      </svg>

      <section className={s.col} aria-label="Addresses">
        <h3 className="label">Reached at</h3>
        {model.addrs.length === 0 ? (
          <p className={s.empty}>No web address. It may still publish ports for other apps.</p>
        ) : (
          model.addrs.map((a) => (
            <a key={a.id} href={a.href} target="_blank" rel="noopener noreferrer" className={s.node} data-kind={a.kind} {...hover(a.id)}>
              <span className={s.nodeHead}>
                {a.kind === "public" ? <Globe aria-hidden /> : <HomeSimple aria-hidden />}
                <span className={`${s.nodeTitle} mono`} title={a.href}>
                  {a.label}
                </span>
                <OpenNewWindow aria-hidden className={s.nodeGo} />
              </span>
              <span className={s.nodeSub}>
                {a.kind === "public" ? "From anywhere" : "At home"}
                {a.note && a.kind === "public" ? ` · ${a.note}` : ""}
                {a.target ? <span className={s.linkText}> · goes to {model.ctrs.find((c) => c.id === a.target!.ctr)?.name} on port {a.target.port}</span> : <span> · Gluon can't tell which container answers</span>}
              </span>
            </a>
          ))
        )}
      </section>

      <section className={s.col} aria-label="Containers">
        <h3 className={`label ${s.ctrHead}`}>{model.ctrs.length === 1 ? "Container" : `${model.ctrs.length} containers`}</h3>
        {sharedNet && <p className={`${s.netNote} ${s.ctrHead}`}>{sharedNet === "host" ? "All on the server's own network" : <>Talking to each other on <span className="mono">{sharedNet}</span></>}</p>}
        {model.ctrs.map((c) => {
          const live = stats.get(c.d.name);
          const running = c.d.state === "running";
          const items: MenuEntry[] = [
            { label: "Restart", icon: <Refresh />, disabled: !running, onSelect: () => actions.onContainer(c.d.name, "restart") },
            running ? { label: "Stop", icon: <Square />, onSelect: () => actions.onContainer(c.d.name, "stop") } : { label: "Start", icon: <Play />, onSelect: () => actions.onContainer(c.d.name, "start") },
            "separator",
            { label: "Logs", icon: <Journal />, href: actions.logsHref(c.d.name) },
            ...reach(c.id).map((a) => ({ label: `Open ${a.label}`, icon: <OpenNewWindow />, href: a.href })),
            ...uses(c.id)
              .filter((n) => n.href)
              .slice(0, 4)
              .map((n) => ({ label: `Show ${n.full.split("/").pop()} in Files`, icon: <Folder />, href: n.href! })),
          ];
          const reached = reach(c.id);
          const used = uses(c.id);
          return (
            <div key={c.id} className={s.ctrWrap}>
              {c.ports.length > 0 && (
                <span className={s.ports} aria-label={`Publishes port${c.ports.length > 1 ? "s" : ""} ${c.ports.join(", ")}`}>
                  {c.ports.map((p) => (
                    <span key={p} className={`${s.port} mono num`} data-port={`${c.id}:${p}`} data-dim={linked && !linked.has(c.id) ? "" : undefined}>
                      :{p}
                    </span>
                  ))}
                </span>
              )}
              <Menu
                align="start"
                trigger={
                  <button type="button" className={s.node} data-kind="container" data-state={c.line} data-busy={actions.busy === c.d.name ? "" : undefined} {...hover(c.id)} aria-label={`${c.name}, ${lineLabel(c.line)}. Actions`}>
                    <span className={s.nodeHead}>
                      <StateLine state={c.line} size={16} />
                      <span className={s.nodeTitle} title={c.d.name}>
                        {c.name}
                      </span>
                      {running && live && (
                        <span className={`${s.nodeNums} num`}>
                          {fmt.percent(live.cpu, 1)} · {fmt.bytes(live.mem)}
                        </span>
                      )}
                    </span>
                    <span className={s.nodeSub}>
                      <span className="mono" title={c.d.image}>
                        {c.image}
                      </span>
                    </span>
                    <span className={s.nodeSub}>
                      {running && c.d.startedAt ? (
                        <>
                          {lineLabel(c.line)}, started <Time ts={c.d.startedAt} />
                        </>
                      ) : c.d.exitExplained ? (
                        `${lineLabel(c.line)}: ${c.d.exitExplained}`
                      ) : (
                        lineLabel(c.line)
                      )}
                      {c.d.restartCount > 0 && ` · ${fmt.plural(c.d.restartCount, "restart")}`}
                      {c.d.oomKilled && <span className={s.bad}> · ran out of memory</span>}
                      {c.d.memoryLimit && (!memTotal || c.d.memoryLimit < memTotal * 0.9) ? ` · memory capped at ${fmt.bytes(c.d.memoryLimit, 0)}` : ""}
                      {!sharedNet && c.network && (c.network === "host" ? " · on the server's own network" : c.network === "bridge" ? " · on Docker's default network" : <> · on <span className="mono">{c.network}</span></>)}
                    </span>
                    <span className={s.linkText}>
                      {reached.length > 0 && `Reached at ${reached.map((a) => a.label).join(", ")}. `}
                      {used.length > 0 && `Keeps data in ${used.length === 1 ? used[0]!.full : `${used.length} places`}.`}
                    </span>
                  </button>
                }
                items={items}
              />
            </div>
          );
        })}
      </section>

      <section className={s.col} aria-label="Storage">
        <h3 className="label">Keeps its data in</h3>
        {model.groups.length === 0 ? (
          <p className={s.empty}>Nothing outside its containers. Anything it saves is lost if it's recreated.</p>
        ) : (
          model.groups.map((g, gi) => (
            <div key={g.dir ?? `g${gi}`} className={s.storeGroup}>
              {g.dir && (
                <p className={`${s.dir} mono`} title={g.dir}>
                  {g.dir}/
                </p>
              )}
              {g.nodes.map((n) => {
                const ro = n.users.every((u) => !u.rw);
                const shared = new Set(n.users.map((u) => u.ctr)).size;
                const content = (
                  <>
                    <span className={s.nodeHead}>
                      {n.kind === "volume" ? <Database aria-hidden /> : n.kind === "file" || n.kind === "socket" ? <FileIcon aria-hidden /> : <Folder aria-hidden />}
                      <span className={`${s.nodeTitle} ${n.kind === "socket" ? "" : "mono"}`} title={n.full}>
                        {n.label}
                      </span>
                    </span>
                    <span className={s.nodeSub}>
                      {n.kind === "socket" ? "Gives full control of Docker" : n.kind === "volume" ? "Docker volume" : ro ? "Read only" : "Read and write"}
                      {shared > 1 && ` · shared by ${shared} containers`}
                      <span className={s.linkText}> · used by {[...new Set(n.users.map((u) => model.ctrs.find((c) => c.id === u.ctr)?.name))].join(", ")}</span>
                    </span>
                  </>
                );
                return n.href ? (
                  <a key={n.id} href={n.href} className={s.node} data-kind="store" {...hover(n.id)} aria-label={`${n.full}, open in Files`}>
                    {content}
                  </a>
                ) : (
                  <div key={n.id} className={s.node} data-kind="store" tabIndex={0} {...hover(n.id)}>
                    {content}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </section>
    </div>
    </div>
  );
}
