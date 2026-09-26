/**
 * Storage types shared by the server (src/server/storage) and the Storage UI.
 * No server imports here.
 */

// ---------------------------------------------------------------- inventory

export type DiskMedia = "hdd" | "ssd" | "nvme" | "flash" | "card" | "unknown";

export type DiskState =
  /** Linux runs from it (/, /boot, /var, swap or Docker's storage live here). */
  | "system"
  /** Something on it is mounted, used as swap or held by LVM/RAID/encryption. */
  | "in-use"
  /** Has partitions or a filesystem, but nothing on it is in use. */
  | "unused"
  /** No partition table and no filesystem: a blank disk. */
  | "empty"
  /** A reader or bay with nothing inserted. */
  | "no-media";

export type VolumeRole = "filesystem" | "swap" | "lvm-member" | "raid-member" | "encrypted" | "bios-boot" | "unformatted" | "other";

export interface MountView {
  target: string;
  /** "/" for a normal mount; the sub-folder for a bind mount of part of the filesystem. */
  fsroot: string;
  /** True for bind mounts (a second view of a filesystem that is mounted elsewhere). */
  bind: boolean;
  options: string[];
  readOnly: boolean;
}

export interface FsUsageView {
  size: number;
  used: number;
  avail: number;
  pct: number;
}

export type PersistState =
  /** /etc/fstab (or a systemd mount unit) mounts it here at boot. */
  | "persistent"
  /** Mounted by hand: gone after a restart. */
  | "missing"
  /** /etc/fstab mounts it, but somewhere else. */
  | "different-target"
  /** /etc/fstab mounts a different filesystem at this place. */
  | "conflict";

export interface Persistence {
  state: PersistState;
  via: "fstab" | "systemd" | null;
  /** 1-based line in /etc/fstab. */
  line: number | null;
  entry: string | null;
  matchedBy: FstabSourceKind | null;
  /** Matched by /dev/sdX name, which can change between boots. */
  fragile: boolean;
  /** Where fstab would mount it (for different-target). */
  fstabTarget: string | null;
}

export interface VolumeUser {
  appId: string;
  app: string;
  container: string;
  running: boolean;
  /** Host path the container uses. */
  source: string;
  destination: string;
}

export interface VolumeView {
  name: string;
  path: string;
  majMin: string;
  kind: "disk" | "part" | "lvm" | "crypt" | "raid" | "loop" | "other";
  size: number;
  partNumber: number | null;
  partLabel: string | null;
  partType: string | null;
  fstype: string | null;
  fsVersion: string | null;
  label: string | null;
  uuid: string | null;
  partUuid: string | null;
  role: VolumeRole;
  mounts: MountView[];
  /** The main (non-bind) mount point, if mounted. */
  primaryMount: string | null;
  swapActive: boolean;
  usage: FsUsageView | null;
  /** Only for mounted filesystems. */
  persistence: Persistence | null;
  /** 1-based /etc/fstab lines that refer to this volume. */
  fstabLines: number[];
  /** Device is write-protected. */
  deviceReadOnly: boolean;
  /** Mounted read-only right now. */
  mountedReadOnly: boolean;
  system: boolean;
  usedBy: VolumeUser[];
  children: VolumeView[];
}

export interface DiskView {
  /** Stable id (serial or WWN), used in URLs. Falls back to the kernel name. */
  id: string;
  name: string;
  path: string;
  byId: string | null;
  model: string | null;
  vendor: string | null;
  serial: string | null;
  wwn: string | null;
  size: number;
  media: DiskMedia;
  rotational: boolean;
  transport: string | null;
  removable: boolean;
  hotplug: boolean;
  mediaPresent: boolean;
  readOnly: boolean;
  partitionTable: string | null;
  system: boolean;
  systemReason: string | null;
  state: DiskState;
  /** "1.5 TB hard drive" */
  title: string;
  /** Plain-language one-liner: "Mounted at /mnt/hdd2 · 2% used". */
  summary: string;
  /** A filesystem written directly on the disk (no partitions). */
  wholeDisk: VolumeView | null;
  partitions: VolumeView[];
  /** Bytes not covered by any partition (only when meaningful). */
  unallocated: number;
  usage: { size: number; used: number; avail: number } | null;
  inFstab: boolean;
  smart: SmartSummary | null;
}

