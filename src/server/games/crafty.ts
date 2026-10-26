import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { docker } from "../docker/client";
import { hostPath } from "../host/paths";
import { parseProperties } from "./properties";
import { plain } from "./slp";
import { hostPathFor, type Listed } from "./discover";
import type { CraftyServer } from "@/lib/games-types";

/**
 * Crafty Controller's Minecraft servers, read without touching Crafty: each server's folder and
 * server.properties (its port and MOTD), Crafty's own names from a copy of its database, and
 * which ones are running from the processes in Crafty's container.
 */

interface Named {
  name: string;
  type: string;
  port: number | null;
}

type G = typeof globalThis & { __gluonCraftyNames?: { key: string; names: Map<string, Named> | null } };
const g = globalThis as G;

const MAX_DB = 256 * 1024 * 1024;

/**
 * Crafty keeps its server list in config/db/crafty.sqlite (WAL mode, Crafty 4). Opening it in
 * place could leave -wal/-shm files owned by root next to it, which Crafty (not root) then can't
 * open, so Gluon copies the database and its write-ahead log and reads the copy.
 */
function craftyNames(configDir: string): Map<string, Named> | null {
  const dbFile = hostPath(path.posix.join(configDir, "db", "crafty.sqlite"));
  let key: string;
  try {
    const st = fs.statSync(dbFile);
    if (st.size > MAX_DB) return null;
    let wal = "";
    try {
      const w = fs.statSync(`${dbFile}-wal`);
      wal = `${w.size}:${w.mtimeMs}`;
    } catch {
      /* no WAL right now */
    }
    key = `${dbFile}:${st.size}:${st.mtimeMs}:${wal}`;
  } catch {
    return null;
  }
  if (g.__gluonCraftyNames?.key === key) return g.__gluonCraftyNames.names;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-crafty-"));
  let names: Map<string, Named> | null = null;
  try {
    const copy = path.join(tmp, "crafty.sqlite");
    fs.copyFileSync(dbFile, copy);
    try {
      fs.copyFileSync(`${dbFile}-wal`, `${copy}-wal`);
    } catch {
      /* no WAL */
    }
    const d = new Database(copy, { fileMustExist: true });
    try {
      const rows = d.prepare("SELECT server_id, server_name, path, server_port, type FROM servers").all() as { server_id: string; server_name: string; path: string; server_port: number; type: string }[];
      names = new Map();
      for (const r of rows) {
        const v: Named = { name: String(r.server_name ?? "").trim(), type: String(r.type ?? "minecraft-java"), port: Number(r.server_port) || null };
        names.set(String(r.server_id), v);
        if (r.path) names.set(path.posix.basename(String(r.path).replace(/\/$/, "")), v);
      }
    } finally {
      d.close();
    }
  } catch {
    names = g.__gluonCraftyNames?.names ?? null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  g.__gluonCraftyNames = { key, names };
  return names;
}

/**
 * Which server folders have a game running in them: Crafty starts each server with its folder as
 * the working directory. Null when this machine's processes aren't visible (Gluon off the server).
 */
async function liveFolders(c: Listed, ids: string[]): Promise<Set<string> | null> {
  if (c.State !== "running") return new Set();
  let top: { Titles?: string[]; Processes?: string[][] };
  try {
    top = await docker().getContainer(c.Id).top();
  } catch {
    return null;
  }
  const pidAt = top.Titles?.indexOf("PID") ?? -1;
  if (pidAt < 0) return null;
  const live = new Set<string>();
  let seen = false;
  for (const p of top.Processes ?? []) {
    const pid = Number(p[pidAt]);
    if (!Number.isInteger(pid)) continue;
    let where = "";
    try {
      where = fs.readlinkSync(`/proc/${pid}/cwd`);
      seen = true;
    } catch {
      continue;
    }
    const id = ids.find((x) => where === x || where.endsWith(`/${x}`) || where.includes(`/${x}/`));
    if (id) live.add(id);
  }
  return seen ? live : null;
}

function readProps(file: string): Map<string, string> | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 256 * 1024) return null;
    return parseProperties(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const isBedrock = (folder: string, props: Map<string, string>) => props.has("server-portv6") || fs.existsSync(path.join(folder, "bedrock_server")) || fs.existsSync(path.join(folder, "bedrock_server.exe"));

export interface CraftyRead {
  servers: CraftyServer[];
  names: boolean;
  live: boolean;
}

export async function readCrafty(c: Listed): Promise<CraftyRead> {
  const serversDir = hostPathFor(c.Mounts ?? [], "/crafty/servers");
  const configDir = hostPathFor(c.Mounts ?? [], "/crafty/app/config");
  if (!serversDir) return { servers: [], names: false, live: false };
  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(hostPath(serversDir), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return { servers: [], names: false, live: false };
  }
  const names = configDir ? craftyNames(configDir) : null;
  const live = await liveFolders(c, entries);
  const servers: CraftyServer[] = [];
  for (const id of entries) {
    const folder = path.join(hostPath(serversDir), id);
    const props = readProps(path.join(folder, "server.properties"));
    const named = names?.get(id);
    if (!props && !named) continue;
    const motd = props?.get("motd") ? plain(props.get("motd")!) || null : null;
    const type = named?.type ?? (props && isBedrock(folder, props) ? "minecraft-bedrock" : "minecraft-java");
    const port = Number(props?.get("server-port")) || named?.port || null;
    const name = named?.name || (motd && motd !== "A Minecraft Server" ? motd.split("\n")[0]! : null);
    servers.push({ id, name: name ?? id.slice(0, 8), named: named?.name ? "crafty" : name ? "motd" : "folder", port, motd, type, running: live ? live.has(id) : null });
  }
  servers.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
  return { servers, names: !!names, live: !!live };
}
