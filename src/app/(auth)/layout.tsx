import { getSetting } from "@/server/settings";
import { BondField } from "@/components/brand/BondField";
import { GluonMark } from "@/components/brand/GluonMark";
import s from "./auth.module.css";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const name = getSetting("serverName");
  return (
    <div className={s.frame}>
      <aside className={s.plate} aria-hidden>
        <div className={s.brand}>
          <GluonMark />
          Gluon
        </div>
        <BondField className={s.lines} />
        <div className={s.name}>
          <div className={s.plateName}>{name}</div>
          <p>Apps, files and health for the server at home.</p>
        </div>
      </aside>
      <main className={s.main}>{children}</main>
    </div>
  );
}
