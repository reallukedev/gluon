"use client";
import * as React from "react";
import s from "./markdown.module.css";

/**
 * A small, safe Markdown reader for READMEs and notes: headings, paragraphs, lists (with task
 * boxes), quotes, code blocks, tables, rules, and inline code, emphasis and links. It builds React
 * elements (never HTML strings), so nothing in a file can run in the page. Links open only
 * http(s) and mailto addresses, in a new tab. Anything it doesn't know stays as plain text.
 */
export function Markdown({ source }: { source: string }) {
  const blocks = React.useMemo(() => parse(source.replace(/\r\n?/g, "\n")), [source]);
  return <div className={s.md}>{blocks}</div>;
}

type Node = React.ReactNode;

function parse(src: string): Node[] {
  const lines = src.split("\n");
  const out: Node[] = [];
  let i = 0;
  let key = 0;
  const k = () => key++;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    // Fenced code
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      const close = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(close)) body.push(lines[i++]!);
      i++;
      out.push(
        <pre key={k()} className={s.pre} data-lang={fence[2] || undefined}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    // Heading
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const level = Math.min(h[1]!.length, 4);
      const Tag = `h${level + 1}` as "h2";
      out.push(<Tag key={k()}>{inline(h[2]!)}</Tag>);
      i++;
      continue;
    }
    // Rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={k()} />);
      i++;
      continue;
    }
    // Quote
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={k()}>{parse(body.join("\n"))}</blockquote>);
      continue;
    }
    // Table: a header row, then a |---|---| row
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
      const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : undefined));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push(
        <div key={k()} className={s.tableWrap}>
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} style={{ textAlign: align[j] }}>
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j} style={{ textAlign: align[j] }}>
                      {inline(r[j] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    // Lists
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const indent = li[1]!.length;
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m && m[1]!.length <= indent + 1 && /\d/.test(m[2]!) === ordered) {
          items.push([m[3]!]);
          i++;
        } else if (items.length && (l.startsWith(" ".repeat(indent + 2)) || (l.trim() && /^\s+/.test(l) && !m))) {
          items[items.length - 1]!.push(l.slice(Math.min(indent + 2, l.length - l.trimStart().length)));
          i++;
        } else if (items.length && !l.trim() && i + 1 < lines.length && /^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i + 1]!)) {
          i++;
        } else break;
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={k()}>
          {items.map((body, j) => {
            const task = body[0]!.match(/^\[([ xX])\]\s+(.*)$/);
            const first = task ? task[2]! : body[0]!;
            const rest = body.slice(1).join("\n");
            return (
              <li key={j} data-task={task ? "" : undefined}>
                {task && <input type="checkbox" checked={task[1] !== " "} readOnly disabled aria-label={task[1] !== " " ? "Done" : "Not done"} />}
                {inline(first)}
                {rest.trim() && parse(rest)}
              </li>
            );
          })}
        </List>,
      );
      continue;
    }
    // Paragraph: until a blank line or another block starts
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*(#{1,6}\s|```|~~~|>|([-*+]|\d+[.)])\s+)/.test(lines[i]!)) para.push(lines[i++]!);
    if (!para.length) para.push(lines[i++]!);
    out.push(<p key={k()}>{inline(para.join("\n"))}</p>);
  }
  return out;
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Inline code, links, images (as links), bold, italic, strikethrough and hard breaks. */
function inline(text: string): Node[] {
  const out: Node[] = [];
  let rest = text;
  let key = 0;
  const re = /(`+)([\s\S]*?[^`])\1(?!`)|!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|(?<![\w])_([^_\s][^_]*)_(?![\w])|~~([^~]+)~~|(https?:\/\/[^\s<)]+)|( {2,}|\\)\n/;
  while (rest) {
    const m = rest.match(re);
    if (!m || m.index === undefined) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const [all, , code, label, href, auto, b1, b2, i1, i2, strike, bare] = m;
    if (code !== undefined) out.push(<code key={key++}>{code.trim()}</code>);
    else if (href !== undefined) out.push(link(href, label || href, key++));
    else if (auto !== undefined) out.push(link(auto, auto, key++));
    else if (b1 !== undefined || b2 !== undefined) out.push(<strong key={key++}>{inline(b1 ?? b2!)}</strong>);
    else if (i1 !== undefined || i2 !== undefined) out.push(<em key={key++}>{inline(i1 ?? i2!)}</em>);
    else if (strike !== undefined) out.push(<del key={key++}>{inline(strike)}</del>);
    else if (bare !== undefined) out.push(link(bare, bare, key++));
    else out.push(<br key={key++} />);
    rest = rest.slice(m.index + all.length);
  }
  return out;
}

function link(href: string, label: string, key: number): Node {
  if (!SAFE_URL.test(href)) return <span key={key}>{label}</span>;
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
      {label}
    </a>
  );
}
