import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateAccountingDatabase, openAccountingDatabase } from '../src/accounting/sqlite.js';
import { HkdService } from '../src/accounting/hkd-service.js';
import { AccountingService } from '../src/accounting/service.js';
import { ErpError } from '../src/validation.js';
import type { AccountingStore } from '../src/accounting/store.js';
import type { HkdConfigureInput, HkdEntryPayload, HkdExpense, HkdMoney, HkdOtherTax, HkdRevenue, HkdStock, HkdReportInput, HkdReport } from '../src/accounting/hkd-model.js';

const time = '2030-03-01T12:00:00.000Z';
const now = () => new Date(time);
const actor = 'household-admin';
let nextId = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;
const code = (expected: string) => (error: unknown) => error instanceof ErpError && error.code === expected;
const base = (date = '2030-01-10') => ({ date, documentDate: date, documentNumber: 'CT-001', description: 'Synthetic documented activity' });
function revenue(overrides: Partial<HkdRevenue> = {}): HkdRevenue { return { ...base(), kind: 'revenue', amountMinor: 1000, businessLine: 'Bán hàng', vatRateBps: 100, pitRateBps: 0, vatTaxableMinor: 800, pitTaxableMinor: 0, incomeRevenueMinor: 900, ...overrides }; }
function stock(direction: HkdStock['direction'], quantity: string, amountMinor: number | null, date = '2030-01-01', extra: Partial<HkdStock> = {}): HkdStock { return { ...base(date), kind: 'stock', direction, itemCode: 'A', itemName: 'Hàng A', unit: 'kg', quantity, amountMinor, ...extra }; }
function money(direction: HkdMoney['direction'], amountMinor: number, date = '2030-01-01', extra: Partial<HkdMoney> = {}): HkdMoney { return { ...base(date), kind: 'money', direction, fund: 'cash', bankName: null, amountMinor, ...extra }; }
function tax(taxKind: HkdOtherTax['taxKind'], extra: Partial<HkdOtherTax> = {}): HkdOtherTax { return { ...base(), kind: 'tax', taxKind, quantity: '2.5', absoluteRateMinor: 0, unitTaxPriceMinor: 100, taxRateBps: 1000, ...extra }; }
function policy(overrides: Partial<HkdConfigureInput> = {}): HkdConfigureInput { return { commandId: uuid(), year: 2030, startDate: '2030-01-01', name: 'Hộ kinh doanh tổng hợp', address: 'Địa chỉ tổng hợp', taxCode: 'TEST-HKD', representative: 'Người đại diện', location: 'Hà Nội', taxMethod: 'income', periodType: 'month', incomeTaxRateBps: 2000, otherTaxes: true, ...overrides }; }
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'erp-hkd-')); const filename = join(directory, 'accounting.db');
  migrateAccountingDatabase(filename); const connections: AccountingStore[] = [];
  const open = () => { const raw = openAccountingDatabase(filename); connections.push(raw); return raw; };
  const store = open(); t.after(() => { connections.forEach((connection) => connection.close()); rmSync(directory, { recursive: true, force: true }); });
  const service = new HkdService(store, actor, now);
  const scope = (year = 2030) => store.get<{ installationId: string; revision: string }>('SELECT installationId,revision FROM erp_ac_hkd_profiles WHERE year=?', year) ?? { installationId: uuid(), revision: uuid() };
  const post = (entry: HkdEntryPayload, year = 2030, commandId = uuid()) => service.postEntry({ commandId, year, ...scope(year), entry });
  const report = (book: HkdReportInput['book'], period = 1, year = 2030) => service.report({ year, period, book });
  return { store, filename, open, service, post, report, scope };
}
async function configured(t: TestContext, overrides: Partial<HkdConfigureInput> = {}) { const value = fixture(t); const configured = await value.service.configure(policy(overrides)); assert.ok(configured.profile); return { ...value, profile: configured.profile, configured }; }
function snapshot(store: AccountingStore) { return ['erp_ac_hkd_profiles', 'erp_ac_hkd_events', 'erp_ac_hkd_commands'].map((table) => store.all(`SELECT * FROM ${table} ORDER BY rowid`)); }
async function allPages(service: HkdService, input: HkdReportInput): Promise<HkdReport> {
  const first = await service.report(input); const rows = [...first.rows]; let current = first;
  while (current.hasMore) { assert.ok(current.cursor); current = await service.report({ ...input, cursor: current.cursor }); assert.equal(current.asOfSequence, first.asOfSequence); assert.deepEqual(current.summaries, first.summaries); rows.push(...current.rows); }
  return { ...first, rows, hasMore: false };
}

