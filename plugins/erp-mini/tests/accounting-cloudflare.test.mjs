import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Bundle the compiled package as the host would, with no nodejs_compat. esbuild's
// browser resolver rejects Node builtins anywhere in the Cloudflare import graph.
const bundled = await build({ entryPoints: [fileURLToPath(new URL('./accounting-cloudflare-worker.mjs', import.meta.url))], bundle: true, write: false, platform: 'browser', format: 'esm', external: ['cloudflare:workers'] });
const legacySql = await readFile(new URL('../migrations/0001_accounting.sql', import.meta.url), 'utf8');
const legacyArtifact = { sql: legacySql, checksum: createHash('sha256').update(legacySql).digest('hex') };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'erp-workerd-accounting-'));
  const options = { script: bundled.outputFiles[0].text, modules: true, compatibilityDate: '2026-07-30', durableObjects: { ACCOUNTING: { className: 'TestAccounting', useSQLite: true } }, durableObjectsPersist: directory };
  let mf = new Miniflare(options);
  t.after(async () => { try { await mf.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } });
  return {
    async send(operation, input, action, actor = 'admin-1', name = 'ledger') {
      const namespace = await mf.getDurableObjectNamespace('ACCOUNTING');
      const response = await namespace.getByName(name).fetch('https://accounting.test.invalid/', { method: 'POST', body: JSON.stringify({ operation, input, action, actor }) });
      assert.equal(response.status, 200);
      return response.json();
    },
    async restart() { await mf.dispose(); mf = new Miniflare(options); },
  };
}
async function successful(f, operation, input, action, actor, name) {
  const result = await f.send(operation, input, action, actor, name);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
async function action(f, name, input, actor, objectName) { return successful(f, 'service', input, name, actor, objectName); }
function line(accountId, debitMinor, creditMinor, partyId = null, allocations = []) {
  return { accountId, debitMinor, creditMinor, partyId, allocations };
}
function accountInput(record, changes = {}) {
  const { code, name, rootType, purpose, isGroup, parentId, active } = record.value;
  return { id: record.id, revision: record.revision, code, name, rootType, purpose, isGroup, parentId, active, ...changes };
}
async function setup(f) {
  await successful(f, 'migrate');
  await action(f, 'configure-book', { startDate: '2030-01-01' });
  const accounts = {};
  for (const [code, rootType, purpose] of [['bank', 'asset', 'bank'], ['ar', 'asset', 'receivable'], ['income', 'income', 'general'], ['equity', 'equity', 'general'], ['ap', 'liability', 'payable'], ['expense', 'expense', 'general']]) {
    accounts[code] = await action(f, 'save-account', { id: randomUUID(), revision: null, code, name: code, rootType, purpose, isGroup: false, parentId: null, active: true });
  }
  const customer = await action(f, 'save-party', { id: randomUUID(), revision: null, code: 'CUSTOMER', name: 'Synthetic customer', kind: 'customer', active: true });
  const supplier = await action(f, 'save-party', { id: randomUUID(), revision: null, code: 'SUPPLIER', name: 'Synthetic supplier', kind: 'supplier', active: true });
  return { accounts, customer, supplier };
}
async function save(f, lines, postingDate = '2030-02-01') {
  return action(f, 'save-journal', { id: randomUUID(), revision: null, kind: 'journal', postingDate, memo: 'Synthetic workerd journal', reference: 'TEST', lines });
}
async function post(f, draft) {
  const command = { id: draft.id, revision: draft.revision, commandId: randomUUID() };
  return { command, receipt: await action(f, 'post-journal', command) };
}
async function report(f, type, extra = {}) {
  return action(f, 'report', { type, from: '2030-01-01', to: '2030-12-31', ...extra });
}
async function databaseSnapshot(f) {
  const snapshot = {};
  for (const name of ['settings', 'accounts', 'parties', 'journals', 'lines', 'allocations', 'audit', 'commands']) snapshot[name] = await successful(f, 'raw', { sql: `SELECT * FROM erp_ac_${name} ORDER BY rowid` });
  return snapshot;
}

test('workerd runtime never auto-migrates; explicit migration is empty/idempotent and ignores runtime-owned schema', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await successful(f, 'status'), { version: null, checksum: null, bookConfigured: false });
  assert.equal((await f.send('service', undefined, 'info')).error.code, 'SCHEMA_VERSION');
  const status = await successful(f, 'migrate');
  assert.equal(status.version, 2); assert.match(status.checksum, /^[a-f0-9]{64}$/); assert.equal(status.bookConfigured, false);
  const migration = await successful(f, 'raw', { sql: 'SELECT * FROM erp_ac_migrations' });
  assert.deepEqual(migration.map(({ version }) => version), [1, 2]);
  for (const name of ['settings', 'accounts', 'parties', 'journals', 'lines', 'allocations', 'audit', 'commands', 'coa_imports']) {
    assert.deepEqual(await successful(f, 'raw', { sql: `SELECT * FROM erp_ac_${name}` }), [], name);
  }
  await successful(f, 'migrate');
  assert.deepEqual(await successful(f, 'raw', { sql: 'SELECT * FROM erp_ac_migrations' }), migration);
  assert.equal((await action(f, 'info')).book, null);
  assert.deepEqual(await successful(f, 'internal-kv'), status);
  await successful(f, 'raw', { sql: 'CREATE TABLE unrelated_runtime_feature(value TEXT)' });
  assert.deepEqual(await successful(f, 'status'), status);
  assert.equal((await action(f, 'info')).book, null);
});

