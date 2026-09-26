import { route } from "@/server/api";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { getPrefs, updatePrefs, writeUiCookie } from "@/server/prefs";

export const GET = route({ auth: "user" }, ({ user }) => getPrefs(user.id));

export const PATCH = route({ auth: "user", body: z.record(z.string(), z.unknown()) }, async ({ user, body }) => {
  try {
    const next = updatePrefs(user.id, body);
    await writeUiCookie(next);
    return next;
  } catch (e) {
    if (e instanceof z.ZodError) throw new AppError("invalid", "That setting has an unexpected value.", 400);
    throw e;
  }
});
