"use client";
import * as React from "react";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";
import { Box3dPoint, Page as PageIcon, Github, Lock, Terminal } from "iconoir-react";
import { ApiError, api, useApi } from "@/lib/client/api";
import type { AppSummary } from "@/server/docker/apps";
import type { AppSpec, BuilderSource, BuilderTarget, RepoInspection } from "@/lib/builder-types";
import { Notice } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Field, Input, TextArea } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Disclosure } from "@/components/ui/Disclosure";
import { useConfirm } from "@/components/ui/Dialog";
import { StateLine } from "@/components/ui/StateLine";
import { AppIcon } from "@/components/apps/AppIcon";
import { analyze } from "@/lib/builder/analyze";
import { draftFromDockerRun, type RunNote } from "@/lib/builder/dockerRun";
import { blankDetails, blankWeb, draftFromImage, nameForImage, pickWebPort, prepareCompose, titleize, type Prepared } from "@/lib/builder/start";
import { imageError, nameError, parseGithub, slugify } from "@/lib/builder/names";
import { ImageField, useImageLookup } from "../ImageField";
import { IssueList } from "../Issues";
import { LazyYamlEditor as YamlEditor } from "../LazyYamlEditor";
import s from "../builder.module.css";
import type { SourceIO } from "./sourceInputs";
import f from "./flow.module.css";

export type FlowSource = BuilderSource | "run";

export interface CreateBody {
  source: BuilderSource;
  spec: AppSpec;
  secrets?: Record<string, Record<string, string>>;
  github?: unknown;
  token?: string | null;
}

/** Where to go once the draft exists: the guided setup, or straight to the full builder. */
export type Create = (body: CreateBody, then: "flow" | "builder") => void;

const SOURCES: { value: FlowSource; title: string; desc: string; icon: React.ReactNode }[] = [
  { value: "image", title: "Image", desc: "One container from Docker Hub, GitHub's registry or any other. Search by name.", icon: <Box3dPoint /> },
  { value: "run", title: "docker run", desc: "Paste the command from an app's instructions; Gluon turns it into a compose file.", icon: <Terminal /> },
  { value: "compose", title: "Compose file", desc: "Paste a docker-compose.yml, or copy one from an app already on this server.", icon: <PageIcon /> },
  { value: "github", title: "GitHub", desc: "Gluon reads the repository and builds it on this server if it has to.", icon: <Github /> },
];

/** Secret names and values from a prepared compose file, as the create request wants them. */
function secretsOf(p: Prepared) {
  const out: Record<string, Record<string, string>> = {};
  for (const [svc, keys] of Object.entries(p.secrets)) out[svc] = Object.fromEntries(keys.map((k) => [k, p.secretValues[svc]?.[k] ?? ""]));
  return out;
}

/**
 * The first step: what to run. The picker is a radio group (arrow keys move between sources),
 * and the chosen source's form sits right under it.
 */
export function SourceStep({ source, onSource, target, busy, io, onCreate }: { source: FlowSource; onSource: (v: FlowSource) => void; target: BuilderTarget; busy: "flow" | "builder" | null; io: SourceIO; onCreate: Create }) {
  const current = SOURCES.find((o) => o.value === source)!;
  return (
    <section className={f.sourcePanel} aria-labelledby="source-label">
      <h2 id="source-label" className="sr-only">
        Start from
      </h2>
      <RadioGroup value={source} onValueChange={(v) => onSource(v as FlowSource)} aria-labelledby="source-label" className={f.sourcePicker}>
        {SOURCES.map((o) => (
          <Radio.Root key={o.value} value={o.value} className={f.sourceOption} nativeButton render={<button type="button" />}>
            {o.icon}
            <span>{o.title}</span>
          </Radio.Root>
        ))}
      </RadioGroup>
      <div className={f.sourceBody}>
        <p className={f.sourceDesc}>{current.desc}</p>
        <div key={source} className={f.stepIn} data-motion-gentle="">
          {source === "image" && <FromImage io={io} busy={busy} onCreate={onCreate} />}
          {source === "run" && <FromRun io={io} target={target} busy={busy} onCreate={onCreate} />}
          {source === "compose" && <FromCompose io={io} target={target} busy={busy} onCreate={onCreate} />}
          {source === "github" && <FromGithub io={io} target={target} busy={busy} onCreate={onCreate} />}
        </div>
      </div>
    </section>
  );
}

