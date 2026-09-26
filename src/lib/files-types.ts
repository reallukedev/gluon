/**
 * Types shared between the Files API (src/app/api/files/**) and the client.
 * No server imports here.
 */

export type Access = "read" | "write";

/** Coarse bucket for icons, filters and sorting. */
export type FileKind = "folder" | "image" | "video" | "audio" | "document" | "archive" | "text" | "disk-image" | "other";

/** How the client can show the file inline. null = download only. */
export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | null;

export type EntryType = "file" | "dir" | "symlink" | "other";

export interface LinkInfo {
  /** The link text exactly as stored (may be relative). */
  target: string;
  /** Absolute host path it points at after resolving every link, or null when broken. */
  resolved: string | null;
  /** What the link ends at. */
  type: "file" | "dir" | "other" | null;
  broken: boolean;
  /** Points outside the folders this person can open (members only; always false for admins). */
  outside: boolean;
}

export interface FileEntry {
  name: string;
  /** Absolute host path as the person navigated to it (links in the path are kept). */
  path: string;
  type: EntryType;
  link: LinkInfo | null;
  /** Bytes for files (and for links, the target's size). null for folders. */
  size: number | null;
  /** Epoch ms. */
  mtime: number;
  /** "drwxr-xr-x" */
  mode: string;
  /** Permission bits, e.g. 0o755 → 493. */
  perms: number;
  uid: number;
  gid: number;
  owner: string | null;
  group: string | null;
  hidden: boolean;
  kind: FileKind;
  mime: string | null;
  preview: PreviewKind;
  /** Cached folder size (see GET /api/files/size), when one has been calculated. */
  dirSize: { bytes: number; computedAt: number } | null;
  /** Folders only: pinned by the current person. */
  pinned: { id: string; label: string } | null;
}

export interface FilesystemInfo {
  mount: string;
  device: string;
  fstype: string;
  size: number;
  used: number;
  avail: number;
  readOnly: boolean;
}

export type SortKey = "name" | "size" | "mtime" | "kind" | "type";

export interface Listing {
  path: string;
  /** The same folder with every link resolved. */
  real: string;
  name: string;
  /** Parent folder the person may open, or null at the top of what they can see. */
  parent: string | null;
  breadcrumbs: { name: string; path: string }[];
  access: Access;
  self: FileEntry;
  entries: FileEntry[];
  /** Entries after the hidden/filter options, before paging. */
  total: number;
  offset: number;
  limit: number;
  counts: { dirs: number; files: number; links: number; other: number; hidden: number };
  sort: SortKey;
  order: "asc" | "desc";
  /** The folder was too large to sort by size/date; it is sorted by name instead. */
  sortLimited: boolean;
  /** More entries exist than Gluon reads in one go (250,000); only the first ones are listed. */
  truncated: boolean;
  fs: FilesystemInfo | null;
  /** Mutations here are refused (system folder); the message says why. */
  protectedReason: string | null;
}

export interface PlaceApp {
  id: string;
  name: string;
  icon: string | null;
}

/** Which group of the Places rail a place belongs to. */
export type PlaceSection = "drives" | "homes" | "apps" | "shared" | "pins" | "recent";

export type PlaceMedia = "hdd" | "ssd" | "nvme" | "flash" | "card" | "unknown";

export interface Place {
  id: string;
  /** Human name: "2.0 TB hard drive", "Luke", "media". */
  label: string;
  path: string;
  kind: "root" | "drive" | "data" | "home" | "media" | "grant" | "pin" | "recent";
  section?: PlaceSection;
  access: Access;
  /** Second line in plain words: the drive's model, "Part of the 256 GB SSD", "Home folder". */
  detail?: string | null;
  /** Drives: what kind of disk holds it, for its glyph. */
  media?: PlaceMedia | null;
  /** Present for drives/mount points. */
  fs?: FilesystemInfo | null;
  /** For media and app folders found from containers: the apps that keep files there. */
  apps?: PlaceApp[];
  /** Pinned by the current person. */
  pinned?: { id: string } | null;
  /** Folder no longer exists / is not mounted. */
  missing?: boolean;
}

export interface Places {
  places: Place[];
  pins: Place[];
  recent: Place[];
  admin: boolean;
}

