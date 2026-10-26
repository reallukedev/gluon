import "server-only";
// Side-effect module: keeps an eye on the home router (status, traffic, restarts, broadband drops).
import { every, onStart } from "../jobs";
import { pruneRouter, tick } from "./monitor";

onStart("router-monitor", () => {
  // Cheap when nothing is due: the monitor decides what to read and how often.
  every(5_000, tick);
  every(60 * 60_000, pruneRouter, { immediate: true });
});

export {};