export type FstabSourceKind = "uuid" | "label" | "partuuid" | "partlabel" | "device" | "link" | "path" | "network" | "none";

export interface FstabEntryView {
  line: number;
  text: string;
  spec: string;
  target: string;
  fstype: string;
  options: string[];
  dump: number;
  pass: number;
  sourceKind: FstabSourceKind;
  bind: boolean;
  swap: boolean;
  nofail: boolean;
  /** The device it refers to is connected (null when not applicable: binds, network). */
  present: boolean | null;
  device: string | null;
  mounted: boolean;
  issues: string[];
}

export interface FstabBackup {
  path: string;
  at: number;
  size: number;
}

export interface FstabView {
  entries: FstabEntryView[];
  backups: FstabBackup[];
}

export interface Inventory {
  disks: DiskView[];
  fstab: FstabView;
  generatedAt: number;
  smartCheckedAt: number | null;
  /** Non-fatal problems gathering the inventory (a command missing, a timeout). */
  warnings: string[];
}

// ---------------------------------------------------------------- SMART

export type SmartState = "ok" | "warning" | "failing" | "asleep" | "unavailable" | "unknown";

export interface SmartAttribute {
  id: number;
  name: string;
  value: number | null;
  worst: number | null;
  thresh: number | null;
  raw: string;
  prefailure: boolean;
  whenFailed: string;
}

export interface SmartSummary {
  state: SmartState;
  checkedAt: number;
  /** When real values were last read (the disk may be asleep now). */
  readAt: number | null;
  passed: boolean | null;
  temperature: number | null;
  /** Highest temperature the drive is rated to operate at, when it reports one. */
  tempLimit: number | null;
  powerOnHours: number | null;
  powerCycles: number | null;
  reallocated: number | null;
  pending: number | null;
  uncorrectable: number | null;
  reallocatedRising: boolean;
  /** % of rated write endurance used (SSD / NVMe). */
  wearPercent: number | null;
  nvme: { criticalWarning: number; availableSpare: number | null; availableSpareThreshold: number | null; mediaErrors: number | null; unsafeShutdowns: number | null } | null;
  lastSelfTest: { type: string; status: string; passed: boolean | null; lifetimeHours: number | null } | null;
  /** In smartctl's drive database: attribute names/meanings are known. */
  known: boolean;
  /** Plain sentences explaining anything notable. */
  notes: string[];
  /** Why SMART couldn't be read (state = unavailable). */
  message: string | null;
}

export interface SmartDetail {
  summary: SmartSummary | null;
  attributes: SmartAttribute[];
  firmware: string | null;
  history: { at: number; temperature: number | null; reallocated: number | null; pending: number | null }[];
}

// ---------------------------------------------------------------- holders

export interface Holder {
  kind: "process" | "container" | "swap" | "loop" | "mount";
  /** Plain sentence: "Immich (immich-server) uses /mnt/hdd2/photos". */
  label: string;
  pid?: number;
  command?: string;
  user?: string;
  container?: { id: string; name: string; appId: string | null };
  paths?: string[];
}

// ---------------------------------------------------------------- plans

export interface LineChange {
  line: number;
  before: string;
  after: string;
}

export interface RenamePlan {
  /** Echo this back when executing; if anything changed in between, you're asked to review again. */
  hash: string;
  from: string;
  to: string;
  device: string;
  uuid: string | null;
  fstype: string;
  diskTitle: string;
  symlink: boolean;
  persist: boolean;
  apps: {
    id: string;
    name: string;
    mode: "compose" | "containers";
    willStop: boolean;
    restartServices: string[];
    containers: { name: string; running: boolean; paths: { source: string; destination: string }[] }[];
  }[];
  files: { path: string; kind: "compose" | "env"; apps: string[]; changes: LineChange[]; untouched: { line: number; text: string }[] }[];
  fstab: { action: "update" | "add" | "none"; line: number | null; before: string | null; after: string | null };
  gluonRefs: { folderGrants: number; pins: number; trash: number };
  holders: Holder[];
  warnings: string[];
  blockers: string[];
  steps: string[];
}

