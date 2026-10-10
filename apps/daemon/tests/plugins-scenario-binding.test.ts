import { createTestDatabase } from './helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import {
  automaticScenarioTaskProfile,
  migrateProjectScenarioBindings,
  readVerifiedProjectScenarioBinding,
  writeProjectScenarioBinding,
} from '../src/plugins/scenario-binding.js';

function fixtureDb() {
  const db = createTestDatabase({ migrate: false });
  db.exec(`
    CREATE TABLE projects (
      id TEXT COLLATE "C" PRIMARY KEY,
      metadata_json TEXT COLLATE "C",
      applied_plugin_snapshot_id TEXT COLLATE "C"
    );
    CREATE TABLE applied_plugin_snapshots (
      id TEXT COLLATE "C" PRIMARY KEY,
      project_id TEXT COLLATE "C",
      plugin_id TEXT COLLATE "C",
      applied_at BIGINT
    );
  `);
  return db;
}

describe('project scenario binding provenance', () => {
  it('migrates historical pins to legacy_unknown without guessing automatic authority', () => {
    const db = fixtureDb();
    db.prepare(`INSERT INTO applied_plugin_snapshots VALUES (?, ?, ?, ?)`)
      .run('snapshot-1', 'project-1', 'example-web-prototype', 42);
    db.prepare(`INSERT INTO projects VALUES (?, ?, ?)`)
      .run(
        'project-1',
        JSON.stringify({
          kind: 'prototype',
          automaticDefaultScenario: {
            pluginId: 'example-web-prototype',
            snapshotId: 'snapshot-1',
          },
        }),
        'snapshot-1',
      );

    migrateProjectScenarioBindings(db);
    const row = db.prepare(`SELECT metadata_json AS metadataJson FROM projects WHERE id = ?`)
      .get('project-1') as { metadataJson: string };
    const metadata = JSON.parse(row.metadataJson);
    expect(metadata.automaticDefaultScenario).toBeUndefined();
    expect(metadata.scenarioBinding).toEqual({
      schemaVersion: 1,
      provenance: 'legacy_unknown',
      pluginId: 'example-web-prototype',
      snapshotId: 'snapshot-1',
      boundAt: 42,
    });
    db.close();
  });

  it('stamps and verifies exact automatic identity while rejecting broad image inference', () => {
    const db = fixtureDb();
    db.prepare(`INSERT INTO applied_plugin_snapshots VALUES (?, ?, ?, ?)`)
      .run('snapshot-2', 'project-2', 'example-web-prototype', 84);
    db.prepare(`INSERT INTO projects VALUES (?, ?, ?)`)
      .run('project-2', JSON.stringify({ kind: 'prototype', intent: 'marketing' }), 'snapshot-2');

    const binding = writeProjectScenarioBinding(db, {
      projectId: 'project-2',
      snapshotId: 'snapshot-2',
      pluginId: 'example-web-prototype',
      provenance: 'automatic_default',
      taskProfile: 'marketing',
      boundAt: 85,
    });
    const metadata = JSON.parse((db.prepare(
      `SELECT metadata_json AS metadataJson FROM projects WHERE id = ?`,
    ).get('project-2') as { metadataJson: string }).metadataJson);
    expect(readVerifiedProjectScenarioBinding(db, {
      projectId: 'project-2',
      appliedPluginSnapshotId: 'snapshot-2',
      metadata,
    })).toEqual(binding);
    expect(readVerifiedProjectScenarioBinding(db, {
      projectId: 'project-2',
      appliedPluginSnapshotId: 'different-snapshot',
      metadata,
    })).toBeNull();
    expect(readVerifiedProjectScenarioBinding(db, {
      projectId: 'project-2',
      appliedPluginSnapshotId: 'snapshot-2',
      metadata: { ...metadata, intent: undefined },
    })).toBeNull();
    expect(() => writeProjectScenarioBinding(db, {
      projectId: 'project-2',
      snapshotId: 'snapshot-2',
      pluginId: 'example-web-prototype',
      provenance: 'automatic_default',
      taskProfile: 'prototype',
    })).toThrow(/mismatched scenario task profile/i);
    expect(automaticScenarioTaskProfile({
      metadata: { kind: 'image' },
      pluginId: 'od-media-generation',
    })).toBeNull();
    expect(automaticScenarioTaskProfile({
      metadata: { kind: 'video', intent: 'hyperframes' },
      pluginId: 'example-hyperframes',
    })).toBe('hyperframes');
    db.close();
  });
});
