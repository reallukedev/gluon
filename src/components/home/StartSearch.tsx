"use client";
import * as React from "react";
import { Search } from "iconoir-react";
import { SEARCH_ENGINES } from "@/lib/prefs";
import { usePrefs } from "@/components/PrefsProvider";
import { useApi } from "@/lib/client/api";
import { AppIcon } from "@/components/apps/AppIcon";
import type { HomeApp } from "./widgets/core";
import { useSmartUrl } from "./widgets/core";
import s from "./home.module.css";

/**
 * The start page's search: type to jump to an app, press Enter to search the web with your engine.
 * (⌘K still searches everything inside Gluon.)
 */
export function StartSearch() {
  const { prefs } = usePrefs();
  const url = useSmartUrl();
  const { data: apps } = useApi<HomeApp[]>("/api/apps");
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(-1);
  const [open, setOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();
  const [narrow, setNarrow] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(max-width: 520px)");
    setNarrow(mq.matches);
    const h = () => setNarrow(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);

  const engine = prefs.searchEngine === "custom" ? { name: "the web", url: prefs.searchCustomUrl || SEARCH_ENGINES.duckduckgo.url } : SEARCH_ENGINES[prefs.searchEngine];

  // "/" focuses the search on the home page.
  React.useEffect(() => {
    if (!prefs.shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) {
        e.preventDefault();
        e.stopImmediatePropagation();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [prefs.shortcuts]);

  const term = q.trim().toLowerCase();
  const matches = term
    ? (apps ?? []).filter((a) => (a.urls.home || a.urls.away) && (a.name.toLowerCase().includes(term) || a.id.toLowerCase().includes(term))).slice(0, 5)
    : [];
  const showList = open && term.length > 0;
  const target = prefs.openLinks === "new" ? "_blank" : "_self";

  function go(i: number) {
    const app = matches[i];
    if (app) {
      const href = url(app.urls);
      if (href) window.open(href, target, "noopener,noreferrer");
      return;
    }
    if (!term) return;
    const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(q.trim()) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(q.trim());
    const dest = looksLikeUrl ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(q.trim()) ? q.trim() : `https://${q.trim()}`) : engine.url.replace("%s", encodeURIComponent(q.trim()));
    window.open(dest, target, "noopener,noreferrer");
  }

  return (
    <form
      className={s.search}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        go(active);
      }}
    >
      <Search className={s.searchIcon} aria-hidden />
      <input
        ref={inputRef}
        className={s.searchInput}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(matches.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(-1, a - 1));
          } else if (e.key === "Escape") {
            setQ("");
            inputRef.current?.blur();
          }
        }}
        placeholder={narrow ? "Search or open an app" : `Search ${engine.name} or open an app`}
        aria-label={`Search ${engine.name} or open an app`}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
      />
      {prefs.shortcuts && !q && <kbd className={s.searchKbd}>/</kbd>}
      {showList && (
        <ul className={s.suggest} role="listbox" id={listId}>
          {matches.map((a, i) => (
            <li
              key={a.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={s.suggestItem}
              onMouseDown={(e) => {
                e.preventDefault();
                go(i);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <AppIcon src={a.icon} name={a.name} size={24} />
              <span>Open {a.name}</span>
            </li>
          ))}
          <li
            role="option"
            id={`${listId}-web`}
            aria-selected={active === -1}
            className={s.suggestItem}
            onMouseDown={(e) => {
              e.preventDefault();
              go(-1);
            }}
            onMouseEnter={() => setActive(-1)}
          >
            <span className={s.suggestIcon}>
              <Search />
            </span>
            <span>
              Search {engine.name} for “{q.trim()}”
            </span>
          </li>
        </ul>
      )}
    </form>
  );
}
