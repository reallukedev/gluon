"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { NavArrowDown, Box3dPoint, Page, Github, Terminal } from "iconoir-react";
import { Menu } from "@/components/ui/Menu";
import { Button } from "@/components/ui/Button";

/**
 * "Make an app" for the Your apps header: a menu of the four ways to start. `variant` lets a header
 * keep one primary button.
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
        { label: "From a docker run command", description: "Paste one from an app's instructions", icon: <Terminal />, onSelect: () => router.push("/apps/new?from=run") },
        { label: "From a compose file", description: "Paste or write docker-compose.yml", icon: <Page />, onSelect: () => router.push("/apps/new?from=compose") },
        { label: "From a GitHub repository", description: "Gluon builds it on this server", icon: <Github />, onSelect: () => router.push("/apps/new?from=github") },
      ]}
    />
  );
}
