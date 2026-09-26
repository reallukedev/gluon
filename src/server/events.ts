import "server-only";
import { EventEmitter } from "node:events";

/** In-process pub/sub used to fan live data out to SSE subscribers. */
type G = typeof globalThis & { __gluonBus?: EventEmitter };
const g = globalThis as G;

export function bus(): EventEmitter {
  if (!g.__gluonBus) {
    g.__gluonBus = new EventEmitter();
    g.__gluonBus.setMaxListeners(500);
  }
  return g.__gluonBus;
}

export function publish(topic: string, data: unknown) {
  bus().emit(topic, data);
}

export function subscribe(topic: string, fn: (data: unknown) => void): () => void {
  bus().on(topic, fn);
  return () => bus().off(topic, fn);
}
