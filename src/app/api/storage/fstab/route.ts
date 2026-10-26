import { route } from "@/server/api";
import { getInventory } from "@/server/storage/inventory";
import { readFstabText } from "@/server/storage/fstab";

/** GET /api/storage/fstab: the file as text plus each entry explained, and Gluon's backups. */
export const GET = route({ auth: "admin" }, async () => {
  const inv = await getInventory(true);
  return { text: readFstabText(), entries: inv.fstab.entries, backups: inv.fstab.backups };
});
