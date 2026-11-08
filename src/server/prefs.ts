import "server-only";
import { cookies } from "next/headers";
import { encodeUiCookie, uiBits, UI_COOKIE, type Prefs } from "@/lib/prefs";
import { defaultPrefs, prefsSchema } from "@/lib/prefs-schema";
import { now, one, run } from "./db";

export function getPrefs(userId: string): Prefs {
  const row = one<{ json: string }>("SELECT json FROM user_prefs WHERE user_id = ?", userId);
  if (!row) return defaultPrefs;
  let stored: unknown;
  try {
    stored = JSON.parse(row.json);
  } catch {
    return defaultPrefs; // a damaged row must not break every page for this person
  }
  const parsed = prefsSchema.safeParse({ ...defaultPrefs, ...(stored && typeof stored === "object" ? stored : {}) });
  return parsed.success ? parsed.data : defaultPrefs;
}

/** Unknown keys are dropped, invalid values rejected. */
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

/** So the next server render has no theme flash. */
export async function writeUiCookie(p: Prefs) {
  (await cookies()).set(UI_COOKIE, encodeUiCookie(uiBits(p)), {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 400 * 86_400,
  });
}