export interface TextFile {
  path: string;
  size: number;
  mtime: number;
  encoding: "utf-8" | "utf-16le" | "utf-16be" | "latin1" | "binary";
  /** Only the first 1 MB is included. */
  truncated: boolean;
  content: string | null;
  /** Safe to edit and save in the browser (small, UTF-8, writable, not a system file). */
  editable: boolean;
  /** Why it isn't editable, in plain words. */
  readOnlyReason: string | null;
  /** Hint for syntax highlighting: yaml, json, sh, ini, md, … */
  language: string | null;
}

export interface ZipEstimate {
  token: string;
  name: string;
  bytes: number;
  files: number;
  dirs: number;
  /** Counting stopped early (very large tree); the numbers are a lower bound. */
  partial: boolean;
  /** Plain-language warning for very large downloads, or null. */
  warning: string | null;
}

export type ConflictPolicy = "rename" | "overwrite" | "skip";

export interface UploadSession {
  id: string;
  dir: string;
  name: string;
  size: number;
  received: number;
  conflict: ConflictPolicy;
  status: "open" | "completing" | "done" | "failed" | "cancelled" | "expired" | "skipped";
  finalPath: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  /** Suggested chunk size in bytes. */
  chunkSize: number;
}

export type JobKind = "copy" | "move" | "extract" | "chown" | "chown-undo" | "delete-forever";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobProgress {
  /** Items (files) done / total; total null while counting. */
  done: number;
  total: number | null;
  bytesDone: number;
  bytesTotal: number | null;
  /** Path currently being worked on. */
  current: string | null;
  /** Plain-language phase: "Counting files", "Copying", "Removing originals"… */
  phase: string;
}

export interface FileJob {
  id: string;
  kind: JobKind;
  status: JobStatus;
  title: string;
  userId: string | null;
  username: string | null;
  progress: JobProgress;
  /** Plain-language outcome when finished. */
  message: string | null;
  error: string | null;
  /** Kind-specific result (e.g. created paths, skipped items). */
  result: Record<string, unknown> | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface TrashItem {
  id: string;
  name: string;
  originalPath: string;
  trashPath: string;
  fsRoot: string;
  size: number | null;
  isDir: boolean;
  deletedAt: number;
  deletedBy: string | null;
  deletedByName: string | null;
  /** The item is still on disk (false if someone removed it by hand). */
  present: boolean;
  /** Something now exists at the original path. */
  originalTaken: boolean;
}

export interface TrashSummary {
  items: TrashItem[];
  /** Bytes held per filesystem mount root. */
  byFilesystem: { fsRoot: string; bytes: number; items: number }[];
}

export interface FolderSize {
  path: string;
  bytes: number | null;
  computedAt: number | null;
  tookMs: number | null;
  running: boolean;
  /** Some sub-folders couldn't be read, so the number is a lower bound. */
  partial: boolean;
  /** Sizes of the immediate sub-folders, from the same calculation. */
  children: { name: string; path: string; bytes: number }[];
  error: string | null;
}

export interface AppUse {
  appId: string;
  appName: string;
  icon: string | null;
  container: string;
  containerState: string;
  /** Host folder the container mounts. */
  source: string;
  /** Where it appears inside the container. */
  destination: string;
  /** Where *this* folder appears inside the container (when this folder is inside the mount). */
  containerPath: string | null;
  rw: boolean;
  /** "this" = exactly this folder; "within" = this folder is inside the mount; "below" = a sub-folder of this is mounted. */
  relation: "this" | "within" | "below";
  runsAs: RunsAs | null;
}

export interface RunsAs {
  uid: number;
  gid: number;
  user: string | null;
  group: string | null;
  /** Where it came from: "PUID/PGID", "user: 1000:1000", "root (default)". */
  source: string;
  root: boolean;
}

export interface OwnershipPreview {
  path: string;
  app: { id: string; name: string } | null;
  target: RunsAs;
  total: number;
  toChange: number;
  byOwner: { uid: number; gid: number; user: string | null; group: string | null; count: number }[];
  samples: { path: string; type: "file" | "dir" | "symlink" | "other"; user: string | null; group: string | null }[];
  /** Counting stopped early (timeout). */
  partial: boolean;
  /** Human sentence summarising what will happen. */
  summary: string;
}

export interface SearchHit {
  path: string;
  name: string;
  type: EntryType;
  size: number | null;
  mtime: number;
  kind: FileKind;
}
