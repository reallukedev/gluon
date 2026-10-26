import { HomeSimple, Globe } from "iconoir-react";
import type { AppSummary } from "@/server/docker/apps";
import s from "./addresses.module.css";

/**
 * Where an app can be opened, as hairline address tags (never pills): the LAN port with a house,
 * public addresses with a globe. The host name is the part people recognise, so it's what shows.
 */
export function Addresses({ app, empty = "No web page" }: { app: Pick<AppSummary, "urls" | "webPort" | "routes">; empty?: string }) {
  const routes = app.routes.filter((r) => r.enabled);
  if (!app.urls.home && !routes.length) return <span className={s.none}>{empty}</span>;
  return (
    <span className={s.list}>
      {app.urls.home && (
        <a href={app.urls.home} target="_blank" rel="noopener noreferrer" className={s.tag} title={`At home: ${app.urls.home}`}>
          <HomeSimple aria-hidden />
          <span className="sr-only">At home: </span>
          <span className={s.text}>{app.webPort ? `:${app.webPort}` : app.urls.home.replace(/^https?:\/\//, "")}</span>
        </a>
      )}
      {routes.map((r) => (
        <a key={r.id} href={r.url} target="_blank" rel="noopener noreferrer" className={s.tag} data-public="" title={`From anywhere: ${r.url}${r.onlyPaths?.length ? ` (only ${r.onlyPaths.join(", ")})` : ""}`}>
          <Globe aria-hidden />
          <span className="sr-only">From anywhere: </span>
          <span className={s.text}>{r.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
          {r.onlyPaths?.length ? <span className={s.partly}>some paths</span> : null}
        </a>
      ))}
    </span>
  );
}
