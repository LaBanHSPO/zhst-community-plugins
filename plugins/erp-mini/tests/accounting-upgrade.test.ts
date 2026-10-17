import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateAccountingDatabase, openAccountingDatabase } from '../src/accounting/sqlite.js';
import { AccountingService, ErpError } from '../src/accounting/server.js';
import type { AccountingStore, SqlParameter } from '../src/accounting/store.js';
import type { AccountInput, AccountReportRow, CoaImportResult, JournalLineInput } from '../src/accounting/model.js';

const time = '2030-01-01T12:00:00.000Z';
const actor = 'upgrade-admin';
const now = () => new Date(time);
const businessTables = ['erp_ac_settings', 'erp_ac_accounts', 'erp_ac_parties', 'erp_ac_journals', 'erp_ac_lines', 'erp_ac_allocations', 'erp_ac_audit', 'erp_ac_commands'];
const schemaQuery = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
function code(expected: string) {
  return (error: unknown) => error instanceof ErpError && error.code === expected;
}
function migration(version: 1 | 2 | 3) {
  const names = { 1: '0001_accounting.sql', 2: '0002_coa_import.sql', 3: '0003_hkd_books.sql' };
  const sql = readFileSync(new URL(`../migrations/${names[version]}`, import.meta.url), 'utf8');
  return { sql, checksum: createHash('sha256').update(sql).digest('hex') };
}
function location(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'erp-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'accounting.db');
}
function schema2(filename: string) {
  const db = new DatabaseSync(filename);
  const second = migration(2);
  try {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    db.exec(second.sql);
    db.prepare('INSERT INTO erp_ac_migrations(version,checksum,appliedAt) VALUES(2,?,?)').run(second.checksum, time);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec('COMMIT; PRAGMA foreign_keys=ON;');
  } finally { db.close(); }
}
// Only fixture construction uses this adapter: runtime must refuse older schemas.
// All domain writes still execute the real service and shipped SQL constraints.
function fixtureStore(db: DatabaseSync): AccountingStore {
  return {
    get<T>(sql: string, ...parameters: SqlParameter[]) {
      // Historical fixture construction predates both newer command namespaces.
      if (sql === 'SELECT 1 FROM erp_ac_hkd_commands WHERE commandId=?' &&
          !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='erp_ac_hkd_commands'").get()) return undefined;
      if (sql === 'SELECT 1 FROM erp_ac_coa_imports WHERE commandId=?' &&
          !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='erp_ac_coa_imports'").get()) return undefined;
      return db.prepare(sql).get(...parameters) as T | undefined;
    },
    all<T>(sql: string, ...parameters: SqlParameter[]) {
      return db.prepare(sql).all(...parameters) as T[];
    },
    run(sql, ...parameters) {
      const result = db.prepare(sql).run(...parameters);
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    },
    transaction(work) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = work(); db.exec('COMMIT'); return result; }
      catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}
function rows(db: DatabaseSync) {
  return Object.fromEntries(businessTables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function snapshot(db: DatabaseSync) {
  return {
    business: rows(db), schema: db.prepare(schemaQuery).all(),
    migrations: db.prepare('SELECT * FROM erp_ac_migrations ORDER BY version').all(),
    journalMode: db.prepare('PRAGMA journal_mode').get(),
    userVersion: db.prepare('PRAGMA user_version').get(),
    applicationId: db.prepare('PRAGMA application_id').get(),
  };
}
function chain(store: AccountingStore) {
  for (const row of store.all<{ version: 1 | 2 | 3; checksum: string }>('SELECT version,checksum FROM erp_ac_migrations ORDER BY version')) {
    assert.equal(row.checksum, migration(row.version).checksum);
  }
  assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
  assert.equal(store.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys, 1);
}
function line(accountId: string, debitMinor: number, creditMinor: number, partyId: string | null = null): JournalLineInput {
  return { accountId, debitMinor, creditMinor, partyId, allocations: [] };
}
function journalInput(id: string, lines: JournalLineInput[]) {
  return { id, revision: null, kind: 'journal', postingDate: '2030-01-10', memo: 'Synthetic upgrade journal', reference: 'UPGRADE', lines };
}
async function v1(t: TestContext) {
  const filename = location(t);
  const db = new DatabaseSync(filename);
  const first = migration(1);
  db.exec(first.sql);
  db.prepare('INSERT INTO erp_ac_migrations(version,checksum,appliedAt) VALUES(1,?,?)').run(first.checksum, time);
  const store = fixtureStore(db);
  const service = new AccountingService(store, actor, now);
  let next = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
  await service.configureBook({ startDate: '2030-01-01' });
  const account = (input: Omit<AccountInput, 'id' | 'revision' | 'active'>) => service.saveAccount({ ...input, id: uuid(), revision: null, active: true });
  const group = await account({ code: 'ASSETS', name: 'Synthetic assets', rootType: 'asset', purpose: 'general', isGroup: true, parentId: null });
  const bank = await account({ code: '1121', name: 'Synthetic bank', rootType: 'asset', purpose: 'bank', isGroup: false, parentId: group.id });
  const ar = await account({ code: '131', name: 'Synthetic receivable', rootType: 'asset', purpose: 'receivable', isGroup: false, parentId: group.id });
  const income = await account({ code: '511', name: 'Synthetic income', rootType: 'income', purpose: 'general', isGroup: false, parentId: null });
  const equity = await account({ code: '4212', name: 'Synthetic equity', rootType: 'equity', purpose: 'general', isGroup: false, parentId: null });
  const customer = await service.saveParty({ id: uuid(), revision: null, kind: 'customer', code: 'CUSTOMER', name: 'Synthetic customer', active: true });
  const draft = await service.saveJournal(journalInput(uuid(), [line(ar.id, 100, 0, customer.id), line(income.id, 0, 100)]));
  const command = { id: draft.id, revision: draft.revision, commandId: uuid() };
  const result = await service.postJournal(command);
  const settlement = await service.saveSettlement({ id: uuid(), revision: null, kind: 'receipt', postingDate: '2030-01-10', memo: 'Synthetic receipt', reference: 'UPGRADE', moneyAccountId: bank.id, partyId: customer.id, allocations: [{ sourceJournalId: result.id, sourceLineIndex: 0, amountMinor: 40 }] });
  const settlementCommand = { id: settlement.id, revision: settlement.revision, commandId: uuid() };
  const settlementResult = await service.postJournal(settlementCommand);
  assert.equal(db.prepare('SELECT count(*) AS count FROM erp_ac_allocations').get()?.count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM erp_ac_commands').get()?.count, 2);
  assert.ok(Number(db.prepare('SELECT count(*) AS count FROM erp_ac_audit').get()?.count) > 0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const before = snapshot(db);
  db.close();
  return { filename, before, uuid, group, bank, ar, income, equity, customer, command, result, settlementCommand, settlementResult };
}
function runtime(t: TestContext, filename: string) {
  const store = openAccountingDatabase(filename);
  t.after(() => store.close());
  return { store, service: new AccountingService(store, actor, now) };
}

test('fresh shipped schema has a checksummed exact chain, no business seed and a write-free rerun', async (t) => {
  const filename = location(t);
  migrateAccountingDatabase(filename);
  const { store, service } = runtime(t, filename);
  chain(store);
  assert.equal((await service.info()).book, null);
  for (const table of [...businessTables, 'erp_ac_coa_imports', 'erp_ac_hkd_profiles', 'erp_ac_hkd_events', 'erp_ac_hkd_commands']) assert.equal(store.get<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count, 0, table);
  const before = store.all('SELECT * FROM erp_ac_migrations ORDER BY version');
  migrateAccountingDatabase(filename);
  assert.deepEqual(store.all('SELECT * FROM erp_ac_migrations ORDER BY version'), before);
  chain(store);
});

test('v1 runtime refusal is read-only; upgrade preserves every business row and replays old commands before real result posting/reporting', async (t) => {
  const legacy = await v1(t);
  assert.throws(() => openAccountingDatabase(legacy.filename), code('SCHEMA_VERSION'));
  const refused = new DatabaseSync(legacy.filename);
  try { assert.deepEqual(snapshot(refused), legacy.before); } finally { refused.close(); }
  migrateAccountingDatabase(legacy.filename);
  const { store, service } = runtime(t, legacy.filename);
  chain(store);
  for (const table of businessTables) assert.deepEqual(store.all(`SELECT * FROM ${table} ORDER BY rowid`), legacy.before.business[table], table);
  assert.deepEqual(store.get('SELECT * FROM erp_ac_migrations WHERE version=1'), legacy.before.migrations[0]);
  assert.equal(store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_coa_imports')?.count, 0);
  const history = businessTables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`));
  assert.deepEqual(await service.postJournal(legacy.command), legacy.result);
  assert.deepEqual(await service.postJournal(legacy.settlementCommand), legacy.settlementResult);
  assert.deepEqual(businessTables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`)), history);
  const imported: CoaImportResult = await service.importAccounts({ commandId: legacy.uuid(), templateId: 'vn-tt99-2025', templateVersion: '1', selectedCodes: ['215121'] });
  assert.deepEqual(imported.created.map((row) => row.code), ['215', '2151', '21512', '215121']);
  assert.deepEqual(imported.existing, []);
  assert.deepEqual(await service.importAccounts({ commandId: imported.commandId, templateId: imported.templateId, templateVersion: imported.templateVersion, selectedCodes: imported.selectedCodes }), imported);
  for (const ref of imported.created) {
    const parentCode = { '215': null, '2151': '215', '21512': '2151', '215121': '21512' }[ref.code as '215' | '2151' | '21512' | '215121'];
    assert.equal(store.get<{ parentId: string | null }>('SELECT parentId FROM erp_ac_accounts WHERE id=?', ref.id)?.parentId, parentCode === null ? null : imported.created.find((row) => row.code === parentCode)!.id);
  }
  for (const table of businessTables.filter((name) => name !== 'erp_ac_accounts' && name !== 'erp_ac_audit')) assert.deepEqual(store.all(`SELECT * FROM ${table} ORDER BY rowid`), legacy.before.business[table], table);
  for (const table of ['erp_ac_accounts', 'erp_ac_audit']) {
    for (const preserved of legacy.before.business[table]!) {
      assert.equal(typeof preserved.id, 'string');
      assert.deepEqual(store.get(`SELECT * FROM ${table} WHERE id=?`, String(preserved.id)), preserved, `${table}:${String(preserved.id)}`);
    }
  }
  const range = { from: '2030-01-01', to: '2030-12-31' };
  const cashBefore = await service.report({ type: 'cash-bank', ...range });
  const debtBefore = await service.report({ type: 'debt', ...range });
  const resultInput: AccountInput = { id: legacy.uuid(), revision: null, code: '911', name: 'Synthetic result', rootType: 'result', purpose: 'general', isGroup: false, parentId: null, active: true };
  const result = await service.saveAccount(resultInput);
  assert.equal(result.value.schemaVersion, 1);
  for (const purpose of ['cash', 'bank', 'receivable', 'payable']) await assert.rejects(service.saveAccount({ ...resultInput, id: legacy.uuid(), code: `BAD-${purpose}`, purpose }), code('ACCOUNT_UNAVAILABLE'));
  assert.throws(() => store.run("UPDATE erp_ac_accounts SET purpose='cash' WHERE id=?", result.id), code('CONFLICT'));
  const closing = await service.saveJournal(journalInput(legacy.uuid(), [line(legacy.income.id, 100, 0), line(result.id, 0, 100)]));
  const closingResult = await service.postJournal({ id: closing.id, revision: closing.revision, commandId: legacy.uuid() });
  assert.equal(closingResult.postedSequence, 3);
  const transfer = await service.saveJournal(journalInput(legacy.uuid(), [line(result.id, 100, 0), line(legacy.equity.id, 0, 100)]));
  assert.equal((await service.postJournal({ id: transfer.id, revision: transfer.revision, commandId: legacy.uuid() })).postedSequence, 4);
  const trial = await service.report({ type: 'trial-balance', ...range });
  const resultRow = (trial.items as AccountReportRow[]).find((row) => row.accountId === result.id)!;
  assert.equal(resultRow.rootType, 'result');
  assert.equal(resultRow.debitMinor, '100'); assert.equal(resultRow.creditMinor, '100'); assert.equal(resultRow.closingMinor, '0');
  const ledger = await service.report({ type: 'ledger', ...range, accountId: result.id });
  assert.equal(ledger.items.length, 2);
  assert.ok(ledger.items.every((row) => 'accountId' in row && row.accountId === result.id));
  assert.deepEqual(store.all<{ accountRootType: string }>('SELECT accountRootType FROM erp_ac_lines WHERE accountId=? ORDER BY journalId,lineIndex', result.id).map((row) => row.accountRootType), ['result', 'result']);
  assert.equal(ledger.totals.debitMinor, '100'); assert.equal(ledger.totals.creditMinor, '100'); assert.equal(ledger.totals.closingMinor, '0');
  assert.deepEqual((await service.report({ type: 'cash-bank', ...range })).totals, cashBefore.totals);
  assert.deepEqual((await service.report({ type: 'debt', ...range })).totals, debtBefore.totals);
  const group = await service.saveAccount({ ...resultInput, id: legacy.uuid(), code: 'RESULT-GROUP', isGroup: true });
  await assert.rejects(service.saveJournal(journalInput(legacy.uuid(), [line(group.id, 10, 0), line(legacy.equity.id, 0, 10)])), code('ACCOUNT_UNAVAILABLE'));
  const contra = await service.saveAccount({ ...resultInput, id: legacy.uuid(), code: '214', name: 'Synthetic contra asset', rootType: 'asset' });
  const contraDraft = await service.saveJournal(journalInput(legacy.uuid(), [line(legacy.income.id, 10, 0), line(contra.id, 0, 10)]));
  await service.postJournal({ id: contraDraft.id, revision: contraDraft.revision, commandId: legacy.uuid() });
  const contraRow = ((await service.report({ type: 'trial-balance', ...range })).items as AccountReportRow[]).find((row) => row.accountId === contra.id)!;
  assert.equal(contraRow.rootType, 'asset'); assert.equal(contraRow.closingMinor, '-10');
  const migrations = store.all('SELECT * FROM erp_ac_migrations ORDER BY version');
  const after = businessTables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`));
  migrateAccountingDatabase(legacy.filename);
  assert.deepEqual(store.all('SELECT * FROM erp_ac_migrations ORDER BY version'), migrations);
  assert.deepEqual(businessTables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`)), after);
  chain(store);
});

for (const fault of ['interruption', 'foreign-key'] as const) {
  test(`schema2 rebuild ${fault} rolls back to identical usable v1 and subsequent recovery preserves history`, async (t) => {
    const legacy = await v1(t);
    // Warm the shipped reference independently so fault injection only touches this file.
    const warm = location(t); migrateAccountingDatabase(warm);
    const original = DatabaseSync.prototype.exec;
    let injected = false;
    DatabaseSync.prototype.exec = function (sql: string) {
      original.call(this, sql);
      const file = this.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
      if (!injected && file === realpathSync(legacy.filename) && this.isTransaction && sql.includes("'result'") && sql.includes('erp_ac_accounts') && sql.includes('erp_ac_lines')) {
        injected = true;
        if (fault === 'interruption') throw new Error('Synthetic rebuild interruption');
        this.prepare("INSERT INTO erp_ac_audit(id,entity,recordId,journalId,event,actorId,occurredAt,revision,postedSequence) VALUES(?,'journal',?,?,'synthetic-fk-fault',?,?,'fault-r1',NULL)").run(legacy.uuid(), 'missing-journal', 'missing-journal', actor, time);
      }
    };
    try { assert.throws(() => migrateAccountingDatabase(legacy.filename), code(fault === 'interruption' ? 'ACCOUNTING_STORAGE' : 'SCHEMA_VERSION')); }
    finally { DatabaseSync.prototype.exec = original; }
    assert.equal(injected, true);
    const raw = new DatabaseSync(legacy.filename);
    try {
      assert.deepEqual(snapshot(raw), legacy.before);
      assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);
      const service = new AccountingService(fixtureStore(raw), actor, now);
      assert.deepEqual(await service.postJournal(legacy.command), legacy.result);
      const draft = await service.saveJournal(journalInput(legacy.uuid(), [line(legacy.bank.id, 5, 0), line(legacy.income.id, 0, 5)]));
      assert.equal((await service.postJournal({ id: draft.id, revision: draft.revision, commandId: legacy.uuid() })).postedSequence, 3);
    } finally { raw.close(); }
    assert.throws(() => openAccountingDatabase(legacy.filename), code('SCHEMA_VERSION'));
    const beforeRecovery = new DatabaseSync(legacy.filename);
    let preserved: Record<string, Record<string, unknown>[]>;
    try { preserved = rows(beforeRecovery); } finally { beforeRecovery.close(); }
    migrateAccountingDatabase(legacy.filename);
    const { store, service } = runtime(t, legacy.filename);
    for (const table of businessTables) assert.deepEqual(store.all(`SELECT * FROM ${table} ORDER BY rowid`), preserved![table], table);
    assert.deepEqual(await service.postJournal(legacy.command), legacy.result);
    chain(store);
  });
}

