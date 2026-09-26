import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { findById } from "@/server/auth/users";
import { setAppVisibility, setUserApps, visibility } from "@/server/people/access";

/** Which apps household members see: per app, "everyone" (household) and individual members. */
export const GET = route({ auth: "admin" }, () => visibility());

const body = z.union([
  z.object({
    appId: z.string().min(1).max(200),
    /** Every household member sees it. */
    household: z.boolean().optional(),
    /** Exactly these members see it individually (replaces the list). */
    users: z.array(z.string().max(64)).max(200).optional(),
  }),
  z.object({
    userId: z.string().min(1).max(64),
    /** Exactly these apps for this member (replaces the list). */
    apps: z.array(z.string().max(200)).max(500),
  }),
]);

export const PUT = route({ auth: "admin", body, recent: true }, async ({ user, body, ip, zone }) => {
  if ("appId" in body) {
    const app = await setAppVisibility(body.appId, body);
    const parts: string[] = [];
    if (body.household !== undefined) parts.push(body.household ? "everyone in the household can see it" : "it's no longer shown to the whole household");
    if (body.users) parts.push(`${body.users.length} ${body.users.length === 1 ? "person sees" : "people see"} it individually`);
    audit(user, { action: "people.app_visibility", target: app.id, summary: `${app.name}: ${parts.join("; ") || "no change"}` }, { ip, zone });
  } else {
    await setUserApps(body.userId, body.apps);
    const who = findById(body.userId)?.display_name ?? "Someone";
    audit(user, { action: "people.app_access", target: body.userId, summary: `${who} now sees ${body.apps.length} app${body.apps.length === 1 ? "" : "s"} individually`, detail: { apps: body.apps } }, { ip, zone });
  }
  return visibility();
});
