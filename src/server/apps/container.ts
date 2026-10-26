import "server-only";
import { AppError, notFound } from "../errors";

interface AppWithContainers {
  name: string;
  self: boolean;
  containers: { id: string; shortId: string; name: string }[];
}

/**
 * The container `ref` (a name, or a full or short id) as one of `app`'s own, or a refusal. Gluon's
 * own container may only be restarted: stopping or pausing it would cut off the page asking.
 */
export function containerFor<T extends AppWithContainers>(app: T, ref: string, action: string): T["containers"][number] {
  const r = ref.replace(/^\//, "");
  const c = app.containers.find((x) => x.name === r || x.id === r || (r.length >= 12 && x.id.startsWith(r)) || x.shortId === r);
  if (!c) throw notFound(`A container called ${r} in ${app.name}`);
  if (app.self && action !== "restart") throw new AppError("self", "Gluon can't stop or pause its own container from here. Restart it instead.", 409);
  return c;
}
