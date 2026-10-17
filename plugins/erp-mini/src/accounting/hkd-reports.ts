import { z } from 'zod';
import { ErpError } from '../validation.js';
import type { AccountingStore } from './store.js';
import type { HkdBook, HkdEntry, HkdOtherTax, HkdProfile, HkdReport, HkdReportInput, HkdReportRow, HkdStock } from './hkd-model.js';
import { hkdEntrySchema, quantityText, quantityUnits } from './hkd-validation.js';

const taxLabels: Record<HkdOtherTax['taxKind'], string> = {
  export: 'Thuế xuất khẩu', import: 'Thuế nhập khẩu', excise: 'Thuế tiêu thụ đặc biệt',
  environment: 'Thuế bảo vệ môi trường', resource: 'Thuế tài nguyên', land: 'Thuế sử dụng đất',
};

export const hkdKey = (value: string): string => value.normalize('NFKC').toLowerCase();
export function roundDong(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) throw new ErpError('INVALID_RECORD', 'Invalid nonnegative monetary ratio.');
  return (numerator * 2n + denominator) / (denominator * 2n);
}
export function hkdMaxSequence(store: AccountingStore): number {
  return store.get<{ sequence: number }>('SELECT COALESCE(MAX(sequence),0) AS sequence FROM erp_ac_hkd_events')!.sequence;
}
export interface HkdEventRow { id: string; year: number; sequence: number; payloadJson: string; createdAt: string; createdBy: string; voidReason: string | null }
const voidPayloadSchema = z.strictObject({ reason: z.string().min(1).max(2000) });
export function hkdEntryFromRow(row: HkdEventRow): HkdEntry {
  let payload: unknown; let reason: string | null = null;
  try {
    payload = JSON.parse(row.payloadJson);
    if (row.voidReason !== null) {
      const parsed = voidPayloadSchema.safeParse(JSON.parse(row.voidReason));
      if (!parsed.success) throw new Error();
      reason = parsed.data.reason;
    }
  } catch { throw new ErpError('INVALID_RECORD', 'Malformed household event.'); }
  const parsed = hkdEntrySchema.safeParse(payload);
  if (!parsed.success) throw new ErpError('INVALID_RECORD', 'Malformed household entry.');
  return { id: row.id, year: row.year, sequence: row.sequence, createdAt: row.createdAt, createdBy: row.createdBy, entry: parsed.data, voided: reason !== null, voidReason: reason };
}
/** Immutable high-water snapshot; later voids do not rewrite an export in progress. */
export function hkdEntries(store: AccountingStore, year: number, sequence: number, balanceKind?: 'stock' | 'money'): HkdEntry[] {
  const entries: HkdEntry[] = []; let last = 0;
  for (;;) {
    const rows = store.all<HkdEventRow>(`SELECT e.*,v.payloadJson AS voidReason FROM erp_ac_hkd_events e LEFT JOIN erp_ac_hkd_events v ON v.targetId=e.id AND v.eventType='void' AND v.sequence<=? WHERE e.year=? AND e.eventType='entry' AND e.sequence>? AND e.sequence<=?${balanceKind ? " AND json_extract(e.payloadJson,'$.kind')=?" : ''} ORDER BY e.sequence LIMIT 256`, sequence, year, last, sequence, ...(balanceKind ? [balanceKind] : []));
    for (const row of rows) entries.push(hkdEntryFromRow(row));
    if (rows.length < 256) return entries;
    last = rows[rows.length - 1]!.sequence;
  }
}
export function hkdPeriodCount(profile: HkdProfile): number { return profile.periodType === 'month' ? 12 : profile.periodType === 'quarter' ? 4 : 1; }
export function hkdPeriodIndex(profile: HkdProfile, date: string): number {
  const month = Number(date.slice(5, 7)); return profile.periodType === 'month' ? month : profile.periodType === 'quarter' ? Math.ceil(month / 3) : 1;
}
export function hkdPeriodRange(profile: HkdProfile, period: number): { from: string; to: string } {
  if (period < 1 || period > hkdPeriodCount(profile)) throw new ErpError('INVALID_INPUT', 'The period does not belong to the explicitly selected annual policy.');
  const months = profile.periodType === 'month' ? 1 : profile.periodType === 'quarter' ? 3 : 12;
  const firstMonth = (period - 1) * months;
  const from = `${profile.year}-${String(firstMonth + 1).padStart(2, '0')}-01`;
  const to = new Date(Date.UTC(profile.year, firstMonth + months, 0)).toISOString().slice(0, 10);
  if (to < profile.startDate) throw new ErpError('INVALID_INPUT', 'The selected canonical period ends before this annual profile starts.');
  return { from: from < profile.startDate ? profile.startDate : from, to };
}
function hkdChronological(entries: HkdEntry[]): HkdEntry[] {
  const opening = (row: HkdEntry) => (row.entry.kind === 'stock' || row.entry.kind === 'money') && row.entry.direction === 'opening' ? 0 : 1;
  return entries.sort((a, b) => a.entry.date < b.entry.date ? -1 : a.entry.date > b.entry.date ? 1 : opening(a) - opening(b) || a.sequence - b.sequence);
}
interface StockLine { source: HkdEntry; cost: bigint; balanceQuantity: bigint; balanceValue: bigint; unitPrice: bigint }
interface StockPeriod { item: HkdStock; openingQuantity: bigint; openingValue: bigint; inQuantity: bigint; inValue: bigint; outQuantity: bigint; outValue: bigint; closingQuantity: bigint; closingValue: bigint; lines: StockLine[] }
/** Period-average, not moving average: collect ALL period receipts before valuing any issue.
 * Cumulative half-up allocation carries the dong remainder, exhausting the pool exactly.
 * Entries already use the report's single chronological ordering. */