test('annual HKD policy and revenue are independent from enterprise books, immutable, explicit and actor-gated', async (t) => {
  const { store, service, post, report, scope } = fixture(t);
  assert.deepEqual(await service.info(), { profiles: [], currency: 'VND', pageSize: 25 });
  await assert.rejects(post(revenue()), code('HKD_PROFILE_REQUIRED'));
  const input = policy({ taxMethod: 'exempt', incomeTaxRateBps: null }); const result = await service.configure(input);
  assert.equal(result.profile?.name, input.name); assert.equal(result.asOfSequence, 0); assert.equal((await service.info()).profiles.length, 1);
  assert.equal(store.get<{ n: number }>('SELECT count(*) AS n FROM erp_ac_settings')!.n, 0);
  assert.equal(store.get<{ n: number }>('SELECT count(*) AS n FROM erp_ac_hkd_events')!.n, 0);
  await assert.rejects(service.configure(policy()), code('CONFLICT'));
  await assert.rejects(service.configure(policy({ year: 2031, startDate: '2030-01-01' })), code('INVALID_INPUT'));
  await assert.rejects(service.configure(policy({ year: 2031, startDate: '2031-01-01', incomeTaxRateBps: null })), code('INVALID_INPUT'));
  await assert.rejects(post(revenue()), code('INVALID_INPUT'));
  await post(revenue({ businessLine: '', vatTaxableMinor: 0, vatRateBps: 0, incomeRevenueMinor: 0 }));
  const output = await report('S1a-HKD'); assert.equal(output.rows[0]!.cells.amountMinor, '1000'); assert.equal(output.summaries[0]!.cells.amountMinor, '1000');
  assert.equal('vatMinor' in output.summaries[0]!.cells, false, 'S1a does not declare VAT or PIT liabilities');
  assert.equal('pitMinor' in output.summaries[0]!.cells, false);
  assert.equal(output.profile.taxCode, input.taxCode); assert.equal(output.profile.representative, input.representative); assert.equal(output.from, '2030-01-01');
  await assert.rejects(report('S2a-HKD'), code('HKD_BOOK_UNAVAILABLE'));
  await assert.rejects(post(money('opening', 0)), code('HKD_BOOK_UNAVAILABLE'));
  const denied = new HkdService(store, '', now); const before = snapshot(store);
  for (const action of [() => denied.info(), () => denied.configure(policy()), () => denied.postEntry({ commandId: uuid(), year: 2030, ...scope(), entry: revenue() }), () => denied.voidEntry({ commandId: uuid(), year: 2030, ...scope(), id: uuid(), reason: 'Denied' }), () => denied.list({ year: 2030 }), () => denied.report({ year: 2030, period: 1, book: 'S1a-HKD' })]) await assert.rejects(action(), code('AUTH_REQUIRED'));
  assert.deepEqual(snapshot(store), before);
});

test('revenue method freezes explicit independent bases, tax rates and normalized industry plus both-rate groups', async (t) => {
  const { post, report } = await configured(t, { taxMethod: 'revenue', incomeTaxRateBps: null });
  await post(revenue({ amountMinor: 1000, vatTaxableMinor: 800, pitTaxableMinor: 500, pitRateBps: 200, incomeRevenueMinor: 0 }));
  await post(revenue({ businessLine: 'ＢÁN HÀNG', amountMinor: 2000, vatTaxableMinor: 1000, pitTaxableMinor: 1000, pitRateBps: 200, incomeRevenueMinor: 0 }));
  await post(revenue({ amountMinor: 500, vatTaxableMinor: 500, pitTaxableMinor: 500, pitRateBps: 100, incomeRevenueMinor: 0 }));
  const book = await report('S2a-HKD'); assert.equal(book.rows[0]!.cells.vatMinor, '8'); assert.equal(book.rows[0]!.cells.pitMinor, '10');
  assert.equal(book.summaries.length, 3); assert.equal(book.summaries[0]!.cells.amountMinor, '3000'); assert.equal(book.summaries[1]!.cells.amountMinor, '500');
  assert.equal(book.summaries[2]!.cells.vatMinor, '23'); assert.equal(book.summaries[2]!.cells.pitMinor, '35');
  await assert.rejects(post(revenue()), code('INVALID_INPUT'));
  await assert.rejects(post(revenue({ incomeRevenueMinor: 0, vatTaxableMinor: 1001 })), code('INVALID_INPUT'));
  await assert.rejects(report('S2c-HKD'), code('HKD_BOOK_UNAVAILABLE'));
});

test('income books use explicitly certified six expense categories, not cash flows or stock issues', async (t) => {
  const { post, report, service, scope } = await configured(t);
  await post(revenue({ amountMinor: 2000, incomeRevenueMinor: 1500 }));
  const categories: HkdExpense['category'][] = ['materials', 'labour', 'depreciation', 'services', 'interest', 'other'];
  for (const category of categories) await post({ ...base(), kind: 'expense', category, amountMinor: 200, deductibleMinor: 100 });
  await post(stock('opening', '1', 500)); await post(stock('out', '1', null, '2030-01-03'));
  await post(money('opening', 1000)); await post(money('out', 1000, '2030-01-04'));
  const revenueBook = await report('S2b-HKD'); assert.equal(revenueBook.summaries.at(-1)!.cells.vatMinor, '8');
  assert.equal('pitMinor' in revenueBook.summaries.at(-1)!.cells, false, 'income-method PIT belongs to S2c, not a misleading zero in S2b');
  const costs = await report('S2c-HKD'); assert.equal(costs.rows.length, 7);
  for (const category of categories) assert.equal(costs.summaries[0]!.cells[category], '100');
  assert.equal(costs.summaries[0]!.cells.deductibleMinor, '600'); assert.equal(costs.summaries[1]!.cells.differenceMinor, '900'); assert.equal(costs.summaries[2]!.cells.incomeTaxMinor, '180');
  const loss = await post({ ...base(), kind: 'expense', category: 'other', amountMinor: 2000, deductibleMinor: 2000 });
  assert.equal((await report('S2c-HKD')).summaries[2]!.cells.incomeTaxMinor, '0');
  await service.voidEntry({ commandId: uuid(), year: 2030, ...scope(), id: loss.entry!.id, reason: 'Duplicate documented expense' });
  assert.equal((await report('S2c-HKD')).summaries[2]!.cells.incomeTaxMinor, '180');
  await assert.rejects(post(revenue({ pitTaxableMinor: 1 })), code('INVALID_INPUT'));
  await assert.rejects(post({ ...base(), kind: 'expense', category: 'other', amountMinor: 100, deductibleMinor: 101 }), code('INVALID_INPUT'));
});

