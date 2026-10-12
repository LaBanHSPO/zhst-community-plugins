import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { ErpError } from '../validation.js';
import type { AccountingStore, SqlParameter, WriteResult } from './store.js';

const BUSY_TIMEOUT_MS = 250;
const schemaQuery = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
interface SchemaRow { type: string; name: string; tbl_name: string; sql: string }
interface Migration { sql: string; checksum: string; schema: SchemaRow[] }
let shipped: Migration | undefined;

function database(filename: string): DatabaseSync {
  // The pinned Node type declarations predate defensive; supported engines implement it.
  const options = { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false, defensive: true, timeout: BUSY_TIMEOUT_MS };
  const db = new DatabaseSync(filename, options);
  (db as DatabaseSync & { enableDefensive(active: boolean): void }).enableDefensive(true);
  return db;
}
function migration(): Migration {
  if (shipped) return shipped;
  // Both src/accounting/sqlite.ts and dist/accounting/sqlite.mjs sit two levels below the package root.
  const location = new URL('../../migrations/0001_accounting.sql', import.meta.url);
  if (!existsSync(location)) throw new ErpError('SCHEMA_VERSION', 'The accounting migration artifact is missing. Install a complete approved package.');
  const sql = readFileSync(location, 'utf8');
  const reference = database(':memory:');
  try {
    reference.exec(sql);
    shipped = { sql, checksum: createHash('sha256').update(sql).digest('hex'), schema: reference.prepare(schemaQuery).all() as unknown as SchemaRow[] };
    return shipped;
  } finally { reference.close(); }
}
function schemaError(): never {
  throw new ErpError('SCHEMA_VERSION', 'The accounting schema is missing or incompatible. Run the explicit migration with its matching approved artifact.');
}
function verify(db: DatabaseSync, expected: Migration, allowEmpty: boolean): boolean {
  const rows = db.prepare(schemaQuery).all() as unknown as SchemaRow[];
  if (rows.length === 0) { if (allowEmpty) return false; schemaError(); }
  if (!rows.some((row) => row.type === 'table' && row.name === 'erp_ac_migrations')) schemaError();
  if (rows.length !== expected.schema.length || rows.some((row, index) => {
    const other = expected.schema[index];
    return !other || row.type !== other.type || row.name !== other.name || row.tbl_name !== other.tbl_name || row.sql !== other.sql;
  })) schemaError();
  const applied = db.prepare('SELECT version,checksum FROM erp_ac_migrations ORDER BY version').all();
  if (applied.length !== 1 || applied[0]?.version !== 1 || applied[0]?.checksum !== expected.checksum) schemaError();
  if (db.prepare('PRAGMA foreign_key_check').get()) schemaError();
  return true;
}
const assertionCodes: Record<string, true> = {
  BOOK_IMMUTABLE: true, AUDIT_IMMUTABLE: true, COMMAND_IMMUTABLE: true, INVALID_RECEIPT: true,
  INVALID_TRANSITION: true, JOURNAL_IMMUTABLE: true, ACCOUNT_UNAVAILABLE: true, ACCOUNT_CYCLE: true,
  ACCOUNT_HISTORY: true, PARTY_HISTORY: true, BOOK_REQUIRED: true, INVALID_SEQUENCE: true,
  UNBALANCED: true, INVALID_SNAPSHOT: true, OVER_ALLOCATION: true, ALLOCATION_DATE_CONFLICT: true,
  INVALID_REVERSAL: true, ACTIVE_SETTLEMENT: true, INVALID_SETTLEMENT: true,
};
function safeError(error: unknown): Error {
  if (error instanceof ErpError) return error;
  const value = error as { errcode?: number; message?: string } | null;
  const code = typeof value?.errcode === 'number' ? value.errcode & 255 : undefined;
  if (code === 5 || code === 6) return new ErpError('ACCOUNTING_BUSY', 'Accounting is busy with another writer. Keep your command intent and try again after reloading.');
  if (value?.message && Object.hasOwn(assertionCodes, value.message)) return new ErpError(value.message, 'The accounting operation violates the saved book or journal rules.');
  if (code === 19) return new ErpError('CONFLICT', 'The accounting operation conflicts with saved records or their constraints. Reload before continuing.');
  return new ErpError('ACCOUNTING_STORAGE', 'Accounting storage is unavailable. No successful commit has been confirmed.');
}
function rollback(db: DatabaseSync): void { if (db.isTransaction) db.exec('ROLLBACK'); }

