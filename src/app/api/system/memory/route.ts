import { route } from "@/server/api";
import { memoryBreakdown } from "@/server/system/memory";

export const GET = route({ auth: "admin" }, () => memoryBreakdown());