test('S2d values issues using ALL period receipts rather than moving average; prior periods carry exact closing', async (t) => {
  const { post, report } = await configured(t);
  await post(stock('opening', '10', 100)); const issue = await post(stock('out', '10', null, '2030-01-02'));
  await post(stock('in', '10', 200, '2030-01-20'));
  const jan = await report('S2d-HKD'); const line = jan.rows.find((row) => row.entryId === issue.entry!.id)!;
  assert.equal(line.cells.outMinor, '150', 'moving average would incorrectly issue100'); assert.equal(line.cells.unitPriceMinor, '15'); assert.equal(line.cells.balanceMinor, '-50', 'period-average temporary negative value is allowed while quantity stays nonnegative');
  assert.equal(jan.summaries[0]!.cells.balanceQuantity, '10'); assert.equal(jan.summaries[0]!.cells.balanceMinor, '150');
  const febIssue = await post(stock('out', '5', null, '2030-02-03')); await post(stock('in', '10', 300, '2030-02-20'));
  const feb = await report('S2d-HKD', 2); assert.equal(feb.rows[0]!.cells.balanceQuantity, '10'); assert.equal(feb.rows[0]!.cells.balanceMinor, '150');
  assert.equal(feb.rows.find((row) => row.entryId === febIssue.entry!.id)!.cells.outMinor, '113');
  assert.equal(feb.summaries[0]!.cells.balanceQuantity, '15'); assert.equal(feb.summaries[0]!.cells.balanceMinor, '337');
  assert.equal((await report('S2d-HKD', 3)).summaries[0]!.cells.balanceMinor, '337');
});

test('fractional quantity allocation conserves dong remainders and full depletion at exact micro-unit precision', async (t) => {
  const { post, report } = await configured(t);
  await post(stock('opening', '00.300000', 2));
  const a = await post(stock('out', '0.1', null, '2030-01-02')); const b = await post(stock('out', '0.100000', null, '2030-01-03')); const c = await post(stock('out', '0.1', null, '2030-01-04'));
  const reportA = await report('S2d-HKD'); assert.deepEqual([a, b, c].map((result) => reportA.rows.find((row) => row.entryId === result.entry!.id)!.cells.outMinor), ['1', '0', '1']);
  assert.equal(reportA.rows[0]!.cells.balanceQuantity, '0.3'); assert.equal(reportA.summaries[0]!.cells.outMinor, '2'); assert.equal(reportA.summaries[0]!.cells.balanceMinor, '0');
  await post(stock('opening', '0.000002', 1, '2030-01-01', { itemCode: 'B', itemName: 'Hàng B' }));
  await post(stock('out', '0.000001', null, '2030-01-02', { itemCode: 'B', itemName: 'Hàng B' }));
  await post(stock('out', '0.000001', null, '2030-01-03', { itemCode: 'B', itemName: 'Hàng B' }));
  const final = await report('S2d-HKD'); const summary = final.summaries.find((row) => row.cells.itemCode === 'B')!; assert.equal(summary.cells.balanceMinor, '0'); assert.equal(summary.cells.outMinor, '1');
});

