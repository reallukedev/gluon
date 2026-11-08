"use client";
import type { StatusPayload } from "@/server/status";
import { useApi, STATUS_KEY } from "@/lib/client/api";
import { Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { AppConsole } from "./AppConsole";

/** Live use by app: one channel strip per app, refreshed with the server's status. */
export function AppsTab() {
  const { data, error } = useApi<StatusPayload>(STATUS_KEY, { refresh: 10_000 });
  if (error && !data) return <Notice tone="fault" title="Couldn't load the apps">Checking again every few seconds.</Notice>;
  if (!data) return <Skeleton height={240} />;
  if (data.appsUnavailable) return <Notice tone="fault" title="Docker isn't answering">Apps can&apos;t be listed until it answers.</Notice>;
  if (!data.apps.some((a) => a.containers.length)) return <Notice title="Nothing running">No app has a running container right now.</Notice>;
  return (
    <Panel title="Live use by app" flush>
      <AppConsole apps={data.apps} findings={data.findings} />
    </Panel>
  );
}
