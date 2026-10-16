import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Kysely } from 'kysely';
import { PluginStorageRepository, type Database } from 'emdash';
import { createDialect } from 'emdash/db/sqlite';
import { runMigrations } from 'emdash/db';
import { migrateAccountingDatabase, openAccountingDatabase } from '../src/accounting/sqlite.js';
import { AccountingService, executeAccountingAction, validateAccountingActionInput, createErpAccountingSource } from '../src/accounting/server.js';
import type { AccountingStore } from '../src/accounting/store.js';
import { ErpService, type ErpStorage } from '../src/service.js';
import type { RecordView } from '../src/model.js';
import { accountImportClosure, accountTemplate } from '../src/accounting/coa.js';
import { ErpError } from '../src/validation.js';
import { coaImportResultSchema } from '../src/accounting/validation.js';
import type { Account, AccountInput, CoaEntry, CoaImportInput, CoaImportResult, CoaSelection, CoaTemplateId, JournalLineInput } from '../src/accounting/model.js';

function selection(templateId: CoaTemplateId, selectedCodes: string[]) { return { templateId, templateVersion: '1', selectedCodes }; }
test('partial VAT and biological-asset selection retains required hierarchy without siblings', () => {
  assert.deepEqual(accountImportClosure(selection('vn-tt133-2016', ['33311'])).map((row) => [row.code, row.parentCode, row.isGroup]), [
    ['333', null, true], ['3331', '333', true], ['33311', '3331', false],
  ]);
  assert.deepEqual(accountImportClosure(selection('vn-tt99-2025', ['215121'])).map((row) => [row.code, row.parentCode, row.isGroup]), [
    ['215', null, true], ['2151', '215', true], ['21512', '2151', true], ['215121', '21512', false],
  ]);
  for (const id of ['vn-tt133-2016', 'vn-tt99-2025'] as const) {
    assert.throws(() => accountImportClosure(selection(id, ['333'])), (error: unknown) => error instanceof ErpError && error.code === 'INVALID_INPUT');
    assert.throws(() => accountImportClosure(selection(id, ['999999'])), (error: unknown) => error instanceof ErpError && error.code === 'INVALID_INPUT');
    assert.throws(() => accountTemplate(id, 'future'), (error: unknown) => error instanceof ErpError && error.code === 'COA_TEMPLATE_VERSION');
  }
});
test('legal code collisions and contra/result accounts retain economic meaning', () => {
  const small = accountTemplate('vn-tt133-2016').entries;
  const general = accountTemplate('vn-tt99-2025').entries;
  const row = (entries: typeof small, code: string) => { const found = entries.find((entry) => entry.code === code); assert.ok(found, code); return found; };
  assert.equal(row(small, '1111').purpose, 'cash'); assert.equal(row(small, '1112').purpose, 'cash');
  assert.equal(row(small, '1121').purpose, 'bank'); assert.equal(row(small, '1122').purpose, 'bank');
  assert.equal(row(small, '111').isGroup, true); assert.equal(row(small, '111').purpose, 'general');
  assert.equal(row(general, '111').isGroup, false); assert.equal(row(general, '111').purpose, 'cash');
  for (const code of ['1111', '1112', '1121', '1122', '5111', '5112', '5113', '5118']) assert.equal(general.some((entry) => entry.code === code), false, code);
  assert.notEqual(row(small, '3386').name, row(general, '3386').name);
  assert.notEqual(row(small, '6421').name, row(general, '6421').name);
  assert.equal(row(general, '215122').rootType, 'asset');
  assert.equal(row(general, '521').rootType, 'income');
  for (const entries of [small, general]) {
    assert.equal(row(entries, '214').rootType, 'asset'); assert.equal(row(entries, '229').rootType, 'asset');
    assert.equal(row(entries, '419').rootType, 'equity'); assert.equal(row(entries, '911').rootType, 'result');
    assert.equal(row(entries, '911').purpose, 'general');
    assert.equal(row(entries, '131').purpose, 'receivable'); assert.equal(row(entries, '331').purpose, 'payable');
    for (const entry of entries.filter((entry) => entry.code.startsWith('138') || entry.code.startsWith('338'))) assert.equal(entry.purpose, 'general');
  }
});

