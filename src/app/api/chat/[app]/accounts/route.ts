import { z } from "zod";
import { route } from "@/server/api";
import { param } from "@/app/api/docker/params";
import { audit } from "@/server/audit";
import { createAccount, USERNAME_RE } from "@/server/chat/prosody";
import { newPassword, targetAndHost } from "@/server/chat/service";

const body = z.object({
  host: z.string().min(1).max(253),
  user: z
    .string()
    .trim()
    .toLowerCase()
    .regex(USERNAME_RE, "Use lowercase letters, numbers, dots, dashes or underscores, starting with a letter or number."),
  /** Leave out to have Gluon make one up. */
  password: z.string().min(8, "Passwords are at least 8 characters.").max(256).regex(/^[^\r\n\0]*$/, "Passwords can't contain line breaks.").nullish(),
  role: z.enum(["member", "admin"]).default("member"),
});

/** Create a chat account. A made-up password comes back once, for the admin to pass on. */
export const POST = route({ auth: "admin", recent: true, body, burst: { limit: 30, windowMs: 60_000 } }, async ({ params, body, user, ip, zone }) => {
  const appId = param(params.app);
  const { t } = await targetAndHost(appId, body.host);
  const password = body.password ?? newPassword();
  await createAccount(t, { host: body.host, user: body.user, password, role: body.role });
  const jid = `${body.user}@${body.host}`;
  audit(user, { action: "chat.account.create", target: appId, summary: `Created chat account ${jid}${body.role === "admin" ? " as an admin" : ""}` }, { ip, zone });
  return { jid, password: body.password ? null : password };
});
