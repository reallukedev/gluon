import "server-only";
// Side-effect module: background samplers for the Home widgets that read this machine (Internet, Power).
import { every, onStart } from "../jobs";
import { pruneInternet, startInternetProbe } from "./internet";
import { startPowerSampler } from "./power";

onStart("home-widgets", () => {
  startInternetProbe();
  startPowerSampler();
  every(60 * 60_000, pruneInternet, { immediate: true });
});

export {};