const time = '2030-01-01T12:00:00.000Z';
const now = () => new Date(time);
const actor = 'admin-1';
const uuid = () => globalThis.crypto.randomUUID();
const tables = ['erp_ac_settings', 'erp_ac_accounts', 'erp_ac_parties', 'erp_ac_journals', 'erp_ac_lines', 'erp_ac_allocations', 'erp_ac_audit', 'erp_ac_commands', 'erp_ac_coa_imports'];
function errorCode(expected: string) {
  return (error: unknown) => error instanceof ErpError && error.code === expected;
}
function snapshot(store: AccountingStore) {
  return tables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`));
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'erp-coa-'));
  const filename = join(directory, 'accounting.db');
  migrateAccountingDatabase(filename);
  const stores: AccountingStore[] = [];
  const open = () => { const store = openAccountingDatabase(filename); stores.push(store); return store; };
  const store = open();
  t.after(() => { for (const connection of stores) connection.close(); rmSync(directory, { recursive: true, force: true }); });
  return { filename, store, open, service: new AccountingService(store, actor, now) };
}
async function configured(t: TestContext) {
  const value = fixture(t);
  await value.service.configureBook({ startDate: '2030-01-01' });
  return value;
}
function command(templateId: CoaTemplateId, selectedCodes: string[], commandId = uuid()): CoaImportInput {
  return { ...selection(templateId, selectedCodes), commandId };
}
function refs(result: CoaImportResult) { return [...result.created, ...result.existing].sort((left, right) => left.code < right.code ? -1 : left.code > right.code ? 1 : 0); }
function ref(result: CoaImportResult, code: string) { const found = refs(result).find((row) => row.code === code); assert.ok(found, code); return found; }
async function saveTemplateAccount(service: AccountingService, row: CoaEntry, overrides: Partial<AccountInput> = {}) {
  return service.saveAccount({ id: uuid(), revision: null, code: row.code, name: row.name, rootType: row.rootType, purpose: row.purpose, isGroup: row.isGroup, parentId: null, active: true, ...overrides });
}
function row(templateId: CoaTemplateId, code: string) {
  const entry = accountTemplate(templateId).entries.find((item) => item.code === code); assert.ok(entry, code); return entry;
}
function line(accountId: string, debitMinor: number, creditMinor: number, partyId: string | null = null): JournalLineInput {
  return { accountId, debitMinor, creditMinor, partyId, allocations: [] };
}
function journal(lines: JournalLineInput[]) {
  return { id: uuid(), revision: null, kind: 'journal', postingDate: '2030-01-10', memo: 'Synthetic COA validation', reference: 'COA', lines };
}
function update(account: RecordView<Account>, changes: Partial<AccountInput>) {
  const { code, name, rootType, purpose, isGroup, parentId, active } = account.value;
  return { id: account.id, revision: account.revision, code, name, rootType, purpose, isGroup, parentId, active, ...changes };
}
async function getAccount(service: AccountingService, id: string): Promise<RecordView<Account>> {
  const record = await service.get({ entity: 'accounts', id });
  assert.ok('rootType' in record.value, 'Account lookup must return an account, not another master or journal');
  return { id: record.id, revision: record.revision, value: record.value };
}

for (const [templateId, expectedCount] of [['vn-tt133-2016', 123], ['vn-tt99-2025', 184]] as const) {
  test(`${templateId} full real SQLite import retains every hierarchy and every ledger can post while groups cannot`, async (t) => {
    const { store, service } = await configured(t);
    const beforeRead = snapshot(store);
    const metadata = await service.accountTemplates();
    assert.deepEqual(metadata.map((item) => item.templateId), ['vn-tt133-2016', 'vn-tt99-2025']);
    const template = await service.accountTemplate({ templateId });
    assert.equal(template.entries.length, expectedCount);
    const leaves = template.entries.filter((entry) => !entry.isGroup);
    const input = command(templateId, leaves.map((entry) => entry.code));
    const preview = await service.previewAccountImport(selection(templateId, input.selectedCodes));
    assert.equal(preview.canImport, true); assert.equal(preview.createCount, expectedCount);
    assert.equal(preview.conflictCount, 0); assert.equal(preview.existingCount, 0);
    assert.equal(preview.rows.filter((item) => item.automaticParent).length, expectedCount - leaves.length);
    assert.deepEqual(snapshot(store), beforeRead, 'catalog and preview must not seed or audit');
    const result = await service.importAccounts(input);
    assert.equal(result.created.length, expectedCount); assert.deepEqual(result.existing, []);
    assert.deepEqual(result.created.map((item) => item.code), template.entries.map((item) => item.code).sort());
    assert.equal(result.completedAt, time);
    assert.equal(store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_journals')?.count, 0);
    assert.equal(store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_commands')?.count, 0);
    const audits = store.all<{ recordId: string; actorId: string; event: string; revision: string; postedSequence: number | null }>("SELECT recordId,actorId,event,revision,postedSequence FROM erp_ac_audit WHERE entity='account'");
    assert.equal(audits.length, expectedCount);
    for (const entry of template.entries) {
      const saved = await getAccount(service, ref(result, entry.code).id);
      assert.deepEqual({ code: saved.value.code, name: saved.value.name, rootType: saved.value.rootType, purpose: saved.value.purpose, isGroup: saved.value.isGroup, active: saved.value.active, parentId: saved.value.parentId },
        { code: entry.code, name: entry.name, rootType: entry.rootType, purpose: entry.purpose, isGroup: entry.isGroup, active: true, parentId: entry.parentCode === null ? null : ref(result, entry.parentCode).id }, entry.code);
      assert.equal(saved.value.schemaVersion, 1);
      assert.equal(saved.value.createdBy, actor); assert.equal(saved.value.updatedBy, actor);
      const audit = audits.find((item) => item.recordId === saved.id)!;
      assert.equal(audit.actorId, actor); assert.equal(audit.event, `import-accounts:${templateId}:1`);
      assert.equal(audit.revision, saved.revision); assert.equal(audit.postedSequence, null);
    }
    const customer = await service.saveParty({ id: uuid(), revision: null, kind: 'customer', code: 'COA-CUSTOMER', name: 'Synthetic customer', active: true });
    const supplier = await service.saveParty({ id: uuid(), revision: null, kind: 'supplier', code: 'COA-SUPPLIER', name: 'Synthetic supplier', active: true });
    for (const entry of leaves) {
      const counterpart = ref(result, entry.code === '4212' ? '911' : '4212').id;
      const lines = entry.purpose === 'payable'
        ? [line(counterpart, 1, 0), line(ref(result, entry.code).id, 0, 1, supplier.id)]
        : [line(ref(result, entry.code).id, 1, 0, entry.purpose === 'receivable' ? customer.id : null), line(counterpart, 0, 1)];
      const draft = await service.saveJournal(journal(lines));
      const posted = await service.postJournal({ id: draft.id, revision: draft.revision, commandId: uuid() });
      assert.ok(posted.postedSequence > 0, entry.code);
    }
    const beforeGroups = snapshot(store);
    for (const group of template.entries.filter((entry) => entry.isGroup)) {
      await assert.rejects(service.saveJournal(journal([line(ref(result, group.code).id, 1, 0), line(ref(result, '911').id, 0, 1)])), errorCode('ACCOUNT_UNAVAILABLE'));
    }
    assert.deepEqual(snapshot(store), beforeGroups);
    assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
  });
}

test('subset imports reuse exact ancestors, preserve audit/revision and never pull siblings', async (t) => {
  const { store, service } = await configured(t);
  const first = await service.importAccounts(command('vn-tt133-2016', ['33311']));
  assert.deepEqual(first.created.map((item) => item.code), ['333', '3331', '33311']);
  assert.equal(store.get('SELECT 1 FROM erp_ac_accounts WHERE codeKey=?', '33312'), undefined);
  const accountsBefore = store.all('SELECT * FROM erp_ac_accounts ORDER BY codeKey');
  const auditsBefore = store.all('SELECT * FROM erp_ac_audit ORDER BY rowid');
  const noOp = await service.importAccounts(command('vn-tt133-2016', ['33311']));
  assert.deepEqual(noOp.created, []); assert.deepEqual(noOp.existing, first.created);
  assert.deepEqual(store.all('SELECT * FROM erp_ac_accounts ORDER BY codeKey'), accountsBefore);
  assert.deepEqual(store.all('SELECT * FROM erp_ac_audit ORDER BY rowid'), auditsBefore);
  const preview = await service.previewAccountImport(selection('vn-tt133-2016', ['33311']));
  assert.equal(preview.canImport, true); assert.equal(preview.createCount, 0); assert.equal(preview.existingCount, 3);
  const second = await service.importAccounts(command('vn-tt133-2016', ['33312']));
  assert.deepEqual(second.created.map((item) => item.code), ['33312']);
  assert.deepEqual(second.existing, first.created.filter((item) => item.code !== '33311'));
  assert.equal(store.get<{ parentId: string }>('SELECT parentId FROM erp_ac_accounts WHERE id=?', second.created[0]!.id)?.parentId, ref(first, '3331').id);
  const deep = await service.importAccounts(command('vn-tt99-2025', ['215121']));
  assert.deepEqual(deep.created.map((item) => item.code), ['215', '2151', '21512', '215121']);
  assert.equal(store.get('SELECT 1 FROM erp_ac_accounts WHERE codeKey=?', '215122'), undefined);
});

test('normalized fullwidth existing code is reused without rewriting display code, metadata or audit', async (t) => {
  const { store, service } = await configured(t);
  const existing = await saveTemplateAccount(service, row('vn-tt99-2025', '111'), { code: '１１１' });
  const before = snapshot(store);
  const preview = await service.previewAccountImport(selection('vn-tt99-2025', ['111']));
  assert.equal(preview.rows[0]!.status, 'existing'); assert.equal(preview.rows[0]!.existingId, existing.id);
  assert.deepEqual(snapshot(store), before);
  const result = await service.importAccounts(command('vn-tt99-2025', ['111']));
  assert.deepEqual(result.created, []); assert.deepEqual(result.existing, [{ code: '111', id: existing.id, revision: existing.revision }]);
  assert.deepEqual((await service.get({ entity: 'accounts', id: existing.id })), existing);
  assert.deepEqual(snapshot(store).slice(0, -1), before.slice(0, -1));
});

const conflicts: { field: string; code: string; changes: Partial<AccountInput> }[] = [
  { field: 'name', code: '711', changes: { name: 'Different legal meaning' } },
  { field: 'rootType', code: '711', changes: { rootType: 'expense' } },
  { field: 'purpose', code: '111', changes: { purpose: 'general' } },
  { field: 'isGroup', code: '711', changes: { isGroup: true } },
  { field: 'active', code: '711', changes: { active: false } },
  { field: 'parent', code: '711', changes: {} },
];
for (const scenario of conflicts) {
  test(`${scenario.field} mismatch blocks the whole import and never mutates existing or unrelated accounts`, async (t) => {
    const { store, service } = await configured(t);
    const unrelated = await service.saveAccount({ id: uuid(), revision: null, code: 'UNRELATED', name: 'Synthetic unrelated', rootType: 'income', purpose: 'general', isGroup: true, parentId: null, active: true });
    const changes = scenario.field === 'parent' ? { parentId: unrelated.id } : scenario.changes;
    const existing = await saveTemplateAccount(service, row('vn-tt99-2025', scenario.code), changes);
    const input = command('vn-tt99-2025', [scenario.code, '911']);
    const before = snapshot(store);
    const preview = await service.previewAccountImport(selection(input.templateId, input.selectedCodes));
    assert.equal(preview.canImport, false); assert.equal(preview.conflictCount, 1);
    assert.equal(preview.rows.find((item) => item.code === '911')!.status, 'create');
    const blocked = preview.rows.find((item) => item.code === scenario.code)!;
    assert.equal(blocked.status, 'conflict'); assert.equal(blocked.existingId, existing.id);
    const detail = blocked.conflicts!.find((item) => item.field === scenario.field);
    assert.ok(detail, `Missing ${scenario.field} conflict detail`);
    assert.notDeepEqual(detail.expected, detail.actual);
    assert.deepEqual(snapshot(store), before);
    await assert.rejects(service.importAccounts(input), errorCode('COA_IMPORT_CONFLICT'));
    assert.deepEqual(snapshot(store), before);
    assert.deepEqual(await service.get({ entity: 'accounts', id: unrelated.id }), unrelated);
  });
}

test('wrong ledger ancestor, inactive ancestor and different child parent each block the dependent batch', async (t) => {
  for (const mutation of ['ledger', 'inactive', 'different-parent'] as const) {
    const { store, service } = await configured(t);
    if (mutation === 'ledger') {
      await saveTemplateAccount(service, row('vn-tt133-2016', '333'), { isGroup: false });
    } else {
      const imported = await service.importAccounts(command('vn-tt133-2016', ['33311']));
      if (mutation === 'inactive') {
        const parent = await getAccount(service, ref(imported, '333').id);
        await service.saveAccount(update(parent, { active: false }));
      } else {
        const alternate = await service.saveAccount({ id: uuid(), revision: null, code: 'ALT', name: 'Synthetic liability group', rootType: 'liability', purpose: 'general', isGroup: true, parentId: null, active: true });
        const child = await getAccount(service, ref(imported, '33311').id);
        await service.saveAccount(update(child, { parentId: alternate.id }));
      }
    }
    const input = command('vn-tt133-2016', ['33311', '33312', '911']);
    const before = snapshot(store);
    const preview = await service.previewAccountImport(selection(input.templateId, input.selectedCodes));
    assert.equal(preview.canImport, false, mutation); assert.ok(preview.conflictCount > 0);
    const mismatch = preview.rows.find((item) => item.code === (mutation === 'different-parent' ? '33311' : '333'))!;
    assert.equal(mismatch.status, 'conflict');
    assert.ok(mismatch.conflicts!.some((item) => item.field === (mutation === 'ledger' ? 'isGroup' : mutation === 'inactive' ? 'active' : 'parent')));
    await assert.rejects(service.importAccounts(input), errorCode('COA_IMPORT_CONFLICT'));
    assert.deepEqual(snapshot(store), before, mutation);
  }
});

test('TT133→TT99 legal 6421 collision is not silently skipped or converted', async (t) => {
  const { store, service } = await configured(t);
  const imported = await service.importAccounts(command('vn-tt133-2016', ['6421']));
  const before = snapshot(store);
  const input = command('vn-tt99-2025', ['6421', '911']);
  const preview = await service.previewAccountImport(selection(input.templateId, input.selectedCodes));
  const collision = preview.rows.find((item) => item.code === '6421')!;
  assert.equal(collision.existingId, ref(imported, '6421').id);
  assert.ok(collision.conflicts!.some((item) => item.field === 'name' && item.actual === row('vn-tt133-2016', '6421').name && item.expected === row('vn-tt99-2025', '6421').name));
  await assert.rejects(service.importAccounts(input), errorCode('COA_IMPORT_CONFLICT'));
  assert.deepEqual(snapshot(store), before);
});

for (const fault of ['account-third', 'audit', 'before-receipt', 'after-receipt'] as const) {
  test(`${fault} fault rolls back every account, audit, receipt and posting sequence; exact retry then succeeds`, async (t) => {
    const { store, service } = await configured(t);
    const input = command('vn-tt99-2025', ['215121', '911']);
    const before = snapshot(store);
    let accountWrites = 0; let injected = false;
    const faultStore: AccountingStore = {
      get: store.get.bind(store), all: store.all.bind(store), transaction: store.transaction.bind(store), close() {},
      run(sql, ...parameters) {
        const isReceipt = sql.startsWith('INSERT INTO erp_ac_coa_imports');
        if (fault === 'before-receipt' && isReceipt) { injected = true; throw new Error('Synthetic receipt fault'); }
        const result = store.run(sql, ...parameters);
        if (sql.startsWith('INSERT INTO erp_ac_accounts')) accountWrites++;
        if (!injected && ((fault === 'account-third' && accountWrites === 3) || (fault === 'audit' && sql.startsWith('INSERT INTO erp_ac_audit')) || (fault === 'after-receipt' && isReceipt))) {
          injected = true; throw new Error('Synthetic fault after successful write');
        }
        return result;
      },
    };
    await assert.rejects(new AccountingService(faultStore, actor, now).importAccounts(input), errorCode('ACCOUNTING_STORAGE'));
    assert.equal(injected, true); assert.deepEqual(snapshot(store), before);
    const result = await service.importAccounts(input);
    assert.deepEqual(result.created.map((item) => item.code), ['215', '2151', '21512', '215121', '911']);
    const committed = snapshot(store);
    assert.deepEqual(await service.importAccounts(input), result);
    assert.deepEqual(snapshot(store), committed);
    assert.equal(store.get<{ sequence: number }>('SELECT coalesce(max(postedSequence),0) AS sequence FROM erp_ac_journals')?.sequence, 0);
  });
}

test('lost response survives reopen, rename and selection order permutation with exact immutable receipt', async (t) => {
  const { store, service, open } = await configured(t);
  const input = command('vn-tt99-2025', ['911', '111']);
  const result = await service.importAccounts(input); // Commit occurred; pretend the response was lost.
  assert.deepEqual(result.selectedCodes, ['111', '911']);
  const account = await getAccount(service, ref(result, '111').id);
  await service.saveAccount(update(account, { code: 'RENAMED', name: 'Operator renamed cash' }));
  const before = snapshot(store);
  store.close();
  const reopened = open();
  const recovered = new AccountingService(reopened, actor, now);
  assert.deepEqual(await recovered.importAccounts({ ...input, selectedCodes: ['111', '911'] }), result);
  assert.deepEqual(snapshot(reopened), before);
  assert.equal(reopened.get('SELECT 1 FROM erp_ac_accounts WHERE codeKey=?', '111'), undefined);
  const receipt = reopened.get<{ resultJson: string }>('SELECT resultJson FROM erp_ac_coa_imports WHERE commandId=?', input.commandId)!;
  assert.deepEqual(coaImportResultSchema.parse(JSON.parse(receipt.resultJson)), result);
  const committed = snapshot(reopened);
  for (const changed of [
    { ...input, selectedCodes: ['911'] },
    { ...input, templateId: 'vn-tt133-2016' },
    { ...input, templateVersion: 'future' },
  ]) await assert.rejects(recovered.importAccounts(changed), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(new AccountingService(reopened, 'different-admin', now).importAccounts(input), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(snapshot(reopened), committed);
});

test('import UUIDs and post/reverse UUIDs share one reciprocal command namespace', async (t) => {
  const { store, service } = await configured(t);
  const input = command('vn-tt99-2025', ['4212', '511', '911']);
  const imported = await service.importAccounts(input);
  const draft = await service.saveJournal(journal([line(ref(imported, '511').id, 10, 0), line(ref(imported, '911').id, 0, 10)]));
  const postInput = { id: draft.id, revision: draft.revision, commandId: input.commandId };
  const before = snapshot(store);
  await assert.rejects(service.postJournal(postInput), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(snapshot(store), before);
  const postingCommand = { ...postInput, commandId: uuid() };
  const posted = await service.postJournal(postingCommand);
  const afterPost = snapshot(store);
  await assert.rejects(service.importAccounts({ ...input, commandId: postingCommand.commandId }), errorCode('IDEMPOTENCY_CONFLICT'));
  const reverseInput = { id: posted.id, revision: posted.revision, commandId: input.commandId, postingDate: '2030-01-11', memo: 'Synthetic reversal' };
  await assert.rejects(service.reverseJournal(reverseInput), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(snapshot(store), afterPost);
  const reverseCommand = { ...reverseInput, commandId: uuid() };
  await service.reverseJournal(reverseCommand);
  const afterReverse = snapshot(store);
  await assert.rejects(service.importAccounts({ ...input, commandId: reverseCommand.commandId }), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(snapshot(store), afterReverse);
});

test('a stale compatible preview cannot permit an incompatible concurrent mutation or partial import', async (t) => {
  const { filename, store, service } = await configured(t);
  const imported = await service.importAccounts(command('vn-tt99-2025', ['111']));
  const input = command('vn-tt99-2025', ['111', '911']);
  const preview = await service.previewAccountImport(selection(input.templateId, input.selectedCodes));
  assert.equal(preview.canImport, true); assert.equal(preview.createCount, 1); assert.equal(preview.existingCount, 1);
  const independent = openAccountingDatabase(filename);
  try {
    const writer = new AccountingService(independent, 'other-admin', now);
    const account = await getAccount(writer, ref(imported, '111').id);
    await writer.saveAccount(update(account, { name: 'Incompatible concurrent cash label' }));
  } finally { independent.close(); }
  const before = snapshot(store);
  await assert.rejects(service.importAccounts(input), errorCode('COA_IMPORT_CONFLICT'));
  assert.deepEqual(snapshot(store), before);
  const refreshed = await service.previewAccountImport(selection(input.templateId, input.selectedCodes));
  assert.equal(refreshed.canImport, false); assert.equal(refreshed.conflictCount, 1);
});

type WriterOutcome = { ok: true; result: CoaImportResult } | { ok: false; code: string };
async function importRace(t: TestContext, filename: string, inputs: CoaImportInput[], beforeSend?: () => void) {
  const children = inputs.map(() => fork(fileURLToPath(new URL('./accounting-writer.mjs', import.meta.url)), [filename, actor, 'import-accounts'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(() => { for (const child of children) if (!child.killed) child.kill(); });
  const outcomes = children.map((child) => new Promise<WriterOutcome>((resolve, reject) => {
    let stderr = ''; let received = false;
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.on('message', (message) => {
      if (message && typeof message === 'object' && 'ok' in message) {
        received = true;
        try {
          if (message.ok === true && 'result' in message) resolve({ ok: true, result: coaImportResultSchema.parse(message.result) });
          else if (message.ok === false && 'code' in message && typeof message.code === 'string') resolve({ ok: false, code: message.code });
          else reject(new Error('Malformed import writer outcome'));
        } catch (error) { reject(error); }
      }
    });
    child.once('exit', (code) => { if (!received || code !== 0) reject(new Error(`Import writer exited ${code}: ${stderr}`)); });
  }));
  const ready = children.map((child) => new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Import writer exited before barrier: ${code}`)));
    child.once('message', (message) => {
      if (message && typeof message === 'object' && 'ready' in message) resolve();
      else reject(new Error('Import writer did not reach its explicit start barrier.'));
    });
  }));
  await Promise.all(ready);
  beforeSend?.();
  children.forEach((child, index) => child.send(inputs[index]!));
  return Promise.all(outcomes);
}

