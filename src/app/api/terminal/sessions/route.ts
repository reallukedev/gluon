import { z } from "zod";
import { ndjson, route } from "@/server/api";
import { AppError } from "@/server/errors";
import { parseTarget } from "@/lib/terminal/types";
import { resolveTarget } from "@/server/terminal/targets";
import { open } from "@/server/terminal/sessions";
import { requireTerminalAuth } from "@/server/terminal/grant";

const body = z.object({
  target: z.string().max(140),
  mode: z.enum(["run", "shell"]),
  command: z.string().max(8000).optional(),
  cwd: z.string().max(1024).nullish(),
  rows: z.number().int().min(2).max(500),
  cols: z.number().int().min(10).max(1000),
});

/**
 * Run a command (Commands mode) or open a shell (Terminal mode) and stream its output as NDJSON.
 * Keystrokes, resizes and Stop go to /api/terminal/sessions/[id]. Closing this stream ends it.
 * Needs a recent sign-in, stretched for terminal work (see grant.ts).
 */
export const POST = route({ auth: "admin", body, burst: { limit: 40, windowMs: 60_000 } }, async ({ req, body, user, session, ip, zone }) => {
  requireTerminalAuth(session);
  const target = parseTarget(body.target);
  if (!target) throw new AppError("invalid", "That isn't a place commands can run.", 400);
  if (body.mode === "run" && !body.command?.trim()) throw new AppError("invalid", "Type a command to run.", 400, { field: "command" });
  const resolved = await resolveTarget(target);
  const s = await open({ user, ip, zone, mode: body.mode, target: resolved, command: body.command, cwd: body.cwd, rows: body.rows, cols: body.cols });
  return ndjson((emit, signal) => s.stream(emit, signal), req.signal);
});
