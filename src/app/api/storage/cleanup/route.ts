import { route } from "@/server/api";
import { cleanupPreview } from "@/server/storage/cleanup";

/** Run one with POST /api/storage/operations { op: "cleanup", … }. */
export const GET = route({ auth: "admin" }, () => cleanupPreview());
