import { z } from "zod";
import { route } from "@/server/api";
import { get, input, resize, stop } from "@/server/terminal/sessions";
import { param } from "@/app/api/docker/params";

const body = z.object({
  input: z.string().max(65_536).optional(),
  resize: z.object({ rows: z.number().int().min(2).max(500), cols: z.number().int().min(10).max(1000) }).optional(),
  stop: z.literal(true).optional(),
});

/** Typing, resizing and stopping, for a command or terminal this admin opened. */
export const POST = route({ auth: "admin", body, maxBody: 128 * 1024, burst: { limit: 2400, windowMs: 60_000 } }, async ({ params, body, user }) => {
  const s = get(param(params.id), user.id);
  if (body.resize) resize(s, body.resize.rows, body.resize.cols);
  if (body.input) input(s, body.input);
  if (body.stop) await stop(s, "stopped");
  return { ok: true };
});
