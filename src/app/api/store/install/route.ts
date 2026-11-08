import { z } from "zod";
import { route, ndjson } from "@/server/api";
import { activePlatform } from "@/server/platform";
import { umbrelApps, umbrelStores, type UmbrelAppState } from "@/server/platform/umbrel";
import { followState, startAction } from "@/server/appstore/umbrel";
import { invalidateApps } from "@/server/docker/apps";
import { publish } from "@/server/events";
import { AppError, notFound } from "@/server/errors";
import { audit } from "@/server/audit";

const body = z.object({ appId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/) });

const STATE_TEXT: Partial<Record<UmbrelAppState, string>> = { installing: "Installing", starting: "Starting", ready: "Running", running: "Running", stopped: "Stopped", "not-installed": "Not installed" };

/** Install an app from the Umbrel store, streaming its progress until it's running (or fails). */
export const POST = route({ auth: "admin", body, recent: true }, async ({ req, body, user, ip, zone }) => {
  if ((await activePlatform()) !== "umbrel") throw new AppError("platform", "Installing apps from here needs Gluon to be working with Umbrel.", 409);
  const app = (await umbrelStores()).flatMap((s) => s.apps).find((a) => a.id === body.appId);
  if (!app) throw notFound("That app");
  const installedIds = new Set((await umbrelApps(0)).map((a) => a.id));
  if (installedIds.has(app.id)) throw new AppError("installed", `${app.name} is already installed.`, 409);
  const missing = app.dependencies.filter((d) => !installedIds.has(d));
  if (missing.length) throw new AppError("dependencies", `${app.name} needs ${missing.join(", ")} installed first.`, 409, { missing });

  return ndjson(async (emit) => {
    emit({ type: "step", text: `Asking Umbrel to install ${app.name}…` });
    // Umbrel answers the install call only when it's over (false when the app didn't come up),
    // so the state is followed meanwhile and the answer decides how it ended.
    const action = startAction(app.id, "install");
    const early = await Promise.race([action, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    if (early && !early.ok && early.error) {
      emit({ type: "done", ok: false, message: early.error });
      return;
    }
    const end = await followState(
      app.id,
      (s, seen) => s === "ready" || s === "running" || (seen.has("installing") && (s === "not-installed" || s === "stopped")),
      (s, progress) => emit({ type: "line", text: `${STATE_TEXT[s] ?? s}${progress ? ` · ${Math.round(progress)}%` : ""}`, stream: "out" }),
      { action, signal: req.signal },
    );
    invalidateApps();
    publish("apps.changed", { id: app.id });
    if (req.signal.aborted) {
      // The page went away; Umbrel carries on with the install.
      audit(user, { action: "app.install", target: app.id, summary: `Started installing ${app.name}` }, { ip, zone });
      return;
    }
    // A finished call that said false is a failed install whatever the last look showed.
    const result = await Promise.race([action, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
    const ok = (end === "ready" || end === "running") && result?.ok !== false;
    const message = ok
      ? `${app.name} is installed and running.`
      : end === "installing" || end === "starting"
        ? `Umbrel is still installing ${app.name}. Check Apps in a few minutes.`
        : end === "stopped"
          ? `${app.name} is installed but stopped right after starting. Its logs say why.`
          : end === "unknown"
            ? `Gluon lost track of the install of ${app.name}. Check Apps to see whether it finished.`
            : `Umbrel couldn't install ${app.name}.${result?.error ? ` ${result.error}` : " Its logs in Umbrel say why."}`;
    emit({ type: "done", ok, message });
    audit(user, { action: "app.install", target: app.id, summary: ok ? `Installed ${app.name} from ${app.storeId === "umbrel-app-store" ? "the Umbrel App Store" : app.storeId}` : `Tried to install ${app.name}`, outcome: ok ? "ok" : "failed" }, { ip, zone });
  }, req.signal);
});
