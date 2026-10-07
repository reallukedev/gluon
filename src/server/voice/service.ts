import "server-only";
import { token } from "../crypto";
import { audit } from "../audit";
import { AppError } from "../errors";
import { lanHost } from "../docker/apps";
import { startJob, type Emit } from "../appstore/jobs";
import { appDetail } from "../appstore/service";
import type { User } from "../auth/users";
import { connect, iceError, iceId, iceVersion, isUnreachable, MumbleServer, type MumbleConn } from "./ice";
import { countConnections, mumbleFacts, type MumbleFacts } from "./container";
import { applyChange, changeTarget, freeIcePort } from "./apply";
import { editServiceEnv, iceEnvFile, manageCompose } from "./compose-edit";
import { getVoice, saveVoice, type IceSecrets } from "./store";
import { asBool, effectiveSettings, envFor, settingDef, toStored } from "./settings-map";
import { certView } from "./certs";
import type { ManagePlan, VoiceChannel, VoiceDetails, VoiceLive, VoiceProblemCode, VoiceRegistered, VoiceUser } from "./types";

type Where = { ip?: string; zone?: string };
const LOCAL = process.env.GLUON_LOCAL_HOST ?? "127.0.0.1";

// ---------------------------------------------------------------- connecting

class Problem extends AppError {
  constructor(
    public readonly kind: VoiceProblemCode,
    message: string,
  ) {
    super(`voice_${kind}`, message, 409);
  }
}

/** The app's facts and a live Ice connection, or a Problem saying why there isn't one. */
async function open(appId: string, f?: MumbleFacts): Promise<{ f: MumbleFacts; c: MumbleConn }> {
  f ??= await mumbleFacts(appId);
  if (!f.running) throw new Problem("stopped", `${f.app.name} is stopped.`);
  if (!f.icePort) throw new Problem("not_managed", "Gluon can't reach Mumble's admin connection yet.");
  const rec = getVoice(appId);
  try {
    const c = await connect({ host: LOCAL, port: f.icePort, secret: rec?.secrets?.write ?? "" });
    return { f, c };
  } catch (e) {
    const id = iceId(e) ?? "";
    if (/InvalidSecret/.test(id)) throw new Problem("wrong_secret", rec?.secrets ? "Mumble refused the secret Gluon has for it, so its Ice secret was changed outside Gluon." : "Mumble's admin connection needs a secret Gluon doesn't have.");
    if (isUnreachable(e)) {
      const young = f.startedAt !== null && Date.now() - f.startedAt < 30_000;
      if (young) throw new Problem("booting", "Mumble is still starting.");
      const answers = await iceVersion({ host: LOCAL, port: f.icePort }).then(() => true, () => false);
      throw new Problem("unreachable", answers ? "Mumble's admin connection answers but refused Gluon." : `Nothing answers on Mumble's admin port (127.0.0.1:${f.icePort}).`);
    }
    throw iceError(e, "Connecting to Mumble");
  }
}

async function live(appId: string): Promise<MumbleConn> {
  try {
    return (await open(appId)).c;
  } catch (e) {
    if (e instanceof Problem) throw new AppError(e.code, e.kind === "stopped" ? e.message : `${e.message} Open the Voice server tab to fix it.`, 409);
    throw e;
  }
}

// ---------------------------------------------------------------- reading

function ip(addr: Uint8Array | null | undefined): string | null {
  if (!addr || addr.length !== 16) return null;
  const v4mapped = addr.slice(0, 10).every((b) => b === 0) && addr[10] === 0xff && addr[11] === 0xff;
  if (v4mapped) return `${addr[12]}.${addr[13]}.${addr[14]}.${addr[15]}`;
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(((addr[i]! << 8) | addr[i + 1]!).toString(16));
  return parts.join(":").replace(/(^|:)0(:0)+(:|$)/, "::");
}

function toUser(u: MumbleServer.User): VoiceUser {
  const os = [u.os, u.osversion].filter(Boolean).join(" ").trim();
  const ping = u.udpPing > 0 ? u.udpPing : u.tcpPing > 0 ? u.tcpPing : null;
  return {
    session: u.session,
    userId: u.userid,
    name: u.name,
    channel: u.channel,
    mute: u.mute,
    deaf: u.deaf,
    selfMute: u.selfMute,
    selfDeaf: u.selfDeaf,
    suppress: u.suppress,
    recording: u.recording,
    prioritySpeaker: u.prioritySpeaker,
    onlineSecs: u.onlinesecs,
    idleSecs: u.idlesecs,
    client: u.release ? `Mumble ${u.release.replace(/^Mumble\s+/i, "")}` : null,
    os: os || null,
    address: ip(u.address),
    tcpOnly: u.tcponly,
    pingMs: ping === null ? null : Math.round(ping),
  };
}