test('migration failure after real SQL DDL rolls back all plugin schema and permits explicit retry', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await successful(f, 'migration-fault'), { failure: 'ACCOUNTING_STORAGE', status: { version: null, checksum: null, bookConfigured: false } });
  assert.equal((await successful(f, 'migrate')).version, 2);
});

test('checksum, newer version, missing triggers and unrecognized plugin-owned objects fail closed without repair', async (t) => {
  const f = await fixture(t);
  const mutations = ["UPDATE erp_ac_migrations SET checksum=printf('%064d',0)", 'UPDATE erp_ac_migrations SET version=3 WHERE version=2', 'DELETE FROM erp_ac_migrations WHERE version=1', 'DROP TRIGGER erp_ac_settings_update', 'DROP TRIGGER erp_ac_coa_imports_insert', 'CREATE TABLE erp_ac_unapproved(value TEXT)', 'CREATE TRIGGER foreign_named_trigger AFTER INSERT ON erp_ac_accounts BEGIN SELECT 1; END'];
  for (const [index, sql] of mutations.entries()) {
    const name = `drift-${index}`;
    await successful(f, 'migrate', undefined, undefined, undefined, name);
    await successful(f, 'raw', { sql }, undefined, undefined, name);
    const before = await successful(f, 'raw', { sql: "SELECT name,sql FROM sqlite_schema WHERE name GLOB 'erp_ac_*' OR tbl_name GLOB 'erp_ac_*' ORDER BY name" }, undefined, undefined, name);
    for (const operation of ['status', 'migrate', 'service']) assert.equal((await f.send(operation, undefined, 'info', 'admin-1', name)).error.code, 'SCHEMA_VERSION');
    assert.deepEqual(await successful(f, 'raw', { sql: "SELECT name,sql FROM sqlite_schema WHERE name GLOB 'erp_ac_*' OR tbl_name GLOB 'erp_ac_*' ORDER BY name" }, undefined, undefined, name), before);
  }
});

