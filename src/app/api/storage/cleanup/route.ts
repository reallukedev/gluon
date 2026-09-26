import { route } from "@/server/api";
import { cleanupPreview } from "@/server/storage/cleanup";

/**
 * GET /api/storage/cleanup — what each cleanup would free, and exactly which Docker images,
 * containers and volumes it would remove. Run one with POST /api/storage/operations { op: "cleanup", … }.
 */
export const GET = route({ auth: "admin" }, () => cleanupPreview());