const corruptions = [
  { name: 'v1 checksum', version: 1, sql: "UPDATE erp_ac_migrations SET checksum=printf('%064d',0) WHERE version=1" },
  { name: 'v2 checksum', version: 2, sql: "UPDATE erp_ac_migrations SET checksum=printf('%064d',0) WHERE version=2" },
  { name: 'missing first prefix row', version: 2, sql: 'DELETE FROM erp_ac_migrations WHERE version=1' },
  { name: 'schema2 claiming schema1', version: 2, sql: 'DELETE FROM erp_ac_migrations WHERE version=2' },
  { name: 'empty chain with nonempty schema', version: 1, sql: 'DELETE FROM erp_ac_migrations' },
  { name: 'future prefix', version: 2, sql: "INSERT INTO erp_ac_migrations VALUES(99,printf('%064d',0),'2030-01-01')" },
  { name: 'unknown table', version: 1, sql: 'CREATE TABLE foreign_data(value TEXT) STRICT' },
  { name: 'unknown index', version: 2, sql: 'CREATE INDEX foreign_index ON erp_ac_accounts(code)' },
  { name: 'missing trigger', version: 1, sql: 'DROP TRIGGER erp_ac_settings_update' },
  { name: 'modified trigger', version: 2, sql: "DROP TRIGGER erp_ac_settings_update; CREATE TRIGGER erp_ac_settings_update BEFORE UPDATE ON erp_ac_settings BEGIN SELECT RAISE(ABORT,'DIFFERENT_RULE'); END;" },
] as const;
for (const corruption of corruptions) {
  test(`${corruption.name} fails closed without rewriting schema, history or migration rows`, async (t) => {
    const legacy = await v1(t);
    if (corruption.version === 2) schema2(legacy.filename);
    const raw = new DatabaseSync(legacy.filename);
    try {
      raw.exec(corruption.sql);
      const before = snapshot(raw);
      assert.throws(() => migrateAccountingDatabase(legacy.filename), code('SCHEMA_VERSION'));
      assert.throws(() => openAccountingDatabase(legacy.filename), code('SCHEMA_VERSION'));
      assert.deepEqual(snapshot(raw), before);
    } finally { raw.close(); }
  });
}

