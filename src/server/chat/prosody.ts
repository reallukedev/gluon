import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { docker } from "../docker/client";
import { getApp, type AppSummary } from "../docker/apps";
import { AppError } from "../errors";
import { hostPath } from "../host/paths";
import { publicBaseUrl, getSetting } from "../settings";
import { tryReadConfig } from "../caddy/routes";
import { execWithInput } from "./exec";
import { XMPP_SENDER } from "../notify/xmpp-format";
import { readTar, writeTar } from "../network/tarball";
import { cleanLuaError, list, parseShellOutput, rawLine } from "./lua";
import { CUSTOM_FILE, GLUON_CONFIG, MANAGED_MODULES, hasInclude, historyFrom, readGluonConfig, renderGluonConfig, signUpFrom, withInclude } from "./settings";
import { capabilities } from "./capabilities";
import { clientName, roleOf } from "./names";
import type { ChatAccount, ChatConfigFiles, ChatHostSnapshot, ChatInvite, ChatRole, ChatRoom, ChatSettings, ChatSnapshot } from "@/lib/chat-types";

/**
 * Prosody, run by Gluon. Everything goes through `prosodyctl shell` inside the container (one line
 * of Lua in, one line of JSON out), so it works with any Prosody 13 install without extra modules
 * or open ports. Settings are written to gluon.cfg.lua next to the person's own config.
 */

const PROSODY_IMAGE = /(^|\/)(prosody|prosodyim)\/|(^|\/)prosody(:|$)/i;

export interface ProsodyTarget {
  app: AppSummary;
  id: string;
  name: string;
}

export async function prosodyFor(appId: string): Promise<ProsodyTarget> {
  const app = await getApp(appId);
  if (!app) throw new AppError("not_found", "That app doesn't exist (any more).", 404);
  const c = app.containers.find((x) => PROSODY_IMAGE.test(x.image));
  if (!c) throw new AppError("not_prosody", `${app.name} doesn't run Prosody.`, 400);
  if (c.state !== "running") throw new AppError("not_running", `${app.name} isn't running. Start it to manage chat accounts.`, 409);
  return { app, id: c.id, name: c.name };
}

const oneLine = (lua: string) => lua.replace(/\s*\n\s*/g, " ").trim();

/** uid/gid of the prosody user in each container, read once from its /etc/passwd. */
const owners = new Map<string, { uid: number; gid: number }>();
async function prosodyOwner(t: ProsodyTarget): Promise<{ uid: number; gid: number }> {
  const hit = owners.get(t.id);
  if (hit) return hit;
  const stream = (await docker().getContainer(t.id).getArchive({ path: "/etc/passwd" })) as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  const line = readTar(Buffer.concat(chunks))
    .find((e) => e.type === "file")
    ?.data.toString()
    .split("\n")
    .find((l) => l.startsWith("prosody:"));
  const [, , uid, gid] = line?.split(":") ?? [];
  if (!uid || !gid) throw new AppError("prosody_user", "Gluon couldn't find the prosody user in the container.", 502);
  const o = { uid: Number(uid), gid: Number(gid) };
  owners.set(t.id, o);
  return o;
}

/** Leave the arguments where only Prosody can read them; the Lua deletes the file as it reads it. */
async function putArgs(t: ProsodyTarget, args: unknown): Promise<string> {
  const name = `gluon-${crypto.randomBytes(12).toString("hex")}.json`;
  const o = await prosodyOwner(t);
  const tar = writeTar([{ name, data: Buffer.from(JSON.stringify(args ?? {})), mode: 0o600, uid: o.uid, gid: o.gid }]);
  await docker().getContainer(t.id).putArchive(tar, { path: "/tmp" });
  return `/tmp/${name}`;
}

/** Run Lua inside Prosody and return what it returned. Arguments travel as JSON (see lua.ts). */
export async function prosodyLua<T>(t: ProsodyTarget, body: string, args: unknown = {}, timeoutMs = 20_000): Promise<T> {
  const nonce = `GLUON${crypto.randomBytes(6).toString("hex")}`;
  const file = await putArgs(t, args);
  const r = await execWithInput(t.id, ["prosodyctl", "shell"], rawLine(oneLine(body), file, nonce), { user: "prosody", timeoutMs });
  if (r.timedOut) {
    await execWithInput(t.id, ["rm", "-f", file], "", { user: "prosody", timeoutMs: 5_000 }).catch(() => undefined);
    throw new AppError("prosody_timeout", "Prosody took too long to answer. It may be busy or stuck; try again, or restart it.", 504);
  }
  const res = parseShellOutput(`${r.stdout}\n${r.stderr}`, nonce);
  if (!res.ok) {
    // Only when no result came back at all: an error from Gluon's own Lua may mention any word.
    if (!res.fromLua && /connect|socket|No such file/i.test(res.error)) {
      throw new AppError("prosody_console", "Gluon couldn't open Prosody's admin console. Make sure admin_shell is in modules_enabled, then restart Prosody.", 502);
    }
    throw new AppError("prosody_error", cleanLuaError(res.error), 400);
  }
  return res.value as T;
}

// ---------------------------------------------------------------- snapshot

