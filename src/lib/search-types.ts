/** "local" answers from Gluon's own data; "app" asks a connected app (Jellyfin, Immich…) and may be slow. */
export type SearchTier = "local" | "app";

export interface SearchConfirm {
  title: string;
  description?: string;
  consequences?: string[];
  confirmLabel: string;
  danger?: boolean;
  typeToConfirm?: string;
}

/** Something a result does in place instead of opening a page. Always a same-origin POST to /api/. */
export interface SearchAction {
  url: string;
  body?: Record<string, unknown>;
  confirm?: SearchConfirm;
  pending: string;
  failed: string;
  done?: string;
}

export interface SearchItem {
  id: string;
  label: string;
  hint?: string;
  icon?: string;
  image?: string | null;
  href?: string;
  external?: boolean;
  action?: SearchAction;
  at?: number;
  score?: number;
}

export interface SearchGroupOut {
  key: string;
  name: string;
  tier: SearchTier;
  priority: number;
  items: SearchItem[];
  more?: { label: string; href: string; external?: boolean };
}

/** NDJSON lines from POST /api/search, in the order they happen. */
export type SearchEvent =
  | { type: "start"; pending: { key: string; name: string; tier: SearchTier }[] }
  | { type: "group"; group: SearchGroupOut }
  | { type: "fail"; key: string; name: string; tier: SearchTier; message: string; timedOut: boolean }
  | { type: "done"; ms: number };

export interface SearchScope {
  id: string;
  label: string;
  kind: "all" | "apps" | "files" | "app";
}

export const SCOPE_ID = /^(all|apps|files|app:[A-Za-z0-9_-]{1,80})$/;
