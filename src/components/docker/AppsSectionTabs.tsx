"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import type { Platform } from "@/server/platform";
import { Tabs } from "@/components/ui/Tabs";
import { Segmented } from "@/components/ui/Field";
import s from "./section.module.css";

/** The Apps section's tabs. Docker's four pages share one tab and switch with a segmented control. */
export type AppsSection = "apps" | "store" | "custom" | "docker";
export type DockerPart = "images" | "volumes" | "networks" | "disk";

const DOCKER: { value: DockerPart; label: string; href: string }[] = [
  { value: "images", label: "Images", href: "/apps/images" },
  { value: "volumes", label: "Volumes", href: "/apps/volumes" },
  { value: "networks", label: "Networks", href: "/apps/networks" },
  { value: "disk", label: "Disk use", href: "/apps/disk" },
];
const dockerHref = (p: DockerPart) => DOCKER.find((d) => d.value === p)!.href;

/** Which platform Gluon works with, from the /apps layout: the App store tab only exists with Umbrel. */
const PlatformContext = React.createContext<Platform | null>(null);
export function AppsPlatform({ value, children }: { value: Platform; children: React.ReactNode }) {
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

const LAST_DOCKER = "gluon:apps-docker";

/**
 * Sits under the page header on every Apps page: Apps, App store (with Umbrel), Your apps, Docker.
 * The Docker tab reopens the Docker page you used last in this session.
 */
export function AppsSectionTabs({ current, docker }: { current: AppsSection; docker?: DockerPart }) {
  const router = useRouter();
  const platform = React.useContext(PlatformContext);
  const [lastDocker, setLastDocker] = React.useState<DockerPart>(docker ?? "images");

  React.useEffect(() => {
    try {
      if (docker) sessionStorage.setItem(LAST_DOCKER, docker);
      else {
        const saved = sessionStorage.getItem(LAST_DOCKER);
        if (saved && DOCKER.some((d) => d.value === saved)) setLastDocker(saved as DockerPart);
      }
    } catch {
      /* storage unavailable: the Docker tab opens Images */
    }
  }, [docker]);

  // A store page opened directly (a bookmark) still shows its tab, whatever the platform.
  const store = platform === "umbrel" || current === "store";
  const items = [
    { value: "apps" as const, label: "Apps" },
    ...(store ? [{ value: "store" as const, label: "App store" }] : []),
    { value: "custom" as const, label: "Your apps" },
    { value: "docker" as const, label: "Docker" },
  ];
  const href = (v: AppsSection) => (v === "apps" ? "/apps" : v === "store" ? "/apps/store" : v === "custom" ? "/apps/custom" : dockerHref(docker ?? lastDocker));

  return (
    <div className={s.section}>
      <Tabs value={current} items={items} hrefFor={href} aria-label="Apps sections" />
      {docker && (
        <div className={s.docker}>
          <Segmented
            aria-label="Docker"
            value={docker}
            onChange={(v) => v !== docker && router.push(dockerHref(v), { scroll: false })}
            options={DOCKER.map((d) => ({ value: d.value, label: d.label }))}
          />
        </div>
      )}
    </div>
  );
}