test('real transactionSync rolls back and fences continuations, rejects nested/async work and preserves exact numeric boundaries', async (t) => {
  const f = await fixture(t);
  await successful(f, 'migrate');
  assert.deepEqual(await successful(f, 'adapter-probe'), { rollback: 'ACCOUNTING_STORAGE', nested: 'NESTED_TRANSACTION', crossAdapterNested: 'NESTED_TRANSACTION', closeDuringTransaction: 'ACTIVE_TRANSACTION', async: 'ASYNC_TRANSACTION', asyncCalled: false, thenable: 'ASYNC_TRANSACTION', continuation: 'ASYNC_TRANSACTION', auditCount: 0, safeBigint: Number.MAX_SAFE_INTEGER, unsafeBigint: 'INVALID_INPUT', fractional: 'INVALID_INPUT', unsafeRead: 'ACCOUNTING_STORAGE' });
  assert.deepEqual(await successful(f, 'write-probe'), {
    changes: 1, immutable: 'AUDIT_IMMUTABLE', duplicateRejected: true,
    saved: { event: 'test', actorId: 'admin-1', revision: 'r1' }, count: 1, closed: 'ACCOUNTING_CLOSED',
  });
});

test('financial fault after receipt insertion atomically restores draft, snapshots, allocations, audit and commands', async (t) => {
  const f = await fixture(t);
  const { accounts, customer } = await setup(f);
  const source = await save(f, [line(accounts.ar.id, 1000, 0, customer.id), line(accounts.income.id, 0, 1000)]);
  await post(f, source);
  const settlement = await action(f, 'save-settlement', { id: randomUUID(), revision: null, kind: 'receipt', postingDate: '2030-02-02', memo: 'Rollback receipt', reference: 'TEST', moneyAccountId: accounts.bank.id, partyId: customer.id, allocations: [{ sourceJournalId: source.id, sourceLineIndex: 0, amountMinor: 600 }] });
  const command = { id: settlement.id, revision: settlement.revision, commandId: randomUUID() };
  const before = await databaseSnapshot(f);
  assert.equal((await f.send('post-fault', command, 'post-journal')).ok, false);
  assert.deepEqual(await databaseSnapshot(f), before);
  assert.equal((await action(f, 'post-journal', command)).postedSequence, 2);
});

test('same-object concurrent writers serialize command replay and competing allocations; history/reversal survives reopen', async (t) => {
  const f = await fixture(t);
  const { accounts, customer, supplier } = await setup(f);
  const source = await save(f, [line(accounts.ar.id, 1000, 0, customer.id), line(accounts.income.id, 0, 1000)]);
  assert.equal((await report(f, 'debt')).totals.remainingMinor, '0');
  const command = { id: source.id, revision: source.revision, commandId: randomUUID() };
  const replay = await Promise.all([f.send('service', command, 'post-journal'), f.send('service', command, 'post-journal')]);
  assert.ok(replay.every((result) => result.ok)); assert.deepEqual(replay[0].data, replay[1].data);
  assert.equal((await f.send('service', command, 'post-journal', 'admin-2')).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.send('service', { ...command, revision: 'different' }, 'post-journal')).error.code, 'IDEMPOTENCY_CONFLICT');
  const drafts = [];
  for (let index = 0; index < 2; index++) drafts.push(await action(f, 'save-settlement', { id: randomUUID(), revision: null, kind: 'receipt', postingDate: '2030-02-02', memo: 'Competing receipt', reference: 'TEST', moneyAccountId: accounts.bank.id, partyId: customer.id, allocations: [{ sourceJournalId: source.id, sourceLineIndex: 0, amountMinor: 600 }] }));
  const contenders = drafts.map((draft) => ({ id: draft.id, revision: draft.revision, commandId: randomUUID() }));
  const results = await Promise.all(contenders.map((input) => f.send('service', input, 'post-journal')));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.find((result) => !result.ok).error.code, 'OVER_ALLOCATION');
  const winnerIndex = results.findIndex((result) => result.ok);
  const winner = results[winnerIndex].data;
  const debtBeforeReversal = await report(f, 'debt');
  assert.equal(debtBeforeReversal.totals.remainingMinor, '400'); assert.equal(debtBeforeReversal.reconciled, true);
  const activeSource = await action(f, 'get', { entity: 'journals', id: source.id });
  assert.equal((await f.send('service', { id: source.id, revision: activeSource.revision, commandId: randomUUID(), postingDate: '2030-02-03', memo: 'Must be blocked' }, 'reverse-journal')).error.code, 'ACTIVE_SETTLEMENT');
  const payable = await save(f, [line(accounts.expense.id, 800, 0), line(accounts.ap.id, 0, 800, supplier.id)]);
  await post(f, payable);
  const payment = await action(f, 'save-settlement', { id: randomUUID(), revision: null, kind: 'payment', postingDate: '2030-02-02', memo: 'Partial supplier payment', reference: 'TEST', moneyAccountId: accounts.bank.id, partyId: supplier.id, allocations: [{ sourceJournalId: payable.id, sourceLineIndex: 1, amountMinor: 300 }] });
  await post(f, payment);
  const beforeRestart = await databaseSnapshot(f);
  await f.restart();
  assert.deepEqual(await databaseSnapshot(f), beforeRestart);
  assert.deepEqual(await action(f, 'post-journal', command), replay[0].data);
  assert.deepEqual(await action(f, 'post-journal', contenders[winnerIndex]), winner);
  assert.equal((await report(f, 'debt')).totals.payableMinor, '500');
  await action(f, 'reverse-journal', { id: winner.id, revision: winner.revision, commandId: randomUUID(), postingDate: '2030-02-03', memo: 'Release allocation' });
  assert.equal((await report(f, 'debt', { to: '2030-02-02', partyId: customer.id })).totals.remainingMinor, '400');
  assert.equal((await report(f, 'debt', { partyId: customer.id })).totals.remainingMinor, '1000');
  await action(f, 'reverse-journal', { id: source.id, revision: activeSource.revision, commandId: randomUUID(), postingDate: '2030-02-03', memo: 'Reverse source' });
  assert.equal((await report(f, 'debt', { partyId: customer.id })).totals.remainingMinor, '0');
  const immutable = await f.send('raw', { sql: "UPDATE erp_ac_commands SET actorId='forged'" });
  assert.equal(immutable.ok, false);
});

