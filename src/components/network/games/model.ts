import type { CraftyServer, GamePort, GamesStatus, HostDns, McPing, McTarget } from "@/lib/games-types";
import type { NeedStateT, RouterStatus } from "@/lib/router-types";
import type { LineState } from "@/lib/types";

export const GAMES_URL = "/api/network/games";
export const ROUTER_URL = "/api/network/router";

/** "Survival Island!" → "survival-island", for a default address. */
export function slug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "server"
  );
}

export const OTHER = "__other";

/** The Crafty server a target is (the running one when several share its port), for a picker. */
export function craftyValue(st: GamesStatus, target: McTarget | null): string {
  if (target?.kind !== "crafty") return OTHER;
  const on = javaServers(st).filter((x) => x.port === target.port);
  return (on.find((x) => x.running) ?? on[0])?.id ?? OTHER;
}

/** The name mc-router already uses for Crafty (keep it, so edits don't rewrite working backends). */
export function craftyHostOf(st: GamesStatus, backend: string | null): string {
  const b = backend ?? st.routes.find((r) => r.target.kind === "crafty")?.backend ?? (st.fallback?.target.kind === "crafty" ? st.fallback.backend : null);
  return b ? b.slice(0, b.lastIndexOf(":")) : (st.crafty.container ?? "crafty_container");
}

export const javaServers = (st: GamesStatus) => st.crafty.servers.filter((s) => s.type !== "minecraft-bedrock" && s.port);

/** Crafty servers sharing a port with `s` (only one of them can run at a time). */
export const portMates = (st: GamesStatus, s: CraftyServer) => javaServers(st).filter((x) => x.port === s.port && x.id !== s.id);

/** The server an address reaches, in words. */
export function targetName(t: McTarget, backend: string): { name: string; sub: string } {
  if (t.kind === "crafty") {
    if (t.servers.length === 1) return { name: t.servers[0]!.name, sub: `Crafty, port ${t.port}` };
    if (t.servers.length === 0) return { name: `Port ${t.port}`, sub: "Crafty, no server set to it" };
    const live = t.servers.find((s) => s.running);
    return live ? { name: live.name, sub: `Crafty, port ${t.port}, shared with ${t.servers.length - 1} more` } : { name: t.servers.map((s) => s.name).join(" or "), sub: `Crafty, port ${t.port}, whichever is running` };
  }
  if (t.kind === "container") return { name: t.name, sub: backend };
  return { name: backend, sub: "Outside Docker" };
}

export function playersLine(p: McPing | null): string | null {
  if (!p?.ok || !p.players.length) return null;
  const more = (p.online ?? 0) - p.players.length;
  return `${p.players.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** DNS worth a sentence: only when it would stop players outside. */
export const dnsProblem = (d: HostDns | null) => !!d && d.status !== "home" && d.status !== "literal";

export interface Forwarding {
  state: LineState;
  label: string;
  /** Point at the Port forwarding panel to fix it. */
  fix: boolean;
}

/** How the router stands on one of Gluon's needs, matched by key. */
export function forwarding(router: RouterStatus | undefined, key: string, routerError: boolean): Forwarding {
  const n: NeedStateT | undefined = router?.needs.find((x) => x.need.key === key);
  if (!router) return { state: "unknown", label: routerError ? "Router not checked" : "Checking the router", fix: false };
  if (!n || n.status === "unknown") return { state: "unknown", label: router.connected ? "Router not checked" : "Forward it on your router", fix: true };
  if (n.status === "forwarded") return { state: "running", label: "Forwarded", fix: false };
  if (n.status === "elsewhere") return { state: "attention", label: `Goes to ${n.device ?? "another device"}`, fix: true };
  return { state: "attention", label: "Not forwarded", fix: true };
}

export const protoText = (p: GamePort["protocol"]) => (p === "both" ? "TCP/UDP" : p.toUpperCase());
export const rangeText = (min: number, max: number) => (min === max ? String(min) : `${min}-${max}`);

/** The line under the panel title: state first, then what needs doing. */
export function leadSentence(st: GamesStatus): string | null {
  const r = st.mcRouter;
  const n = st.routes.length;
  const answering = st.routes.filter((x) => x.state === "running").length;
  const ports = st.ports.length ? ` ${st.ports.length === 1 ? "One game port" : `${st.ports.length} game ports`} for other games.` : "";
  // The Minecraft section explains a missing mc-router; the lead only adds what it doesn't say.
  if (r.status === "missing") return ports.trim() || null;
  if (r.status === "stopped") return `mc-router is stopped, so nobody can join your Minecraft Java servers.${ports}`;
  if (r.broken) return `mc-router's routes file has a mistake, so Gluon won't change it.${ports}`;
  if (!n) return `mc-router is running with no addresses yet.${ports}`;
  const dns = st.routes.filter((x) => dnsProblem(x.dns)).length;
  const home = st.routes.filter((x) => x.dns?.status === "home").length;
  const head = `${n === 1 ? "One Minecraft address" : `${n} Minecraft addresses`} through mc-router, ${answering === n ? (n === 1 ? "and it answers" : "and all of them answer") : answering === 0 ? "and none answer right now" : `${answering} answering right now`}.`;
  const reach = dns ? ` ${dns === 1 ? "One doesn't" : `${dns} don't`} lead players outside your home here.` : home === n ? (n === 1 ? " It points at your home." : " All of them point at your home.") : "";
  return `${head}${reach}${ports}`;
}