for (const sameCommand of [false, true]) {
  test(`independent import processes ${sameCommand ? 'replay one command' : 'serialize two commands'} with exactly one hierarchy and no duplicate audits`, { timeout: 30000 }, async (t) => {
    const { filename, store, service } = await configured(t);
    const first = command('vn-tt133-2016', ['33311']);
    const second = sameCommand ? { ...first } : command('vn-tt133-2016', ['33311']);
    const outcomes = await importRace(t, filename, [first, second]);
    assert.ok(outcomes.every((outcome) => outcome.ok), JSON.stringify(outcomes));
    const results = outcomes.map((outcome) => outcome.result);
    if (sameCommand) assert.deepEqual(results[0], results[1]);
    else {
      assert.deepEqual(results.map((result) => result.created.length).sort(), [0, 3]);
      assert.deepEqual(results.map((result) => result.existing.length).sort(), [0, 3]);
    }
    assert.deepEqual(store.all<{ code: string }>('SELECT code FROM erp_ac_accounts ORDER BY code').map((item) => item.code), ['333', '3331', '33311']);
    assert.equal(store.get<{ count: number }>("SELECT count(*) AS count FROM erp_ac_audit WHERE entity='account'")?.count, 3);
    assert.equal(store.get<{ count: number }>('SELECT count(*) AS count FROM erp_ac_coa_imports')?.count, sameCommand ? 1 : 2);
    assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
    const before = snapshot(store);
    assert.deepEqual(await service.importAccounts(first), results[0]);
    assert.deepEqual(await service.importAccounts(second), results[1]);
    assert.deepEqual(snapshot(store), before);
  });
}

