"use client";
import * as React from "react";
import { usePathname } from "next/navigation";
import { Tabs } from "@/components/ui/Tabs";
import s from "./docker.module.css";

export type AppsSection = "apps" | "custom" | "images" | "volumes" | "networks" | "disk";

const HREF: Record<AppsSection, string> = {
  apps: "/apps",
  custom: "/apps/custom",
  images: "/apps/images",
  volumes: "/apps/volumes",
  networks: "/apps/networks",
  disk: "/apps/disk",
};

const ITEMS = [
  { value: "apps", label: "Apps" },
  { value: "custom", label: "Your apps" },
  { value: "images", label: "Images" },
  { value: "volumes", label: "Volumes" },
  { value: "networks", label: "Networks" },
  { value: "disk", label: "Disk use" },
] as const;

function sectionOf(path: string): AppsSection {
  for (const k of ["custom", "images", "volumes", "networks", "disk"] as const) if (path === HREF[k] || path.startsWith(`${HREF[k]}/`)) return k;
  return "apps";
}

/**
 * The Apps section's own tabs: apps, and the Docker pieces under them. Sits at the very top of
 * each of those pages, above the page title, so it stays put while the title changes.
 */
export function AppsSectionTabs({ current }: { current?: AppsSection }) {
  const path = usePathname() ?? "/apps";
  const value = current ?? sectionOf(path);
  return (
    <div className={s.sectionTabs}>
      <Tabs value={value} items={ITEMS} hrefFor={(v) => HREF[v]} aria-label="Apps and Docker" />
    </div>
  );
}
