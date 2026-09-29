"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { NavArrowDown, Box3dPoint, Page, Github, AppWindow } from "iconoir-react";
import { Menu } from "@/components/ui/Menu";
import { Button } from "@/components/ui/Button";

/**
 * "Make an app" for the Apps page header (next to "Get apps"): a menu of the three ways to start,
 * plus the list of apps you've made. `variant` lets the header keep one primary button.
 */
export function NewAppButton({ variant = "secondary", label = "Make an app" }: { variant?: "primary" | "secondary" | "ghost"; label?: string }) {
  const router = useRouter();
  return (
    <Menu
      trigger={
        <Button variant={variant} iconEnd={<NavArrowDown />}>
          {label}
        </Button>
      }
      items={[
        { label: "From a Docker image", description: "One container, set up with a form", icon: <Box3dPoint />, onSelect: () => router.push("/apps/new?from=image") },
        { label: "From a compose file", description: "Paste or write docker-compose.yml", icon: <Page />, onSelect: () => router.push("/apps/new?from=compose") },
        { label: "From a GitHub repository", description: "Gluon builds it on this server", icon: <Github />, onSelect: () => router.push("/apps/new?from=github") },
        "separator",
        { label: "Your apps", icon: <AppWindow />, href: "/apps/custom" },
      ]}
    />
  );
}
