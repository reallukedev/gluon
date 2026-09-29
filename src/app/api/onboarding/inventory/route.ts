import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { inventoryAddresses, inventoryApps, inventoryAttention, inventoryDrives } from "@/server/onboarding";

const TIMEOUT_MS = 20_000;

const PART_NAME = { apps: "the apps", drives: "the drives", addresses: "the public addresses", attention: "what needs you" } as const;

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new AppError("timeout", `Reading ${what} took too long. The server may be busy.`, 504)), TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * GET /api/onboarding/inventory?part=apps|drives|addresses|attention — the admin's first look at the
 * server, one part per request so each shows as soon as it's read and one failing doesn't hide the rest.
 * Read-only.
 */
export const GET = route({ auth: "admin", query: z.object({ part: z.enum(["apps", "drives", "addresses", "attention"]) }) }, async ({ query }) => {
  const what = PART_NAME[query.part];
  try {
    switch (query.part) {
      case "apps":
        return await withTimeout(inventoryApps(), what);
      case "drives":
        return await withTimeout(inventoryDrives(), what);
      case "addresses":
        return inventoryAddresses();
      case "attention":
        return inventoryAttention();
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    console.error(`[gluon] first look: couldn't read ${what}`, e);
    throw new AppError("scan_failed", `Gluon couldn't read ${what} just now.`, 500, e instanceof Error && e.message ? { detail: e.message.slice(0, 300) } : undefined);
  }
});