export interface SetupPlan {
  hash: string;
  disk: { id: string; name: string; path: string; title: string; model: string | null; serial: string | null; size: number };
  /** What the person must type to confirm (the serial number, or the device name if it has none). */
  confirmWith: string;
  erases: { name: string; size: number; fstype: string | null; label: string | null; used: number | null }[];
  label: string;
  mountPath: string;
  fstabLine: string;
  fstabRemovals: { line: number; text: string }[];
  warnings: string[];
  blockers: string[];
  steps: string[];
}

export interface MountPlan {
  device: string;
  target: string;
  fstype: string | null;
  fstabLine: string | null;
  warnings: string[];
  blockers: string[];
}

export interface UnmountPlan {
  target: string;
  device: string;
  holders: Holder[];
  fstabLine: { line: number; text: string } | null;
  warnings: string[];
  blockers: string[];
}

export interface PersistPlan {
  items: { target: string; device: string; action: "add" | "update" | "replace-conflict"; line: number | null; before: string | null; after: string }[];
  skipped: { target: string; reason: string }[];
}

// ---------------------------------------------------------------- jobs

export type JobKind = "rename" | "setup" | "usage" | "cleanup" | "mount" | "unmount" | "persist";
export type JobStatus = "running" | "done" | "failed" | "rolled-back" | "interrupted" | "cancelled";
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "undone" | "undo-failed";

export interface JobStep {
  id: string;
  label: string;
  status: StepStatus;
  /** Undo steps are added (after the step that failed) when a change is rolled back. */
  undo: boolean;
  detail: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface StorageJob {
  id: string;
  kind: JobKind;
  target: string | null;
  title: string;
  status: JobStatus;
  steps: JobStep[];
  progress: { done: number; total: number } | null;
  /** Kind-specific result (UsageResult for usage jobs). */
  result: unknown;
  /** Plain-language outcome when it didn't succeed. */
  error: string | null;
  username: string | null;
  startedAt: number;
  finishedAt: number | null;
}

// ---------------------------------------------------------------- usage breakdown

export interface UsageEntry {
  name: string;
  path: string;
  bytes: number;
  dir: boolean;
  /** This child is a different filesystem (another drive) and wasn't counted. */
  mountpoint: boolean;
}

export interface UsageChildren {
  entries: UsageEntry[];
  otherBytes: number;
  otherCount: number;
}

export interface UsageResult {
  path: string;
  total: number;
  entries: UsageEntry[];
  /** One level deeper, for the biggest folders (keyed by their path), so the map can nest and drill without waiting. */
  children?: Record<string, UsageChildren>;
  /** Everything beyond the top entries, summed. */
  otherBytes: number;
  otherCount: number;
  /** Items du couldn't read. */
  unreadable: number;
  filesystem: { mount: string; size: number; used: number; avail: number } | null;
  scannedAt: number;
  durationMs: number;
}

// ---------------------------------------------------------------- cleanup

export interface DockerUsage {
  images: { count: number; bytes: number; reclaimable: number };
  containers: { count: number; bytes: number; reclaimable: number };
  volumes: { count: number; bytes: number; reclaimable: number };
  buildCache: { count: number; bytes: number; reclaimable: number };
}

export interface CleanupPreview {
  apt: { bytes: number; files: number };
  journal: { bytes: number; suggestedKeep: number };
  docker: {
    usage: DockerUsage;
    danglingImages: { id: string; bytes: number; created: number }[];
    buildCache: { bytes: number; entries: number };
    stoppedContainers: { id: string; name: string; app: string | null; image: string; status: string; bytes: number }[];
    unusedVolumes: { name: string; bytes: number | null; app: string | null; anonymous: boolean; created: string | null }[];
  } | null;
  /** Old copies of Docker's storage left behind after a move (handled by the storage.removeLeftovers fix). */
  leftovers: { paths: string[]; bytes: number; /** Bytes per path. */ sizes?: Record<string, number>; action: "storage.removeLeftovers" } | null;
  /** Docker's storage folder on the host, links followed (for the Space map). */
  dockerRoot?: string | null;
  warnings: string[];
}
