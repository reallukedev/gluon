"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Box3dPoint, Page as PageIcon, Github, Lock } from "iconoir-react";
import { ApiError, api, useApi } from "@/lib/client/api";
import type { AppSummary } from "@/server/docker/apps";
import type { AppSpec, BuilderSource, BuilderTarget, RepoInspection } from "@/lib/builder-types";
import { Page, PageHeader, Panel, Notice } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Disclosure } from "@/components/ui/Disclosure";
import { StateLine } from "@/components/ui/StateLine";
import { AppIcon } from "@/components/apps/AppIcon";
import { analyze } from "@/lib/builder/analyze";
import { blankDetails, pickWebPort, prepareCompose, specFromImage, titleize } from "@/lib/builder/start";
import { imageError, nameError, parseGithub, slugify } from "@/lib/builder/names";
import { ImageField, useImageLookup } from "./ImageField";
import { IssueList } from "./Issues";
import { YamlEditor } from "./YamlEditor";
import s from "./builder.module.css";

const SOURCES: { value: BuilderSource; title: string; desc: string; icon: React.ReactNode }[] = [
  { value: "image", title: "A Docker image", desc: "One container from Docker Hub, GitHub's registry or any other, set up with a form.", icon: <Box3dPoint /> },
  { value: "compose", title: "A compose file", desc: "Paste a docker-compose.yml, or copy one from an app already on this server.", icon: <PageIcon /> },
  { value: "github", title: "A GitHub repository", desc: "Gluon reads the repository and builds it on this server if it has to.", icon: <Github /> },
];

export function NewAppView({ initial, target }: { initial: BuilderSource | null; target: BuilderTarget }) {
  const router = useRouter();
  const [source, setSource] = React.useState<BuilderSource | null>(initial);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const choose = (v: BuilderSource) => {
    setSource(v);
    setError(null);
    window.history.replaceState(null, "", `/apps/new?from=${v}`);
  };

  async function create(body: { source: BuilderSource; spec: AppSpec; secrets?: Record<string, Record<string, string>>; github?: unknown; token?: string | null }) {
    setCreating(true);
    setError(null);
    try {
      const r = await api.post<{ id: string }>("/api/custom-apps", body);
      router.push(`/apps/custom/${r.id}`);
    } catch (e) {
      setCreating(false);
      setError(e instanceof Error ? e.message : "Gluon couldn't start the app.");
    }
  }

  const where = target === "umbrel" ? "It installs through Umbrel like any other app." : "Gluon runs it with Docker Compose.";

  return (
    <Page narrow>
      <PageHeader back={{ href: "/apps/custom", label: "Your apps" }} title="Make an app" summary={<>Start from an image, a compose file or a repository. {where} Everything can be changed later.</>} />
      <div className={s.sources} role="radiogroup" aria-label="Start from">
        {SOURCES.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={source === o.value} className={s.source} data-checked={source === o.value ? "" : undefined} onClick={() => choose(o.value)}>
            {o.icon}
            <span className={s.sourceTitle}>{o.title}</span>
            <span className={s.sourceDesc}>{o.desc}</span>
          </button>
        ))}
      </div>
      <div className={s.startPanel}>
        {error && (
          <div style={{ marginBottom: 16 }}>
            <Notice tone="fault" title="That didn't work">
              {error}
            </Notice>
          </div>
        )}
        {source === "image" && <FromImage target={target} busy={creating} onCreate={create} />}
        {source === "compose" && <FromCompose target={target} busy={creating} onCreate={create} />}
        {source === "github" && <FromGithub target={target} busy={creating} onCreate={create} />}
        {!source && <p className={s.hint}>Choose where to start. Your progress is saved as a draft as soon as you continue.</p>}
      </div>
    </Page>
  );
}

type Create = (body: { source: BuilderSource; spec: AppSpec; secrets?: Record<string, Record<string, string>>; github?: unknown; token?: string | null }) => void;

// ---------------------------------------------------------------- image

