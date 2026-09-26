import { z } from "zod";
import { route } from "@/server/api";
import { getInventory } from "@/server/storage/inventory";

/** GET /api/storage — disks → partitions → filesystems → mounts, with fstab, SMART and usage. */
export const GET = route({ auth: "admin", query: z.object({ refresh: z.enum(["0", "1"]).optional() }) }, ({ query }) => getInventory(query.refresh === "1"));
