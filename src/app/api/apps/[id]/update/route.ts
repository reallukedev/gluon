import { route, ndjson } from "@/server/api";
import { getApp } from "@/server/docker/apps";
import { followUmbrel, streamCompose } from "@/server/docker/actions";
import { umbrelAction } from "@/server/platform/umbrel";
import { AppError, notFound } from "@/server/errors";
import { audit } from "@/server/audit";
import { lockApps } from "@/server/apps/lock";

/** Pull newer images and recreate the containers that changed, streaming Compose's output. */
export const POST = route({ auth: "admin", recent: true }, async ({ req, params, user, ip, zone }) => {
  const app = await getApp(decodeURIComponent(String(params.id)));
  if (!app) throw notFound("That app");
  if (app.self) throw new AppError("self", "Gluon can't update itself from here.");
  const lock = lockApps([app.id], `${app.name} is updating`);
  const run = (fn: (emit: (e: unknown) => void) => Promise<void>) => ndjson((emit) => fn(emit).finally(() => lock.release()), req.signal);
  const signal = req.signal;
  if (app.umbrel) {
    const target = app.umbrel.latest;
    return run(async (emit) => {
      emit({ type: "step", text: target ? `Asking Umbrel to update ${app.name} to ${target}…` : `Asking Umbrel to update ${app.name}…` });
      await umbrelAction(app.id, "update");
      const end = await followUmbrel(app.id, (s) => s === "ready" || s === "running" || s === "stopped", (text) => emit({ type: "line", text, stream: "out" }), req.signal);
      const ok = end === "ready" || end === "running";
      emit({ type: "done", ok, message: ok ? `${app.name} is up to date.` : `Umbrel finished with ${app.name} ${end}. Its logs in Umbrel say why.` });
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
    const up = await streamCompose(app, ["up", "-d", "--remove-orphans"], (text, stream) => emit({ type: "line", text, stream }), signal);
    emit({ type: "done", ok: up === 0, message: up === 0 ? `${app.name} is up to date.` : "The new version didn't start. The output above says why." });
    audit(user, { action: "app.update", target: app.id, summary: up === 0 ? `Updated ${app.name}` : `Updated ${app.name}, but it didn't start`, outcome: up === 0 ? "ok" : "failed" }, { ip, zone });
  });
});
