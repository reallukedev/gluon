import { route } from "@/server/api";
import { scheduleData } from "@/server/widgets/schedule";

export const GET = route({ auth: "admin" }, () => scheduleData());
