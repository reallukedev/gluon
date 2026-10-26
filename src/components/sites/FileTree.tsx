"use client";
import * as React from "react";
import { Folder, Page, MediaImage, CodeBrackets, NavArrowRight, MoreHoriz, PagePlus, FolderPlus, Upload, EditPencil, ArrowRight, Download, Trash, Archive } from "iconoir-react";
import { IconButton } from "@/components/ui/Button";
import { Menu, ContextMenu, type MenuEntry } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Surface";
import { extOf, type SiteFile, type SiteTree } from "@/lib/sites-types";
import e from "./editor.module.css";

interface Node {
  name: string;
  path: string;
  dir: boolean;
  file?: SiteFile;
  children: Node[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function build(tree: SiteTree): Node[] {
  const root: Node = { name: "", path: "", dir: true, children: [] };
  const dirs = new Map<string, Node>([["", root]]);
  const dirFor = (p: string): Node => {
    const hit = dirs.get(p);
    if (hit) return hit;
    const i = p.lastIndexOf("/");
    const parent = dirFor(i < 0 ? "" : p.slice(0, i));
    const n: Node = { name: p.slice(i + 1), path: p, dir: true, children: [] };
    parent.children.push(n);
    dirs.set(p, n);
    return n;
  };
  for (const d of tree.dirs) dirFor(d);
  for (const f of tree.files) {
    const i = f.path.lastIndexOf("/");
    dirFor(i < 0 ? "" : f.path.slice(0, i)).children.push({ name: f.path.slice(i + 1), path: f.path, dir: false, file: f, children: [] });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => Number(b.dir) - Number(a.dir) || collator.compare(a.name, b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function FileIcon({ node }: { node: Node }) {
  if (node.dir) return <Folder />;
  const x = extOf(node.path);
  if (node.file?.kind === "image") return <MediaImage />;
  if (["css", "js", "mjs", "cjs", "json", "webmanifest", "map"].includes(x)) return <CodeBrackets />;
  return <Page />;
}

export type TreeAction =
  | { kind: "new-file"; dir: string }
  | { kind: "new-folder"; dir: string }
  | { kind: "upload"; dir: string; what: "files" | "folder" | "zip" }
  | { kind: "rename"; path: string; dir: boolean }
  | { kind: "move"; path: string; dir: boolean }
  | { kind: "delete"; path: string; dir: boolean }
  | { kind: "download"; path: string };

interface Props {
  tree: SiteTree | undefined;
  selected: string | null;
  /** Files with edits that aren't saved. */
  dirty: ReadonlySet<string>;
  onOpen: (path: string) => void;
  onAction: (a: TreeAction) => void;
  onDrop: (dir: string, dt: DataTransfer) => void;
  /** Shown under the files while uploads run. */
  footer?: React.ReactNode;
  /** A folder to open (with the folders above it), e.g. where files were just uploaded. */
  reveal?: { path: string } | null;
}

export const uploadEntries = (dir: string, onAction: (a: TreeAction) => void): MenuEntry[] => [
  { label: "Upload files", icon: <Upload />, onSelect: () => onAction({ kind: "upload", dir, what: "files" }) },
  { label: "Upload a folder", icon: <Folder />, onSelect: () => onAction({ kind: "upload", dir, what: "folder" }) },
  { label: "Unpack a .zip here", icon: <Archive />, onSelect: () => onAction({ kind: "upload", dir, what: "zip" }) },
];

/** The draft's files. Folders open in place; every row has its actions on a menu, a right-click and a long press. */
export function FileTree({ tree, selected, dirty, onOpen, onAction, onDrop, footer, reveal }: Props) {
  const nodes = React.useMemo(() => (tree ? build(tree) : null), [tree]);
  const [open, setOpen] = React.useState<Set<string>>(() => new Set());
  const [over, setOver] = React.useState<string | null>(null);

  // The open file's folders stay open, and so does a folder something was just put in.
  React.useEffect(() => {
    if (reveal) setOpen((cur) => new Set([...cur, ...reveal.path.split("/").map((_, i, a) => a.slice(0, i + 1).join("/"))]));
  }, [reveal]);
  React.useEffect(() => {
    if (!selected?.includes("/")) return;
    const parts = selected.split("/").slice(0, -1);
    setOpen((cur) => {
      const next = new Set(cur);
      parts.forEach((_, i) => next.add(parts.slice(0, i + 1).join("/")));
      return next.size === cur.size ? cur : next;
    });
  }, [selected]);

  const toggle = (p: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const dropProps = (dir: string) => ({
    onDragOver: (ev: React.DragEvent) => {
      if (![...ev.dataTransfer.types].includes("Files")) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = "copy";
      setOver(dir);
    },
    onDragLeave: (ev: React.DragEvent) => {
      if (!(ev.currentTarget as HTMLElement).contains(ev.relatedTarget as globalThis.Node | null)) setOver((o) => (o === dir ? null : o));
    },
    onDrop: (ev: React.DragEvent) => {
      if (![...ev.dataTransfer.types].includes("Files")) return;
      ev.preventDefault();
      ev.stopPropagation();
      setOver(null);
      onDrop(dir, ev.dataTransfer);
    },
  });

  const items = (n: Node): MenuEntry[] =>
    n.dir
      ? [
          { label: "New file here", icon: <PagePlus />, onSelect: () => onAction({ kind: "new-file", dir: n.path }) },
          { label: "New folder here", icon: <FolderPlus />, onSelect: () => onAction({ kind: "new-folder", dir: n.path }) },
          ...uploadEntries(n.path, onAction),
          "separator",
          { label: "Rename", icon: <EditPencil />, onSelect: () => onAction({ kind: "rename", path: n.path, dir: true }) },
          { label: "Move to…", icon: <ArrowRight />, onSelect: () => onAction({ kind: "move", path: n.path, dir: true }) },
          "separator",
          { label: "Delete folder", icon: <Trash />, danger: true, onSelect: () => onAction({ kind: "delete", path: n.path, dir: true }) },
        ]
      : [
          { label: "Rename", icon: <EditPencil />, onSelect: () => onAction({ kind: "rename", path: n.path, dir: false }) },
          { label: "Move to…", icon: <ArrowRight />, onSelect: () => onAction({ kind: "move", path: n.path, dir: false }) },
          { label: "Download", icon: <Download />, onSelect: () => onAction({ kind: "download", path: n.path }) },
          "separator",
          { label: "Delete", icon: <Trash />, danger: true, onSelect: () => onAction({ kind: "delete", path: n.path, dir: false }) },
        ];

  const render = (list: Node[], depth: number): React.ReactNode => (
    <ul role={depth ? "group" : undefined} className={e.treeList}>
      {list.map((n) => {
        const isOpen = open.has(n.path);
        return (
          <li key={n.path} {...(n.dir ? dropProps(n.path) : {})}>
            <ContextMenu items={items(n)}>
              <div className={e.node} data-selected={selected === n.path ? "" : undefined} data-over={n.dir && over === n.path ? "" : undefined} style={{ "--depth": depth } as React.CSSProperties}>
                <button
                  type="button"
                  className={e.nodeBtn}
                  aria-expanded={n.dir ? isOpen : undefined}
                  aria-current={selected === n.path ? "true" : undefined}
                  onClick={() => (n.dir ? toggle(n.path) : onOpen(n.path))}
                  title={n.path}
                >
                  {n.dir ? <NavArrowRight className={e.caret} data-open={isOpen ? "" : undefined} aria-hidden /> : <span className={e.caretSpace} aria-hidden />}
                  <span className={e.nodeIcon} aria-hidden>
                    <FileIcon node={n} />
                  </span>
                  <span className={e.nodeName}>{n.name}</span>
                  {dirty.has(n.path) && (
                    <span className={e.unsaved} title="Not saved">
                      <span className="sr-only">, not saved</span>
                    </span>
                  )}
                </button>
                <Menu
                  trigger={
                    <IconButton label={`${n.name} actions`} size="sm" className={e.nodeMenu} tooltip={false}>
                      <MoreHoriz />
                    </IconButton>
                  }
                  items={items(n)}
                />
              </div>
            </ContextMenu>
            {n.dir && isOpen && (n.children.length ? render(n.children, depth + 1) : <p className={e.emptyFolder} style={{ "--depth": depth + 1 } as React.CSSProperties}>Empty folder</p>)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className={e.tree} data-over={over === "" ? "" : undefined} {...dropProps("")}>
      {!nodes ? (
        <div className={e.treePad}>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} height={14} width={`${70 - i * 8}%`} style={{ margin: "9px 0" }} />
          ))}
        </div>
      ) : nodes.length ? (
        <nav aria-label="Site files">{render(nodes, 0)}</nav>
      ) : (
        <p className={e.treeEmpty}>No files yet. Make one, or drop files and folders here.</p>
      )}
      {footer}
    </div>
  );
}
