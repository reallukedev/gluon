import "server-only";
import crypto from "node:crypto";
import { all, one } from "../db";
import { publicBaseUrl } from "../settings";
import { findById } from "../auth/users";
import { listApps } from "../docker/apps";
import { prosodyFor, prosodyLua } from "../chat/prosody";
import { list } from "../chat/lua";
import { appImageUpdates, checkAppImages, runningImages } from "../updates/apps";
import { peopleHref } from "@/lib/settings-links";
import { notifyEvent, type Notice } from "./dispatcher";
import { firstTime, getState, setState } from "./state";
import { XMPP_SENDER as SENDER } from "./xmpp-format";

/**
 * Change detectors for the notifications that aren't problems: Gluon and app updates, sign-ins
 * and the chat server. Each remembers what it has seen (notify_state), the first look only takes a
 * baseline, and each event is announced once (firstTime + the delivery dedupe key).
 */

const base = () => publicBaseUrl();
const short = (d: string) => d.replace(/^sha256:/, "").slice(0, 12);

async function announce(n: Notice) {
  if (!firstTime(`${n.kind}|${n.key}`)) return;
  await notifyEvent(n);
}

// ---------------------------------------------------------------- the activity log (sign-ins and security)

interface AuditRow {
  id: number;
  user_id: string | null;
  username: string | null;
  action: string;
  target: string | null;
  summary: string;
  detail: string | null;
  outcome: string;
}

const WATCHED = ["auth.mfa_disabled", "people.mfa_reset", "auth.new_device"];

async function auditWatch() {
  const cursor = getState<number>("cursor:audit");
  const max = one<{ n: number | null }>("SELECT MAX(id) AS n FROM audit_log")?.n ?? 0;
  if (cursor === null) return setState("cursor:audit", max);
  if (max <= cursor) return;
  const rows = all<AuditRow>(`SELECT * FROM audit_log WHERE id > ? AND id <= ? AND action IN (${WATCHED.map(() => "?").join(",")}) ORDER BY id`, cursor, max, ...WATCHED);
  setState("cursor:audit", max);
  for (const r of rows) {
    if (r.outcome !== "ok") continue;
    if (r.action === "auth.mfa_disabled" || r.action === "people.mfa_reset") {
      const whoId = r.action === "auth.mfa_disabled" ? r.user_id : r.target;
      const who = whoId ? findById(whoId) : null;
      const name = who?.display_name || who?.username || "Someone";
      const by = r.action === "people.mfa_reset" ? r.username : null;
      await announce({
        kind: "mfa.off",
        key: `audit:${r.id}`,
        title: by ? `${by} turned off two-step verification for ${name}` : `${name} turned off two-step verification`,
        body: `${name}'s account now signs in with a password alone.${who?.role === "admin" ? " It's an admin account." : ""} If nobody meant to do this, turn it back on and change the password.`,
        link: `${base()}${peopleHref({ person: whoId })}`,
        linkLabel: "Review the account",
        severity: "attention",
      });
    } else if (r.action === "auth.new_device") {
      // Admins' new devices are already problems (signin.new_device findings); this covers everyone else.
      const who = r.user_id ? findById(r.user_id) : null;
      if (!who || who.role === "admin") continue;
      const name = who.display_name || who.username;
      await announce({
        kind: "signin.new_device",
        key: `audit:${r.id}`,
        title: `${name} signed in from a new device outside home`,
        body: `${r.summary.replace(/^Signed in from a new device outside home\s*/, "").replace(/^\(|\)$/g, "") || "A browser Gluon hasn't seen before"}. If it wasn't them, sign that device out from their account.`,
        link: `${base()}${peopleHref({ person: who.id })}`,
        linkLabel: "Review their devices",
        severity: "attention",
      });
    }
  }
}

// ---------------------------------------------------------------- Gluon's own updates

interface SelfUpdateRow {
  id: string;
  to_version: string;
  from_version: string;
  outcome: "running" | "ok" | "failed";
  message: string | null;
  auto: number;
  username: string | null;
  finished_at: number | null;
}