test('separate Durable Objects isolate book/schema/journal/command data even under the same Worker namespace', async (t) => {
  const f = await fixture(t);
  const { accounts } = await setup(f);
  const original = await post(f, await save(f, [line(accounts.bank.id, 123, 0), line(accounts.equity.id, 0, 123)]));
  assert.deepEqual(await successful(f, 'status', undefined, undefined, undefined, 'other-installation'), { version: null, checksum: null, bookConfigured: false });
  await successful(f, 'migrate', undefined, undefined, undefined, 'other-installation');
  assert.equal((await successful(f, 'service', undefined, 'info', undefined, 'other-installation')).book, null);
  assert.deepEqual(await successful(f, 'raw', { sql: 'SELECT * FROM erp_ac_commands' }, undefined, undefined, 'other-installation'), []);
  assert.deepEqual(await action(f, 'post-journal', original.command), original.receipt);
});

test('workerd SQL integer bindings and exact report algorithms retain odd totals beyond MAX_SAFE_INTEGER', { timeout: 180_000 }, async (t) => {
  const f = await fixture(t);
  const { accounts } = await setup(f);
  const reports = await successful(f, 'large-totals', { bank: accounts.bank.id, equity: accounts.equity.id });
  for (const type of ['journal', 'ledger', 'trial-balance', 'cash-bank']) {
    assert.equal(reports[type].totals.debitMinor, '9050000000000001');
    assert.equal(reports[type].asOfSequence, 363);
    if (reports[type].nextTotals) assert.deepEqual(reports[type].nextTotals, reports[type].totals);
  }
  assert.equal(reports['trial-balance'].totals.closingDebitMinor, '9050000000000001');
  assert.equal(reports['trial-balance'].totals.closingCreditMinor, '9050000000000001');
  assert.equal(reports.ledger.totals.closingMinor, '9050000000000001');
  assert.equal(reports['cash-bank'].totals.closingMinor, '9050000000000001');
});

