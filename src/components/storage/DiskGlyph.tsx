import * as React from "react";

export type GlyphMedia = "hdd" | "ssd" | "nvme" | "flash" | "card" | "unknown";

/**
 * A disk drawn as the object it is, in the iconoir line weight: a hard drive shows its platter and
 * arm, an SSD its chips, an NVMe stick its long board, a USB stick its plug, a card its clipped
 * corner. Same 24px grid and 1.5 stroke as the rest of the icons, so it sits in any icon slot.
 */
export function DiskGlyph({ media, className, size }: { media: GlyphMedia | null | undefined; className?: string; size?: number }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    width: size,
    height: size,
    "aria-hidden": true,
  };
  switch (media) {
    case "hdd":
      return (
        <svg {...common}>
          <rect x="4" y="2.75" width="16" height="18.5" rx="2.5" />
          <circle cx="12" cy="10" r="4.25" />
          <circle cx="12" cy="10" r="0.5" fill="currentColor" />
          <path d="M8.5 17.75h7" />
        </svg>
      );
    case "ssd":
      return (
        <svg {...common}>
          <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
          <rect x="6.2" y="8" width="4.8" height="6.5" rx="0.6" />
          <rect x="13" y="8" width="4.8" height="6.5" rx="0.6" />
          <path d="M6.5 17h11" strokeDasharray="1 1.6" />
        </svg>
      );
    case "nvme":
      return (
        <svg {...common}>
          <rect x="2" y="8" width="20" height="8" rx="1.2" />
          <path d="M5 8v8" />
          <rect x="8" y="10" width="4" height="4" rx="0.4" />
          <rect x="14" y="10" width="4" height="4" rx="0.4" />
        </svg>
      );
    case "flash":
      return (
        <svg {...common}>
          <rect x="8" y="7.5" width="13.5" height="9" rx="1.8" />
          <path d="M8 9.5H3.5v5H8" />
          <path d="M5 11.2v1.6" />
        </svg>
      );
    case "card":
      return (
        <svg {...common}>
          <path d="M9 3h9.5A1.5 1.5 0 0 1 20 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5V8z" />
          <path d="M10 3v3.5M13 3v3.5M16 3v3.5" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="3" y="6" width="18" height="12" rx="2.2" />
          <path d="M3 13.5h18" />
          <path d="M16.5 16h1" />
        </svg>
      );
  }
}