async function selfUpdateWatch() {
  const cursor = getState<number>("cursor:self_updates");
  const max = one<{ n: number | null }>("SELECT MAX(finished_at) AS n FROM self_updates")?.n ?? 0;
  if (cursor === null) return setState("cursor:self_updates", max);
  if (max <= cursor) return;
  const rows = all<SelfUpdateRow>("SELECT * FROM self_updates WHERE finished_at > ? AND finished_at <= ? ORDER BY finished_at", cursor, max);
  setState("cursor:self_updates", max);
  for (const r of rows) {
    const how = r.auto ? "An automatic update" : r.username ? `Started by ${r.username}` : "Started from Settings";
    if (r.outcome === "ok") {
      await announce({
        kind: "gluon.installed",
        key: r.id,
        title: `Gluon updated to ${r.to_version}`,
        body: `${how}, from ${r.from_version}.`,
        link: `${base()}/settings/updates`,
        linkLabel: "See what changed",
        severity: "info",
      });
    } else if (r.outcome === "failed") {
      await announce({
        kind: "gluon.failed",
        key: r.id,
        title: `Gluon couldn't update to ${r.to_version}`,
        body: `${r.message ?? "The update didn't finish."} It's still running ${r.from_version}.`,
        link: `${base()}/settings/updates`,
        linkLabel: "See the update log",
        severity: "attention",
      });
    }
  }
}

/** "Gluon 1.4.0 is available" is an info finding the updater keeps open; tell people once per version. */
async function gluonAvailableWatch() {
  const f = one<{ title: string; cause: string | null; first_seen: number }>("SELECT title, cause, first_seen FROM findings WHERE id = 'gluon-update' AND resolved_at IS NULL");
  if (!f) return;
  await announce({
    kind: "gluon.available",
    key: f.title,
    title: f.title,
    body: f.cause ?? "Install it from Settings → Updates.",
    link: `${base()}/settings/updates`,
    linkLabel: "See the update",
    severity: "info",
  });
}

// ---------------------------------------------------------------- apps

interface AppSeen {
  /** Umbrel's installed version. */
  version?: string;
  /** container name → image id */
  images?: Record<string, string>;
}

async function appsWatch() {
  const apps = await listApps();
  const prev = getState<Record<string, AppSeen>>("apps") ;
  const next: Record<string, AppSeen> = {};
  const byApp = new Map<string, Record<string, string>>();
  for (const i of await runningImages()) {
    const m = byApp.get(i.appId) ?? {};
    m[i.container] = i.imageId;
    byApp.set(i.appId, m);
  }
  for (const a of apps) {
    if (a.self) continue;
    const before = prev?.[a.id];
    const seen: AppSeen = {};
    if (a.umbrel) {
      seen.version = a.umbrel.version;
      if (a.umbrel.latest) {
        await announce({
          kind: "app.available",
          key: `${a.id}@${a.umbrel.latest}`,
          subject: a.id,
          title: `${a.name} ${a.umbrel.latest} is available`,
          body: `Umbrel's app store has ${a.umbrel.latest}; this server runs ${a.umbrel.version}.`,
          link: `${base()}/apps/${encodeURIComponent(a.id)}`,
          linkLabel: `Open ${a.name}`,
          severity: "info",
        });
      }
      if (before?.version && before.version !== a.umbrel.version && a.umbrel.state !== "updating") {
        await announce({
          kind: "app.updated",
          key: `${a.id}@${a.umbrel.version}`,
          subject: a.id,
          title: `${a.name} was updated to ${a.umbrel.version}`,
          body: `It was on ${before.version}.`,
          link: `${base()}/apps/${encodeURIComponent(a.id)}`,
          linkLabel: `Open ${a.name}`,
          severity: "info",
        });
      }
    } else {
      const now = byApp.get(a.id);
      // Keep what was known while the app is stopped, so starting it again isn't news.
      seen.images = { ...(before?.images ?? {}), ...(now ?? {}) };
      const changed = now && before?.images ? Object.entries(now).filter(([c, id]) => before.images![c] && before.images![c] !== id) : [];
      if (changed.length) {
        const sig = crypto.createHash("sha256").update(changed.map(([c, id]) => `${c}=${id}`).sort().join(",")).digest("hex").slice(0, 16);
        await announce({
          kind: "app.updated",
          key: `${a.id}#${sig}`,
          subject: a.id,
          title: `${a.name} was updated`,
          body: changed.length === 1 ? `${changed[0]![0]} is running a new image (${short(changed[0]![1])}).` : `${changed.length} of its containers are running new images.`,
          link: `${base()}/apps/${encodeURIComponent(a.id)}`,
          linkLabel: `Open ${a.name}`,
          severity: "info",
        });
      }
    }
    next[a.id] = seen;
  }
  // Apps that vanished (removed, or not listed this time) keep their last state for a while.
  setState("apps", { ...(prev ?? {}), ...next });
}

