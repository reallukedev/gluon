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

function hourIn(timeZone: string | undefined) {
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(new Date()));
}

export function Greeting() {
  const { prefs, viewer, timeZone, serverName } = usePrefs();
  // With the time zone known (it rides in a cookie), the server already renders the right greeting, so nothing swaps in.
  const [hour, setHour] = React.useState<number | null>(() => (timeZone ? hourIn(timeZone) : null));
  React.useEffect(() => {
    const read = () => setHour(hourIn(timeZone));
    read();
    const t = setInterval(read, 60_000);
    return () => clearInterval(t);
  }, [timeZone]);
  const name = prefs.greetingName.trim() || viewer.displayName.split(" ")[0];
  if (!prefs.greeting) return <h2 className={s.greeting}>{serverName}</h2>;
  return (
    <h2 className={s.greeting} suppressHydrationWarning>
      {hour === null ? "Hello" : partOfDay(hour)}, {name}.
    </h2>
  );
}