test('schema1 cannot claim a contiguous schema2 chain and pre-existing FK violations cannot be repaired by upgrade', async (t) => {
  for (const corruption of ['false-prefix', 'foreign-key-v1', 'foreign-key-v2'] as const) {
    const legacy = await v1(t);
    if (corruption === 'foreign-key-v2') schema2(legacy.filename);
    const raw = new DatabaseSync(legacy.filename);
    try {
      if (corruption === 'false-prefix') raw.prepare('INSERT INTO erp_ac_migrations VALUES(2,?,?)').run(migration(2).checksum, time);
      else {
        raw.exec('PRAGMA foreign_keys=OFF');
        raw.prepare('DELETE FROM erp_ac_accounts WHERE id=?').run(legacy.bank.id);
        raw.exec('PRAGMA foreign_keys=ON');
        assert.ok(raw.prepare('PRAGMA foreign_key_check').all().length > 0);
      }
      const before = snapshot(raw);
      assert.throws(() => migrateAccountingDatabase(legacy.filename), code('SCHEMA_VERSION'));
      assert.throws(() => openAccountingDatabase(legacy.filename), code('SCHEMA_VERSION'));
      assert.deepEqual(snapshot(raw), before);
    } finally { raw.close(); }
  }
});

function insertImport(store: AccountingStore, commandId: string, accountId: string, revision: string) {
  const result: CoaImportResult = { commandId, templateId: 'vn-tt99-2025', templateVersion: '1', selectedCodes: ['511'], created: [], existing: [{ code: '511', id: accountId, revision }], completedAt: time };
  store.run('INSERT INTO erp_ac_coa_imports(commandId,actorId,canonicalPayloadHash,templateId,templateVersion,resultJson,createdAt) VALUES(?,?,?,?,?,?,?)', commandId, actor, 'a'.repeat(64), result.templateId, result.templateVersion, JSON.stringify(result), time);
  return result;
}