test('independent overlapping leaf selections reuse their shared ancestors without partial hierarchies', { timeout: 30000 }, async (t) => {
  const { filename, store } = await configured(t);
  const outcomes = await importRace(t, filename, [command('vn-tt133-2016', ['33311']), command('vn-tt133-2016', ['33312'])]);
  assert.ok(outcomes.every((outcome) => outcome.ok), JSON.stringify(outcomes));
  assert.deepEqual(store.all<{ code: string }>('SELECT code FROM erp_ac_accounts ORDER BY code').map((item) => item.code), ['333', '3331', '33311', '33312']);
  const results = outcomes.map((outcome) => outcome.result);
  assert.equal(results.reduce((total, result) => total + result.created.length, 0), 4);
  assert.equal(results.reduce((total, result) => total + result.existing.length, 0), 2);
  assert.equal(ref(results[0]!, '333').id, ref(results[1]!, '333').id);
  assert.equal(ref(results[0]!, '3331').id, ref(results[1]!, '3331').id);
  assert.equal(store.get<{ count: number }>("SELECT count(*) AS count FROM erp_ac_audit WHERE entity='account'")?.count, 4);
  assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
});

test('busy independent writer returns an uncertain storage result without writes and retries the same intent after lock release', { timeout: 30000 }, async (t) => {
  const { filename, store, service } = await configured(t);
  const input = command('vn-tt99-2025', ['215121']);
  const before = snapshot(store);
  const blocker = new DatabaseSync(filename);
  let locked = false;
  try {
    const outcomes = await importRace(t, filename, [input], () => { blocker.exec('BEGIN IMMEDIATE'); locked = true; });
    assert.deepEqual(outcomes, [{ ok: false, code: 'ACCOUNTING_BUSY' }]);
    assert.deepEqual(snapshot(store), before);
  } finally {
    if (locked) blocker.exec('ROLLBACK');
    blocker.close();
  }
  const imported = await service.importAccounts(input);
  assert.equal(imported.created.length, 4);
  assert.deepEqual(await service.importAccounts(input), imported);
});