const SNAPSHOT = `
local um=require"core.usermanager"; local cm=require"core.configmanager"; local sm=require"core.storagemanager";
local function setlist(v) local o={} if type(v)~="table" then return o end for k,x in pairs(v) do if type(k)=="number" then o[#o+1]=x elseif x==true then o[#o+1]=k end end return o end;
local out={version=prosody.version, started=prosody.start_time, configFile=prosody.config_file, configDir=prosody.paths and prosody.paths.config, hosts={}};
for name,h in pairs(prosody.hosts) do
  local t={host=name, type=h.type, modules={}};
  for m in pairs(h.modules or {}) do t.modules[#t.modules+1]=m end;
  if h.type=="component" then t.component=cm.get(name,"component_module") end;
  if h.type=="local" then local ok,e=pcall(function()
    t.config={allow_registration=cm.get(name,"allow_registration"), registration_invite_only=cm.get(name,"registration_invite_only"), archive_expires_after=cm.get(name,"archive_expires_after"), welcome_message=cm.get(name,"welcome_message"), admins=setlist(cm.get(name,"admins")), contact_info=cm.get(name,"contact_info"), c2s_require_encryption=cm.get(name,"c2s_require_encryption"), invites_page=cm.get(name,"invites_page"), turn_external_host=cm.get(name,"turn_external_host")};
    local act=h.modules.account_activity and sm.open(name,"account_activity","keyval+");
    t.users={};
    for u in um.users(name) do
      local r=um.get_user_role and um.get_user_role(u,name); local info=um.get_account_info and um.get_account_info(u,name) or {};
      local last; if act then local ok,v=pcall(function() return act:get_key(u,"timestamp") end); if ok then last=v end end;
      local en=true; if um.user_is_enabled then en=um.user_is_enabled(u,name) and true or false end;
      t.users[#t.users+1]={user=u, role=r and r.name or nil, enabled=en, created=info.created, pw=info.password_updated, last=last};
    end;
    t.sessions={};
    for user,us in pairs(h.sessions or {}) do for res,s in pairs(us.sessions or {}) do
      t.sessions[#t.sessions+1]={user=user, resource=res, ip=s.ip, secure=s.secure and true or false, since=s.conntime, smacks=s.smacks and true or false, csi=s.state};
    end end;
    if h.modules.invites then local inv={}; for _,i in h.modules.invites.pending_account_invites() do
      local ad=i.additional_data or {}; inv[#inv+1]={token=i.token, jid=i.jid, created=i.created_at, expires=i.expires, uri=i.uri, page=i.landing_page, roles=ad.roles, reset=ad.allow_reset, reusable=i.reusable};
    end; t.invites=inv end;
  end); if not ok then t.problem=tostring(e) end end;
  if h.modules.muc and h.modules.muc.all_rooms then local rooms={}; for r in h.modules.muc.all_rooms() do
    local n=0; for _ in r:each_occupant() do n=n+1 end;
    rooms[#rooms+1]={jid=r.jid, name=r:get_name(), description=r:get_description(), public=r:get_public(), members=r:get_members_only(), persistent=r:get_persistent(), n=n};
  end; t.rooms=rooms end;
  out.hosts[#out.hosts+1]=t;
end;
return out`;

interface RawHost {
  host: string;
  type: string;
  modules: string[] | Record<string, never>;
  component?: string;
  config?: {
    allow_registration?: boolean;
    registration_invite_only?: boolean;
    archive_expires_after?: unknown;
    welcome_message?: string;
    admins: string[] | Record<string, never>;
    contact_info?: { admin?: string[] };
    c2s_require_encryption?: boolean;
    invites_page?: string;
    turn_external_host?: string;
  };
  users?: { user: string; role?: string; enabled: boolean; created?: number; pw?: number; last?: number }[];
  sessions?: { user: string; resource: string; ip?: string; secure: boolean; since?: number; smacks: boolean; csi?: string }[];
  invites?: { token: string; jid: string; created: number; expires: number; uri: string; page?: string; roles?: string[]; reset?: string; reusable?: boolean }[];
  rooms?: { jid: string; name?: string; description?: string; public?: boolean; members?: boolean; persistent?: boolean; n: number }[];
  /** Reading this domain failed; the others still show. */
  problem?: string;
}
interface RawSnapshot {
  version: string;
  started?: number;
  configFile?: string;
  configDir?: string;
  hosts: RawHost[] | Record<string, never>;
}

/** Where Prosody's config file is on the server, through the container's bind mounts. */
/** The file people edit by hand in the conf.d layout; Gluon's own settings sit next to it. */
// Not *.cfg.lua, so the image's conf.d/*.cfg.lua include skips it; gluon.cfg.lua includes it last.
export const CUSTOM_CONFIG = CUSTOM_FILE;
const CUSTOM_STARTER = `-- Your own Prosody settings. Prosody reads this last, after its built-in config, the\n-- environment variables in the app's compose file and Gluon's gluon.cfg.lua, so anything here wins.\n\nHost "*"\n\n`;

