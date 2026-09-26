/**
 * People & household: accounts, invites, app visibility, folder grants, problem reports,
 * announcements and the activity feed. Shared by server and client. No server imports.
 */

export type Role = "admin" | "member";

export interface PersonView {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  /** Two-step verification is on. */
  mfa: boolean;
  disabled: boolean;
  /** Must pick a new password at next sign-in (set by an admin password reset). */
  mustChangePassword: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  /** Most recent activity on any session. */
  lastSeenAt: number | null;
  /** Signed-in devices. */
  sessions: number;
  /** Apps granted individually (on top of household apps). Members only. */
  appGrants: number;
  /** Folder grants. Members only. */
  folderGrants: number;
  /** This is the admin looking at the list. */
  self: boolean;
}

export interface InviteView {
  id: string;
  role: Role;
  displayName: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface CreatedInvite extends InviteView {
  /** Full link to hand over. Only returned once, when created. */
  url: string;
  path: string;
}

export interface PersonSession {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  zone: "home" | "away";
  userAgent: string | null;
  /** The admin's own current session (can't revoke from here). */
  current: boolean;
}

// ---------------------------------------------------------------- app visibility

export interface AppVisibility {
  id: string;
  name: string;
  icon: string | null;
  line: string;
  hidden: boolean;
  /** Every household member sees it. */
  household: boolean;
  /** Members who see it individually (in addition to household). */
  users: string[];
}

export interface VisibilityResponse {
  apps: AppVisibility[];
  members: { id: string; displayName: string; username: string }[];
}

// ---------------------------------------------------------------- folder grants

export interface FolderGrant {
  id: string;
  userId: string;
  userName: string;
  path: string;
  label: string | null;
  access: "read" | "write";
  createdAt: number;
  /** The folder is still there. */
  exists: boolean;
}

// ---------------------------------------------------------------- reports

export interface ProblemReport {
  id: string;
  userId: string | null;
  userName: string | null;
  appId: string | null;
  appName: string | null;
  message: string;
  createdAt: number;
  resolvedAt: number | null;
  resolvedByName: string | null;
  reply: string | null;
  repliedAt: number | null;
  repliedByName: string | null;
  /** An admin has seen it (marked as seen, replied or resolved). Sent → seen → fixed. */
  acknowledgedAt: number | null;
  acknowledgedByName: string | null;
}

// ---------------------------------------------------------------- announcements

export interface Announcement {
  id: string;
  message: string;
  appId: string | null;
  appName: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: number;
  /** Stops showing after this time; null = until removed. */
  until: number | null;
  active: boolean;
}

// ---------------------------------------------------------------- activity

export interface ActivityItem {
  id: number;
  at: number;
  userId: string | null;
  username: string | null;
  kind: "user" | "system";
  action: string;
  target: string | null;
  summary: string;
  detail: unknown;
  ip: string | null;
  zone: string | null;
  outcome: "ok" | "failed";
}

export interface ActivityPage {
  items: ActivityItem[];
  /** Pass as `before` for the next page; null at the end. */
  next: number | null;
}
