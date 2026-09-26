import { route } from "@/server/api";
import { journalUnits } from "@/server/diagnostics/logs";

/** systemd units that have journal entries, for the log filter. */
export const GET = route({ auth: "admin" }, async () => ({ units: await journalUnits() }));