/**
 * Where Prosody's config is on the server, through the container's bind mounts. Two layouts:
 * "main", the whole config folder mounted (Gluon adds an Include line to the main file), and
 * "confd", the official image's own config with only conf.d mounted (it includes conf.d/*.cfg.lua
 * last, so Gluon's file and the person's custom.cfg.lua live there).
 */
async function configOnHost(t: ProsodyTarget, file: string | undefined): Promise<Omit<ChatSnapshot["config"], "rev">> {
  const none = (reason: string): Omit<ChatSnapshot["config"], "rev"> => ({ file: file ?? null, hostPath: null, writable: false, reason, managed: false, layout: "main" });
  if (!file) return none("Prosody didn't say where its config file is.");
  const info = await docker().getContainer(t.id).inspect();
  const mounts = (info.Mounts ?? []).filter((m) => m.Destination && m.Type === "bind");
  const under = (p: string) => mounts.filter((m) => p === m.Destination || p.startsWith(m.Destination.replace(/\/$/, "") + "/")).sort((a, b) => b.Destination.length - a.Destination.length)[0];
  const toHost = (m: { Source: string; Destination: string }, p: string) => path.posix.join(m.Source, path.posix.relative(m.Destination, p));

  let layout: "main" | "confd" = "main";
  let target = file;
  let mount = under(file);
  if (!mount) {
    const confd = path.posix.join(path.posix.dirname(file), "conf.d");
    const m = mounts.find((x) => x.Destination.replace(/\/$/, "") === confd);
    if (!m) return none(`${file} lives inside the container, so changes would be lost when it's recreated. Mount Prosody's config folder (or its conf.d folder) from the server to manage settings here.`);
    layout = "confd";
    mount = m;
    target = path.posix.join(confd, CUSTOM_CONFIG);
  }
  const onHost = toHost(mount, target);
  let writable = false;
  let reason: string | null = null;
  try {
    if (layout === "main" || fs.existsSync(hostPath(onHost))) fs.accessSync(hostPath(onHost), fs.constants.R_OK | fs.constants.W_OK);
    fs.accessSync(hostPath(path.posix.dirname(onHost)), fs.constants.W_OK);
    writable = true;
  } catch {
    reason = `Gluon can't write to ${onHost}.`;
  }
  let managed = false;
  try {
    managed = layout === "confd" ? fs.existsSync(hostPath(path.posix.join(path.posix.dirname(onHost), GLUON_CONFIG))) : hasInclude(fs.readFileSync(hostPath(onHost), "utf8"));
  } catch {
    /* unreadable: writable is already false */
  }
  return { file: target, hostPath: onHost, writable, reason, managed, layout };
}

function majorOf(v: string): number | null {
  const m = v.match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  // 0.12 → 0, 13.0 → 13.
  return Number(m[1]);
}

function routeFor(hosts: string[]): { host: string; httpPort: number | null } | null {
  const cfg = tryReadConfig();
  const r = cfg?.routes.find((x) => x.type === "subdomain" && !!x.xmpp && hosts.includes(x.host));
  return r && r.type === "subdomain" ? { host: r.host, httpPort: r.xmpp?.http_port ?? null } : null;
}

function defaultsFor(host: string): ChatSettings {
  return {
    signUp: "closed",
    history: "1w",
    groups: { on: false, host: `rooms.${host}`, whoCreates: "everyone" },
    files: { on: false, host: `upload.${host}`, maxMb: 100, keepDays: 30 },
    push: false,
    federation: true,
    web: false,
    calls: { on: false, host },
    welcome: null,
    contact: null,
  };
}

