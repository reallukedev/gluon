import { z } from "zod";
import { route } from "@/server/api";
import { param } from "@/app/api/docker/params";
import { audit } from "@/server/audit";
import { withAppLock } from "@/server/apps/lock";
import { chatTarget, checkChatConfig, readChatConfig, saveChatConfig, serverName } from "@/server/chat/backend";

/** The chat server's own config file (Prosody's Lua, Quark's TOML), for editing by hand. */
export const GET = route({ auth: "admin" }, async ({ params }) => readChatConfig(param(params.app)));

const text = z.string().max(256 * 1024, "That config is too big.");

/** Check without saving. */
export const POST = route({ auth: "admin", body: z.object({ text }), burst: { limit: 30, windowMs: 60_000 } }, async ({ params, body }) => checkChatConfig(param(params.app), body.text));

/** Check, save, and reload (Prosody can restart instead, which picks up new hosts and ports; Quark applies it live). */
export const PUT = route({ auth: "admin", recent: true, body: z.object({ text, base: z.string().max(256 * 1024), restart: z.boolean().default(false) }) }, async ({ params, body, user, ip, zone }) => {
  const appId = param(params.app);
  const t = await chatTarget(appId);
  return withAppLock([appId], `${t.app.name}'s config is being saved`, async () => {
    const r = await saveChatConfig(t, appId, { text: body.text, base: body.base, restart: t.kind === "prosody" && body.restart });
    if (!r.saved) return { saved: false, check: r.check };
    audit(user, { action: "chat.config.save", target: appId, summary: `Edited ${serverName(t.kind)}'s config for ${t.app.name}${r.restarted ? " and restarted it" : ""}` }, { ip, zone });
    return r;
  });
});
