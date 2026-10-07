import { route } from "@/server/api";
import { notFound } from "@/server/errors";
import { getInventoryState, findDisk } from "@/server/storage/inventory";
import { smartDetail, smartFor } from "@/server/storage/smart";

/** GET /api/storage/disks/:disk: one disk (by id, name or serial) with its full SMART table and history. */
export const GET = route({ auth: "admin" }, async ({ params }) => {
  const key = decodeURIComponent(String(params.disk ?? ""));
  const s = await getInventoryState();
  const disk = findDisk(s, key);
  if (!disk) throw notFound("That disk");
  disk.smart = smartFor(disk.id);
  return { disk, smart: smartDetail(disk.id) };
});