test('strict service and action validation deny forged fields, malformed leaves and unsupported versions without writes', async (t) => {
  const { store, service } = await configured(t);
  const input = command('vn-tt99-2025', ['911']);
  const before = snapshot(store);
  const invalidSelections: Record<string, unknown>[] = [
    { ...selection(input.templateId, ['911']), actorId: 'forged' },
    { ...selection(input.templateId, ['911']), name: 'forged' },
    { ...selection(input.templateId, ['911']), rootType: 'income' },
    { ...selection(input.templateId, ['911']), parentId: uuid() },
    { ...selection(input.templateId, ['911']), id: uuid() },
    { ...selection(input.templateId, ['911']), purpose: 'cash' },
    { ...selection(input.templateId, ['911']), isGroup: false },
    { ...selection(input.templateId, ['911']), active: false },
    { ...selection(input.templateId, ['911']), createdBy: actor },
    selection(input.templateId, []),
    selection(input.templateId, ['911', '911']),
    selection(input.templateId, ['９１１']),
    selection(input.templateId, ['91']),
    selection(input.templateId, ['1234567']),
    selection(input.templateId, Array.from({ length: 513 }, (_, index) => String(100000 + index))),
    { ...selection(input.templateId, ['911']), selectedCodes: null },
    { ...selection(input.templateId, ['911']), templateId: 'vn-tt200-2014' },
    { ...selection(input.templateId, ['911']), templateVersion: '' },
    { ...selection(input.templateId, ['911']), templateVersion: 'x'.repeat(33) },
  ];
  for (const invalid of invalidSelections) {
    await assert.rejects(service.previewAccountImport(invalid), errorCode('INVALID_INPUT'));
    const importInput = { ...invalid, commandId: input.commandId };
    await assert.rejects(service.importAccounts(importInput), errorCode('INVALID_INPUT'));
    assert.throws(() => validateAccountingActionInput('preview-account-import', invalid), errorCode('INVALID_INPUT'));
    assert.throws(() => validateAccountingActionInput('import-accounts', importInput), errorCode('INVALID_INPUT'));
    assert.deepEqual(snapshot(store), before);
  }
  // Catalog membership belongs after receipt lookup, not syntactic transport
  // preflight: an exact old receipt must remain replayable after a catalog upgrade.
  for (const selectedCodes of [['333'], ['999999']]) {
    const invalid = selection(input.templateId, selectedCodes);
    await assert.rejects(service.previewAccountImport(invalid), errorCode('INVALID_INPUT'));
    await assert.rejects(service.importAccounts({ ...invalid, commandId: input.commandId }), errorCode('INVALID_INPUT'));
    assert.deepEqual(snapshot(store), before);
  }
  for (const invalid of [{ ...input, commandId: 'not-uuid' }, { ...input, actorId: actor }]) await assert.rejects(service.importAccounts(invalid), errorCode('INVALID_INPUT'));
  for (const invalid of [{ templateId: input.templateId, actorId: actor }, { templateId: input.templateId, templateVersion: '1' }, { templateId: 'unknown' }]) {
    await assert.rejects(service.accountTemplate(invalid), errorCode('INVALID_INPUT'));
    assert.throws(() => validateAccountingActionInput('account-template', invalid), errorCode('INVALID_INPUT'));
  }
  assert.throws(() => validateAccountingActionInput('account-templates', {}), errorCode('INVALID_INPUT'));
  const future: CoaSelection = { ...selection(input.templateId, ['911']), templateVersion: 'future' };
  await assert.rejects(service.previewAccountImport(future), errorCode('COA_TEMPLATE_VERSION'));
  await assert.rejects(service.importAccounts({ ...future, commandId: uuid() }), errorCode('COA_TEMPLATE_VERSION'));
  assert.deepEqual(snapshot(store), before);
});