function FromImage({ busy, onCreate }: { target: BuilderTarget; busy: boolean; onCreate: Create }) {
  const [image, setImage] = React.useState("");
  const [name, setName] = React.useState("");
  const [nameTouched, setNameTouched] = React.useState(false);
  const lookup = useImageLookup(image);
  const suggested = image.trim() && !imageError(image) ? titleize(image.split("@")[0]!.split(":")[0]!.split("/").pop() ?? "") : "";
  const shownName = nameTouched ? name : suggested;
  const r = lookup.result;
  const ready = !!image.trim() && !imageError(image) && r?.exists !== false && !lookup.loading && !nameError(shownName);
  const webPort = r ? pickWebPort(r.ports) : null;
  const otherPorts = r ? r.ports.filter((p) => !(p.port === webPort && p.proto === "tcp")) : [];

  return (
    <Panel title="The image">
      <form
        className={s.stack}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onCreate({ source: "image", spec: specFromImage(image, r, shownName) });
        }}
      >
        <ImageField value={image} onChange={setImage} lookup={lookup} autoFocus>
          {r?.exists && (r.ports.length > 0 || r.volumes.length > 0) && (
            <div className={s.suggest}>
              <span>Gluon sets up what the image asks for:</span>
              <ul>
                {webPort && <li>Its web page, on port {webPort}</li>}
                {otherPorts.length > 0 && <li>{otherPorts.length === 1 ? "Port" : "Ports"} {otherPorts.map((p) => `${p.port}${p.proto === "udp" ? "/udp" : ""}`).join(", ")}, open on the server too</li>}
                {r.volumes.length > 0 && <li>{r.volumes.length === 1 ? "Its folder" : "Its folders"} {r.volumes.join(", ")}, kept in the app&apos;s data folder</li>}
                {/(^|\/)linuxserver\/|^lscr\.io\//.test(image) && <li>PUID, PGID and TZ, which LinuxServer images read</li>}
              </ul>
            </div>
          )}
        </ImageField>
        <Field label="Name" description="What Umbrel shows under its icon. You can add an icon and description next." error={nameTouched ? nameError(name) : null}>
          <Input
            value={shownName}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value);
            }}
            placeholder="Jellyfin"
            maxLength={80}
          />
        </Field>
        <div className={s.formActions}>
          <Button type="submit" variant="primary" disabled={!ready} loading={busy}>
            Continue
          </Button>
        </div>
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------------- compose

