"use client";
import * as React from "react";
import { OpenNewWindow } from "iconoir-react";
import type { BuilderTarget, CustomAppDetail, Issue, StoreStatus } from "@/lib/builder-types";
import { Dialog } from "@/components/ui/Dialog";
import { Button, LinkButton } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Field";
import { DefinitionList, Notice } from "@/components/ui/Surface";
import { IssueList } from "./Issues";
import { JobProgress } from "./JobProgress";
import { jobFrom } from "./state";
import { useJob, type JobMode } from "./useJob";
import s from "./builder.module.css";

export type { JobMode } from "./useJob";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  detail: CustomAppDetail;
  issues: Issue[];
  target: BuilderTarget;
  store: StoreStatus | null;
  /** Save any typing before publishing. */
  beforeStart: () => Promise<void>;
  onFinished: () => void;
  onSetUpStore: () => void;
  initialMode?: JobMode;
}

/**
 * Publish (install or update) in one place: what will happen, then the run itself, then how it
 * ended. The run belongs to the server; closing this doesn't stop it, and reopening shows it again.
 */
export function PublishDialog({ open, onOpenChange, detail, issues, target, store, beforeStart, onFinished, onSetUpStore, initialMode }: Props) {
  const { view, setView, running, startError, start, reset, serverRunning } = useJob(detail, { beforeStart, onFinished });
  const [rebuild, setRebuild] = React.useState(false);
  const job = detail.job;

  // Opening while a job runs (or just ran) shows it; the live stream takes over when we started it.
  React.useEffect(() => {
    if (!open) return;
    reset();
    if (initialMode && initialMode.kind !== "attach") return void start(initialMode);
    if (job && !running) setView({ ...jobFrom(job.events), stages: job.stages, kind: job.kind });
    else if (!job && !running) setView(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // While attached by polling (after a reload), follow the server's copy.
  React.useEffect(() => {
    if (open && job && !running && (serverRunning || view)) setView({ ...jobFrom(job.events), stages: job.stages, kind: job.kind });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.events.length, job?.finishedAt]);

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const installed = detail.runtime && detail.runtime.state !== "not-installed";
  const needsStore = target === "umbrel" && store && !store.registered;
  const name = detail.spec.details.name || "this app";
  const action = target === "umbrel" ? (installed ? "Update in Umbrel" : "Install in Umbrel") : detail.status === "published" && installed ? "Update" : "Start it";
  const building = detail.source === "github" && /(^|\n)\s+build:/.test(detail.spec.compose);
  const webUrl = detail.spec.web.service && detail.spec.web.port ? `http://${detail.lanHost ?? (typeof window !== "undefined" ? window.location.hostname : "localhost")}:${detail.spec.web.port}${detail.spec.web.path || ""}` : null;

  let title = `Publish ${name}`;
  let description: string | undefined;
  let body: React.ReactNode;
  let footer: React.ReactNode;

  if (view) {
    const kind = view.kind ?? "publish";
    const done = !!view.result;
    title = kind === "build" ? `Building ${name}` : kind === "remove" ? `Removing ${name}` : target === "umbrel" ? `${installed || view.stages.some((st) => st.label.startsWith("Update")) ? "Updating" : "Installing"} ${name}` : `Publishing ${name}`;
    if (done) title = view.result!.ok ? (kind === "build" ? "Built" : kind === "remove" ? "Removed" : `${name} is ${target === "umbrel" ? "in Umbrel" : "running"}`) : kind === "build" ? "The build failed" : kind === "remove" ? "Removing didn't finish" : "Publishing didn't finish";
    body = <JobProgress view={view} stages={view.stages} running={!done} openOutput={kind === "build" || (done && !view.result!.ok && !view.result!.detail?.length)} label={title} />;
    footer = done ? (
      <>
        {view.result!.ok && kind === "publish" && webUrl && (
          <Button icon={<OpenNewWindow />} onClick={() => window.open(webUrl, "_blank", "noopener")}>
            Open {name}
          </Button>
        )}
        {view.result!.ok && kind === "publish" && detail.appId && (
          <LinkButton href={`/apps/${encodeURIComponent(detail.appId)}`} variant="ghost">
            Show in Apps
          </LinkButton>
        )}
        {!view.result!.ok && kind === "publish" && (
          <Button onClick={() => void start({ kind: "publish", rebuild })}>Try again</Button>
        )}
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </>
    ) : (
      <Button variant="ghost" onClick={() => onOpenChange(false)}>
        Close
      </Button>
    );
  } else {
    description = target === "umbrel" ? (installed ? "Gluon adds the new version to its store, then Umbrel updates the app." : "Gluon adds it to its store, then Umbrel installs it like any other app.") : "Gluon writes the app's files and starts it with Docker Compose.";
    const facts: [React.ReactNode, React.ReactNode][] = [
      ["Version", <span key="v" className="mono">{detail.nextVersion}{detail.publishedVersion && <span className={s.muted}> (now {detail.publishedVersion})</span>}</span>],
      [target === "umbrel" ? "In Umbrel as" : "Folder", <span key="w" className="mono">{target === "umbrel" ? detail.plannedAppId ?? "…" : `${store?.composeRoot ?? ""}/${detail.appId ?? detail.spec.details.slug}`}</span>],
    ];
    if (webUrl) facts.push(["Opens at", <span key="u" className="mono">{webUrl.replace(/^http:\/\//, "")}</span>]);
    if (building) facts.push(["Images", detail.github?.builtCommit ? <span key="b">Built from <span className="mono">{detail.github.builtCommit.slice(0, 7)}</span>{detail.github.latestCommit && detail.github.latestCommit !== detail.github.builtCommit ? "; newer commits exist" : ""}</span> : "Gluon builds them first (this can take a while)"]);
    body = (
      <div className={s.stack}>
        {needsStore ? (
          <Notice tone="attention" title="Gluon's store isn't in Umbrel yet" action={<Button size="sm" onClick={onSetUpStore}>Set up the store</Button>}>
            Umbrel installs apps from app stores, so it needs to know about Gluon&apos;s once.
          </Notice>
        ) : null}
        {startError && <Notice tone="fault" title="That didn't start">{startError}</Notice>}
        <DefinitionList items={facts} />
        {building && detail.github?.builtCommit && (
          <Checkbox checked={rebuild} onChange={setRebuild}>
            Build again from the newest commit on {detail.github.branch}
          </Checkbox>
        )}
        {errors.length > 0 ? (
          <div>
            <p className={s.listLead}>
              Fix {errors.length === 1 ? "this" : "these"} first:
            </p>
            <IssueList issues={errors} />
          </div>
        ) : warnings.length > 0 ? (
          <div>
            <p className={s.listLead}>
              {warnings.length === 1 ? "One thing to know" : `${warnings.length} things to know`}:
            </p>
            <IssueList issues={warnings} />
          </div>
        ) : null}
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={errors.length > 0 || !!needsStore || serverRunning} onClick={() => void start({ kind: "publish", rebuild })}>
          {action}
        </Button>
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} size="wide" footer={footer}>
      {body}
    </Dialog>
  );
}
