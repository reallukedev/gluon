import { z } from "zod";
import { route } from "@/server/api";
import { runAllChecks } from "@/server/alerts/engine";
import { counts } from "@/server/findings";
import { audit } from "@/server/audit";
import { plural } from "@/lib/format";

/** Commands the palette offers that have no endpoint of their own. Admins only. */
const body = z.object({ id: z.enum(["checks.run"]) });

const CHECKS_WAIT_MS = 25_000;

export const POST = route({ auth: "admin", body, burst: { limit: 6, windowMs: 60_000 } }, async ({ user, body, ip, zone }) => {
  switch (body.id) {
    case "checks.run": {
      let finished = false;
      await Promise.race([runAllChecks().then(() => (finished = true)), new Promise((r) => setTimeout(r, CHECKS_WAIT_MS))]);
      audit(user, { action: "checks.run", target: null, summary: "Ran every health check" }, { ip, zone });
      if (!finished) return { ok: true, message: "The checks are still running. Status updates when they finish." };
      const c = counts();
      const open = c.fault + c.attention;
      return { ok: true, message: open ? `Checked everything: ${plural(open, "thing needs", "things need")} you.` : "Checked everything. Nothing needs you." };
    }
  }
});
