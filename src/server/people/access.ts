import "server-only";
import fs from "node:fs";
import { all, now, one, run, tx } from "../db";
import { id as newId } from "../crypto";
import { AppError, badRequest, conflict, notFound } from "../errors";
import { findById } from "../auth/users";
import { getApp, listApps, setAppPrefs } from "../docker/apps";
import { host } from "../host/exec";
import { hostPath, isWithin, normalizeHostPath } from "../host/paths";
import type { AppVisibility, FolderGrant, VisibilityResponse } from "@/lib/people-types";

// ---------------------------------------------------------------- app visibility

async function appsOrExplain() {
  try {
    return await listApps();
  } catch {
    throw new AppError("docker_unavailable", "Gluon can't reach Docker right now, so it can't list the apps. Check that Docker is running.", 503);
  }
}

export async function visibility(): Promise<VisibilityResponse> {
  const apps = (await appsOrExplain()).filter((a) => !a.self);
  const access = all<{ app_id: string; user_id: string }>("SELECT app_id, user_id FROM app_access");
  const byApp = new Map<string, string[]>();
  for (const r of access) {
    const arr = byApp.get(r.app_id) ?? [];
    arr.push(r.user_id);
    byApp.set(r.app_id, arr);
  }
  const members = all<{ id: string; display_name: string; username: string }>(
    "SELECT id, display_name, username FROM users WHERE role = 'member' ORDER BY display_name COLLATE NOCASE",
  ).map((m) => ({ id: m.id, displayName: m.display_name, username: m.username }));
  const out: AppVisibility[] = apps.map((a) => ({
    id: a.id,
    name: a.name,
    icon: a.icon,
    line: a.line,
    hidden: a.hidden,
    household: a.household,
    users: byApp.get(a.id) ?? [],
  }));
  return { apps: out, members };
}

function memberIds(ids: string[]): string[] {
  const uniq = [...new Set(ids)];
  for (const id of uniq) {
    const u = findById(id);
    if (!u) throw notFound("One of those people");
    if (u.role !== "member") throw badRequest(`${u.display_name} is an admin and already sees every app.`);
  }
  return uniq;
}

/** Set whether every household member sees an app, and/or exactly which members see it individually. */
export async function setAppVisibility(appId: string, patch: { household?: boolean; users?: string[] }) {
  const app = await getApp(appId);
  if (!app) throw notFound("That app");
  if (app.self) throw badRequest("Gluon itself isn't an app members open.");
  const users = patch.users ? memberIds(patch.users) : null;
  tx(() => {
    if (users) {
      run("DELETE FROM app_access WHERE app_id = ?", appId);
      for (const u of users) run("INSERT INTO app_access (app_id, user_id) VALUES (?, ?)", appId, u);
    }
  });
  if (patch.household !== undefined) setAppPrefs(appId, { household: patch.household });
  return app;
}

/** Replace the apps one member sees individually. */
export async function setUserApps(userId: string, appIds: string[]) {
  const [id] = memberIds([userId]);
  const known = new Set((await appsOrExplain()).map((a) => a.id));
  const unknown = appIds.filter((a) => !known.has(a));
  if (unknown.length) throw notFound(`The app “${unknown[0]}”`);
  tx(() => {
    run("DELETE FROM app_access WHERE user_id = ?", id);
    for (const a of new Set(appIds)) run("INSERT INTO app_access (app_id, user_id) VALUES (?, ?)", a, id);
  });
}

// ---------------------------------------------------------------- folder grants

interface GrantRow {
  id: string;
  user_id: string;
  path: string;
  label: string | null;
  access: "read" | "write";
  created_at: number;
  display_name?: string;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(hostPath(p)).isDirectory();
  } catch {
    return false;
  }
}

const toGrant = (r: GrantRow): FolderGrant => ({
  id: r.id,
  userId: r.user_id,
  userName: r.display_name ?? "",
  path: r.path,
  label: r.label,
  access: r.access,
  createdAt: r.created_at,
  exists: isDir(r.path),
});

export function listGrants(userId?: string): FolderGrant[] {
  const rows = userId
    ? all<GrantRow>("SELECT g.*, u.display_name FROM file_grants g JOIN users u ON u.id = g.user_id WHERE g.user_id = ? ORDER BY g.path", userId)
    : all<GrantRow>("SELECT g.*, u.display_name FROM file_grants g JOIN users u ON u.id = g.user_id ORDER BY u.display_name COLLATE NOCASE, g.path");
  return rows.map(toGrant);
}

export function getGrant(id: string): FolderGrant | null {
  const r = one<GrantRow>("SELECT g.*, u.display_name FROM file_grants g JOIN users u ON u.id = g.user_id WHERE g.id = ?", id);
  return r ? toGrant(r) : null;
}

