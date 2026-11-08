import { route } from "@/server/api";
import { journalUnits } from "@/server/diagnostics/logs";

export const GET = route({ auth: "admin" }, async () => ({ units: await journalUnits() }));
