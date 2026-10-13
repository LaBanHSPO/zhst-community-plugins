import { ErpError } from '../validation.js';
import { accountingMigration } from './migration.generated.js';
import type { AccountingStore, SqlParameter, WriteResult } from './store.js';

export type DurableSqlBinding = string | number | null | Uint8Array;
export interface DurableSqlCursor {
  next(): { done: true; value?: undefined } | { done?: false; value: Record<string, unknown> };
  toArray(): Record<string, unknown>[];
}
/** Structural subset of SQLite DurableObjectStorage; no Node compatibility flag required. */
export interface DurableAccountingStorage {
  readonly sql: { exec(query: string, ...bindings: DurableSqlBinding[]): DurableSqlCursor };
  transactionSync<T>(callback: () => T): T;
}
export interface DurableAccountingSchemaStatus {
  version: 1 | null;
  checksum: string | null;
  bookConfigured: boolean;
}
interface SchemaRow { type: string; name: string; tbl_name: string; sql: string }
interface StorageContext { active: boolean }
const contexts = new WeakMap<DurableAccountingStorage, StorageContext>();
function context(storage: DurableAccountingStorage): StorageContext {
  let value = contexts.get(storage);
  if (!value) { value = { active: false }; contexts.set(storage, value); }
  return value;
}
// Cloudflare owns __cf_* (including hidden KV), SQLite owns sqlite_*. Inspect every
// plugin-named object AND every trigger/index on a plugin table, regardless of its name.
const schemaQuery = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '__cf_*' AND (name GLOB 'erp_ac_*' OR tbl_name GLOB 'erp_ac_*') ORDER BY type,name";
const assertionCodes: Record<string, true> = {
  BOOK_IMMUTABLE: true, AUDIT_IMMUTABLE: true, COMMAND_IMMUTABLE: true, INVALID_RECEIPT: true,
  INVALID_TRANSITION: true, JOURNAL_IMMUTABLE: true, ACCOUNT_UNAVAILABLE: true, ACCOUNT_CYCLE: true,
  ACCOUNT_HISTORY: true, PARTY_HISTORY: true, BOOK_REQUIRED: true, INVALID_SEQUENCE: true,
  UNBALANCED: true, INVALID_SNAPSHOT: true, OVER_ALLOCATION: true, ALLOCATION_DATE_CONFLICT: true,
  INVALID_REVERSAL: true, ACTIVE_SETTLEMENT: true, INVALID_SETTLEMENT: true,
};
function safeError(error: unknown): ErpError {
  if (error instanceof ErpError) return error;
  const message = error instanceof Error ? error.message : '';
  // workerd appends the primary/extended SQLite error name to sqlite3_errmsg().
  const assertion = /^([A-Z_]+)(?:: SQLITE_CONSTRAINT(?:\b.*)?)?$/.exec(message)?.[1];
  if (assertion && Object.hasOwn(assertionCodes, assertion)) return new ErpError(assertion, 'The accounting operation violates the saved book or journal rules.');
  if (/\bSQLITE_(?:BUSY|LOCKED)\b/.test(message)) return new ErpError('ACCOUNTING_BUSY', 'Accounting is busy with another writer. Keep your command intent and try again after reloading.');
  if (/\bSQLITE_CONSTRAINT\b/.test(message)) return new ErpError('CONFLICT', 'The accounting operation conflicts with saved records or their constraints. Reload before continuing.');
  return new ErpError('ACCOUNTING_STORAGE', 'Accounting storage is unavailable. No successful commit has been confirmed.');
}
function schemaError(): never {
  throw new ErpError('SCHEMA_VERSION', 'The accounting schema is missing or incompatible. Run the explicit migration with its matching approved artifact.');
}
function verify(storage: DurableAccountingStorage, allowEmpty: boolean): boolean {
  const rows = storage.sql.exec(schemaQuery).toArray() as unknown as SchemaRow[];
  if (rows.length === 0) { if (allowEmpty) return false; schemaError(); }
  const expected = accountingMigration.schema;
  if (rows.length !== expected.length || rows.some((row, index) => {
    const other = expected[index];
    return !other || row.type !== other.type || row.name !== other.name || row.tbl_name !== other.tbl_name || row.sql !== other.sql;
  })) schemaError();
  const applied = storage.sql.exec('SELECT version,checksum FROM erp_ac_migrations ORDER BY version').toArray();
  if (applied.length !== 1 || applied[0]?.version !== 1 || applied[0]?.checksum !== accountingMigration.checksum) schemaError();
  if (storage.sql.exec('PRAGMA foreign_keys').toArray()[0]?.foreign_keys !== 1) schemaError();
  for (const row of expected) {
    if (row.type === 'table' && storage.sql.exec(`PRAGMA foreign_key_check(${row.name})`).toArray().length !== 0) schemaError();
  }
  return true;
}
function binding(value: SqlParameter): DurableSqlBinding {
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ErpError('INVALID_INPUT', 'Accounting SQL integer bindings must be safe integers.');
    return Number(value);
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new ErpError('INVALID_INPUT', 'Accounting SQL numeric bindings must be safe integers.');
  return value;
}
function row<T>(value: Record<string, unknown>): T {
  // workerd returns int64 as Number. Fail closed rather than expose rounded money/sequence.
  for (const item of Object.values(value)) {
    if (typeof item === 'number' && !Number.isSafeInteger(item)) throw new ErpError('ACCOUNTING_STORAGE', 'Accounting storage returned a numeric value outside the exact integer boundary.');
  }
  return value as T;
}
function synchronous<T>(storage: DurableAccountingStorage, work: () => T): T {
  const state = context(storage);
  if (state.active) throw new ErpError('NESTED_TRANSACTION', 'Nested accounting transactions are not supported.');
  state.active = true;
  try { return storage.transactionSync(work); }
  catch (error) { throw safeError(error); }
  finally { state.active = false; }
}
class DurableAccountingStore implements AccountingStore {
  private closed = false;
  private fenced = false;
  constructor(private readonly storage: DurableAccountingStorage) {}
  private assertOpen(): void {
    if (this.fenced) throw new ErpError('ASYNC_TRANSACTION', 'Accounting transaction callbacks must be synchronous. Reopen the adapter after rejecting asynchronous work.');
    if (this.closed) throw new ErpError('ACCOUNTING_CLOSED', 'The accounting resource is closed.');
  }
  private query<T>(sql: string, parameters: SqlParameter[], execute: (cursor: DurableSqlCursor) => T): T {
    this.assertOpen();
    try {
      // The rest-parameter array belongs to this call; normalize in place, not a copy.
      for (let index = 0; index < parameters.length; index++) parameters[index] = binding(parameters[index]!);
      return execute(this.storage.sql.exec(sql, ...parameters as DurableSqlBinding[]));
    }
    catch (error) { throw safeError(error); }
  }
  get<T = Record<string, unknown>>(sql: string, ...parameters: SqlParameter[]): T | undefined {
    return this.query(sql, parameters, (cursor) => {
      const first = cursor.next();
      // Drain before returning: no live cursor can cross an await or transaction boundary.
      if (first.done) return undefined;
      while (!cursor.next().done) { /* Consume remaining rows synchronously. */ }
      return row<T>(first.value);
    });
  }
  all<T = Record<string, unknown>>(sql: string, ...parameters: SqlParameter[]): T[] {
    return this.query(sql, parameters, (cursor) => {
      const values = cursor.toArray();
      for (const value of values) row<T>(value);
      return values as T[];
    });
  }
  run(sql: string, ...parameters: SqlParameter[]): WriteResult {
    return this.query(sql, parameters, (cursor) => {
      while (!cursor.next().done) { /* Complete RETURNING statements before reading changes. */ }
      // rowsWritten includes indexes/triggers, unlike AccountingStore.changes.
      const result = this.storage.sql.exec('SELECT changes() AS changes,last_insert_rowid() AS lastInsertRowid').toArray()[0];
      if (!result) throw new ErpError('ACCOUNTING_STORAGE', 'Accounting storage did not return its write result.');
      return row<WriteResult>(result);
    });
  }
  transaction<T>(work: () => T): T {
    this.assertOpen();
    if (context(this.storage).active) throw new ErpError('NESTED_TRANSACTION', 'Nested accounting transactions are not supported.');
    if (work.constructor.name === 'AsyncFunction' || work.constructor.name === 'AsyncGeneratorFunction') throw new ErpError('ASYNC_TRANSACTION', 'Accounting transaction callbacks must be synchronous.');
    return synchronous(this.storage, () => {
      const result = work();
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
        // Without Node async_hooks, permanently fencing this adapter is the safe way to
        // prevent a rejected callback's later continuation from escaping rollback.
        this.fenced = true;
        void Promise.resolve(result).catch(() => { /* Already rejected; adapter is fenced. */ });
        throw new ErpError('ASYNC_TRANSACTION', 'Accounting transaction callbacks must be synchronous.');
      }
      return result;
    });
  }
  close(): void {
    if (this.closed) return;
    if (context(this.storage).active) throw new ErpError('ACTIVE_TRANSACTION', 'Close the accounting resource only after its transaction completes.');
    // Storage is owned by the DO runtime, not this adapter. Never delete/close its database.
    this.closed = true;
  }
}
export function openDurableAccountingStore(storage: DurableAccountingStorage): AccountingStore {
  try {
    verify(storage, false);
    storage.sql.exec('PRAGMA recursive_triggers=ON').toArray();
    return new DurableAccountingStore(storage);
  } catch (error) { throw safeError(error); }
}
export function migrateDurableAccountingStore(storage: DurableAccountingStorage): void {
  try {
    if (verify(storage, true)) return;
    synchronous(storage, () => {
      if (verify(storage, true)) return;
      storage.sql.exec(accountingMigration.sql).toArray();
      storage.sql.exec('INSERT INTO erp_ac_migrations(version,checksum,appliedAt) VALUES(1,?,?)', accountingMigration.checksum, new Date().toISOString()).toArray();
      verify(storage, false);
    });
  } catch (error) { throw safeError(error); }
}
export function durableAccountingSchemaStatus(storage: DurableAccountingStorage): DurableAccountingSchemaStatus {
  try {
    if (!verify(storage, true)) return { version: null, checksum: null, bookConfigured: false };
    return { version: 1, checksum: accountingMigration.checksum, bookConfigured: storage.sql.exec("SELECT 1 FROM erp_ac_settings WHERE id='book'").toArray().length === 1 };
  } catch (error) { throw safeError(error); }
}
export type { AccountingStore } from './store.js';
