// Append-only. Never edit a shipped migration; add a new one.
export const migrations: string[] = [
  /* 1 · core */ `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    password_hash TEXT NOT NULL,
    totp_secret_enc TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    totp_last_step INTEGER,
    recovery_codes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER,
    password_changed_at INTEGER,
    disabled INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    recent_auth_at INTEGER NOT NULL,
    mfa_pending INTEGER NOT NULL DEFAULT 0,
    ip TEXT,
    user_agent TEXT,
    zone TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    display_name TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT
  );

  CREATE TABLE login_attempts (
    key TEXT NOT NULL,
    at INTEGER NOT NULL,
    ok INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX login_attempts_key ON login_attempts(key, at);

  CREATE TABLE user_prefs (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE home_layouts (
    owner TEXT PRIMARY KEY,            -- user id, or '__default__' for the household template
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE pins (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,               -- folder | app | page
    target TEXT NOT NULL,
    label TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX pins_user ON pins(user_id, kind, position);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    user_id TEXT,
    username TEXT,
    kind TEXT NOT NULL DEFAULT 'user',  -- user | system
    action TEXT NOT NULL,
    target TEXT,
    summary TEXT NOT NULL,
    detail TEXT,
    ip TEXT,
    zone TEXT,
    outcome TEXT NOT NULL DEFAULT 'ok'  -- ok | failed
  );
  CREATE INDEX audit_at ON audit_log(at);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  /* 2 · health, alerts, metrics */ `
  CREATE TABLE findings (
    id TEXT PRIMARY KEY,               -- stable key, e.g. disk.full:/var
    kind TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('fault', 'attention', 'info')),
    subject TEXT,                      -- app / disk / route the finding is about
    title TEXT NOT NULL,
    cause TEXT,
    detail TEXT,                       -- json
    remedy TEXT,                       -- json { action, label, params, danger }
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    resolved_at INTEGER,
    snoozed_until INTEGER,
    dismissed_at INTEGER,
    dismissed_by TEXT,
    notified_at INTEGER
  );
  CREATE INDEX findings_open ON findings(resolved_at, severity);

  CREATE TABLE monitors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,                -- http | tcp
    target TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL DEFAULT 'user', -- user | auto
    ref TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE monitor_checks (
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    latency_ms INTEGER,
    status INTEGER,
    error TEXT
  );
  CREATE INDEX monitor_checks_idx ON monitor_checks(monitor_id, at);

  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    owner TEXT,                        -- user id; NULL = server-wide
    kind TEXT NOT NULL,                -- ntfy | pushover | email | webhook
    name TEXT NOT NULL,
    config_enc TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE subscriptions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    filter TEXT NOT NULL DEFAULT '{}', -- { severities, subjects, quiet: {from,to} }
    PRIMARY KEY (user_id, channel_id)
  );

  CREATE TABLE metrics (
    key TEXT NOT NULL,
    ts INTEGER NOT NULL,               -- minute bucket (ms)
    value REAL NOT NULL,
    PRIMARY KEY (key, ts)
  ) WITHOUT ROWID;

  CREATE TABLE metrics_hour (
    key TEXT NOT NULL,
    ts INTEGER NOT NULL,
    avg REAL NOT NULL,
    max REAL NOT NULL,
    PRIMARY KEY (key, ts)
  ) WITHOUT ROWID;
  `,

  /* 3 · apps, household, files, integrations */ `
  CREATE TABLE app_prefs (
    app_id TEXT PRIMARY KEY,           -- compose project or container name
    display_name TEXT,
    description TEXT,
    icon TEXT,
    url_home TEXT,
    url_away TEXT,
    household INTEGER NOT NULL DEFAULT 0,
    has_login TEXT,                    -- yes | no | unknown
    hidden INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE app_access (
    app_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (app_id, user_id)
  );

  CREATE TABLE reports (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    app_id TEXT,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolved_by TEXT,
    reply TEXT
  );

  CREATE TABLE announcements (
    id TEXT PRIMARY KEY,
    message TEXT NOT NULL,
    app_id TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    until INTEGER
  );

  CREATE TABLE file_grants (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    label TEXT,
    access TEXT NOT NULL CHECK (access IN ('read', 'write')),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE trash (
    id TEXT PRIMARY KEY,
    original_path TEXT NOT NULL,
    trash_path TEXT NOT NULL,
    fs_root TEXT NOT NULL,
    size INTEGER,
    is_dir INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL,
    deleted_by TEXT
  );

  CREATE TABLE integrations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    config_enc TEXT NOT NULL,
    app_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,

  /* 4 · system updates */ `
  CREATE TABLE update_runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('refresh', 'upgrade', 'repair')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    user_id TEXT,
    username TEXT,
    packages TEXT,
    outcome TEXT NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'ok', 'failed', 'interrupted')),
    exit_code INTEGER,
    summary TEXT,
    log TEXT
  );
  CREATE INDEX update_runs_kind ON update_runs(kind, started_at);
  CREATE INDEX update_runs_outcome ON update_runs(outcome);

  CREATE TABLE pending_updates (
    package TEXT PRIMARY KEY,
    candidate TEXT NOT NULL,
    security INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    security_since INTEGER
  );
  `,

  /* 5 · integrations sharing */ `
  ALTER TABLE integrations ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
  `,

  /* 6 · files */ `
  CREATE TABLE uploads (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dest_dir TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0,
    conflict TEXT NOT NULL CHECK (conflict IN ('rename','overwrite','skip')), mtime INTEGER,
    status TEXT NOT NULL, final_path TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX uploads_user ON uploads(user_id, status);
  CREATE TABLE file_jobs (
    id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL, username TEXT,
    kind TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}',
    progress TEXT, result TEXT, message TEXT, error TEXT,
    created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
  CREATE INDEX file_jobs_user ON file_jobs(user_id, created_at);
  CREATE INDEX file_jobs_status ON file_jobs(status);
  CREATE TABLE dir_sizes (path TEXT PRIMARY KEY, bytes INTEGER NOT NULL, partial INTEGER NOT NULL DEFAULT 0,
    computed_at INTEGER NOT NULL, took_ms INTEGER NOT NULL);
  CREATE TABLE file_recents (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, path TEXT NOT NULL,
    visited_at INTEGER NOT NULL, PRIMARY KEY (user_id, path));
  CREATE INDEX trash_deleted_by ON trash(deleted_by, deleted_at);
  CREATE INDEX file_grants_user ON file_grants(user_id);
  `,

  /* 7 · network login probes */ `
  CREATE TABLE login_probes (
    target TEXT PRIMARY KEY,
    result TEXT NOT NULL CHECK (result IN ('login','none','unknown')),
    evidence TEXT,
    fingerprint TEXT,
    admin INTEGER NOT NULL DEFAULT 0,
    checked_at INTEGER NOT NULL
  );
  `,

  /* 8 · notifications, monitor aggregates, reports, forced password change */ `
  CREATE TABLE notify_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
    channel_id TEXT, channel_name TEXT NOT NULL, channel_kind TEXT, user_id TEXT,
    event TEXT NOT NULL, finding_id TEXT, episode INTEGER, dedupe_key TEXT NOT NULL UNIQUE,
    severity TEXT, title TEXT NOT NULL, body TEXT NOT NULL, link TEXT, link_label TEXT,
    status TEXT NOT NULL DEFAULT 'pending', not_before INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, sent_at INTEGER, followed_up INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX notify_deliveries_due ON notify_deliveries(status, next_attempt_at);
  CREATE INDEX notify_deliveries_channel ON notify_deliveries(channel_id, id);
  CREATE INDEX notify_deliveries_follow ON notify_deliveries(event, followed_up);
  CREATE INDEX notify_deliveries_created ON notify_deliveries(created_at);
  CREATE TABLE monitor_hours (
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE, hour INTEGER NOT NULL,
    checks INTEGER NOT NULL, ok INTEGER NOT NULL, latency_sum INTEGER NOT NULL, latency_n INTEGER NOT NULL,
    latency_max INTEGER, PRIMARY KEY (monitor_id, hour)
  ) WITHOUT ROWID;
  CREATE INDEX monitor_hours_hour ON monitor_hours(hour);
  ALTER TABLE reports ADD COLUMN replied_at INTEGER;
  ALTER TABLE reports ADD COLUMN replied_by TEXT;
  ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX reports_user ON reports(user_id, created_at);
  `,

  /* 9 · storage */ `
  CREATE TABLE storage_jobs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT, status TEXT NOT NULL, title TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]', progress TEXT, result TEXT, error TEXT,
    user_id TEXT, username TEXT, started_at INTEGER NOT NULL, finished_at INTEGER
  );
  CREATE INDEX storage_jobs_kind ON storage_jobs(kind, target, started_at);
  CREATE INDEX storage_jobs_status ON storage_jobs(status);
  CREATE TABLE storage_smart (
    disk_id TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL, temp REAL, power_on_hours INTEGER,
    reallocated INTEGER, pending INTEGER, uncorrectable INTEGER, wear_pct REAL, summary TEXT NOT NULL,
    PRIMARY KEY (disk_id, at)
  ) WITHOUT ROWID;
  `,

  /* 10 · sign-in security: known devices (new-device alerts). Idempotent: auth/devices.ts creates the
     same tables on first use, so a running server picks them up before its next restart. */ `
  CREATE TABLE IF NOT EXISTS known_devices (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_hash TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    first_ip TEXT,
    first_zone TEXT,
    PRIMARY KEY (user_id, device_hash)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS session_devices (
    session_hash TEXT PRIMARY KEY REFERENCES sessions(id_hash) ON DELETE CASCADE ON UPDATE CASCADE,
    device_hash TEXT NOT NULL,
    new_device INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  `,

  /* 11 · diagnostics checkups (history of runs with their results). Idempotent: diagnostics/checkup/history.ts
     creates the same table on first use, so a running server picks it up before its next restart. */ `
  CREATE TABLE IF NOT EXISTS checkup_runs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
    started_at INTEGER NOT NULL, finished_at INTEGER, user_id TEXT, username TEXT,
    counts TEXT, verdict TEXT, meta TEXT NOT NULL, plan TEXT NOT NULL, results TEXT NOT NULL, summary TEXT
  );
  CREATE INDEX IF NOT EXISTS checkup_runs_kind ON checkup_runs(kind, target, started_at);
  CREATE INDEX IF NOT EXISTS checkup_runs_started ON checkup_runs(started_at);
  `,

  /* 12 · Gluon's own updates (Settings → Updates). */ `
  CREATE TABLE IF NOT EXISTS self_updates (
    id TEXT PRIMARY KEY, method TEXT NOT NULL, from_version TEXT NOT NULL, to_version TEXT NOT NULL,
    ref TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT NOT NULL, stage TEXT,
    message TEXT, auto INTEGER NOT NULL DEFAULT 0, user_id TEXT, username TEXT, log TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS self_updates_started ON self_updates(started_at);
  `,

  /* 13 · app builder: custom apps, their published versions and builds, and Gluon's Umbrel app store.
     Idempotent: server/appstore/db.ts runs the same SQL on first use. */ `
  CREATE TABLE IF NOT EXISTS custom_apps (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', target TEXT, app_id TEXT UNIQUE,
    slug TEXT NOT NULL, name TEXT NOT NULL, spec TEXT NOT NULL, secrets TEXT, github TEXT, rev INTEGER NOT NULL DEFAULT 1,
    published_version TEXT, published_revision INTEGER NOT NULL DEFAULT 0, published_at INTEGER, published_spec TEXT,
    created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS custom_apps_updated ON custom_apps(updated_at);
  CREATE TABLE IF NOT EXISTS custom_app_versions (
    app TEXT NOT NULL REFERENCES custom_apps(id) ON DELETE CASCADE, revision INTEGER NOT NULL, version TEXT NOT NULL,
    files TEXT NOT NULL, store_commit TEXT, source_commit TEXT, images TEXT, published_at INTEGER NOT NULL,
    user_id TEXT, username TEXT, PRIMARY KEY (app, revision)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS custom_app_builds (
    id TEXT PRIMARY KEY, app TEXT NOT NULL REFERENCES custom_apps(id) ON DELETE CASCADE, status TEXT NOT NULL,
    commit_sha TEXT, images TEXT NOT NULL DEFAULT '{}', started_at INTEGER NOT NULL, finished_at INTEGER,
    log TEXT NOT NULL DEFAULT '', error TEXT, user_id TEXT, username TEXT
  );
  CREATE INDEX IF NOT EXISTS custom_app_builds_app ON custom_app_builds(app, started_at);
  CREATE TABLE IF NOT EXISTS custom_app_store (
    id INTEGER PRIMARY KEY CHECK (id = 1), store_id TEXT NOT NULL, token TEXT NOT NULL,
    registered_url TEXT, registered_at INTEGER, created_at INTEGER NOT NULL
  );
  `,

  /* 14 · Home widgets that read this machine: the internet probe's minutes (7 days) and the guest Wi-Fi network
     (password encrypted). Idempotent: server/widgets/internet.ts and guest-wifi.ts create the same tables on first use. */ `
  CREATE TABLE IF NOT EXISTS internet_minutes (
    ts INTEGER PRIMARY KEY, rounds INTEGER NOT NULL, up INTEGER NOT NULL, router_down INTEGER NOT NULL,
    lost INTEGER NOT NULL, probes INTEGER NOT NULL, ms_sum REAL NOT NULL, ms_n INTEGER NOT NULL, ms_max REAL
  );
  CREATE TABLE IF NOT EXISTS guest_wifi (
    id INTEGER PRIMARY KEY CHECK (id = 1), ssid TEXT NOT NULL, security TEXT NOT NULL, secret TEXT,
    hidden INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT
  );
  `,
];
