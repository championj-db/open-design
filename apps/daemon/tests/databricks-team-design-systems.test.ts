import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDesignSystemSharing,
  designSystemAccess,
  TEAM_OWNER,
} from '../src/databricks/design-system-sharing.js';
import { seedTeamDesignSystems } from '../src/databricks/team-design-systems.js';
import { listDesignSystems } from '../src/design-systems/index.js';

const SEED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../team-design-systems');
const DBUI = ['user:dbui-base', 'user:dbui-du-bois', 'user:dbui-genie-one', 'user:dbui-shadcn-neutral'];

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'od-dbx-team-ds-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const list = () => listDesignSystems(root, { idPrefix: 'user:', source: 'user', isEditable: true, defaultStatus: 'draft' });

describe('team design systems', () => {
  it('installs the bundled dbui themes as published design systems the app owns and shares read-only', async () => {
    const sharing = createDesignSystemSharing(new Database(':memory:'));
    const result = await seedTeamDesignSystems({ seedRoot: SEED_ROOT, userDesignSystemsRoot: root, sharing });

    expect(result.installed.sort()).toEqual(DBUI);
    const systems = await list();
    expect(systems.map((system) => system.id).sort()).toEqual(DBUI);
    const duBois = systems.find((system) => system.id === 'user:dbui-du-bois')!;
    expect(duBois).toMatchObject({ title: 'dbui Du Bois', category: 'Product UI', status: 'published' });
    expect(duBois.swatches).toEqual(['#ffffff', '#ebebeb', '#161616', '#2272b4']);
    // The daemon generated the package from the DESIGN.md, and the seed's own
    // token sheet replaced the generic one.
    expect(await readFile(path.join(root, 'dbui-du-bois', 'ui_kits', 'app', 'index.html'), 'utf8')).toContain('colors_and_type.css');
    const tokens = await readFile(path.join(root, 'dbui-du-bois', 'colors_and_type.css'), 'utf8');
    expect(tokens).toContain('--dbui-du-bois-foreground: #161616;');
    expect(tokens).toContain('--dbui-du-bois-accent: #2272B4;');
    expect(tokens).toContain('--dbui-du-bois-radius-sm: 4px;');

    for (const id of DBUI) {
      expect(sharing.ownerOf(id)).toBe(TEAM_OWNER);
      expect(sharing.isShared(id)).toBe(true);
      expect(designSystemAccess(sharing, id, 'any-user')).toBe('read');
    }
  });

  it('leaves an unchanged install alone and re-installs a changed one', async () => {
    const sharing = createDesignSystemSharing(new Database(':memory:'));
    await seedTeamDesignSystems({ seedRoot: SEED_ROOT, userDesignSystemsRoot: root, sharing });
    expect(await seedTeamDesignSystems({ seedRoot: SEED_ROOT, userDesignSystemsRoot: root, sharing }))
      .toEqual({ installed: [], updated: [] });

    await writeFile(path.join(root, 'dbui-base', 'DESIGN.md'), '# Edited\n', 'utf8');
    const again = await seedTeamDesignSystems({ seedRoot: SEED_ROOT, userDesignSystemsRoot: root, sharing });
    expect(again).toEqual({ installed: [], updated: ['user:dbui-base'] });
    expect((await list()).find((system) => system.id === 'user:dbui-base')?.title).toBe('dbui Base');
  });

  it('installs nothing when the seed directory is missing', async () => {
    const sharing = createDesignSystemSharing(new Database(':memory:'));
    expect(await seedTeamDesignSystems({ seedRoot: path.join(root, 'missing'), userDesignSystemsRoot: root, sharing }))
      .toEqual({ installed: [], updated: [] });
  });
});
