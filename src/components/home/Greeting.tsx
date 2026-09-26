"use client";
import * as React from "react";
import { usePrefs } from "@/components/PrefsProvider";
import s from "./home.module.css";

function partOfDay(h: number) {
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function Greeting() {
  const { prefs, viewer, timeZone, serverName } = usePrefs();
  const [hour, setHour] = React.useState<number | null>(null);
  React.useEffect(() => {
    const read = () => setHour(Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(new Date())));
    read();
    const t = setInterval(read, 60_000);
    return () => clearInterval(t);
  }, [timeZone]);
  const name = prefs.greetingName.trim() || viewer.displayName.split(" ")[0];
  if (!prefs.greeting) return <h1 className={s.greeting}>{serverName}</h1>;
  return (
    <h1 className={s.greeting} suppressHydrationWarning>
      {hour === null ? "Hello" : partOfDay(hour)}, {name}.
    </h1>
  );
}