function hostSnapshot(h: RawHost, all: RawHost[], gluon: ChatSettings | null, webSide: boolean): ChatHostSnapshot {
  const modules = list<string>(h.modules);
  const has = (m: string) => modules.includes(m);
  const c = h.config ?? { admins: [] };
  const admins = list<string>(c.admins);
  const components = all.filter((x) => x.type === "component");
  const sub = (mod: string) => components.find((x) => x.component === mod && (x.host.endsWith(`.${h.host}`) || components.length === 1))?.host ?? null;
  const groupsHost = sub("muc");
  const filesHost = sub("http_file_share");
  const ownComponents = {
    muc: groupsHost && !(gluon?.groups.on && gluon.groups.host === groupsHost) ? groupsHost : null,
    files: filesHost && !(gluon?.files.on && gluon.files.host === filesHost) ? filesHost : null,
  };

  const devicesOf = new Map<string, ChatAccount["devices"]>();
  for (const s of list<NonNullable<RawHost["sessions"]>[number]>(h.sessions)) {
    const arr = devicesOf.get(s.user) ?? [];
    arr.push({ resource: s.resource, client: clientName(s.resource), ip: s.ip ?? null, secure: s.secure, since: s.since ? Math.round(s.since * 1000) : null, resumable: s.smacks, inactive: s.csi === "inactive" });
    devicesOf.set(s.user, arr);
  }
  const accounts: ChatAccount[] = list<NonNullable<RawHost["users"]>[number]>(h.users)
    .map((u) => {
      const jid = `${u.user}@${h.host}`;
      const fromConfig = admins.includes(jid);
      return {
        user: u.user,
        jid,
        role: fromConfig ? ("owner" as ChatRole) : roleOf(u.role ?? null),
        roleName: u.role ?? null,
        fromConfig,
        sender: u.user === XMPP_SENDER,
        enabled: u.enabled,
        created: u.created ? u.created * 1000 : null,
        passwordChanged: u.pw ? u.pw * 1000 : null,
        lastActive: u.last ? u.last * 1000 : null,
        devices: (devicesOf.get(u.user) ?? []).sort((a, b) => (b.since ?? 0) - (a.since ?? 0)),
      };
    })
    .sort((a, b) => a.user.localeCompare(b.user));

  const invites: ChatInvite[] = list<NonNullable<RawHost["invites"]>[number]>(h.invites)
    .filter((i) => i.jid === h.host || i.jid.endsWith(`@${h.host}`))
    .map((i) => ({
      token: i.token,
      username: i.jid.includes("@") ? i.jid.split("@")[0]! : null,
      role: roleOf(list<string>(i.roles)[0] ?? "prosody:member"),
      created: i.created * 1000,
      expires: i.expires * 1000,
      uri: i.uri,
      page: i.page ?? null,
      reusable: !!i.reusable,
      reset: !!i.reset,
    }))
    .sort((a, b) => b.created - a.created);

  const rooms: ChatRoom[] = list<NonNullable<RawHost["rooms"]>[number]>(all.find((x) => x.host === groupsHost)?.rooms)
    .map((r) => ({ jid: r.jid, name: r.name ?? null, description: r.description ?? null, public: !!r.public, membersOnly: !!r.members, persistent: !!r.persistent, occupants: r.n }))
    .sort((a, b) => b.occupants - a.occupants || a.jid.localeCompare(b.jid));

  const allModules = new Set(modules);
  const settings: ChatSettings = {
    ...defaultsFor(h.host),
    ...(gluon ?? {}),
    signUp: signUpFrom(c.allow_registration, c.registration_invite_only, has("invites_register")),
    history: historyFrom(has("mam"), c.archive_expires_after),
    groups: { ...(gluon?.groups ?? defaultsFor(h.host).groups), on: !!groupsHost, host: groupsHost ?? gluon?.groups.host ?? `rooms.${h.host}` },
    files: { ...(gluon?.files ?? defaultsFor(h.host).files), on: !!filesHost, host: filesHost ?? gluon?.files.host ?? `upload.${h.host}` },
    push: has("cloud_notify"),
    federation: has("s2s"),
    web: has("bosh") || has("websocket"),
    calls: { on: has("turn_external"), host: c.turn_external_host ?? gluon?.calls?.host ?? h.host },
    welcome: has("welcome") ? (c.welcome_message ?? gluon?.welcome ?? null) : null,
    contact: list<string>(c.contact_info?.admin)[0]?.replace(/^xmpp:/, "") ?? null,
  };

  return {
    host: h.host,
    problem: h.problem ? cleanLuaError(h.problem) : null,
    accounts,
    invites,
    invitesReady: has("invites") && has("invites_register"),
    rooms,
    groupsHost,
    filesHost,
    settings,
    ownComponents,
    capabilities: capabilities({ host: h.host, modules: allModules, groupsHost, filesHost, webSide, settings, requireEncryption: c.c2s_require_encryption !== false }),
    modules: [...allModules].sort(),
  };
}

export async function chatSnapshot(appId: string): Promise<ChatSnapshot> {
  const t = await prosodyFor(appId);
  const raw = await prosodyLua<RawSnapshot>(t, SNAPSHOT);
  const all = list<RawHost>(raw.hosts);
  const config = withRev(await configOnHost(t, raw.configFile));
  const gluon = readGluonConfig(config.hostPath ? readOr(path.posix.join(path.posix.dirname(config.hostPath), GLUON_CONFIG)) : null);
  const vhosts = all.filter((h) => h.type === "local" && h.host !== "localhost" && (h.config || h.problem));
  const route = routeFor(vhosts.map((h) => h.host));
  const hosts = vhosts
    .map((h) => hostSnapshot(h, all, gluon, !!route?.httpPort && route.host === h.host))
    .sort((a, b) => Number(b.host === route?.host) - Number(a.host === route?.host) || b.accounts.length - a.accounts.length || a.host.localeCompare(b.host));
  return {
    app: { id: t.app.id, name: t.app.name },
    container: t.name,
    version: raw.version,
    major: majorOf(raw.version),
    startedAt: raw.started ? raw.started * 1000 : null,
    hosts,
    routeHost: route?.host ?? null,
    config,
    publicBase: getSetting("publicHost").trim() ? publicBaseUrl() : null,
    checkedAt: Date.now(),
  };
}

