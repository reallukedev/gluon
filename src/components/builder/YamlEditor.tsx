"use client";
import * as React from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, indentOnInput, bracketMatching, foldGutter } from "@codemirror/language";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { unifiedMergeView } from "@codemirror/merge";
import type { Issue } from "@/lib/builder-types";
import { editorHighlight, editorTheme } from "@/components/code/CodeEditor";
import s from "@/components/code/code.module.css";
import b from "./builder.module.css";

/**
 * The compose editor: CodeEditor's theme and highlighting plus what the builder needs on top,
 * problems drawn on their lines and a handle to jump to a line from the problem list.
 */
const lintTheme = EditorView.theme({
  // Errors get a red underline and a diamond in the gutter (red always has a glyph); warnings an ink-2 one.
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--fault)", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline dotted var(--ink-2)", textUnderlineOffset: "3px" },
  ".cm-lintRange-info": { backgroundImage: "none" },
  ".cm-lint-marker": { width: "7px", height: "7px", content: "none" },
  ".cm-lint-marker-error": { content: "none", background: "var(--fault)", transform: "rotate(45deg)", width: "6px", height: "6px", margin: "5px 0 0 3px" },
  ".cm-lint-marker-warning": { content: "none", background: "var(--ink-2)", width: "2px", height: "11px", margin: "3px 0 0 5px" },
  ".cm-lint-marker-info": { content: "none", background: "var(--faint)", width: "2px", height: "11px", margin: "3px 0 0 5px" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: "8px", boxShadow: "var(--shadow-pop)" },
  ".cm-diagnostic": { fontFamily: "var(--font-sans)", fontSize: "13px", padding: "6px 10px", borderLeft: "2px solid var(--ink-2)" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--fault)" },
  ".cm-gutter-lint": { width: "14px" },
});

export interface YamlEditorHandle {
  gotoLine: (line: number) => void;
  focus: () => void;
}

interface Props {
  value: string;
  onChange?: (v: string) => void;
  issues?: Issue[];
  readOnly?: boolean;
  /** Show changes against this text. */
  original?: string;
  height?: number | string;
  label: string;
  placeholder?: string;
}

export function YamlEditor({ ref, value, onChange, issues, readOnly, original, height = 520, label }: Props & { ref?: React.Ref<YamlEditorHandle> }) {
  const host = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<EditorView | null>(null);
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  const issuesRef = React.useRef(issues);
  issuesRef.current = issues;

  React.useImperativeHandle(ref, () => ({
    gotoLine(line: number) {
      const v = view.current;
      if (!v) return;
      const l = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)));
      v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
      v.focus();
    },
    focus: () => view.current?.focus(),
  }));

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const lang: Extension[] = [];
      const yaml = await import("@codemirror/lang-yaml").then((m) => m.yaml()).catch(() => null);
      if (yaml) lang.push(yaml);
      if (cancelled || !host.current) return;
      const state = EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          lintGutter(),
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
          lintTheme,
          ...lang,
          EditorState.readOnly.of(!!readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
          EditorState.tabSize.of(2),
          ...(original !== undefined ? [unifiedMergeView({ original, mergeControls: false, highlightChanges: true, gutter: true })] : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      });
      view.current = new EditorView({ state, parent: host.current });
      applyDiagnostics(view.current, issuesRef.current);
    })();
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, original]);

  React.useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  React.useEffect(() => {
    if (view.current) applyDiagnostics(view.current, issues);
  }, [issues]);

  return <div ref={host} className={`${s.editor} ${b.yamlHost}`} style={{ "--editor-height": typeof height === "number" ? `${height}px` : height } as React.CSSProperties} />;
}

function applyDiagnostics(v: EditorView, issues: Issue[] | undefined) {
  const doc = v.state.doc;
  const diags: Diagnostic[] = [];
  for (const i of issues ?? []) {
    if (!i.line || i.line > doc.lines) continue;
    const l = doc.line(i.line);
    const text = l.text;
    const start = l.from + (text.length - text.trimStart().length);
    diags.push({ from: start, to: Math.max(start, l.to), severity: i.level === "error" ? "error" : i.level === "warning" ? "warning" : "info", message: i.message.replace(/^Line \d+: /, "") });
  }
  v.dispatch(setDiagnostics(v.state, diags));
}
