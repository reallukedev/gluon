import * as React from "react";
import { GluonMark } from "@/components/brand/GluonMark";
import {
  HomeSimpleDoor,
  Activity,
  ViewGrid,
  Folder,
  Globe,
  HardDrive,
  Cpu,
  AntennaSignal,
  Community,
  Settings,
  Link as LinkIcon,
  AppWindow,
  Terminal,
} from "iconoir-react";

const MAP: Record<string, React.ComponentType<{ strokeWidth?: number }>> = {
  home: HomeSimpleDoor,
  status: Activity,
  apps: ViewGrid,
  files: Folder,
  network: Globe,
  storage: HardDrive,
  system: Cpu,
  diagnostics: AntennaSignal,
  terminal: Terminal,
  people: Community,
  settings: Settings,
  link: LinkIcon,
  app: AppWindow,
  folder: Folder,
};

export function NavIcon({ id }: { id: string }) {
  const I = MAP[id] ?? AppWindow;
  return <I strokeWidth={1.6} />;
}

export function HostMark({ className }: { className?: string }) {
  return <GluonMark className={className} />;
}
