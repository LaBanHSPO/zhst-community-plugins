import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Kysely } from 'kysely';
import { PluginStorageRepository, type Database } from 'emdash';
import { createDialect } from 'emdash/db/sqlite';
import { runMigrations } from 'emdash/db';
import { openAccountingDatabase, migrateAccountingDatabase } from '../src/accounting/sqlite.js';
import { AccountingService, executeAccountingAction, validateAccountingActionInput, createErpAccountingSource, ErpError } from '../src/accounting/server.js';
import type { AccountingStore } from '../src/accounting/store.js';
import { ErpService, type ErpStorage } from '../src/service.js';
import type { Currency } from '../src/model.js';
import type { AccountInput, AllocationInput, FinancialResult, Journal, JournalLineInput, SourceSummary } from '../src/accounting/model.js';
import type { RecordView } from '../src/model.js';

const time = '2030-01-01T12:00:00.000Z';
const now = () => new Date(time);
const ids = { asset: '11111111-1111-4111-8111-111111111111', equity: '22222222-2222-4222-8222-222222222222', journal: '33333333-3333-4333-8333-333333333333', customer: '44444444-4444-4444-8444-444444444444' };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'erp-accounting-'));
  const filename = join(directory, 'accounting.db');
  migrateAccountingDatabase(filename);
  const store = openAccountingDatabase(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, filename, store, service: new AccountingService(store, 'admin-1', now) };
}
function errorCode(code: string) {
  return (error: unknown) => error instanceof ErpError && error.code === code;
}
async function crm(t: TestContext, currency: Currency = 'VND') {
  const db = new Kysely<Database>({ dialect: createDialect({ url: ':memory:' }) });
  t.after(() => db.destroy());
  await runMigrations(db);
  const storage: ErpStorage = {
    settings: new PluginStorageRepository(db, 'erp-mini', 'settings', []),
    customers: new PluginStorageRepository(db, 'erp-mini', 'customers', ['nameKey', 'active', ['active', 'nameKey']]),
    items: new PluginStorageRepository(db, 'erp-mini', 'items', ['nameKey', 'active', ['active', 'nameKey']]),
    sales: new PluginStorageRepository(db, 'erp-mini', 'sales', ['hasOrder']),
  };
  return { storage, service: new ErpService(storage, 'admin-1', currency, now), source: createErpAccountingSource(storage, 'admin-1', currency) };
}
function draft(store: AccountingStore) {
  for (const [id, code, root] of [[ids.asset, 'BANK', 'asset'], [ids.equity, 'EQUITY', 'equity']]) {
    store.run('INSERT INTO erp_ac_accounts(id,schemaVersion,revision,code,codeKey,name,nameKey,rootType,purpose,isGroup,parentId,active,createdAt,createdBy,updatedAt,updatedBy) VALUES(?,1,?,?,?,?,?,?,?,0,NULL,1,?,?,?,?)', id!, 'account-r1', code!, code!.toLowerCase(), code!, code!.toLowerCase(), root!, 'general', time, 'admin-1', time, 'admin-1');
  }
  store.run('INSERT INTO erp_ac_journals(id,schemaVersion,revision,kind,status,postingDate,memo,reference,currency,number,postedSequence,postedAt,postedBy,reversalOf,createdAt,createdBy,updatedAt,updatedBy) VALUES(?,1,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?,?,?)', ids.journal, 'journal-r1', 'journal', 'draft', '2030-01-01', 'Synthetic capital', 'TEST', 'VND', time, 'admin-1', time, 'admin-1');
  store.run('INSERT INTO erp_ac_lines(journalId,lineIndex,accountId,partyId,role,accountCode,accountName,accountRootType,accountPurpose,partyCode,partyName,partyKind,debitMinor,creditMinor) VALUES(?,0,?,NULL,?,?,?,?,?,NULL,NULL,NULL,100,0)', ids.journal, ids.asset, 'general', 'BANK', 'BANK', 'asset', 'general');
  store.run('INSERT INTO erp_ac_lines(journalId,lineIndex,accountId,partyId,role,accountCode,accountName,accountRootType,accountPurpose,partyCode,partyName,partyKind,debitMinor,creditMinor) VALUES(?,1,?,NULL,?,?,?,?,?,NULL,NULL,NULL,0,100)', ids.journal, ids.equity, 'general', 'EQUITY', 'EQUITY', 'equity', 'general');
}
function post(store: AccountingStore) {
  store.run("UPDATE erp_ac_journals SET status='posted',revision='posted-r1',number='J-1',postedSequence=1,postedAt=?,postedBy='admin-1' WHERE id=?", time, ids.journal);
}

