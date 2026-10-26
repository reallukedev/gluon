import { HomeSimple, Globe, ArrowUpRight } from "iconoir-react";
import type { AppSummary } from "@/server/docker/apps";
import { linkTarget } from "@/lib/client/open-link";
import s from "./addresses.module.css";

/**
 * Where an app opens, as hairline tags (never pills) that read as links: the home port with a house,
 * public addresses with a globe, an arrow on each. "Open at" leads the list where no column head says it.
 */
export function Addresses({ app, empty = "No web page" }: { app: Pick<AppSummary, "urls" | "webPort" | "routes">; empty?: string }) {
  const routes = app.routes.filter((r) => r.enabled);
  if (!app.urls.home && !routes.length) return <span className={s.none}>{empty}</span>;
  return (
    <span className={s.list}>
      <span className={s.lead} aria-hidden>
        Open at
      </span>
      {app.urls.home && (
        <a href={app.urls.home} target={linkTarget(app.urls.home, true)} rel="noopener noreferrer" className={s.tag} title={`Open at home: ${app.urls.home}`}>
          <HomeSimple aria-hidden />
          <span className="sr-only">Open at home: </span>
          <span className={s.text}>{app.webPort ? `:${app.webPort}` : app.urls.home.replace(/^https?:\/\//, "")}</span>
          <ArrowUpRight aria-hidden className={s.arrow} />
        </a>
      )}
      {routes.map((r) => (
        <a key={r.id} href={r.url} target={linkTarget(r.url, true)} rel="noopener noreferrer" className={s.tag} data-public="" title={`Open from anywhere: ${r.url}${r.onlyPaths?.length ? ` (only ${r.onlyPaths.join(", ")})` : ""}`}>
          <Globe aria-hidden />
          <span className="sr-only">Open from anywhere: </span>
          <span className={s.text}>{r.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
          {r.onlyPaths?.length ? <span className={s.partly}>some paths</span> : null}
          <ArrowUpRight aria-hidden className={s.arrow} />
        </a>
      ))}
    </span>
  );
}
