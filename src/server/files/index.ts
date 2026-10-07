import "server-only";
import { all } from "../db";
import { every, onStart } from "../jobs";
import { registerCheck, registerRemedy } from "../alerts/engine";
import { raise, resolveMissing } from "../findings";
import { filesystems } from "../metrics/sampler";
import { getSetting } from "../settings";
import { AppError } from "../errors";
import { formatBytes, plural } from "@/lib/format";
import { markInterrupted } from "./jobs";
import { cleanupUploads } from "./upload";
import { deleteForever, reconcileTrash, trashTotals } from "./trash";

// Side-effect module: background jobs and the "trash is holding space" finding. (Universal search
// finds files through searchNames in ./search.)

onStart("files", async () => {
  markInterrupted();
  cleanupUploads(true);
  every(60 * 60_000, () => cleanupUploads());
  // Trash bookkeeping touches every drive; stagger it off the startup path.
  setTimeout(() => void reconcileTrash().catch((e) => console.error("[gluon] trash reconcile failed", e)), 20_000).unref?.();
  every(30 * 60_000, () => reconcileTrash());
});

const TRASH_MIN = 1024 ** 3;

registerCheck("files-trash", 10 * 60_000, () => {
  const { diskAttention } = getSetting("thresholds");
  const open = new Set<string>();
  const fsList = filesystems();
  for (const t of trashTotals()) {
    if (t.bytes < TRASH_MIN) continue;
    const f = fsList.find((x) => x.mount === t.fsRoot);
    if (!f) continue;
    const share = f.size ? t.bytes / f.size : 0;
    if (f.pct < diskAttention && share < 0.1) continue;
    const id = `files.trash:${t.fsRoot}`;
    open.add(id);
    raise({
      id,
      kind: "files.trash",
      severity: "attention",
      subject: t.fsRoot,
      title: `The trash is holding ${formatBytes(t.bytes)} on ${t.fsRoot}`,
      cause: `${plural(t.items, "deleted item")} still use space until the trash is emptied. ${t.fsRoot} is ${Math.round(f.pct)}% full.`,
      detail: { fsRoot: t.fsRoot, bytes: t.bytes, items: t.items, pct: f.pct },
      remedy: {
        action: "files.emptyTrash",
        label: `Free ${formatBytes(t.bytes)}`,
        params: { fsRoot: t.fsRoot },
        confirm: {
          title: `Empty the trash on ${t.fsRoot}?`,
          consequences: [`Permanently deletes ${plural(t.items, "item")} (${formatBytes(t.bytes)}) that were moved to the trash on ${t.fsRoot}.`, "This can't be undone."],
        },
      },
    });
  }
  resolveMissing("files.trash", open);
});

registerRemedy("files.emptyTrash", {
  recent: true,
  async run({ user, params }) {
    if (user.role !== "admin") throw new AppError("forbidden", "Only admins can empty the trash.", 403);
    const fsRoot = String(params.fsRoot ?? "");
    const ids = all<{ id: string }>("SELECT id FROM trash WHERE fs_root = ?", fsRoot).map((r) => r.id);
    if (!ids.length) return { message: `The trash on ${fsRoot} is already empty.` };
    deleteForever(user, ids, {});
    return { message: `Emptying the trash on ${fsRoot} (${plural(ids.length, "item")}).` };
  },
});
