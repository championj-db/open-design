// Minimal typings for Node's built-in `node:sqlite` (Node >= 22.5), used by
// storage/local-sqlite.ts. The repo pins @types/node 20, which predates it.
declare module 'node:sqlite' {
  type SQLInputValue = null | number | bigint | string | Uint8Array;
  type SQLOutputValue = null | number | bigint | string | Uint8Array;

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    timeout?: number;
  }

  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...params: SQLInputValue[]): StatementResultingChanges;
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    all(...params: SQLInputValue[]): Array<Record<string, SQLOutputValue>>;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    readonly isOpen: boolean;
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
