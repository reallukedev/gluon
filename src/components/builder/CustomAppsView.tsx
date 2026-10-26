"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHoriz, Box3dPoint, Page as PageIcon, Github, Terminal } from "iconoir-react";
import { api, useApi } from "@/lib/client/api";
import type { CustomAppListItem, CustomAppsResponse, StoreStatus } from "@/lib/builder-types";
import { Page, PageHeader, Empty, Notice, Skeleton, Panel } from "@/components/ui/Surface";
import { AppsSectionTabs } from "@/components/docker/AppsSectionTabs";
import { Button, IconButton, LinkButton } from "@/components/ui/Button";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { useConfirm } from "@/components/ui/Dialog";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { AppIcon } from "@/components/apps/AppIcon";
import { NewAppButton } from "./NewAppButton";
import { StoreSetupDialog } from "./StoreSetup";
import { SOURCE_WORDS, runtimeLine } from "./Issues";
import s from "./builder.module.css";

export function CustomAppsView({ initial }: { initial: CustomAppsResponse | null }) {
  const router = useRouter();
  const [fast, setFast] = React.useState(false);
  const { data, error, isLoading, mutate } = useApi<CustomAppsResponse>("/api/custom-apps", { fallbackData: initial ?? undefined, refresh: fast ? 2000 : 15_000 });
  const [storeOpen, setStoreOpen] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();
  const apps = data?.apps ?? [];
  const store = data?.store ?? null;
  React.useEffect(() => setFast(apps.some((a) => a.job || /installing|updating|uninstalling|starting|restarting/.test(a.runtime?.state ?? ""))), [apps]);

  if (!data) {
    return (
      <Page>
        <PageHeader title="Apps" summary={error ? "The apps you made didn't load." : <Skeleton width="min(420px, 90%)" height={15} style={{ marginTop: 4 }} />} actions={<NewAppButton variant="primary" />} />
        <AppsSectionTabs current="custom" />
        {error ? (
          <Notice tone="fault" title="Couldn't load your apps" action={<Button size="sm" loading={isLoading} onClick={() => void mutate()}>Try again</Button>}>
            {error.message}
          </Notice>
        ) : (
          <div className={s.table} aria-busy aria-label="Loading your apps">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className={`${s.listRow} ${s.listRowStatic}`}>
                <div className={s.appCell}>
                  <Skeleton width={34} height={34} radius={9} />
                  <div className={`${s.appText} ${s.grow}`}>
                    <Skeleton width="50%" height={14} />
                    <Skeleton width="70%" height={11} style={{ marginTop: 4 }} />
                  </div>
                </div>
                <Skeleton width={90} height={13} />
                <Skeleton width={60} height={13} />
                <Skeleton width={70} height={13} />
                <span />
              </div>
            ))}
          </div>
        )}
      </Page>
    );
  }

  const published = apps.filter((a) => a.status === "published");
  const drafts = apps.length - published.length;
  const runningCount = published.filter((a) => a.runtime && (a.runtime.state === "ready" || a.runtime.state === "running")).length;
  const umbrel = store?.platform === "umbrel";
  const where = umbrel ? "in Umbrel" : "with Docker Compose";
  const summary =
    apps.length === 0
      ? umbrel
        ? "Make your own apps and install them in Umbrel like any other."
        : "Make your own apps from images, compose files or repositories."
      : [
          published.length === 1
            ? `You've published 1 app${runningCount ? `, running ${where}` : ", not running right now"}.`
            : published.length
              ? `You've published ${published.length} apps${runningCount === published.length ? `, all running ${where}` : `, ${runningCount} running ${where}`}.`
              : null,
          drafts ? `${drafts === 1 ? "1 draft" : `${drafts} drafts`} in progress.` : null,
        ]
          .filter(Boolean)
          .join(" ");

  const remove = (a: CustomAppListItem) =>
    confirm({
      title: `Delete ${a.name || "this draft"}?`,
      description: "It was never published, so nothing runs anywhere.",
      consequences: ["Its settings, secrets and build history are deleted."],
      confirmLabel: "Delete draft",
      onConfirm: async () => {
        await api.del(`/api/custom-apps/${a.id}`);
        toast.success(`Deleted ${a.name || "the draft"}`);
        void mutate();
      },
    });

  return (
    <Page>
      <PageHeader title="Apps" summary={summary} actions={<NewAppButton variant="primary" />} />
      <AppsSectionTabs current="custom" />

      <StoreNotice store={store} hasApps={apps.length > 0} hasPublished={published.some((a) => a.target === "umbrel")} onSetUp={() => setStoreOpen(true)} />

      {apps.length === 0 ? (
        <Panel>
          <Empty
            title="Nothing made yet"
            action={
              <>
                <LinkButton href="/apps/new?from=image" icon={<Box3dPoint />}>
                  Docker image
                </LinkButton>
                <LinkButton href="/apps/new?from=run" icon={<Terminal />}>
                  docker run
                </LinkButton>
                <LinkButton href="/apps/new?from=compose" icon={<PageIcon />}>
                  Compose file
                </LinkButton>
                <LinkButton href="/apps/new?from=github" icon={<Github />}>
                  GitHub repository
                </LinkButton>
              </>
            }
          >
            {umbrel
              ? "Package any Docker image, docker run command, compose file or GitHub project as an Umbrel app. Gluon hosts it in its own app store, so it installs, updates and uninstalls from Umbrel's dashboard, and shows up here and in Apps."
              : "Package any Docker image, docker run command, compose file or GitHub project as an app Gluon runs with Docker Compose, with its data kept in one folder."}
          </Empty>
        </Panel>
      ) : (
        <div className={s.table} role="table" aria-label="Your apps">
          <div className={s.headRow} role="row">
            <span role="columnheader">App</span>
            <span role="columnheader">State</span>
            <span role="columnheader">Version</span>
            <span role="columnheader">Changed</span>
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {apps.map((a) => (
            <AppRow key={a.id} app={a} onOpen={() => router.push(`/apps/custom/${a.id}`)} onDelete={() => remove(a)} />
          ))}
        </div>
      )}

      {store?.registered && umbrel && (
        <p className={s.storeLine}>
          <StateLine state="running" size={12} label={`Umbrel lists these in Gluon's store (${store.storeId})`} />
          {store.displayUrl && <span className="mono">{store.displayUrl.replace(/^https?:\/\//, "").split("/api/")[0]}</span>}
        </p>
      )}

      <StoreSetupDialog
        open={storeOpen}
        onOpenChange={setStoreOpen}
        repair={!!store?.lost}
        onDone={(st) => {
          void mutate({ ...data, store: st }, { revalidate: true });
        }}
      />
      {confirmNode}
    </Page>
  );
}

function AppRow({ app: a, onOpen, onDelete }: { app: CustomAppListItem; onOpen: () => void; onDelete: () => void }) {
  const rt = runtimeLine(a.status, a.runtime, a.job);
  const href = `/apps/custom/${a.id}`;
  const behind = a.github?.latestCommit && a.github.builtCommit && a.github.latestCommit !== a.github.builtCommit;
  const sub = a.github ? (
    <>
      GitHub · <span className="mono">{a.github.owner}/{a.github.repo}</span>
      {a.github.builtCommit ? <> @ <span className="mono">{a.github.builtCommit.slice(0, 7)}</span></> : null}
    </>
  ) : a.source === "image" && a.image ? (
    <span className="mono">{a.image}</span>
  ) : (
    SOURCE_WORDS[a.source]
  );
  const items: MenuEntry[] = [
    ...(a.status === "draft" && !a.job ? [{ label: "Continue setting up", href: `/apps/new?draft=${a.id}&step=setup` }] : []),
    { label: a.status === "draft" ? "Open in the builder" : "Edit", href },
    ...(a.runtime?.url && (a.runtime.state === "ready" || a.runtime.state === "running") ? [{ label: `Open ${a.name}`, href: a.runtime.url }] : []),
    ...(a.runtime?.appsId ? [{ label: "Show in Apps", href: `/apps/${encodeURIComponent(a.runtime.appsId)}` }] : []),
    ...(a.status === "draft" ? ["separator" as const, { label: "Delete draft…", danger: true, onSelect: onDelete }] : []),
  ];
  return (
    <div className={s.listRow} role="row" onClick={(e) => !(e.target as HTMLElement).closest("a,button") && onOpen()}>
      <div className={s.appCell} role="cell">
        <AppIcon src={a.icon} name={a.name || "App"} size={34} />
        <div className={s.appText}>
          <Link href={href} className={s.appName} title={a.name}>
            {a.name.trim() || "Untitled app"}
          </Link>
          <span className={s.appSub}>{sub}</span>
        </div>
      </div>
      <div className={s.stateCell} role="cell">
        <StateLine state={rt.line} size={12} label={rt.label} />
        {a.status === "published" && a.runtime?.state === "not-installed" && <span className={s.stateSub}>{a.target === "umbrel" ? "Install it from its page" : "Start it from its page"}</span>}
        {a.lastBuild?.status === "failed" && !a.job && <span className={s.stateSub}>Last build failed</span>}
      </div>
      <div className={s.versionCell} role="cell">
        {a.publishedVersion ? <span className="mono">{a.publishedVersion}</span> : <span className={s.muted}>Not published</span>}
        {(a.changed || behind) && <span className={s.stateSub}>{a.changed ? "Unpublished changes" : "New commits"}</span>}
      </div>
      <div className={s.timeCell} role="cell">
        <Time ts={a.updatedAt} />
      </div>
      <div className={s.actionsCell} role="cell">
        <Menu
          trigger={
            <IconButton label={`More for ${a.name || "this app"}`} size="sm">
              <MoreHoriz />
            </IconButton>
          }
          items={items}
        />
      </div>
    </div>
  );
}

function StoreNotice({ store, hasApps, hasPublished, onSetUp }: { store: StoreStatus | null; hasApps: boolean; hasPublished: boolean; onSetUp: () => void }) {
  if (!store) return null;
  const gap = <div className={s.gap} />;
  if (store.gitMissing) {
    return (
      <>
        <Notice tone="fault" title="This version of Gluon can't host an app store">
          Its image doesn&apos;t include git, which Umbrel needs to read the store and Gluon needs to build from GitHub. Update Gluon; apps you make are kept as drafts until then.
        </Notice>
        {gap}
      </>
    );
  }
  if (store.platform !== "umbrel") {
    return (
      <>
        <Notice title={store.platform === "casaos" ? "Gluon is working with CasaOS, not Umbrel" : "Gluon isn't working with Umbrel"}>
          Apps you make run with Docker Compose in <span className="mono">{store.composeRoot}</span>, and show up in Apps like any other stack. If Umbrel runs here too, choose it under Settings › Server › Works with.
        </Notice>
        {gap}
      </>
    );
  }
  if (store.umbrel === "unreachable") {
    return (
      <>
        <Notice tone="fault" title="Umbrel isn't answering">
          It may be restarting. Your apps&apos; states will show again when it&apos;s back; drafts can still be edited.
        </Notice>
        {gap}
      </>
    );
  }
  if (store.lost) {
    return (
      <>
        <Notice tone="attention" title="Umbrel no longer lists Gluon's store" action={<Button size="sm" onClick={onSetUp}>Add it again</Button>}>
          {hasPublished ? "Apps you published keep running, but Umbrel can't update them or install new ones until the store is back." : "Umbrel can't install the apps you make until it's back."}
        </Notice>
        {gap}
      </>
    );
  }
  if (!store.registered) {
    // Before anything is made, the empty state explains the store; it's set up when first needed.
    if (!hasApps) return null;
    return (
      <>
        <Panel>
          <div className={s.setupPanel}>
            <div className={s.setupText}>
              <h2>Umbrel installs apps from app stores</h2>
              <p className={s.hint}>Gluon keeps a small private store for the apps you make, served from this server to Umbrel. Add it once, and every app you publish shows up in Umbrel&apos;s dashboard.</p>
            </div>
            <Button onClick={onSetUp}>Add Gluon&apos;s store to Umbrel</Button>
          </div>
        </Panel>
        {gap}
      </>
    );
  }
  return null;
}
