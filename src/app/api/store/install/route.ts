import { z } from "zod";
import { route, ndjson } from "@/server/api";
import { activePlatform } from "@/server/platform";
import { umbrelAction, umbrelApps, umbrelStores } from "@/server/platform/umbrel";
import { followUmbrel } from "@/server/docker/actions";
import { AppError, notFound } from "@/server/errors";
import { audit } from "@/server/audit";

const body = z.object({ appId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/) });

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
    try {
      await umbrelAction(app.id, "install");
    } catch (e) {
      emit({ type: "done", ok: false, message: e instanceof Error ? e.message : "Umbrel couldn't start the install." });
      return;
    }
    let sawInstalling = false;
    const end = await followUmbrel(
      app.id,
      (s) => {
        if (s === "installing") sawInstalling = true;
        return s === "ready" || s === "running" || s === "stopped" || (sawInstalling && s === "not-installed");
      },
      (text) => emit({ type: "line", text, stream: "out" }),
      req.signal,
    );
    const ok = end === "ready" || end === "running";
    emit({ type: "done", ok, message: ok ? `${app.name} is installed and running.` : end === "not-installed" ? `Umbrel couldn't install ${app.name}. Its logs in Umbrel say why.` : `${app.name} is installed but ${end}.` });
    audit(user, { action: "app.install", target: app.id, summary: ok ? `Installed ${app.name} from ${app.storeId === "umbrel-app-store" ? "the Umbrel App Store" : app.storeId}` : `Tried to install ${app.name}`, outcome: ok ? "ok" : "failed" }, { ip, zone });
  }, req.signal);
});