/** System locations never shared with household members, whatever the admin clicks. */
const SYSTEM = ["/proc", "/sys", "/dev", "/run", "/boot", "/etc", "/root", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/var/lib", "/var/log", "/var/cache", "/var/spool", "/snap", "/lost+found", "/tmp"];
/** App internals (databases, configs with tokens, Docker's storage): not for browsing. */
const APP_DATA = ["/DATA/AppData", "/srv/docker", "/srv/containerd", "/var/lib/docker", "/var/lib/casaos"];
/** Folders holding keys/credentials; a grant may not contain one. */
const SECRET_DIRS = [".ssh", ".gnupg", ".docker", ".kube", ".aws", ".password-store"];

/** Canonical host path (symlinks resolved on the host) of an existing directory, or a clear refusal. */
export async function validateGrantPath(input: string): Promise<string> {
  let p: string;
  try {
    p = normalizeHostPath(input.trim());
  } catch {
    throw new AppError("invalid", "Use a full folder path starting with /, e.g. /srv/media/films.", 400, { field: "path" });
  }
  let real = p;
  try {
    const { stdout } = await host("realpath", ["-e", "--", p], { timeoutMs: 5000 });
    real = normalizeHostPath(stdout.trim());
  } catch {
    throw new AppError("not_found", `${p} doesn't exist on the server.`, 400, { field: "path" });
  }
  if (!isDir(real)) throw new AppError("invalid", `${real} is a file, not a folder.`, 400, { field: "path" });
  if (real === "/") throw new AppError("unsafe", "Sharing the whole disk isn't allowed. Pick a folder with the files they need.", 400, { field: "path" });
  const sys = SYSTEM.find((s) => isWithin(real, s));
  if (sys) throw new AppError("unsafe", `${real} is part of the operating system (${sys}), so it can't be shared.`, 400, { field: "path" });
  const appData = APP_DATA.find((s) => isWithin(real, s));
  if (appData) throw new AppError("unsafe", `${real} holds apps' own data (${appData}). Share the folders with the actual files instead.`, 400, { field: "path" });
  if (real === "/home" || real === "/srv" || real === "/mnt" || real === "/media" || real === "/var" || real === "/opt") {
    throw new AppError("unsafe", `${real} is a top-level system folder. Pick a folder inside it.`, 400, { field: "path" });
  }
  const holds = [...SYSTEM, ...APP_DATA].find((s) => isWithin(s, real) && s !== real);
  if (holds) throw new AppError("unsafe", `${real} contains ${holds}, which can't be shared. Pick a folder inside it that holds just the files.`, 400, { field: "path" });
  const segs = real.split("/");
  const secretSeg = segs.find((s) => SECRET_DIRS.includes(s));
  if (secretSeg) throw new AppError("unsafe", `${real} holds sign-in keys (${secretSeg}), so it can't be shared.`, 400, { field: "path" });
  const contains = SECRET_DIRS.find((d) => fs.existsSync(hostPath(`${real}/${d}`)));
  if (contains) {
    throw new AppError("unsafe", `${real} contains ${real}/${contains} (sign-in keys). Share a folder inside it instead.`, 400, { field: "path" });
  }
  return real;
}

export async function createGrant(input: { userId: string; path: string; label?: string | null; access: "read" | "write" }): Promise<FolderGrant> {
  const u = findById(input.userId);
  if (!u) throw notFound("That person");
  if (u.role === "admin") throw badRequest(`${u.display_name} is an admin and can already open every folder.`);
  const path = await validateGrantPath(input.path);
  const existing = all<GrantRow>("SELECT * FROM file_grants WHERE user_id = ?", u.id);
  if (existing.some((g) => g.path === path)) throw conflict(`${u.display_name} already has ${path}.`);
  const parent = existing.find((g) => isWithin(path, g.path) && (g.access === "write" || input.access === "read"));
  if (parent) throw conflict(`${u.display_name} can already open ${path} through ${parent.path}.`);
  if (existing.length >= 50) throw conflict("That's a lot of folders for one person. Share a parent folder instead.");
  const id = newId();
  run(
    "INSERT INTO file_grants (id, user_id, path, label, access, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    id,
    u.id,
    path,
    input.label?.trim() || null,
    input.access,
    now(),
  );
  return getGrant(id)!;
}

export function updateGrant(id: string, patch: { label?: string | null; access?: "read" | "write" }): { before: FolderGrant; after: FolderGrant } {
  const before = getGrant(id);
  if (!before) throw notFound("That folder grant");
  run(
    "UPDATE file_grants SET label = ?, access = ? WHERE id = ?",
    patch.label === undefined ? before.label : patch.label?.trim() || null,
    patch.access ?? before.access,
    id,
  );
  return { before, after: getGrant(id)! };
}

export function deleteGrant(id: string): FolderGrant {
  const g = getGrant(id);
  if (!g) throw notFound("That folder grant");
  run("DELETE FROM file_grants WHERE id = ?", id);
  return g;
}
