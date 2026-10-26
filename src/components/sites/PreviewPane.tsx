"use client";
import * as React from "react";
import { Refresh, OpenNewWindow } from "iconoir-react";
import { api } from "@/lib/client/api";
import { IconButton } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Notice, Skeleton } from "@/components/ui/Surface";
import type { SitePreview } from "@/lib/sites-types";
import e from "./editor.module.css";

/** The sandbox the frame gets. The server sends the same one as a header, so opening a page on its own is no different. */
export const FRAME_SANDBOX = "allow-scripts allow-forms allow-popups";

/** A preview link for the draft, renewed before it runs out. */
export function usePreview(siteId: string) {
  const [preview, setPreview] = React.useState<SitePreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const get = React.useCallback(async () => {
    try {
      const p = await api.post<SitePreview>(`/api/sites/${siteId}/preview`, {});
      setPreview(p);
      setError(null);
      return p;
    } catch (err) {
      setError(err instanceof Error ? err.message : "The preview isn't available.");
      return null;
    }
  }, [siteId]);
  React.useEffect(() => {
    void get();
  }, [get]);
  // Renew ten minutes before the hour is up.
  React.useEffect(() => {
    if (!preview) return;
    const t = setTimeout(() => void get(), Math.max(60_000, preview.expiresAt - Date.now() - 10 * 60_000));
    return () => clearTimeout(t);
  }, [preview, get]);
  return { preview, error, renew: get };
}

interface Props {
  preview: SitePreview | null;
  error: string | null;
  page: string;
  pages: string[];
  onPage: (p: string) => void;
  /** Bumped after every save, which reloads the frame. */
  nonce: number;
  onReload: () => void;
}

const pageUrl = (p: SitePreview, page: string) => `${p.base}/${page.split("/").map(encodeURIComponent).join("/")}`;

/**
 * The draft as visitors will see it, in a sandboxed frame: its scripts run, but with no origin of
 * their own they can't read Gluon's cookies, call its API or move this page.
 */
export function PreviewPane({ preview, error, page, pages, onPage, nonce, onReload }: Props) {
  const [width, setWidth] = React.useState<"full" | "phone">("full");
  const [loaded, setLoaded] = React.useState(false);
  const src = preview ? `${pageUrl(preview, page)}${nonce ? `?r=${nonce}` : ""}` : null;
  // The placeholder shows while a different page loads, not on every reload after a save.
  const shown = preview ? pageUrl(preview, page) : null;
  React.useEffect(() => setLoaded(false), [shown]);
  const options = (pages.includes(page) ? pages : [page, ...pages]).map((p) => ({ value: p, label: p }));

  return (
    <div className={e.preview}>
      <div className={e.paneBar}>
        <div className={e.pageSelect}>
          <Select value={page} onChange={onPage} options={options} aria-label="Page to preview" />
        </div>
        <span className={e.widthSwitch}>
        <Segmented
          value={width}
          onChange={setWidth}
          aria-label="Preview width"
          options={[
            { value: "full", label: "Full" },
            { value: "phone", label: "Phone" },
          ]}
        />
        </span>
        <IconButton label="Reload the preview" size="sm" onClick={onReload} disabled={!preview}>
          <Refresh />
        </IconButton>
        {preview ? (
          <a className={e.barLink} href={pageUrl(preview, page)} target="_blank" rel="noopener noreferrer" aria-label="Open the preview in a new tab" title="Open the preview in a new tab">
            <OpenNewWindow />
          </a>
        ) : null}
      </div>
      <div className={e.stage} data-width={width}>
        {error ? (
          <div className={e.stagePad}>
            <Notice tone="fault" title="The preview isn't available">
              {error}
            </Notice>
          </div>
        ) : src ? (
          <>
            {!loaded && <Skeleton height="100%" radius={0} style={{ position: "absolute", inset: 0 }} />}
            <iframe title={`Preview of ${page}`} src={src} sandbox={FRAME_SANDBOX} referrerPolicy="no-referrer" className={e.frame} onLoad={() => setLoaded(true)} />
          </>
        ) : (
          <Skeleton height="100%" radius={0} />
        )}
      </div>
    </div>
  );
}
