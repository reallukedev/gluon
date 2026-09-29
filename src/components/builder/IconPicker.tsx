"use client";
import * as React from "react";
import { Upload, Link as LinkIcon, Trash } from "iconoir-react";
import { AppIcon } from "@/components/apps/AppIcon";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { iconError, MAX_ICON_BYTES } from "@/lib/builder/names";
import s from "./builder.module.css";

/**
 * The app's icon: upload an image (scaled to 256 px and kept inside the app, so Umbrel shows it
 * without fetching anything), or point at an https address. SVGs are kept as they are.
 */
export function IconPicker({ value, name, onChange, suggestions = [] }: { value: string | null; name: string; onChange: (v: string | null) => void; suggestions?: { label: string; value: string }[] }) {
  const file = React.useRef<HTMLInputElement>(null);
  const [mode, setMode] = React.useState<"idle" | "url">("idle");
  const [url, setUrl] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function pick(f: File) {
    setError(null);
    if (!/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(f.type)) return setError("Choose a PNG, JPEG, WebP, GIF or SVG image.");
    setBusy(true);
    try {
      if (f.type === "image/svg+xml") {
        if (f.size > MAX_ICON_BYTES) return setError("That SVG is over 256 KB. Use a smaller one.");
        const text = await f.text();
        onChange(`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`);
        return;
      }
      if (f.size > 20 * 1024 * 1024) return setError("That image is too big to use as an icon.");
      const bmp = await createImageBitmap(f);
      const size = 256;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      // Fit inside the square, centred, keeping transparency.
      const scale = Math.min(size / bmp.width, size / bmp.height);
      const w = bmp.width * scale;
      const h = bmp.height * scale;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h);
      const data = canvas.toDataURL("image/png");
      if (data.length > MAX_ICON_BYTES * 1.37) return setError("That image stays too large after scaling. Try a simpler one.");
      onChange(data);
    } catch {
      setError("Gluon couldn't read that image.");
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  function useUrl() {
    const v = url.trim();
    const e = iconError(v);
    if (e || !v) return setError(e ?? "Enter the icon's address.");
    setError(null);
    onChange(v);
    setMode("idle");
    setUrl("");
  }

  return (
    <div className={s.iconPicker}>
      <div className={s.iconPreview}>
        <AppIcon src={value} name={name || "App"} size={64} />
      </div>
      <div className={s.iconControls}>
        <div className={s.iconButtons}>
          <Button size="sm" icon={<Upload />} loading={busy} onClick={() => file.current?.click()}>
            Upload
          </Button>
          <Button size="sm" icon={<LinkIcon />} onClick={() => setMode(mode === "url" ? "idle" : "url")} aria-expanded={mode === "url"}>
            Use an address
          </Button>
          {suggestions.map((sg) => (
            <Button key={sg.value} size="sm" variant="ghost" onClick={() => onChange(sg.value)} disabled={value === sg.value}>
              {sg.label}
            </Button>
          ))}
          {value && (
            <Button size="sm" variant="ghost" icon={<Trash />} onClick={() => onChange(null)}>
              Remove
            </Button>
          )}
        </div>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
        {mode === "url" && (
          <div className={s.pathField}>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/icon.png"
              aria-label="Icon address"
              mono
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  useUrl();
                }
                if (e.key === "Escape") setMode("idle");
              }}
            />
            <Button onClick={useUrl}>Use</Button>
          </div>
        )}
        {error ? (
          <p className={s.note} data-level="error" role="alert">
            {error}
          </p>
        ) : (
          <p className={s.hint}>{value ? (value.startsWith("data:") ? "Kept inside the app, so it shows up even offline." : "Umbrel loads it from that address.") : "Without one, Umbrel shows the app's first letter."}</p>
        )}
      </div>
    </div>
  );
}
