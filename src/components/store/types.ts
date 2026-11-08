import type { Platform } from "@/server/platform";
import type { UmbrelAppState, UmbrelStore, UmbrelStoreApp } from "@/server/platform/umbrel";

export type { UmbrelStore, UmbrelStoreApp };

export interface StoreResponse {
  platform: Platform;
  stores: UmbrelStore[];
  installed: Record<string, { state: UmbrelAppState; version: string }>;
}

export interface StoreEntry {
  key: string;
  app: UmbrelStoreApp;
  store: UmbrelStore;
}

export interface InstalledInfo {
  state: UmbrelAppState;
  version: string;
  latest: string | null;
  url: string | null;
  progress: number | null;
}

const CATEGORY: Record<string, string> = {
  files: "Files & productivity",
  productivity: "Productivity",
  bitcoin: "Bitcoin",
  lightning: "Lightning",
  finance: "Finance",
  crypto: "Crypto",
  media: "Media",
  networking: "Networking",
  social: "Social",
  automation: "Home & automation",
  developer: "Developer tools",
  gaming: "Gaming",
  ai: "AI",
  other: "Other",
};

export function categoryName(id: string): string {
  const k = id.trim().toLowerCase();
  if (CATEGORY[k]) return CATEGORY[k];
  const words = k.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Other";
}

export const categoryKey = (id: string) => id.trim().toLowerCase() || "other";
