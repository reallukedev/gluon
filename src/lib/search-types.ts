/** Universal search (⌘K): what the server streams to the palette. Shared by client and server. */

/** "local" answers from Gluon's own data; "app" asks a connected app (Jellyfin, Immich…) and may be slow. */
export type SearchTier = "local" | "app";

/** Asked before an action runs. Uses the same words as every other confirmation in Gluon. */
export interface SearchConfirm {
  title: string;
  description?: string;
  consequences?: string[];
  confirmLabel: string;
  /** Red confirm button (stop, delete). Otherwise the primary button. */
  danger?: boolean;
  typeToConfirm?: string;
}

/** Something a result does in place instead of opening a page. Always a same-origin POST to /api/. */
export interface SearchAction {
  url: string;
  body?: Record<string, unknown>;
  confirm?: SearchConfirm;
  /** Toast while it runs: "Restarting Jellyfin…". */
  pending: string;
  /** Toast title when it fails: "Couldn't restart Jellyfin". */
  failed: string;
  /** Toast when it worked, if the server doesn't answer with a message. */
  done?: string;
}

export interface SearchItem {
  id: string;
  label: string;
  hint?: string;
  /** A NavIcon id ("app", "folder", "settings"…) or a thing's type ("film", "photo", "song", "light"). */
  icon?: string;
  /** Same-origin image (an app icon, a poster, a photo thumbnail). */
  image?: string | null;
  href?: string;
  external?: boolean;
  action?: SearchAction;
  /** A time to show next to the hint, formatted for the person ("2 hours ago"). */
  at?: number;
  /** 0–1, how well it matches. Used for "best match" across groups. */
  score?: number;
}

export interface SearchGroupOut {
  key: string;
  name: string;
  tier: SearchTier;
  /** Lower comes first among groups that match about as well. */
  priority: number;
  items: SearchItem[];
  /** Where to see everything when only the first few are shown. */
  more?: { label: string; href: string; external?: boolean };
}

/** NDJSON lines from POST /api/search, in the order they happen. */
export type SearchEvent =
  | { type: "start"; pending: { key: string; name: string; tier: SearchTier }[] }
  | { type: "group"; group: SearchGroupOut }
  | { type: "fail"; key: string; name: string; tier: SearchTier; message: string; timedOut: boolean }
  | { type: "done"; ms: number };

/** Where to search: everywhere, one part of Gluon, or inside one connected app. */
export interface SearchScope {
  id: string;
  label: string;
  kind: "all" | "apps" | "files" | "app";
}

export const SCOPE_ID = /^(all|apps|files|app:[A-Za-z0-9_-]{1,80})$/;
