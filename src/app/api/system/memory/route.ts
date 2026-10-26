import { route } from "@/server/api";
import { memoryBreakdown } from "@/server/system/memory";

/** Memory in use, split by app. */
export const GET = route({ auth: "admin" }, () => memoryBreakdown());
