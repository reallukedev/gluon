import "server-only";
import { token } from "../crypto";
import { audit } from "../audit";
import { AppError } from "../errors";
import { hostExists } from "../host/paths";
import { appsRoot } from "../apps/root";
import { lanHost, listApps } from "../docker/apps";
import { serverChecks } from "../appstore/checks";
import { appDetail, createDraft } from "../appstore/service";
import type { User } from "../auth/users";
import { freeIcePort } from "./apply";
import { connect, iceError } from "./ice";
import { mumbleFacts } from "./container";
import { getVoice, saveVoice } from "./store";
import { MUMBLE_PORT, mumbleLink, slugFor, voiceRecipe, type VoiceAnswers } from "./recipe";
import type { InstallDefaults } from "./types";

/**
 * Installing a new voice server, the way the chat installer does it: create a builder draft from
 * the recipe (the page then publishes it and follows the builder's job), then finish: wait for
 * Mumble's admin connection and set a random admin (SuperUser) password, shown once.
 */

type Where = { ip?: string; zone?: string };
const LOCAL = process.env.GLUON_LOCAL_HOST ?? "127.0.0.1";

async function takenPorts() {
  const probe = voiceRecipe({ name: "probe", welcome: "", password: "", port: MUMBLE_PORT }, { iceWrite: "x", iceRead: "x" }, 6502);
  const res = await serverChecks(probe.spec, "compose", null).catch(() => ({ ports: [] as { port: number; proto: "tcp" | "udp"; by: string }[] }));
  return res.ports;
}

export async function installDefaults(): Promise<InstallDefaults> {
  const taken = await takenPorts();
  let port = MUMBLE_PORT;
  while (taken.some((t) => t.port === port) && port < MUMBLE_PORT + 100) port++;
  const names = new Set((await listApps().catch(() => [])).map((a) => a.name.toLowerCase()));
  return { port, name: names.has("mumble") ? "Voice chat" : "Mumble", welcome: "Welcome! Pick a channel and say hi.", taken: taken.filter((t) => t.port >= 1024), lanHost: await lanHost().catch(() => null) };
}

/** An app id no app and no folder uses yet. */
async function freeSlug(base: string): Promise<string> {
  const ids = new Set((await listApps().catch(() => [])).map((a) => a.id));
  const root = await appsRoot();
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? base : `${base.slice(0, 27)}-${n}`;
    if (!ids.has(slug) && !hostExists(`${root}/${slug}`)) return slug;
  }
  throw new AppError("invalid", "Pick another name; Gluon couldn't find a free id for it.", 409, { field: "name" });
}

/** Check the answers and make the builder draft. Ice's secrets are saved for the app it becomes. */
export async function startVoiceInstall(a: VoiceAnswers, user: User, where: Where): Promise<{ draftId: string; appId: string }> {
  const taken = await takenPorts();
  for (const proto of ["tcp", "udp"] as const) {
    const by = taken.find((t) => t.port === a.port && t.proto === proto)?.by;
    if (by) throw new AppError("invalid", `Port ${a.port}${proto === "udp" ? " (UDP)" : ""} is already used by ${by}. Pick another one.`, 409, { field: "port" });
  }
  const icePort = await freeIcePort();
  const secrets = { iceWrite: token(24), iceRead: token(24) };
  const recipe = voiceRecipe(a, secrets, icePort);
  const slug = await freeSlug(slugFor(a.name));
  const spec = { ...recipe.spec, details: { ...recipe.spec.details, slug } };
  const draftId = await createDraft(user, where, { source: "compose", spec, secrets: recipe.secrets });
  const appId = (await appDetail(draftId)).plannedAppId ?? slug;
  saveVoice(appId, { icePort, secrets: { write: secrets.iceWrite, read: secrets.iceRead } });
  return { draftId, appId };
}

export interface InstallDone {
  appId: string;
  name: string;
  host: string;
  port: number;
  link: string;
  superuser: string;
}

/** Once the publish has run: wait for Mumble, then give it a random admin password and hand that over once. */
export async function finishVoiceInstall(draftId: string, user: User, where: Where): Promise<InstallDone> {
  const d = await appDetail(draftId);
  const appId = d.appId;
  if (!appId || d.status !== "published") throw new AppError("not_ready", "The voice server isn't installed yet. Wait for the install to finish.", 409);
  const rec = getVoice(appId);
  if (!rec?.secrets) throw new AppError("no_secret", "Gluon lost the secrets for this voice server. Open its Voice server tab and let Gluon manage it.", 409);
  const end = Date.now() + 90_000;
  let last: unknown = null;
  while (Date.now() < end) {
    try {
      const f = await mumbleFacts(appId);
      if (f.running && f.icePort) {
        const c = await connect({ host: LOCAL, port: f.icePort, secret: rec.secrets.write });
        const superuser = token(15);
        await c.server.setSuperuserPassword(superuser);
        const name = d.spec.details.name;
        const host = (await lanHost().catch(() => null)) ?? LOCAL;
        const port = f.voiceHostPort ?? MUMBLE_PORT;
        audit(user, { action: "voice.install", target: appId, summary: `Set up the voice server ${name} and gave it an admin password` }, where);
        return { appId, name, host, port, link: mumbleLink(host, port, name), superuser };
      }
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new AppError("install_timeout", `${d.spec.details.name} is installed, but Mumble didn't answer within 90 seconds${last ? ` (${iceError(last).message})` : ""}. Open its Voice server tab; you can set the admin password there.`, 504);
}
