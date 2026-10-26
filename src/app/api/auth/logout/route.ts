import { route } from "@/server/api";
import { destroyCurrentSession } from "@/server/auth/session";
import { audit } from "@/server/audit";

export const POST = route({ auth: "public" }, async ({ user, ip, zone }) => {
  await destroyCurrentSession();
  if (user) audit(user, { action: "auth.logout", summary: "Signed out" }, { ip, zone });
  return { ok: true };
});
