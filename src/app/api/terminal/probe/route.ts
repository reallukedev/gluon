import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { parseTarget } from "@/lib/terminal/types";
import { probeTarget, resolveTarget } from "@/server/terminal/targets";

const query = z.object({ target: z.string().max(140) });

/** The target's shell, user, starting folder and programs, for the prompt and its suggestions. */
export const GET = route({ auth: "admin", query, burst: { limit: 60, windowMs: 60_000 } }, async ({ query }) => {
  const target = parseTarget(query.target);
  if (!target) throw new AppError("invalid", "That isn't a place commands can run.", 400);
  return probeTarget(await resolveTarget(target));
});