test('long Unicode and literal-symbol accounting searches preserve matching records on workerd', async (t) => {
  const f = await fixture(t);
  await setup(f);
  const term = 'Khách hàng kế toán '.repeat(5).trim();
  const party = await action(f, 'save-party', {
    id: randomUUID(), revision: null, kind: 'customer', code: 'UNICODE',
    name: `North ${term} %_\\ suffix`, active: true,
  });
  const code = 'SEARCH'.repeat(10);
  const account = await action(f, 'save-account', {
    id: randomUUID(), revision: null, code, name: 'Long searchable account',
    rootType: 'asset', purpose: 'general', isGroup: false, parentId: null, active: true,
  });
  assert.deepEqual((await action(f, 'list', { entity: 'parties', search: term.toUpperCase() })).items.map(item => item.id), [party.id]);
  assert.deepEqual((await action(f, 'list', { entity: 'parties', search: '%_\\' })).items.map(item => item.id), [party.id]);
  assert.deepEqual((await action(f, 'list', { entity: 'accounts', search: code.toLowerCase() })).items.map(item => item.id), [account.id]);
});

test('workerd imports both complete catalogs without seeding and posts real result-root line snapshots', async (t) => {
  const f = await fixture(t);
  for (const templateId of ['vn-tt133-2016', 'vn-tt99-2025']) {
    const invoke = (name, input) => action(f, name, input, undefined, templateId);
    const raw = (sql) => successful(f, 'raw', { sql }, undefined, undefined, templateId);
    await successful(f, 'migrate', undefined, undefined, undefined, templateId);
    await invoke('configure-book', { startDate: '2030-01-01' });
    assert.equal((await invoke('account-templates')).length, 2);
    const catalog = await invoke('account-template', { templateId });
    const selectedCodes = catalog.entries.filter((entry) => !entry.isGroup).map((entry) => entry.code);
    const selection = { templateId, templateVersion: catalog.templateVersion, selectedCodes };
    const preview = await invoke('preview-account-import', selection);
    assert.equal(preview.canImport, true);
    assert.equal(preview.createCount, catalog.entries.length);
    assert.equal(preview.conflictCount, 0);
    const receipt = await invoke('import-accounts', { ...selection, commandId: randomUUID() });
    assert.equal(receipt.created.length, catalog.entries.length);
    assert.deepEqual(receipt.existing, []);
    const accounts = await raw('SELECT * FROM erp_ac_accounts ORDER BY code');
    const byCode = new Map(accounts.map((entry) => [entry.code, entry]));
    for (const entry of catalog.entries) {
      const saved = byCode.get(entry.code);
      assert.equal(saved.name, entry.name);
      assert.equal(saved.rootType, entry.rootType);
      assert.equal(saved.purpose, entry.purpose);
      assert.equal(saved.isGroup, Number(entry.isGroup));
      assert.equal(saved.parentId, entry.parentCode === null ? null : byCode.get(entry.parentCode).id);
    }
    assert.equal(byCode.get('911').rootType, 'result');
    assert.equal(byCode.get('214').rootType, 'asset');
    assert.equal(byCode.get('229').rootType, 'asset');
    if (templateId === 'vn-tt133-2016') {
      assert.equal(byCode.get('1111').purpose, 'cash');
      assert.equal(byCode.get('1122').purpose, 'bank');
      assert.equal(byCode.get('6421').name, 'Chi phí bán hàng');
    } else {
      assert.equal(byCode.has('1111'), false);
      assert.equal(byCode.get('111').purpose, 'cash');
      assert.equal(byCode.get('6421').name, 'Chi phí nhân viên quản lý');
      assert.equal(byCode.get('215121').parentId, byCode.get('21512').id);
      assert.equal(byCode.get('21512').parentId, byCode.get('2151').id);
      assert.equal(byCode.get('2151').parentId, byCode.get('215').id);
    }
    const incomeCode = templateId === 'vn-tt133-2016' ? '5111' : '511';
    const draft = await invoke('save-journal', { id: randomUUID(), revision: null, kind: 'journal', postingDate: '2030-02-01', memo: 'Result root on workerd', reference: 'TEST', lines: [line(byCode.get(incomeCode).id, 100, 0), line(byCode.get('911').id, 0, 100)] });
    assert.equal((await invoke('post-journal', { id: draft.id, revision: draft.revision, commandId: randomUUID() })).postedSequence, 1);
    assert.deepEqual(await raw("SELECT accountRootType FROM erp_ac_lines WHERE accountRootType='result'"), [{ accountRootType: 'result' }]);
    const trial = await invoke('report', { type: 'trial-balance', from: '2030-01-01', to: '2030-12-31' });
    assert.equal(trial.items.find((entry) => entry.accountId === byCode.get('911').id).rootType, 'result');
  }
});