test('backdating and void validate all chronological stock and fund balances atomically, including downstream periods', async (t) => {
  const { store, service, post, scope } = await configured(t);
  await assert.rejects(post(stock('in', '1', 10)), code('HKD_OPENING_REQUIRED'));
  const opening = await post(stock('opening', '0', 0)); const receipt = await post(stock('in', '10', 100, '2030-01-10')); const issue = await post(stock('out', '10', null, '2030-02-03'));
  const before = snapshot(store);
  await assert.rejects(post(stock('out', '1', null, '2030-01-09')), code('HKD_NEGATIVE_STOCK'));
  await assert.rejects(service.voidEntry({ commandId: uuid(), year: 2030, ...scope(), id: receipt.entry!.id, reason: 'Would invalidate February' }), code('HKD_NEGATIVE_STOCK'));
  await assert.rejects(service.voidEntry({ commandId: uuid(), year: 2030, ...scope(), id: opening.entry!.id, reason: 'Opening required' }), code('HKD_OPENING_REQUIRED'));
  await assert.rejects(post(stock('in', '1', 10, '2030-02-05', { itemCode: 'ａ', itemName: 'Renamed item' })), code('HKD_IDENTITY_CONFLICT'));
  assert.deepEqual(snapshot(store), before);
  await service.voidEntry({ commandId: uuid(), year: 2030, ...scope(), id: issue.entry!.id, reason: 'Wrong issue' });
  await service.voidEntry({ commandId: uuid(), year: 2030, ...scope(), id: receipt.entry!.id, reason: 'Wrong receipt' });
  await assert.rejects(post(stock('in', '1', 1, '2030-01-20', { itemName: 'New historical identity' })), code('HKD_IDENTITY_CONFLICT'));
  await assert.rejects(post(money('in', 1)), code('HKD_OPENING_REQUIRED'));
  await post(money('opening', 0)); const incoming = await post(money('in', 100, '2030-01-10')); await post(money('out', 100, '2030-02-10'));
  const moneyBefore = snapshot(store);
  await assert.rejects(service.voidEntry({ commandId: uuid(), year: 2030, ...scope(), id: incoming.entry!.id, reason: 'Would invalidate February' }), code('HKD_NEGATIVE_MONEY'));
  await assert.rejects(post(money('out', 1, '2030-01-09')), code('HKD_NEGATIVE_MONEY'));
  assert.deepEqual(snapshot(store), moneyBefore);
});

test('S2e isolates cash and each named bank/provider with explicit annual opening and period totals', async (t) => {
  const { post, report, service } = await configured(t);
  await post(money('opening', 100)); await post(money('in', 50, '2030-01-02')); await post(money('out', 20, '2030-01-03'));
  await post(money('opening', 200, '2030-01-01', { fund: 'bank', bankName: 'Bank A' }));
  await post(money('out', 60, '2030-01-04', { fund: 'bank', bankName: 'ＢＡＮＫ A' }));
  await post(money('opening', 0, '2030-01-01', { fund: 'bank', bankName: 'Payment provider' }));
  await post(money('in', 30, '2030-01-05', { fund: 'bank', bankName: 'Payment provider' }));
  const jan = await report('S2e-HKD'); assert.equal(jan.summaries.length, 3);
  const cash = jan.summaries.find((row) => row.label === 'Tiền mặt')!; assert.equal(cash.cells.openingMinor, '100'); assert.equal(cash.cells.inMinor, '50'); assert.equal(cash.cells.outMinor, '20'); assert.equal(cash.cells.balanceMinor, '130');
  const feb = await report('S2e-HKD', 2); assert.equal(feb.summaries.find((row) => row.label === 'Bank A')!.cells.openingMinor, '140');
  await service.configure(policy({ year: 2031, startDate: '2031-01-01' }));
  await assert.rejects(post(money('out', 1, '2031-01-02'), 2031), code('HKD_OPENING_REQUIRED'));
  await assert.rejects(post(money('opening', 0, '2030-01-02')), code('INVALID_INPUT'));
});

test('S3a implements percentage, absolute and combined trade taxes plus environment/resource/land with exact large arithmetic', async (t) => {
  const { post, report } = await configured(t);
  for (const kind of ['export', 'import', 'excise'] as const) await post(tax(kind, { absoluteRateMinor: 2 }));
  await post(tax('environment', { absoluteRateMinor: 3, unitTaxPriceMinor: 0, taxRateBps: 0 }));
  await post(tax('resource')); await post(tax('land'));
  const book = await report('S3a-HKD'); assert.equal(book.rows.length, 6);
  for (const row of book.rows.slice(0, 3)) { assert.equal(row.cells.percentageMinor, '25'); assert.equal(row.cells.absoluteMinor, '5'); assert.equal(row.cells.dueMinor, '30'); }
  const total = book.summaries[0]!.cells; assert.equal(total.dueMinor, '90'); assert.equal(total.environmentMinor, '8'); assert.equal(total.resourceMinor, '25'); assert.equal(total.landMinor, '25');
  await post(tax('excise', { quantity: '1000000000000', unitTaxPriceMinor: 1_000_000_000_000, taxRateBps: 15000 }));
  assert.equal((await report('S3a-HKD')).rows.at(-1)!.cells.dueMinor, '1500000000000000000000000');
  await assert.rejects(post(tax('environment')), code('INVALID_INPUT'));
  await assert.rejects(post(tax('resource', { absoluteRateMinor: 1 })), code('INVALID_INPUT'));
  await assert.rejects(post(tax('export', { unitTaxPriceMinor: 100, taxRateBps: 0 })), code('INVALID_INPUT'));
  await assert.rejects(post(tax('import', { unitTaxPriceMinor: 0, taxRateBps: 0 })), code('INVALID_INPUT'));
});

