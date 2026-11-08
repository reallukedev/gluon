import "server-only";
import { every, onStart } from "../jobs";
import { getSetting } from "../settings";
import { ddnsRunning } from "../network/ddns";
import { scheduleSync, sync } from "./service";

type G = typeof globalThis & { __gluonDdnsSeen?: boolean | null };
const g = globalThis as G;

onStart("cloudflare", () => {
  const run = () => (getSetting("cloudflare") ? sync() : undefined);
  setTimeout(() => void Promise.resolve(run()).catch(() => undefined), 20_000).unref?.();
  every(5 * 60_000, run);
  // Gluon holds off on cloudflare-ddns's names while it runs; once it stops (or is removed), take
  // them over within a minute rather than at the next 5-minute pass.
  every(60_000, async () => {
    if (!getSetting("cloudflare")) return;
    const now = await ddnsRunning().catch(() => undefined);
    if (now === undefined) return;
    const was = g.__gluonDdnsSeen;
    g.__gluonDdnsSeen = now;
    if (was !== undefined && was !== now) scheduleSync(0);
  });
});
