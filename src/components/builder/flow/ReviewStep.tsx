"use client";
import * as React from "react";
import type { BuilderTarget, CustomAppDetail, Issue, StoreStatus } from "@/lib/builder-types";
import type { RoutesResponse } from "@/lib/network-types";
import { useApi } from "@/lib/client/api";
import { Panel, Notice, Skeleton, DefinitionList } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Field";
import { StateLine } from "@/components/ui/StateLine";
import { CopyButton } from "@/components/ui/CopyButton";
import { suggestLabel } from "@/components/network/shared";
import { IssueList } from "../Issues";
import { LazyYamlEditor as YamlEditor } from "../LazyYamlEditor";
import { linkHost, type Draft } from "../state";
import type { AddressChoice } from "./address";
import { FlowNav } from "./FlowFrame";
import s from "../builder.module.css";
import f from "./flow.module.css";

interface Preview {
  target: BuilderTarget;
  appId: string;
  version: string;
  files: Record<string, string>;
  published: Record<string, string> | null;
  error: string | null;
  secretFiles: string[];
}

/** The last look: what's wrong (with fixes), where it will run, and the exact files that will run. */
export function ReviewStep({ draft, detail: d, issues, checking, checkError, onRecheck, target, store, address, onFix, onBack, onSetUpStore, onStart }: { draft: Draft; detail: CustomAppDetail; issues: Issue[]; checking: boolean; checkError: string | null; onRecheck: () => void; target: BuilderTarget; store: StoreStatus | null; address: AddressChoice; onFix: (id: string) => void; onBack: () => void; onSetUpStore: () => void; onStart: () => void }) {
  const errors = issues.filter((i) => i.level === "error");
  const shown = issues.filter((i) => i.level !== "info" || i.fix);
  const needsStore = target === "umbrel" && !!store && !store.registered;
  const name = draft.spec.details.name.trim() || "the app";
  const w = draft.spec.web;
  const url = w.service && w.port ? `http://${linkHost(d)}:${w.port}${w.path || ""}` : null;
  const { data: routes } = useApi<RoutesResponse>(address.on ? "/api/network/routes" : null, { revalidateOnFocus: false });
  const secretCount = Object.values(draft.secrets).reduce((n, k) => n + k.length, 0);

  const facts: [React.ReactNode, React.ReactNode][] = [
    [target === "umbrel" ? "Installs in" : "Runs with", target === "umbrel" ? "Umbrel, from Gluon's app store" : "Docker Compose, run by Gluon"],
    [target === "umbrel" ? "Umbrel app id" : "Folder", <span key="w" className="mono">{target === "umbrel" ? d.plannedAppId ?? "…" : `${store?.composeRoot ?? "…"}/${d.appId ?? draft.spec.details.slug}`}</span>],
    ["On your network", url ? <span key="u" className="mono">{url.replace(/^http:\/\//, "")}</span> : "No web page"],
  ];
  if (url) facts.push(["On the internet", address.on && routes ? <span key="a" className="mono">{`${address.label || suggestLabel(name)}.${routes.config.base_domain}`}</span> : "Not published"]);
  if (secretCount) facts.push(["Secrets", `${secretCount} kept encrypted, outside the files below`]);

  return (
    <div className={f.stack}>
      <Panel title="Before it starts" meta={checking ? <StateLine state="starting" size={12} label="Checking ports and images" /> : undefined}>
        {needsStore && (
          <div className={f.notice}>
            <Notice tone="attention" title="Gluon's store isn't in Umbrel yet" action={<Button size="sm" onClick={onSetUpStore}>Set up the store</Button>}>
              Umbrel installs apps from app stores, so it needs to know about Gluon&apos;s once.
            </Notice>
          </div>
        )}
        {checkError && !checking && (
          <div className={f.notice}>
            <Notice tone="attention" title="Gluon couldn't check ports and images" action={<Button size="sm" onClick={onRecheck}>Check again</Button>}>
              {checkError} Starting checks them again, so it can still go ahead.
            </Notice>
          </div>
        )}
        {shown.length ? (
          <IssueList issues={shown} onFix={onFix} />
        ) : checking ? (
          <div className={f.skeletonRows}>
            <Skeleton width="80%" height={14} />
            <Skeleton width="55%" height={14} />
          </div>
        ) : checkError ? null : (
          <StateLine state="running" size={12} label="Nothing to fix. The ports are free and the images exist." />
        )}
      </Panel>
      <Panel title="Where it runs">
        <DefinitionList items={facts} />
      </Panel>
      <Files id={d.id} rev={d.rev} saving={draft.state !== "saved"} />
      <FlowNav back={{ label: "Back", onClick: onBack }}>
        <Button variant="primary" disabled={errors.length > 0 || checking || needsStore || (!!d.job && !d.job.finishedAt)} onClick={onStart}>
          {target === "umbrel" ? `Install ${name} in Umbrel` : `Start ${name}`}
        </Button>
      </FlowNav>
      {errors.length > 0 && !checking && <p className={f.blocked}>{errors.length === 1 ? "Fix the problem above to start it." : `Fix the ${errors.length} problems above to start it.`}</p>}
    </div>
  );
}

/** The files exactly as the start writes them, from the server's own renderer. */
function Files({ id, rev, saving }: { id: string; rev: number; saving: boolean }) {
  // rev in the key: a new saved state is a new answer, fetched once.
  const { data, error } = useApi<Preview>(`/api/custom-apps/${id}/files?rev=${rev}`, { revalidateOnFocus: false, keepPreviousData: true });
  const names = data ? Object.keys(data.files).filter((n) => !n.endsWith(".gitkeep")) : [];
  const [file, setFile] = React.useState<string | null>(null);
  const current = file && names.includes(file) ? file : names[0] ?? null;
  if (error) return <Notice tone="fault" title="Couldn't show the files">{error.message}</Notice>;
  if (!data) return <Skeleton height={360} radius={12} />;
  if (data.error) return <Notice tone="fault" title="The files can't be made yet">{data.error} Fix the problems above first.</Notice>;
  return (
    <div className={s.editorWrap} aria-busy={saving || undefined}>
      <div className={s.editorBar}>
        {names.length > 1 ? <Segmented aria-label="File" value={current ?? ""} onChange={setFile} options={names.map((n) => ({ value: n, label: n }))} /> : <h3>{current}</h3>}
        {current && <CopyButton value={data.files[current]!} label="Copy file" />}
      </div>
      {current && <YamlEditor key={current} value={data.files[current]!} readOnly height={380} label={current} />}
    </div>
  );
}
