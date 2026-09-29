"use client";
import * as React from "react";
import Link from "next/link";
import { Toggle } from "@base-ui/react/toggle";
import { Check, EditPencil, Eye, Minus, Plus } from "iconoir-react";
import type { FolderGrant, VisibilityResponse } from "@/lib/people-types";
import { api, ApiError, useApi } from "@/lib/client/api";
import { Empty, Notice, Panel, Skeleton } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { toast } from "@/components/ui/Toast";
import { AppIcon } from "@/components/apps/AppIcon";
import { shortName } from "@/lib/app-names";
import { ShareFolderDialog } from "./FolderGrants";
import { Avatar, errorMessage } from "./bits";
import { peopleHref } from "@/lib/settings-links";
import s from "./access.module.css";

const APPS_URL = "/api/people/apps";
const GRANTS_URL = "/api/people/grants";

type Level = "none" | "read" | "write";
const LEVEL: Record<Level, string> = { none: "No access", read: "Can view", write: "Can view and change" };

/** Is `p` the folder `root` or inside it? (Paths are canonical: no trailing slash, no dots.) */
const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

const quiet = (e: unknown) => e instanceof ApiError && e.code === "reauth_cancelled";

/**
 * Who can open what: household members across, apps and shared folders down. Every cell is the
 * control: tap an app cell to let that person see the app; open a folder cell to choose view or change.
 * With `memberId`, only that person's column (their detail page).
 */
