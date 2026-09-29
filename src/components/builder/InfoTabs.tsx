"use client";
import * as React from "react";
import { OpenNewWindow, Refresh } from "iconoir-react";
import { ApiError, api, useApi } from "@/lib/client/api";
import type { BuilderTarget, CustomAppDetail } from "@/lib/builder-types";
import { Panel, Notice, Skeleton, Empty } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Field, Input, Segmented } from "@/components/ui/Field";
import { Dialog } from "@/components/ui/Dialog";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { CopyButton } from "@/components/ui/CopyButton";
import { toast } from "@/components/ui/Toast";
import { BRANCH_RE, repoPathError } from "@/lib/builder/names";
import { YamlEditor } from "./YamlEditor";
import type { Draft } from "./state";
import s from "./builder.module.css";

// ---------------------------------------------------------------- files

interface Preview {
  target: BuilderTarget;
  appId: string;
  version: string;
  files: Record<string, string>;
  published: Record<string, string> | null;
  error: string | null;
  secretFiles: string[];
}

/** Exactly what the next publish writes, beside what was published last. */
export function FilesTab({ id, rev }: { id: string; rev: number }) {
  const { data, error, isLoading, mutate } = useApi<Preview>(`/api/custom-apps/${id}/files`, { revalidateOnFocus: false });
  React.useEffect(() => {
    void mutate();
  }, [rev, mutate]);
  const names = data ? Object.keys(data.files).filter((f) => !f.endsWith(".gitkeep")) : [];
  const [file, setFile] = React.useState<string | null>(null);
  const [compare, setCompare] = React.useState(false);
  const current = file && names.includes(file) ? file : names[0] ?? null;
  if (error) return <Notice tone="fault" title="Couldn't show the files">{error.message}</Notice>;
  if (!data || (isLoading && !data)) return <Skeleton height={400} radius={12} />;
  if (data.error) return <Notice tone="fault" title="These files can't be made yet">{data.error} Fix the problems listed under Checks first.</Notice>;
  const folders = Object.keys(data.files).filter((f) => f.endsWith(".gitkeep")).map((f) => f.replace(/\/\.gitkeep$/, ""));
  const before = current && data.published ? data.published[current] : undefined;
  return (
    <div className={s.stack}>
      <div className={s.editorWrap}>
        <div className={s.editorBar}>
          <Segmented aria-label="File" value={current ?? ""} onChange={setFile} options={names.map((n) => ({ value: n, label: n }))} />
          <div className={s.editorTools}>
            {before !== undefined && before !== data.files[current!] && (
              <Segmented aria-label="Show" value={compare ? "diff" : "file"} onChange={(v) => setCompare(v === "diff")} options={[{ value: "file", label: "File" }, { value: "diff", label: "Changes" }]} />
            )}
            {current && <CopyButton value={data.files[current]!} label="Copy file" />}
          </div>
        </div>
        {current && <YamlEditor key={`${current}-${compare}`} value={data.files[current]!} original={compare ? before : undefined} readOnly height={520} label={current} />}
      </div>
      <p className={s.hint}>
        {data.target === "umbrel" ? (
          <>
            {data.published ? "The next publish adds" : "Publishing adds"} <span className="mono">{data.appId}</span> version <span className="mono">{data.version}</span> to Gluon&apos;s store.{folders.length ? <> Umbrel makes {folders.length === 1 ? "the data folder" : "the data folders"} <span className="mono">{folders.join(", ")}</span> for it.</> : null}
          </>
        ) : (
          <>Written to the app&apos;s folder on this server and started with Docker Compose.</>
        )}
        {data.secretFiles.length > 0 && (
          <>
            {" "}
            Secrets go to <span className="mono">{data.secretFiles.join(", ")}</span> next to the app, readable only by root, and never into the store.
          </>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- history

export function HistoryTab({ detail }: { detail: CustomAppDetail }) {
  if (!detail.versions.length) return <Empty title="Not published yet">Each time you publish, the version shows up here with who published it and from which commit.</Empty>;
  return (
    <Panel title="Published versions" flush meta={<span className="num">{detail.versions.length}</span>}>
      <ul className={s.plainList}>
        {detail.versions.map((v, i) => (
          <li key={v.revision}>
            <span className={s.plainMain}>
              <span className={s.plainTitle}>
                <span className="mono">{v.version}</span>
                {i === 0 && <StateLine state={detail.runtime?.version === v.version ? "running" : "stopped"} size={12} label={detail.runtime?.version === v.version ? "Running" : "Latest"} />}
              </span>
              <span className={s.plainSub}>
                <Time ts={v.publishedAt} kind="dateTime" />
                {v.username ? ` by ${v.username}` : ""}
                {v.sourceCommit ? <> · built from <span className="mono">{v.sourceCommit.slice(0, 7)}</span></> : null}
              </span>
            </span>
            <span />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------- source (GitHub)

export function SourceTab({ detail, draft, onRebuild, busy }: { detail: CustomAppDetail; draft: Draft; onRebuild: () => void; busy: boolean }) {
  const gh = detail.github!;
  const [branch, setBranch] = React.useState(gh.branch);
  const [path, setPath] = React.useState(gh.path);
  const [token, setToken] = React.useState("");
  const [editingToken, setEditingToken] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [log, setLog] = React.useState<{ id: string; text: string | null; error: string | null } | null>(null);
  const branchErr = branch && !BRANCH_RE.test(branch) ? "That isn't a branch name Gluon can use." : null;
  const pathErr = repoPathError(path);
  const url = `https://github.com/${gh.owner}/${gh.repo}`;
  const behind = gh.latestCommit && gh.builtCommit && gh.latestCommit !== gh.builtCommit;

  React.useEffect(() => {
    setBranch(gh.branch);
    setPath(gh.path);
  }, [gh.branch, gh.path]);

  const saveRef = () => {
    if (branchErr || pathErr || (branch === gh.branch && path === gh.path) || !branch) return;
    draft.setGithub({ branch, path });
  };

  async function check() {
    setChecking(true);
    try {
      const r = await api.post<{ latest: string; built: string | null }>(`/api/custom-apps/${detail.id}/commits`);
      if (r.built && r.latest === r.built) toast.success("Up to date", { description: `The newest commit on ${gh.branch} is the one it was built from.` });
      else toast.info(r.built ? "There are new commits" : "Not built yet", { description: `${gh.branch} is at ${r.latest.slice(0, 7)}.` });
    } catch (e) {
      toast.error("Couldn't check for new commits", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setChecking(false);
    }
  }

  async function openLog(id: string) {
    setLog({ id, text: null, error: null });
    try {
      const r = await api.get<{ log: string }>(`/api/custom-apps/${detail.id}/builds/${id}`);
      setLog({ id, text: r.log || "(The build wrote nothing.)", error: null });
    } catch (e) {
      setLog({ id, text: null, error: e instanceof ApiError ? e.message : "Couldn't load the log." });
    }
  }

  return (
    <>
      <Panel
        title="Repository"
        meta={
          <a href={url} target="_blank" rel="noopener noreferrer" className={s.link}>
            {gh.owner}/{gh.repo}
            <OpenNewWindow width={13} height={13} style={{ marginLeft: 5, verticalAlign: "-2px" }} />
          </a>
        }
      >
        <div className={s.stack}>
          <div className={s.twoCol}>
            <Field label="Branch" error={branchErr}>
              <Input value={branch} mono onChange={(e) => setBranch(e.target.value)} onBlur={saveRef} />
            </Field>
            <Field label="Folder" optional error={pathErr}>
              <Input value={path} mono placeholder="The top of the repository" onChange={(e) => setPath(e.target.value)} onBlur={saveRef} />
            </Field>
          </div>
          <div className={s.inlineControl}>
            <span>
              {gh.hasToken ? "A token is saved for this repository." : gh.private ? "The repository is private and no token is saved." : "No token (the repository is public)."}
              <span className={s.hint} style={{ display: "block" }}>
                {gh.hasToken ? "It's encrypted and never shown again." : "A token lets Gluon clone private repositories and avoids GitHub's limits."}
              </span>
            </span>
            <span className={s.iconButtons}>
              {gh.hasToken && !editingToken && (
                <Button size="sm" variant="ghost" onClick={() => draft.setToken(null)}>
                  Remove
                </Button>
              )}
              {!editingToken && (
                <Button size="sm" onClick={() => setEditingToken(true)}>
                  {gh.hasToken ? "Replace" : "Add a token"}
                </Button>
              )}
            </span>
          </div>
          {editingToken && (
            <div className={s.pathField}>
              <Input value={token} type="password" mono autoComplete="off" autoFocus placeholder="github_pat_…" aria-label="GitHub token" onChange={(e) => setToken(e.target.value.trim())} />
              <Button
                variant="primary"
                disabled={!/^[A-Za-z0-9_\-.]{10,255}$/.test(token)}
                onClick={() => {
                  draft.setToken(token);
                  setToken("");
                  setEditingToken(false);
                }}
              >
                Save token
              </Button>
              <Button variant="ghost" onClick={() => (setEditingToken(false), setToken(""))}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title="Builds"
        meta={
          <span className={s.iconButtons}>
            <Button size="sm" variant="ghost" icon={<Refresh />} loading={checking} onClick={() => void check()}>
              Check for new commits
            </Button>
            <Button size="sm" onClick={onRebuild} disabled={busy}>
              {detail.status === "published" ? "Rebuild and update" : "Build now"}
            </Button>
          </span>
        }
        flush
      >
        {(gh.builtCommit || gh.latestCommit) && (
          <p className={s.hint} style={{ padding: "12px 18px 0" }}>
            {gh.builtCommit ? (
              <>
                Built from <a className={`${s.link} mono`} href={`${url}/commit/${gh.builtCommit}`} target="_blank" rel="noopener noreferrer">{gh.builtCommit.slice(0, 7)}</a>
                {gh.builtAt ? <> <Time ts={gh.builtAt} /></> : null}.{" "}
              </>
            ) : null}
            {behind ? (
              <>
                <b>{gh.branch}</b> has moved on to <a className={`${s.link} mono`} href={`${url}/compare/${gh.builtCommit}...${gh.latestCommit}`} target="_blank" rel="noopener noreferrer">{gh.latestCommit!.slice(0, 7)}</a>.
              </>
            ) : gh.latestCommit && gh.checkedAt ? (
              <>
                That&apos;s still the newest on <b>{gh.branch}</b> (checked <Time ts={gh.checkedAt} />).
              </>
            ) : null}
          </p>
        )}
        {detail.builds.length === 0 ? (
          <p className={s.hint} style={{ padding: "12px 18px 16px" }}>
            No builds yet. Gluon builds the images when you publish, or now with Build now.
          </p>
        ) : (
          <ul className={s.plainList} style={{ marginTop: 4 }}>
            {detail.builds.map((b) => (
              <li key={b.id}>
                <span className={s.plainMain}>
                  <span className={s.plainTitle}>
                    <StateLine state={b.status === "running" ? "starting" : b.status === "ok" ? "running" : "unhealthy"} size={12} label={b.status === "running" ? "Building" : b.status === "ok" ? "Built" : "Failed"} />
                    {b.commit && <span className="mono">{b.commit.slice(0, 7)}</span>}
                  </span>
                  <span className={s.plainSub}>
                    <Time ts={b.startedAt} kind="dateTime" />
                    {b.finishedAt ? ` · took ${Math.max(1, Math.round((b.finishedAt - b.startedAt) / 1000))} s` : ""}
                    {b.username ? ` · ${b.username}` : ""}
                    {b.error ? ` · ${b.error}` : ""}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => void openLog(b.id)}>
                  Log
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Dialog open={!!log} onOpenChange={(o) => !o && setLog(null)} title="Build log" size="xwide" footer={<>{log?.text && <CopyButton value={log.text} size="md">Copy log</CopyButton>}<Button variant="primary" onClick={() => setLog(null)}>Close</Button></>}>
        {log?.error ? <Notice tone="fault">{log.error}</Notice> : log?.text === null ? <Skeleton height={300} /> : <pre className={`${s.log} ${s.logTall}`}>{log?.text}</pre>}
      </Dialog>
    </>
  );
}


