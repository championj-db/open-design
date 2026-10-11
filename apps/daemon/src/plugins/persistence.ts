// Plugin-system schema migrations. Phase 1 shipped installed_plugins,
// plugin_marketplaces, applied_plugin_snapshots (full §11.4 shape with
// PB2 expires_at), and ALTER TABLE adds for projects / conversations to
// back-reference the applied snapshot. Phase 2A adds run_devloop_iterations
// (devloop audit + future per-iteration billing) and genui_surfaces
// (cross-conversation cache, F8 lookup rules).
//
// `runs` lives in-memory in `apps/daemon/src/runs.ts` today, so the
// run-level snapshot link is carried on the in-memory run object plus
// the messages.run_id row instead of a SQL ALTER TABLE.

import type { SqlDatabase } from '../storage/postgres/sql-database.js';

type SqliteDb = SqlDatabase;
type DbRow = Record<string, unknown>;

export function migratePlugins(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS installed_plugins (
      id                   TEXT COLLATE "C" PRIMARY KEY,
      title                TEXT COLLATE "C" NOT NULL,
      version              TEXT COLLATE "C" NOT NULL,
      source_kind          TEXT COLLATE "C" NOT NULL,
      source               TEXT COLLATE "C" NOT NULL,
      pinned_ref           TEXT COLLATE "C",
      source_digest        TEXT COLLATE "C",
      source_marketplace_id TEXT COLLATE "C",
      source_marketplace_entry_name TEXT COLLATE "C",
      source_marketplace_entry_version TEXT COLLATE "C",
      marketplace_trust    TEXT COLLATE "C",
      resolved_source      TEXT COLLATE "C",
      resolved_ref         TEXT COLLATE "C",
      manifest_digest      TEXT COLLATE "C",
      archive_integrity    TEXT COLLATE "C",
      trust                TEXT COLLATE "C" NOT NULL,
      capabilities_granted TEXT COLLATE "C" NOT NULL,
      manifest_json        TEXT COLLATE "C" NOT NULL,
      fs_path              TEXT COLLATE "C" NOT NULL,
      installed_at         BIGINT NOT NULL,
      updated_at           BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_installed_plugins_source_kind
      ON installed_plugins(source_kind NULLS FIRST);

    CREATE TABLE IF NOT EXISTS plugin_marketplaces (
      id            TEXT COLLATE "C" PRIMARY KEY,
      url           TEXT COLLATE "C" NOT NULL,
      spec_version  TEXT COLLATE "C" NOT NULL DEFAULT '1.0.0',
      version       TEXT COLLATE "C" NOT NULL DEFAULT '0.0.0',
      trust         TEXT COLLATE "C" NOT NULL,
      manifest_json TEXT COLLATE "C" NOT NULL,
      added_at      BIGINT NOT NULL,
      refreshed_at  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS applied_plugin_snapshots (
      id                       TEXT COLLATE "C" PRIMARY KEY,
      project_id               TEXT COLLATE "C" NOT NULL,
      conversation_id          TEXT COLLATE "C",
      run_id                   TEXT COLLATE "C",
      plugin_id                TEXT COLLATE "C" NOT NULL,
      plugin_spec_version      TEXT COLLATE "C" NOT NULL DEFAULT '1.0.0',
      plugin_version           TEXT COLLATE "C" NOT NULL,
      manifest_source_digest   TEXT COLLATE "C" NOT NULL,
      strategy_json            TEXT COLLATE "C",
      source_marketplace_id    TEXT COLLATE "C",
      source_marketplace_entry_name TEXT COLLATE "C",
      source_marketplace_entry_version TEXT COLLATE "C",
      marketplace_trust        TEXT COLLATE "C",
      resolved_source          TEXT COLLATE "C",
      resolved_ref             TEXT COLLATE "C",
      archive_integrity        TEXT COLLATE "C",
      pinned_ref               TEXT COLLATE "C",
      task_kind                TEXT COLLATE "C" NOT NULL,
      inputs_json              TEXT COLLATE "C" NOT NULL,
      resolved_context_json    TEXT COLLATE "C" NOT NULL,
      craft_requires_json      TEXT COLLATE "C" NOT NULL DEFAULT '[]',
      pipeline_json            TEXT COLLATE "C",
      genui_surfaces_json      TEXT COLLATE "C" NOT NULL DEFAULT '[]',
      capabilities_granted     TEXT COLLATE "C" NOT NULL,
      capabilities_required    TEXT COLLATE "C" NOT NULL DEFAULT '[]',
      assets_staged_json       TEXT COLLATE "C" NOT NULL,
      connectors_required_json TEXT COLLATE "C" NOT NULL DEFAULT '[]',
      connectors_resolved_json TEXT COLLATE "C" NOT NULL DEFAULT '[]',
      mcp_servers_json         TEXT COLLATE "C" NOT NULL DEFAULT '[]',
      plugin_title             TEXT COLLATE "C",
      plugin_description       TEXT COLLATE "C",
      query_text               TEXT COLLATE "C",
      status                   TEXT COLLATE "C" NOT NULL DEFAULT 'fresh',
      applied_at               BIGINT NOT NULL,
      expires_at               BIGINT,
      FOREIGN KEY (project_id)      REFERENCES projects(id)      ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_project ON applied_plugin_snapshots(project_id NULLS FIRST);
    CREATE INDEX IF NOT EXISTS idx_snapshots_run     ON applied_plugin_snapshots(run_id NULLS FIRST);
    CREATE INDEX IF NOT EXISTS idx_snapshots_plugin  ON applied_plugin_snapshots(plugin_id NULLS FIRST, plugin_version NULLS FIRST);

    -- §10.2 devloop audit + per-iteration billing surface.
    -- run_id is a free string today (in-memory runs, no FK target).
    CREATE TABLE IF NOT EXISTS run_devloop_iterations (
      id                    TEXT COLLATE "C" PRIMARY KEY,
      run_id                TEXT COLLATE "C" NOT NULL,
      stage_id              TEXT COLLATE "C" NOT NULL,
      iteration             BIGINT NOT NULL,
      artifact_diff_summary TEXT COLLATE "C",
      critique_summary      TEXT COLLATE "C",
      tokens_used           BIGINT,
      ended_at              BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_devloop_run        ON run_devloop_iterations(run_id NULLS FIRST);
    CREATE INDEX IF NOT EXISTS idx_devloop_run_stage  ON run_devloop_iterations(run_id NULLS FIRST, stage_id NULLS FIRST);

    -- §10.3 GenUI surface persisted state. The lookup rules in §10.3.3
    -- read this table at run / conversation / project tier; F8 enforces
    -- the cross-conversation cache hit on a second oauth-prompt.
    -- conversation_id / run_id are stored as plain TEXT (no FK) because
    -- runs are in-memory; conversation FK is set up by the daemon's
    -- existing migrations and we don't want to fail on legacy DBs that
    -- predate it. plugin_snapshot_id is a FK to applied_plugin_snapshots.
    CREATE TABLE IF NOT EXISTS genui_surfaces (
      id                    TEXT COLLATE "C" PRIMARY KEY,
      project_id            TEXT COLLATE "C" NOT NULL,
      conversation_id       TEXT COLLATE "C",
      run_id                TEXT COLLATE "C",
      plugin_snapshot_id    TEXT COLLATE "C" NOT NULL,
      surface_id            TEXT COLLATE "C" NOT NULL,
      kind                  TEXT COLLATE "C" NOT NULL,
      persist               TEXT COLLATE "C" NOT NULL,
      schema_digest         TEXT COLLATE "C",
      value_json            TEXT COLLATE "C",
      status                TEXT COLLATE "C" NOT NULL,
      responded_by          TEXT COLLATE "C",
      requested_at          BIGINT NOT NULL,
      responded_at          BIGINT,
      expires_at            BIGINT,
      FOREIGN KEY (project_id)         REFERENCES projects(id)                  ON DELETE CASCADE,
      FOREIGN KEY (plugin_snapshot_id) REFERENCES applied_plugin_snapshots(id)  ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_genui_proj_surface ON genui_surfaces(project_id NULLS FIRST, surface_id NULLS FIRST);
    CREATE INDEX IF NOT EXISTS idx_genui_conv_surface ON genui_surfaces(conversation_id NULLS FIRST, surface_id NULLS FIRST);
    CREATE INDEX IF NOT EXISTS idx_genui_run          ON genui_surfaces(run_id NULLS FIRST);

    CREATE TABLE IF NOT EXISTS skill_plugin_candidates (
      id                   TEXT COLLATE "C" PRIMARY KEY,
      project_id           TEXT COLLATE "C" NOT NULL,
      run_id               TEXT COLLATE "C",
      conversation_id      TEXT COLLATE "C",
      assistant_message_id TEXT COLLATE "C",
      fingerprint          TEXT COLLATE "C" NOT NULL,
      status               TEXT COLLATE "C" NOT NULL DEFAULT 'active',
      title                TEXT COLLATE "C" NOT NULL,
      description          TEXT COLLATE "C" NOT NULL,
      confidence           DOUBLE PRECISION NOT NULL,
      source_refs_json     TEXT COLLATE "C" NOT NULL,
      provenance_json      TEXT COLLATE "C" NOT NULL,
      draft_path           TEXT COLLATE "C",
      created_at           BIGINT NOT NULL,
      updated_at           BIGINT NOT NULL,
      dismissed_at         BIGINT,
      UNIQUE(project_id, fingerprint),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_skill_plugin_candidates_project
      ON skill_plugin_candidates(project_id NULLS FIRST, status NULLS FIRST, created_at DESC NULLS LAST);
  `);

  db.exec(`ALTER TABLE plugin_marketplaces ADD COLUMN IF NOT EXISTS spec_version TEXT COLLATE "C" NOT NULL DEFAULT '1.0.0'`);
  db.exec(`ALTER TABLE plugin_marketplaces ADD COLUMN IF NOT EXISTS version TEXT COLLATE "C" NOT NULL DEFAULT '0.0.0'`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_marketplaces_version ON plugin_marketplaces(version NULLS FIRST)`);

  for (const ddl of [
    `ALTER TABLE installed_plugins ADD COLUMN IF NOT EXISTS source_marketplace_entry_name TEXT COLLATE "C"`,
    `ALTER TABLE installed_plugins ADD COLUMN IF NOT EXISTS source_marketplace_entry_version TEXT COLLATE "C"`,
    `ALTER TABLE installed_plugins ADD COLUMN IF NOT EXISTS marketplace_trust TEXT COLLATE "C"`,
    `ALTER TABLE installed_plugins ADD COLUMN IF NOT EXISTS resolved_source TEXT COLLATE "C"`,
    `ALTER TABLE installed_plugins ADD COLUMN IF NOT EXISTS resolved_ref TEXT COLLATE "C"`,
    `ALTER TABLE installed_plugins ADD COLUMN IF NOT EXISTS manifest_digest TEXT COLLATE "C"`,
    `ALTER TABLE installed_plugins ADD COLUMN IF NOT EXISTS archive_integrity TEXT COLLATE "C"`,
    // Internal bookkeeping for the bundled-plugin boot walker only (bundled.ts)
    // — a hash of the on-disk files (open-design.json, SKILL.md, …) a bundled
    // plugin was last registered from, so a no-op reboot can tell "nothing
    // changed" from "SKILL.md was edited" without touching the parsed
    // manifest/version fields other InstalledPluginRecord consumers rely on.
    `ALTER TABLE installed_plugins ADD COLUMN IF NOT EXISTS bundled_content_digest TEXT COLLATE "C"`,
  ]) {
    db.exec(ddl);
  }

  db.exec(`ALTER TABLE applied_plugin_snapshots ADD COLUMN IF NOT EXISTS plugin_spec_version TEXT COLLATE "C" NOT NULL DEFAULT '1.0.0'`);
  for (const ddl of [
    `ALTER TABLE applied_plugin_snapshots ADD COLUMN IF NOT EXISTS strategy_json TEXT COLLATE "C"`,
    `ALTER TABLE applied_plugin_snapshots ADD COLUMN IF NOT EXISTS source_marketplace_entry_name TEXT COLLATE "C"`,
    `ALTER TABLE applied_plugin_snapshots ADD COLUMN IF NOT EXISTS source_marketplace_entry_version TEXT COLLATE "C"`,
    `ALTER TABLE applied_plugin_snapshots ADD COLUMN IF NOT EXISTS marketplace_trust TEXT COLLATE "C"`,
    `ALTER TABLE applied_plugin_snapshots ADD COLUMN IF NOT EXISTS resolved_source TEXT COLLATE "C"`,
    `ALTER TABLE applied_plugin_snapshots ADD COLUMN IF NOT EXISTS resolved_ref TEXT COLLATE "C"`,
    `ALTER TABLE applied_plugin_snapshots ADD COLUMN IF NOT EXISTS archive_integrity TEXT COLLATE "C"`,
    `ALTER TABLE applied_plugin_snapshots ADD COLUMN IF NOT EXISTS craft_requires_json TEXT COLLATE "C" NOT NULL DEFAULT '[]'`,
  ]) {
    db.exec(ddl);
  }

  // Back-reference columns. Mirrors the upstream pattern in db.ts.
  db.exec(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS applied_plugin_snapshot_id TEXT COLLATE "C"`);
  db.exec(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS applied_plugin_snapshot_id TEXT COLLATE "C"`);
}
