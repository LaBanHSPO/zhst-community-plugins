import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { ErpError } from '../validation.js';
import type { AccountingStore, SqlParameter, WriteResult } from './store.js';

const BUSY_TIMEOUT_MS = 250;
const schemaQuery = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
interface SchemaRow { type: string; name: string; tbl_name: string; sql: string }
interface Migration { version: number; sql: string; checksum: string; schema: SchemaRow[] }
let shipped: Migration[] | undefined;

function database(filename: string): DatabaseSync {
  // The pinned Node type declarations predate defensive; supported engines implement it.
  const options = { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false, defensive: true, timeout: BUSY_TIMEOUT_MS };
  const db = new DatabaseSync(filename, options);
  (db as DatabaseSync & { enableDefensive(active: boolean): void }).enableDefensive(true);
  return db;
}
function migrations(): Migration[] {
  if (shipped) return shipped;
  // Source and built modules both sit two levels below the package root.
  const artifacts = ['0001_accounting.sql', '0002_coa_import.sql', '0003_hkd_books.sql'].map((name, index) => {
    const location = new URL(`../../migrations/${name}`, import.meta.url);
    if (!existsSync(location)) throw new ErpError('SCHEMA_VERSION', 'An accounting migration artifact is missing. Install a complete approved package.');
    const sql = readFileSync(location, 'utf8');
    return { version: index + 1, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
  const reference = database(':memory:');
  try {
    // Use the same rebuild SQL and final table names as the durable upgrade.
    reference.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    const chain = artifacts.map((artifact) => {
      reference.exec(artifact.sql);
      return { ...artifact, schema: reference.prepare(schemaQuery).all() as unknown as SchemaRow[] };
    });
    reference.exec('COMMIT; PRAGMA foreign_keys=ON;');
    shipped = chain;
    return chain;
  } finally { reference.close(); }
}
function schemaError(): never {
  throw new ErpError('SCHEMA_VERSION', 'The accounting schema is missing or incompatible. Run the explicit migration with its matching approved artifact.');
}
function verify(db: DatabaseSync, chain: Migration[], allowEmpty: boolean): number {
  const rows = db.prepare(schemaQuery).all() as unknown as SchemaRow[];
  if (rows.length === 0) { if (allowEmpty) return 0; schemaError(); }
  const expected = chain.find((artifact) => rows.length === artifact.schema.length && rows.every((row, index) => {
    const other = artifact.schema[index];
    return other && row.type === other.type && row.name === other.name && row.tbl_name === other.tbl_name && row.sql === other.sql;
  }));
  if (!expected) schemaError();
  const applied = db.prepare('SELECT version,checksum FROM erp_ac_migrations ORDER BY version').all();
  if (applied.length !== expected.version || applied.some((row, index) =>
    row.version !== chain[index]?.version || row.checksum !== chain[index]?.checksum
  )) schemaError();
  if (db.prepare('PRAGMA foreign_key_check').get()) schemaError();
  return applied.length;
}
const assertionCodes: Record<string, true> = {
  BOOK_IMMUTABLE: true, AUDIT_IMMUTABLE: true, COMMAND_IMMUTABLE: true, INVALID_RECEIPT: true,
  INVALID_TRANSITION: true, JOURNAL_IMMUTABLE: true, ACCOUNT_UNAVAILABLE: true, ACCOUNT_CYCLE: true,
  ACCOUNT_HISTORY: true, PARTY_HISTORY: true, BOOK_REQUIRED: true, INVALID_SEQUENCE: true,
  UNBALANCED: true, INVALID_SNAPSHOT: true, OVER_ALLOCATION: true, ALLOCATION_DATE_CONFLICT: true,
  INVALID_REVERSAL: true, ACTIVE_SETTLEMENT: true, INVALID_SETTLEMENT: true,
  COA_IMPORT_IMMUTABLE: true, IDEMPOTENCY_CONFLICT: true,
  HKD_PROFILE_IMMUTABLE: true, HKD_ENTRY_IMMUTABLE: true, HKD_COMMAND_IMMUTABLE: true,
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
  const chain = migrations();
  let db: DatabaseSync | undefined;
  try {
    db = database(filename);
    if (verify(db, chain, false) !== chain.length) schemaError();
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA recursive_triggers=ON;');
    return new SqliteAccountingStore(db);
  } catch (error) { db?.close(); throw safeError(error); }
}
export function migrateAccountingDatabase(filename: string): void {
  if (filename === ':memory:') throw new ErpError('INVALID_INPUT', 'Accounting migrations require a durable database filename.');
  const chain = migrations();
  let db: DatabaseSync | undefined;
  try {
    db = database(filename);
    // Fail closed before changing persistent state. Recheck after taking the lock.
    if (verify(db, chain, true) === chain.length) return;
    // Only this private migration connection disables FK enforcement, and only
    // outside the transaction. Runtime connections always keep it enabled.
    db.exec('PRAGMA foreign_keys=OFF;');
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 0) schemaError();
    db.exec('BEGIN IMMEDIATE');
    const prefix = verify(db, chain, true);
    for (const artifact of chain.slice(prefix)) {
      db.exec(artifact.sql);
      db.prepare('INSERT INTO erp_ac_migrations(version,checksum,appliedAt) VALUES(?,?,?)').run(artifact.version, artifact.checksum, new Date().toISOString());
    }
    // Exact schema, complete checksum chain and all surviving foreign keys must
    // pass while rollback still restores the entire previous prefix.
    if (verify(db, chain, false) !== chain.length) schemaError();
    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  } catch (error) {
    if (db) { try { rollback(db); } catch {} }
    throw safeError(error);
  } finally {
    if (db) {
      try { db.exec('PRAGMA foreign_keys=ON;'); } finally { db.close(); }
    }
  }
}