const toChannel = (c: MumbleServer.Channel): VoiceChannel => ({ id: c.id, name: c.name, parent: c.parent, description: c.description, position: c.position, temporary: c.temporary, links: [...c.links] });

const obj = (m: Map<string, string>) => Object.fromEntries(m.entries());

async function address(f: MumbleFacts): Promise<VoiceLive["address"]> {
  if (!f.voiceHostPort) return null;
  const route = f.app.routes.find((r) => r.type === "subdomain" && r.enabled) ?? f.app.routes.find((r) => r.type === "subdomain");
  const host = route ? new URL(route.url).hostname : await lanHost().catch(() => null);
  return host && host !== "localhost" ? { host, port: f.voiceHostPort } : { host: LOCAL, port: f.voiceHostPort };
}

/** Everything the tab shows at a glance, polled every few seconds. */
export async function voiceLive(appId: string): Promise<VoiceLive> {
  const f = await mumbleFacts(appId);
  const { option } = await changeTarget(f);
  const base: VoiceLive = {
    appId,
    appName: f.app.name,
    running: f.running,
    managed: false,
    problem: null,
    container: { name: f.name, image: f.image, version: f.version, ports: f.ports, startedAt: f.startedAt },
    basics: {
      welcome: envFor("welcometext", f.env)?.value ?? null,
      passwordSet: !!envFor("serverpassword", f.env)?.value,
      maxUsers: Number(envFor("users", f.env)?.value) || 100,
      connected: null,
      port: f.voiceHostPort,
    },
    manage: option,
    server: null,
    users: [],
    channels: [],
    defaultChannel: 0,
    address: await address(f),
  };
  try {
    const { c } = await open(appId, f);
    const [users, channels, conf, defaults, version, uptime] = await Promise.all([
      c.server.getUsers(),
      c.server.getChannels(),
      c.server.getAllConf(),
      c.meta.getDefaultConf(),
      c.meta.getVersion() as unknown as Promise<[number, number, number, string]>,
      c.server.getUptime(),
    ]);
    const db = obj(conf);
    const dflt = obj(defaults);
    const users2 = [...users.values()].map(toUser).sort((a, b) => a.name.localeCompare(b.name));
    return {
      ...base,
      managed: true,
      server: { id: c.serverId, version: version[3], uptimeSecs: uptime, others: c.others },
      users: users2,
      channels: [...channels.values()].map(toChannel),
      defaultChannel: [...channels.keys()].includes(Number(db.defaultchannel || dflt.defaultchannel || 0)) ? Number(db.defaultchannel || dflt.defaultchannel || 0) : 0,
      basics: {
        ...base.basics,
        welcome: db.welcometext || dflt.welcometext || null,
        passwordSet: !!(db.password || dflt.password),
        maxUsers: Number(db.users || dflt.users) || base.basics.maxUsers,
        connected: users2.length,
      },
    };
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    base.problem = { code: e.kind, message: e.message };
    if (e.kind !== "stopped") base.basics.connected = await countConnections(f);
    else base.basics.connected = 0;
    return base;
  }
}

