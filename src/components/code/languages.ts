import type { Extension } from "@codemirror/state";
import { StreamLanguage, type StreamParser } from "@codemirror/language";

/** Languages the editor can highlight. Each loads on demand so the editor itself stays small. */
export type CodeLanguage =
  | "yaml" | "json" | "markdown" | "ini" | "sh" | "toml" | "dockerfile" | "python" | "javascript" | "typescript"
  | "css" | "xml" | "html" | "sql" | "lua" | "go" | "ruby" | "diff" | "nginx" | "caddyfile" | "text";

const legacy = (p: Promise<StreamParser<unknown>>) => p.then((m) => StreamLanguage.define(m));

export async function loadLanguage(lang: string | null | undefined): Promise<Extension | null> {
  switch (lang) {
    case "yaml": return (await import("@codemirror/lang-yaml")).yaml();
    case "json": return (await import("@codemirror/lang-json")).json();
    case "markdown": return (await import("@codemirror/lang-markdown")).markdown();
    case "ini": return legacy(import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties));
    case "sh": return legacy(import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell));
    case "toml": return legacy(import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml));
    case "dockerfile": return legacy(import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile));
    case "python": return legacy(import("@codemirror/legacy-modes/mode/python").then((m) => m.python));
    case "javascript": return legacy(import("@codemirror/legacy-modes/mode/javascript").then((m) => m.javascript));
    case "typescript": return legacy(import("@codemirror/legacy-modes/mode/javascript").then((m) => m.typescript));
    case "css": return legacy(import("@codemirror/legacy-modes/mode/css").then((m) => m.css));
    case "xml": return legacy(import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml));
    case "html": return legacy(import("@codemirror/legacy-modes/mode/xml").then((m) => m.html));
    case "sql": return legacy(import("@codemirror/legacy-modes/mode/sql").then((m) => m.standardSQL));
    case "lua": return legacy(import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua));
    case "go": return legacy(import("@codemirror/legacy-modes/mode/go").then((m) => m.go));
    case "ruby": return legacy(import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby));
    case "diff": return legacy(import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff));
    // Caddyfiles read close enough to nginx blocks for braces, comments and strings.
    case "nginx": case "caddyfile": return legacy(import("@codemirror/legacy-modes/mode/nginx").then((m) => m.nginx));
    default: return null;
  }
}
