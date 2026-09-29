import { z } from "zod";
import { route, ndjson } from "@/server/api";
import { execInContainer, prepareExec } from "@/server/dockerx/containers";
import { findContainer } from "@/server/dockerx/core";
import { audit } from "@/server/audit";
import { param } from "../../../params";

const body = z.object({
  command: z.string().min(1, "Type a command to run.").max(2000),
  user: z.string().max(65).nullish(),
  workdir: z.string().max(400).nullish(),
  timeoutSec: z.number().int().min(5).max(600).default(60),
});

/** Run one command in a running container (no terminal, no input) and stream its output. */
export const POST = route({ auth: "admin", recent: true, body, burst: { limit: 20, windowMs: 60_000 } }, async ({ req, params, body, user, ip, zone }) => {
  const id = param(params.id);
  const { ref } = await findContainer(id);
  const prepared = await prepareExec(id, body);
  return ndjson(async (emit) => {
    const r = await execInContainer(prepared, emit, req.signal);
    audit(
      user,
      {
        action: "docker.container.exec",
        target: ref.app?.id ?? ref.name,
        summary: `Ran a command in ${r.name}${r.timedOut ? " (stopped at the time limit)" : r.exitCode ? ` (exit code ${r.exitCode})` : ""}`,
        detail: { container: r.name, command: body.command.slice(0, 500), user: body.user ?? null, exitCode: r.exitCode },
        outcome: r.exitCode === 0 ? "ok" : "failed",
      },
      { ip, zone },
    );
  }, req.signal);
});