test('quarter/year canonical periods and explicit start dates determine stock valuation and supported indices', async (t) => {
  const { post, report } = await configured(t, { periodType: 'quarter', startDate: '2030-02-01' });
  await post(stock('opening', '10', 100, '2030-02-01')); const issue = await post(stock('out', '5', null, '2030-02-02')); await post(stock('in', '10', 300, '2030-03-01'));
  const q1 = await report('S2d-HKD'); assert.equal(q1.from, '2030-02-01'); assert.equal(q1.to, '2030-03-31'); assert.equal(q1.rows.find((row) => row.entryId === issue.entry!.id)!.cells.outMinor, '100');
  await assert.rejects(report('S2d-HKD', 5), code('INVALID_INPUT'));
  await assert.rejects(post(revenue({ date: '2030-01-31' })), code('INVALID_INPUT'));
  const annual = await configured(t, { periodType: 'year' }); await annual.post(stock('opening', '1', 10)); const out = await annual.post(stock('out', '1', null, '2030-01-02')); await annual.post(stock('in', '1', 30, '2030-12-01'));
  const year = await annual.report('S2d-HKD'); assert.equal(year.to, '2030-12-31'); assert.equal(year.rows.find((row) => row.entryId === out.entry!.id)!.cells.outMinor, '20');
  await assert.rejects(annual.report('S2d-HKD', 2), code('INVALID_INPUT'));
});

test('report and list pagination retain high-water snapshots after new writes and voids; summaries cover all pages', async (t) => {
  const { service, post, scope } = await configured(t);
  const posted = [];
  for (let i = 0; i < 61; i++) posted.push(await post(revenue({ amountMinor: 1000, vatTaxableMinor: 1000, incomeRevenueMinor: 1000 })));
  const input: HkdReportInput = { year: 2030, period: 1, book: 'S2b-HKD' };
  const first = await service.report(input); const listing = await service.list({ year: 2030 }); assert.equal(first.rows.length, 25); assert.equal(listing.items.length, 25); assert.equal(first.summaries.at(-1)!.cells.amountMinor, '61000');
  await service.voidEntry({ commandId: uuid(), year: 2030, ...scope(), id: posted[30]!.entry!.id, reason: 'After snapshot' }); await post(revenue());
  const second = await service.report({ ...input, cursor: first.cursor }); const third = await service.report({ ...input, cursor: second.cursor });
  assert.equal(second.asOfSequence, first.asOfSequence); assert.deepEqual(second.summaries, first.summaries); assert.equal(third.rows.length, 11); assert.equal(third.hasMore, false);
  const ids = [...first.rows, ...second.rows, ...third.rows].map((row) => row.entryId); assert.equal(new Set(ids).size, 61); assert.ok(ids.includes(posted[30]!.entry!.id));
  const secondList = await service.list({ year: 2030, cursor: listing.cursor }); assert.equal(secondList.items[5]!.id, posted[30]!.entry!.id); assert.equal(secondList.items[5]!.voided, false);
  const current = await service.list({ year: 2030 }); const current2 = await service.list({ year: 2030, cursor: current.cursor }); assert.equal(current2.items[5]!.voidReason, 'After snapshot');
  const full = await allPages(service, input); assert.equal(full.rows.length, 61); assert.equal(full.summaries.at(-1)!.cells.amountMinor, '61000');
});

test('stock/fund summaries span paged detail without truncated totals or missing carry rows', async (t) => {
  const { post, service } = await configured(t);
  await post(stock('opening', '0', 0)); await post(money('opening', 0));
  for (let i = 0; i < 31; i++) { await post(stock('in', '0.1', 10, '2030-01-02')); await post(money('in', 10, '2030-01-02')); }
  const inventory = await allPages(service, { year: 2030, period: 1, book: 'S2d-HKD' }); assert.equal(inventory.rows.length, 32); assert.equal(inventory.summaries[0]!.cells.inMinor, '310'); assert.equal(inventory.summaries[0]!.cells.balanceQuantity, '3.1');
  const cash = await allPages(service, { year: 2030, period: 1, book: 'S2e-HKD' }); assert.equal(cash.rows.length, 32); assert.equal(cash.summaries[0]!.cells.balanceMinor, '310');
});

test('strict cursor envelopes reject malformed, foreign-filter/profile, forged offsets and unknown fields', async (t) => {
  const { service, post } = await configured(t); for (let i = 0; i < 26; i++) await post(revenue());
  const input: HkdReportInput = { year: 2030, period: 1, book: 'S2b-HKD' }; const page = await service.report(input); const list = await service.list({ year: 2030 }); assert.ok(page.cursor); assert.ok(list.cursor);
  for (const cursor of ['not-json', '{}', JSON.stringify({ ...JSON.parse(page.cursor), offset: 1 }), JSON.stringify({ ...JSON.parse(page.cursor), anchor: 'missing' }), JSON.stringify({ ...JSON.parse(page.cursor), sequence: 99999 }), JSON.stringify({ ...JSON.parse(page.cursor), extra: true })]) await assert.rejects(service.report({ ...input, cursor }), code('INVALID_CURSOR'));
  await assert.rejects(service.report({ ...input, period: 2, cursor: page.cursor }), code('INVALID_CURSOR'));
  await assert.rejects(service.report({ ...input, book: 'S2c-HKD', cursor: page.cursor }), code('INVALID_CURSOR'));
  for (const cursor of ['nope', '{}', page.cursor, JSON.stringify({ ...JSON.parse(list.cursor), after: 1 }), JSON.stringify({ ...JSON.parse(list.cursor), sequence: 99999 })]) await assert.rejects(service.list({ year: 2030, cursor }), code('INVALID_CURSOR'));
  await service.configure(policy({ year: 2031, startDate: '2031-01-01' }));
  await assert.rejects(service.list({ year: 2031, cursor: list.cursor }), code('INVALID_CURSOR'));
  await assert.rejects(service.report({ year: 2031, period: 1, book: 'S2b-HKD', cursor: page.cursor }), code('INVALID_CURSOR'));
});

