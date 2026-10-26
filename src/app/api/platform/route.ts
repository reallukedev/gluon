import { z } from "zod";
import { route } from "@/server/api";
import { setSetting } from "@/server/settings";
import { platformInfo, PLATFORM_NAME } from "@/server/platform";
import { invalidateApps } from "@/server/docker/apps";
import { audit } from "@/server/audit";

/** Which home server OS Gluon works alongside, what it detected, and how it's reached. */
export const GET = route({ auth: "admin" }, () => platformInfo());

const body = z.object({ platform: z.enum(["auto", "umbrel", "casaos", "none"]) });

export const PATCH = route({ auth: "admin", body, recent: true }, async ({ body, user, ip, zone }) => {
  setSetting("platform", body.platform);
  invalidateApps();
  const info = await platformInfo();
  audit(user, { action: "settings.platform", summary: body.platform === "auto" ? `Gluon now picks the platform itself (${PLATFORM_NAME[info.active]})` : `Gluon now works with ${PLATFORM_NAME[info.active]}` }, { ip, zone });
  return info;
});
