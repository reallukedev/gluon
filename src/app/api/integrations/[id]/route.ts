import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { deleteIntegration, getIntegration, updateIntegration } from "@/server/integrations/store";
import { KINDS } from "@/server/integrations/registry";
import { requireRecentAuth } from "@/server/integrations/recent";

const idOf = (p: Record<string, string | string[]>) => String(Array.isArray(p.id) ? p.id[0] : p.id);

export const GET = route({ auth: "admin" }, ({ params }) => getIntegration(idOf(params)));

const patchBody = z.object({
  name: z.string().max(200).optional(),
  baseUrl: z.string().max(2048).optional(),
  /** Partial config: omitted or "" secrets keep their stored value; null clears one. */
  config: z.record(z.string(), z.unknown()).optional(),
  appId: z.string().max(200).nullable().optional(),
  shared: z.boolean().optional(),
});

export const PATCH = route({ auth: "admin", body: patchBody }, ({ user, session, body, params, ip, zone }) => {
  // Sharing with the household opens the app to every member: confirm it's the admin.
  if (body.shared === true && !getIntegration(idOf(params)).shared) requireRecentAuth(session);
  const { before, after } = updateIntegration(idOf(params), body);
  const changed = [
    body.name !== undefined && body.name.trim() !== before.name ? "name" : null,
    body.baseUrl !== undefined && after.baseUrl !== before.baseUrl ? "address" : null,
    body.config !== undefined ? "settings" : null,
    body.shared !== undefined && body.shared !== before.shared ? (body.shared ? "shared with the household" : "made admin-only") : null,
    body.appId !== undefined && body.appId !== before.appId ? "app" : null,
  ].filter(Boolean);
  audit(
    user,
    {
      action: "integration.update",
      summary: `Changed the ${KINDS[after.kind].label} connection “${after.name}”${changed.length ? ` (${changed.join(", ")})` : ""}`,
      target: after.id,
      detail: { kind: after.kind, baseUrl: after.baseUrl, shared: after.shared, changed },
    },
    { ip, zone },
  );
  return after;
});

export const DELETE = route({ auth: "admin", recent: true }, ({ user, params, ip, zone }) => {
  const gone = deleteIntegration(idOf(params));
  audit(
    user,
    {
      action: "integration.delete",
      summary: `Removed the ${KINDS[gone.kind]?.label ?? gone.kind} connection “${gone.name}”`,
      target: gone.id,
      detail: { kind: gone.kind, baseUrl: gone.baseUrl },
    },
    { ip, zone },
  );
  return { ok: true };
});
