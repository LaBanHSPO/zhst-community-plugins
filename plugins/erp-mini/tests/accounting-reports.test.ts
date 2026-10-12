import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateAccountingDatabase, openAccountingDatabase } from '../src/accounting/sqlite.js';
import { buildAccountingReport } from '../src/accounting/reports.js';
import { ErpError } from '../src/validation.js';
import type { AccountingStore } from '../src/accounting/store.js';
import type { AccountPurpose, RootType, PartyKind, ReportInput, AccountReportRow, SourceReportRow, JournalReportRow } from '../src/accounting/model.js';

const time = '2030-01-01T12:00:00.000Z';
const actor = 'report-admin';
interface FixtureLine { accountId: string; partyId?: string; debit?: number; credit?: number; allocations?: { journalId: string; lineIndex: number; amount: number }[] }
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'erp-report-'));
  const filename = join(directory, 'accounting.db');
  migrateAccountingDatabase(filename);
  const store = openAccountingDatabase(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.run("INSERT INTO erp_ac_settings VALUES('book',1,'book-r1','VND',0,'2030-01-01',?,?,?,?,?)", globalThis.crypto.randomUUID(), time, actor, time, actor);
  return store;
}
function account(store: AccountingStore, code: string, root: RootType = 'asset', purpose: AccountPurpose = 'general'): string {
  const id = globalThis.crypto.randomUUID();
  store.run('INSERT INTO erp_ac_accounts VALUES(?,1,?,?,?,?,?,?,?,0,NULL,1,?,?,?,?)', id, globalThis.crypto.randomUUID(), code, code.toLowerCase(), `Original ${code}`, code.toLowerCase(), root, purpose, time, actor, time, actor);
  return id;
}
function party(store: AccountingStore, code: string, kind: PartyKind): string {
  const id = globalThis.crypto.randomUUID();
  store.run('INSERT INTO erp_ac_parties VALUES(?,1,?,?,?,?,?,?,1,NULL,NULL,NULL,?,?,?,?)', id, globalThis.crypto.randomUUID(), kind, code, code.toLowerCase(), `Original ${code}`, code.toLowerCase(), time, actor, time, actor);
  return id;
}
function postDraft(store: AccountingStore, id: string): void {
  const sequence = store.get<{ next: number }>('SELECT coalesce(max(postedSequence),0)+1 AS next FROM erp_ac_journals')!.next;
  store.run("UPDATE erp_ac_journals SET status='posted',revision=?,number=?,postedSequence=?,postedAt=?,postedBy=? WHERE id=?", globalThis.crypto.randomUUID(), `J-${sequence}`, sequence, time, actor, id);
}
function journal(store: AccountingStore, date: string, lines: FixtureLine[], kind: 'journal' | 'opening' | 'receipt' | 'payment' = 'journal', status: 'posted' | 'draft' | 'cancelled' = 'posted'): string {
  const id = globalThis.crypto.randomUUID();
  store.transaction(() => {
    store.run("INSERT INTO erp_ac_journals VALUES(?,1,?,?,'draft',?,'Synthetic report fixture','REPORT','VND',NULL,NULL,NULL,NULL,NULL,?,?,?,?)", id, globalThis.crypto.randomUUID(), kind, date, time, actor, time, actor);
    lines.forEach((line, index) => {
      const a = store.get<{ code: string; name: string; rootType: string; purpose: string }>('SELECT code,name,rootType,purpose FROM erp_ac_accounts WHERE id=?', line.accountId)!;
      const p = line.partyId ? store.get<{ code: string; name: string; kind: string }>('SELECT code,name,kind FROM erp_ac_parties WHERE id=?', line.partyId)! : null;
      const role = a.purpose === 'receivable' ? line.debit ? 'open-item' : 'settlement' : a.purpose === 'payable' ? line.credit ? 'open-item' : 'settlement' : 'general';
      store.run('INSERT INTO erp_ac_lines VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, index, line.accountId, line.partyId ?? null, role, a.code, a.name, a.rootType, a.purpose, p?.code ?? null, p?.name ?? null, p?.kind ?? null, line.debit ?? 0, line.credit ?? 0);
      for (const allocation of line.allocations ?? []) store.run('INSERT INTO erp_ac_allocations VALUES(?,?,?,?,?)', id, index, allocation.journalId, allocation.lineIndex, allocation.amount);
    });
    if (status === 'posted') postDraft(store, id);
    else if (status === 'cancelled') store.run("UPDATE erp_ac_journals SET status='cancelled' WHERE id=?", id);
  });
  return id;
}
function reverse(store: AccountingStore, original: string, date: string): string {
  const id = globalThis.crypto.randomUUID();
  store.transaction(() => {
    store.run("INSERT INTO erp_ac_journals VALUES(?,1,?,'reversal','draft',?,'Synthetic reversal','REVERSE','VND',NULL,NULL,NULL,NULL,?,?,?,?,?)", id, globalThis.crypto.randomUUID(), date, original, time, actor, time, actor);
    store.run("INSERT INTO erp_ac_lines SELECT ?,lineIndex,accountId,partyId,'reversal',accountCode,accountName,accountRootType,accountPurpose,partyCode,partyName,partyKind,creditMinor,debitMinor FROM erp_ac_lines WHERE journalId=?", id, original);
    postDraft(store, id);
  });
  return id;
}
function report(store: AccountingStore, type: ReportInput['type'], extra: Partial<ReportInput> = {}) {
  return buildAccountingReport(store, { type, from: '2030-01-01', to: '2030-12-31', ...extra });
}
function code(expected: string) {
  return (error: unknown) => error instanceof ErpError && error.code === expected;
}

test('opening, inclusive movements, both-sided trial balances, cash flows and posted-only journal/ledger reconcile', (t) => {
  const store = fixture(t);
  const bank = account(store, 'BANK', 'asset', 'bank');
  const cash = account(store, 'CASH', 'asset', 'cash');
  const equity = account(store, 'EQUITY', 'equity');
  const expense = account(store, 'EXPENSE', 'expense');
  journal(store, '2030-01-01', [{ accountId: bank, debit: 2000 }, { accountId: equity, credit: 2000 }], 'opening');
  journal(store, '2030-02-01', [{ accountId: cash, debit: 300 }, { accountId: bank, credit: 300 }]);
  journal(store, '2030-02-28', [{ accountId: expense, debit: 150 }, { accountId: cash, credit: 150 }]);
  journal(store, '2030-03-01', [{ accountId: expense, debit: 40 }, { accountId: bank, credit: 40 }]);
  for (const status of ['draft', 'cancelled'] as const) journal(store, '2030-02-01', [{ accountId: bank, debit: 999 }, { accountId: equity, credit: 999 }], 'journal', status);
  const range = { from: '2030-02-01', to: '2030-02-28' };
  const trial = report(store, 'trial-balance', range);
  assert.equal(trial.totals.openingDebitMinor, '2000'); assert.equal(trial.totals.openingCreditMinor, '2000');
  assert.equal(trial.totals.debitMinor, '450'); assert.equal(trial.totals.creditMinor, '450');
  assert.equal(trial.totals.closingDebitMinor, '2000'); assert.equal(trial.totals.closingCreditMinor, '2000');
  const bankRow = (trial.items as AccountReportRow[]).find((row) => row.accountId === bank)!;
  assert.equal(bankRow.openingMinor, '2000'); assert.equal(bankRow.creditMinor, '300'); assert.equal(bankRow.closingMinor, '1700');
  const ledger = report(store, 'ledger', { ...range, accountId: bank });
  assert.equal(ledger.items.length, 1); assert.equal(ledger.totals.openingMinor, '2000'); assert.equal(ledger.totals.closingMinor, '1700');
  const cashReport = report(store, 'cash-bank', range);
  assert.equal(cashReport.totals.openingMinor, '2000'); assert.equal(cashReport.totals.inflowMinor, '300'); assert.equal(cashReport.totals.outflowMinor, '450'); assert.equal(cashReport.totals.netFlowMinor, '-150'); assert.equal(cashReport.totals.closingMinor, '1850');
  assert.equal(report(store, 'journal', range).items.length, 4);
  assert.equal(report(store, 'journal', { from: '2030-03-01', to: '2030-03-01' }).totals.debitMinor, '40');
});

test('journal/ledger keyset run exceeds25 and remains stable through backdated posting, rename and reversal', (t) => {
  const store = fixture(t);
  const bank = account(store, 'BANK', 'asset', 'bank');
  const equity = account(store, 'EQUITY', 'equity');
  const originals: string[] = [];
  for (let i = 0; i < 31; i++) originals.push(journal(store, '2030-02-01', [{ accountId: bank, debit: i + 1 }, { accountId: equity, credit: i + 1 }]));
  const first = report(store, 'journal');
  const ledgerFirst = report(store, 'ledger', { accountId: bank });
  assert.equal(first.items.length, 25); assert.equal(first.hasMore, true); assert.equal(first.totals.debitMinor, '496');
  store.run("UPDATE erp_ac_accounts SET code='RENAMED',name='Changed bank',active=0 WHERE id=?", bank);
  const reversal = reverse(store, originals[0]!, '2030-03-01');
  const other = account(store, 'OTHER');
  journal(store, '2030-01-02', [{ accountId: other, debit: 1000 }, { accountId: equity, credit: 1000 }]);
  const rows = [...first.items];
  let page = first;
  while (page.hasMore) { page = report(store, 'journal', { cursor: page.cursor }); rows.push(...page.items); assert.deepEqual(page.totals, first.totals); assert.equal(page.asOfSequence, 31); }
  assert.equal(rows.length, 62);
  assert.equal(new Set((rows as JournalReportRow[]).map((row) => `${row.journalId}/${row.lineIndex}`)).size, 62);
  assert.ok((rows as JournalReportRow[]).filter((row) => row.accountId === bank).every((row) => row.accountName === 'Original BANK'));
  assert.ok((rows as JournalReportRow[]).every((row) => row.reversedBy === null && row.postedBy === actor && row.postedAt === time));
  const ledgerNext = report(store, 'ledger', { accountId: bank, cursor: ledgerFirst.cursor });
  assert.equal(ledgerNext.items.length, 6); assert.equal(ledgerNext.totals.closingMinor, '496');
  const refreshed = report(store, 'journal');
  assert.equal(refreshed.asOfSequence, 33); assert.equal(refreshed.totals.debitMinor, '1497');
  assert.equal((refreshed.items as JournalReportRow[]).find((row) => row.journalId === originals[0])!.reversedBy, reversal);
  const historical = report(store, 'ledger', { accountId: bank, to: '2030-02-28' });
  assert.equal(historical.totals.closingMinor, '496');
  assert.equal((historical.items[0] as JournalReportRow).reversedBy, null);
  const reversalRows = report(store, 'journal', { from: '2030-03-01' }).items as JournalReportRow[];
  assert.equal(reversalRows[0]!.reversalOf, originals[0]); assert.equal(reversalRows[0]!.journalId, reversal);
  assert.equal(report(store, 'ledger', { accountId: bank }).totals.closingMinor, '495');
});

test('account report pages pin snapshot labels, totals and membership beyond25', (t) => {
  const store = fixture(t);
  const equity = account(store, 'EQUITY', 'equity');
  const accounts: string[] = [];
  for (let i = 0; i < 30; i++) { const id = account(store, `BANK-${i}`, 'asset', 'bank'); accounts.push(id); journal(store, '2030-02-01', [{ accountId: id, debit: 10 }, { accountId: equity, credit: 10 }]); }
  for (const type of ['trial-balance', 'cash-bank'] as const) {
    const first = report(store, type);
    assert.equal(first.items.length, 25); assert.equal(first.hasMore, true);
    for (const id of accounts) store.run("UPDATE erp_ac_accounts SET name='Renamed bank' WHERE id=?", id);
    const extra = account(store, `NEW-${type}`, 'asset', 'bank');
    journal(store, '2030-01-02', [{ accountId: extra, debit: 5 }, { accountId: equity, credit: 5 }]);
    const next = report(store, type, { cursor: first.cursor });
    assert.deepEqual(next.totals, first.totals); assert.equal(next.hasMore, false);
    assert.ok((next.items as AccountReportRow[]).filter((row) => row.purpose === 'bank').every((row) => row.accountName.startsWith('Original')));
    assert.equal(first.items.length + next.items.length, 31);
    assert.equal(report(store, type).totals.debitMinor, type === 'trial-balance' ? '305' : '310');
  }
});

test('AR/AP/opening debt uses source snapshots and same date/sequence for allocations, release and source reversals', (t) => {
  const store = fixture(t);
  const bank = account(store, 'BANK', 'asset', 'bank');
  const ar = account(store, 'AR', 'asset', 'receivable');
  const ap = account(store, 'AP', 'liability', 'payable');
  const equity = account(store, 'EQUITY', 'equity');
  const income = account(store, 'INCOME', 'income');
  const expense = account(store, 'EXPENSE', 'expense');
  const customer = party(store, 'CUSTOMER', 'customer');
  const supplier = party(store, 'SUPPLIER', 'supplier');
  const opening = journal(store, '2030-01-01', [{ accountId: ar, partyId: customer, debit: 400 }, { accountId: equity, credit: 400 }], 'opening');
  const source = journal(store, '2030-02-01', [{ accountId: ar, partyId: customer, debit: 1000 }, { accountId: income, credit: 1000 }]);
  const payable = journal(store, '2030-02-01', [{ accountId: expense, debit: 800 }, { accountId: ap, partyId: supplier, credit: 800 }]);
  const receipt = journal(store, '2030-02-10', [{ accountId: bank, debit: 600 }, { accountId: ar, partyId: customer, credit: 600, allocations: [{ journalId: source, lineIndex: 0, amount: 600 }] }], 'receipt');
  const payment = journal(store, '2030-02-11', [{ accountId: ap, partyId: supplier, debit: 300, allocations: [{ journalId: payable, lineIndex: 1, amount: 300 }] }, { accountId: bank, credit: 300 }], 'payment');
  const before = report(store, 'debt', { from: '2030-02-01', to: '2030-02-28' });
  assert.equal(before.reconciled, true); assert.equal(before.totals.receivableMinor, '800'); assert.equal(before.totals.payableMinor, '500');
  assert.equal(before.totals.originalMinor, '2200'); assert.equal(before.totals.allocatedMinor, '900'); assert.equal(before.totals.remainingMinor, '1300');
  assert.ok((before.items as SourceReportRow[]).some((row) => row.journalId === opening));
  store.run("UPDATE erp_ac_parties SET code='CUSTOMER-NEW',name='Renamed customer',active=0 WHERE id=?", customer);
  store.run("UPDATE erp_ac_accounts SET name='Renamed AR',active=0 WHERE id=?", ar);
  reverse(store, receipt, '2030-03-01');
  reverse(store, payment, '2030-03-02');
  reverse(store, source, '2030-03-03');
  const historical = report(store, 'debt', { to: '2030-02-28' });
  assert.deepEqual(historical.totals, before.totals); assert.equal(historical.reconciled, true);
  const historicalSource = (historical.items as SourceReportRow[]).find((row) => row.journalId === source)!;
  assert.equal(historicalSource.partyName, 'Original CUSTOMER'); assert.equal(historicalSource.accountName, 'Original AR'); assert.equal(historicalSource.remainingMinor, '400');
  const released = report(store, 'debt', { to: '2030-03-02' });
  assert.equal(released.reconciled, true); assert.equal(released.totals.receivableMinor, '1400'); assert.equal(released.totals.payableMinor, '800');
  const current = report(store, 'debt');
  assert.equal(current.reconciled, true); assert.equal(current.totals.receivableMinor, '400'); assert.equal(current.totals.payableMinor, '800');
  assert.ok(!(current.items as SourceReportRow[]).some((row) => row.journalId === source));
  const customerOnly = report(store, 'debt', { partyId: customer });
  assert.equal(customerOnly.totals.remainingMinor, '400'); assert.equal(customerOnly.totals.controlPayableMinor, '0');
  assert.equal(report(store, 'ledger', { accountId: ar, partyId: customer }).totals.closingMinor, '400');
  assert.equal(report(store, 'debt', { to: '2030-01-31' }).totals.remainingMinor, '400');
});

test('debt page totals and source membership remain pinned after allocation/source reversal and new backdated source', (t) => {
  const store = fixture(t);
  const ar = account(store, 'AR', 'asset', 'receivable');
  const income = account(store, 'INCOME', 'income');
  const bank = account(store, 'BANK', 'asset', 'bank');
  const customer = party(store, 'C', 'customer');
  const sources: string[] = [];
  for (let i = 0; i < 28; i++) sources.push(journal(store, '2030-02-01', [{ accountId: ar, partyId: customer, debit: 100 }, { accountId: income, credit: 100 }]));
  const settlement = journal(store, '2030-02-02', [{ accountId: bank, debit: 50 }, { accountId: ar, partyId: customer, credit: 50, allocations: [{ journalId: sources[27]!, lineIndex: 0, amount: 50 }] }], 'receipt');
  const first = report(store, 'debt');
  assert.equal(first.items.length, 25); assert.equal(first.totals.remainingMinor, '2750');
  reverse(store, settlement, '2030-02-03'); reverse(store, sources[27]!, '2030-02-04');
  journal(store, '2030-01-02', [{ accountId: ar, partyId: customer, debit: 700 }, { accountId: income, credit: 700 }]);
  store.run("UPDATE erp_ac_parties SET name='New label' WHERE id=?", customer);
  const next = report(store, 'debt', { cursor: first.cursor });
  assert.equal(next.items.length, 3); assert.deepEqual(next.totals, first.totals); assert.equal(next.reconciled, true);
  assert.equal((next.items as SourceReportRow[]).find((row) => row.journalId === sources[27])!.remainingMinor, '50');
  assert.ok((next.items as SourceReportRow[]).every((row) => row.partyName === 'Original C'));
  const fresh = report(store, 'debt'); assert.equal(fresh.totals.remainingMinor, '3400'); assert.equal(fresh.reconciled, true);
});

test('generic mixed-source settlement reversal releases allocations historically and source chronology fences keep controls exact', (t) => {
  const store = fixture(t);
  const ar = account(store, 'AR', 'asset', 'receivable');
  const income = account(store, 'INCOME', 'income');
  const bank = account(store, 'BANK', 'asset', 'bank');
  const customer = party(store, 'C', 'customer');
  const source = journal(store, '2030-02-05', [{ accountId: ar, partyId: customer, debit: 100 }, { accountId: income, credit: 100 }]);
  const attempt = (date: string) => journal(store, date, [{ accountId: bank, debit: 60 }, { accountId: ar, partyId: customer, credit: 60, allocations: [{ journalId: source, lineIndex: 0, amount: 60 }] }]);
  assert.throws(() => attempt('2030-02-04'), code('OVER_ALLOCATION'));
  assert.equal(report(store, 'debt', { to: '2030-02-04' }).totals.remainingMinor, '0');
  const mixed = journal(store, '2030-02-06', [
    { accountId: ar, partyId: customer, debit: 200 },
    { accountId: ar, partyId: customer, credit: 60, allocations: [{ journalId: source, lineIndex: 0, amount: 60 }] },
    { accountId: income, credit: 140 },
  ]);
  const receipt = journal(store, '2030-02-07', [{ accountId: bank, debit: 100 }, { accountId: ar, partyId: customer, credit: 100, allocations: [{ journalId: mixed, lineIndex: 0, amount: 100 }] }], 'receipt');
  assert.throws(() => reverse(store, mixed, '2030-02-08'), code('ACTIVE_SETTLEMENT'));
  const before = report(store, 'debt', { to: '2030-02-08' });
  assert.equal(before.totals.remainingMinor, '140'); assert.equal(before.reconciled, true);
  reverse(store, receipt, '2030-02-09');
  assert.throws(() => reverse(store, mixed, '2030-02-08'), code('ALLOCATION_DATE_CONFLICT'));
  reverse(store, mixed, '2030-02-10');
  assert.throws(() => attempt('2030-02-09'), code('ALLOCATION_DATE_CONFLICT'));
  assert.throws(() => reverse(store, source, '2030-02-09'), code('ALLOCATION_DATE_CONFLICT'));
  const restored = report(store, 'debt', { to: '2030-02-10' });
  assert.equal(restored.totals.remainingMinor, '100'); assert.equal(restored.totals.allocatedMinor, '0'); assert.equal(restored.reconciled, true);
  assert.equal(report(store, 'debt', { to: '2030-02-08' }).totals.remainingMinor, '140');
  reverse(store, source, '2030-02-10');
  assert.equal(report(store, 'debt').totals.remainingMinor, '0'); assert.equal(report(store, 'debt').reconciled, true);
});

test('empty books and leap-day boundaries have exact zero totals; filtered trial balances need not balance the whole book', (t) => {
  const store = fixture(t);
  for (const type of ['journal', 'ledger', 'trial-balance', 'cash-bank', 'debt'] as const) {
    const empty = report(store, type);
    assert.equal(empty.items.length, 0); assert.equal(empty.hasMore, false); assert.equal(empty.asOfSequence, 0);
    assert.ok(Object.values(empty.totals).every((amount) => amount === '0'));
    if (type === 'debt') assert.equal(empty.reconciled, true);
  }
  const bank = account(store, 'BANK', 'asset', 'bank'); const equity = account(store, 'EQUITY', 'equity');
  journal(store, '2032-02-29', [{ accountId: bank, debit: 17 }, { accountId: equity, credit: 17 }]);
  const boundary = report(store, 'trial-balance', { from: '2032-02-29', to: '2032-02-29', accountId: bank });
  assert.equal(boundary.totals.debitMinor, '17'); assert.equal(boundary.totals.creditMinor, '0');
  assert.equal(boundary.totals.closingDebitMinor, '17'); assert.equal(boundary.totals.closingCreditMinor, '0');
  const earlier = report(store, 'ledger', { to: '2032-02-28', accountId: bank });
  assert.equal(earlier.totals.closingMinor, '0');
  const after = report(store, 'ledger', { from: '2032-03-01', to: '2032-03-01', accountId: bank });
  assert.equal(after.totals.openingMinor, '17'); assert.equal(after.totals.debitMinor, '0'); assert.equal(after.totals.closingMinor, '17');
});

test('historical allocations stream across a batch boundary without dropping a dong or using operational releases', (t) => {
  const store = fixture(t);
  const ar = account(store, 'AR', 'asset', 'receivable'); const income = account(store, 'INCOME', 'income');
  const bank = account(store, 'BANK', 'asset', 'bank'); const customer = party(store, 'C', 'customer');
  const source = journal(store, '2030-02-01', [{ accountId: ar, partyId: customer, debit: 1000 }, { accountId: income, credit: 1000 }]);
  let lastReceipt = '';
  for (let i = 0; i < 270; i++) lastReceipt = journal(store, '2030-02-02', [
    { accountId: bank, debit: 1 },
    { accountId: ar, partyId: customer, credit: 1, allocations: [{ journalId: source, lineIndex: 0, amount: 1 }] },
  ], 'receipt');
  const before = report(store, 'debt', { to: '2030-02-02' });
  assert.equal(before.totals.allocatedMinor, '270'); assert.equal(before.totals.remainingMinor, '730'); assert.equal(before.reconciled, true);
  reverse(store, lastReceipt, '2030-02-03');
  assert.deepEqual(report(store, 'debt', { to: '2030-02-02' }).totals, before.totals);
  const after = report(store, 'debt', { to: '2030-02-03' });
  assert.equal(after.totals.allocatedMinor, '269'); assert.equal(after.totals.remainingMinor, '731'); assert.equal(after.reconciled, true);
});

test('strict report dates, cursor shape/filter/installation/watermark and anchor bounds fail safely', (t) => {
  const store = fixture(t);
  const bank = account(store, 'BANK'); const equity = account(store, 'EQUITY', 'equity');
  for (let i = 0; i < 14; i++) journal(store, '2030-02-01', [{ accountId: bank, debit: 1 }, { accountId: equity, credit: 1 }]);
  for (const extra of [{ from: '2030-02-29' }, { to: '2030-04-31' }, { from: '0000-01-01' }, { from: '2029-12-31' }, { from: '2030-04-01', to: '2030-03-01' }]) assert.throws(() => report(store, 'journal', extra), code('INVALID_INPUT'));
  const first = report(store, 'journal');
  assert.throws(() => report(store, 'journal', { cursor: '{' }), code('INVALID_CURSOR'));
  assert.throws(() => report(store, 'journal', { cursor: first.cursor, accountId: bank }), code('INVALID_CURSOR'));
  assert.throws(() => report(store, 'ledger', { cursor: first.cursor }), code('INVALID_CURSOR'));
  assert.throws(() => report(store, 'journal', { cursor: first.cursor, to: '2030-11-30' }), code('INVALID_CURSOR'));
  const cursor = JSON.parse(first.cursor!);
  for (const changed of [
    { ...cursor, version: 2 }, { ...cursor, installationId: globalThis.crypto.randomUUID() },
    { ...cursor, asOfSequence: 9999 }, { ...cursor, secret: true },
    { ...cursor, position: { ...cursor.position, lineIndex: 49 } },
    { ...cursor, position: { ...cursor.position, postingDate: '2029-12-31' } },
    { ...cursor, position: { ...cursor.position, postedSequence: 0 } },
    { ...cursor, position: { accountId: bank } },
  ]) assert.throws(() => report(store, 'journal', { cursor: JSON.stringify(changed) }), code('INVALID_CURSOR'));
  const another = fixture(t); assert.throws(() => report(another, 'journal', { cursor: first.cursor }), code('INVALID_CURSOR'));
});

test('odd aggregate beyond MAX_SAFE is exact over362 real50-line posted journals, including later pages', (t) => {
  const store = fixture(t);
  const bank = account(store, 'BANK', 'asset', 'bank'); const equity = account(store, 'EQUITY', 'equity');
  const lines: FixtureLine[] = [];
  for (let i = 0; i < 25; i++) lines.push({ accountId: bank, debit: 1_000_000_000_000 }, { accountId: equity, credit: 1_000_000_000_000 });
  for (let i = 0; i < 362; i++) journal(store, '2030-02-01', lines);
  journal(store, '2030-02-01', [{ accountId: bank, debit: 1 }, { accountId: equity, credit: 1 }]);
  const exact = '9050000000000001';
  assert.notEqual(BigInt(Number(exact)), BigInt(exact));
  for (const type of ['journal', 'ledger', 'trial-balance', 'cash-bank'] as const) {
    const first = report(store, type, type === 'ledger' ? { accountId: bank } : {});
    assert.equal(first.totals.debitMinor, exact);
    if (type === 'journal' || type === 'trial-balance') assert.equal(first.totals.creditMinor, exact);
    if (type === 'ledger' || type === 'cash-bank') assert.equal(first.totals.closingMinor, exact);
    if (first.hasMore) assert.equal(report(store, type, { ...(type === 'ledger' ? { accountId: bank } : {}), cursor: first.cursor }).totals.debitMinor, exact);
  }
  const trial = report(store, 'trial-balance');
  assert.equal(trial.totals.closingDebitMinor, exact); assert.equal(trial.totals.closingCreditMinor, exact);
  const opening = report(store, 'cash-bank', { from: '2030-03-01' }); assert.equal(opening.totals.openingMinor, exact); assert.equal(opening.totals.debitMinor, '0');
});