test('raw import receipts are immutable and command namespace fences protect both direct SQL and real post/reverse transactions', async (t) => {
  const legacy = await v1(t);
  migrateAccountingDatabase(legacy.filename);
  const { store, service } = runtime(t, legacy.filename);
  const commandId = legacy.uuid();
  const receipt = insertImport(store, commandId, legacy.income.id, legacy.income.revision);
  const beforeReceipt = store.get('SELECT * FROM erp_ac_coa_imports WHERE commandId=?', commandId);
  assert.deepEqual(JSON.parse(String(beforeReceipt?.resultJson)), receipt);
  const valid: SqlParameter[] = [legacy.uuid(), actor, 'b'.repeat(64), receipt.templateId, receipt.templateVersion, JSON.stringify(receipt), time];
  for (const [index, invalid] of [[0, ''], [1, ''], [1, null], [2, 'short'], [2, 'z'.repeat(64)], [3, ''], [4, ''], [5, '{invalid'], [6, '']] as const) {
    const values = [...valid];
    values[0] = legacy.uuid();
    values[index] = invalid;
    assert.throws(() => store.run('INSERT INTO erp_ac_coa_imports(commandId,actorId,canonicalPayloadHash,templateId,templateVersion,resultJson,createdAt) VALUES(?,?,?,?,?,?,?)', ...values), code('CONFLICT'));
    assert.deepEqual(store.all('SELECT * FROM erp_ac_coa_imports'), [beforeReceipt]);
  }
  for (const sql of ["UPDATE erp_ac_coa_imports SET actorId='forged' WHERE commandId=?", 'DELETE FROM erp_ac_coa_imports WHERE commandId=?', 'INSERT OR REPLACE INTO erp_ac_coa_imports SELECT * FROM erp_ac_coa_imports WHERE commandId=?']) {
    assert.throws(() => store.run(sql, commandId), code('COA_IMPORT_IMMUTABLE'));
    assert.deepEqual(store.get('SELECT * FROM erp_ac_coa_imports WHERE commandId=?', commandId), beforeReceipt);
  }
  assert.throws(() => insertImport(store, legacy.command.commandId, legacy.income.id, legacy.income.revision), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.run('INSERT INTO erp_ac_commands SELECT ?,action,actorId,canonicalPayloadHash,journalId,revision,postedSequence,createdAt FROM erp_ac_commands WHERE commandId=?', commandId, legacy.command.commandId), code('IDEMPOTENCY_CONFLICT'));
  const draft = await service.saveJournal(journalInput(legacy.uuid(), [line(legacy.bank.id, 10, 0), line(legacy.income.id, 0, 10)]));
  const tables = [...businessTables, 'erp_ac_coa_imports'];
  const before = tables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`));
  await assert.rejects(service.postJournal({ id: draft.id, revision: draft.revision, commandId }), code('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(tables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`)), before);
  await assert.rejects(service.reverseJournal({ id: legacy.settlementResult.id, revision: legacy.settlementResult.revision, commandId, postingDate: '2030-01-10', memo: '' }), code('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(tables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`)), before);
  assert.equal(store.get<{ sequence: number }>('SELECT max(postedSequence) AS sequence FROM erp_ac_journals')?.sequence, 2);
  assert.deepEqual(await service.postJournal(legacy.command), legacy.result);
  assert.deepEqual(await service.postJournal(legacy.settlementCommand), legacy.settlementResult);
  chain(store);
});