test('new action dispatch returns real catalog, preview and immutable import DTOs; anonymous and unconfigured calls never write', async (t) => {
  const { store, service } = fixture(t);
  const input = command('vn-tt99-2025', ['911']);
  const actions: [string, unknown][] = [
    ['account-templates', undefined],
    ['account-template', { templateId: input.templateId }],
    ['preview-account-import', selection(input.templateId, input.selectedCodes)],
    ['import-accounts', input],
  ];
  const before = snapshot(store);
  for (const [action, payload] of actions) {
    const anonymous = await executeAccountingAction(new AccountingService(store, '', now), action, payload);
    assert.equal(anonymous.ok, false); if (!anonymous.ok) assert.equal(anonymous.error.code, 'AUTH_REQUIRED');
    const missingBook = await executeAccountingAction(service, action, payload);
    assert.equal(missingBook.ok, false); if (!missingBook.ok) assert.equal(missingBook.error.code, 'BOOK_REQUIRED');
  }
  assert.deepEqual(snapshot(store), before);
  await service.configureBook({ startDate: '2030-01-01' });
  const configuredBefore = snapshot(store);
  const metadata = await executeAccountingAction(service, actions[0]![0], actions[0]![1]);
  assert.equal(metadata.ok, true);
  if (metadata.ok) { assert.ok(Array.isArray(metadata.data)); assert.equal(metadata.data.length, 2); }
  const template = await executeAccountingAction(service, actions[1]![0], actions[1]![1]);
  assert.equal(template.ok, true);
  if (template.ok) {
    assert.ok(template.data && typeof template.data === 'object' && 'entries' in template.data);
    assert.ok(Array.isArray(template.data.entries)); assert.equal(template.data.entries.length, 184);
  }
  const preview = await executeAccountingAction(service, actions[2]![0], actions[2]![1]);
  assert.equal(preview.ok, true);
  if (preview.ok) {
    assert.ok(preview.data && typeof preview.data === 'object' && 'createCount' in preview.data);
    assert.equal(preview.data.createCount, 1);
  }
  assert.deepEqual(snapshot(store), configuredBefore);
  const imported = await executeAccountingAction(service, 'import-accounts', input);
  assert.equal(imported.ok, true);
  if (imported.ok) {
    const result = coaImportResultSchema.parse(imported.data);
    assert.equal(result.commandId, input.commandId); assert.deepEqual(result.created.map((item) => item.code), ['911']);
    assert.deepEqual(await executeAccountingAction(service, 'import-accounts', input), imported);
  }
});