function FromCompose({ target, busy, onCreate }: { target: BuilderTarget; busy: boolean; onCreate: Create }) {
  const [text, setText] = React.useState("");
  const [name, setName] = React.useState("");
  const [nameTouched, setNameTouched] = React.useState(false);
  const [icon, setIcon] = React.useState<string | null>(null);
  const [fromApp, setFromApp] = React.useState("");
  const [loadingApp, setLoadingApp] = React.useState(false);
  const [appError, setAppError] = React.useState<string | null>(null);
  const deferred = React.useDeferredValue(text);
  const { data: apps } = useApi<AppSummary[]>("/api/apps");
  const candidates = (apps ?? []).filter((a) => a.configFile && !a.umbrel && !a.self).sort((a, b) => a.name.localeCompare(b.name));

  const prepared = React.useMemo(() => (deferred.trim() ? prepareCompose(deferred, target, "compose") : null), [deferred, target]);
  const remaining = React.useMemo(() => (prepared ? analyze(prepared.text, { source: "compose", target, web: prepared.web, secrets: prepared.secrets }).issues : []), [prepared, target]);
  const syntax = React.useMemo(() => (deferred.trim() ? analyze(deferred, { source: "compose", target, web: prepared?.web ?? { service: null, containerPort: null, port: null, path: "", umbrelAuth: true }, secrets: {} }).issues.filter((i) => i.id.startsWith("yaml-") || i.id === "root" || i.id === "no-services") : []), [deferred, target, prepared]);
  const errors = remaining.filter((i) => i.level === "error");
  const guessedName = prepared?.name ?? (prepared ? titleize(prepared.web.service ?? "") : "");
  const shownName = nameTouched ? name : guessedName;
  const ready = !!prepared && syntax.length === 0 && !nameError(shownName);

  async function copyFrom(id: string) {
    setFromApp(id);
    setAppError(null);
    if (!id) return;
    setLoadingApp(true);
    try {
      const c = await api.get<{ content: string }>(`/api/apps/${encodeURIComponent(id)}/compose`);
      const a = candidates.find((x) => x.id === id);
      setText(c.content);
      if (a) {
        setName(a.name);
        setNameTouched(true);
        setIcon(a.icon);
      }
    } catch (e) {
      setAppError(e instanceof Error ? e.message : "Gluon couldn't read that app's compose file.");
    } finally {
      setLoadingApp(false);
    }
  }

  function submit() {
    if (!prepared || !ready) return;
    const secrets: Record<string, Record<string, string>> = {};
    for (const [svc, keys] of Object.entries(prepared.secrets)) secrets[svc] = Object.fromEntries(keys.map((k) => [k, prepared.secretValues[svc]?.[k] ?? ""]));
    const details = { ...blankDetails(shownName), icon: icon && /^(https?:|data:image\/)/.test(icon) ? icon : null };
    onCreate({ source: "compose", spec: { details, web: prepared.web, compose: prepared.text }, secrets });
  }

  return (
    <Panel title="The compose file" meta={loadingApp ? "Loading…" : undefined}>
      <div className={s.stack}>
        {candidates.length > 0 && (
          <Field label="Copy from an app on this server" optional description="Its compose file becomes a new app; the running one isn't touched." error={appError}>
            <Select className={s.fill} value={fromApp} onChange={(v) => void copyFrom(v)} placeholder="Choose an app" options={[{ value: "", label: "Paste one instead" }, ...candidates.map((a) => ({ value: a.id, label: a.name, description: a.configFile ?? undefined }))]} />
          </Field>
        )}
        <div className={s.editorWrap}>
          <div className={s.editorBar}>
            <h2>docker-compose.yml</h2>
            <span className={s.hint}>{text.trim() ? `${text.split("\n").length} lines` : "Paste it here"}</span>
          </div>
          <YamlEditor value={text} onChange={setText} issues={syntax} height={340} label="Compose file" />
        </div>
        {prepared && syntax.length === 0 && (
          <div className={s.stack}>
            {prepared.said.length > 0 ? (
              <div className={s.suggest}>
                <span>Gluon will make {prepared.said.length === 1 ? "this change" : `these ${prepared.said.length} changes`} so it runs {target === "umbrel" ? "under Umbrel" : "here"}:</span>
                <ul>
                  {prepared.said.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
                <Disclosure summary="Show the file after these changes">
                  <div className={s.editorWrap}>
                    <YamlEditor value={prepared.text} original={deferred} readOnly height={300} label="Compose file after Gluon's changes" />
                  </div>
                </Disclosure>
              </div>
            ) : (
              <StateLine state="running" size={12} label="Nothing needs changing" />
            )}
            {prepared.web.service ? (
              <p className={s.hint}>
                The web page looks like <span className={s.mono}>{prepared.web.service}</span> on port <span className={`${s.mono} num`}>{prepared.web.containerPort}</span>. You can change it next.
              </p>
            ) : (
              <p className={s.hint}>No service publishes a web port, so pick the web page next (or leave it without one).</p>
            )}
            {errors.length > 0 && (
              <div>
                <p className={s.hint} style={{ marginBottom: 6 }}>
                  Still to fix after you continue:
                </p>
                <IssueList issues={errors} />
              </div>
            )}
          </div>
        )}
        {syntax.length > 0 && <IssueList issues={syntax} />}
        <Field label="Name" error={nameTouched ? nameError(name) : null}>
          <Input
            value={shownName}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value);
            }}
            placeholder="Paperless"
            maxLength={80}
          />
        </Field>
        <div className={s.formActions}>
          <Button variant="primary" disabled={!ready} loading={busy} onClick={submit}>
            Continue
          </Button>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- GitHub

