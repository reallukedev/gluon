"use client";
import * as React from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching, foldGutter } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { unifiedMergeView } from "@codemirror/merge";
import { loadLanguage, type CodeLanguage } from "./languages";
import s from "./code.module.css";

/** Colours come from Gluon's tokens, so the editor follows light/dark. Shared with the app builder's YAML editor. */
export const editorTheme = EditorView.theme({
  "&": { color: "var(--ink)", backgroundColor: "var(--panel)", fontSize: "12.75px", height: "100%" },
  ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--ink)", padding: "10px 0" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-gutters": { backgroundColor: "var(--panel-2)", color: "var(--faint)", border: "none", borderRight: "1px solid var(--line)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--ink) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink-2)" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklab, var(--ink) 16%, transparent) !important" },
  ".cm-cursor": { borderLeftColor: "var(--ink)", borderLeftWidth: "2px" },
  // Sodium means "needs you", so search hits are an ink wash like the selection.
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--ink) 14%, transparent)" },
  ".cm-panels": { backgroundColor: "var(--panel-2)", color: "var(--ink)", borderTop: "1px solid var(--line)" },
  ".cm-panels input, .cm-panels button": { fontFamily: "var(--font-sans)", fontSize: "13px" },
  ".cm-changedLine": { backgroundColor: "color-mix(in oklab, var(--ok) 12%, transparent) !important" },
  ".cm-deletedChunk": { backgroundColor: "color-mix(in oklab, var(--fault) 10%, transparent)" },
  ".cm-insertedLine": { backgroundColor: "color-mix(in oklab, var(--ok) 12%, transparent)" },
  ".cm-changedText": { background: "color-mix(in oklab, var(--ok) 30%, transparent)" },
});

export const editorHighlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--ink)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "var(--info)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--ok)" },
  { tag: [t.comment, t.lineComment], color: "var(--muted)", fontStyle: "italic" },
  // Red stays reserved for faults, so keywords get weight rather than colour.
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--ink)", fontWeight: "600" },
  { tag: [t.typeName, t.labelName, t.className, t.tagName], color: "var(--info)", fontWeight: "600" },
  { tag: [t.special(t.variableName), t.variableName, t.attributeName], color: "var(--ink-2)" },
  { tag: t.heading, color: "var(--ink)", fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: [t.link, t.url], color: "var(--info)", textDecoration: "underline" },
  { tag: t.inserted, color: "var(--ok)" },
  { tag: t.deleted, color: "var(--fault)" },
  { tag: [t.punctuation, t.separator, t.bracket], color: "var(--faint)" },
  { tag: t.meta, color: "var(--muted)" },
]);

export interface CodeEditorProps {
  value: string;
  onChange?: (v: string) => void;
  language?: CodeLanguage;
  readOnly?: boolean;
  /** Show a diff against this text (unified, inline). */
  original?: string;
  height?: number | string;
  label: string;
}

export function CodeEditor({ value, onChange, language = "text", readOnly, original, height = 480, label }: CodeEditorProps) {
  const host = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<EditorView | null>(null);
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const lang: Extension[] = [];
      const loaded = await loadLanguage(language).catch(() => null);
      if (loaded) lang.push(loaded);
      if (cancelled || !host.current) return;
      const state = EditorState.create({
        doc: value,
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
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          editorTheme,
          ...lang,
          EditorState.readOnly.of(!!readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorState.tabSize.of(2),
          ...(original !== undefined ? [unifiedMergeView({ original, mergeControls: false, highlightChanges: true, gutter: true })] : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
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
    // Recreate only when the mode changes; value changes flow through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly, original]);

  // External value changes (load, restore backup) replace the document.
  React.useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className={s.editor} style={{ height }} />;
}
