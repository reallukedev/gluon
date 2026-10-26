import "server-only";
import crypto from "node:crypto";
import { all, db, now, one, run } from "../db";
import type { GameProtocol } from "@/lib/games-types";
import type { PortNeed } from "../router/plan";

/** Game ports Luke adds by hand: games that need a port of their own, kept in Gluon's database. */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS game_ports (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  game TEXT,
  protocol TEXT NOT NULL,
  host_min INTEGER NOT NULL,
  host_max INTEGER NOT NULL,
  public_min INTEGER NOT NULL,
  address TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`;
type G = typeof globalThis & { __gluonGamePortsSchema?: boolean };
const g = globalThis as G;
function ensure() {
  if (g.__gluonGamePortsSchema) return;
  db().exec(SCHEMA);
  g.__gluonGamePortsSchema = true;
}

export interface GamePortRow {
  id: string;
  name: string;
  game: string | null;
  protocol: GameProtocol;
  hostMin: number;
  hostMax: number;
  publicMin: number;
  address: string | null;
}

interface Raw {
  id: string;
  name: string;
  game: string | null;
  protocol: string;
  host_min: number;
  host_max: number;
  public_min: number;
  address: string | null;
}

const fromRaw = (r: Raw): GamePortRow => ({ id: r.id, name: r.name, game: r.game, protocol: r.protocol as GameProtocol, hostMin: r.host_min, hostMax: r.host_max, publicMin: r.public_min, address: r.address });

export function listGamePorts(): GamePortRow[] {
  ensure();
  return all<Raw>("SELECT * FROM game_ports ORDER BY created_at").map(fromRaw);
}

export function getGamePort(id: string): GamePortRow | null {
  ensure();
  const r = one<Raw>("SELECT * FROM game_ports WHERE id = ?", id);
  return r ? fromRaw(r) : null;
}

export type GamePortInput = Omit<GamePortRow, "id">;

export function insertGamePort(p: GamePortInput): GamePortRow {
  ensure();
  const id = crypto.randomBytes(4).toString("hex");
  run("INSERT INTO game_ports (id, name, game, protocol, host_min, host_max, public_min, address, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, p.name, p.game, p.protocol, p.hostMin, p.hostMax, p.publicMin, p.address, now(), now());
  return { id, ...p };
}

export function updateGamePort(id: string, p: GamePortInput) {
  ensure();
  run("UPDATE game_ports SET name = ?, game = ?, protocol = ?, host_min = ?, host_max = ?, public_min = ?, address = ?, updated_at = ? WHERE id = ?", p.name, p.game, p.protocol, p.hostMin, p.hostMax, p.publicMin, p.address, now(), id);
}

export function deleteGamePort(id: string) {
  ensure();
  run("DELETE FROM game_ports WHERE id = ?", id);
}

const overlaps = (a: { min: number; max: number }, b: { min: number; max: number }) => a.min <= b.max && b.min <= a.max;
const protoClash = (a: GameProtocol, b: GameProtocol) => a === "both" || b === "both" || a === b;

export interface Reserved {
  min: number;
  max: number;
  protocol: GameProtocol;
  label: string;
}

/**
 * Public ports a game port must leave alone: whatever else Gluon forwards (from the router's list
 * of needs, game ports aside since they're checked against each other), plus 80 and 443, which the
 * web server needs whether or not it's set up yet (443 over UDP too, for HTTP/3).
 */
export function reservedPorts(needs: PortNeed[]): Reserved[] {
  const out: Reserved[] = needs.filter((n) => !n.key.startsWith("game-port-")).map((n) => ({ min: n.min, max: n.max, protocol: n.protocol, label: n.label }));
  if (!out.some((r) => r.min <= 80 && r.max >= 80)) out.push({ min: 80, max: 80, protocol: "both", label: "Web (HTTP)" });
  if (!out.some((r) => r.min <= 443 && r.max >= 443 && r.protocol !== "tcp")) out.push({ min: 443, max: 443, protocol: "both", label: "Web (HTTPS)" });
  return out;
}

/** Another entry, or something else Gluon forwards, already using some of these ports. */
export function clash(p: GamePortInput, others: GamePortRow[], reserved: Reserved[]): string | null {
  const host = { min: p.hostMin, max: p.hostMax };
  const pub = { min: p.publicMin, max: p.publicMin + (p.hostMax - p.hostMin) };
  for (const o of others) {
    if (!protoClash(p.protocol, o.protocol)) continue;
    if (overlaps(host, { min: o.hostMin, max: o.hostMax })) return `${o.name} already uses ${o.hostMin === o.hostMax ? `port ${o.hostMin}` : `ports ${o.hostMin}-${o.hostMax}`} on this server.`;
    if (overlaps(pub, { min: o.publicMin, max: o.publicMin + (o.hostMax - o.hostMin) })) return `${o.name} already uses that public port.`;
  }
  for (const r of reserved) {
    if (!protoClash(p.protocol, r.protocol) || !overlaps(pub, r)) continue;
    const at = Math.max(pub.min, r.min);
    return `Public port ${at} is already used by ${r.label}. Pick another public port.`;
  }
  return null;
}
