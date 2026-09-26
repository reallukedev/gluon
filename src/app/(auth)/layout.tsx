import { getSetting } from "@/server/settings";
import s from "./auth.module.css";

// Decorative spectrum: fixed pattern, reveals nothing about the server before sign-in.
const PATTERN = ["", "", "dash", "", "", "", "short", "", "", "sodium", "", "", "dash", "", ""];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const name = getSetting("serverName");
  return (
    <div className={s.frame}>
      <aside className={s.plate} aria-hidden>
        <div className={s.brand}>
          <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 3v16M8.5 7v12M17.5 3v16" />
            <path d="M12.5 3v16" stroke="var(--attn)" />
          </svg>
          Gluon
        </div>
        <div className={s.lines}>
          {PATTERN.map((k, i) => (
            <i key={i} data-k={k} />
          ))}
        </div>
        <div className={s.name}>
          <h1>{name}</h1>
          <p>Apps, files and health for the server at home.</p>
        </div>
      </aside>
      <main className={s.main}>{children}</main>
    </div>
  );
}
