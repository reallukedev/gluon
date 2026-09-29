"use client";
import * as React from "react";
import { NavArrowDown } from "iconoir-react";
import { api } from "@/lib/client/api";
import { imageError, isLocalImage, parseImage } from "@/lib/builder/names";
import type { ImageLookup } from "@/lib/builder-types";
import { Field, Input } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { Button } from "@/components/ui/Button";
import { StateLine } from "@/components/ui/StateLine";
import s from "./builder.module.css";

/**
 * An image reference with a live check: is it on this server, does the registry have it, which
 * tags are recent. The lookup waits for typing to settle and never blocks editing.
 */
export function useImageLookup(ref: string) {
  const [result, setResult] = React.useState<ImageLookup | null>(null);
  const [loading, setLoading] = React.useState(false);
  const clean = ref.trim();
  React.useEffect(() => {
    setResult(null);
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
      } catch {
        if (!cancelled) setResult(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [clean]);
  return { result, loading };
}

export function registryName(ref: string) {
  const r = parseImage(ref).registry;
  return r === "docker.io" ? "Docker Hub" : r === "ghcr.io" ? "GitHub's registry" : r === "lscr.io" ? "LinuxServer's registry" : r === "quay.io" ? "Quay" : r;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  error?: string | null;
  id?: string;
  autoFocus?: boolean;
  lookup: { result: ImageLookup | null; loading: boolean };
  /** Extra line under the status (e.g. "Use its ports and folders"). */
  children?: React.ReactNode;
}

export function ImageField({ value, onChange, label = "Image", error, autoFocus, lookup, children }: Props) {
  const localErr = value.trim() ? imageError(value) : null;
  const shownError = error ?? localErr;
  const { result, loading } = lookup;
  const tag = value.includes("@") ? null : parseImage(value || "x").tag;
  const withTag = (t: string) => {
    const at = value.lastIndexOf(":");
    const slash = value.lastIndexOf("/");
    const base = at > slash ? value.slice(0, at) : value;
    return `${base.trim()}:${t}`;
  };

  let status: React.ReactNode = null;
  if (!shownError && value.trim() && !value.includes("$")) {
    if (loading) status = <StateLine state="starting" size={12} label="Checking" />;
    else if (result?.exists === true) {
      status = (
        <>
          <StateLine state="running" size={12} label={result.local ? "On this server" : `Found on ${registryName(value)}`} />
          {!tag && !isLocalImage(value) && <span>No tag given, so it's latest.</span>}
          {result.unknownReason && <span>{result.unknownReason}</span>}
        </>
      );
    } else if (result?.exists === false) status = null;
    else if (result?.unknownReason) status = <span>{result.unknownReason}</span>;
  }
  const notFound = !shownError && result?.exists === false ? result.unknownReason ?? "That image doesn't exist." : null;

  return (
    <div className={s.stack} style={{ gap: 6 }}>
      <Field label={label} error={shownError ?? notFound}>
        <div className={s.pathField}>
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            mono
            placeholder="linuxserver/jellyfin:latest"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            autoFocus={autoFocus}
          />
          {result && result.tags.length > 0 && (
            <Menu
              trigger={
                <Button iconEnd={<NavArrowDown />} aria-label="Choose a tag">
                  Tags
                </Button>
              }
              items={[{ kind: "label", label: "Recent tags" }, ...result.tags.slice(0, 20).map((t) => ({ label: t, onSelect: () => onChange(withTag(t)) }))]}
            />
          )}
        </div>
      </Field>
      {status && <div className={s.imageStatus}>{status}</div>}
      {children}
    </div>
  );
}
