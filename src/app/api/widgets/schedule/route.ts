import { route } from "@/server/api";
import { scheduleData } from "@/server/widgets/schedule";

/** What the server will do on its own next: systemd timers, Gluon's update window, certificate renewals. Admins. */
export const GET = route({ auth: "admin" }, () => scheduleData());
