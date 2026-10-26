import "server-only";
import { SERVICE_NAME_MAX, type PortNeed } from "../router/plan";
import { JAVA_NEED_KEY, portNeedKey } from "@/lib/games-types";
import type { GamePortRow } from "./ports";

/** The router caps custom service names, and Gluon names the services it adds after the label. */
export const LABEL_MAX = SERVICE_NAME_MAX;

export function shortLabel(name: string): string {
  let n = name.trim().replace(/\s+/g, " ");
  if (n.length <= LABEL_MAX) return n;
  // "Minecraft" alone is mc-router's need; keep the edition.
  n = n.replace(/^Minecraft /i, "MC ");
  if (n.length <= LABEL_MAX) return n;
  const cut = n.slice(0, LABEL_MAX + 1);
  const word = cut.lastIndexOf(" ");
  return (word >= 6 ? cut.slice(0, word) : n.slice(0, LABEL_MAX)).trim();
}

/** Pure: what the router must forward for mc-router and for each game port. */
export function needsFor(java: { hostPort: number; addresses: number } | null, ports: GamePortRow[]): PortNeed[] {
  const out: PortNeed[] = [];
  if (java)
    out.push({ key: JAVA_NEED_KEY, label: "Minecraft", why: java.addresses === 1 ? "Players join your Minecraft server by name." : "Players join your Minecraft servers by name.", min: 25565, max: 25565, hostPort: java.hostPort, protocol: "tcp" });
  for (const p of ports) {
    out.push({
      key: portNeedKey(p.id),
      label: shortLabel(p.name),
      why: p.address ? `Players join ${p.address}${p.publicMin === 25565 ? "" : `:${p.publicMin}`}.` : `Players join ${p.name}.`,
      min: p.publicMin,
      max: p.publicMin + (p.hostMax - p.hostMin),
      hostPort: p.hostMin,
      protocol: p.protocol,
    });
  }
  return out;
}

/** Router ports that game servers published in Gluon need from the internet. */
export async function gamePortNeeds(): Promise<PortNeed[]> {
  // Loaded on use so needsFor stays importable without Docker and the database.
  const { javaNeed } = await import("./service");
  const { listGamePorts } = await import("./ports");
  return needsFor(await javaNeed().catch(() => null), listGamePorts());
}