test('schema2→3 interruption preserves COA receipts and posted history before independent household setup', async (t) => {
  const legacy = await v1(t);
  schema2(legacy.filename);
  const prior = new DatabaseSync(legacy.filename);
  const historical = new AccountingService(fixtureStore(prior), actor, now);
  const imported = await historical.importAccounts({ commandId: legacy.uuid(), templateId: 'vn-tt133-2016', templateVersion: '1', selectedCodes: ['33311', '911'] });
  const before = snapshot(prior);
  const receipts = prior.prepare('SELECT * FROM erp_ac_coa_imports ORDER BY commandId').all();
  prior.close();
  assert.throws(() => openAccountingDatabase(legacy.filename), code('SCHEMA_VERSION'));
  const warm = location(t); migrateAccountingDatabase(warm);
  const original = DatabaseSync.prototype.exec;
  let injected = false;
  DatabaseSync.prototype.exec = function (sql: string) {
    original.call(this, sql);
    const file = this.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
    if (!injected && file === realpathSync(legacy.filename) && this.isTransaction && sql.includes('CREATE TABLE erp_ac_hkd_profiles')) {
      injected = true;
      throw new Error('Synthetic household schema interruption');
    }
  };
  try { assert.throws(() => migrateAccountingDatabase(legacy.filename), code('ACCOUNTING_STORAGE')); }
  finally { DatabaseSync.prototype.exec = original; }
  assert.equal(injected, true);
  const rolledBack = new DatabaseSync(legacy.filename);
  try {
    assert.deepEqual(snapshot(rolledBack), before);
    assert.deepEqual(rolledBack.prepare('SELECT * FROM erp_ac_coa_imports ORDER BY commandId').all(), receipts);
  } finally { rolledBack.close(); }
  migrateAccountingDatabase(legacy.filename);
  const { store, service } = runtime(t, legacy.filename);
  assert.deepEqual(await service.postJournal(legacy.command), legacy.result);
  assert.deepEqual(await service.postJournal(legacy.settlementCommand), legacy.settlementResult);
  const { commandId, templateId, templateVersion, selectedCodes } = imported;
  assert.deepEqual(await service.importAccounts({ commandId, templateId, templateVersion, selectedCodes }), imported);
  const configured = await service.hkd.configure({ commandId: legacy.uuid(), year: 2030, startDate: '2030-01-01', name: 'Hộ tổng hợp',
    address: 'Địa chỉ tổng hợp', taxCode: '0123456789', representative: 'Người tổng hợp', location: 'Cửa hàng',
    taxMethod: 'exempt', periodType: 'month', incomeTaxRateBps: null, otherTaxes: false });
  await service.hkd.postEntry({ commandId: legacy.uuid(), year: 2030, installationId: configured.profile!.installationId, revision: configured.profile!.revision, entry: { kind: 'revenue', date: '2030-01-02',
    documentDate: '2030-01-02', documentNumber: 'HKD-001', description: 'Doanh thu hộ', amountMinor: 25,
    businessLine: '', vatRateBps: 0, pitRateBps: 0, vatTaxableMinor: 0, pitTaxableMinor: 0, incomeRevenueMinor: 0 } });
  for (const table of businessTables) assert.deepEqual(store.all(`SELECT * FROM ${table} ORDER BY rowid`), before.business[table], table);
  assert.deepEqual(store.all('SELECT * FROM erp_ac_coa_imports ORDER BY commandId'), receipts);
});