test('workerd subset closure, exact immutable replay after rename/reopen, and reciprocal command fences coexist', async (t) => {
  const f = await fixture(t);
  await successful(f, 'migrate');
  await action(f, 'configure-book', { startDate: '2030-01-01' });
  const selection = { templateId: 'vn-tt99-2025', templateVersion: '1', selectedCodes: ['215121', '33311'] };
  const command = { ...selection, commandId: randomUUID() };
  const preview = await action(f, 'preview-account-import', selection);
  assert.deepEqual(preview.rows.map((entry) => entry.code).sort(), ['215', '2151', '21512', '215121', '333', '3331', '33311']);
  const receipt = await action(f, 'import-accounts', command);
  assert.deepEqual(receipt.created.map((entry) => entry.code), ['215', '2151', '21512', '215121', '333', '3331', '33311']);
  const before = await databaseSnapshot(f);
  const existing = await action(f, 'import-accounts', { ...command, commandId: randomUUID() });
  assert.deepEqual(existing.created, []);
  assert.deepEqual(existing.existing, receipt.created);
  assert.deepEqual(await databaseSnapshot(f), before);
  const imported = receipt.created.find((entry) => entry.code === '215121');
  const account = await action(f, 'get', { entity: 'accounts', id: imported.id });
  await action(f, 'save-account', accountInput(account, { code: 'RENAMED-215121' }));
  const renamed = await databaseSnapshot(f);
  await f.restart();
  assert.deepEqual(await action(f, 'import-accounts', command), receipt);
  assert.deepEqual(await databaseSnapshot(f), renamed);
  assert.equal((await f.send('service', command, 'import-accounts', 'admin-2')).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.send('service', { ...command, selectedCodes: ['215122'] }, 'import-accounts')).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await successful(f, 'guarded-sql', [
    { sql: "UPDATE erp_ac_coa_imports SET actorId='forged' WHERE commandId=?", parameters: [command.commandId] },
    { sql: 'DELETE FROM erp_ac_coa_imports WHERE commandId=?', parameters: [command.commandId] },
    { sql: 'INSERT OR REPLACE INTO erp_ac_coa_imports SELECT * FROM erp_ac_coa_imports WHERE commandId=?', parameters: [command.commandId] },
    { sql: "INSERT INTO erp_ac_commands(commandId,action,actorId,canonicalPayloadHash,journalId,revision,postedSequence,createdAt) VALUES(?,'post-journal','admin-1',?,?,'r1',1,'2030-01-01')", parameters: [command.commandId, '0'.repeat(64), randomUUID()] },
  ]), ['COA_IMPORT_IMMUTABLE', 'COA_IMPORT_IMMUTABLE', 'COA_IMPORT_IMMUTABLE', 'IDEMPOTENCY_CONFLICT']);
  const income = await action(f, 'save-account', { id: randomUUID(), revision: null, code: 'TEST-INCOME', name: 'Test income', rootType: 'income', purpose: 'general', isGroup: false, parentId: null, active: true });
  const draft = await save(f, [line(imported.id, 100, 0), line(income.id, 0, 100)]);
  assert.equal((await f.send('service', { id: draft.id, revision: draft.revision, commandId: command.commandId }, 'post-journal')).error.code, 'IDEMPOTENCY_CONFLICT');
  const financial = await post(f, draft);
  assert.equal((await f.send('service', { ...command, commandId: financial.command.commandId }, 'import-accounts')).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await successful(f, 'guarded-sql', [
    { sql: 'INSERT INTO erp_ac_coa_imports(commandId,actorId,canonicalPayloadHash,templateId,templateVersion,resultJson,createdAt) SELECT ?,actorId,canonicalPayloadHash,templateId,templateVersion,resultJson,createdAt FROM erp_ac_coa_imports WHERE commandId=?', parameters: [financial.command.commandId, command.commandId] },
  ]), ['IDEMPOTENCY_CONFLICT']);
});

