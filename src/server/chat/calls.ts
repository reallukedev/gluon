import "server-only";
import type { User } from "../auth/users";
import { audit } from "../audit";
import { AppError } from "../errors";
import { createDraft, appDetail } from "../appstore/service";
import { docker } from "../docker/client";
import { lanHost, listApps, type AppSummary } from "../docker/apps";
import { lanSide } from "../network/reach";
import { networkStatus } from "../network/status";
import { chatSnapshot, prosodyFor, putProsodyFile } from "./prosody";
import { applySettings, type Where } from "./service";
import { coturnRecipe, newTurnSecret, PROSODY_TURN_SECRET, RELAY_PORTS, stunAnswers, TURN_PORT } from "./turn";
import type { ChatCallsStatus } from "@/lib/chat-types";

const COTURN = /(^|\/)coturn(\/|:|$)/i;

/** This server's IPv4 on the home network: from the default route, else Gluon's LAN host setting. */
async function serverLanIp(): Promise<string | null> {
  const fromRoute = (await lanSide().catch(() => null))?.lanIp;
  if (fromRoute) return fromRoute;
  const h = await lanHost().catch(() => null);
  return h && /^\d+\.\d+\.\d+\.\d+$/.test(h) ? h : null;
}

async function relayApp(): Promise<AppSummary | null> {
  const apps = await listApps().catch(() => []);
  return apps.find((a) => a.containers.some((c) => COTURN.test(c.image))) ?? null;
}

/** The relay, whether it answers here and through the router, and what to forward. */
export async function callsStatus(appId: string): Promise<ChatCallsStatus> {
  const [relay, lan, lanIp, snap] = await Promise.all([relayApp(), lanSide().catch(() => ({ lanIp: null, gateway: null })), serverLanIp(), chatSnapshot(appId)]);
  const running = !!relay?.containers.some((c) => COTURN.test(c.image) && c.state === "running");
  const host = snap.hosts[0];
  // Only on the server itself: from a laptop, "the public address" is someone else's network.
  const onServer = process.platform === "linux";
  const publicIp = onServer ? ((await networkStatus().catch(() => null))?.publicIp.v4 ?? null) : null;
  const [here, outside] = await Promise.all([
    onServer && running && lanIp ? stunAnswers(lanIp) : Promise.resolve(null),
    running && publicIp ? stunAnswers(publicIp) : Promise.resolve(null),
  ]);
  return {
    on: !!host?.settings.calls?.on,
    host: host?.settings.calls?.host ?? host?.host ?? null,
    relay: relay ? { appId: relay.id, name: relay.name, running } : null,
    answers: { here, outside },
    lanIp,
    gateway: lan.gateway,
    publicIp,
    ports: { turn: TURN_PORT, relayMin: RELAY_PORTS.min, relayMax: RELAY_PORTS.max },
  };
}

/** Install the relay when there isn't one. Returns the builder draft to publish, or null to go straight to finishing. */
export async function startCalls(user: User, where: Where, appId: string): Promise<{ draftId: string | null }> {
  const existing = await relayApp();
  if (existing) return { draftId: null };
  const snap = await chatSnapshot(appId);
  const host = snap.hosts[0];
  if (!host) throw new AppError("invalid", "This Prosody has no chat domain yet.", 400);
  const lanIp = await serverLanIp();
  if (!lanIp) throw new AppError("no_lan_ip", "Gluon can't tell this server's address on your home network, which the relay needs.", 409);
  const draftId = await createDraft(user, where, { source: "compose", spec: coturnRecipe({ domain: host.host, lanIp }), secrets: { turn: { TURN_SECRET: newTurnSecret() } } });
  return { draftId };
}

/** The relay's secret, as its container sees it. */
async function relaySecret(relay: AppSummary): Promise<string> {
  const c = relay.containers.find((x) => COTURN.test(x.image) && x.state === "running");
  if (!c) throw new AppError("relay_stopped", `${relay.name} isn't running. Start it, then turn calls on again.`, 409);
  const info = await docker().getContainer(c.id).inspect();
  const secret = (info.Config.Env ?? []).find((e) => e.startsWith("TURN_SECRET="))?.slice("TURN_SECRET=".length);
  if (!secret) throw new AppError("relay_secret", `${relay.name} has no TURN_SECRET, so Gluon can't give chat apps logins for it. Remove it and set calls up again.`, 409);
  return secret;
}

/** Share the relay's secret with Prosody and turn calls on. */
export async function finishCalls(user: User, where: Where, appId: string, draftId: string | null) {
  if (draftId) {
    const d = await appDetail(draftId);
    if (d.status !== "published") throw new AppError("not_ready", "The relay isn't installed yet. Wait for it to finish.", 409);
  }
  const relay = await relayApp();
  if (!relay) throw new AppError("no_relay", "Gluon can't find the call relay.", 409);
  const secret = await relaySecret(relay);
  const t = await prosodyFor(appId);
  await putProsodyFile(t, PROSODY_TURN_SECRET, secret);
  const snap = await chatSnapshot(appId);
  const h = snap.hosts[0]!;
  const r = await applySettings(user, where, appId, h.host, { ...h.settings, calls: { on: true, host: h.host } }, false, null);
  audit(user, { action: "chat.calls", target: appId, summary: `Turned on calls across networks for ${h.host} through ${relay.name}` }, where);
  return r;
}

export async function stopCalls(user: User, where: Where, appId: string) {
  const snap = await chatSnapshot(appId);
  const h = snap.hosts[0]!;
  const r = await applySettings(user, where, appId, h.host, { ...h.settings, calls: { on: false, host: h.settings.calls?.host ?? h.host } }, false, null);
  audit(user, { action: "chat.calls", target: appId, summary: `Turned off calls across networks for ${h.host}` }, where);
  return r;
}