/** Registrations, settings and the certificate: read when the tab opens and after changes. */
export async function voiceDetails(appId: string): Promise<VoiceDetails> {
  const f = await mumbleFacts(appId);
  const notes: string[] = [];
  if (f.env.MUMBLE_CUSTOM_CONFIG_FILE) notes.push(`Mumble reads its settings from ${f.env.MUMBLE_CUSTOM_CONFIG_FILE}, so MUMBLE_CONFIG_ variables in the compose file are ignored.`);
  let c: MumbleConn | null = null;
  try {
    c = (await open(appId, f)).c;
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
  }
  const cert = await certView(appId, f, c);
  if (!c) return { managed: false, registered: [], settings: effectiveSettings({ db: {}, defaults: {}, env: f.env }), cert, notes };

  const [names, users, conf, defaults] = await Promise.all([c.server.getRegisteredUsers(""), c.server.getUsers(), c.server.getAllConf(), c.meta.getDefaultConf()]);
  const online = new Set([...users.values()].map((u) => u.userid));
  const ids = [...names.keys()].sort((a, b) => a - b).slice(0, 300);
  const regs = await Promise.all(
    ids.map(async (id): Promise<VoiceRegistered> => {
      const info = await c!.server.getRegistration(id).catch(() => null);
      const last = info?.get(MumbleServer.UserInfo.UserLastActive) ?? "";
      return { id, name: names.get(id) ?? `#${id}`, lastActive: last ? last.replace(" ", "T") + (last.endsWith("Z") ? "" : "Z") : null, hasCertificate: !!info?.get(MumbleServer.UserInfo.UserHash), online: online.has(id) };
    }),
  );
  return { managed: true, registered: regs, settings: effectiveSettings({ db: obj(conf), defaults: obj(defaults), env: f.env }), cert, notes };
}

// ---------------------------------------------------------------- changing things live

export type VoiceOp =
  | { op: "kick"; session: number; reason: string }
  | { op: "move"; session: number; channel: number }
  | { op: "mute"; session: number; on: boolean }
  | { op: "deafen"; session: number; on: boolean }
  | { op: "channel.create"; name: string; parent: number }
  | { op: "channel.update"; id: number; name?: string; parent?: number; description?: string }
  | { op: "channel.delete"; id: number }
  | { op: "channel.default"; id: number }
  | { op: "registered.create"; name: string; password: string }
  | { op: "registered.rename"; id: number; name: string }
  | { op: "registered.password"; id: number; password: string }
  | { op: "registered.delete"; id: number }
  | { op: "setting"; key: string; value: string }
  | { op: "setting.reset"; key: string };

const CHANNEL_NAME = /^[^\n\r\t/]{1,100}$/;
const USER_NAME = /^[^\n\r\t]{1,128}$/;

