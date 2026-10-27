import path from 'node:path';

// Notified the moment a new user design system directory is reserved — by a
// create, an import, or a brand extraction — inside the reserving call's
// async context, so a deployment can attribute the new design system to
// whoever caused it (databricks/design-system-sharing.ts). The id is the
// directory name; the catalog lists it as `user:<dirId>`.
const listeners = new Set<(root: string, dirId: string) => void>();

export function onUserDesignSystemCreated(listener: (root: string, dirId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyUserDesignSystemCreated(root: string, dirId: string): void {
  const resolvedRoot = path.resolve(root);
  for (const listener of listeners) {
    try {
      listener(resolvedRoot, dirId);
    } catch (error) {
      console.warn('[design-systems] creation listener failed', error);
    }
  }
}
