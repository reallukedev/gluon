import * as React from "react";
import {
  HomeSimpleDoor,
  Activity,
  ViewGrid,
  Folder,
  Globe,
  HardDrive,
  Cpu,
  AntennaSignal,
  WarningTriangle,
  Journal,
  Community,
  Settings,
  Link as LinkIcon,
  AppWindow,
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
  alerts: WarningTriangle,
  activity: Journal,
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
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M3.5 2.5v15M7.5 6v11.5M16.5 2.5v15" stroke="currentColor" strokeWidth="1.8" />
      <path d="M11 2.5v15M13.5 2.5v15" stroke="var(--attn)" strokeWidth="1.6" />
    </svg>
  );
}
