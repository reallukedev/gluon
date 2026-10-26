import "server-only";
import { cookies } from "next/headers";
import { defaultPrefs, encodeUiCookie, prefsSchema, uiBits, UI_COOKIE, type Prefs } from "@/lib/prefs";
import { now, one, run } from "./db";

export function getPrefs(userId: string): Prefs {
  const row = one<{ json: string }>("SELECT json FROM user_prefs WHERE user_id = ?", userId);
  if (!row) return defaultPrefs;
  const parsed = prefsSchema.safeParse({ ...defaultPrefs, ...JSON.parse(row.json) });
  return parsed.success ? parsed.data : defaultPrefs;
}

/** Merge a partial update over the stored prefs; unknown keys are dropped, invalid values rejected. */
export function updatePrefs(userId: string, patch: Record<string, unknown>): Prefs {
  const merged = prefsSchema.parse({ ...getPrefs(userId), ...patch });
  run(
    "INSERT INTO user_prefs (user_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
    userId,
    JSON.stringify(merged),
    now(),
  );
  return merged;
}

/** Mirror the appearance prefs into a cookie so the next server render has no theme flash. */
export async function writeUiCookie(p: Prefs) {
  (await cookies()).set(UI_COOKIE, encodeUiCookie(uiBits(p)), {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 400 * 86_400,
  });
}
