import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { updateUserDesignSystem } from '../design-systems/index.js';
import type { DesignSystemSharing } from './design-system-sharing.js';

// The app's own Team design systems on a Databricks App. Each directory under
// the repository's `team-design-systems/` holds one DESIGN.md; at startup it
// is installed as the user design system `user:<directory>`, the daemon
// generates its tokens, kit and previews from it, and it is recorded as owned
// by the app and shared (design-system-sharing.ts), so every user finds it in
// the Team collection, read-only. Any other file in a seed directory (such as
// a hand-written `colors_and_type.css`) replaces the generated file of that
// name. A changed seed is re-installed on the next start; an unchanged one is
// left alone.

export interface TeamDesignSystemSeedResult {
  installed: string[];
  updated: string[];
}

export async function seedTeamDesignSystems({
  seedRoot,
  userDesignSystemsRoot,
  sharing,
}: {
  seedRoot: string;
  userDesignSystemsRoot: string;
  sharing: Pick<DesignSystemSharing, 'recordTeamOwned'>;
}): Promise<TeamDesignSystemSeedResult> {
  const result: TeamDesignSystemSeedResult = { installed: [], updated: [] };
  const entries = await readdir(seedRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
    const seed = await readFile(path.join(seedRoot, entry.name, 'DESIGN.md'), 'utf8').catch(() => null);
    const body = seed?.trim() ? `${seed.trim()}\n` : null;
    if (!body) continue;
    const id = `user:${entry.name}`;
    const dir = path.join(userDesignSystemsRoot, entry.name);
    const installed = await readFile(path.join(dir, 'DESIGN.md'), 'utf8').catch(() => null);
    let changed = installed !== body;
    if (changed) {
      if (installed === null) {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'DESIGN.md'), body, 'utf8');
      }
      await updateUserDesignSystem(userDesignSystemsRoot, id, { body, status: 'published' });
    }
    const overrides = await readdir(path.join(seedRoot, entry.name), { withFileTypes: true });
    for (const file of overrides) {
      if (!file.isFile() || file.name === 'DESIGN.md') continue;
      const content = await readFile(path.join(seedRoot, entry.name, file.name), 'utf8');
      const target = path.join(dir, file.name);
      if ((await readFile(target, 'utf8').catch(() => null)) === content) continue;
      await writeFile(target, content, 'utf8');
      changed = true;
    }
    if (changed) (installed === null ? result.installed : result.updated).push(id);
    sharing.recordTeamOwned(id);
  }
  return result;
}
