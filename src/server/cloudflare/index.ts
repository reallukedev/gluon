import "server-only";
import { every, onStart } from "../jobs";
import { getSetting } from "../settings";
import { sync } from "./service";

/** Gluon's own dynamic DNS: every 5 minutes, and soon after start-up. */
onStart("cloudflare", () => {
  const run = () => (getSetting("cloudflare") ? sync() : undefined);
  setTimeout(() => void Promise.resolve(run()).catch(() => undefined), 20_000).unref?.();
  every(5 * 60_000, run);
});