test('every mutation replays exact immutable receipts across reopening, void, actor/payload changes and namespaces', async (t) => {
  const { store, service, open, scope } = fixture(t); const configure = policy(); const configResult = await service.configure(configure); assert.deepEqual(await service.configure(configure), configResult);
  const command = { commandId: uuid(), year: 2030, ...scope(), entry: revenue() }; const result = await service.postEntry(command);
  const voidInput = { commandId: uuid(), year: 2030, ...scope(), id: result.entry!.id, reason: 'Synthetic correction' }; const voidResult = await service.voidEntry(voidInput);
  const reopen = new HkdService(open(), actor, now); assert.deepEqual(await reopen.configure(configure), configResult); assert.deepEqual(await reopen.postEntry(command), result); assert.deepEqual(await reopen.voidEntry(voidInput), voidResult);
  const before = snapshot(store); const other = new HkdService(store, 'another-admin', now);
  for (const action of [() => other.configure(configure), () => other.postEntry(command), () => other.voidEntry(voidInput), () => service.postEntry({ ...command, entry: revenue({ description: 'Different' }) }), () => service.voidEntry({ ...voidInput, reason: 'Different reason' }), () => service.configure({ ...configure, name: 'Different name' }), () => service.postEntry({ ...command, commandId: configure.commandId }), () => service.voidEntry({ ...voidInput, commandId: command.commandId })]) await assert.rejects(action(), code('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(snapshot(store), before);
  const enterprise = new AccountingService(store, actor, now); await enterprise.configureBook({ startDate: '2030-01-01' });
  const importedCommand = { commandId: uuid(), templateId: 'vn-tt133-2016', templateVersion: '1', selectedCodes: ['911'] }; await enterprise.importAccounts(importedCommand);
  await assert.rejects(service.postEntry({ ...command, commandId: importedCommand.commandId }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(enterprise.importAccounts({ ...importedCommand, commandId: command.commandId }), code('IDEMPOTENCY_CONFLICT'));
  const assets = await enterprise.saveAccount({ id: uuid(), revision: null, code: 'SYNTH-ASSET', name: 'Synthetic asset', rootType: 'asset', purpose: 'general', isGroup: false, parentId: null, active: true });
  const equity = await enterprise.saveAccount({ id: uuid(), revision: null, code: 'SYNTH-EQUITY', name: 'Synthetic equity', rootType: 'equity', purpose: 'general', isGroup: false, parentId: null, active: true });
  const draft = await enterprise.saveJournal({ id: uuid(), revision: null, kind: 'journal', postingDate: '2030-01-10', memo: 'Cross namespace', reference: '', lines: [{ accountId: assets.id, debitMinor: 10, creditMinor: 0, partyId: null, allocations: [] }, { accountId: equity.id, debitMinor: 0, creditMinor: 10, partyId: null, allocations: [] }] });
  await assert.rejects(enterprise.postJournal({ id: draft.id, revision: draft.revision, commandId: command.commandId }), code('IDEMPOTENCY_CONFLICT'));
  const journalCommand = { id: draft.id, revision: draft.revision, commandId: uuid() }; await enterprise.postJournal(journalCommand);
  await assert.rejects(service.postEntry({ ...command, commandId: journalCommand.commandId }), code('IDEMPOTENCY_CONFLICT'));
});

test('household storage errors are sanitized and rollback profiles, events and receipts atomically', async (t) => {
  const { store, service, scope } = fixture(t); let fail = '';
  const wrapped: AccountingStore = { get: store.get.bind(store), all: store.all.bind(store), close() {}, run(sql, ...parameters) { if (fail && sql.includes(fail)) throw new Error('Injected durable write failure'); return store.run(sql, ...parameters); }, transaction: store.transaction.bind(store) };
  const faulting = new HkdService(wrapped, actor, now); const input = policy(); const empty = snapshot(store); fail = 'INSERT INTO erp_ac_hkd_commands';
  await assert.rejects(faulting.configure(input), code('ACCOUNTING_STORAGE')); assert.deepEqual(snapshot(store), empty);
  fail = ''; await faulting.configure(input); const command = { commandId: uuid(), year: 2030, ...scope(), entry: revenue() }; const configured = snapshot(store);
  fail = 'INSERT INTO erp_ac_hkd_commands'; await assert.rejects(faulting.postEntry(command), code('ACCOUNTING_STORAGE')); assert.deepEqual(snapshot(store), configured);
  fail = 'INSERT INTO erp_ac_hkd_events'; await assert.rejects(faulting.postEntry(command), code('ACCOUNTING_STORAGE')); assert.deepEqual(snapshot(store), configured);
  fail = ''; const result = await faulting.postEntry(command); const posted = snapshot(store); const voidInput = { commandId: uuid(), year: 2030, ...scope(), id: result.entry!.id, reason: 'Faulted correction' };
  fail = 'INSERT INTO erp_ac_hkd_commands'; await assert.rejects(faulting.voidEntry(voidInput), code('ACCOUNTING_STORAGE')); assert.deepEqual(snapshot(store), posted);
  fail = ''; await faulting.voidEntry(voidInput); assert.equal((await service.list({ year: 2030 })).items[0]!.voided, true);
});

test('strict bounded validation rejects unknown/client-owned fields, impossible dates, costs and meaningless operands before writes', async (t) => {
  const { service, store, post, scope } = await configured(t); const before = snapshot(store);
  for (const entry of [revenue({ amountMinor: 1_000_000_000_001 }), revenue({ amountMinor: 1.5 }), revenue({ date: '2030-02-30' }), revenue({ date: '2031-01-01' }), { ...revenue(), actorId: 'spoofed' }, stock('opening', '0.0000001', 0), stock('opening', '1000000000000.000001', 0), stock('opening', '0', 1), stock('out', '1', 10), stock('in', '1', null), money('opening', 1, '2030-01-01', { bankName: 'Meaningless cash bank' }), tax('environment', { quantity: '0', absoluteRateMinor: 1, unitTaxPriceMinor: 0, taxRateBps: 0 })]) await assert.rejects(service.postEntry({ commandId: uuid(), year: 2030, ...scope(), entry }), code('INVALID_INPUT'));
  await assert.rejects(service.postEntry({ commandId: uuid(), year: 2030, ...scope(), entry: revenue(), actorId: 'spoofed' }), code('INVALID_INPUT'));
  await assert.rejects(service.configure({ ...policy({ year: 2031, startDate: '2031-01-01' }), group: 'inferred' }), code('INVALID_INPUT'));
  await assert.rejects(service.voidEntry({ commandId: uuid(), year: 2030, ...scope(), id: uuid(), reason: '  ' }), code('INVALID_INPUT'));
  assert.deepEqual(snapshot(store), before);
  const normalized = await post(stock('opening', '0000000000000.000000', 0)); assert.equal(normalized.entry!.entry.kind, 'stock'); if (normalized.entry!.entry.kind === 'stock') assert.equal(normalized.entry!.entry.quantity, '0');
});

test('later-period receipt changes revalue current stock but cannot rewrite a paged stock snapshot', async (t) => {
  const { service, post } = await configured(t);
  await post(stock('opening', '31', 31));
  const issues = [];
  for (let i = 0; i < 31; i++) issues.push(await post(stock('out', '1', null, '2030-01-02')));
  const input: HkdReportInput = { year: 2030, period: 1, book: 'S2d-HKD' };
  const first = await service.report(input);
  assert.equal(first.rows.length, 25); assert.equal(first.summaries[0]!.cells.outMinor, '31'); assert.ok(first.cursor);
  await post(stock('in', '31', 93, '2030-01-30'));
  const oldSecond = await service.report({ ...input, cursor: first.cursor });
  assert.equal(oldSecond.rows.length, 7); assert.equal(oldSecond.rows[0]!.cells.outMinor, '1'); assert.equal(oldSecond.summaries[0]!.cells.balanceMinor, '0');
  const current = await allPages(service, input);
  assert.equal(current.summaries[0]!.cells.outMinor, '62'); assert.equal(current.summaries[0]!.cells.balanceMinor, '62');
  for (const issue of issues) assert.equal(current.rows.find((row) => row.entryId === issue.entry!.id)!.cells.outMinor, '2');
});

test('explicit other-tax enablement is independent of all three methods; taxable expense and tax totals span report pages', async (t) => {
  const { service, post } = await configured(t);
  for (let i = 0; i < 31; i++) {
    await post(revenue({ amountMinor: 100, vatTaxableMinor: 100, incomeRevenueMinor: 100 }));
    await post({ ...base(), kind: 'expense', category: 'materials', amountMinor: 50, deductibleMinor: 10 });
    await post(tax('environment', { absoluteRateMinor: 3, unitTaxPriceMinor: 0, taxRateBps: 0 }));
  }
  const income = await allPages(service, { year: 2030, period: 1, book: 'S2c-HKD' });
  assert.equal(income.rows.length, 62); assert.equal(income.summaries[0]!.cells.revenueMinor, '3100'); assert.equal(income.summaries[0]!.cells.materials, '310'); assert.equal(income.summaries[2]!.cells.incomeTaxMinor, '558');
  const taxes = await allPages(service, { year: 2030, period: 1, book: 'S3a-HKD' });
  assert.equal(taxes.rows.length, 31); assert.equal(taxes.summaries[0]!.cells.environmentMinor, '248');
  await service.configure(policy({ year: 2031, startDate: '2031-01-01', taxMethod: 'exempt', incomeTaxRateBps: null, otherTaxes: false }));
  await assert.rejects(service.report({ year: 2031, period: 1, book: 'S3a-HKD' }), code('HKD_BOOK_UNAVAILABLE'));
  await assert.rejects(post(tax('resource', { date: '2031-01-02' }), 2031), code('HKD_BOOK_UNAVAILABLE'));
  await service.configure(policy({ year: 2032, startDate: '2032-01-01', taxMethod: 'exempt', incomeTaxRateBps: null, otherTaxes: true }));
  await post(tax('resource', { date: '2032-01-02' }), 2032);
  assert.equal((await service.report({ year: 2032, period: 1, book: 'S3a-HKD' })).summaries[0]!.cells.resourceMinor, '25');
});

test('database enforces immutable policy, events and exact-command receipts even for direct SQL writes', async (t) => {
  const { store, post } = await configured(t);
  await post(revenue());
  const before = snapshot(store);
  for (const table of ['erp_ac_hkd_profiles', 'erp_ac_hkd_events', 'erp_ac_hkd_commands']) {
    const record = store.get<Record<string, string | number | null>>(`SELECT * FROM ${table}`)!;
    const fields = Object.keys(record);
    assert.throws(() => store.run(`UPDATE ${table} SET ${fields[0]}=${fields[0]}`));
    assert.throws(() => store.run(`DELETE FROM ${table}`));
    assert.throws(() => store.run(`INSERT OR REPLACE INTO ${table}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`, ...fields.map((key) => record[key]!)));
    assert.deepEqual(snapshot(store), before);
  }
});

test('turnover taxes round whole-period normalized industry bases once, not each sale, including across pages', async (t) => {
  const { post, report, service } = await configured(t, { taxMethod: 'revenue', incomeTaxRateBps: null });
  await post(revenue({ amountMinor: 50, vatTaxableMinor: 50, pitTaxableMinor: 50, pitRateBps: 100, incomeRevenueMinor: 0 }));
  await post(revenue({ amountMinor: 50, businessLine: 'ＢÁN HÀNG', vatTaxableMinor: 50, pitTaxableMinor: 50, pitRateBps: 100, incomeRevenueMinor: 0 }));
  let book = await report('S2a-HKD');
  assert.deepEqual(book.rows.map((row) => row.cells.vatMinor), ['1', '0']);
  assert.deepEqual(book.rows.map((row) => row.cells.pitMinor), ['1', '0']);
  assert.equal(book.summaries[0]!.cells.vatMinor, '1'); assert.equal(book.summaries[0]!.cells.pitMinor, '1');
  for (let i = 0; i < 25; i++) await post(revenue({ amountMinor: 50, vatTaxableMinor: 50, pitTaxableMinor: 50, pitRateBps: 100, incomeRevenueMinor: 0 }));
  book = await allPages(service, { year: 2030, period: 1, book: 'S2a-HKD' });
  assert.equal(book.rows.length, 27);
  assert.equal(book.summaries[0]!.cells.vatTaxableMinor, '1350'); assert.equal(book.summaries[0]!.cells.vatMinor, '14');
  assert.equal(book.rows.reduce((sum, row) => sum + BigInt(row.cells.vatMinor!), 0n), 14n);
  assert.equal(book.rows.reduce((sum, row) => sum + BigInt(row.cells.pitMinor!), 0n), 14n);
  await service.configure(policy({ year: 2031, startDate: '2031-02-01' }));
  await assert.rejects(service.report({ year: 2031, period: 1, book: 'S2b-HKD' }), code('INVALID_INPUT'));
});

test('hybrid S3a obligation rounds the exact sum once rather than rounding both half-dong components up', async (t) => {
  const { post, report } = await configured(t);
  await post(tax('excise', { quantity: '0.5', unitTaxPriceMinor: 1, taxRateBps: 10000, absoluteRateMinor: 1 }));
  const book = await report('S3a-HKD'); const cells = book.rows[0]!.cells;
  assert.equal(cells.taxKind, 'Thuế tiêu thụ đặc biệt');
  assert.equal(cells.percentageMinor, '1'); assert.equal(cells.absoluteMinor, '0'); assert.equal(cells.dueMinor, '1');
  assert.equal(book.summaries[0]!.cells.dueMinor, '1');
});

test('retained commands cannot mutate a replacement annual profile after resource restoration', async (t) => {
  const original = await configured(t);
  const replacement = await configured(t);
  const command = { commandId: uuid(), year: 2030, ...original.scope(), entry: revenue() };
  const before = snapshot(replacement.store);
  await assert.rejects(replacement.service.postEntry(command), code('HKD_PROFILE_MISMATCH'));
  assert.deepEqual(snapshot(replacement.store), before);
  const posted = await original.service.postEntry(command);
  const originalBefore = snapshot(original.store);
  await assert.rejects(original.service.voidEntry({ commandId: uuid(), year: 2030, ...replacement.scope(), id: posted.entry!.id, reason: 'Wrong installation' }), code('HKD_PROFILE_MISMATCH'));
  await assert.rejects(original.service.postEntry({ ...command, ...replacement.scope() }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(original.service.postEntry({ commandId: uuid(), year: 2030, entry: revenue() }), code('INVALID_INPUT'));
  assert.deepEqual(snapshot(original.store), originalBefore);
  assert.deepEqual(await original.service.postEntry(command), posted);
});
