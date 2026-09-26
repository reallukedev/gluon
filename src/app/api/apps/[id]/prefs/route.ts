import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { hasRecentAuth } from "@/server/auth/session";
import { setAppPrefs } from "@/server/docker/apps";
import { all, one, run } from "@/server/db";
import { audit } from "@/server/audit";

const url = z.string().max(500).refine((v) => v === "" || /^https?:\/\/\S+$/i.test(v), "Use a full address starting with http:// or https://");

const body = z.object({
  displayName: z.string().max(60).optional(),
  description: z.string().max(200).optional(),
  icon: url.optional(),
  urlHome: url.optional(),
  urlAway: url.optional(),
  household: z.boolean().optional(),
  hasLogin: z.enum(["yes", "no", "unknown"]).optional(),
  hidden: z.boolean().optional(),
  access: z.array(z.string().max(40)).max(100).optional(),
});

function accessChanges(id: string, body: { household?: boolean; access?: string[] }): boolean {
  if (body.household !== undefined) {
    const cur = one<{ household: number | null }>("SELECT household FROM app_prefs WHERE app_id = ?", id);
    if ((cur?.household ?? 0) !== (body.household ? 1 : 0)) return true;
  }
  if (body.access !== undefined) {
    const cur = new Set(all<{ user_id: string }>("SELECT user_id FROM app_access WHERE app_id = ?", id).map((r) => r.user_id));
    const next = new Set(body.access);
    if (cur.size !== next.size || [...next].some((u) => !cur.has(u))) return true;
  }
  return false;
}

export const PATCH = route({ auth: "admin", body }, ({ params, body, user, session, ip, zone }) => {
  const id = decodeURIComponent(String(params.id));
  // Who can open an app is an access decision (same as People → Apps): confirm it's you first.
  if (accessChanges(id, body) && !hasRecentAuth(session)) throw new AppError("reauth", "Confirm it's you to continue.", 403);
  const blank = (v: string | undefined) => (v === undefined ? undefined : v.trim() || null);
  setAppPrefs(id, {
    display_name: blank(body.displayName),
    description: blank(body.description),
    icon: blank(body.icon),
    url_home: blank(body.urlHome),
    url_away: blank(body.urlAway),
    household: body.household,
    has_login: body.hasLogin,
    hidden: body.hidden,
  });
  if (body.access) {
    run("DELETE FROM app_access WHERE app_id = ?", id);
    for (const uid of body.access) run("INSERT OR IGNORE INTO app_access (app_id, user_id) VALUES (?, ?)", id, uid);
  }
  audit(user, { action: "app.settings", target: id, summary: `Changed settings for ${id}`, detail: body }, { ip, zone });
  return { ok: true };
});
