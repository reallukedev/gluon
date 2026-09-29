import "server-only";
import type { User } from "../auth/users";
import { filesystems } from "../metrics/sampler";
import { powerAvailable } from "./power";
import { scheduleAvailable } from "./schedule";
import { guestWifiConfigured } from "./guest-wifi";
import type { LocalWidgetAvailability } from "@/lib/home-widgets-types";

/** Home widgets that read this machine: can this person use them here, and if not, why. Cheap checks only. */
export function localAvailability(user: Pick<User, "role">): LocalWidgetAvailability[] {
  const admin = user.role === "admin";
  const out: LocalWidgetAvailability[] = [{ type: "household.internet", available: true, reason: null }];
  const wifi = guestWifiConfigured();
  out.push({
    type: "household.guest-wifi",
    // Admins can add it and set it up from the widget; members need an admin to set it up first.
    available: admin || wifi,
    reason: admin || wifi ? null : "Whoever runs the server hasn't added the guest network yet.",
  });
  if (admin) {
    const power = powerAvailable();
    out.push({ type: "server.power", available: power.available, reason: power.reason });
    const sched = scheduleAvailable();
    out.push({ type: "server.schedule", available: sched.available, reason: sched.reason });
    // Space works anywhere Gluon can see a filesystem; without history yet, the widget says it's still learning.
    const seen = filesystems().length > 0;
    out.push({ type: "server.space", available: seen, reason: seen ? null : "Gluon can't see any disks on this machine yet." });
  }
  return out;
}
