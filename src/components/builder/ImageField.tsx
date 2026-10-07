"use client";
import * as React from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Combobox } from "@base-ui/react/combobox";
import { Field as BaseField } from "@base-ui/react/field";
import { NavArrowDown, Check } from "iconoir-react";
import { api } from "@/lib/client/api";
import { imageError, isLocalImage, parseImage } from "@/lib/builder/names";
import { hubQuery } from "@/lib/builder/hub";
import type { HubRepo, HubSearchResult, ImageLookup, TagInfo, TagPage } from "@/lib/builder-types";
import { Field } from "@/components/ui/Field";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { useFormat } from "@/components/PrefsProvider";
import field from "@/components/ui/field.module.css";
import popup from "@/components/ui/popup.module.css";
import s from "./builder.module.css";

export interface ImageLookupState {
  result: ImageLookup | null;
  loading: boolean;
  /** Gluon itself couldn't be asked (network, rate limit). The registry's own answers are in result. */
  error: string | null;
  retry: () => void;
}

/**
 * An image reference with a live check: is it on this server, does the registry have it, what
 * does it ask for. The lookup waits for typing to settle and never blocks editing.
 */
export function useImageLookup(ref: string): ImageLookupState {
  const [result, setResult] = React.useState<ImageLookup | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const clean = ref.trim();
  React.useEffect(() => {
    setResult(null);
    setError(null);
    if (!clean || imageError(clean) || clean.includes("$")) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.get<ImageLookup>(`/api/custom-apps/image?ref=${encodeURIComponent(clean)}`);
        if (!cancelled) setResult(r);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "The check didn't finish.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [clean, attempt]);
  const retry = React.useCallback(() => setAttempt((n) => n + 1), []);
  return { result, loading, error, retry };
}

export function registryName(ref: string) {
  const r = parseImage(ref).registry;
  return r === "docker.io" ? "Docker Hub" : r === "ghcr.io" ? "GitHub's registry" : r === "lscr.io" ? "LinuxServer's registry" : r === "quay.io" ? "Quay" : r;
}

/** The reference with its tag replaced (or added). */
export function withTag(ref: string, tag: string): string {
  const v = ref.trim().split("@")[0]!;
  const colon = v.lastIndexOf(":");
  const slash = v.lastIndexOf("/");
  return `${colon > slash ? v.slice(0, colon) : v}:${tag}`;
}

// ---------------------------------------------------------------- Docker Hub search

const searchCache = new Map<string, HubSearchResult>();

function useHubSearch(text: string, enabled: boolean) {
  const q = enabled ? hubQuery(text) : null;
  const [state, setState] = React.useState<{ q: string | null; data: HubSearchResult | null; loading: boolean }>({ q: null, data: null, loading: false });
  React.useEffect(() => {
    if (!q) return setState({ q: null, data: null, loading: false });
    const hit = searchCache.get(q);
    if (hit) return setState({ q, data: hit, loading: false });
    let cancelled = false;
    setState((st) => ({ q, data: st.data, loading: true }));
    const t = setTimeout(async () => {
      try {
        const r = await api.get<HubSearchResult>(`/api/custom-apps/image/search?q=${encodeURIComponent(q)}`);
        if (!r.error) searchCache.set(q, r);
        if (!cancelled) setState({ q, data: r, loading: false });
      } catch (e) {
        if (!cancelled) setState({ q, data: { query: q, results: [], error: e instanceof Error ? e.message : "Search didn't answer." }, loading: false });
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);
  return state;
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

interface Props {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  error?: string | null;
  autoFocus?: boolean;
  lookup: ImageLookupState;
  /** Under the status line (what Gluon will set up from the image). */
  children?: React.ReactNode;
}

/**
 * The image to run. Typing a name searches Docker Hub; the tag picker lists every tag, page by
 * page, as soon as the name is valid (it doesn't wait for the full lookup).
 */
export function ImageField({ value, onChange, label = "Image", error, autoFocus, lookup, children }: Props) {
  const localErr = value.trim() ? imageError(value) : null;
  const shownError = error ?? localErr;
  const { result, loading } = lookup;
  const [focused, setFocused] = React.useState(false);
  // Searches even when the field isn't focused, so the best match can be offered after leaving it;
  // the popup itself only shows while typing.
  const search = useHubSearch(value, !!value.trim());
  const results = search.data?.results ?? [];
  const tag = value.includes("@") ? null : parseImage(value || "x").tag;
  const canTag = !!value.trim() && !localErr && !value.includes("$") && !isLocalImage(value);

  let status: React.ReactNode = null;
  if (!shownError && value.trim() && !value.includes("$")) {
    if (loading) status = <StateLine state="starting" size={12} label="Checking" />;
    else if (lookup.error)
      status = (
        <span>
          Gluon couldn&apos;t check it: {lookup.error}{" "}
          <button type="button" className={s.link} onClick={lookup.retry}>
            Check again
          </button>
        </span>
      );
    else if (result?.exists === true)
      status = (
        <>
          <StateLine state="running" size={12} label={result.local ? "On this server" : `Found on ${registryName(value)}`} />
          {!tag && !isLocalImage(value) && <span>No tag given, so it&apos;s latest.</span>}
          {result.unknownReason && <span>{result.unknownReason}</span>}
        </>
      );
    else if (result?.exists === null && result.unknownReason)
      status = (
        <span>
          {result.unknownReason} It can still be used.{" "}
          <button type="button" className={s.link} onClick={lookup.retry}>
            Check again
          </button>
        </span>
      );
  }
  // A bare word is usually a search, not a full image name: say nothing while the person is still
  // picking from the list, and afterwards offer the best match instead of a dead end.
  const bare = /^[a-z0-9-]+$/.test(value.trim());
  const searching = focused && results.length > 0;
  const best = bare ? results.find((r) => r.ref.split("/").pop() === value.trim()) ?? results[0] : undefined;
  const missing = !shownError && !searching && result?.exists === false;
  const notFound = missing && !best ? (result.unknownReason ?? "That image doesn't exist.") + (bare ? " Images from people (not Docker) include their name, like linuxserver/jellyfin." : "") : null;
  if (missing && best)
    status = (
      <span>
        There&apos;s no official image called {value.trim()}.{" "}
        <button type="button" className={s.link} onClick={() => onChange(best.ref)}>
          Use {best.ref}
        </button>
      </span>
    );

  return (
    <div className={s.imageField}>
      <Field label={label} error={shownError ?? notFound}>
        <div className={s.pathField}>
          <Autocomplete.Root
            items={results}
            value={value}
            onValueChange={(v) => onChange(v)}
            itemToStringValue={(r: HubRepo) => r.ref}
            filter={null}
            openOnInputClick={false}
          >
            <Autocomplete.Input
              className={`${field.input} ${field.mono}`}
              placeholder="jellyfin, or linuxserver/jellyfin:latest"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              autoFocus={autoFocus}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />
            <Autocomplete.Portal hidden={!focused || (!results.length && !search.data?.error)}>
              <Autocomplete.Positioner className={popup.positioner} sideOffset={6} align="start" collisionPadding={8}>
                <Autocomplete.Popup className={`${popup.popup} ${s.searchPopup}`} aria-busy={search.loading || undefined} data-motion-gentle="">
                  <Autocomplete.Status className={s.searchStatus}>{search.data?.error ?? (results.length ? `${results.length} on Docker Hub` : null)}</Autocomplete.Status>
                  <Autocomplete.List>
                    {(r: HubRepo) => (
                      <Autocomplete.Item key={r.ref} value={r} className={`${popup.item} ${s.searchItem}`}>
                        <span className={s.searchMain}>
                          <span className={s.searchRef}>{r.ref}</span>
                          {r.description && <span className={s.searchDesc}>{r.description}</span>}
                        </span>
                        <span className={`${s.searchMeta} num`}>
                          {r.official ? "Official · " : ""}
                          {compact.format(r.pulls)} pulls
                        </span>
                      </Autocomplete.Item>
                    )}
                  </Autocomplete.List>
                </Autocomplete.Popup>
              </Autocomplete.Positioner>
            </Autocomplete.Portal>
          </Autocomplete.Root>
          {/* Its own field context, so the label stays on the image input. */}
          <BaseField.Root className={s.tagField}>
            <TagPicker image={value} disabled={!canTag} current={tag} onPick={(t) => onChange(withTag(value, t))} />
          </BaseField.Root>
        </div>
      </Field>
      {status && <div className={s.imageStatus}>{status}</div>}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- tags

/** Every tag of an image, newest first, searchable, a page at a time. */
function TagPicker({ image, current, disabled, onPick }: { image: string; current: string | null; disabled: boolean; onPick: (tag: string) => void }) {
  const fmt = useFormat();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [pages, setPages] = React.useState<TagPage[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const base = image.trim().split("@")[0]!.replace(/:[^/:]*$/, "");
  const seq = React.useRef(0);

  const load = React.useCallback(
    async (page: number, query: string) => {
      const id = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const r = await api.get<TagPage>(`/api/custom-apps/image/tags?ref=${encodeURIComponent(base)}&q=${encodeURIComponent(query)}&page=${page}`);
        if (id !== seq.current) return;
        setPages((p) => (page === 1 ? [r] : [...p, r]));
        if (r.error) setError(r.error);
      } catch (e) {
        if (id === seq.current) setError(e instanceof Error ? e.message : "The tags didn't load.");
      } finally {
        if (id === seq.current) setLoading(false);
      }
    },
    [base],
  );

  // A new image starts over; a new filter waits for typing to settle.
  React.useEffect(() => {
    setPages([]);
    setQ("");
  }, [base]);
  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void load(1, q), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [open, q, load]);

  const tags: TagInfo[] = pages.flatMap((p) => p.tags);
  const last = pages[pages.length - 1];
  const names = tags.map((t) => t.name);
  const info = new Map(tags.map((t) => [t.name, t]));

  return (
    <Combobox.Root
      items={names}
      value={current}
      onValueChange={(v) => {
        if (typeof v === "string" && v) onPick(v);
      }}
      inputValue={q}
      onInputValueChange={setQ}
      filter={null}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      <Combobox.Trigger className={s.tagTrigger} aria-label={current ? `Tag: ${current}. Choose another` : "Choose a tag"}>
        <span className={s.tagValue} title={current ?? "latest"}>{current ?? "latest"}</span>
        <NavArrowDown strokeWidth={2} />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner className={popup.positioner} sideOffset={6} align="end" collisionPadding={8}>
          <Combobox.Popup className={`${popup.popup} ${s.tagPopup}`} aria-label="Tags" data-motion-gentle="">
            <Combobox.Input className={`${field.input} ${field.mono} ${s.tagSearch}`} placeholder="Find a tag, like 10.11" spellCheck={false} autoCapitalize="off" />
            <Combobox.Status className={s.searchStatus}>
              {error ? error : loading && !tags.length ? "Loading tags…" : !tags.length && last ? (q ? `No tags match “${q}”.` : "This image has no tags.") : null}
            </Combobox.Status>
            <Combobox.List className={s.tagList}>
              {(name: string) => {
                const t = info.get(name);
                return (
                  <Combobox.Item key={name} value={name} className={`${popup.item} ${s.tagItem}`}>
                    <Combobox.ItemIndicator className={s.tagCheck}>
                      <Check strokeWidth={2.2} />
                    </Combobox.ItemIndicator>
                    <span className={s.tagName} title={name}>{name}</span>
                    <span className={`${s.searchMeta} num`}>
                      {t?.size ? fmt.bytes(t.size) : null}
                      {t?.size && t.updated ? " · " : null}
                      {t?.updated ? <Time ts={t.updated} /> : null}
                    </span>
                  </Combobox.Item>
                );
              }}
            </Combobox.List>
            {last?.next && (
              <button type="button" className={s.moreTags} disabled={loading} onClick={() => void load(last.page + 1, q)}>
                {loading ? "Loading…" : "Show more tags"}
              </button>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
