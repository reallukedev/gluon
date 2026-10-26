"use client";
import type { ITheme } from "@xterm/xterm";

/**
 * xterm.js draws on a canvas, so it needs real colours rather than CSS variables. Read Gluon's
 * tokens (and the ANSI colours derived from them in terminal.module.css) as the browser resolves
 * them, then turn each into hex through a 1px canvas, which also flattens color-mix() and oklab.
 */
function toHex(css: string, ctx: CanvasRenderingContext2D): string {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "#000";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`;
}

const SLOTS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

export function readTheme(scope: HTMLElement): { theme: ITheme; fontFamily: string } {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  scope.appendChild(probe);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const read = (value: string) => {
    probe.style.color = "";
    probe.style.color = value;
    return toHex(getComputedStyle(probe).color, ctx);
  };
  const theme: ITheme = {
    background: read("var(--term-bg)"),
    foreground: read("var(--ink)"),
    cursor: read("var(--ink)"),
    cursorAccent: read("var(--term-bg)"),
    selectionBackground: read("color-mix(in oklab, var(--ink) 22%, var(--term-bg))"),
    selectionInactiveBackground: read("color-mix(in oklab, var(--ink) 12%, var(--term-bg))"),
    scrollbarSliderBackground: read("var(--line-strong)"),
    scrollbarSliderHoverBackground: read("var(--faint)"),
    scrollbarSliderActiveBackground: read("var(--muted)"),
  };
  SLOTS.forEach((name, i) => {
    (theme as Record<string, string>)[name] = read(`var(--ansi-${i})`);
    (theme as Record<string, string>)[`bright${name[0]!.toUpperCase()}${name.slice(1)}`] = read(`var(--ansi-${i + 8})`);
  });
  probe.style.fontFamily = "var(--font-mono)";
  const fontFamily = getComputedStyle(probe).fontFamily || "ui-monospace, Menlo, monospace";
  probe.remove();
  return { theme, fontFamily };
}
