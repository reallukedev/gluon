import type { Platform } from "@/server/platform";
import type { UmbrelAppState, UmbrelStore, UmbrelStoreApp } from "@/server/platform/umbrel";

export type { UmbrelStore, UmbrelStoreApp };

/** GET /api/store */
export interface StoreResponse {
  platform: Platform;
  stores: UmbrelStore[];
  installed: Record<string, { state: UmbrelAppState; version: string }>;
}

/** One app as listed in one store (the same app can appear in more than one). */
export interface StoreEntry {
  key: string;
  app: UmbrelStoreApp;
  store: UmbrelStore;
}

/** What Gluon knows about an installed app, merged from the store listing and the app list. */
export interface InstalledInfo {
  state: UmbrelAppState;
  version: string;
  latest: string | null;
  url: string | null;
  /** Umbrel's own percentage while it installs or updates, when it gives one. */
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