function FromGithub({ target, busy, onCreate }: { target: BuilderTarget; busy: boolean; onCreate: Create }) {
  const [repo, setRepo] = React.useState("");
  const [branch, setBranch] = React.useState("");
  const [path, setPath] = React.useState("");
  const [token, setToken] = React.useState("");
  const [showToken, setShowToken] = React.useState(false);
  const [reading, setReading] = React.useState(false);
  const [found, setFound] = React.useState<RepoInspection | null>(null);
  const [err, setErr] = React.useState<{ message: string; field?: string } | null>(null);
  const [name, setName] = React.useState("");
  const parsed = parseGithub(repo);

  async function read() {
    if (!parsed) return setErr({ message: "Enter a repository as owner/name or its github.com address.", field: "repo" });
    setReading(true);
    setErr(null);
    setFound(null);
    try {
      const r = await api.post<RepoInspection>("/api/custom-apps/github", { repo, branch: branch.trim() || undefined, path: path.trim() || undefined, token: token.trim() || undefined });
      setFound(r);
      setName(r.prefill.details.name ?? titleize(r.repo));
      if (!branch.trim() && parsed.branch === null) setBranch("");
    } catch (e) {
      setErr({ message: e instanceof Error ? e.message : "Gluon couldn't read that repository.", field: e instanceof ApiError ? e.field : undefined });
      if (e instanceof ApiError && e.field === "token") setShowToken(true);
    } finally {
      setReading(false);
    }
  }

  const prepared = React.useMemo(() => (found ? prepareCompose(found.prefill.compose, target, "github", found.prefill.web) : null), [found, target]);

  function submit() {
    if (!found || !prepared) return;
    const secrets: Record<string, Record<string, string>> = {};
    for (const [svc, keys] of Object.entries(prepared.secrets)) secrets[svc] = Object.fromEntries(keys.map((k) => [k, prepared.secretValues[svc]?.[k] ?? ""]));
    const n = name.trim() || titleize(found.repo);
    const details = { ...blankDetails(n), ...found.prefill.details, name: n, slug: slugify(n) };
    onCreate({
      source: "github",
      spec: { details, web: prepared.web, compose: prepared.text },
      secrets,
      github: { owner: found.owner, repo: found.repo, branch: found.branch, path: found.path, private: found.private },
      token: token.trim() || null,
    });
  }

  const fieldErr = (f: string) => (err?.field === f ? err.message : null);

  return (
    <Panel title="The repository">
      <form
        className={s.stack}
        onSubmit={(e) => {
          e.preventDefault();
          void read();
        }}
      >
        <Field label="Repository" description="owner/name, or its address on github.com (a link to a folder or branch works too)." error={fieldErr("repo")}>
          <Input value={repo} onChange={(e) => (setRepo(e.target.value), setFound(null))} placeholder="paperless-ngx/paperless-ngx" mono spellCheck={false} autoCapitalize="off" autoCorrect="off" autoFocus />
        </Field>
        <div className={s.twoCol}>
          <Field label="Branch" optional description={parsed?.branch ? `From the link: ${parsed.branch}` : "Its main branch if empty."} error={fieldErr("branch")}>
            <Input value={branch} onChange={(e) => (setBranch(e.target.value), setFound(null))} placeholder={parsed?.branch ?? "main"} mono spellCheck={false} autoCapitalize="off" />
          </Field>
          <Field label="Folder" optional description="Where the app is, if not at the top." error={fieldErr("path")}>
            <Input value={path} onChange={(e) => (setPath(e.target.value), setFound(null))} placeholder={parsed?.path ?? "apps/web"} mono spellCheck={false} autoCapitalize="off" />
          </Field>
        </div>
        {showToken ? (
          <Field label="Access token" optional description="For private repositories: a fine-grained token with read access to its contents. Gluon keeps it encrypted and never shows it again." error={fieldErr("token")}>
            <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" mono placeholder="github_pat_…" />
          </Field>
        ) : (
          <button type="button" className={s.link} style={{ justifySelf: "start", fontSize: "var(--text-sm)" }} onClick={() => setShowToken(true)}>
            <Lock width={13} height={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            It&apos;s private
          </button>
        )}
        {err && !err.field && <Notice tone="fault">{err.message}</Notice>}
        {!found && (
          <div className={s.formActions}>
            <Button type="submit" variant="primary" loading={reading} disabled={!repo.trim()}>
              Read repository
            </Button>
          </div>
        )}
      </form>
      {found && prepared && (
        <div className={s.stack} style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
          <div className={s.title} style={{ gap: 12 }}>
            <AppIcon src={found.prefill.details.icon} name={name || found.repo} size={40} />
            <div className={s.appText}>
              <a href={found.htmlUrl} target="_blank" rel="noopener noreferrer" className={s.appName} style={{ position: "static" }}>
                {found.owner}/{found.repo}
              </a>
              <span className={s.appSub}>
                <span className="mono">{found.branch}</span>
                {found.path ? ` · ${found.path}` : ""} · commit <span className="mono">{found.commit.slice(0, 7)}</span>
                {found.private ? " · private" : ""}
              </span>
            </div>
          </div>
          <ul className={s.found}>
            <li>
              <StateLine state={found.found.manifest ? "running" : "stopped"} size={12} label={found.found.manifest ? "umbrel-app.yml" : "No umbrel-app.yml"} />
            </li>
            <li>
              <StateLine state={found.found.compose ? "running" : "stopped"} size={12} label={found.found.compose ?? "No compose file"} />
            </li>
            <li>
              <StateLine state={found.found.dockerfile ? "running" : "stopped"} size={12} label={found.found.dockerfile ?? "No Dockerfile"} />
            </li>
          </ul>
          <p className={s.hint}>{found.plan}</p>
          {[...found.notes, ...prepared.said].length > 0 && (
            <ul className={s.explain} style={{ fontSize: "var(--text-sm)" }}>
              {[...found.notes, ...prepared.said].map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          <Field label="Name" error={nameError(name)}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
          <div className={s.formActions}>
            <Button variant="ghost" onClick={() => setFound(null)}>
              Change
            </Button>
            <Button variant="primary" onClick={submit} loading={busy} disabled={!!nameError(name)}>
              Continue
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
