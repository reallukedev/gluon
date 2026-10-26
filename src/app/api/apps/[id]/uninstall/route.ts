import { z } from "zod";
import { route } from "@/server/api";
import { runUninstall, uninstallPlan } from "@/server/apps/uninstall";

/** Exactly what uninstalling would remove and keep, in both modes. Changes nothing. */
export const GET = route({ auth: "admin" }, ({ params }) => uninstallPlan(decodeURIComponent(String(params.id))));

const body = z.object({
  mode: z.enum(["keep", "everything"]),
  planId: z.string().regex(/^[a-f0-9]{20}$/, "Check the list again."),
  /** "Delete everything": exactly the folders and volumes the person left ticked. */
  remove: z.array(z.string().min(1).max(4096)).max(500).optional(),
});

export const POST = route({ auth: "admin", recent: true, body }, ({ params, body, user, ip, zone }) =>
  runUninstall(decodeURIComponent(String(params.id)), body.mode, body.planId, user, { ip, zone }, body.remove),
);