function hkdStockPeriods(profile: HkdProfile, entries: HkdEntry[], selectedPeriod: number): StockPeriod[] {
  const items = new Map<string, HkdEntry[]>();
  for (const source of entries) {
    if (source.voided || source.entry.kind !== 'stock' || hkdPeriodIndex(profile, source.entry.date) > selectedPeriod) continue;
    const entry = source.entry as HkdStock; const key = hkdKey(entry.itemCode);
    const list = items.get(key) ?? []; list.push(source); items.set(key, list);
  }
  const result: StockPeriod[] = [];
  for (const [, movements] of [...items].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const item = movements[0]!.entry as HkdStock;
    const periods: HkdEntry[][] = Array.from({ length: selectedPeriod }, () => []);
    for (const movement of movements) periods[hkdPeriodIndex(profile, movement.entry.date) - 1]!.push(movement);
    let quantity = 0n; let value = 0n;
    for (let period = 1; period <= selectedPeriod; period++) {
      const current = periods[period - 1]!;
      const opening = current.find((row) => (row.entry as HkdStock).direction === 'opening');
      if (opening) { quantity = quantityUnits((opening.entry as HkdStock).quantity); value = BigInt((opening.entry as HkdStock).amountMinor!); }
      const openingQuantity = quantity; const openingValue = value;
      let inQuantity = 0n; let inValue = 0n;
      for (const row of current) { const entry = row.entry as HkdStock; if (entry.direction === 'in') { inQuantity += quantityUnits(entry.quantity); inValue += BigInt(entry.amountMinor!); } }
      const poolQuantity = openingQuantity + inQuantity; const poolValue = openingValue + inValue;
      let outQuantity = 0n; let outValue = 0n;
      const lines: StockLine[] = [];
      for (const row of current) {
        const entry = row.entry as HkdStock; const q = quantityUnits(entry.quantity);
        if (entry.direction === 'opening') continue;
        let cost: bigint;
        if (entry.direction === 'in') { cost = BigInt(entry.amountMinor!); quantity += q; value += cost; }
        else { outQuantity += q; const allocated = poolQuantity === 0n ? 0n : roundDong(outQuantity * poolValue, poolQuantity); cost = allocated - outValue; outValue = allocated; quantity -= q; value -= cost; }
        lines.push({ source: row, cost, balanceQuantity: quantity, balanceValue: value, unitPrice: entry.direction === 'out' ? roundDong(poolValue * 1_000_000n, poolQuantity) : roundDong(cost * 1_000_000n, q) });
      }
      if (period === selectedPeriod && (current.length || openingQuantity !== 0n || openingValue !== 0n)) result.push({ item, openingQuantity, openingValue, inQuantity, inValue, outQuantity, outValue, closingQuantity: quantity, closingValue: value, lines });
    }
  }
  return result;
}
/** Full year revalidation makes backdated inserts and voids safe, including downstream periods. */
export function validateHkdBalances(profile: HkdProfile, entries: HkdEntry[]): void {
  const identities = new Map<string, string>();
  for (const row of entries) if (row.entry.kind === 'stock') {
    const entry = row.entry; const key = hkdKey(entry.itemCode); const identity = JSON.stringify([entry.itemName, entry.unit]);
    if (identities.has(key) && identities.get(key) !== identity) throw new ErpError('HKD_IDENTITY_CONFLICT', 'An item code must retain its original name and unit, including voided history.');
    identities.set(key, identity);
  }
  const stocks = new Map<string, { opening: boolean; quantity: bigint }>();
  const funds = new Map<string, { opening: boolean; amount: bigint }>();
  for (const row of hkdChronological(entries.filter((entry) => !entry.voided))) {
    const entry = row.entry;
    if (entry.kind !== 'stock' && entry.kind !== 'money') continue;
    const opening = entry.direction === 'opening';
    if (opening && entry.date !== profile.startDate) throw new ErpError('INVALID_INPUT', 'Opening balances must use the annual profile start date.');
    if (entry.kind === 'stock') {
      const key = hkdKey(entry.itemCode); const state = stocks.get(key) ?? { opening: false, quantity: 0n };
      if (opening ? state.opening : !state.opening) throw new ErpError(opening ? 'CONFLICT' : 'HKD_OPENING_REQUIRED', 'Record exactly one explicit opening per item before its movements.');
      if (opening) state.opening = true;
      state.quantity += quantityUnits(entry.quantity) * (entry.direction === 'out' ? -1n : 1n);
      if (state.quantity < 0n) throw new ErpError('HKD_NEGATIVE_STOCK', 'This change would make chronological stock quantity negative.');
      stocks.set(key, state);
    } else {
      const key = entry.fund === 'cash' ? 'cash' : `bank:${hkdKey(entry.bankName!)}`; const state = funds.get(key) ?? { opening: false, amount: 0n };
      if (opening ? state.opening : !state.opening) throw new ErpError(opening ? 'CONFLICT' : 'HKD_OPENING_REQUIRED', 'Record exactly one explicit opening for each cash/bank/payment-provider fund.');
      if (opening) state.opening = true;
      state.amount += BigInt(entry.amountMinor) * (entry.direction === 'out' ? -1n : 1n);
      if (state.amount < 0n) throw new ErpError('HKD_NEGATIVE_MONEY', 'This change would make the chronological fund balance negative.');
      funds.set(key, state);
    }
  }
}
const cursorSchema = z.strictObject({ v: z.literal(1), installationId: z.string().uuid(), revision: z.string().uuid(), year: z.number().int(), book: z.string(), period: z.number().int(), sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), offset: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), anchor: z.string().min(1) });
function invalidCursor(): never { throw new ErpError('INVALID_CURSOR', 'Refresh this report: the cursor is invalid or belongs to a different profile/filter.'); }
export function hkdBooks(profile: HkdProfile): HkdBook[] {
  return [...(profile.taxMethod === 'exempt' ? ['S1a-HKD'] as const : profile.taxMethod === 'revenue' ? ['S2a-HKD'] as const : ['S2b-HKD', 'S2c-HKD', 'S2d-HKD', 'S2e-HKD'] as const), ...(profile.otherTaxes ? ['S3a-HKD'] as const : [])];
}
export function buildHkdReport(store: AccountingStore, profile: HkdProfile, input: HkdReportInput): HkdReport {
  if (!hkdBooks(profile).includes(input.book)) throw new ErpError('HKD_BOOK_UNAVAILABLE', 'This book is not available under the explicitly chosen annual policy.');
  const range = hkdPeriodRange(profile, input.period); const maximum = hkdMaxSequence(store);
  let sequence = maximum; let offset = 0; let anchor: string | undefined;
  if (input.cursor) {
    let decoded: unknown; try { decoded = JSON.parse(input.cursor); } catch { return invalidCursor(); }
    const cursor = cursorSchema.safeParse(decoded);
    if (!cursor.success) return invalidCursor();
    const c = cursor.data;
    if (c.installationId !== profile.installationId || c.revision !== profile.revision || c.year !== input.year || c.book !== input.book || c.period !== input.period || c.sequence > maximum || c.offset % 25 !== 0) return invalidCursor();
    sequence = c.sequence; offset = c.offset; anchor = c.anchor;
  }
  const entries = hkdChronological(hkdEntries(store, input.year, sequence).filter((row) => !row.voided));
  const selected = input.book === 'S2d-HKD' || input.book === 'S2e-HKD' ? [] : entries.filter((row) => row.entry.date >= range.from && row.entry.date <= range.to);
  const rows: HkdReportRow[] = []; const summaries: HkdReport['summaries'] = []; const columns: HkdReport['columns'] = [];
  const column = (key: string, label: string, numeric = false) => columns.push({ key, label, ...(numeric ? { numeric } : {}) });
  const baseColumns = () => { column('date', 'Ngày ghi sổ'); column('documentNumber', 'Số chứng từ'); column('documentDate', 'Ngày chứng từ'); column('description', 'Diễn giải'); };
  const baseCells = (row: HkdEntry) => ({ date: row.entry.date, documentNumber: row.entry.documentNumber, documentDate: row.entry.documentDate, description: row.entry.description });
  const row = (source: HkdEntry, cells: Record<string, string>) => rows.push({ id: source.id, entryId: source.id, cells: { ...baseCells(source), ...cells } });
  if (input.book === 'S1a-HKD' || input.book === 'S2a-HKD' || input.book === 'S2b-HKD') {
    if (input.book === 'S1a-HKD') { column('date', 'Ngày ghi sổ'); column('description', 'Diễn giải'); } else { baseColumns(); column('businessLine', 'Ngành nghề'); column('vatRateBps', 'Tỷ lệ GTGT (điểm cơ bản)', true); if (input.book === 'S2a-HKD') column('pitRateBps', 'Tỷ lệ TNCN (điểm cơ bản)', true); }
    column('amountMinor', 'Doanh thu (VND)', true);
    if (input.book !== 'S1a-HKD') { column('vatTaxableMinor', 'Doanh thu tính GTGT (VND)', true); column('vatMinor', 'Thuế GTGT (VND)', true); if (input.book === 'S2a-HKD') { column('pitTaxableMinor', 'Doanh thu tính TNCN (VND)', true); column('pitMinor', 'Thuế TNCN (VND)', true); } }
    const groups = new Map<string, { label: string; amountMinor: bigint; vatTaxableMinor: bigint; pitTaxableMinor: bigint; vatMinor: bigint; pitMinor: bigint }>();
    const total = { amountMinor: 0n, vatTaxableMinor: 0n, pitTaxableMinor: 0n, vatMinor: 0n, pitMinor: 0n };
    const amountKeys: (keyof typeof total)[] = input.book === 'S1a-HKD' ? ['amountMinor'] : input.book === 'S2b-HKD' ? ['amountMinor', 'vatTaxableMinor', 'vatMinor'] : ['amountMinor', 'vatTaxableMinor', 'vatMinor', 'pitTaxableMinor', 'pitMinor'];
    const amountCells = (values: typeof total) => Object.fromEntries(amountKeys.map((key) => [key, String(values[key])]));
    for (const source of selected) if (source.entry.kind === 'revenue') {
      const e = source.entry;
      const key = JSON.stringify([hkdKey(e.businessLine), e.vatRateBps, e.pitRateBps]);
      const group = groups.get(key) ?? { label: `${e.businessLine} — GTGT ${e.vatRateBps} bps${input.book === 'S2a-HKD' ? ` / TNCN ${e.pitRateBps} bps` : ''}`, amountMinor: 0n, vatTaxableMinor: 0n, pitTaxableMinor: 0n, vatMinor: 0n, pitMinor: 0n };
      // Tax is rounded once on each industry's whole-period base. Cumulative
      // row allocation preserves that result instead of rounding every sale.
      const amounts = {
        amountMinor: BigInt(e.amountMinor), vatTaxableMinor: BigInt(e.vatTaxableMinor), pitTaxableMinor: BigInt(e.pitTaxableMinor),
        vatMinor: input.book === 'S1a-HKD' ? 0n : roundDong((group.vatTaxableMinor + BigInt(e.vatTaxableMinor)) * BigInt(e.vatRateBps), 10_000n) - group.vatMinor,
        pitMinor: input.book !== 'S2a-HKD' ? 0n : roundDong((group.pitTaxableMinor + BigInt(e.pitTaxableMinor)) * BigInt(e.pitRateBps), 10_000n) - group.pitMinor,
      };
      for (const key of Object.keys(total) as (keyof typeof total)[]) { total[key] += amounts[key]; group[key] += amounts[key]; } groups.set(key, group);
      row(source, { ...(input.book === 'S1a-HKD' ? {} : { businessLine: e.businessLine, vatRateBps: String(e.vatRateBps), ...(input.book === 'S2a-HKD' ? { pitRateBps: String(e.pitRateBps) } : {}) }), ...amountCells(amounts) });
    }
    if (input.book !== 'S1a-HKD') for (const group of groups.values()) summaries.push({ label: group.label, cells: amountCells(group) });
    summaries.push({ label: 'Tổng cộng', cells: amountCells(total) });
  } else if (input.book === 'S2c-HKD') {
    baseColumns(); column('revenueMinor', 'Doanh thu tính TNCN (VND)', true);
    const categories = ['materials', 'labour', 'depreciation', 'services', 'interest', 'other'] as const;
    const labels = ['Nguyên vật liệu', 'Nhân công', 'Khấu hao', 'Dịch vụ mua ngoài', 'Lãi vay', 'Chi phí khác'];
    categories.forEach((key, index) => column(key, `${labels[index]} (VND)`, true));
    let revenue = 0n; let expenses = 0n; const categoryTotals = Object.fromEntries(categories.map((key) => [key, 0n])) as Record<typeof categories[number], bigint>;
    for (const source of selected) {
      const e = source.entry;
      if (e.kind === 'revenue') { revenue += BigInt(e.incomeRevenueMinor); row(source, { revenueMinor: String(e.incomeRevenueMinor), ...Object.fromEntries(categories.map((key) => [key, '0'])) }); }
      else if (e.kind === 'expense') { expenses += BigInt(e.deductibleMinor); categoryTotals[e.category] += BigInt(e.deductibleMinor); row(source, { revenueMinor: '0', ...Object.fromEntries(categories.map((key) => [key, key === e.category ? String(e.deductibleMinor) : '0'])) }); }
    }
    const difference = revenue - expenses;
    summaries.push({ label: 'Tổng doanh thu, chi phí được trừ', cells: { revenueMinor: String(revenue), ...Object.fromEntries(Object.entries(categoryTotals).map(([key, value]) => [key, String(value)])), deductibleMinor: String(expenses) } }, { label: 'Chênh lệch doanh thu trừ chi phí', cells: { differenceMinor: String(difference) } }, { label: 'Thuế TNCN trên thu nhập không âm', cells: { incomeTaxRateBps: String(profile.incomeTaxRateBps), incomeTaxMinor: String(roundDong((difference > 0n ? difference : 0n) * BigInt(profile.incomeTaxRateBps!), 10_000n)) } });
  } else if (input.book === 'S2d-HKD') {
    column('itemCode', 'Mã hàng'); column('itemName', 'Tên vật liệu, dụng cụ, sản phẩm, hàng hóa'); column('unit', 'Đơn vị tính'); baseColumns();
    for (const [key, label] of [['unitPriceMinor', 'Đơn giá (VND)'], ['inQuantity', 'Số lượng nhập'], ['inMinor', 'Giá trị nhập (VND)'], ['outQuantity', 'Số lượng xuất'], ['outMinor', 'Giá trị xuất (VND)'], ['balanceQuantity', 'Số lượng tồn'], ['balanceMinor', 'Giá trị tồn (VND)']]) column(key!, label!, true);
    for (const stock of hkdStockPeriods(profile, entries, input.period)) {
      const identity = { itemCode: stock.item.itemCode, itemName: stock.item.itemName, unit: stock.item.unit };
      rows.push({ id: `opening:${hkdKey(stock.item.itemCode)}`, cells: { ...identity, date: range.from, description: 'Tồn đầu kỳ', unitPriceMinor: stock.openingQuantity ? String(roundDong(stock.openingValue * 1_000_000n, stock.openingQuantity)) : '0', balanceQuantity: quantityText(stock.openingQuantity), balanceMinor: String(stock.openingValue) } });
      for (const line of stock.lines) { const e = line.source.entry as HkdStock; row(line.source, { ...identity, unitPriceMinor: String(line.unitPrice), inQuantity: e.direction === 'in' ? e.quantity : '0', inMinor: e.direction === 'in' ? String(line.cost) : '0', outQuantity: e.direction === 'out' ? e.quantity : '0', outMinor: e.direction === 'out' ? String(line.cost) : '0', balanceQuantity: quantityText(line.balanceQuantity), balanceMinor: String(line.balanceValue) }); }
      summaries.push({ label: `${stock.item.itemCode} — ${stock.item.itemName} (${stock.item.unit})`, cells: { ...identity, openingQuantity: quantityText(stock.openingQuantity), openingMinor: String(stock.openingValue), inQuantity: quantityText(stock.inQuantity), inMinor: String(stock.inValue), outQuantity: quantityText(stock.outQuantity), outMinor: String(stock.outValue), balanceQuantity: quantityText(stock.closingQuantity), balanceMinor: String(stock.closingValue) } });
    }
  } else if (input.book === 'S2e-HKD') {
    column('fund', 'Quỹ / ngân hàng / tổ chức thanh toán'); baseColumns(); column('inMinor', 'Thu / gửi vào (VND)', true); column('outMinor', 'Chi / rút ra (VND)', true); column('balanceMinor', 'Số dư (VND)', true);
    const funds = new Map<string, { label: string; opening: bigint; incoming: bigint; outgoing: bigint; balance: bigint; lines: HkdReportRow[] }>();
    for (const source of entries) if (source.entry.kind === 'money' && source.entry.date <= range.to) {
      const e = source.entry; const key = e.fund === 'cash' ? 'cash' : `bank:${hkdKey(e.bankName!)}`; const fund = funds.get(key) ?? { label: e.fund === 'cash' ? 'Tiền mặt' : e.bankName!, opening: 0n, incoming: 0n, outgoing: 0n, balance: 0n, lines: [] }; const amount = BigInt(e.amountMinor);
      fund.balance += e.direction === 'out' ? -amount : amount;
      if (e.date < range.from || e.direction === 'opening') fund.opening = fund.balance;
      else { if (e.direction === 'in') fund.incoming += amount; else fund.outgoing += amount; fund.lines.push({ id: source.id, entryId: source.id, cells: { ...baseCells(source), fund: fund.label, inMinor: e.direction === 'in' ? String(amount) : '0', outMinor: e.direction === 'out' ? String(amount) : '0', balanceMinor: String(fund.balance) } }); }
      funds.set(key, fund);
    }
    for (const [key, fund] of [...funds].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      rows.push({ id: `opening:${key}`, cells: { fund: fund.label, date: range.from, description: 'Số dư đầu kỳ', balanceMinor: String(fund.opening) } }, ...fund.lines);
      summaries.push({ label: fund.label, cells: { fund: fund.label, openingMinor: String(fund.opening), inMinor: String(fund.incoming), outMinor: String(fund.outgoing), balanceMinor: String(fund.balance) } });
    }
  } else {
    column('date', 'Ngày ghi sổ'); column('description', 'Diễn giải'); column('taxKind', 'Loại thuế');
    for (const [key, label] of [['quantity', 'Lượng chịu thuế'], ['absoluteRateMinor', 'Mức thuế tuyệt đối (VND)'], ['unitTaxPriceMinor', 'Giá tính thuế / đơn vị (VND)'], ['taxRateBps', 'Thuế suất (điểm cơ bản)'], ['percentageMinor', 'Thuế theo tỷ lệ (VND)'], ['absoluteMinor', 'Thuế tuyệt đối (VND)'], ['dueMinor', 'Thuế XNK / TTĐB phải nộp (VND)'], ['environmentMinor', 'Thuế bảo vệ môi trường (VND)'], ['resourceMinor', 'Thuế tài nguyên (VND)'], ['landMinor', 'Thuế sử dụng đất (VND)']]) column(key!, label!, true);
    const total = { percentageMinor: 0n, absoluteMinor: 0n, dueMinor: 0n, environmentMinor: 0n, resourceMinor: 0n, landMinor: 0n };
    for (const source of selected) if (source.entry.kind === 'tax') {
      const e = source.entry; const q = quantityUnits(e.quantity);
      const percentageNumerator = q * BigInt(e.unitTaxPriceMinor) * BigInt(e.taxRateBps);
      const absoluteNumerator = q * BigInt(e.absoluteRateMinor) * 10_000n;
      const percentage = roundDong(percentageNumerator, 10_000_000_000n);
      const due = roundDong(percentageNumerator + absoluteNumerator, 10_000_000_000n);
      // Allocate the rounded obligation between displayed components without
      // independently rounding two half-dong components up to two dong.
      const absolute = due - percentage;
      const trade = ['export', 'import', 'excise'].includes(e.taxKind);
      const amounts = { percentageMinor: trade ? percentage : 0n, absoluteMinor: trade ? absolute : 0n, dueMinor: trade ? due : 0n, environmentMinor: e.taxKind === 'environment' ? due : 0n, resourceMinor: e.taxKind === 'resource' ? due : 0n, landMinor: e.taxKind === 'land' ? due : 0n };
      for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += amounts[key];
      row(source, { taxKind: taxLabels[e.taxKind], quantity: e.quantity, absoluteRateMinor: String(e.absoluteRateMinor), unitTaxPriceMinor: String(e.unitTaxPriceMinor), taxRateBps: String(e.taxRateBps), ...Object.fromEntries(Object.entries(amounts).map(([key, value]) => [key, String(value)])) });
    }
    summaries.push({ label: 'Tổng nghĩa vụ thuế khác', cells: Object.fromEntries(Object.entries(total).map(([key, value]) => [key, String(value)])) });
  }
  if (offset > 0 && (offset >= rows.length || rows[offset - 1]?.id !== anchor)) return invalidCursor();
  const page = rows.slice(offset, offset + 25); const hasMore = offset + page.length < rows.length;
  return {
    profile, book: input.book, period: input.period, ...range, asOfSequence: sequence, columns, rows: page, summaries, hasMore,
    ...(hasMore ? { cursor: JSON.stringify({ v: 1, installationId: profile.installationId, revision: profile.revision, year: input.year, book: input.book, period: input.period, sequence, offset: offset + page.length, anchor: page[page.length - 1]!.id }) } : {}),
    notes: [
      'Đơn vị tiền tệ: VND. Chính sách và căn cứ tính thuế do người vận hành lựa chọn; không tự xác định ngưỡng hoặc chứng nhận nghĩa vụ thuế.',
      ...(input.book === 'S2a-HKD' || input.book === 'S2b-HKD' ? [`Thuế ${input.book === 'S2a-HKD' ? 'GTGT/TNCN' : 'GTGT'} trên doanh thu tính từ tổng căn cứ cả kỳ của từng nhóm ngành nghề và tỷ lệ; làm tròn đồng một lần mỗi nhóm, phân bổ lũy kế lên các dòng.`] : []),
      ...(input.book === 'S3a-HKD' ? ['S3a cộng chính xác các thành phần trước khi làm tròn một lần mỗi nghĩa vụ; cột tuyệt đối nhận phần còn lại sau cột tỷ lệ đã làm tròn.'] : []),
      ...(input.book === 'S2d-HKD' ? ['Xuất kho bình quân gia quyền từ tồn đầu kỳ và TẤT CẢ phiếu nhập trong kỳ chính sách. Phiếu nhập mới hoặc hủy phiếu có thể tính lại giá xuất cả kỳ và kỳ sau; giá trị tồn tạm thời có thể âm trước phiếu nhập dù lượng tồn không âm.', 'Làm tròn đồng theo phân bổ lũy kế, tất toán hết giá trị khi xuất hết lượng. Đơn giá hiển thị làm tròn; thành tiền dùng tỷ số chính xác.'] : []),
      'Báo cáo cố định theo mốc sự kiện đã hiển thị, không phải bằng chứng khóa sổ hoặc hồ sơ kê khai đã nộp.',
      ...(input.book === 'S2c-HKD' || input.book === 'S2d-HKD' ? ['Xuất kho không tự ghi chi phí được trừ S2c-HKD. Người vận hành ghi riêng chi phí và phần được trừ có chứng từ.'] : []),
      `Địa điểm lập: ${profile.location}. Người đại diện: ${profile.representative}. Chữ ký: ____________________`,
    ],
  };
}
