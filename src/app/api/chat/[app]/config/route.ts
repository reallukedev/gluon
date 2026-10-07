import { z } from "zod";
import { route } from "@/server/api";
import { param } from "@/app/api/docker/params";
import { audit } from "@/server/audit";
import { withAppLock } from "@/server/apps/lock";
import { checkConfigText, prosodyFor, readConfigFiles, reloadProsody, restartProsody, saveMainConfig } from "@/server/chat/prosody";
import { AppError } from "@/server/errors";

/** Prosody's own config file, for editing by hand. */
export const GET = route({ auth: "admin" }, async ({ params }) => {
  const f = await readConfigFiles(param(params.app));
  return { main: f.main, gluon: f.gluon, file: f.file, writable: f.snap.config.writable, reason: f.snap.config.reason };
});

const text = z.string().max(256 * 1024, "That config is too big.");

/** Check without saving. */
export const POST = route({ auth: "admin", body: z.object({ text }), burst: { limit: 30, windowMs: 60_000 } }, async ({ params, body }) => {
  const appId = param(params.app);
  const f = await readConfigFiles(appId);
  const t = await prosodyFor(appId);
  return checkConfigText(t, f.snap, body.text);
});

/** Check, save, and reload (or restart, which picks up new hosts and ports). */
export const PUT = route({ auth: "admin", recent: true, body: z.object({ text, base: z.string().max(256 * 1024), restart: z.boolean().default(false) }) }, async ({ params, body, user, ip, zone }) => {
  const appId = param(params.app);
  const t = await prosodyFor(appId);
  return withAppLock([appId], `${t.app.name}'s config is being saved`, async () => {
    const f = await readConfigFiles(appId);
    if (f.main !== body.base) throw new AppError("stale", "Prosody's config changed since you opened it. Reload it, then make your change again.", 409);
    const check = await checkConfigText(t, f.snap, body.text);
    if (!check.ok) return { saved: false, check };
    await saveMainConfig(t, f.snap, body.text);
    if (body.restart) await restartProsody(t);
    else await reloadProsody(t);
    audit(user, { action: "chat.config.save", target: appId, summary: `Edited Prosody's config for ${t.app.name}${body.restart ? " and restarted it" : ""}` }, { ip, zone });
    return { saved: true, check, restarted: body.restart };
  });
});