test('real CRM source rejects non-VND and missing/saved incompatible configuration for every catalog/import action without initializing either store', async (t) => {
  const { store, service } = await configured(t);
  const db = new Kysely<Database>({ dialect: createDialect({ url: ':memory:' }) });
  t.after(() => db.destroy());
  await runMigrations(db);
  const storage: ErpStorage = {
    settings: new PluginStorageRepository(db, 'erp-mini', 'settings', []),
    customers: new PluginStorageRepository(db, 'erp-mini', 'customers', ['nameKey', 'active', ['active', 'nameKey']]),
    items: new PluginStorageRepository(db, 'erp-mini', 'items', ['nameKey', 'active', ['active', 'nameKey']]),
    sales: new PluginStorageRepository(db, 'erp-mini', 'sales', ['hasOrder']),
  };
  const input = command('vn-tt99-2025', ['911']);
  const actions: [string, unknown][] = [
    ['account-templates', undefined], ['account-template', { templateId: input.templateId }],
    ['preview-account-import', selection(input.templateId, input.selectedCodes)], ['import-accounts', input],
  ];
  const before = snapshot(store);
  for (const currency of ['USD', 'VND'] as const) {
    const source = createErpAccountingSource(storage, actor, currency);
    for (const [action, payload] of actions) {
      const response = await executeAccountingAction(service, action, payload, source);
      assert.equal(response.ok, false); if (!response.ok) assert.equal(response.error.code, currency === 'USD' ? 'CURRENCY_MISMATCH' : 'BOOK_REQUIRED');
    }
    assert.equal(await storage.settings.getVersioned('configuration'), null);
    assert.deepEqual(snapshot(store), before);
  }
  await new ErpService(storage, actor, 'USD', now).info();
  const saved = await storage.settings.getVersioned('configuration');
  for (const [action, payload] of actions) {
    const response = await executeAccountingAction(service, action, payload, createErpAccountingSource(storage, actor, 'VND'));
    assert.equal(response.ok, false); if (!response.ok) assert.equal(response.error.code, 'CURRENCY_MISMATCH');
  }
  assert.deepEqual(await storage.settings.getVersioned('configuration'), saved);
  assert.deepEqual(snapshot(store), before);
});