function readOr(p: string): string | null {
  try {
    return fs.readFileSync(hostPath(p), "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- accounts

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ROLE_NAME: Record<"member" | "admin", string> = { member: "prosody:member", admin: "prosody:admin" };

function checkHost(snap: { hosts: { host: string }[] } | null, host: string) {
  if (!/^[a-z0-9.-]{1,253}$/.test(host)) throw new AppError("invalid", "That isn't a chat domain on this server.", 400, { field: "host" });
  if (snap && !snap.hosts.some((h) => h.host === host)) throw new AppError("invalid", `${host} isn't a chat domain on this server.`, 400, { field: "host" });
}

export async function createAccount(t: ProsodyTarget, a: { host: string; user: string; password: string; role: "member" | "admin" }) {
  checkHost(null, a.host);
  return prosodyLua<true>(
    t,
    `local um=require"core.usermanager";
     if um.user_exists(A.user,A.host) then error("There's already an account called "..A.user.."@"..A.host..".") end;
     local ok,err;
     if um.create_user_with_role then ok,err=um.create_user_with_role(A.user,A.password,A.host,A.role) else ok,err=um.create_user(A.user,A.password,A.host) end;
     if not ok then error(err or "Prosody didn't create the account.") end;
     return true`,
    { ...a, role: ROLE_NAME[a.role] },
  );
}

/** Close the account's connections; with `resource`, only that device. */
const CLOSE = `local function close(user,host,resource,text) local n=0; local us=prosody.hosts[host] and prosody.hosts[host].sessions[user]; if not us then return 0 end;
  local list={}; for res,s in pairs(us.sessions or {}) do if not resource or res==resource then list[#list+1]=s end end;
  for _,s in ipairs(list) do s:close({condition="not-authorized", text=text}); n=n+1 end; return n end;`;

export async function updateAccount(
  t: ProsodyTarget,
  a: { host: string; user: string; password?: string; role?: "member" | "admin"; enabled?: boolean; signOut?: boolean | string },
): Promise<{ closed: number }> {
  checkHost(null, a.host);
  return prosodyLua<{ closed: number }>(
    t,
    `local um=require"core.usermanager"; ${CLOSE}
     if not um.user_exists(A.user,A.host) then error(A.user.."@"..A.host.." doesn't exist any more.") end;
     local closed=0;
     if A.password then local ok,err=um.set_password(A.user,A.password,A.host,nil); if not ok then error(err or "Prosody didn't change the password.") end end;
     if A.role then if not um.set_user_role then error("Roles need Prosody 13 or newer.") end; local ok,err=um.set_user_role(A.user,A.host,A.role); if not ok then error(err or "Prosody didn't change the role.") end end;
     if A.enabled==false then local ok,err=um.disable_user(A.user,A.host,{reason="Turned off in Gluon"}); if not ok then error(err or "Prosody didn't turn the account off.") end; closed=closed+close(A.user,A.host,nil,"This account was turned off.") end;
     if A.enabled==true then local ok,err=um.enable_user(A.user,A.host); if not ok then error(err or "Prosody didn't turn the account on.") end end;
     if A.signOut==true then closed=closed+close(A.user,A.host,nil,"Signed out by the server admin.") elseif type(A.signOut)=="string" then closed=closed+close(A.user,A.host,A.signOut,"Signed out by the server admin.") end;
     return {closed=closed}`,
    { ...a, role: a.role ? ROLE_NAME[a.role] : undefined },
  );
}

export async function deleteAccount(t: ProsodyTarget, a: { host: string; user: string }) {
  checkHost(null, a.host);
  return prosodyLua<true>(
    t,
    `local um=require"core.usermanager"; ${CLOSE}
     if not um.user_exists(A.user,A.host) then return true end;
     close(A.user,A.host,nil,"This account was deleted.");
     local ok,err=um.delete_user(A.user,A.host); if not ok then error(err or "Prosody didn't delete the account.") end;
     return true`,
    a,
  );
}

// ---------------------------------------------------------------- invites

export async function createInvite(
  t: ProsodyTarget,
  a: { host: string; username: string | null; role: "member" | "admin"; days: number; reusable: boolean },
): Promise<ChatInvite> {
  checkHost(null, a.host);
  const raw = await prosodyLua<{ token: string; jid: string; created_at: number; expires: number; uri: string; landing_page?: string; reusable?: boolean }>(
    t,
    `local h=prosody.hosts[A.host]; local inv=h and h.modules.invites;
     if not inv then error("Invites aren't turned on for "..A.host..". Turn them on in Settings first.") end;
     if A.username and require"core.usermanager".user_exists(A.username,A.host) then error("There's already an account called "..A.username.."@"..A.host..".") end;
     local ttl=A.days*86400; local data={roles={A.role}};
     local i, err;
     if A.reusable then i,err=inv.create_group({}, data, ttl) else i,err=inv.create_account(A.username, data, ttl) end;
     if not i then error(err or "Prosody didn't create the invite.") end;
     return i`,
    { ...a, role: ROLE_NAME[a.role], username: a.username || null },
  );
  return {
    token: raw.token,
    username: raw.jid.includes("@") ? raw.jid.split("@")[0]! : null,
    role: a.role,
    created: raw.created_at * 1000,
    expires: raw.expires * 1000,
    uri: raw.uri,
    page: raw.landing_page ?? null,
    reusable: !!raw.reusable,
    reset: false,
  };
}

export async function revokeInvite(t: ProsodyTarget, a: { host: string; token: string }) {
  checkHost(null, a.host);
  return prosodyLua<true>(
    t,
    `local inv=prosody.hosts[A.host] and prosody.hosts[A.host].modules.invites; if not inv then return true end;
     inv.delete_account_invite(A.token); return true`,
    a,
  );
}

/** For the public invite page: is this token a live account invite on that host? */
export async function peekChatInvite(t: ProsodyTarget, a: { host: string; token: string }): Promise<{ expires: number; username: string | null; uri: string } | null> {
  const r = await prosodyLua<{ expires: number; jid: string; uri: string } | null>(
    t,
    `local inv=prosody.hosts[A.host] and prosody.hosts[A.host].modules.invites; if not inv then return nil end;
     local i=inv.get_account_invite_info(A.token); if not i then return nil end;
     return {expires=i.expires, jid=i.jid, uri=i.uri}`,
    a,
  );
  return r ? { expires: r.expires * 1000, username: r.jid.includes("@") ? r.jid.split("@")[0]! : null, uri: r.uri } : null;
}

// ---------------------------------------------------------------- rooms

export async function createRoom(t: ProsodyTarget, a: { service: string; room: string; name: string; description: string | null; public: boolean; membersOnly: boolean; owner: string | null }) {
  return prosodyLua<{ jid: string }>(
    t,
    `local h=prosody.hosts[A.service]; local muc=h and h.modules.muc; if not muc then error(A.service.." isn't a group chat service.") end;
     local jid=A.room.."@"..A.service; if muc.get_room_from_jid(jid) then error("There's already a group chat called "..jid..".") end;
     local r,err=muc.create_room(jid); if not r then error(err or "Prosody didn't create the group chat.") end;
     r:set_name(A.name); if A.description then r:set_description(A.description) end;
     r:set_public(A.public); r:set_members_only(A.membersOnly); r:set_persistent(true);
     if A.owner then r:set_affiliation(true, A.owner, "owner") end;
     r:save(true);
     return {jid=jid}`,
    a,
  );
}

export async function destroyRoom(t: ProsodyTarget, a: { jid: string; reason: string | null }) {
  return prosodyLua<true>(
    t,
    `local _,service=require"util.jid".split(A.jid); local h=prosody.hosts[service]; local muc=h and h.modules.muc;
     if not muc then error(service.." isn't a group chat service.") end;
     local r=muc.get_room_from_jid(A.jid); if not r then return true end;
     local ok,err=r:destroy(nil, A.reason or "This group chat was closed by the server admin."); if ok==false then error(err or "Prosody didn't close the group chat.") end; return true`,
    a,
  );
}

// ---------------------------------------------------------------- settings and config

function hostFile(snap: ConfigPlace): string {
  if (!snap.config.hostPath) throw new AppError("config_unavailable", snap.config.reason ?? "Gluon can't find Prosody's config file.", 409);
  if (!snap.config.writable) throw new AppError("config_readonly", snap.config.reason ?? "Gluon can't change Prosody's config file.", 409);
  return snap.config.hostPath;
}

function writeLike(file: string, text: string, like: string) {
  const p = hostPath(file);
  const tmp = `${p}.gluon-tmp-${process.pid}`;
  let st: fs.Stats | null = null;
  let mode = 0o644;
  try {
    st = fs.statSync(hostPath(like));
    // Same owner and permissions as the file it sits beside: Debian ships Prosody's config as
    // 0640 root:prosody because it can hold secrets.
    mode = st.mode & 0o777;
  } catch {
    // Nothing to copy: owned like its folder (which Prosody can read), and readable, since
    // nothing Gluon writes on its own holds a secret.
    try {
      st = fs.statSync(hostPath(path.posix.dirname(file)));
    } catch {
      st = null;
    }
  }
  fs.writeFileSync(tmp, text, { mode });
  try {
    fs.chmodSync(tmp, mode);
    if (st) fs.chownSync(tmp, st.uid, st.gid);
  } catch {
    /* best effort: Prosody only needs to read it */
  }
  fs.renameSync(tmp, p);
}

/** Copy the person's config aside once, before Gluon first touches it. */
function backupOnce(file: string) {
  const backup = `${file}.before-gluon`;
  if (fs.existsSync(hostPath(file)) && !fs.existsSync(hostPath(backup))) fs.copyFileSync(hostPath(file), hostPath(backup));
}

/** Changes when Gluon's file or the person's changes, so a save from a stale page is refused. */
function withRev(placed: Omit<ChatSnapshot["config"], "rev">): ChatSnapshot["config"] {
  const gluonText = placed.hostPath ? readOr(path.posix.join(path.posix.dirname(placed.hostPath), GLUON_CONFIG)) : null;
  const rev = crypto.createHash("sha256").update(`${gluonText ?? ""}\0${placed.hostPath ? (readOr(placed.hostPath) ?? "") : ""}`).digest("hex").slice(0, 16);
  return { ...placed, rev };
}

type ConfigPlace = Pick<ChatSnapshot, "config">;

/**
 * Where the config is, without needing Prosody's console: prosodyctl reads the whole config before
 * it does anything, so a broken file would otherwise lock the person out of the editor that fixes it.
 */
async function locateConfig(appId: string): Promise<ConfigPlace> {
  try {
    return { config: (await chatSnapshot(appId)).config };
  } catch {
    const t = await prosodyFor(appId);
    return { config: withRev(await configOnHost(t, "/etc/prosody/prosody.cfg.lua")) };
  }
}

export async function readConfigFiles(appId: string): Promise<ChatConfigFiles & { snap: ConfigPlace }> {
  const snap = await locateConfig(appId);
  if (!snap.config.hostPath) throw new AppError("config_unavailable", snap.config.reason ?? "Gluon can't find Prosody's config file.", 409);
  const main = readOr(snap.config.hostPath) ?? (snap.config.layout === "confd" ? CUSTOM_STARTER : null);
  if (main === null) throw new AppError("config_unavailable", `Gluon can't read ${snap.config.hostPath}.`, 409);
  return { main, gluon: readOr(path.posix.join(path.posix.dirname(snap.config.hostPath), GLUON_CONFIG)), file: snap.config.hostPath, snap };
}

export async function reloadProsody(t: ProsodyTarget): Promise<{ loaded: string[]; unloaded: string[]; failed: string[] }> {
  // Reloading updates settings but doesn't load or unload modules, so do that for the ones
  // Gluon turns on and off. Others (dependencies, ones loaded by hand) are left alone. Group chat
  // and upload services read their options when they load, so they're reloaded too (rooms keep).
  const body = `local ok,err=prosody.reload_config(); if ok==false then error(err or "Prosody couldn't read its config.") end;
    local mm=require"core.modulemanager"; local managed=A.managed; local loaded,unloaded,failed={},{},{};
    for host,h in pairs(prosody.hosts) do if h.type=="local" then
      local want=mm.get_modules_for_host(host);
      for _,name in ipairs(managed) do
        local on=mm.is_loaded(host,name);
        if want:contains(name) and not on then local ok2,e=pcall(mm.load,host,name); if ok2 and mm.is_loaded(host,name) then loaded[#loaded+1]=name else failed[#failed+1]=name..": "..tostring(e) end
        elseif on and not want:contains(name) then pcall(mm.unload,host,name); unloaded[#unloaded+1]=name end;
      end;
    end end;
    for host,h in pairs(prosody.hosts) do if h.type=="component" then
      local cmod=require"core.configmanager".get(host,"component_module");
      if (cmod=="muc" or cmod=="http_file_share") and mm.is_loaded(host,cmod) then local ok2,e=pcall(mm.reload,host,cmod); if not ok2 then failed[#failed+1]=cmod..": "..tostring(e) end end;
    end end;
    return {loaded=loaded, unloaded=unloaded, failed=failed}`;
  // prosodyctl reads the config itself before it connects; a file replaced a moment ago can be
  // briefly missing on some shared folders, so try again before calling it broken.
  for (let i = 0; ; i++) {
    try {
      return await prosodyLua<{ loaded: string[]; unloaded: string[]; failed: string[] }>(t, body, { managed: MANAGED_MODULES });
    } catch (e) {
      if (i >= 4 || !/config(uration)? file/i.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}

export async function restartProsody(t: ProsodyTarget) {
  await docker().getContainer(t.id).restart({ t: 10 });
}

/**
 * Check a config file Prosody would load, with prosodyctl, without loading it. The candidate gets
 * a name of its own (two checks can't trip over each other) that no include pattern matches. In
 * the conf.d layout it stands in for custom.lua through a copy of gluon.cfg.lua, so a broken file
 * on disk doesn't stop its fix from passing.
 */
export async function checkConfigText(t: ProsodyTarget, snap: ConfigPlace, text: string): Promise<{ ok: boolean; line: number | null; message: string; output: string }> {
  const main = hostFile(snap);
  const dir = path.posix.dirname(main);
  const inDir = path.posix.dirname(snap.config.file!);
  const tag = crypto.randomBytes(6).toString("hex");
  const candidate = `.gluon-check-${tag}.lua`;
  const written = [path.posix.join(dir, candidate)];
  writeLike(written[0]!, text, main);
  let argv = ["prosodyctl", "--config", path.posix.join(inDir, candidate), "check", "config"];
  let env: Record<string, string> | undefined;
  if (snap.config.layout === "confd") {
    const gluonText = readOr(path.posix.join(dir, GLUON_CONFIG)) ?? "";
    const stand = `.gluon-check-${tag}-g.lua`;
    const swapped = gluonText.includes(snap.config.file!) ? gluonText.split(snap.config.file!).join(path.posix.join(inDir, candidate)) : `${gluonText}\nHost "*"\nInclude "${path.posix.join(inDir, candidate)}"\n`;
    written.push(path.posix.join(dir, stand));
    writeLike(written[1]!, swapped, main);
    argv = ["prosodyctl", "check", "config"];
    env = { PROSODY_EXTRA_CONFIG: path.posix.join(inDir, stand) };
  }
  try {
    const r = await execWithInput(t.id, argv, "", { user: "prosody", timeoutMs: 30_000, env });
    const output = `${r.stdout}\n${r.stderr}`
      .replace(/\*{5,}\s*\n(?:(?!\*{5,})[\s\S])*?lua-unbound[\s\S]*?\*{5,}\n?/g, "")
      .split("\n")
      .filter((l) => !/^certmanager\s+error\s+Error indexing certificate directory/.test(l))
      .join("\n")
      .split(candidate)
      .join(path.posix.basename(snap.config.file!))
      .trim();
    const err = output.match(/Error:\s*(?:[^\n:]*?:(\d+):\s*)?(.+)/);
    // A relative certificate folder resolves next to the candidate and logs an error that has
    // nothing to do with the text; Prosody's own verdict is the line that counts.
    const passed = /All checks passed|^Done\.$/m.test(output);
    if (err || (r.exitCode !== 0 && !passed)) {
      const inFile = !!err && new RegExp(`${path.posix.basename(snap.config.file!).replace(/[.]/g, "\\.")}:\\d+`).test(err[0]);
      return { ok: false, line: inFile && err?.[1] ? Number(err[1]) : null, message: err?.[2]?.trim() ?? "Prosody found a problem in the config.", output };
    }
    return { ok: true, line: null, message: "Prosody can read this config.", output };
  } finally {
    for (const f of written) {
      try {
        fs.unlinkSync(hostPath(f));
      } catch {
        /* already gone */
      }
    }
  }
}

export async function saveMainConfig(t: ProsodyTarget, snap: ConfigPlace, text: string) {
  const file = hostFile(snap);
  backupOnce(file);
  writeLike(file, text.endsWith("\n") ? text : `${text}\n`, file);
}

/** Write gluon.cfg.lua for these settings and make sure the main config includes it. */
export function writeSettings(snap: ChatSnapshot, host: ChatHostSnapshot, s: ChatSettings) {
  const file = hostFile(snap);
  const dir = path.posix.dirname(file);
  const confd = snap.config.layout === "confd";
  if (confd && !fs.existsSync(hostPath(file))) writeLike(file, CUSTOM_STARTER, path.posix.join(dir, GLUON_CONFIG));
  const text = renderGluonConfig(s, { host: host.host, ownComponents: host.ownComponents, publicBase: snap.publicBase, layout: snap.config.layout, customPath: confd ? (snap.config.file ?? undefined) : undefined });
  writeLike(path.posix.join(dir, GLUON_CONFIG), text, confd && fs.existsSync(hostPath(path.posix.join(dir, GLUON_CONFIG))) ? path.posix.join(dir, GLUON_CONFIG) : file);
  if (confd) return;
  const main = readOr(file) ?? "";
  const inc = withInclude(main);
  if (inc.changed) {
    backupOnce(file);
    writeLike(file, inc.text, file);
  }
}

export type { ChatAccount };

// ---------------------------------------------------------------- for Network

const signUpCache = new Map<string, { at: number; value: boolean | null }>();

/**
 * Whether strangers can really make an account on `host`, asked of Prosody itself. The stream
 * features probe can't tell: invite-only servers still advertise registration for invite holders.
 * null when this isn't a Prosody Gluon can reach. Cached for five minutes.
 */
export async function openSignUp(appId: string | undefined, host: string): Promise<boolean | null> {
  if (!appId) return null;
  const key = `${appId}:${host}`;
  const hit = signUpCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  let value: boolean | null = null;
  try {
    const t = await prosodyFor(appId);
    const r = await prosodyLua<{ allow?: boolean; inviteOnly?: boolean; invites: boolean }>(
      t,
      `local cm=require"core.configmanager"; local h=prosody.hosts[A.host]; if not h then return {invites=false} end;
       return {allow=cm.get(A.host,"allow_registration"), inviteOnly=cm.get(A.host,"registration_invite_only"), invites=h.modules.invites_register~=nil}`,
      { host },
    );
    value = signUpFrom(r.allow, r.inviteOnly, r.invites) === "open";
  } catch {
    value = null;
  }
  signUpCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * The installer's conf.d layout, written straight to the app's folder: used before Prosody is up,
 * so a broken earlier attempt can be put right without Prosody's help.
 */
export function writeConfd(confdOnHost: string, settings: ChatSettings, ctx: { host: string; publicBase: string | null }) {
  const custom = path.posix.join(confdOnHost, CUSTOM_CONFIG);
  const gluon = path.posix.join(confdOnHost, GLUON_CONFIG);
  fs.mkdirSync(hostPath(confdOnHost), { recursive: true });
  if (!fs.existsSync(hostPath(custom))) writeLike(custom, CUSTOM_STARTER, gluon);
  writeLike(gluon, renderGluonConfig(settings, { host: ctx.host, ownComponents: { muc: null, files: null }, publicBase: ctx.publicBase, layout: "confd" }), gluon);
}

/** Put a private file (0600, owned by prosody) into the Prosody container, e.g. the call relay's secret. */
export async function putProsodyFile(t: ProsodyTarget, file: string, data: string) {
  const o = await prosodyOwner(t);
  const tar = writeTar([{ name: path.posix.basename(file), data: Buffer.from(data), mode: 0o600, uid: o.uid, gid: o.gid }]);
  await docker().getContainer(t.id).putArchive(tar, { path: path.posix.dirname(file) });
}
