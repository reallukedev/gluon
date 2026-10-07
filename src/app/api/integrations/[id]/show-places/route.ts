import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { badRequest, notFound } from "@/server/errors";
import { getRecord, updateIntegration } from "@/server/integrations/store";

const body = z.object({ show: z.boolean() });

/**
 * Admin: whether Who's home names the places people are ("At Work"). Off by default. It lives on the connection,
 * so every Who's home widget reading it follows the same choice and a member can't turn it on for themselves.
 */
export const PUT = route({ auth: "admin", body, recent: true }, ({ user, body, params, ip, zone }) => {
  const id = String(Array.isArray(params.id) ? params.id[0] : params.id);
  const rec = getRecord(id);
  if (!rec) throw notFound("That connection");
  if (rec.kind !== "homeassistant") throw badRequest("Only Home Assistant knows where people are.");
  if (!rec.config) throw badRequest(rec.configError ?? "This connection needs to be set up again.");
  if (rec.config.showPlaces === body.show) return { showPlaces: body.show };
  updateIntegration(id, { config: { showPlaces: body.show } });
  audit(
    user,
    {
      action: "integration.show-places",
      summary: body.show ? `Who's home now shows where people are (Home Assistant “${rec.name}”)` : `Who's home now shows only Home or Away (Home Assistant “${rec.name}”)`,
      target: rec.id,
      detail: { show: body.show },
    },
    { ip, zone },
  );
  return { showPlaces: body.show };
});
