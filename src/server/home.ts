import "server-only";
import { ADMIN_DEFAULT, HOUSEHOLD_DEFAULT, layoutSchema, type HomeLayout } from "@/lib/home";
import { now, one, run } from "./db";
import { badRequest } from "./errors";
import type { Role } from "./auth/users";

const MAX_BYTES = 64 * 1024;

function read(owner: string): HomeLayout | null {
  const row = one<{ json: string }>("SELECT json FROM home_layouts WHERE owner = ?", owner);
  if (!row) return null;
  const parsed = layoutSchema.safeParse(JSON.parse(row.json));
  return parsed.success ? parsed.data : null;
}

function write(owner: string, layout: unknown): HomeLayout {
  const parsed = layoutSchema.safeParse(layout);
  if (!parsed.success) throw badRequest("That layout isn't valid.");
  const json = JSON.stringify(parsed.data);
  if (json.length > MAX_BYTES) throw badRequest("Your home page is too big to save. Remove a few widgets or shorten notes.");
  run(
    "INSERT INTO home_layouts (owner, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
    owner,
    json,
    now(),
  );
  return parsed.data;
}

export function householdDefault(): HomeLayout {
  return read("__default__") ?? HOUSEHOLD_DEFAULT;
}

export function homeFor(userId: string, role: Role): { layout: HomeLayout; personal: boolean } {
  const mine = read(userId);
  if (mine) return { layout: mine, personal: true };
  return { layout: role === "admin" ? ADMIN_DEFAULT : householdDefault(), personal: false };
}

export const saveHome = (userId: string, layout: unknown) => write(userId, layout);
export const resetHome = (userId: string) => run("DELETE FROM home_layouts WHERE owner = ?", userId);
export const saveHouseholdDefault = (layout: unknown) => write("__default__", layout);