/** Continue (into the guided setup) and a quieter way straight into the full builder. */
function Actions({ ready, busy, onGo, children }: { ready: boolean; busy: "flow" | "builder" | null; onGo: (then: "flow" | "builder") => void; children?: React.ReactNode }) {
  return (
    <div className={s.formActions}>
      {children}
      <Button variant="ghost" disabled={!ready || !!busy} loading={busy === "builder"} onClick={() => onGo("builder")}>
        Open in the full builder
      </Button>
      <Button variant="primary" disabled={!ready || !!busy} loading={busy === "flow"} onClick={() => onGo("flow")}>
        Continue
      </Button>
    </div>
  );
}

function NameField({ value, onChange, touched, placeholder, description }: { value: string; onChange: (v: string) => void; touched: boolean; placeholder: string; description?: string }) {
  return (
    <Field label="Name" description={description} error={touched ? nameError(value) : null}>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={80} />
    </Field>
  );
}

/** A name that follows a suggestion until the person types their own. */
function useSuggestedName({ inputs, set }: SourceIO, source: FlowSource, suggestion: string) {
  const typed = inputs.names[source];
  return { name: typed ?? suggestion, touched: typed !== undefined, setName: (v: string) => set({ names: { [source]: v } }) };
}

// ---------------------------------------------------------------- image

