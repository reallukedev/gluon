import { z } from "zod";
import { route } from "@/server/api";
import { param } from "@/app/api/docker/params";
import { audit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { deleteAccount, updateAccount, USERNAME_RE } from "@/server/chat/prosody";
import { newPassword, targetAndHost } from "@/server/chat/service";

const patch = z.object({
  host: z.string().min(1).max(253),
  /** A new password, or "generate" for Gluon to make one up. */
  password: z.union([z.literal("generate"), z.string().min(8, "Passwords are at least 8 characters.").max(256).regex(/^[^\r\n\0]*$/, "Passwords can't contain line breaks.")]).optional(),
  role: z.enum(["member", "admin"]).optional(),
  enabled: z.boolean().optional(),
  /** true: every device; a string: just that device (its resource). */
  signOut: z.union([z.boolean(), z.string().min(1).max(1023)]).optional(),
});

function who(params: Record<string, string | string[]>) {
  const appId = param(params.app);
  const u = param(params.user);
  if (!USERNAME_RE.test(u) && !/^[^@/\s]{1,1023}$/.test(u)) throw new AppError("invalid", "That isn't a chat account.", 400);
  return { appId, u };
}

export const PATCH = route({ auth: "admin", recent: true, body: patch, burst: { limit: 60, windowMs: 60_000 } }, async ({ params, body, user, ip, zone }) => {
  const { appId, u } = who(params);
  const { t, snap } = await targetAndHost(appId, body.host);
  const acct = snap.hosts.find((h) => h.host === body.host)?.accounts.find((a) => a.user === u);
  if (!acct) throw new AppError("not_found", `${u}@${body.host} doesn't exist any more.`, 404);
  if (body.role && acct.fromConfig) throw new AppError("from_config", `${acct.jid} is an owner because it's listed in admins in Prosody's config file. Remove it there to change its role.`, 409);
  const password = body.password === "generate" ? newPassword() : body.password;
  const r = await updateAccount(t, { host: body.host, user: u, password, role: body.role, enabled: body.enabled, signOut: body.signOut });
  const did = [
    password ? "reset the password" : null,
    body.role ? `made it ${body.role === "admin" ? "an admin" : "a member"}` : null,
    body.enabled === false ? "turned it off" : body.enabled === true ? "turned it back on" : null,
    body.signOut ? (typeof body.signOut === "string" ? `signed out ${body.signOut}` : "signed out its devices") : null,
  ].filter(Boolean);
  audit(user, { action: "chat.account.update", target: appId, summary: `${acct.jid}: ${did.join(", ") || "no change"}`, detail: { closed: r.closed } }, { ip, zone });
  return { closed: r.closed, password: body.password === "generate" ? password : null };
});

const del = z.object({ host: z.string().min(1).max(253) });

export const DELETE = route({ auth: "admin", recent: true, body: del }, async ({ params, body, user, ip, zone }) => {
  const { appId, u } = who(params);
  const { t, snap } = await targetAndHost(appId, body.host);
  const acct = snap.hosts.find((h) => h.host === body.host)?.accounts.find((a) => a.user === u);
  if (acct?.fromConfig) throw new AppError("from_config", `${acct.jid} is listed in admins in Prosody's config file. Remove it there first.`, 409);
  await deleteAccount(t, { host: body.host, user: u });
  audit(user, { action: "chat.account.delete", target: appId, summary: `Deleted chat account ${u}@${body.host}` }, { ip, zone });
  return { ok: true };
});