export function AccessMap({ memberId }: { memberId?: string }) {
  const vis = useApi<VisibilityResponse>(APPS_URL);
  const grantsQ = useApi<FolderGrant[]>(GRANTS_URL);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [sharing, setSharing] = React.useState<{ userId?: string; path?: string } | null>(null);

  const data = vis.data;
  const grants = React.useMemo(() => grantsQ.data ?? [], [grantsQ.data]);
  const members = (data?.members ?? []).filter((m) => !memberId || m.id === memberId);
  const apps = (data?.apps ?? []).filter((a) => !a.hidden).sort((a, b) => Number(b.household) - Number(a.household) || a.name.localeCompare(b.name));
  const hiddenApps = (data?.apps ?? []).filter((a) => a.hidden).length;
  // Two apps can share a name (a CasaOS copy and a Compose one); tell them apart.
  const dupes = new Set(apps.map((a) => a.name.toLowerCase()).filter((n, i, arr) => arr.indexOf(n) !== i));
  const folders = React.useMemo(() => {
    const byPath = new Map<string, { path: string; label: string | null; exists: boolean }>();
    for (const g of grants) if (!byPath.has(g.path)) byPath.set(g.path, { path: g.path, label: g.label, exists: g.exists });
    return [...byPath.values()].sort((a, b) => (a.label ?? a.path).localeCompare(b.label ?? b.path));
  }, [grants]);

  async function setHousehold(appId: string, name: string, on: boolean) {
    setBusy(`h:${appId}`);
    try {
      const next = await api.put<VisibilityResponse>(APPS_URL, { appId, household: on });
      void vis.mutate(next, { revalidate: false });
      toast.success(on ? `Everyone in the household sees ${name}` : `${name} is no longer shown to everyone`, {
        description: on ? undefined : "People you tick individually still see it.",
      });
    } catch (e) {
      if (!quiet(e)) toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function setApp(userId: string, who: string, appId: string, name: string, on: boolean) {
    if (!data) return;
    setBusy(`a:${userId}:${appId}`);
    const current = data.apps.filter((a) => a.users.includes(userId)).map((a) => a.id);
    const nextApps = on ? [...new Set([...current, appId])] : current.filter((x) => x !== appId);
    // Show it straight away; the server's answer replaces it.
    void vis.mutate({ ...data, apps: data.apps.map((a) => (a.id === appId ? { ...a, users: on ? [...a.users, userId] : a.users.filter((u) => u !== userId) } : a)) }, { revalidate: false });
    try {
      const next = await api.put<VisibilityResponse>(APPS_URL, { userId, apps: nextApps });
      void vis.mutate(next, { revalidate: false });
    } catch (e) {
      void vis.mutate();
      if (!quiet(e)) toast.error(errorMessage(e, `Couldn't change what ${who} sees.`));
    } finally {
      setBusy(null);
    }
  }
  async function setFolder(userId: string, who: string, path: string, label: string | null, level: Level) {
    const g = grants.find((x) => x.userId === userId && x.path === path);
    setBusy(`f:${userId}:${path}`);
    try {
      if (level === "none" && g) await api.del(`${GRANTS_URL}/${encodeURIComponent(g.id)}`);
      else if (g && level !== "none") await api.patch(`${GRANTS_URL}/${encodeURIComponent(g.id)}`, { access: level });
      else if (!g && level !== "none") await api.post(GRANTS_URL, { userId, path, label, access: level });
      await grantsQ.mutate();
      toast.success(level === "none" ? `${who} can't open ${label ?? path} any more` : `${who} ${level === "write" ? "can view and change" : "can view"} ${label ?? path}`, {
        description: level === "none" ? "Nothing in the folder was deleted." : undefined,
      });
    } catch (e) {
      if (!quiet(e)) toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const error = vis.error ?? grantsQ.error;
  if (error && !data) {
    return (
      <Notice tone="fault" title="Couldn't load who can open what" action={<Button size="sm" onClick={() => (void vis.mutate(), void grantsQ.mutate())}>Try again</Button>}>
        {errorMessage(error)}
      </Notice>
    );
  }
  if (!data || !grantsQ.data) {
    return (
      <Panel flush>
        <div className={s.skeleton}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={s.skelRow}>
              <Skeleton height={16} width="60%" />
              <Skeleton height={24} width={24} radius={6} />
              <Skeleton height={24} width={24} radius={6} />
            </div>
          ))}
        </div>
      </Panel>
    );
  }
  if (!members.length) {
    return (
      <Panel flush>
        <Empty title="No household members yet">
          Everyone here is an admin, and admins open every app and folder. Invite someone as a household member to choose what they can open.
        </Empty>
      </Panel>
    );
  }

  const single = !!memberId;
  const countFor = (id: string) => ({
    apps: apps.filter((a) => a.household || a.users.includes(id)).length,
    folders: grants.filter((g) => g.userId === id).length,
  });

  return (
    <>
      <div className={`${s.wrap} appear`} data-single={single ? "" : undefined}>
        <table className={s.map}>
          <caption className="sr-only">{single ? "What this person can open" : "Who can open which apps and folders"}</caption>
          <thead>
            <tr>
              <th scope="col" className={s.corner}>
                {single ? <span className="sr-only">App or folder</span> : <span className="label">Household</span>}
              </th>
              {!single && (
                <th scope="col" className={s.colHead}>
                  <span className={s.everyone}>Everyone</span>
                  <small>new members too</small>
                </th>
              )}
              {members.map((m) => {
                const c = countFor(m.id);
                return (
                  <th key={m.id} scope="col" className={s.colHead}>
                    {single ? (
                      <span className={s.everyone}>{m.displayName}</span>
                    ) : (
                      <Link href={peopleHref({ person: m.id })} className={s.person} title={`${m.displayName} (${m.username})`}>
                        <Avatar name={m.displayName} size={26} />
                        <span className="truncate">{m.displayName}</span>
                      </Link>
                    )}
                    <small className="num">
                      {c.apps} app{c.apps === 1 ? "" : "s"} · {c.folders} folder{c.folders === 1 ? "" : "s"}
                    </small>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            <tr className={s.section}>
              <th scope="rowgroup" colSpan={members.length + (single ? 1 : 2)}>
                <span className="label">Apps</span>
                {hiddenApps > 0 && <span className={s.sectionNote}>{hiddenApps} hidden from everyone on their app pages</span>}
              </th>
            </tr>
            {apps.length === 0 && (
              <tr>
                <td colSpan={members.length + (single ? 1 : 2)} className={s.none}>
                  No apps yet.
                </td>
              </tr>
            )}
            {apps.map((a) => (
              <tr key={a.id}>
                <th scope="row" className={s.rowHead}>
                  <span className={s.rowName}>
                    <AppIcon src={a.icon} name={a.name} size={22} />
                    <span>
                      <span className="truncate" title={a.name} style={{ display: "block" }}>
                        {shortName(a.name)}
                      </span>
                      {(dupes.has(a.name.toLowerCase()) || a.line === "stopped") && (
                        <small className="truncate">
                          {dupes.has(a.name.toLowerCase()) && <span className="mono">{a.id}</span>}
                          {dupes.has(a.name.toLowerCase()) && a.line === "stopped" ? " · " : ""}
                          {a.line === "stopped" ? "stopped" : ""}
                        </small>
                      )}
                    </span>
                  </span>
                </th>
                {!single && (
                  <td className={s.cell}>
                    <Switch checked={a.household} onChange={(v) => void setHousehold(a.id, a.name, v)} disabled={busy === `h:${a.id}`} aria-label={`Everyone in the household sees ${a.name}`} />
                  </td>
                )}
                {members.map((m) => {
                  const own = a.users.includes(m.id);
                  const key = `a:${m.id}:${a.id}`;
                  if (a.household) {
                    return (
                      <td key={m.id} className={s.cell}>
                        <span className={s.inherited} role="img" aria-label={`${m.displayName} sees ${a.name}: everyone in the household does`} title="Everyone in the household sees it">
                          <Check aria-hidden />
                        </span>
                      </td>
                    );
                  }
                  return (
                    <td key={m.id} className={s.cell}>
                      <Toggle
                        pressed={own}
                        disabled={busy === key}
                        onPressedChange={(v) => void setApp(m.id, m.displayName, a.id, a.name, v)}
                        className={s.toggle}
                        aria-label={`${m.displayName} sees ${a.name}`}
                      >
                        {own ? <Check aria-hidden /> : <Minus aria-hidden />}
                      </Toggle>
                    </td>
                  );
                })}
              </tr>
            ))}

            <tr className={s.section}>
              <th scope="rowgroup" colSpan={members.length + (single ? 1 : 2)}>
                <span className="label">Folders</span>
                <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setSharing({ userId: memberId })}>
                  Share a folder
                </Button>
              </th>
            </tr>
            {folders.length === 0 && (
              <tr>
                <td colSpan={members.length + (single ? 1 : 2)} className={s.none}>
                  No folders shared yet. Share one like Films or Photos and it appears in Files for the people you pick.
                </td>
              </tr>
            )}
            {folders.map((f) => (
              <tr key={f.path}>
                <th scope="row" className={s.rowHead}>
                  <span className={s.folderName} title={f.path}>
                    <span className="truncate">{f.label ?? f.path.split("/").pop()}</span>
                    <small className="mono truncate">{f.path}</small>
                    {!f.exists && <small className={s.missing}>Not there right now (a disk may be unmounted)</small>}
                  </span>
                </th>
                {!single && (
                  <td className={s.cell}>
                    <span className={s.na} title="Folders are shared person by person">
                      <span className="sr-only">Shared person by person</span>
                    </span>
                  </td>
                )}
                {members.map((m) => {
                  const own = grants.find((g) => g.userId === m.id && g.path === f.path);
                  const parent = own ? null : grants.find((g) => g.userId === m.id && g.path !== f.path && within(f.path, g.path));
                  const level: Level = own ? own.access : "none";
                  const key = `f:${m.id}:${f.path}`;
                  return (
                    <td key={m.id} className={s.cell}>
                      <Menu
                        align="center"
                        trigger={
                          <button type="button" className={s.folderCell} data-level={level} data-via={parent ? "" : undefined} disabled={busy === key} aria-label={`${m.displayName}: ${parent ? `${LEVEL[parent.access]}, through ${parent.label ?? parent.path}` : LEVEL[level]} for ${f.label ?? f.path}. Change`}>
                            {level === "write" ? <EditPencil aria-hidden /> : level === "read" ? <Eye aria-hidden /> : parent ? <Eye aria-hidden /> : <Minus aria-hidden />}
                            <span>{level === "write" ? "Change" : level === "read" ? "View" : parent ? "via parent" : ""}</span>
                          </button>
                        }
                        items={[
                          { kind: "label", label: `${m.displayName} · ${f.label ?? f.path}` },
                          ...(["none", "read", "write"] as const).map((l) => ({
                            label: LEVEL[l],
                            description: l === "write" ? "Add, rename, move and delete files" : l === "read" ? "Browse and download" : parent ? `Still opens it through ${parent.label ?? parent.path}` : undefined,
                            icon: l === level ? <Check /> : <span style={{ width: 16 }} />,
                            disabled: l === level,
                            onSelect: () => void setFolder(m.id, m.displayName, f.path, f.label, l),
                          })),
                        ]}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={s.legend} aria-hidden>
        <span>
          <i className={s.lgOn}>
            <Check />
          </i>
          sees it
        </span>
        <span>
          <i className={s.lgVia}>
            <Check />
          </i>
          through Everyone
        </span>
        <span>
          <i className={s.lgOn}>
            <Eye />
          </i>
          can view
        </span>
        <span>
          <i className={s.lgOn}>
            <EditPencil />
          </i>
          can view and change
        </span>
        <span>
          <i className={s.lgOff}>
            <Minus />
          </i>
          no access
        </span>
      </div>
      <ShareFolderDialog
        open={!!sharing}
        onOpenChange={(o) => !o && setSharing(null)}
        userId={sharing?.userId}
        members={members.map((m) => ({ id: m.id, name: m.displayName }))}
        onSaved={() => void grantsQ.mutate()}
      />
    </>
  );
}
