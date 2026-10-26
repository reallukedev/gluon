"use client";
import * as React from "react";
import useSWR, { mutate as mutateGlobal } from "swr";
import { toast } from "@/components/ui/Toast";
import { api } from "@/lib/client/api";
import { appInsertIndex, appItem, isAppItem, type HomeLayout, type WidgetItem } from "@/lib/home";

/**
 * Pinned apps are `app` cards in the person's Home layout, one per app; the layout is the only record of what's
 * pinned. Home, the Apps page and an app's own page all read and change it through the same SWR entry, so a pin
 * made anywhere shows up everywhere without a reload.
 */

export const HOME_KEY = "/api/me/home";
export interface HomeData {
  layout: HomeLayout;
  personal: boolean;
}

export interface PinnableApp {
  id: string;
  name: string;
  icon: string | null;
  urls: { home: string | null; away: string | null };
}

/** Only apps with a web page can sit on Home: there'd be nothing to open otherwise. */
export const canPin = (a: PinnableApp) => !!(a.urls.home || a.urls.away);

/** The layout, shared with Home. Pass the server-rendered one on Home so the first paint needs no fetch. */
export function useHomeLayout(initial?: HomeData) {
  return useSWR<HomeData>(HOME_KEY, (u: string) => api.get<HomeData>(u), {
    fallbackData: initial,
    revalidateOnFocus: false,
    revalidateOnMount: true,
    dedupingInterval: 2000,
  });
}

/** Save a whole layout: the cache changes at once, the server in the background; a failure puts it back. */
export async function saveLayout(next: HomeLayout, before?: HomeData) {
  await mutateGlobal<HomeData>(HOME_KEY, { layout: next, personal: true }, { revalidate: false });
  try {
    await api.put(HOME_KEY, { layout: next });
  } catch (e) {
    if (before) await mutateGlobal<HomeData>(HOME_KEY, before, { revalidate: false });
    throw e;
  }
}

async function current(): Promise<HomeData> {
  const cached = await mutateGlobal<HomeData>(HOME_KEY, (d) => d, { revalidate: false });
  if (cached) return cached;
  const fresh = await api.get<HomeData>(HOME_KEY);
  await mutateGlobal<HomeData>(HOME_KEY, fresh, { revalidate: false });
  return fresh;
}

export function withApp(items: WidgetItem[], app: { id: string; name: string }): WidgetItem[] {
  if (items.some((i) => isAppItem(i, app.id))) return items;
  const at = appInsertIndex(items);
  return [...items.slice(0, at), appItem(app), ...items.slice(at)];
}

export const withoutApp = (items: WidgetItem[], appId: string) => items.filter((i) => !isAppItem(i, appId));

/** Pin several apps at once (first run), keeping the order given; ones already on Home stay where they are. */
export async function pinAppsToHome(apps: { id: string; name: string }[]) {
  const before = await current();
  const at = appInsertIndex(before.layout.items);
  const fresh = apps.filter((a) => !before.layout.items.some((i) => isAppItem(i, a.id))).map((a) => appItem(a));
  const items = [...before.layout.items.slice(0, at), ...fresh, ...before.layout.items.slice(at)];
  await saveLayout({ ...before.layout, items }, before);
}

/** Unpin several apps (first run: the ones left unticked). */
export async function unpinAppsFromHome(ids: string[]) {
  const before = await current();
  const items = before.layout.items.filter((i) => !(i.type === "app" && ids.includes(String(i.config.appId))));
  if (items.length !== before.layout.items.length) await saveLayout({ ...before.layout, items }, before);
}

/** Pin or unpin from anywhere (Apps page, an app's page, the Collection). */
export function usePinToHome() {
  const { data } = useHomeLayout();
  const isPinned = React.useCallback((id: string) => !!data?.layout.items.some((i) => isAppItem(i, id)), [data]);
  const toggle = React.useCallback(async (app: { id: string; name: string }) => {
    const before = await current();
    const pinned = before.layout.items.some((i) => isAppItem(i, app.id));
    const items = pinned ? withoutApp(before.layout.items, app.id) : withApp(before.layout.items, app);
    try {
      await saveLayout({ ...before.layout, items }, before);
      toast.success(pinned ? `Unpinned ${app.name}` : `Pinned ${app.name} to Home`, {
        action: { label: "Undo", onClick: () => void saveLayout(before.layout).catch(() => undefined) },
      });
    } catch (e) {
      toast.error(pinned ? `Couldn't unpin ${app.name}` : `Couldn't pin ${app.name}`, { description: e instanceof Error ? e.message : undefined });
    }
  }, []);
  return { isPinned, toggle };
}