async function registryWatch() {
  await checkAppImages();
  for (const u of await appImageUpdates()) {
    await announce({
      kind: "app.available",
      key: `${u.appId}|${u.ref}|${u.remoteDigest}`,
      subject: u.appId,
      title: `A newer ${u.appName} is out`,
      body: `${u.ref.replace(/^docker\.io\//, "")} has a newer image than the one running. Updating downloads it and restarts ${u.appName}.`,
      link: `${base()}/apps/${encodeURIComponent(u.appId)}`,
      linkLabel: `Open ${u.appName}`,
      severity: "info",
    });
  }
}

// ---------------------------------------------------------------- chat server

const PROSODY_IMAGE = /(^|\/)(prosody|prosodyim)\/|(^|\/)prosody(:|$)/i;
const ACCOUNTS_LUA = `local um=require"core.usermanager"; local out={};
for name,h in pairs(prosody.hosts) do if h.type=="local" and name~="localhost" then local us={}; for u in um.users(name) do us[#us+1]=u end; out[#out+1]={host=name, users=us} end end;
return out`;

async function chatWatch() {
  const apps = (await listApps()).filter((a) => a.containers.some((c) => PROSODY_IMAGE.test(c.image) && c.state === "running"));
  for (const a of apps) {
    let hosts: { host: string; users: string[] | Record<string, never> }[];
    try {
      hosts = list(await prosodyLua(await prosodyFor(a.id), ACCOUNTS_LUA, {}, 15_000));
    } catch {
      continue;
    }
    // Accounts an admin made in Gluon aren't news.
    const made = new Set(
      all<{ summary: string }>("SELECT summary FROM audit_log WHERE action = 'chat.account.create' AND target = ? AND at > ?", a.id, Date.now() - 7 * 86_400_000).map((r) =>
        (/account (\S+@\S+)/.exec(r.summary)?.[1] ?? "").toLowerCase(),
      ),
    );
    for (const h of hosts) {
      const users = list<string>(h.users);
      const key = `chat:${a.id}:${h.host}`;
      const known = getState<string[]>(key);
      setState(key, users);
      if (known === null) continue;
      const old = new Set(known);
      for (const u of users) {
        const jid = `${u}@${h.host}`;
        if (old.has(u) || u === SENDER || made.has(jid)) continue;
        await announce({
          kind: "chat.joined",
          key: `${a.id}|${jid}`,
          title: `${jid} joined the chat server`,
          body: `A new account appeared on ${a.name}, most likely from an invite link. If you didn't expect it, turn it off from the chat server's page.`,
          link: `${base()}/apps/${encodeURIComponent(a.id)}`,
          linkLabel: `Open ${a.name}`,
          severity: "info",
        });
      }
    }
  }
}

// ---------------------------------------------------------------- schedule

const EVERY: { name: string; ms: number; fn: () => Promise<unknown> }[] = [
  { name: "audit", ms: 0, fn: auditWatch },
  { name: "self-updates", ms: 0, fn: selfUpdateWatch },
  { name: "gluon-available", ms: 5 * 60_000, fn: gluonAvailableWatch },
  { name: "apps", ms: 10 * 60_000, fn: appsWatch },
  { name: "chat", ms: 10 * 60_000, fn: chatWatch },
  { name: "registry", ms: 60 * 60_000, fn: registryWatch },
];

type G = typeof globalThis & { __gluonNotifyWatch?: Map<string, number> };
const last = ((globalThis as G).__gluonNotifyWatch ??= new Map());

const busy = new Set<string>();

/** Start whatever is due. Each watcher runs on its own, at most one at a time, and fails on its own. Resolves when the ones it started finish. */
export function runWatchers(): Promise<unknown> {
  const t = Date.now();
  const started: Promise<unknown>[] = [];
  for (const w of EVERY) {
    if (busy.has(w.name) || (w.ms && t - (last.get(w.name) ?? 0) < w.ms)) continue;
    last.set(w.name, t);
    busy.add(w.name);
    started.push(
      w
        .fn()
        .catch((e) => console.error(`[gluon] notify watcher ${w.name} failed`, e))
        .finally(() => busy.delete(w.name)),
    );
  }
  return Promise.all(started);
}
