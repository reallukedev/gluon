import { route, ndjson } from "@/server/api";
import { getApp, invalidateApps } from "@/server/docker/apps";
import { streamCompose } from "@/server/docker/actions";
import { followState, startAction } from "@/server/appstore/umbrel";
import type { UmbrelAppState } from "@/server/platform/umbrel";
import { AppError, notFound } from "@/server/errors";
import { audit } from "@/server/audit";
import { lockApps } from "@/server/apps/lock";

const STATE_TEXT: Partial<Record<UmbrelAppState, string>> = { updating: "Updating", starting: "Starting", restarting: "Restarting", ready: "Running", running: "Running", stopped: "Stopped" };

/** Pull newer images and recreate the containers that changed, streaming Compose's output. */
export const POST = route({ auth: "admin", recent: true }, async ({ req, params, user, ip, zone }) => {
  const app = await getApp(decodeURIComponent(String(params.id)));
  if (!app) throw notFound("That app");
  if (app.self) throw new AppError("self", "Gluon can't update itself from here. Update it in Settings.");
  const lock = lockApps([app.id], `${app.name} is updating`);
  const run = (fn: (emit: (e: unknown) => void) => Promise<void>) => ndjson((emit) => fn(emit).finally(() => lock.release()), req.signal);
  const signal = req.signal;
  if (app.umbrel) {
    const target = app.umbrel.latest;
    return run(async (emit) => {
      emit({ type: "step", text: target ? `Asking Umbrel to update ${app.name} to ${target}…` : `Asking Umbrel to update ${app.name}…` });
      // Umbrel answers the update call when it's over; until then its state shows the progress. A
      // look that comes before Umbrel has started says "running", which isn't "updated".
      const action = startAction(app.id, "update");
      const early = await Promise.race([action, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
      if (early && !early.ok && early.error) {
        emit({ type: "done", ok: false, message: early.error });
        audit(user, { action: "app.update", target: app.id, summary: `Umbrel couldn't update ${app.name}`, outcome: "failed" }, { ip, zone });
        return;
      }
      const end = await followState(
        app.id,
        (s, seen) => seen.has("updating") && (s === "ready" || s === "running" || s === "stopped"),
        (s, progress) => emit({ type: "line", text: `${STATE_TEXT[s] ?? s}${progress ? ` · ${Math.round(progress)}%` : ""}`, stream: "out" }),
        { action, signal },
      );
      invalidateApps();
      if (signal.aborted) return;
      const result = await Promise.race([action, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
      const ok = (end === "ready" || end === "running") && result?.ok !== false;
      const message = ok
        ? `${app.name} is up to date.`
        : end === "updating"
          ? `Umbrel is still updating ${app.name}. Check back in a few minutes.`
          : end === "unknown"
            ? `Gluon lost track of the update of ${app.name}. Check its page to see whether it finished.`
            : `Umbrel finished with ${app.name} ${STATE_TEXT[end]?.toLowerCase() ?? end}.${result?.error ? ` ${result.error}` : " Its logs in Umbrel say why."}`;
      emit({ type: "done", ok, message });
      audit(user, { action: "app.update", target: app.id, summary: ok ? `Updated ${app.name} through Umbrel` : `Umbrel couldn't update ${app.name}`, outcome: ok ? "ok" : "failed" }, { ip, zone });
    });
  }
  if (!app.configFile) {
    lock.release();
    throw new AppError("no_compose", "Only Compose apps can be updated from here.");
  }
  return run(async (emit) => {
    emit({ type: "step", text: "Downloading newer images…" });
    const pull = await streamCompose(app, ["pull"], (text, stream) => emit({ type: "line", text, stream }), signal);
    if (pull !== 0) {
      emit({ type: "done", ok: false, message: "Couldn't download the images. Nothing was changed." });
      audit(user, { action: "app.update", target: app.id, summary: `Tried to update ${app.name}`, outcome: "failed" }, { ip, zone });
      return;
    }
    emit({ type: "step", text: "Recreating anything that changed…" });
    // Not stopped when the page goes away: halfway through, some containers are removed and not yet recreated.
    const up = await streamCompose(app, ["up", "-d", "--remove-orphans"], (text, stream) => emit({ type: "line", text, stream }));
    emit({ type: "done", ok: up === 0, message: up === 0 ? `${app.name} is up to date.` : "The new version didn't start. The output above says why." });
    audit(user, { action: "app.update", target: app.id, summary: up === 0 ? `Updated ${app.name}` : `Updated ${app.name}, but it didn't start`, outcome: up === 0 ? "ok" : "failed" }, { ip, zone });
  });
});
