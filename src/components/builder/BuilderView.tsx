"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { MoreHoriz, OpenNewWindow } from "iconoir-react";
import { api, useApi } from "@/lib/client/api";
import type { BuilderTarget, CustomAppDetail, Issue, ServerCheck, StoreStatus } from "@/lib/builder-types";
import { Page, PageHeader, Panel, Notice } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Dialog, useConfirm } from "@/components/ui/Dialog";
import { HoldButton } from "@/components/ui/HoldButton";
import { Checkbox } from "@/components/ui/Field";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { AppIcon } from "@/components/apps/AppIcon";
import { analyze, applyAllFixes, applyFix, detailIssues } from "@/lib/builder/analyze";
import { DetailsTab } from "./DetailsTab";
import { ServicesTab } from "./ServicesTab";
import { ComposeTab } from "./ComposeTab";
import { FilesTab, HistoryTab, SourceTab } from "./InfoTabs";
import { PublishDialog, type JobMode } from "./PublishDialog";
import { StoreSetupDialog } from "./StoreSetup";
import { IssueCount, SOURCE_WORDS, runtimeLine } from "./Issues";
import type { YamlEditorHandle } from "./YamlEditor";
import { linkHost, useDraft } from "./state";
import s from "./builder.module.css";

export type BuilderTab = "details" | "services" | "compose" | "files" | "source" | "history";