function FromImage({ io, busy, onCreate }: { io: SourceIO; busy: "flow" | "builder" | null; onCreate: Create }) {
  const image = io.inputs.image;
  const setImage = (v: string) => io.set({ image: v });
  const lookup = useImageLookup(image);
  const valid = !!image.trim() && !imageError(image);
  const { name, touched, setName } = useSuggestedName(io, "image", valid ? nameForImage(image) : "");
  const r = lookup.result;
  // Continue stays the primary action while the image is being checked: pressing it waits for
  // the check (so its ports and folders come along), then goes on.
  const ready = valid && r?.exists !== false && !nameError(name);
  const [queued, setQueued] = React.useState<"flow" | "builder" | null>(null);
  const draft = React.useMemo(() => (valid && r ? draftFromImage(image, r, name) : null), [valid, image, r, name]);
  const webPort = r ? pickWebPort(r.ports) : null;
  const otherPorts = r ? r.ports.filter((p) => !(p.port === webPort && p.proto === "tcp")) : [];
  const create = (then: "flow" | "builder") => {
    const d = draftFromImage(image, r, name);
    onCreate({ source: "image", spec: d.spec, secrets: d.secretValues }, then);
  };
  const go = (then: "flow" | "builder") => {
    if (!ready) return;
    if (lookup.loading) setQueued(then);
    else create(then);
  };
  React.useEffect(() => {
    if (!queued || lookup.loading) return;
    setQueued(null);
    // The check said it doesn't exist: stay, and let the field explain.
    if (r?.exists !== false) create(queued);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, lookup.loading]);

  return (
    <div className={s.stack}>
      <ImageField value={image} onChange={setImage} lookup={lookup} autoFocus>
        {r?.exists && draft && (r.ports.length > 0 || r.volumes.length > 0 || draft.said.length > 0) && (
          <div className={s.suggest}>
            <span>Gluon sets up what the image asks for:</span>
            <ul>
              {webPort && <li>Its web page, on port {webPort}</li>}
              {otherPorts.length > 0 && <li>{otherPorts.length === 1 ? "Port" : "Ports"} {otherPorts.map((p) => `${p.port}${p.proto === "udp" ? "/udp" : ""}`).join(", ")}, open on the server too</li>}
              {r.volumes.length > 0 && <li>{r.volumes.length === 1 ? "Its folder" : "Its folders"} {r.volumes.join(", ")}, kept in the app&apos;s data folder</li>}
              {draft.said.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        )}
      </ImageField>
      <NameField value={name} onChange={setName} touched={touched} placeholder="Jellyfin" description="What the app is called here. You can change it later." />
      <Actions ready={ready} busy={busy ?? queued} onGo={go} />
    </div>
  );
}

// ---------------------------------------------------------------- docker run

const RUN_EXAMPLE = `docker run -d \\
  --name=jellyfin \\
  -e PUID=1000 -e PGID=1000 -e TZ=Etc/UTC \\
  -p 8096:8096 \\
  -v /path/to/config:/config \\
  --restart unless-stopped \\
  lscr.io/linuxserver/jellyfin:latest`;

function FromRun({ io, target, busy, onCreate }: { io: SourceIO; target: BuilderTarget; busy: "flow" | "builder" | null; onCreate: Create }) {
  const text = io.inputs.run;
  const setText = (v: string) => io.set({ run: v });
  const deferred = React.useDeferredValue(text);
  const result = React.useMemo(() => (deferred.trim() ? draftFromDockerRun(deferred, target) : null), [deferred, target]);
  const run = result?.run ?? null;
  const prepared = result?.prepared ?? null;
  const { name, touched, setName } = useSuggestedName(io, "run", run?.name ?? "");
  const ready = !!prepared && !nameError(name);
  const notes: RunNote[] = run?.notes ?? [];
  const go = (then: "flow" | "builder") => {
    if (!prepared || !ready) return;
    onCreate({ source: "compose", spec: { details: { ...blankDetails(name), ...(run?.image ? imageDetails(run.image) : {}) }, web: prepared.web, compose: prepared.text }, secrets: secretsOf(prepared) }, then);
  };

  return (
    <div className={s.stack}>
      <Field label="The command" description="Backslashes at the ends of lines, quotes and LinuxServer's #optional notes all work." error={text.trim() && run && !run.ok ? run.error : null}>
        <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={9} mono spellCheck={false} autoCapitalize="off" autoCorrect="off" autoFocus placeholder={RUN_EXAMPLE} className={f.runInput} />
      </Field>
      {run?.ok && prepared && (
        <div className={s.stack}>
          <div className={s.suggest}>
            <span>
              It becomes one service, <span className="mono">{run.service}</span>, running <span className="mono">{run.image}</span>
              {prepared.web.service ? (
                <>
                  , with its web page on port <span className="mono num">{prepared.web.containerPort}</span>
                </>
              ) : null}
              .
            </span>
            {(notes.length > 0 || prepared.said.length > 0) && (
              <ul className={f.notes}>
                {notes.map((n, i) => (
                  <li key={i} data-level={n.level}>
                    {n.text}
                  </li>
                ))}
                {prepared.said.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
            <Disclosure summary="Show the compose file">
              <div className={s.editorWrap}>
                <YamlEditor value={prepared.text} readOnly height={280} label="The compose file Gluon made" />
              </div>
            </Disclosure>
          </div>
        </div>
      )}
      <NameField value={name} onChange={setName} touched={touched} placeholder="Jellyfin" />
      <Actions ready={ready} busy={busy} onGo={go} />
    </div>
  );
}

/** Website and version from the image reference, like the image source does. */
function imageDetails(image: string) {
  const d = draftFromImage(image, null).spec.details;
  return { website: d.website, version: d.version };
}

// ---------------------------------------------------------------- compose

function FromCompose({ io, target, busy, onCreate }: { io: SourceIO; target: BuilderTarget; busy: "flow" | "builder" | null; onCreate: Create }) {
  const text = io.inputs.compose;
  const setText = (v: string) => io.set({ compose: v });
  const icon = io.inputs.composeIcon;
  const [fromApp, setFromApp] = React.useState("");
  const [loadingApp, setLoadingApp] = React.useState(false);
  const [appError, setAppError] = React.useState<string | null>(null);
  const [confirm, confirmNode] = useConfirm();
  const deferred = React.useDeferredValue(text);
  const { data: apps } = useApi<AppSummary[]>("/api/apps");
  const candidates = (apps ?? []).filter((a) => a.configFile && !a.umbrel && !a.self).sort((a, b) => a.name.localeCompare(b.name));

  const prepared = React.useMemo(() => (deferred.trim() ? prepareCompose(deferred, target, "compose") : null), [deferred, target]);
  const remaining = React.useMemo(() => (prepared ? analyze(prepared.text, { source: "compose", target, web: prepared.web, secrets: prepared.secrets }).issues : []), [prepared, target]);
  const syntax = React.useMemo(() => (deferred.trim() ? analyze(deferred, { source: "compose", target, web: prepared?.web ?? blankWeb(), secrets: {} }).issues.filter((i) => i.id.startsWith("yaml-") || i.id === "root" || i.id === "no-services") : []), [deferred, target, prepared]);
  const errors = remaining.filter((i) => i.level === "error");
  const { name, touched, setName } = useSuggestedName(io, "compose", prepared?.name ?? (prepared ? titleize(prepared.web.service ?? "") : ""));
  const ready = !!prepared && syntax.length === 0 && !nameError(name);

  // Replies can arrive out of order when the choice changes quickly; only the latest one counts.
  const seq = React.useRef(0);
  const copied = React.useRef<string | null>(null);
  async function load(id: string) {
    const n = ++seq.current;
    setLoadingApp(true);
    try {
      const c = await api.get<{ content: string }>(`/api/apps/${encodeURIComponent(id)}/compose`);
      if (n !== seq.current) return;
      const a = candidates.find((x) => x.id === id);
      copied.current = c.content;
      io.set({ compose: c.content, composeIcon: a?.icon ?? null, ...(a ? { names: { compose: a.name } } : {}) });
    } catch (e) {
      if (n === seq.current) setAppError(e instanceof Error ? e.message : "Gluon couldn't read that app's compose file.");
    } finally {
      if (n === seq.current) setLoadingApp(false);
    }
  }
  function copyFrom(id: string) {
    setFromApp(id);
    setAppError(null);
    if (!id) {
      seq.current++;
      return setLoadingApp(false);
    }
    // Typed or pasted text is the person's work: ask before replacing it.
    if (text.trim() && text !== copied.current) {
      const a = candidates.find((x) => x.id === id);
      confirm({
        title: `Replace the compose file with ${a?.name ?? "that app"}'s?`,
        description: "What you pasted or typed here is replaced. Nothing changes in the running app.",
        confirmLabel: "Replace it",
        onConfirm: () => void load(id),
      });
      return;
    }
    void load(id);
  }

  const go = (then: "flow" | "builder") => {
    if (!prepared || !ready) return;
    const details = { ...blankDetails(name), icon: icon && /^(https?:|data:image\/)/.test(icon) ? icon : null };
    onCreate({ source: "compose", spec: { details, web: prepared.web, compose: prepared.text }, secrets: secretsOf(prepared) }, then);
  };

  return (
    <div className={s.stack}>
      {candidates.length > 0 && (
        <Field label="Copy from an app on this server" optional description="Its compose file becomes a new app; the running one isn't touched." error={appError}>
          <Select className={s.fill} value={fromApp} onChange={copyFrom} placeholder="Choose an app" options={[{ value: "", label: "Paste one instead" }, ...candidates.map((a) => ({ value: a.id, label: a.name, description: a.configFile ?? undefined }))]} />
        </Field>
      )}
      <div className={s.editorWrap}>
        <div className={s.editorBar}>
          <h3>docker-compose.yml</h3>
          <span className={s.hint}>{loadingApp ? "Loading…" : text.trim() ? `${text.split("\n").length} lines` : "Paste it here"}</span>
        </div>
        <YamlEditor value={text} onChange={setText} issues={syntax} height={340} label="Compose file" />
      </div>
      {prepared && syntax.length === 0 && (
        <div className={s.stack}>
          {prepared.said.length > 0 ? (
            <div className={s.suggest}>
              <span>
                Gluon will make {prepared.said.length === 1 ? "this change" : `these ${prepared.said.length} changes`} so it runs {target === "umbrel" ? "under Umbrel" : "here"}:
              </span>
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
          <p className={s.hint}>
            {prepared.web.service ? (
              <>
                The web page looks like <span className={s.mono}>{prepared.web.service}</span> on port <span className={`${s.mono} num`}>{prepared.web.containerPort}</span>. You can change it next.
              </>
            ) : (
              "No service publishes a web port, so you'll pick the web page next (or leave it without one)."
            )}
          </p>
          {errors.length > 0 && (
            <div>
              <p className={s.listLead}>Still to fix after you continue:</p>
              <IssueList issues={errors} />
            </div>
          )}
        </div>
      )}
      {syntax.length > 0 && <IssueList issues={syntax} />}
      <NameField value={name} onChange={setName} touched={touched} placeholder="Paperless" />
      <Actions ready={ready} busy={busy} onGo={go} />
      {confirmNode}
    </div>
  );
}

// ---------------------------------------------------------------- GitHub

function FromGithub({ io, target, busy, onCreate }: { io: SourceIO; target: BuilderTarget; busy: "flow" | "builder" | null; onCreate: Create }) {
  const { repo, branch, path } = io.inputs;
  const setRepo = (v: string) => io.set({ repo: v });
  const setBranch = (v: string) => io.set({ branch: v });
  const setPath = (v: string) => io.set({ path: v });
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
    } catch (e) {
      setErr({ message: e instanceof Error ? e.message : "Gluon couldn't read that repository.", field: e instanceof ApiError ? e.field : undefined });
      if (e instanceof ApiError && e.field === "token") setShowToken(true);
    } finally {
      setReading(false);
    }
  }

  const prepared = React.useMemo(() => (found ? prepareCompose(found.prefill.compose, target, "github", found.prefill.web) : null), [found, target]);

  const go = (then: "flow" | "builder") => {
    if (!found || !prepared || nameError(name)) return;
    const n = name.trim() || titleize(found.repo);
    const details = { ...blankDetails(n), ...found.prefill.details, name: n, slug: slugify(n) };
    onCreate(
      {
        source: "github",
        spec: { details, web: prepared.web, compose: prepared.text },
        secrets: secretsOf(prepared),
        github: { owner: found.owner, repo: found.repo, branch: found.branch, path: found.path, private: found.private },
        token: token.trim() || null,
      },
      then,
    );
  };

  const fieldErr = (k: string) => (err?.field === k ? err.message : null);
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setFound(null);
  };

  return (
    <div className={s.stack}>
      <form
        className={s.stack}
        onSubmit={(e) => {
          e.preventDefault();
          void read();
        }}
      >
        <Field label="Repository" description="owner/name, or its address on github.com (a link to a folder or branch works too)." error={fieldErr("repo")}>
          <Input value={repo} onChange={(e) => reset(setRepo)(e.target.value)} placeholder="paperless-ngx/paperless-ngx" mono spellCheck={false} autoCapitalize="off" autoCorrect="off" autoFocus />
        </Field>
        <div className={s.twoCol}>
          <Field label="Branch" optional description={parsed?.branch ? `From the link: ${parsed.branch}` : "Its main branch if empty."} error={fieldErr("branch")}>
            <Input value={branch} onChange={(e) => reset(setBranch)(e.target.value)} placeholder={parsed?.branch ?? "main"} mono spellCheck={false} autoCapitalize="off" />
          </Field>
          <Field label="Folder" optional description="Where the app is, if not at the top." error={fieldErr("path")}>
            <Input value={path} onChange={(e) => reset(setPath)(e.target.value)} placeholder={parsed?.path ?? "apps/web"} mono spellCheck={false} autoCapitalize="off" />
          </Field>
        </div>
        {showToken ? (
          <Field label="Access token" optional description="For private repositories: a fine-grained token with read access to its contents. Gluon keeps it encrypted and never shows it again." error={fieldErr("token")}>
            <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" mono placeholder="github_pat_…" />
          </Field>
        ) : (
          <button type="button" className={`${s.link} ${f.privateLink}`} onClick={() => setShowToken(true)}>
            <Lock aria-hidden />
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
        <div className={f.found}>
          <div className={s.title}>
            <AppIcon src={found.prefill.details.icon} name={name || found.repo} size={40} />
            <div className={s.appText}>
              <a href={found.htmlUrl} target="_blank" rel="noopener noreferrer" className={f.repoLink}>
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
            <ul className={f.notes}>
              {[...found.notes, ...prepared.said].map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          <Field label="Name" error={nameError(name)}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
          <Actions ready={!nameError(name)} busy={busy} onGo={go}>
            <Button variant="ghost" className={f.pushLeft} onClick={() => setFound(null)}>
              Choose another repository
            </Button>
          </Actions>
        </div>
      )}
    </div>
  );
}
