import { route } from "@/server/api";
import { securityState } from "@/server/diagnostics/checkup/state";

export const GET = route({ auth: "admin" }, () => securityState());