/** Do one thing on the live server, and record it. Returns a sentence for the toast. */
export async function voiceAct(appId: string, a: VoiceOp, user: User, where: Where): Promise<string> {
  const c = await live(appId);
  const s = c.server;
  const facts = await mumbleFacts(appId);
  const app = facts.app.name;
  const record = (summary: string, detail?: unknown) => audit(user, { action: `voice.${a.op}`, target: appId, summary, detail }, where);
  const userBy = async (session: number) => s.getState(session).catch((e) => Promise.reject(iceError(e)));
  const channelName = async (id: number) => {
    const name = (await s.getChannelState(id).catch((e) => Promise.reject(iceError(e)))).name;
    // Mumble apps show the server name on the top channel.
    return id === 0 ? (await s.getConf("registername").catch(() => "")) || name : name;
  };
  try {
    switch (a.op) {
      case "kick": {
        const u = await userBy(a.session);
        await s.kickUser(a.session, a.reason.trim());
        record(`Removed ${u.name} from ${app}`, { reason: a.reason.trim() || null });
        return `${u.name} was removed. They can join again.`;
      }
      case "move": {
        const u = await userBy(a.session);
        const to = await channelName(a.channel);
        u.channel = a.channel;
        await s.setState(u);
        record(`Moved ${u.name} to ${to} on ${app}`);
        return `Moved ${u.name} to ${to}.`;
      }
      case "mute":
      case "deafen": {
        const u = await userBy(a.session);
        if (a.op === "mute") {
          u.mute = a.on;
          if (!a.on) u.deaf = false;
        } else {
          u.deaf = a.on;
          if (a.on) u.mute = true;
        }
        await s.setState(u);
        const verb = a.op === "mute" ? (a.on ? "Muted" : "Unmuted") : a.on ? "Deafened" : "Undeafened";
        record(`${verb} ${u.name} on ${app}`);
        return `${verb} ${u.name}.`;
      }
      case "channel.create": {
        const name = a.name.trim();
        if (!CHANNEL_NAME.test(name)) throw new AppError("invalid", "Give the channel a name (no slashes, up to 100 characters).", 400, { field: "name" });
        const id = await s.addChannel(name, a.parent);
        record(`Added the channel ${name} on ${app}`, { id, parent: a.parent });
        return `Added ${name}.`;
      }
      case "channel.update": {
        const ch = await s.getChannelState(a.id);
        const before = ch.name;
        const changed: string[] = [];
        if (a.name !== undefined) {
          const name = a.name.trim();
          if (a.id === 0) throw new AppError("invalid", "The top channel takes the server's name. Change the server name in Settings instead.", 400, { field: "name" });
          if (!CHANNEL_NAME.test(name)) throw new AppError("invalid", "Give the channel a name (no slashes, up to 100 characters).", 400, { field: "name" });
          if (name !== ch.name) changed.push(`renamed it to ${name}`);
          ch.name = name;
        }
        if (a.parent !== undefined && a.parent !== ch.parent) {
          if (a.id === 0) throw new AppError("invalid", "The top channel can't move.", 400);
          const all = await s.getChannels();
          for (let p: number | undefined = a.parent; p !== undefined && p >= 0; p = all.get(p)?.parent) {
            if (p === a.id) throw new AppError("invalid", "A channel can't move inside itself.", 400, { field: "parent" });
          }
          ch.parent = a.parent;
          changed.push(`moved it under ${all.get(a.parent)?.name ?? "the top"}`);
        }
        if (a.description !== undefined && a.description !== ch.description) {
          if (a.description.length > 5000) throw new AppError("invalid", "Keep the description under 5,000 characters.", 400, { field: "description" });
          ch.description = a.description;
          changed.push(a.description ? "changed its description" : "removed its description");
        }
        if (!changed.length) return "Nothing to change.";
        await s.setChannelState(ch);
        record(`Changed the channel ${before} on ${app}: ${changed.join(", ")}`);
        return `Saved ${ch.name}.`;
      }
      case "channel.delete": {
        if (a.id === 0) throw new AppError("invalid", "The top channel can't be deleted.", 400);
        const name = await channelName(a.id);
        // Mumble keeps pointing new people at a deleted default channel; send them to the top instead.
        const all = await s.getChannels();
        const gone = new Set([a.id]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const c of all.values()) {
            if (gone.has(c.id) || !gone.has(c.parent)) continue;
            gone.add(c.id);
            grew = true;
          }
        }
        const dflt = Number((await s.getConf("defaultchannel")) || 0);
        await s.removeChannel(a.id);
        if (gone.has(dflt)) await s.setConf("defaultchannel", "");
        record(`Deleted the channel ${name} on ${app}`);
        return `Deleted ${name}. Anyone in it moved up a level.`;
      }
      case "channel.default": {
        const name = await channelName(a.id);
        await s.setConf("defaultchannel", String(a.id));
        record(`Made ${name} the channel people join on ${app}`);
        return `New people now land in ${name}.`;
      }
      case "registered.create": {
        const name = a.name.trim();
        if (!USER_NAME.test(name)) throw new AppError("invalid", "Enter a name.", 400, { field: "name" });
        if (a.password.length < 8) throw new AppError("invalid", "Use at least 8 characters.", 400, { field: "password" });
        const info = new MumbleServer.UserInfoMap();
        info.set(MumbleServer.UserInfo.UserName, name);
        info.set(MumbleServer.UserInfo.UserPassword, a.password);
        const id = await s.registerUser(info);
        if (id < 0) throw new AppError("invalid", `Mumble already has someone called ${name}.`, 409, { field: "name" });
        record(`Registered ${name} on ${app}`);
        return `Registered ${name}.`;
      }
      case "registered.rename": {
        if (a.id === 0) throw new AppError("invalid", "SuperUser is Mumble's built-in admin and keeps its name.", 400);
        const name = a.name.trim();
        if (!USER_NAME.test(name)) throw new AppError("invalid", "Enter a name.", 400, { field: "name" });
        const before = (await s.getUserNames([a.id])).get(a.id) ?? `#${a.id}`;
        const info = new MumbleServer.UserInfoMap();
        info.set(MumbleServer.UserInfo.UserName, name);
        await s.updateRegistration(a.id, info);
        record(`Renamed ${before} to ${name} on ${app}`);
        return `${before} is now ${name}.`;
      }
      case "registered.password": {
        if (a.password.length < 8) throw new AppError("invalid", "Use at least 8 characters.", 400, { field: "password" });
        if (a.id === 0) {
          await s.setSuperuserPassword(a.password);
          record(`Reset the admin (SuperUser) password of ${app}`);
          return "Saved the new SuperUser password.";
        }
        const name = (await s.getUserNames([a.id])).get(a.id) ?? `#${a.id}`;
        const info = new MumbleServer.UserInfoMap();
        info.set(MumbleServer.UserInfo.UserPassword, a.password);
        await s.updateRegistration(a.id, info);
        record(`Set a new password for ${name} on ${app}`);
        return `Saved ${name}'s new password.`;
      }
      case "registered.delete": {
        if (a.id === 0) throw new AppError("invalid", "SuperUser is Mumble's built-in admin and can't be removed.", 400);
        const name = (await s.getUserNames([a.id])).get(a.id) ?? `#${a.id}`;
        await s.unregisterUser(a.id);
        record(`Removed the registration of ${name} on ${app}`);
        return `${name} is no longer registered.`;
      }
      case "setting": {
        const d = settingDef(a.key);
        if (!d) throw new AppError("invalid", "That isn't a setting Gluon knows.", 400);
        const v = toStored(d, a.value);
        if (!v.ok) throw new AppError("invalid", v.message, 400, { field: a.key });
        if (d.key === "password" && v.value === "") throw new AppError("invalid", "Use Remove the password instead.", 400, { field: a.key });
        await s.setConf(d.key, v.value);
        record(d.kind === "secret" ? `Changed the ${d.label.toLowerCase()} of ${app}` : `Set ${d.label.toLowerCase()} on ${app}`, d.kind === "secret" ? undefined : { value: d.kind === "richtext" ? `${v.value.length} characters` : v.value });
        return d.kind === "bool" ? `${d.label}: ${asBool(v.value) ? "on" : "off"}.` : `Saved ${d.label.toLowerCase()}.`;
      }
      case "setting.reset": {
        const d = settingDef(a.key);
        if (!d) throw new AppError("invalid", "That isn't a setting Gluon knows.", 400);
        await s.setConf(d.key, "");
        const fromFile = !!envFor(d.iniKey, facts.env);
        record(d.key === "password" ? `Removed the join password of ${app}` : `Put ${d.label.toLowerCase()} back to ${fromFile ? "the app's own value" : "Mumble's default"} on ${app}`);
        return d.key === "password" ? "Removed the password." : fromFile ? `${d.label} is back to the app's own value.` : `${d.label} is back to Mumble's default.`;
      }
    }
  } catch (e) {
    throw iceError(e);
  }
}

