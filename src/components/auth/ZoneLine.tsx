import * as React from "react";
import s from "./parts.module.css";

/**
 * Where this browser is connecting from, drawn as the path it takes: this device, a solid wire over
 * the home network or a dashed one across the internet, then the server. Sign-in rules differ by
 * that path, so it is shown before anyone is surprised by it.
 */
export function ZoneLine({ zone, serverName, children }: { zone: "home" | "away"; serverName: string; children?: React.ReactNode }) {
  const label = zone === "home" ? "Home network" : "Internet";
  return (
    <div className={s.zone} data-zone={zone}>
      <div className={s.zoneTrack} role="img" aria-label={zone === "home" ? `This device is on the home network with ${serverName}.` : `This device is reaching ${serverName} over the internet.`}>
        <span className={s.zoneNode}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
            <rect x="2.5" y="3" width="11" height="7.5" rx="1.2" />
            <path d="M6 13.5h4M8 10.5v3" />
          </svg>
          This device
        </span>
        <span className={s.zoneWire} aria-hidden>
          <span className={s.zoneWireLabel}>{label}</span>
        </span>
        <span className={s.zoneNode}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
            <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
            <rect x="2.5" y="9" width="11" height="4.5" rx="1" />
            <path d="M5 4.75h1.5M5 11.25h1.5" strokeLinecap="round" />
          </svg>
          {serverName}
        </span>
      </div>
      {children && <p className={s.zoneText}>{children}</p>}
    </div>
  );
}