export function BuilderView({ initial, initialTab, target: platformTarget }: { initial: CustomAppDetail; initialTab: BuilderTab; target: BuilderTarget }) {
  const router = useRouter();
  const [jobOpen, setJobOpen] = React.useState(false);
  const [mode, setMode] = React.useState<JobMode | undefined>(undefined);
  const [fast, setFast] = React.useState(!!initial.job && !initial.job.finishedAt);
  const { data, mutate } = useApi<CustomAppDetail>(`/api/custom-apps/${initial.id}`, { fallbackData: initial, refresh: fast || jobOpen ? 1500 : 20_000 });
  const d = data ?? initial;
  const jobRunning = !!d.job && !d.job.finishedAt;
  React.useEffect(() => setFast(jobRunning), [jobRunning]);
  const { data: storeData, mutate: mutateStore } = useApi<StoreStatus>("/api/custom-apps/store", { revalidateOnFocus: false });
  const target: BuilderTarget = d.target ?? platformTarget;
  const draft = useDraft(d, (patch) => void mutate({ ...d, ...patch }, { revalidate: false }));
  const [tab, setTabState] = React.useState<BuilderTab>(initialTab);
  const editorRef = React.useRef<YamlEditorHandle>(null);
  const [storeOpen, setStoreOpen] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [confirm, confirmNode] = useConfirm();

  const setTab = React.useCallback((t: BuilderTab) => {
    setTabState(t);
    const u = new URL(window.location.href);
    if (t === "details") u.searchParams.delete("tab");
    else u.searchParams.set("tab", t);
    window.history.replaceState(null, "", u.toString());
  }, []);

  // ---------------------------------------------------------------- checks
  const published = d.status === "published";
  const ctx = React.useMemo(() => ({ source: d.source, target, web: draft.spec.web, secrets: draft.secrets }), [d.source, target, draft.spec.web, draft.secrets]);
  const analysis = React.useMemo(() => analyze(draft.spec.compose, ctx), [draft.spec.compose, ctx]);
  const local = React.useMemo(() => [...detailIssues(draft.spec, published), ...analysis.issues], [draft.spec, published, analysis.issues]);
  const [server, setServer] = React.useState<ServerCheck | null>(null);
  const checkKey = `${draft.state === "saved" ? "s" : "x"}:${d.rev}`;
  React.useEffect(() => {
    if (draft.state !== "saved") return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.post<ServerCheck>(`/api/custom-apps/${d.id}/check`, {});
        if (!cancelled) setServer(r);
      } catch {
        /* checks are advisory here; publishing runs them for real */
      }
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey]);
  const issues: Issue[] = React.useMemo(() => {
    const ids = new Set(local.map((i) => i.id));
    return [...local, ...(server?.issues ?? []).filter((i) => !ids.has(i.id))];
  }, [local, server]);
  const usedPorts = React.useMemo(() => new Map((server?.ports ?? []).map((p) => [p.port, p.by])), [server]);

  const fix = React.useCallback(
    (fixId: string) => {
      const r = applyFix(draft.spec.compose, fixId, ctx);
      if (!r) return toast.info("That's already fixed.");
      draft.setSpec((sp) => ({ ...sp, compose: r.text, web: { ...sp.web, ...r.web } }));
      for (const [svc, keys] of Object.entries(r.secrets ?? {})) for (const k of keys) draft.setSecret(svc, k, "");
      toast.success(r.said);
    },
    [draft, ctx],
  );
  const fixAll = React.useCallback(() => {
    const r = applyAllFixes(draft.spec.compose, ctx);
    if (!r.said.length) return;
    draft.setSpec((sp) => ({ ...sp, compose: r.text, web: { ...sp.web, ...r.web } }));
    for (const [svc, keys] of Object.entries(r.secrets)) for (const k of keys) draft.setSecret(svc, k, "");
    toast.success(r.said.length === 1 ? r.said[0]! : `Made ${r.said.length} fixes`, r.said.length > 1 ? { description: r.said.join(" ") } : undefined);
  }, [draft, ctx]);

  const goTo = React.useCallback(
    (i: Issue) => {
      const f = i.field ?? "";
      const next: BuilderTab = f.startsWith("details.") || f.startsWith("web.") ? "details" : f.startsWith("services.") && !analysis.parsed.issues.length ? "services" : "compose";
      setTab(next);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (next === "compose" && i.line) return editorRef.current?.gotoLine(i.line);
          const el = f ? document.querySelector<HTMLElement>(`[data-field="${CSS.escape(f)}"]`) ?? document.querySelector<HTMLElement>(`[data-field="${CSS.escape(f.split(".").slice(0, 3).join("."))}"]`) : null;
          if (el) {
            el.scrollIntoView({ block: "center", behavior: "smooth" });
            el.querySelector<HTMLElement>("input, textarea, button")?.focus({ preventScroll: true });
          }
        }),
      );
    },
    [analysis.parsed.issues.length, setTab],
  );

  // ---------------------------------------------------------------- actions
  const openJob = (m?: JobMode) => {
    setMode(m);
    setJobOpen(true);
  };
  const deleteDraft = () =>
    confirm({
      title: `Delete ${d.spec.details.name || "this draft"}?`,
      description: "It was never published, so nothing runs anywhere.",
      consequences: ["Its settings, secrets and build history are deleted.", "Images Gluon built for it are removed from this server."],
      confirmLabel: "Delete draft",
      onConfirm: async () => {
        await api.del(`/api/custom-apps/${d.id}`);
        toast.success(`Deleted ${d.spec.details.name || "the draft"}`);
        router.push("/apps/custom");
      },
    });

  const rt = runtimeLine(d.status, d.runtime, jobRunning ? d.job : null);
  const changed = published && JSON.stringify({ ...draft.spec, details: { ...draft.spec.details, version: "", releaseNotes: "" } }) !== JSON.stringify({ ...d.publishedSpec, details: { ...d.publishedSpec?.details, version: "", releaseNotes: "" } });
  const behind = !!d.github?.latestCommit && !!d.github.builtCommit && d.github.latestCommit !== d.github.builtCommit;
  const where = target === "umbrel" ? "Umbrel" : "Docker Compose";
  const running = d.runtime && (d.runtime.state === "ready" || d.runtime.state === "running");
  const summary = jobRunning ? (
    <>{rt.label}… This page follows along.</>
  ) : !published ? (
    <>A draft. {target === "umbrel" ? "It isn't in Umbrel yet." : "It isn't running yet."} Changes save as you go.</>
  ) : (
    <>
      Version <b className="num">{d.publishedVersion}</b> {d.runtime?.state === "not-installed" ? (target === "umbrel" ? "is in Gluon's store but not installed in Umbrel." : "isn't running.") : running ? `runs in ${where}.` : `is ${rt.label.toLowerCase()} in ${where}.`}
      {changed ? " Some changes aren't published yet." : ""}
      {behind ? ` ${d.github!.branch} has new commits.` : ""}
    </>
  );
  const url = d.runtime?.url ?? (d.spec.web.service && d.spec.web.port && published ? `http://${linkHost(d)}:${d.spec.web.port}${d.spec.web.path || ""}` : null);
  const installedNow = published && d.runtime?.state !== "not-installed";
  const publishLabel = published && installedNow && !changed ? "Publish again" : target === "umbrel" ? (installedNow ? "Update in Umbrel" : "Install in Umbrel") : published ? "Update" : "Start it";
  const errors = issues.filter((i) => i.level === "error");

  const menu: MenuEntry[] = [
    ...(url && running ? [{ label: `Open ${d.spec.details.name}`, icon: <OpenNewWindow />, href: url }] : []),
    ...(d.runtime?.appsId ? [{ label: "Show in Apps", href: `/apps/${encodeURIComponent(d.runtime.appsId)}` }] : []),
    ...(d.source === "github" ? [{ label: "Build from the newest commit", onSelect: () => openJob({ kind: "build" }), disabled: jobRunning }] : []),
    "separator" as const,
    published ? { label: target === "umbrel" ? "Remove from Umbrel…" : "Remove…", danger: true, onSelect: () => setRemoving(true), disabled: jobRunning } : { label: "Delete draft…", danger: true, onSelect: deleteDraft, disabled: jobRunning },
  ];

  const tabs = [
    { value: "details" as const, label: "Details", count: undefined as number | undefined, attention: false },
    { value: "services" as const, label: "Services", count: analysis.services.length || undefined },
    { value: "compose" as const, label: "Compose", count: issues.filter((i) => i.level === "error" && !i.field?.startsWith("details.") && !i.field?.startsWith("web.")).length || undefined, attention: false },
    { value: "files" as const, label: "Files" },
    ...(d.github ? [{ value: "source" as const, label: "Source" }] : []),
    ...(d.versions.length ? [{ value: "history" as const, label: "History", count: d.versions.length }] : []),
  ];

  return (
    <Page>
      <PageHeader
        back={{ href: "/apps/custom", label: "Your apps" }}
        title={
          <span className={s.title}>
            <AppIcon src={draft.spec.details.icon} name={draft.spec.details.name || "App"} size={40} />
            <span className={s.titleText}>{draft.spec.details.name.trim() || "Untitled app"}</span>
          </span>
        }
        summary={summary}
        actions={
          <Menu
            trigger={
              <Button variant="secondary" icon={<MoreHoriz />} aria-label="More actions">
                More
              </Button>
            }
            items={menu}
          />
        }
      />

      {draft.state === "conflict" && (
        <div style={{ marginBottom: 16 }}>
          <Notice
            tone="attention"
            title="Changed somewhere else"
            action={
              <Button size="sm" onClick={async () => draft.reset(await api.get<CustomAppDetail>(`/api/custom-apps/${d.id}`))}>
                Load the latest
              </Button>
            }
          >
            This app was changed in another tab or by a publish. Load the latest to keep editing; what you typed since then isn&apos;t saved.
          </Notice>
        </div>
      )}

      <div className={s.layout}>
        <div className={s.main}>
          <Tabs value={tab} onChange={setTab} items={tabs} aria-label="App builder" />
          <div className={s.tabBody}>
            {tab === "details" && <DetailsTab draft={draft} detail={d} services={analysis.services} issues={issues} target={target} storeId={storeData?.storeId ?? null} usedPorts={usedPorts} />}
            {tab === "services" && <ServicesTab draft={draft} services={analysis.services} issues={issues} target={target} source={d.source} yamlBroken={!analysis.parsed.ok} onFix={fix} onOpenCompose={() => setTab("compose")} />}
            {tab === "compose" && <ComposeTab draft={draft} detail={d} issues={issues} onFix={fix} onFixAll={fixAll} onGo={goTo} editorRef={editorRef} secrets={draft.secrets} />}
            {tab === "files" && <FilesTab id={d.id} rev={d.rev} />}
            {tab === "source" && d.github && <SourceTab detail={d} draft={draft} busy={jobRunning} onRebuild={() => openJob(published ? { kind: "publish", rebuild: true } : { kind: "build" })} />}
            {tab === "history" && <HistoryTab detail={d} />}
          </div>
        </div>

        <aside className={s.rail} aria-label="Publishing">
          <Panel title={published ? "Where it runs" : "Publishing"}>
            <div className={s.railBody}>
              <div className={s.railState}>
                <StateLine state={rt.line} label={rt.label} />
              </div>
              <dl className={s.railFacts}>
                <dt>Source</dt>
                <dd>
                  {SOURCE_WORDS[d.source]}
                  {d.github && (
                    <>
                      {" "}
                      <span className="mono">
                        {d.github.owner}/{d.github.repo}
                      </span>
                    </>
                  )}
                </dd>
                <dt>{published ? "Version" : "First version"}</dt>
                <dd className="mono">{published ? `${d.publishedVersion}${changed ? ` → ${d.nextVersion}` : ""}` : d.nextVersion}</dd>
                <dt>{target === "umbrel" ? "In Umbrel" : "Runs with"}</dt>
                <dd className={target === "umbrel" ? "mono" : undefined}>{target === "umbrel" ? d.plannedAppId ?? "—" : "Docker Compose"}</dd>
                {url && (
                  <>
                    <dt>Opens at</dt>
                    <dd>
                      <a className={`${s.link} mono`} href={url} target="_blank" rel="noopener noreferrer">
                        {url.replace(/^https?:\/\//, "")}
                      </a>
                    </dd>
                  </>
                )}
                {d.publishedAt && (
                  <>
                    <dt>Published</dt>
                    <dd>
                      <Time ts={d.publishedAt} />
                    </dd>
                  </>
                )}
              </dl>
              <div>
                <div className={s.issuesHead}>
                  {published && !changed && errors.length === 0 ? <span className={s.issueCount} data-level="ok">Nothing changed since {d.publishedVersion}</span> : <IssueCount issues={issues} />}
                </div>
                {errors.length > 0 && (
                  <ul className={s.issues}>
                    {errors.slice(0, 5).map((i) => (
                      <li key={i.id} className={s.issue} data-level="error">
                        <span className={s.issueMark} aria-hidden />
                        <button type="button" className={`${s.issueGo} ${s.issueText}`} onClick={() => goTo(i)}>
                          {i.message}
                        </button>
                        <span />
                      </li>
                    ))}
                    {errors.length > 5 && (
                      <li className={s.issue}>
                        <span />
                        <button type="button" className={s.link} onClick={() => setTab("compose")}>
                          {errors.length - 5} more under Compose
                        </button>
                        <span />
                      </li>
                    )}
                  </ul>
                )}
              </div>
              <div className={s.railActions}>
                <Button variant={published && installedNow && !changed && !jobRunning ? "secondary" : "primary"} block onClick={() => openJob(jobRunning ? { kind: "attach" } : undefined)}>
                  {jobRunning ? "Show progress" : publishLabel}
                </Button>
                {published && installedNow && !changed && !jobRunning && <p className={s.hint}>Publishing again downloads the images again, so a newer :latest arrives.</p>}
              </div>
              <SaveLine state={draft.state} savedAt={draft.savedAt} error={draft.error} onRetry={() => void draft.save()} />
            </div>
          </Panel>
        </aside>
      </div>

      <PublishDialog
        open={jobOpen}
        onOpenChange={(o) => {
          setJobOpen(o);
          if (!o) setMode(undefined);
        }}
        detail={d}
        issues={issues}
        target={target}
        store={storeData ?? null}
        initialMode={mode}
        beforeStart={() => draft.save()}
        onFinished={() => {
          void mutate();
          void mutateStore();
        }}
        onSetUpStore={() => {
          setJobOpen(false);
          setStoreOpen(true);
        }}
      />
      <StoreSetupDialog
        open={storeOpen}
        onOpenChange={setStoreOpen}
        repair={!!storeData?.lost}
        onDone={(st) => {
          void mutateStore(st, { revalidate: false });
          setStoreOpen(false);
          setJobOpen(true);
        }}
      />
      <RemoveDialog
        open={removing}
        onOpenChange={setRemoving}
        detail={d}
        target={target}
        onConfirm={(opts) => {
          setRemoving(false);
          openJob({ kind: "remove", ...opts });
        }}
      />
      {confirmNode}
    </Page>
  );
}

function SaveLine({ state, savedAt, error, onRetry }: { state: string; savedAt: number; error: string | null; onRetry: () => void }) {
  return (
    <p className={s.saveState} data-state={state} aria-live="polite">
      <span className={s.saveDot} aria-hidden />
      {state === "saving" || state === "dirty" ? (
        "Saving…"
      ) : state === "error" ? (
        <span>
          Not saved: {error}{" "}
          <button type="button" className={s.link} onClick={onRetry}>
            Try again
          </button>
        </span>
      ) : state === "conflict" ? (
        "Not saved: changed elsewhere"
      ) : (
        <span>
          Saved <Time ts={savedAt} />
        </span>
      )}
    </p>
  );
}

function RemoveDialog({ open, onOpenChange, detail, target, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; detail: CustomAppDetail; target: BuilderTarget; onConfirm: (o: { keepData: boolean; forget: boolean }) => void }) {
  const [keepData, setKeepData] = React.useState(true);
  const [forget, setForget] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setKeepData(true);
      setForget(false);
    }
  }, [open]);
  const name = detail.spec.details.name;
  const installed = detail.runtime && detail.runtime.state !== "not-installed";
  const consequences = target === "umbrel"
    ? [
        installed ? `Umbrel stops ${name} and uninstalls it; its tile goes away.` : `${name} isn't installed, so only its listing goes.`,
        keepData
          ? "Its data folder is moved to Home › Gluon kept data in Umbrel's Files, so you can bring it back."
          : "Umbrel deletes its data folder, with everything the app saved. This can't be undone.",
        "Its listing leaves Gluon's store. Folders on the server it used (outside its data folder) aren't touched.",
        forget ? "Gluon forgets the app too: its settings, secrets and builds." : "The app stays here as a draft, so you can publish it again.",
      ]
    : [
        `Its containers stop and are removed.`,
        keepData ? "Its folder (with its data) stays on the server." : "Its folder, with everything the app saved, is deleted. This can't be undone.",
        forget ? "Gluon forgets the app too: its settings, secrets and builds." : "The app stays here as a draft, so you can publish it again.",
      ];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={target === "umbrel" ? `Remove ${name} from Umbrel?` : `Remove ${name}?`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {keepData ? (
            <Button variant="dangerSolid" onClick={() => onConfirm({ keepData, forget })}>
              Remove {name}
            </Button>
          ) : (
            <HoldButton holdMs={1400} onConfirm={() => onConfirm({ keepData, forget })}>
              Hold to remove and delete data
            </HoldButton>
          )}
        </>
      }
    >
      <div className={s.stack}>
        <ul className={s.consequences}>
          {consequences.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
        <Checkbox checked={keepData} onChange={setKeepData}>
          Keep its data
        </Checkbox>
        <Checkbox checked={forget} onChange={setForget}>
          Also delete it from Gluon
        </Checkbox>
      </div>
    </Dialog>
  );
}
