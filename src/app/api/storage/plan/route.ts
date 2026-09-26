import { route } from "@/server/api";
import { planBody } from "@/server/storage/schemas";
import { planMount, planUnmount, planPersist } from "@/server/storage/ops";
import { planRename } from "@/server/storage/rename";
import { planSetup } from "@/server/storage/setup";

/**
 * POST /api/storage/plan — preview an operation; nothing changes.
 *   { op: "mount", device, target, persist?, noatime? }         → MountPlan
 *   { op: "unmount", target }                                   → UnmountPlan (with holders)
 *   { op: "persist", targets: string[] | null, noatime? }       → PersistPlan
 *   { op: "rename", target, newPath, symlink, persist }         → RenamePlan (send plan.hash back to run it)
 *   { op: "setup", disk, label, mountPath?, noatime? }          → SetupPlan (send plan.hash + the serial back)
 */
export const POST = route({ auth: "admin", body: planBody }, async ({ body }) => {
  switch (body.op) {
    case "mount": {
      const { entry: _e, record: _r, ...plan } = await planMount(body);
      return plan;
    }
    case "unmount": {
      const { record: _r, fstabIndex: _i, ...plan } = await planUnmount(body.target);
      return plan;
    }
    case "persist":
      return (await planPersist(body.targets, { noatime: body.noatime })).plan;
    case "rename":
      return (await planRename(body)).plan;
    case "setup":
      return (await planSetup(body)).plan;
  }
});
