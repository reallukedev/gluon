import { route } from "@/server/api";
import { readCaddyfile, renderCaddyfile } from "@/server/caddy/routes";
import { currentConfig, driftInfo } from "@/server/network/routes-service";

/** The Caddyfile on disk next to what Gluon would generate from routes.json. */
export const GET = route({ auth: "admin" }, () => {
  const cfg = currentConfig();
  let text = "";
  try {
    text = readCaddyfile();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const generated = renderCaddyfile(cfg);
  const drift = text !== generated;
  return { text, generated, drift, driftInfo: drift ? driftInfo(cfg) : null };
});
