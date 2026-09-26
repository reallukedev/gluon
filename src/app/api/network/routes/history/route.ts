import { z } from "zod";
import { route } from "@/server/api";
import { listHistory } from "@/server/caddy/routes";
import { restoreRoutes } from "@/server/network/routes-service";

/** Snapshots taken before each save (newest first). */
export const GET = route({ auth: "admin" }, () => ({ entries: listHistory() }));

const body = z.object({
  id: z.string().regex(/^\d{8}T\d{6}\d*Z$/, "That snapshot doesn't exist."),
  rev: z.string().min(1).max(64),
});

/** Restore a snapshot (applied like a save: validated, loaded into Caddy, snapshotted, audited). */
export const POST = route({ auth: "admin", body, recent: true }, ({ user, body, ip, zone }) => restoreRoutes(user, { ip, zone }, body));