class SqliteAccountingStore implements AccountingStore {
  private closed = false;
  private readonly contexts = new AsyncLocalStorage<{ active: boolean }>();
  constructor(private readonly db: DatabaseSync) {}
  private assertOpen(): void {
    if (this.closed) throw new ErpError('ACCOUNTING_CLOSED', 'The accounting resource is closed.');
    if (this.contexts.getStore()?.active === false) throw new ErpError('ASYNC_TRANSACTION', 'Accounting transaction callbacks must be synchronous.');
  }
  private query<T>(sql: string, execute: (statement: StatementSync) => T): T {
    this.assertOpen();
    try { return execute(this.db.prepare(sql)); } catch (error) { throw safeError(error); }
  }
  get<T = Record<string, unknown>>(sql: string, ...parameters: SqlParameter[]): T | undefined {
    return this.query(sql, (statement) => statement.get(...parameters) as T | undefined);
  }
  all<T = Record<string, unknown>>(sql: string, ...parameters: SqlParameter[]): T[] {
    return this.query(sql, (statement) => statement.all(...parameters) as T[]);
  }
  run(sql: string, ...parameters: SqlParameter[]): WriteResult {
    return this.query(sql, (statement) => {
      const result = statement.run(...parameters);
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    });
  }
  transaction<T>(work: () => T): T {
    this.assertOpen();
    if (this.db.isTransaction) throw new ErpError('NESTED_TRANSACTION', 'Nested accounting transactions are not supported.');
    if (work.constructor.name === 'AsyncFunction' || work.constructor.name === 'AsyncGeneratorFunction') throw new ErpError('ASYNC_TRANSACTION', 'Accounting transaction callbacks must be synchronous.');
    const context = { active: true };
    return this.contexts.run(context, () => {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        const result = work();
        if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
          // Consume a rejected promise without permitting its continuation to use this store.
          void Promise.resolve(result).catch(() => {});
          throw new ErpError('ASYNC_TRANSACTION', 'Accounting transaction callbacks must be synchronous.');
        }
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try { rollback(this.db); } catch { this.closed = true; try { this.db.close(); } catch {} }
        throw safeError(error);
      } finally { context.active = false; }
    });
  }
  close(): void {
    if (this.closed) return;
    this.assertOpen();
    if (this.db.isTransaction) throw new ErpError('ACTIVE_TRANSACTION', 'Close the accounting resource only after its transaction completes.');
    try { this.db.close(); this.closed = true; } catch (error) { throw safeError(error); }
  }
}

export function openAccountingDatabase(filename: string): AccountingStore {
  if (filename === ':memory:' || !existsSync(filename)) schemaError();
  const expected = migration();
  let db: DatabaseSync | undefined;
  try {
    db = database(filename);
    verify(db, expected, false);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA recursive_triggers=ON;');
    return new SqliteAccountingStore(db);
  } catch (error) { db?.close(); throw safeError(error); }
}
export function migrateAccountingDatabase(filename: string): void {
  if (filename === ':memory:') throw new ErpError('INVALID_INPUT', 'Accounting migrations require a durable database filename.');
  const expected = migration();
  let db: DatabaseSync | undefined;
  try {
    db = database(filename);
    // Inspect before any persistent pragma/schema mutation, then repeat under the write lock.
    if (verify(db, expected, true)) return;
    db.exec('BEGIN IMMEDIATE');
    if (!verify(db, expected, true)) {
      db.exec(expected.sql);
      db.prepare('INSERT INTO erp_ac_migrations(version,checksum,appliedAt) VALUES(1,?,?)').run(expected.checksum, new Date().toISOString());
      verify(db, expected, false);
    }
    db.exec('COMMIT');
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
  } catch (error) {
    if (db) { try { rollback(db); } catch {} }
    throw safeError(error);
  } finally { db?.close(); }
}
