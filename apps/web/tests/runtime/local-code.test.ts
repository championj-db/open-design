// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hasPendingLocalFolders,
  localFolderName,
  MAX_LOCAL_CODE_FILE_BYTES,
  selectLocalCodeFiles,
  stagePendingLocalFolder,
  uploadLocalFolder,
  uploadPendingLocalFolders,
} from '../../src/runtime/local-code';

// A file as the browser's folder picker hands it over: its path inside the
// picked folder rides on `webkitRelativePath`.
function picked(relativePath: string, size = 10): File {
  const file = new File(['x'.repeat(Math.min(size, 64))], relativePath.split('/').pop()!);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

const uploads: string[] = [];

function mockUploads(failing: Set<string> = new Set()) {
  uploads.length = 0;
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const name = String((init?.body as FormData).get('name'));
    if (failing.has(name)) return new Response('{}', { status: 500 });
    uploads.push(name);
    return new Response(JSON.stringify({ file: { name } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('local code picked in the browser', () => {
  it('skips dependency, build and VCS trees and large files', () => {
    const files = [
      picked('app/src/index.ts'),
      picked('app/node_modules/react/index.js'),
      picked('app/.git/HEAD'),
      picked('app/dist/bundle.js'),
      picked('app/assets/huge.png', MAX_LOCAL_CODE_FILE_BYTES + 1),
      picked('app/src/index.ts'),
    ];
    expect(selectLocalCodeFiles(files).map((file) => file.webkitRelativePath)).toEqual(['app/src/index.ts']);
    expect(localFolderName(files)).toBe('app');
  });

  it('uploads a folder into the project under context/local-code, keeping its layout', async () => {
    mockUploads(new Set(['context/local-code/app/b.css']));
    const upload = await uploadLocalFolder('p1', [
      picked('app/src/a.tsx'),
      picked('app/b.css'),
      picked('app/node_modules/x.js'),
    ]);
    expect(uploads).toEqual(['context/local-code/app/src/a.tsx']);
    expect(upload).toEqual({ path: 'context/local-code/app', uploaded: 1, skipped: 2 });
  });

  it('reports nothing uploaded as null', async () => {
    mockUploads();
    expect(await uploadLocalFolder('p1', [picked('app/node_modules/x.js')])).toBeNull();
  });

  it('holds a Home pick until its project exists, then swaps in the uploaded path', async () => {
    mockUploads();
    const pending = stagePendingLocalFolder([picked('brand/tokens.css')]);
    const other = { id: 'project:x', kind: 'project' as const, label: 'X', absolutePath: '/x' };
    expect(pending).toMatchObject({ kind: 'local-code', label: 'brand' });
    expect(pending.absolutePath).toBeUndefined();
    expect(hasPendingLocalFolders([other])).toBe(false);
    expect(hasPendingLocalFolders([other, pending])).toBe(true);

    const items = await uploadPendingLocalFolders('p1', [other, pending]);
    expect(uploads).toEqual(['context/local-code/brand/tokens.css']);
    expect(items).toEqual([
      other,
      {
        id: 'local-code:context/local-code/brand',
        kind: 'local-code',
        label: 'brand',
        title: 'brand',
        path: 'context/local-code/brand',
      },
    ]);
    // Consumed: a second pass leaves the context alone.
    expect(hasPendingLocalFolders([pending])).toBe(false);
  });
});
