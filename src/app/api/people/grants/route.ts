import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { createGrant, listGrants } from "@/server/people/access";

export const GET = route({ auth: "admin", query: z.object({ user: z.string().max(64).optional() }) }, ({ query }) => listGrants(query.user));

const body = z.object({
  userId: z.string().min(1).max(64),
  path: z.string().min(1, "Enter a folder.").max(4096),
  label: z.string().trim().max(60).nullable().optional(),
  access: z.enum(["read", "write"]).default("read"),
});

export const POST = route({ auth: "admin", body, recent: true }, async ({ user, body, ip, zone }) => {
  const g = await createGrant(body);
  audit(user, { action: "people.folder_granted", target: g.path, summary: `Shared ${g.path} with ${g.userName} (${g.access === "write" ? "can change" : "view only"})` }, { ip, zone });
  return g;
});