// ---------------------------------------------------------------- letting Gluon manage it

const jobKey = (appId: string) => `voice:${appId}`;

export async function managePlan(appId: string): Promise<ManagePlan> {
  const f = await mumbleFacts(appId);
  const { option, target } = await changeTarget(f);
  const port = f.icePort && !f.iceExposed ? f.icePort : await freeIcePort().catch(() => 6502);
  const connected = await countConnections(f);
  const changes = [
    f.hostNetwork ? `Mumble's admin connection (Ice) listens on 127.0.0.1:${port}, on this server only.` : `Mumble's admin connection (Ice) is published on 127.0.0.1:${port}, so only this server can reach it.`,
    option.via === "builder" ? "Two new random secrets protect it. Gluon keeps them encrypted, in the app's builder secrets." : "Two new random secrets protect it. Gluon keeps them encrypted, and writes them to a private file next to the compose file.",
  ];
  const warnings: string[] = [];
  if (f.env.MUMBLE_SUPERUSER_PASSWORD !== undefined) changes.push(`The admin (SuperUser) password stays as it is, but Gluon takes it out of ${option.via === "builder" ? "the app's settings" : "the compose file"}: Mumble set it again at every start, which would undo a reset from here.`);
  if (f.iceExposed) warnings.push("Ice is published on every address right now, so anyone on your network could try it. This change closes that.");
  if (target?.via === "builder") {
    const d = await appDetail(target.builderId);
    const plain = (s: typeof d.spec) => JSON.stringify({ ...s, details: { ...s.details, version: "", releaseNotes: "" } });
    if (d.publishedSpec && plain(d.spec) !== plain(d.publishedSpec)) warnings.push("This app has changes in the builder that aren't published yet. They go live too.");
  }
  return { ok: option.ok, via: option.via, why: option.why, port, connected, changes, warnings };
}

const STAGES = [
  { key: "check", label: "Check" },
  { key: "apply", label: "Change the app" },
  { key: "connect", label: "Connect" },
];

