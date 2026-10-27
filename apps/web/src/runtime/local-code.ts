// Local code from the user's own computer, read through the browser.
//
// On the desktop the daemon runs on the user's machine, so a picked folder is
// linked by its path and the agent reads it in place. On a Databricks App the
// daemon runs in the app container, which cannot see the user's disk: the
// browser picks the folder instead, and its files are uploaded into the
// project under `context/local-code/<folder>/`, where every agent tool can
// read them. Dependency, build and VCS trees are skipped, as are large files.

import type { WorkspaceCollabContext, WorkspaceContextItem } from '@open-design/contracts';

import { uploadProjectFile } from '../providers/registry';
import { runWithConcurrency, STAGED_UPLOAD_CONCURRENCY } from './chat/staged-attachment';

export const LOCAL_CODE_UPLOAD_ROOT = 'context/local-code';
export const MAX_LOCAL_CODE_FILE_BYTES = 1024 * 1024;
/** Files one design-system source can stage. */
export const MAX_LOCAL_CODE_UPLOAD_FILES = 120;
/** Files one folder attached to a design run can upload. */
export const MAX_LOCAL_FOLDER_UPLOAD_FILES = 400;

export const LOCAL_CODE_SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.vercel',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);

export function normalizeLocalCodePath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

export function localCodeRelativePath(file: File): string {
  const browserPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return normalizeLocalCodePath(browserPath || file.name);
}

function shouldStageLocalCodeFile(file: File): boolean {
  const relativePath = localCodeRelativePath(file);
  if (!relativePath) return false;
  if (file.size > MAX_LOCAL_CODE_FILE_BYTES) return false;
  const parts = relativePath.split('/');
  return !parts.some((part) => LOCAL_CODE_SKIP_DIRS.has(part));
}

export function dedupeLocalCodeFiles(files: File[]): File[] {
  const seen = new Set<string>();
  const next: File[] = [];
  for (const file of files) {
    const key = `${localCodeRelativePath(file)}:${file.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(file);
  }
  return next;
}

export function selectLocalCodeFiles(files: File[], limit = MAX_LOCAL_CODE_UPLOAD_FILES): File[] {
  return dedupeLocalCodeFiles(files.filter(shouldStageLocalCodeFile)).slice(0, limit);
}

/**
 * Open the browser's folder picker. Resolves with every file in the picked
 * folder (each carrying its `webkitRelativePath`), or null when the user
 * cancels.
 */
export function pickLocalFolderFiles(): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.style.display = 'none';
    let settled = false;
    const settle = (files: File[] | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files && files.length > 0 ? files : null);
    };
    input.addEventListener('change', () => settle(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => settle(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** The picked folder's name: the first segment every relative path shares. */
export function localFolderName(files: File[]): string {
  const first = files.map(localCodeRelativePath).find(Boolean) ?? '';
  return first.includes('/') ? first.split('/')[0]! : 'local-code';
}

export interface LocalFolderUpload {
  /** Project-relative folder the files landed in. */
  path: string;
  uploaded: number;
  /** Files left behind: skipped trees, large files, past the cap, or failed. */
  skipped: number;
}

/** Upload a browser-picked folder into the project. Null when nothing uploaded. */
export async function uploadLocalFolder(
  projectId: string,
  files: File[],
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<LocalFolderUpload | null> {
  const folder = localFolderName(files);
  const selected = selectLocalCodeFiles(files, MAX_LOCAL_FOLDER_UPLOAD_FILES);
  const outcomes = await runWithConcurrency(selected, STAGED_UPLOAD_CONCURRENCY, (file) => {
    const relative = localCodeRelativePath(file);
    const inFolder = relative.startsWith(`${folder}/`) ? relative : `${folder}/${relative}`;
    return uploadProjectFile(projectId, file, `${LOCAL_CODE_UPLOAD_ROOT}/${inFolder}`, workspaceContext);
  });
  const uploaded = outcomes.filter(Boolean).length;
  if (uploaded === 0) return null;
  return { path: `${LOCAL_CODE_UPLOAD_ROOT}/${folder}`, uploaded, skipped: files.length - uploaded };
}

/** The run context item for an uploaded folder: a project path, not a host path. */
export function uploadedLocalFolderContextItem(upload: LocalFolderUpload): WorkspaceContextItem {
  const label = upload.path.split('/').pop() || upload.path;
  return { id: `local-code:${upload.path}`, kind: 'local-code', label, title: label, path: upload.path };
}

// Folders picked on Home before their project exists: held here by context
// item id until the project is created and they can be uploaded.
const pendingLocalFolders = new Map<string, File[]>();
const PENDING_PREFIX = 'local-code-pending:';

export function stagePendingLocalFolder(files: File[]): WorkspaceContextItem {
  const label = localFolderName(files);
  const id = `${PENDING_PREFIX}${crypto.randomUUID()}`;
  pendingLocalFolders.set(id, files);
  return { id, kind: 'local-code', label, title: label };
}

export function hasPendingLocalFolders(items: readonly WorkspaceContextItem[] | undefined): boolean {
  return (items ?? []).some((item) => pendingLocalFolders.has(item.id));
}

/**
 * Upload every pending folder among `items` into the new project, and swap
 * each pending item for one naming the uploaded path. A folder that uploads
 * nothing drops out of the context.
 */
export async function uploadPendingLocalFolders(
  projectId: string,
  items: readonly WorkspaceContextItem[],
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<WorkspaceContextItem[]> {
  const next: WorkspaceContextItem[] = [];
  for (const item of items) {
    const files = pendingLocalFolders.get(item.id);
    if (!files) {
      next.push(item);
      continue;
    }
    pendingLocalFolders.delete(item.id);
    const upload = await uploadLocalFolder(projectId, files, workspaceContext);
    if (upload) next.push(uploadedLocalFolderContextItem(upload));
  }
  return next;
}
