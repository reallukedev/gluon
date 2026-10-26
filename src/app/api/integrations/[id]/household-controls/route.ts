import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { badRequest, notFound } from "@/server/errors";
import { contextFor, getRecord, updateIntegration } from "@/server/integrations/store";
import { deviceClasses, householdControlsOf, householdVisibleOf } from "@/server/integrations/kinds/homeassistant";
import { domainOf, editHousehold, memberLookOnly } from "@/server/integrations/kinds/homeassistant-map";
import { HA_ENTITY_ID } from "@/lib/widgets-types";

const ids = z.array(z.string().max(260).regex(HA_ENTITY_ID, "That isn't a Home Assistant entity.")).max(200);
const edits = z.object({ allow: ids.default([]), deny: ids.default([]) });
const body = z.object({ see: edits.optional(), press: edits.optional() });

/**
 * Admin: what household members may see, and what they may press, on a Home Assistant connection. Stored on the
 * connection (not in anyone's widget), so members can't give themselves either by editing their own Home.
 * Garage doors, gates, doors, locks and alarms never go on the "press" list.
 */
export const PUT = route({ auth: "admin", body, recent: true }, async ({ user, body, params, ip, zone }) => {
  const id = String(Array.isArray(params.id) ? params.id[0] : params.id);
  const rec = getRecord(id);
  if (!rec) throw notFound("That connection");
  if (rec.kind !== "homeassistant") throw badRequest("That connected app has no controls.");
  if (!rec.config) throw badRequest(rec.configError ?? "This connection needs to be set up again.");
  const classes = body.press?.allow.length ? await deviceClasses(contextFor(rec)).catch(() => new Map<string, string | null>()) : new Map<string, string | null>();
  const lookOnly = (x: string) => memberLookOnly(domainOf(x), classes.get(x) ?? null);

  const beforeSee = householdVisibleOf(rec.config);
  const beforePress = householdControlsOf(rec.config);
  const see = body.see ? editHousehold("see", beforeSee, body.see.allow, body.see.deny) : beforeSee;
  // Pressing implies seeing, so taking "see" away takes "press" away too.
  const pressDeny = [...(body.press?.deny ?? []), ...(body.see?.deny ?? [])];
  const press = editHousehold("press", beforePress, body.press?.allow ?? [], pressDeny, lookOnly);

  const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  const changes = { seeAdded: diff(see, beforeSee), seeRemoved: diff(beforeSee, see), pressAdded: diff(press, beforePress), pressRemoved: diff(beforePress, press) };
  const n = Object.values(changes).reduce((t, l) => t + l.length, 0);
  if (!n) return { householdVisible: see, householdControls: press };
  updateIntegration(id, { config: { householdVisible: see, householdControls: press } });
  const parts = [
    changes.seeAdded.length ? `shared ${changes.seeAdded.length} to look at` : null,
    changes.seeRemoved.length ? `stopped sharing ${changes.seeRemoved.length}` : null,
    changes.pressAdded.length ? `let the household press ${changes.pressAdded.length}` : null,
    changes.pressRemoved.length ? `took pressing away from ${changes.pressRemoved.length}` : null,
  ].filter(Boolean);
  audit(
    user,
    { action: "integration.household-controls", summary: `Home Assistant “${rec.name}”: ${parts.join(", ")}`, target: rec.id, detail: changes },
    { ip, zone },
  );
  return { householdVisible: see, householdControls: press };
});