/** The one-time change that opens Ice to Gluon. Runs as a job, so closing the page doesn't stop it. */
export async function startManage(appId: string, user: User, where: Where) {
  const f = await mumbleFacts(appId);
  const { target, option } = await changeTarget(f);
  if (!target) throw new AppError("cant_manage", option.why ?? "Gluon can't change this app.", 409);
  const port = f.icePort && !f.iceExposed ? f.icePort : await freeIcePort();
  const secrets: IceSecrets = { write: token(24), read: token(24) };
  const previous = getVoice(appId);
  startJob(jobKey(appId), "publish", STAGES, async (emit) => {
    emit({ type: "stage", stage: "check" });
    emit({ type: "step", text: `Using 127.0.0.1:${port} for Mumble's admin connection` });
    saveVoice(appId, { icePort: port, secrets });
    emit({ type: "stage", stage: "apply" });
    try {
      await applyChange(
        target,
        appId,
        {
          label: "Let Gluon manage the voice server",
          compose: (text, service) => manageCompose(text, service, { port, envFile: target.via === "compose" ? "gluon-voice.env" : null }).text,
          secrets: { set: { MUMBLE_CONFIG_ICESECRETWRITE: secrets.write, MUMBLE_CONFIG_ICESECRETREAD: secrets.read }, remove: ["MUMBLE_SUPERUSER_PASSWORD", "MUMBLE_CONFIG_ICE", "MUMBLE_CONFIG_ICESECRET"] },
          envFile: target.via === "compose" ? iceEnvFile(secrets) : undefined,
        },
        user,
        where,
        emit,
      );
    } catch (e) {
      if (previous?.secrets) saveVoice(appId, { icePort: previous.icePort, secrets: previous.secrets });
      audit(user, { action: "voice.manage", target: appId, summary: `Tried to let Gluon manage ${f.app.name}'s voice server`, outcome: "failed" }, where);
      throw e;
    }
    emit({ type: "stage", stage: "connect" });
    emit({ type: "step", text: "Waiting for Mumble's admin connection" });
    const ok = await waitForIce(appId, 60_000);
    audit(user, { action: "voice.manage", target: appId, summary: ok ? `Let Gluon manage ${f.app.name}'s voice server` : `Changed ${f.app.name} so Gluon can manage it, but couldn't connect yet`, detail: { icePort: port, via: target.via }, outcome: ok ? "ok" : "failed" }, where);
    if (!ok) return { ok: false, message: `${f.app.name} restarted with the change, but Gluon couldn't connect to its admin connection yet. If it doesn't show up in a minute, check its logs.` };
    return { ok: true, message: `Gluon manages ${f.app.name} now.` };
  });
}

async function waitForIce(appId: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      await open(appId);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return false;
}

export const manageJobKey = jobKey;

/**
 * Take the join password out of the compose file (a restart), for when the file sets one: Ice can
 * replace it with another, but clearing it there only falls back to the file's.
 */
export async function startRemoveEnvPassword(appId: string, user: User, where: Where) {
  const f = await mumbleFacts(appId);
  const env = envFor("serverpassword", f.env);
  if (!env) throw new AppError("nothing", "The compose file doesn't set a join password.", 409);
  const { target, option } = await changeTarget(f);
  if (!target) throw new AppError("cant_change", option.why ?? "Gluon can't change this app.", 409);
  startJob(jobKey(appId), "publish", [{ key: "apply", label: "Change the app" }, { key: "connect", label: "Connect" }], async (emit: Emit) => {
    emit({ type: "stage", stage: "apply" });
    // A password saved over Ice would still apply after the restart; clear that too.
    await live(appId).then((c) => c.server.setConf("password", ""), () => undefined);
    await applyChange(target, appId, { label: "Remove the join password", compose: (text, service) => editServiceEnv(text, service, { remove: (k) => k === env.name }).text, secrets: { remove: [env.name] } }, user, where, emit);
    emit({ type: "stage", stage: "connect" });
    const ok = await waitForIce(appId, 60_000);
    audit(user, { action: "voice.password.remove", target: appId, summary: `Removed the join password of ${f.app.name}` }, where);
    return { ok: true, message: ok ? "Anyone can join without a password now." : "The password is gone from the compose file. Gluon couldn't reconnect yet; check the app if it doesn't come back." };
  });
}