test('workerd import receipt fault rolls back every created account and audit before safe exact retry', async (t) => {
  const f = await fixture(t);
  await successful(f, 'migrate');
  await action(f, 'configure-book', { startDate: '2030-01-01' });
  const command = { templateId: 'vn-tt133-2016', templateVersion: '1', selectedCodes: ['33311', '911'], commandId: randomUUID() };
  const before = await databaseSnapshot(f);
  assert.equal((await f.send('import-fault', command, 'import-accounts')).ok, false);
  assert.deepEqual(await databaseSnapshot(f), before);
  assert.deepEqual(await successful(f, 'raw', { sql: 'SELECT * FROM erp_ac_coa_imports' }), []);
  const receipt = await action(f, 'import-accounts', command);
  assert.deepEqual(receipt.created.map((entry) => entry.code), ['333', '3331', '33311', '911']);
  assert.deepEqual(await action(f, 'import-accounts', command), receipt);
  const group = await action(f, 'get', { entity: 'accounts', id: receipt.created.find((entry) => entry.code === '333').id });
  await action(f, 'save-account', accountInput(group, { name: 'Operator-specific tax accounts' }));
  const conflicting = { templateId: command.templateId, templateVersion: '1', selectedCodes: ['33312', '911'] };
  const preview = await action(f, 'preview-account-import', conflicting);
  assert.equal(preview.canImport, false);
  assert.ok(preview.conflictCount > 0);
  const conflictBefore = await databaseSnapshot(f);
  const receiptsBefore = await successful(f, 'raw', { sql: 'SELECT * FROM erp_ac_coa_imports ORDER BY commandId' });
  assert.equal((await f.send('service', { ...conflicting, commandId: randomUUID() }, 'import-accounts')).error.code, 'COA_IMPORT_CONFLICT');
  assert.deepEqual(await databaseSnapshot(f), conflictBefore);
  assert.deepEqual(await successful(f, 'raw', { sql: 'SELECT * FROM erp_ac_coa_imports ORDER BY commandId' }), receiptsBefore);
});

