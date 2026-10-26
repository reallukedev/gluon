"use client";
import * as React from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, indentOnInput, bracketMatching, foldGutter } from "@codemirror/language";
import { editorHighlight, editorTheme } from "@/components/code/CodeEditor";
import { loadLanguage } from "@/components/code/languages";
import type { SiteLanguage } from "@/lib/sites-types";
import e from "./editor.module.css";

/** Real HTML (closing tags as you type), CSS and JavaScript modes; the rest borrow Gluon's shared loaders. */
async function language(lang: SiteLanguage): Promise<Extension | null> {
  switch (lang) {
    case "html":
      return (await import("@codemirror/lang-html")).html({ autoCloseTags: true });
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "json":
    case "markdown":
    case "xml":
      return loadLanguage(lang);
    default:
      return null;
  }
}

interface Props {
  /** Changing it starts a fresh editor with `value` (new undo history). Change it to replace the text. */
  docKey: string;
  value: string;
  language: SiteLanguage;
  label: string;
  onChange: (v: string) => void;
  onSave: () => void;
}

/**
 * The site's code editor. ⌘S / Ctrl+S saves from inside it; the page handles the same keys when
 * focus is elsewhere. Colours come from Gluon's tokens, so it follows light and dark.
 */
export function CodePane({ docKey, value, language: lang, label, onChange, onSave }: Props) {
  const host = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<EditorView | null>(null);
  const cb = React.useRef({ onChange, onSave });
  cb.current = { onChange, onSave };
  // Read when an editor is made; while one is open it owns the text.
  const latest = React.useRef(value);
  latest.current = value;

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded = await language(lang).catch(() => null);
      if (cancelled || !host.current) return;
      const state = EditorState.create({
        doc: latest.current,
        extensions: [
          lineNumbers(),
          foldGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          highlightSelectionMatches(),
          syntaxHighlighting(editorHighlight),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave(), true) },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          editorTheme,
          ...(loaded ? [loaded] : []),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": label, autocapitalize: "off", autocorrect: "off", spellcheck: "false" }),
          EditorState.tabSize.of(2),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
        ],
      });
      view.current = new EditorView({ state, parent: host.current });
    })();
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = null;
    };
    // A new document (another file, or the same one reloaded) gets a new editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, lang]);

  return <div ref={host} className={e.code} />;
}