test('fresh schema is explicit and empty; rerun preserves migration and runtime does not create a missing database', async (t) => {
  const { filename, directory, store, service } = fixture(t);
  assert.equal((await service.info()).book, null);
  assert.equal(store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_accounts')?.count, 0);
  const before = store.all('SELECT * FROM erp_ac_migrations');
  migrateAccountingDatabase(filename);
  assert.deepEqual(store.all('SELECT * FROM erp_ac_migrations'), before);
  const missing = join(directory, 'missing.db');
  assert.throws(() => openAccountingDatabase(missing), errorCode('SCHEMA_VERSION'));
  assert.equal(existsSync(missing), false);
});

test('checksums, newer versions, unknown and missing schema objects fail without changing data', (t) => {
  for (const mutation of ["UPDATE erp_ac_migrations SET checksum='0000000000000000000000000000000000000000000000000000000000000000'", 'UPDATE erp_ac_migrations SET version=3 WHERE version=2', 'CREATE TABLE foreign_data(value TEXT) STRICT', 'DROP TRIGGER erp_ac_settings_update']) {
    const { filename, store } = fixture(t);
    store.close();
    const raw = new DatabaseSync(filename);
    raw.exec(mutation);
    const before = raw.prepare('SELECT * FROM erp_ac_migrations').all();
    const schema = raw.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
    assert.throws(() => migrateAccountingDatabase(filename), errorCode('SCHEMA_VERSION'));
    assert.throws(() => openAccountingDatabase(filename), errorCode('SCHEMA_VERSION'));
    assert.deepEqual(raw.prepare('SELECT * FROM erp_ac_migrations').all(), before);
    assert.deepEqual(raw.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema);
    raw.close();
  }
});

test('migration failure after schema creation rolls back all DDL and recovers a usable latest schema', async (t) => {
  const { directory } = fixture(t); // Loads the shipped artifact before injecting an execution fault.
  const filename = join(directory, 'interrupted.db');
  const original = DatabaseSync.prototype.exec;
  let interrupted = false;
  DatabaseSync.prototype.exec = function (sql: string) {
    original.call(this, sql);
    if (!interrupted && this.isTransaction && this.prepare("SELECT 1 FROM sqlite_schema WHERE name='erp_ac_settings'").get()) {
      interrupted = true;
      throw new Error('Synthetic migration interruption');
    }
  };
  try { assert.throws(() => migrateAccountingDatabase(filename), errorCode('ACCOUNTING_STORAGE')); }
  finally { DatabaseSync.prototype.exec = original; }
  assert.equal(interrupted, true);
  const raw = new DatabaseSync(filename);
  assert.equal(raw.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()?.count, 0);
  raw.close();
  migrateAccountingDatabase(filename);
  const recovered = openAccountingDatabase(filename);
  try {
    assert.deepEqual(recovered.all<{ version: number }>('SELECT version FROM erp_ac_migrations ORDER BY version').map((row) => row.version), [1, 2]);
    assert.deepEqual(recovered.all('PRAGMA foreign_key_check'), []);
    const service = new AccountingService(recovered, 'admin-1', now);
    await service.configureBook({ startDate: '2030-01-01' });
    const account = await service.saveAccount({ id: globalThis.crypto.randomUUID(), revision: null, code: '911', name: 'Synthetic result', rootType: 'result', purpose: 'general', isGroup: false, parentId: null, active: true });
    assert.equal(account.value.rootType, 'result');
    assert.deepEqual((await service.get({ entity: 'accounts', id: account.id })).value, account.value);
  } finally { recovered.close(); }
});

test('setup validates real calendar input and creates immutable server metadata and audit once', async (t) => {
  const { store, service } = fixture(t);
  for (const input of [{}, { startDate: '2030-02-29' }, { startDate: '2030-04-31' }, { startDate: '0000-01-01' }, { startDate: '2030-01-01', actorId: 'forged' }, { startDate: '2030-01-01', currency: 'USD' }]) await assert.rejects(service.configureBook(input), errorCode('INVALID_INPUT'));
  assert.equal(store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_audit')?.count, 0);
  const book = await service.configureBook({ startDate: '2028-02-29' });
  assert.equal(book.value.createdAt, time);
  assert.equal(book.value.createdBy, 'admin-1');
  assert.equal(book.value.currency, 'VND');
  assert.equal(book.value.minorUnits, 0);
  assert.match(book.value.installationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual((await service.info()).book, book);
  const audit = store.get<{ actorId: string; revision: string; event: string }>('SELECT actorId,revision,event FROM erp_ac_audit');
  assert.deepEqual({ ...audit }, { actorId: 'admin-1', revision: book.revision, event: 'configure-book' });
  await assert.rejects(service.configureBook({ startDate: '2030-01-01' }), errorCode('CONFLICT'));
  assert.throws(() => store.run("UPDATE erp_ac_settings SET startDate='2031-01-01'"), errorCode('BOOK_IMMUTABLE'));
  assert.throws(() => store.run('DELETE FROM erp_ac_settings'), errorCode('BOOK_IMMUTABLE'));
  assert.throws(() => store.run("UPDATE erp_ac_audit SET actorId='other'"), errorCode('AUDIT_IMMUTABLE'));
  assert.throws(() => store.run('DELETE FROM erp_ac_audit'), errorCode('AUDIT_IMMUTABLE'));
});

test('independent setup contenders produce one book and one atomic audit, and audit faults roll back settings', async (t) => {
  const { filename, store, service } = fixture(t);
  const second = openAccountingDatabase(filename);
  t.after(() => second.close());
  const results = await Promise.allSettled([service.configureBook({ startDate: '2030-01-01' }), new AccountingService(second, 'admin-2', now).configureBook({ startDate: '2031-01-01' })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && errorCode('CONFLICT')(result.reason)).length, 1);
  assert.equal(store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_settings')?.count, 1);
  assert.equal(store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_audit')?.count, 1);
  const fresh = fixture(t);
  const injected: AccountingStore = {
    get: fresh.store.get.bind(fresh.store), all: fresh.store.all.bind(fresh.store), transaction: fresh.store.transaction.bind(fresh.store), close: fresh.store.close.bind(fresh.store),
    run(sql, ...parameters) { if (sql.startsWith('INSERT INTO erp_ac_audit')) throw new Error('Synthetic audit failure'); return fresh.store.run(sql, ...parameters); },
  };
  await assert.rejects(new AccountingService(injected, 'admin-1', now).configureBook({ startDate: '2030-01-01' }));
  assert.equal((await fresh.service.info()).book, null);
  assert.equal(fresh.store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_audit')?.count, 0);
});

test('sync transactions roll back faults, reject nested/async/thenable work and fence rejected continuations', async (t) => {
  const { store } = fixture(t);
  const write = () => store.run("INSERT INTO erp_ac_audit(id,entity,recordId,journalId,event,actorId,occurredAt,revision,postedSequence) VALUES(?,'book','book',NULL,'test','admin-1',?,'r1',NULL)", globalThis.crypto.randomUUID(), time);
  assert.throws(() => store.transaction(() => { write(); throw new Error('fault'); }), errorCode('ACCOUNTING_STORAGE'));
  assert.throws(() => store.transaction(() => store.transaction(write)), errorCode('NESTED_TRANSACTION'));
  let called = false;
  assert.throws(() => store.transaction(async () => { called = true; write(); }), errorCode('ASYNC_TRANSACTION'));
  assert.equal(called, false);
  let continuationError: unknown;
  assert.throws(() => store.transaction(() => {
    write();
    return Promise.resolve().then(() => { try { write(); } catch (error) { continuationError = error; } });
  }), errorCode('ASYNC_TRANSACTION'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(errorCode('ASYNC_TRANSACTION')(continuationError));
  assert.equal(store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_audit')?.count, 0);
  store.transaction(write);
  assert.equal(store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_audit')?.count, 1);
});

test('two independent connections use a database writer fence and isolate uncommitted changes', (t) => {
  const { filename, store } = fixture(t);
  const second = openAccountingDatabase(filename);
  t.after(() => second.close());
  store.transaction(() => {
    store.run("INSERT INTO erp_ac_audit(id,entity,recordId,journalId,event,actorId,occurredAt,revision,postedSequence) VALUES(?,'book','book',NULL,'test','admin-1',?,'r1',NULL)", ids.asset, time);
    assert.equal(second.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_audit')?.count, 0);
    assert.throws(() => second.transaction(() => {}), errorCode('ACCOUNTING_BUSY'));
  });
  assert.equal(second.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_audit')?.count, 1);
  second.transaction(() => {});
  assert.equal(store.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys, 1);
  assert.equal(store.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode, 'wal');
});

test('book persistence survives close/reopen and separate database files do not share an installation', async (t) => {
  const first = fixture(t);
  const second = fixture(t);
  const book = await first.service.configureBook({ startDate: '2030-01-01' });
  assert.equal((await second.service.info()).book, null);
  first.store.close(); first.store.close();
  assert.throws(() => first.store.get('SELECT 1'), errorCode('ACCOUNTING_CLOSED'));
  const reopened = openAccountingDatabase(first.filename);
  t.after(() => reopened.close());
  assert.deepEqual((await new AccountingService(reopened, 'admin-1', now).info()).book, book);
  assert.equal(reopened.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_audit')?.count, 1);
});

test('normalized schema rejects invalid money/unbalanced/direct-post writes and freezes posted history and receipts', async (t) => {
  const { store, service } = fixture(t);
  await service.configureBook({ startDate: '2030-01-01' });
  store.transaction(() => draft(store));
  assert.throws(() => store.run('UPDATE erp_ac_lines SET debitMinor=1000000000001 WHERE journalId=? AND lineIndex=0', ids.journal), errorCode('CONFLICT'));
  assert.throws(() => store.run('UPDATE erp_ac_lines SET debitMinor=0.5 WHERE journalId=? AND lineIndex=0', ids.journal));
  assert.throws(() => store.run('UPDATE erp_ac_lines SET creditMinor=1 WHERE journalId=? AND lineIndex=0', ids.journal), errorCode('CONFLICT'));
  store.run('UPDATE erp_ac_lines SET creditMinor=99 WHERE journalId=? AND lineIndex=1', ids.journal);
  assert.throws(() => store.transaction(() => post(store)), errorCode('UNBALANCED'));
  assert.equal(store.get<{ status: string }>('SELECT status FROM erp_ac_journals WHERE id=?', ids.journal)?.status, 'draft');
  store.run('UPDATE erp_ac_lines SET creditMinor=100 WHERE journalId=? AND lineIndex=1', ids.journal);
  const rawPostedInsert = "INSERT INTO erp_ac_journals SELECT '55555555-5555-4555-8555-555555555555',schemaVersion,revision,kind,'posted',postingDate,memo,reference,currency,'FORGED',99,createdAt,createdBy,reversalOf,createdAt,createdBy,updatedAt,updatedBy FROM erp_ac_journals WHERE id=?";
  assert.throws(() => store.run(rawPostedInsert, ids.journal), errorCode('INVALID_TRANSITION'));
  store.transaction(() => {
    post(store);
    store.run('INSERT INTO erp_ac_commands(commandId,action,actorId,canonicalPayloadHash,journalId,revision,postedSequence,createdAt) VALUES(?,?,?,?,?,?,?,?)', ids.customer, 'post-journal', 'admin-1', 'a'.repeat(64), ids.journal, 'posted-r1', 1, time);
  });
  assert.throws(() => store.run("UPDATE erp_ac_journals SET memo='changed' WHERE id=?", ids.journal), errorCode('JOURNAL_IMMUTABLE'));
  assert.throws(() => store.run('DELETE FROM erp_ac_journals WHERE id=?', ids.journal), errorCode('JOURNAL_IMMUTABLE'));
  assert.throws(() => store.run('UPDATE erp_ac_lines SET debitMinor=99 WHERE journalId=? AND lineIndex=0', ids.journal), errorCode('JOURNAL_IMMUTABLE'));
  assert.throws(() => store.run("INSERT INTO erp_ac_lines(journalId,lineIndex,accountId,role,debitMinor,creditMinor) VALUES(?,2,?,'general',1,0)", ids.journal, ids.asset), errorCode('JOURNAL_IMMUTABLE'));
  assert.throws(() => store.run('DELETE FROM erp_ac_lines WHERE journalId=?', ids.journal), errorCode('JOURNAL_IMMUTABLE'));
  assert.throws(() => store.run("UPDATE erp_ac_accounts SET purpose='cash' WHERE id=?", ids.asset), errorCode('ACCOUNT_HISTORY'));
  assert.throws(() => store.run("UPDATE erp_ac_commands SET actorId='other'"), errorCode('COMMAND_IMMUTABLE'));
  assert.throws(() => store.run('DELETE FROM erp_ac_commands'), errorCode('COMMAND_IMMUTABLE'));
});

test('dispatcher preflight rejects forged input before CRM initialization and sanitizes unexpected failures', async (t) => {
  const { service } = fixture(t);
  const { storage, source } = await crm(t);
  assert.throws(() => validateAccountingActionInput('info', {}), errorCode('INVALID_INPUT'));
  assert.throws(() => validateAccountingActionInput('__proto__', {}), errorCode('INVALID_ACTION'));
  const invalid = await executeAccountingAction(service, 'configure-book', { startDate: '2030-01-01', actorId: 'forged' }, source);
  assert.equal(invalid.ok, false);
  assert.equal(await storage.settings.getVersioned('configuration'), null);
  const info = await executeAccountingAction(service, 'info', undefined, source);
  assert.equal(info.ok, true);
  assert.equal(await storage.settings.getVersioned('configuration'), null);
  const result = await executeAccountingAction(service, 'configure-book', { startDate: '2030-01-01' }, source);
  assert.equal(result.ok, true);
  assert.ok(await storage.settings.getVersioned('configuration'));
  const failing: AccountingStore = { get() { throw new Error('SQL /private/path/session-secret'); }, all() { return []; }, run() { throw new Error('unexpected'); }, transaction(work) { return work(); }, close() {} };
  assert.deepEqual(await executeAccountingAction(new AccountingService(failing, 'admin-1', now), 'info', undefined), { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Accounting could not complete the request. No successful commit has been confirmed.' } });
});

test('CRM source allows read-only missing info, initializes only setup, validates currency/schema and exact active customer revision', async (t) => {
  const { storage, source, service } = await crm(t);
  await source.checkCurrency(false, true);
  await assert.rejects(source.checkCurrency(false), errorCode('BOOK_REQUIRED'));
  assert.equal(await storage.settings.getVersioned('configuration'), null);
  await source.checkCurrency(true);
  const input = { id: ids.customer, revision: null, code: 'VN-TEST', name: 'Synthetic Company', email: '', phone: '', address: '', contacts: [], active: true };
  const customer = await service.saveCustomer(input);
  assert.deepEqual(await source.customer(customer.id, customer.revision), { code: 'VN-TEST', name: 'Synthetic Company', sourceKind: 'customer', sourceId: customer.id, sourceRevision: customer.revision });
  await assert.rejects(source.customer(customer.id, 'stale'), errorCode('CONFLICT'));
  const archived = await service.saveCustomer({ ...input, revision: customer.revision, active: false });
  await assert.rejects(source.customer(customer.id, archived.revision), errorCode('ARCHIVED_MASTER'));
  await assert.rejects(createErpAccountingSource(storage, 'admin-1', 'USD').checkCurrency(false, true), errorCode('CURRENCY_MISMATCH'));
  const saved = await storage.settings.getVersioned('configuration');
  assert.ok(saved);
  await storage.settings.compareAndSet('configuration', saved.revision, { ...(saved.value as object), schemaVersion: 99 });
  await assert.rejects(source.checkCurrency(false), errorCode('SCHEMA_VERSION'));
  const usd = await crm(t, 'USD');
  await usd.service.info();
  await assert.rejects(createErpAccountingSource(usd.storage, 'admin-1', 'VND').checkCurrency(true), errorCode('CURRENCY_MISMATCH'));
});

async function domain(t: TestContext) {
  const fixtureValue = fixture(t);
  await fixtureValue.service.configureBook({ startDate: '2030-01-01' });
  const accounts = {} as Record<'bank' | 'ar' | 'ap' | 'income' | 'expense' | 'equity', Awaited<ReturnType<AccountingService['saveAccount']>>>;
  for (const [key, rootType, purpose] of [
    ['bank', 'asset', 'bank'], ['ar', 'asset', 'receivable'], ['ap', 'liability', 'payable'],
    ['income', 'income', 'general'], ['expense', 'expense', 'general'], ['equity', 'equity', 'general'],
  ] as const) accounts[key] = await fixtureValue.service.saveAccount({ id: globalThis.crypto.randomUUID(), revision: null, code: key.toUpperCase(), name: key, rootType, purpose, isGroup: false, parentId: null, active: true });
  const customer = await fixtureValue.service.saveParty({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'customer', code: 'CUST', name: 'Synthetic customer', active: true });
  const supplier = await fixtureValue.service.saveParty({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'supplier', code: 'SUPP', name: 'Synthetic supplier', active: true });
  return { ...fixtureValue, accounts, customer, supplier };
}
function inputLine(accountId: string, debitMinor: number, creditMinor: number, partyId: string | null = null, allocations: AllocationInput[] = []): JournalLineInput {
  return { accountId, debitMinor, creditMinor, partyId, allocations };
}
async function entry(service: AccountingService, lines: JournalLineInput[], postingDate = '2030-01-10') {
  const draft = await service.saveJournal({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'journal', postingDate, memo: 'Synthetic journal', reference: 'TEST', lines });
  const command = { id: draft.id, revision: draft.revision, commandId: globalThis.crypto.randomUUID() };
  const result = await service.postJournal(command);
  return { draft, command, result, journal: await service.get({ entity: 'journals', id: result.id }) as RecordView<Journal> };
}
function balances(store: AccountingStore): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const line of store.all<{ accountId: string; debitMinor: number; creditMinor: number }>("SELECT l.accountId,l.debitMinor,l.creditMinor FROM erp_ac_lines l JOIN erp_ac_journals j ON j.id=l.journalId WHERE j.status='posted'")) result.set(line.accountId, (result.get(line.accountId) ?? 0n) + BigInt(line.debitMinor) - BigInt(line.creditMinor));
  return result;
}
async function writerRace(t: TestContext, filename: string, commands: { id: string; revision: string; commandId: string }[]) {
  const children = commands.map(() => fork(fileURLToPath(new URL('./accounting-writer.mjs', import.meta.url)), [filename, 'admin-1'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(() => { for (const child of children) if (!child.killed) child.kill(); });
  const outcomes = children.map((child) => new Promise<{ ok: boolean; code?: string; result?: FinancialResult }>((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.on('message', (message) => {
      if (message && typeof message === 'object' && 'ok' in message) resolve(message as { ok: boolean; code?: string; result?: FinancialResult });
    });
    child.once('exit', (code) => { if (code !== 0) reject(new Error(`Accounting writer exited ${code}: ${stderr}`)); });
  }));
  await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Writer exited before barrier: ${code}`)));
    child.once('message', (message) => {
      if (message && typeof message === 'object' && 'ready' in message) resolve();
      else reject(new Error('Writer did not reach the start barrier.'));
    });
  })));
  children.forEach((child, index) => child.send(commands[index]!));
  return Promise.all(outcomes);
}

test('master tree, normalized uniqueness, revision conflicts and atomic audit protect usable accounts', async (t) => {
  const { store, service, accounts } = await domain(t);
  const groupInput: AccountInput = { id: globalThis.crypto.randomUUID(), revision: null, code: ' Assets ', name: 'Assets', rootType: 'asset', purpose: 'general', isGroup: true, parentId: null, active: true };
  const group = await service.saveAccount(groupInput);
  const child = await service.saveAccount({ ...groupInput, id: globalThis.crypto.randomUUID(), code: 'CHILD', name: 'Child group', parentId: group.id });
  await assert.rejects(service.saveAccount({ ...groupInput, id: globalThis.crypto.randomUUID(), code: 'ＡＳＳＥＴＳ' }), errorCode('CONFLICT'));
  await assert.rejects(service.saveAccount({ ...groupInput, revision: group.revision, parentId: child.id }), errorCode('ACCOUNT_CYCLE'));
  await assert.rejects(service.saveAccount({ ...groupInput, revision: group.revision, isGroup: false }), errorCode('ACCOUNT_UNAVAILABLE'));
  for (const override of [{ purpose: 'bank' }, { rootType: 'income', purpose: 'receivable', isGroup: false }, { purpose: 'payable', isGroup: false }, { parentId: accounts.bank.id }]) await assert.rejects(service.saveAccount({ ...groupInput, id: globalThis.crypto.randomUUID(), code: globalThis.crypto.randomUUID(), ...override }), errorCode('ACCOUNT_UNAVAILABLE'));
  // Send only editable fields; server metadata is never a form field.
  const editable = { id: accounts.bank.id, revision: accounts.bank.revision, code: accounts.bank.value.code, name: accounts.bank.value.name, rootType: accounts.bank.value.rootType, purpose: accounts.bank.value.purpose, isGroup: accounts.bank.value.isGroup, parentId: group.id, active: accounts.bank.value.active };
  const results = await Promise.allSettled([service.saveAccount({ ...editable, name: 'Editor one' }), service.saveAccount({ ...editable, name: 'Editor two' })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && errorCode('CONFLICT')(result.reason)).length, 1);
  const current = await service.get({ entity: 'accounts', id: accounts.bank.id });
  assert.equal(current.value.updatedBy, 'admin-1');
  assert.equal(store.get<{ count: number }>("SELECT count(*) AS count FROM erp_ac_audit WHERE recordId=? AND event='save-account'", accounts.bank.id)?.count, 2);
  const disabled = await service.saveAccount({ ...groupInput, revision: group.revision, active: false });
  assert.equal(disabled.value.active, false);
  await assert.rejects(service.saveAccount({ ...editable, revision: current.revision }), errorCode('ACCOUNT_UNAVAILABLE'));
  const before = store.all('SELECT * FROM erp_ac_accounts');
  const fault: AccountingStore = { get: store.get.bind(store), all: store.all.bind(store), transaction: store.transaction.bind(store), close() {}, run(sql, ...parameters) { if (sql.startsWith('INSERT INTO erp_ac_audit')) throw new Error('Synthetic master audit fault'); return store.run(sql, ...parameters); } };
  await assert.rejects(new AccountingService(fault, 'admin-1', now).saveAccount({ ...groupInput, id: globalThis.crypto.randomUUID(), code: 'FAULT' }));
  assert.deepEqual(store.all('SELECT * FROM erp_ac_accounts'), before);
});

test('CRM link reads an exact source revision outside the writer transaction and never dual writes or rewrites history', async (t) => {
  const { service, store, accounts } = await domain(t);
  const crmValue = await crm(t);
  const customerInput = { id: globalThis.crypto.randomUUID(), revision: null, code: 'CRM', name: 'CRM snapshot', email: '', phone: '', address: '', contacts: [], active: true };
  const customer = await crmValue.service.saveCustomer(customerInput);
  const link = { id: globalThis.crypto.randomUUID(), revision: null, customerId: customer.id, customerRevision: customer.revision };
  await assert.rejects(service.linkCustomer({ ...link, customerRevision: 'stale' }, crmValue.source), errorCode('CONFLICT'));
  const linked = await service.linkCustomer(link, crmValue.source);
  assert.equal(linked.value.name, 'CRM snapshot');
  assert.equal(linked.value.sourceRevision, customer.revision);
  assert.equal((await crmValue.storage.customers.getVersioned(customer.id))?.revision, customer.revision);
  await assert.rejects(service.linkCustomer({ ...link, id: globalThis.crypto.randomUUID() }, crmValue.source), errorCode('CONFLICT'));
  await assert.rejects(service.saveParty({ id: linked.id, revision: linked.revision, kind: 'supplier', code: 'CRM', name: 'Changed kind', active: true }), errorCode('PARTY_HISTORY'));
  assert.throws(() => store.run('INSERT OR REPLACE INTO erp_ac_parties SELECT * FROM erp_ac_parties WHERE id=?', linked.id), errorCode('PARTY_HISTORY'));
  const source = await entry(service, [inputLine(accounts.ar.id, 100, 0, linked.id), inputLine(accounts.income.id, 0, 100)]);
  await crmValue.service.saveCustomer({ ...customerInput, revision: customer.revision, name: 'Changed CRM', active: false });
  const renamed = await service.saveParty({ id: linked.id, revision: linked.revision, kind: 'customer', code: 'CRM-NEW', name: 'Accounting rename', active: false });
  const saved = await service.get({ entity: 'journals', id: source.result.id }) as RecordView<Journal>;
  assert.equal(saved.value.lines[0]?.party?.name, 'CRM snapshot');
  const disabledParty = await service.get({ entity: 'parties', id: renamed.id });
  assert.ok('active' in disabledParty.value);
  assert.equal(disabledParty.value.active, false);
  assert.throws(() => store.run("UPDATE erp_ac_parties SET sourceRevision='forged' WHERE id=?", linked.id), errorCode('PARTY_HISTORY'));
  let reading = false;
  const guardedSource = { checkCurrency: crmValue.source.checkCurrency.bind(crmValue.source), async customer() { reading = true; store.transaction(() => {}); return { code: 'OUTSIDE', name: 'Read before write', sourceKind: 'customer' as const, sourceId: globalThis.crypto.randomUUID(), sourceRevision: 'source-r1' }; } };
  await service.linkCustomer({ ...link, id: globalThis.crypto.randomUUID() }, guardedSource);
  assert.equal(reading, true);
});

test('opening is balanced at startDate, drafts have zero ledger effect, cancellation cannot revive and stale draft saves lose', async (t) => {
  const { service, store, accounts, customer } = await domain(t);
  const lines = [inputLine(accounts.bank.id, 2_000_000, 0), inputLine(accounts.ar.id, 400_000, 0, customer.id), inputLine(accounts.equity.id, 0, 2_400_000)];
  const input = { id: globalThis.crypto.randomUUID(), revision: null, kind: 'opening', postingDate: '2030-01-01', memo: 'Opening', reference: 'OPEN', lines };
  await assert.rejects(service.saveJournal({ ...input, postingDate: '2030-01-02' }), errorCode('INVALID_INPUT'));
  const draftValue = await service.saveJournal(input);
  assert.equal(balances(store).size, 0);
  assert.equal((await service.list({ entity: 'sources' })).items.length, 0);
  assert.equal((await service.report({ type: 'journal', from: '2030-01-01', to: '2030-12-31' })).items.length, 0);
  const competitors = await Promise.allSettled([service.saveJournal({ ...input, revision: draftValue.revision, memo: 'One' }), service.saveJournal({ ...input, revision: draftValue.revision, memo: 'Two' })]);
  assert.equal(competitors.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(competitors.filter((result) => result.status === 'rejected' && errorCode('CONFLICT')(result.reason)).length, 1);
  const current = await service.get({ entity: 'journals', id: draftValue.id });
  const result = await service.postJournal({ id: current.id, revision: current.revision, commandId: globalThis.crypto.randomUUID() });
  assert.equal(result.postedSequence, 1);
  assert.equal(balances(store).get(accounts.bank.id), 2_000_000n);
  assert.equal(balances(store).get(accounts.ar.id), 400_000n);
  assert.equal(balances(store).get(accounts.income.id), undefined);
  const source = (await service.list({ entity: 'sources', partyId: customer.id })).items[0]!.value as SourceSummary;
  assert.equal(source.originalMinor, '400000');
  const cancelInput = { ...input, id: globalThis.crypto.randomUUID() };
  const cancelledDraft = await service.saveJournal(cancelInput);
  const cancelled = await service.cancelDraft({ id: cancelledDraft.id, revision: cancelledDraft.revision });
  await assert.rejects(service.saveJournal({ ...cancelInput, revision: cancelled.revision }), errorCode('INVALID_TRANSITION'));
  await assert.rejects(service.postJournal({ id: cancelled.id, revision: cancelled.revision, commandId: globalThis.crypto.randomUUID() }), errorCode('INVALID_TRANSITION'));
  assert.equal((await service.list({ entity: 'journals', status: 'draft' })).items.length, 0);
  assert.equal(balances(store).get(accounts.bank.id), 2_000_000n);
});

test('invalid money, balance, accounts, parties and forged financial fields fail without side effects; post revalidates the active tree', async (t) => {
  const { service, store, accounts, customer, supplier } = await domain(t);
  const base = { id: globalThis.crypto.randomUUID(), revision: null, kind: 'journal', postingDate: '2030-01-10', memo: '', reference: '', lines: [inputLine(accounts.ar.id, 100, 0, customer.id), inputLine(accounts.income.id, 0, 100)] };
  for (const lines of [[inputLine(accounts.ar.id, 100, 0)], [inputLine(accounts.ar.id, 100.5, 0, customer.id), inputLine(accounts.income.id, 0, 100.5)], [inputLine(accounts.ar.id, 100, 1, customer.id), inputLine(accounts.income.id, 0, 100)], [inputLine(accounts.ar.id, 1_000_000_000_001, 0, customer.id), inputLine(accounts.income.id, 0, 1_000_000_000_001)]]) await assert.rejects(service.saveJournal({ ...base, lines }), errorCode('INVALID_INPUT'));
  await assert.rejects(service.saveJournal({ ...base, lines: [inputLine(accounts.ar.id, 100, 0, customer.id), inputLine(accounts.income.id, 0, 99)] }), errorCode('UNBALANCED'));
  for (const partyId of [null, supplier.id]) await assert.rejects(service.saveJournal({ ...base, lines: [inputLine(accounts.ar.id, 100, 0, partyId), base.lines[1]!] }), errorCode('PARTY_REQUIRED'));
  await assert.rejects(service.saveJournal({ ...base, lines: [inputLine(accounts.bank.id, 100, 0, customer.id), base.lines[1]!] }), errorCode('PARTY_REQUIRED'));
  await assert.rejects(service.saveJournal({ ...base, lines: [{ ...base.lines[0]!, role: 'general' }, base.lines[1]!] }), errorCode('INVALID_INPUT'));
  const group = await service.saveAccount({ id: globalThis.crypto.randomUUID(), revision: null, code: 'ASSET-GROUP', name: 'Assets', rootType: 'asset', purpose: 'general', isGroup: true, parentId: null, active: true });
  await assert.rejects(service.saveJournal({ ...base, lines: [inputLine(group.id, 100, 0), base.lines[1]!] }), errorCode('ACCOUNT_UNAVAILABLE'));
  const arInput = { id: accounts.ar.id, revision: accounts.ar.revision, code: 'AR', name: 'ar', rootType: 'asset', purpose: 'receivable', isGroup: false, parentId: group.id, active: true };
  await service.saveAccount(arInput);
  const draftValue = await service.saveJournal(base);
  await service.saveAccount({ id: group.id, revision: group.revision, code: 'ASSET-GROUP', name: 'Assets', rootType: 'asset', purpose: 'general', isGroup: true, parentId: null, active: false });
  await assert.rejects(service.postJournal({ id: draftValue.id, revision: draftValue.revision, commandId: globalThis.crypto.randomUUID() }), errorCode('ACCOUNT_UNAVAILABLE'));
  assert.throws(() => store.run("UPDATE erp_ac_journals SET status='posted',revision='raw-post',number='RAW',postedSequence=1,postedAt=?,postedBy='admin-1' WHERE id=?", time, draftValue.id), errorCode('ACCOUNT_UNAVAILABLE'));
  assert.equal(balances(store).size, 0);
  assert.equal(store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_commands')?.count, 0);
  const payloads = {
    'save-account': { id: globalThis.crypto.randomUUID(), revision: null, code: 'FAKE', name: 'Fake', rootType: 'asset', purpose: 'general', isGroup: false, parentId: null, active: true },
    'save-party': { id: globalThis.crypto.randomUUID(), revision: null, kind: 'customer', code: 'FAKE', name: 'Fake', active: true },
    'link-customer': { id: globalThis.crypto.randomUUID(), revision: null, customerId: customer.id, customerRevision: customer.revision },
    'save-journal': base, 'cancel-draft': { id: draftValue.id, revision: draftValue.revision },
    'post-journal': { id: draftValue.id, revision: draftValue.revision, commandId: globalThis.crypto.randomUUID() },
    'reverse-journal': { id: draftValue.id, revision: draftValue.revision, commandId: globalThis.crypto.randomUUID(), postingDate: '2030-01-10', memo: '' },
    'save-settlement': { id: globalThis.crypto.randomUUID(), revision: null, kind: 'receipt', postingDate: '2030-01-10', memo: '', reference: '', moneyAccountId: accounts.bank.id, partyId: customer.id, allocations: [{ sourceJournalId: draftValue.id, sourceLineIndex: 0, amountMinor: 100 }] },
    list: { entity: 'sources' }, get: { entity: 'journals', id: draftValue.id }, report: { type: 'trial-balance', from: '2030-01-01', to: '2030-01-31' },
  };
  for (const [action, payload] of Object.entries(payloads)) assert.throws(() => validateAccountingActionInput(action, { ...payload, actorId: 'forged' }), errorCode('INVALID_INPUT'));
  await assert.rejects(new AccountingService(store, '', now).saveJournal(base), errorCode('AUTH_REQUIRED'));
});

test('post snapshots survive master renames/disable, structural history is locked, and exact reversal can use disabled masters', async (t) => {
  const { service, store, accounts, customer } = await domain(t);
  const source = await entry(service, [inputLine(accounts.ar.id, 1_000_000, 0, customer.id), inputLine(accounts.income.id, 0, 1_000_000)]);
  const ar = await service.saveAccount({ id: accounts.ar.id, revision: accounts.ar.revision, code: 'AR-NEW', name: 'Renamed receivable', rootType: 'asset', purpose: 'receivable', isGroup: false, parentId: null, active: false });
  await service.saveParty({ id: customer.id, revision: customer.revision, kind: 'customer', code: 'CUST-NEW', name: 'Renamed customer', active: false });
  await assert.rejects(service.saveAccount({ id: ar.id, revision: ar.revision, code: ar.value.code, name: ar.value.name, rootType: 'asset', purpose: 'general', isGroup: false, parentId: null, active: false }), errorCode('ACCOUNT_HISTORY'));
  const party = await service.get({ entity: 'parties', id: customer.id });
  await assert.rejects(service.saveParty({ id: party.id, revision: party.revision, kind: 'supplier', code: 'CUST', name: 'Changed kind', active: false }), errorCode('PARTY_HISTORY'));
  const journal = await service.get({ entity: 'journals', id: source.result.id }) as RecordView<Journal>;
  assert.equal(journal.value.lines[0]?.account?.code, 'AR');
  assert.equal(journal.value.lines[0]?.party?.name, 'Synthetic customer');
  const reversal = await service.reverseJournal({ id: source.result.id, revision: source.result.revision, commandId: globalThis.crypto.randomUUID(), postingDate: '2030-01-10', memo: 'Exact reversal' });
  const reverseValue = await service.get({ entity: 'journals', id: reversal.id }) as RecordView<Journal>;
  assert.equal(reverseValue.value.lines[0]?.account?.code, 'AR');
  assert.equal(reverseValue.value.lines[0]?.party?.name, 'Synthetic customer');
  assert.equal(reverseValue.value.lines[0]?.role, 'reversal');
  assert.equal(balances(store).get(accounts.ar.id), 0n);
  assert.equal((await service.list({ entity: 'sources' })).items.length, 0);
  assert.throws(() => store.run('UPDATE erp_ac_lines SET debitMinor=1 WHERE journalId=? AND lineIndex=0', reversal.id), errorCode('JOURNAL_IMMUTABLE'));
});

test('receivable/payable partial helpers balance, reserve future capacity, reject mismatches and replay immutable results after later reversals', async (t) => {
  const { service, store, filename, accounts, customer, supplier } = await domain(t);
  const ar = await entry(service, [inputLine(accounts.ar.id, 1_000_000, 0, customer.id), inputLine(accounts.income.id, 0, 1_000_000)]);
  const ap = await entry(service, [inputLine(accounts.expense.id, 800_000, 0), inputLine(accounts.ap.id, 0, 800_000, supplier.id)]);
  const receiptInput = { id: globalThis.crypto.randomUUID(), revision: null, kind: 'receipt', postingDate: '2030-01-20', memo: '', reference: 'Receipt', moneyAccountId: accounts.bank.id, partyId: customer.id, allocations: [{ sourceJournalId: ar.result.id, sourceLineIndex: 0, amountMinor: 600_000 }] };
  const receiptDraft = await service.saveSettlement(receiptInput);
  assert.equal(receiptDraft.value.lines[0]?.account?.purpose, 'bank');
  assert.equal(receiptDraft.value.lines.length, 2);
  assert.equal(balances(store).get(accounts.bank.id), undefined);
  const command = { id: receiptDraft.id, revision: receiptDraft.revision, commandId: globalThis.crypto.randomUUID() };
  const receipt = await service.postJournal(command);
  assert.deepEqual(await service.postJournal(command), receipt);
  for (const changed of [{ ...command, revision: 'changed' }, { ...command, id: ap.result.id }]) await assert.rejects(service.postJournal(changed), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(new AccountingService(store, 'another-admin', now).postJournal(command), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(service.reverseJournal({ ...command, postingDate: '2030-01-20', memo: '' }), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.run('UPDATE erp_ac_allocations SET amountMinor=1 WHERE settlementJournalId=?', receipt.id), errorCode('JOURNAL_IMMUTABLE'));
  assert.throws(() => store.run('DELETE FROM erp_ac_allocations WHERE settlementJournalId=?', receipt.id), errorCode('JOURNAL_IMMUTABLE'));
  const paymentDraft = await service.saveSettlement({ ...receiptInput, id: globalThis.crypto.randomUUID(), kind: 'payment', partyId: supplier.id, allocations: [{ sourceJournalId: ap.result.id, sourceLineIndex: 1, amountMinor: 300_000 }] });
  await service.postJournal({ id: paymentDraft.id, revision: paymentDraft.revision, commandId: globalThis.crypto.randomUUID() });
  const balance = balances(store);
  assert.equal(balance.get(accounts.ar.id), 400_000n);
  assert.equal(balance.get(accounts.ap.id), -500_000n);
  assert.equal(balance.get(accounts.bank.id), 300_000n);
  assert.equal(balance.get(accounts.income.id), -1_000_000n);
  assert.equal(balance.get(accounts.expense.id), 800_000n);
  const remaining = (await service.list({ entity: 'sources', partyId: customer.id })).items[0]!.value as SourceSummary;
  assert.equal(remaining.remainingMinor, '400000');
  await assert.rejects(service.saveSettlement({ ...receiptInput, id: globalThis.crypto.randomUUID(), allocations: [{ sourceJournalId: ar.result.id, sourceLineIndex: 0, amountMinor: 400_001 }] }), errorCode('OVER_ALLOCATION'));
  await assert.rejects(service.saveSettlement({ ...receiptInput, id: globalThis.crypto.randomUUID(), partyId: supplier.id }), errorCode('PARTY_REQUIRED'));
  await assert.rejects(service.saveSettlement({ ...receiptInput, id: globalThis.crypto.randomUUID(), moneyAccountId: accounts.expense.id }), errorCode('ACCOUNT_UNAVAILABLE'));
  await assert.rejects(service.reverseJournal({ id: ar.result.id, revision: ar.result.revision, commandId: globalThis.crypto.randomUUID(), postingDate: '2030-01-20', memo: '' }), errorCode('ACTIVE_SETTLEMENT'));
  const reverseCommand = { id: receipt.id, revision: receipt.revision, commandId: globalThis.crypto.randomUUID(), postingDate: '2030-01-20', memo: 'Reverse receipt' };
  const reversed = await service.reverseJournal(reverseCommand);
  assert.deepEqual(await service.reverseJournal(reverseCommand), reversed);
  await assert.rejects(service.reverseJournal({ ...reverseCommand, memo: 'Changed payload' }), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.equal(balances(store).get(accounts.ar.id), 1_000_000n);
  await service.reverseJournal({ id: ar.result.id, revision: ar.result.revision, commandId: globalThis.crypto.randomUUID(), postingDate: '2030-01-20', memo: 'Reverse source' });
  assert.deepEqual(await service.postJournal(ar.command), ar.result);
  assert.deepEqual(await service.postJournal(command), receipt);
  assert.deepEqual(await service.reverseJournal(reverseCommand), reversed);
  assert.equal(balances(store).get(accounts.ar.id), 0n);
  assert.equal(balances(store).get(accounts.income.id), 0n);
  await assert.rejects(service.reverseJournal({ ...reverseCommand, commandId: globalThis.crypto.randomUUID() }), errorCode('INVALID_TRANSITION'));
  await assert.rejects(service.reverseJournal({ id: reversed.id, revision: reversed.revision, commandId: globalThis.crypto.randomUUID(), postingDate: '2030-01-20', memo: '' }), errorCode('INVALID_TRANSITION'));
  assert.equal(store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_allocations')?.count, 2);
  store.close();
  const reopened = openAccountingDatabase(filename);
  t.after(() => reopened.close());
  assert.deepEqual(await new AccountingService(reopened, 'admin-1', now).postJournal(command), receipt);
  assert.equal(balances(reopened).get(accounts.ar.id), 0n);
});

test('date fences include first source date, future settlements and all release dates for generic journals and reversals', async (t) => {
  const { service, store, accounts, customer } = await domain(t);
  const ar = await entry(service, [inputLine(accounts.ar.id, 100, 0, customer.id), inputLine(accounts.income.id, 0, 100)], '2030-01-10');
  const allocation = { sourceJournalId: ar.result.id, sourceLineIndex: 0, amountMinor: 60 };
  const receiptInput = { id: globalThis.crypto.randomUUID(), revision: null, kind: 'receipt', postingDate: '2030-01-09', memo: '', reference: '', moneyAccountId: accounts.bank.id, partyId: customer.id, allocations: [allocation] };
  await assert.rejects(service.saveSettlement(receiptInput), errorCode('ALLOCATION_DATE_CONFLICT'));
  const genericInput = { id: globalThis.crypto.randomUUID(), revision: null, kind: 'journal', postingDate: '2030-01-09', memo: '', reference: '', lines: [inputLine(accounts.bank.id, 60, 0), inputLine(accounts.ar.id, 0, 60, customer.id, [allocation])] };
  await assert.rejects(service.saveJournal(genericInput), errorCode('ALLOCATION_DATE_CONFLICT'));
  const generic = await entry(service, genericInput.lines, '2030-02-01');
  assert.equal(((await service.list({ entity: 'sources' })).items[0]!.value as SourceSummary).remainingMinor, '40');
  await assert.rejects(service.saveSettlement({ ...receiptInput, id: globalThis.crypto.randomUUID(), postingDate: '2030-01-31', allocations: [{ ...allocation, amountMinor: 40 }] }), errorCode('ALLOCATION_DATE_CONFLICT'));
  await assert.rejects(service.reverseJournal({ id: generic.result.id, revision: generic.result.revision, commandId: globalThis.crypto.randomUUID(), postingDate: '2030-01-31', memo: '' }), errorCode('ALLOCATION_DATE_CONFLICT'));
  await service.reverseJournal({ id: generic.result.id, revision: generic.result.revision, commandId: globalThis.crypto.randomUUID(), postingDate: '2030-02-02', memo: '' });
  assert.equal(((await service.list({ entity: 'sources' })).items[0]!.value as SourceSummary).remainingMinor, '100');
  await assert.rejects(service.saveJournal({ ...genericInput, postingDate: '2030-02-01' }), errorCode('ALLOCATION_DATE_CONFLICT'));
  await assert.rejects(service.reverseJournal({ id: ar.result.id, revision: ar.result.revision, commandId: globalThis.crypto.randomUUID(), postingDate: '2030-02-01', memo: '' }), errorCode('ALLOCATION_DATE_CONFLICT'));
  await service.reverseJournal({ id: ar.result.id, revision: ar.result.revision, commandId: globalThis.crypto.randomUUID(), postingDate: '2030-02-02', memo: '' });
  assert.equal(balances(store).get(accounts.ar.id), 0n);
});

test('grouped duplicate sources cannot overdraw across lines, wrong account/party and unmatched reducing amounts reject whole journals', async (t) => {
  const { service, store, accounts, customer } = await domain(t);
  const source = await entry(service, [inputLine(accounts.ar.id, 100, 0, customer.id), inputLine(accounts.income.id, 0, 100)]);
  const allocation = { sourceJournalId: source.result.id, sourceLineIndex: 0, amountMinor: 60 };
  const input = { id: globalThis.crypto.randomUUID(), revision: null, kind: 'journal', postingDate: '2030-01-10', memo: '', reference: '', lines: [inputLine(accounts.bank.id, 120, 0), inputLine(accounts.ar.id, 0, 60, customer.id, [allocation]), inputLine(accounts.ar.id, 0, 60, customer.id, [allocation])] };
  const before = store.all('SELECT * FROM erp_ac_journals');
  await assert.rejects(service.saveJournal(input), errorCode('OVER_ALLOCATION'));
  const receiptInput = { id: globalThis.crypto.randomUUID(), revision: null, kind: 'receipt', postingDate: '2030-01-10', memo: '', reference: '', moneyAccountId: accounts.bank.id, partyId: customer.id, allocations: [allocation, allocation] };
  await assert.rejects(service.saveSettlement(receiptInput), errorCode('OVER_ALLOCATION'));
  await assert.rejects(service.saveJournal({ ...input, lines: [inputLine(accounts.bank.id, 60, 0), inputLine(accounts.ar.id, 0, 60, customer.id, [{ ...allocation, amountMinor: 59 }])] }), errorCode('OVER_ALLOCATION'));
  const otherParty = await service.saveParty({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'customer', code: 'OTHER', name: 'Other', active: true });
  await assert.rejects(service.saveJournal({ ...input, lines: [inputLine(accounts.bank.id, 60, 0), inputLine(accounts.ar.id, 0, 60, otherParty.id, [allocation])] }), errorCode('OVER_ALLOCATION'));
  const otherAccount = await service.saveAccount({ id: globalThis.crypto.randomUUID(), revision: null, code: 'AR-OTHER', name: 'Other control', rootType: 'asset', purpose: 'receivable', isGroup: false, parentId: null, active: true });
  await assert.rejects(service.saveJournal({ ...input, lines: [inputLine(accounts.bank.id, 60, 0), inputLine(otherAccount.id, 0, 60, customer.id, [allocation])] }), errorCode('OVER_ALLOCATION'));
  assert.deepEqual(store.all('SELECT * FROM erp_ac_journals'), before);
  const valid = await entry(service, [inputLine(accounts.bank.id, 60, 0), inputLine(accounts.ar.id, 0, 60, customer.id, [{ ...allocation, amountMinor: 30 }, { ...allocation, amountMinor: 30 }])]);
  assert.equal(valid.journal.value.lines[1]!.allocations.length, 1);
  assert.equal(valid.journal.value.lines[1]!.allocations[0]!.amountMinor, 60);
});

test('post faults after replacing lines, allocations and receipt insertion roll back every financial side effect and keep the exact draft', async (t) => {
  const { service, store, accounts, customer } = await domain(t);
  const source = await entry(service, [inputLine(accounts.ar.id, 100, 0, customer.id), inputLine(accounts.income.id, 0, 100)]);
  const draftValue = await service.saveSettlement({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'receipt', postingDate: '2030-01-10', memo: '', reference: '', moneyAccountId: accounts.bank.id, partyId: customer.id, allocations: [{ sourceJournalId: source.result.id, sourceLineIndex: 0, amountMinor: 50 }] });
  const command = { id: draftValue.id, revision: draftValue.revision, commandId: globalThis.crypto.randomUUID() };
  const tables = ['erp_ac_journals', 'erp_ac_lines', 'erp_ac_allocations', 'erp_ac_audit', 'erp_ac_commands'];
  const before = tables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`));
  for (const target of ['erp_ac_lines', 'erp_ac_allocations', 'erp_ac_audit', 'erp_ac_commands']) {
    let faulted = false;
    const injected: AccountingStore = { get: store.get.bind(store), all: store.all.bind(store), transaction: store.transaction.bind(store), close() {}, run(sql, ...parameters) {
      const result = store.run(sql, ...parameters);
      if (!faulted && sql.startsWith(`INSERT INTO ${target}`)) { faulted = true; throw new Error('Synthetic post fault after write'); }
      return result;
    } };
    await assert.rejects(new AccountingService(injected, 'admin-1', now).postJournal(command));
    assert.equal(faulted, true);
    assert.deepEqual(tables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`)), before);
    assert.deepEqual(await service.get({ entity: 'journals', id: draftValue.id }), draftValue);
  }
  const result = await service.postJournal(command);
  assert.equal(result.postedSequence, 2);
  assert.equal(balances(store).get(accounts.ar.id), 50n);
});

test('two independent writer processes competing for remaining debt and one draft have exactly one financial winner', async (t) => {
  const { service, store, filename, accounts, customer } = await domain(t);
  const source = await entry(service, [inputLine(accounts.ar.id, 400, 0, customer.id), inputLine(accounts.income.id, 0, 400)]);
  const drafts = await Promise.all([1, 2].map(() => service.saveSettlement({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'receipt', postingDate: '2030-01-10', memo: '', reference: '', moneyAccountId: accounts.bank.id, partyId: customer.id, allocations: [{ sourceJournalId: source.result.id, sourceLineIndex: 0, amountMinor: 300 }] })));
  const outcomes = await writerRace(t, filename, drafts.map((draftValue) => ({ id: draftValue.id, revision: draftValue.revision, commandId: globalThis.crypto.randomUUID() })));
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.code === 'OVER_ALLOCATION').length, 1);
  assert.equal(balances(store).get(accounts.ar.id), 100n);
  assert.equal(balances(store).get(accounts.bank.id), 300n);
  assert.equal(store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_commands')?.count, 2);
  const oneDraft = await service.saveJournal({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'journal', postingDate: '2030-01-10', memo: '', reference: '', lines: [inputLine(accounts.bank.id, 10, 0), inputLine(accounts.equity.id, 0, 10)] });
  const commands = [1, 2].map(() => ({ id: oneDraft.id, revision: oneDraft.revision, commandId: globalThis.crypto.randomUUID() }));
  const sameDraft = await writerRace(t, filename, commands);
  assert.equal(sameDraft.filter((outcome) => outcome.ok).length, 1);
  assert.equal(sameDraft.filter((outcome) => outcome.code === 'CONFLICT').length, 1);
  assert.equal(balances(store).get(accounts.bank.id), 310n);
});

test('B21 mixed source/settlement reversal blocks incoming atomically, then releases every outgoing allocation without changing original history', async (t) => {
  const { service, store, accounts, customer, supplier } = await domain(t);
  const oldAr = await entry(service, [inputLine(accounts.ar.id, 100, 0, customer.id), inputLine(accounts.income.id, 0, 100)]);
  const mixed = await entry(service, [inputLine(accounts.ar.id, 0, 40, customer.id, [{ sourceJournalId: oldAr.result.id, sourceLineIndex: 0, amountMinor: 40 }]), inputLine(accounts.ap.id, 0, 50, supplier.id), inputLine(accounts.expense.id, 90, 0)]);
  const payment = await service.saveSettlement({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'payment', postingDate: '2030-01-11', memo: '', reference: '', moneyAccountId: accounts.bank.id, partyId: supplier.id, allocations: [{ sourceJournalId: mixed.result.id, sourceLineIndex: 1, amountMinor: 20 }] });
  const paymentResult = await service.postJournal({ id: payment.id, revision: payment.revision, commandId: globalThis.crypto.randomUUID() });
  const reverseInput = { id: mixed.result.id, revision: mixed.result.revision, commandId: globalThis.crypto.randomUUID(), postingDate: '2030-01-12', memo: '' };
  const tables = ['erp_ac_journals', 'erp_ac_lines', 'erp_ac_allocations', 'erp_ac_audit', 'erp_ac_commands'];
  const before = tables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`));
  await assert.rejects(service.reverseJournal(reverseInput), errorCode('ACTIVE_SETTLEMENT'));
  assert.deepEqual(tables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`)), before);
  const activeSources = (await service.list({ entity: 'sources' })).items.map((item) => item.value as SourceSummary);
  assert.equal(activeSources.find((source) => source.journalId === oldAr.result.id)?.remainingMinor, '60');
  assert.equal(activeSources.find((source) => source.journalId === mixed.result.id)?.remainingMinor, '30');
  await service.reverseJournal({ id: paymentResult.id, revision: paymentResult.revision, commandId: globalThis.crypto.randomUUID(), postingDate: '2030-01-13', memo: '' });
  await assert.rejects(service.reverseJournal(reverseInput), errorCode('ALLOCATION_DATE_CONFLICT'));
  const reversal = await service.reverseJournal({ ...reverseInput, postingDate: '2030-01-13' });
  const restored = (await service.list({ entity: 'sources' })).items.map((item) => item.value as SourceSummary);
  assert.equal(restored.length, 1);
  assert.equal(restored[0]!.remainingMinor, '100');
  assert.equal(balances(store).get(accounts.ap.id), 0n);
  assert.equal(balances(store).get(accounts.bank.id), 0n);
  assert.deepEqual((await service.get({ entity: 'journals', id: mixed.result.id }) as RecordView<Journal>).value.lines, mixed.journal.value.lines);
  assert.equal((await service.get({ entity: 'journals', id: mixed.result.id }) as RecordView<Journal>).value.reversedBy, reversal.id);
  assert.equal(store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_allocations')?.count, 2);
});

test('bounded keyset lists reject cross-filter cursors and include only posted, unreversed sources with exact operational remaining', async (t) => {
  const { service, accounts, customer } = await domain(t);
  for (let index = 0; index < 28; index++) await entry(service, [inputLine(accounts.ar.id, 100 + index, 0, customer.id), inputLine(accounts.income.id, 0, 100 + index)]);
  const first = await service.list({ entity: 'sources', partyId: customer.id });
  assert.equal(first.items.length, 25);
  assert.equal(first.hasMore, true);
  const second = await service.list({ entity: 'sources', partyId: customer.id, cursor: first.cursor });
  assert.equal(second.items.length, 3);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 28);
  await assert.rejects(service.list({ entity: 'sources', cursor: first.cursor }), errorCode('INVALID_CURSOR'));
  await assert.rejects(service.list({ entity: 'accounts', cursor: first.cursor }), errorCode('INVALID_CURSOR'));
  await assert.rejects(service.list({ entity: 'sources', search: 'not allowed' }), errorCode('INVALID_INPUT'));
  await assert.rejects(service.list({ entity: 'journals', active: true }), errorCode('INVALID_INPUT'));
  const selected = first.items[0]!.value as SourceSummary;
  const source = await service.get({ entity: 'journals', id: selected.journalId });
  const future = await service.saveSettlement({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'receipt', postingDate: '2030-12-31', memo: '', reference: '', moneyAccountId: accounts.bank.id, partyId: customer.id, allocations: [{ sourceJournalId: selected.journalId, sourceLineIndex: selected.lineIndex, amountMinor: Number(selected.remainingMinor) }] });
  await service.postJournal({ id: future.id, revision: future.revision, commandId: globalThis.crypto.randomUUID() });
  const page = await service.list({ entity: 'sources', partyId: customer.id });
  assert.equal(page.items.some((item) => (item.value as SourceSummary).journalId === source.id), false);
  await assert.rejects(service.saveSettlement({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'receipt', postingDate: '2030-12-31', memo: '', reference: '', moneyAccountId: accounts.bank.id, partyId: customer.id, allocations: [{ sourceJournalId: selected.journalId, sourceLineIndex: selected.lineIndex, amountMinor: 1 }] }), errorCode('OVER_ALLOCATION'));
});

test('boundary helpers accept exactly 49 source allocations and 50 balanced lines, but reject larger counts and cash-line overflow', async (t) => {
  const { service, store, accounts, customer } = await domain(t);
  const sourceLines = Array.from({ length: 49 }, () => inputLine(accounts.ar.id, 1, 0, customer.id));
  const source = await entry(service, [...sourceLines, inputLine(accounts.equity.id, 0, 49)], '2030-01-01');
  const allocations = sourceLines.map((_line, index) => ({ sourceJournalId: source.result.id, sourceLineIndex: index, amountMinor: 1 }));
  const helperInput = { id: globalThis.crypto.randomUUID(), revision: null, kind: 'receipt', postingDate: '2030-01-01', memo: '', reference: '', moneyAccountId: accounts.bank.id, partyId: customer.id, allocations };
  await assert.rejects(service.saveSettlement({ ...helperInput, allocations: [...allocations, allocations[0]!] }), errorCode('INVALID_INPUT'));
  await assert.rejects(service.saveJournal({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'journal', postingDate: '2030-01-01', memo: '', reference: '', lines: [...sourceLines, inputLine(accounts.bank.id, 1, 0), inputLine(accounts.equity.id, 0, 50)] }), errorCode('INVALID_INPUT'));
  const helper = await service.saveSettlement(helperInput);
  assert.equal(helper.value.lines.length, 50);
  assert.equal(helper.value.lines[0]?.debitMinor, 49);
  const receipt = await service.postJournal({ id: helper.id, revision: helper.revision, commandId: globalThis.crypto.randomUUID() });
  assert.equal(balances(store).get(accounts.ar.id), 0n);
  assert.equal(balances(store).get(accounts.bank.id), 49n);
  await service.reverseJournal({ id: receipt.id, revision: receipt.revision, commandId: globalThis.crypto.randomUUID(), postingDate: '2030-01-01', memo: '' });
  assert.equal(balances(store).get(accounts.ar.id), 49n);
  const large = await entry(service, [inputLine(accounts.ar.id, 1_000_000_000_000, 0, customer.id), inputLine(accounts.ar.id, 1_000_000_000_000, 0, customer.id), inputLine(accounts.equity.id, 0, 1_000_000_000_000), inputLine(accounts.equity.id, 0, 1_000_000_000_000)]);
  await assert.rejects(service.saveSettlement({ ...helperInput, id: globalThis.crypto.randomUUID(), postingDate: '2030-01-10', allocations: [0, 1].map((sourceLineIndex) => ({ sourceJournalId: large.result.id, sourceLineIndex, amountMinor: 1_000_000_000_000 })) }), errorCode('INVALID_INPUT'));
});

test('post takes live labels rather than draft labels; changing master eligibility before post rolls back, and reversal faults leave allocations active', async (t) => {
  const { service, store, accounts, customer } = await domain(t);
  const draftValue = await service.saveJournal({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'journal', postingDate: '2030-01-10', memo: '', reference: '', lines: [inputLine(accounts.ar.id, 100, 0, customer.id), inputLine(accounts.income.id, 0, 100)] });
  assert.equal(draftValue.value.lines[0]?.account?.name, 'ar');
  await service.saveAccount({ id: accounts.ar.id, revision: accounts.ar.revision, code: 'AR-POST', name: 'Name at post', rootType: 'asset', purpose: 'receivable', isGroup: false, parentId: null, active: true });
  const posted = await service.postJournal({ id: draftValue.id, revision: draftValue.revision, commandId: globalThis.crypto.randomUUID() });
  const saved = await service.get({ entity: 'journals', id: posted.id }) as RecordView<Journal>;
  assert.equal(saved.value.lines[0]?.account?.name, 'Name at post');
  const receiptDraft = await service.saveSettlement({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'receipt', postingDate: '2030-01-10', memo: '', reference: '', moneyAccountId: accounts.bank.id, partyId: customer.id, allocations: [{ sourceJournalId: posted.id, sourceLineIndex: 0, amountMinor: 60 }] });
  const receipt = await service.postJournal({ id: receiptDraft.id, revision: receiptDraft.revision, commandId: globalThis.crypto.randomUUID() });
  const reverseInput = { id: receipt.id, revision: receipt.revision, commandId: globalThis.crypto.randomUUID(), postingDate: '2030-01-10', memo: '' };
  const tables = ['erp_ac_journals', 'erp_ac_lines', 'erp_ac_allocations', 'erp_ac_audit', 'erp_ac_commands'];
  const before = tables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`));
  const fault: AccountingStore = { get: store.get.bind(store), all: store.all.bind(store), transaction: store.transaction.bind(store), close() {}, run(sql, ...parameters) {
    const result = store.run(sql, ...parameters);
    if (sql.startsWith('INSERT INTO erp_ac_commands')) throw new Error('Synthetic reversal commit fault');
    return result;
  } };
  await assert.rejects(new AccountingService(fault, 'admin-1', now).reverseJournal(reverseInput));
  assert.deepEqual(tables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`)), before);
  assert.equal(((await service.list({ entity: 'sources' })).items[0]!.value as SourceSummary).remainingMinor, '40');
  const result = await service.reverseJournal(reverseInput);
  assert.equal(result.postedSequence, 3);
  assert.equal(((await service.list({ entity: 'sources' })).items[0]!.value as SourceSummary).remainingMinor, '100');
  const nextDraft = await service.saveJournal({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'journal', postingDate: '2030-01-10', memo: '', reference: '', lines: [inputLine(accounts.ar.id, 50, 0, customer.id), inputLine(accounts.income.id, 0, 50)] });
  await service.saveParty({ id: customer.id, revision: customer.revision, kind: 'customer', code: 'CUST', name: 'Disabled', active: false });
  await assert.rejects(service.postJournal({ id: nextDraft.id, revision: nextDraft.revision, commandId: globalThis.crypto.randomUUID() }), errorCode('PARTY_REQUIRED'));
  assert.equal((await service.get({ entity: 'journals', id: nextDraft.id }) as RecordView<Journal>).value.status, 'draft');
  assert.equal(balances(store).get(accounts.ar.id), 100n);
});