test('real schema1 posted history and allocations survive atomic deferred-FK upgrade and interrupted rebuild rollback', async (t) => {
  const f = await fixture(t);
  const legacy = await successful(f, 'legacy-fixture', legacyArtifact);
  const before = await databaseSnapshot(f);
  const migrations = await successful(f, 'raw', { sql: 'SELECT * FROM erp_ac_migrations ORDER BY version' });
  assert.equal(before.allocations.length, 1);
  assert.equal(before.commands.length, 2);
  assert.equal((await successful(f, 'status')).version, 1);
  assert.equal((await f.send('service', undefined, 'info')).error.code, 'SCHEMA_VERSION');
  assert.deepEqual(await databaseSnapshot(f), before);
  const interrupted = await successful(f, 'migration-fault', { version: 2 });
  assert.equal(interrupted.failure, 'ACCOUNTING_STORAGE');
  assert.equal(interrupted.status.version, 1);
  assert.deepEqual(await databaseSnapshot(f), before);
  assert.deepEqual(await successful(f, 'raw', { sql: 'SELECT * FROM erp_ac_migrations ORDER BY version' }), migrations);
  assert.deepEqual(await successful(f, 'raw', { sql: 'PRAGMA defer_foreign_keys' }), [{ defer_foreign_keys: 0 }]);
  const invalid = await successful(f, 'migration-fault', { version: 2, integrity: true });
  assert.equal(invalid.failure, 'SCHEMA_VERSION');
  assert.equal(invalid.status.version, 1);
  assert.deepEqual(await databaseSnapshot(f), before);
  assert.deepEqual(await successful(f, 'raw', { sql: 'SELECT * FROM erp_ac_migrations ORDER BY version' }), migrations);
  assert.deepEqual(await successful(f, 'raw', { sql: 'PRAGMA defer_foreign_keys' }), [{ defer_foreign_keys: 0 }]);
  assert.equal((await successful(f, 'migrate')).version, 2);
  assert.deepEqual(await databaseSnapshot(f), before);
  assert.deepEqual((await successful(f, 'raw', { sql: 'SELECT * FROM erp_ac_migrations WHERE version=1' })), migrations);
  assert.deepEqual(await successful(f, 'raw', { sql: 'PRAGMA foreign_keys' }), [{ foreign_keys: 1 }]);
  for (const table of ['accounts', 'lines', 'allocations', 'commands']) {
    assert.deepEqual(await successful(f, 'raw', { sql: `PRAGMA foreign_key_check(erp_ac_${table})` }), []);
  }
  assert.deepEqual(await action(f, 'post-journal', legacy.command), legacy.receipt);
  assert.deepEqual(await action(f, 'post-journal', legacy.settlementCommand), legacy.settlementReceipt);
  assert.equal((await report(f, 'debt')).totals.remainingMinor, '600');
  assert.deepEqual(await successful(f, 'guarded-sql', [
    { sql: 'UPDATE erp_ac_lines SET debitMinor=999 WHERE journalId=? AND lineIndex=0', parameters: [legacy.command.id] },
    { sql: 'DELETE FROM erp_ac_allocations' },
    { sql: 'DELETE FROM erp_ac_commands' },
    { sql: 'DELETE FROM erp_ac_accounts WHERE id=?', parameters: [legacy.accounts.bank.id] },
  ]), ['JOURNAL_IMMUTABLE', 'JOURNAL_IMMUTABLE', 'COMMAND_IMMUTABLE', 'CONFLICT']);
  const imported = await action(f, 'import-accounts', { templateId: 'vn-tt99-2025', templateVersion: '1', selectedCodes: ['215121', '911'], commandId: randomUUID() });
  assert.deepEqual(imported.created.map((entry) => entry.code), ['215', '2151', '21512', '215121', '911']);
  const result = imported.created.find((entry) => entry.code === '911');
  const closing = await post(f, await save(f, [line(legacy.accounts.income.id, 100, 0), line(result.id, 0, 100)]));
  assert.equal(closing.receipt.postedSequence, 3);
  await f.restart();
  assert.deepEqual(await action(f, 'post-journal', legacy.command), legacy.receipt);
  assert.deepEqual(await action(f, 'post-journal', legacy.settlementCommand), legacy.settlementReceipt);
  assert.deepEqual(await action(f, 'post-journal', closing.command), closing.receipt);
});

test('real foreign-key corruption is rejected by status, open and migration without repairing history', async (t) => {
  const f = await fixture(t);
  await successful(f, 'migrate');
  // Deliberately bypass FK enforcement in this test-only raw harness. Production
  // migration resets deferred counters only after exact-schema and full FK checks.
  const journalId = randomUUID();
  const accountId = randomUUID();
  await successful(f, 'raw', { sql: `PRAGMA defer_foreign_keys=ON; INSERT INTO erp_ac_lines(journalId,lineIndex,accountId,role,debitMinor,creditMinor) VALUES('${journalId}',0,'${accountId}','general',1,0); PRAGMA defer_foreign_keys=OFF;` });
  const before = await successful(f, 'raw', { sql: 'SELECT * FROM erp_ac_lines' });
  assert.ok((await successful(f, 'raw', { sql: 'PRAGMA foreign_key_check(erp_ac_lines)' })).length > 0);
  for (const operation of ['status', 'migrate', 'service']) {
    assert.equal((await f.send(operation, undefined, 'info')).error.code, 'SCHEMA_VERSION');
  }
  assert.deepEqual(await successful(f, 'raw', { sql: 'SELECT * FROM erp_ac_lines' }), before);
});
