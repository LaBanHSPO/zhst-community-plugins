import { z } from 'zod';
import { ErpError, parse } from '../validation.js';
import type { AccountingReport, AccountReportRow, JournalReportRow, ReportInput, SourceReportRow, RootType, AccountPurpose, PartyKind } from './model.js';
import type { AccountingStore, SqlParameter } from './store.js';
import { calendarDateSchema } from './validation.js';

const PAGE_SIZE = 25;
const BATCH_SIZE = 256;
const uuid = z.string().uuid();
const reportSchema = z.strictObject({
  type: z.enum(['journal', 'ledger', 'trial-balance', 'cash-bank', 'debt']),
  from: calendarDateSchema, to: calendarDateSchema,
  accountId: uuid.optional(), partyId: uuid.optional(), cursor: z.string().min(1).max(2048).optional(),
});
const linePositionSchema = z.strictObject({ postingDate: calendarDateSchema, postedSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), lineIndex: z.number().int().min(0).max(49) });
const cursorSchema = z.strictObject({
  version: z.literal(1), installationId: uuid, asOfSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  type: reportSchema.shape.type, from: calendarDateSchema, to: calendarDateSchema,
  accountId: uuid.nullable(), partyId: uuid.nullable(),
  position: z.union([linePositionSchema, z.strictObject({ accountId: uuid })]),
});
type Position = z.infer<typeof cursorSchema>['position'];
interface Snapshot { installationId: string; startDate: string; currency: string; minorUnits: number; schemaVersion: number; maxSequence: number }
interface Run { input: ReportInput; sequence: number; installationId: string; position?: Position }
interface LineRow {
  journalId: string; lineIndex: number; postingDate: string; postedSequence: number; number: string; reference: string; memo: string; reversalOf: string | null;
  postedAt: string; postedBy: string; reversedBy?: string | null;
  accountId: string; accountCode: string; accountName: string; accountRootType: RootType; accountPurpose: AccountPurpose;
  partyId: string | null; partyCode: string | null; partyName: string | null; partyKind: PartyKind | null;
  debitMinor: number; creditMinor: number;
}
interface Amounts { opening: bigint; debit: bigint; credit: bigint }
const lineColumns = 'j.id AS journalId,j.postingDate,j.postedSequence,j.number,j.postedAt,j.postedBy,j.reference,j.memo,j.reversalOf,l.lineIndex,l.accountId,l.accountCode,l.accountName,l.accountRootType,l.accountPurpose,l.partyId,l.partyCode,l.partyName,l.partyKind,l.debitMinor,l.creditMinor';
const lineJoin = 'FROM erp_ac_journals j JOIN erp_ac_lines l ON l.journalId=j.id';
const sourcePredicate = "l.role='open-item' AND l.accountPurpose IN ('receivable','payable') AND NOT EXISTS(SELECT 1 FROM erp_ac_journals r WHERE r.reversalOf=j.id AND r.status='posted' AND r.postedSequence<=? AND r.postingDate<=?)";

function invalidCursor(): never { throw new ErpError('INVALID_CURSOR', 'This report cursor is invalid or belongs to a different report. Refresh the report.'); }
function predicate(run: Run, source = false): { sql: string; parameters: SqlParameter[] } {
  const clauses = ["j.status='posted'", 'j.postedSequence<=?', 'j.postingDate<=?'];
  const parameters: SqlParameter[] = [run.sequence, run.input.to];
  if (run.input.accountId) { clauses.push('l.accountId=?'); parameters.push(run.input.accountId); }
  if (run.input.partyId) { clauses.push('l.partyId=?'); parameters.push(run.input.partyId); }
  if (run.input.type === 'cash-bank') clauses.push("l.accountPurpose IN ('cash','bank')");
  if (run.input.type === 'debt') clauses.push("l.accountPurpose IN ('receivable','payable')");
  if (source) { clauses.push(sourcePredicate); parameters.push(run.sequence, run.input.to); }
  return { sql: clauses.join(' AND '), parameters };
}

/** Streams immutable rows in bounded batches; no lifetime SQL amount aggregates. */
function scanLines(store: AccountingStore, run: Run, visit: (row: LineRow) => void, sources = false, byParty = false): void {
  const filter = predicate(run, sources);
  const order = sources ? 'j.postingDate,j.postedSequence,l.lineIndex' : byParty ? 'l.accountId,l.partyId,j.postedSequence,l.lineIndex' : 'l.accountId,j.postedSequence,l.lineIndex';
  let last: LineRow | undefined;
  for (;;) {
    const keys = sources ? '(j.postingDate,j.postedSequence,l.lineIndex)' : byParty ? '(l.accountId,l.partyId,j.postedSequence,l.lineIndex)' : '(l.accountId,j.postedSequence,l.lineIndex)';
    const parameters = [...filter.parameters];
    if (last) parameters.push(...(sources ? [last.postingDate, last.postedSequence, last.lineIndex] : byParty ? [last.accountId, last.partyId!, last.postedSequence, last.lineIndex] : [last.accountId, last.postedSequence, last.lineIndex]));
    const rows = store.all<LineRow>(`SELECT ${lineColumns} ${lineJoin} WHERE ${filter.sql}${last ? ` AND ${keys}>(${byParty && !sources ? '?,?,?,?' : '?,?,?'})` : ''} ORDER BY ${order} LIMIT ${BATCH_SIZE}`, ...parameters);
    for (const row of rows) visit(row);
    if (rows.length < BATCH_SIZE) return;
    last = rows[rows.length - 1]!;
  }
}
function linePosition(row: LineRow): z.infer<typeof linePositionSchema> {
  return { postingDate: row.postingDate, postedSequence: row.postedSequence, lineIndex: row.lineIndex };
}
function compareLine(row: LineRow, position: z.infer<typeof linePositionSchema>): number {
  return row.postingDate.localeCompare(position.postingDate) || row.postedSequence - position.postedSequence || row.lineIndex - position.lineIndex;
}
function encodeCursor(run: Run, position: Position): string {
  return JSON.stringify({ version: 1, installationId: run.installationId, asOfSequence: run.sequence, type: run.input.type, from: run.input.from, to: run.input.to, accountId: run.input.accountId ?? null, partyId: run.input.partyId ?? null, position });
}
function journalRow(row: LineRow): JournalReportRow {
  return { kind: 'journal', journalId: row.journalId, lineIndex: row.lineIndex, postingDate: row.postingDate, postedSequence: row.postedSequence, number: row.number, postedAt: row.postedAt, postedBy: row.postedBy, reference: row.reference, memo: row.memo, accountId: row.accountId, accountCode: row.accountCode, accountName: row.accountName, partyId: row.partyId, partyName: row.partyName, debitMinor: String(row.debitMinor), creditMinor: String(row.creditMinor), reversalOf: row.reversalOf, reversedBy: row.reversedBy ?? null };
}
function accountRow(label: LineRow, amount: Amounts): AccountReportRow {
  const closing = amount.opening + amount.debit - amount.credit;
  return { kind: 'account', accountId: label.accountId, accountCode: label.accountCode, accountName: label.accountName, rootType: label.accountRootType, purpose: label.accountPurpose,
    openingMinor: String(amount.opening), debitMinor: String(amount.debit), creditMinor: String(amount.credit), closingMinor: String(closing),
    openingDebitMinor: String(amount.opening > 0n ? amount.opening : 0n), openingCreditMinor: String(amount.opening < 0n ? -amount.opening : 0n),
    closingDebitMinor: String(closing > 0n ? closing : 0n), closingCreditMinor: String(closing < 0n ? -closing : 0n) };
}
function accountTotals(store: AccountingStore, run: Run, visit: (row: AccountReportRow) => void): Record<string, string> {
  const totals = { openingMinor: 0n, debitMinor: 0n, creditMinor: 0n, closingMinor: 0n, openingDebitMinor: 0n, openingCreditMinor: 0n, closingDebitMinor: 0n, closingCreditMinor: 0n };
  let label: LineRow | undefined;
  let amount: Amounts = { opening: 0n, debit: 0n, credit: 0n };
  const finish = () => {
    if (!label) return;
    const row = accountRow(label, amount);
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += BigInt(row[key]);
    visit(row);
  };
  scanLines(store, run, (row) => {
    if (label?.accountId !== row.accountId) { finish(); label = row; amount = { opening: 0n, debit: 0n, credit: 0n }; }
    // Earliest posted snapshot at this cutoff supplies a stable historical label.
    if (row.postingDate < run.input.from) amount.opening += BigInt(row.debitMinor) - BigInt(row.creditMinor);
    else { amount.debit += BigInt(row.debitMinor); amount.credit += BigInt(row.creditMinor); }
  });
  finish();
  const result = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, String(value)]));
  if (run.input.type === 'cash-bank') { result.inflowMinor = result.debitMinor!; result.outflowMinor = result.creditMinor!; result.netFlowMinor = String(totals.debitMinor - totals.creditMinor); }
  return result;
}

function effectiveAllocated(store: AccountingStore, run: Run, row: LineRow): bigint {
  let total = 0n;
  let last: { postedSequence: number; settlementLineIndex: number } | undefined;
  for (;;) {
    const parameters: SqlParameter[] = [row.journalId, row.lineIndex, run.sequence, run.input.to, run.sequence, run.input.to];
    if (last) parameters.push(last.postedSequence, last.settlementLineIndex);
    const rows = store.all<{ amountMinor: number; postedSequence: number; settlementLineIndex: number }>(`SELECT x.amountMinor,j.postedSequence,x.settlementLineIndex FROM erp_ac_allocations x JOIN erp_ac_journals j ON j.id=x.settlementJournalId WHERE x.sourceJournalId=? AND x.sourceLineIndex=? AND j.status='posted' AND j.postedSequence<=? AND j.postingDate<=? AND NOT EXISTS(SELECT 1 FROM erp_ac_journals r WHERE r.reversalOf=j.id AND r.status='posted' AND r.postedSequence<=? AND r.postingDate<=?)${last ? ' AND (j.postedSequence,x.settlementLineIndex)>(?,?)' : ''} ORDER BY j.postedSequence,x.settlementLineIndex LIMIT ${BATCH_SIZE}`, ...parameters);
    for (const allocation of rows) total += BigInt(allocation.amountMinor);
    if (rows.length < BATCH_SIZE) return total;
    last = rows[rows.length - 1]!;
  }
}
function sourceRow(store: AccountingStore, run: Run, row: LineRow): SourceReportRow {
  const original = BigInt(row.debitMinor) + BigInt(row.creditMinor);
  const allocated = effectiveAllocated(store, run, row);
  if (allocated > original) throw new ErpError('INVALID_RECORD', 'Historical allocations exceed their source. A reviewed repair is required.');
  return { kind: 'source', journalId: row.journalId, lineIndex: row.lineIndex, postingDate: row.postingDate, reference: row.reference, accountId: row.accountId, accountCode: row.accountCode, accountName: row.accountName, partyId: row.partyId!, partyCode: row.partyCode!, partyName: row.partyName!, partyKind: row.partyKind!, originalMinor: String(original), allocatedMinor: String(allocated), remainingMinor: String(original - allocated) };
}
function debtReport(store: AccountingStore, run: Run): Pick<AccountingReport, 'items' | 'totals' | 'reconciled' | 'hasMore' | 'cursor'> {
  const items: SourceReportRow[] = [];
  const positions: Position[] = [];
  const totals = { originalMinor: 0n, allocatedMinor: 0n, remainingMinor: 0n, receivableMinor: 0n, payableMinor: 0n, controlReceivableMinor: 0n, controlPayableMinor: 0n };
  const position = run.position as z.infer<typeof linePositionSchema> | undefined;
  let anchorFound = !position;
  scanLines(store, run, (line) => {
    const row = sourceRow(store, run, line);
    totals.originalMinor += BigInt(row.originalMinor); totals.allocatedMinor += BigInt(row.allocatedMinor); totals.remainingMinor += BigInt(row.remainingMinor);
    totals[line.accountPurpose === 'receivable' ? 'receivableMinor' : 'payableMinor'] += BigInt(row.remainingMinor);
    const comparison = position ? compareLine(line, position) : 1;
    if (comparison === 0) anchorFound = true;
    if (comparison > 0 && items.length < PAGE_SIZE + 1) { items.push(row); positions.push(linePosition(line)); }
  }, true);
  if (!anchorFound) invalidCursor();
  // Reconcile every control account/party separately: opposite differences must not cancel.
  let group: LineRow | undefined;
  let control = 0n;
  let reconciled = true;
  const finish = () => {
    if (!group) return;
    const current = group;
    let remaining = 0n;
    const groupRun: Run = { ...run, input: { ...run.input, accountId: current.accountId, partyId: current.partyId! } };
    scanLines(store, groupRun, (source) => { remaining += BigInt(sourceRow(store, groupRun, source).remainingMinor); }, true);
    if (remaining !== control) reconciled = false;
    totals[current.accountPurpose === 'receivable' ? 'controlReceivableMinor' : 'controlPayableMinor'] += control;
  };
  scanLines(store, run, (row) => {
    if (group?.accountId !== row.accountId || group?.partyId !== row.partyId) { finish(); group = row; control = 0n; }
    control += row.accountPurpose === 'receivable' ? BigInt(row.debitMinor) - BigInt(row.creditMinor) : BigInt(row.creditMinor) - BigInt(row.debitMinor);
  }, false, true);
  finish();
  reconciled &&= totals.receivableMinor === totals.controlReceivableMinor && totals.payableMinor === totals.controlPayableMinor;
  const hasMore = items.length > PAGE_SIZE;
  if (hasMore) items.pop();
  return { items, totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, String(value)])), reconciled, hasMore, ...(hasMore ? { cursor: encodeCursor(run, positions[PAGE_SIZE - 1]!) } : {}) };
}

/** A report run is fenced by immutable posted sequence, never mutable master state. */
export function buildAccountingReport(store: AccountingStore, input: ReportInput): AccountingReport {
  const data = parse(reportSchema, input);
  if (data.from > data.to) throw new ErpError('INVALID_INPUT', 'The report start date must not follow its end date.');
  // A single synchronous statement captures settings and watermark in one short read snapshot.
  const snapshot = store.get<Snapshot>('SELECT installationId,startDate,currency,minorUnits,schemaVersion,(SELECT coalesce(max(postedSequence),0) FROM erp_ac_journals WHERE status=\'posted\') AS maxSequence FROM erp_ac_settings WHERE id=\'book\'');
  if (!snapshot) throw new ErpError('BOOK_REQUIRED', 'Configure the accounting book before running reports.');
  if (snapshot.schemaVersion !== 1) throw new ErpError('SCHEMA_VERSION', 'This book requires a compatible accounting schema.');
  if (snapshot.currency !== 'VND' || snapshot.minorUnits !== 0) throw new ErpError('CURRENCY_MISMATCH', 'Accounting requires the saved VND installation lock.');
  if (!calendarDateSchema.safeParse(snapshot.startDate).success || !uuid.safeParse(snapshot.installationId).success || !Number.isSafeInteger(snapshot.maxSequence)) throw new ErpError('INVALID_RECORD', 'The saved accounting book is malformed.');
  if (data.from < snapshot.startDate || data.to < snapshot.startDate) throw new ErpError('INVALID_INPUT', 'Report dates must not precede the book start date.');
  const run: Run = { input: data, sequence: snapshot.maxSequence, installationId: snapshot.installationId };
  if (data.cursor) {
    let decoded: unknown;
    try { decoded = JSON.parse(data.cursor); } catch { invalidCursor(); }
    const parsed = cursorSchema.safeParse(decoded);
    if (!parsed.success) invalidCursor();
    const cursor = parsed.data;
    if (cursor.installationId !== run.installationId || cursor.type !== data.type || cursor.from !== data.from || cursor.to !== data.to || cursor.accountId !== (data.accountId ?? null) || cursor.partyId !== (data.partyId ?? null) || cursor.asOfSequence > snapshot.maxSequence || cursor.asOfSequence === 0) invalidCursor();
    if (!store.get("SELECT 1 FROM erp_ac_journals WHERE status='posted' AND postedSequence=?", cursor.asOfSequence)) invalidCursor();
    const accountPage = data.type === 'trial-balance' || data.type === 'cash-bank';
    if (accountPage !== ('accountId' in cursor.position)) invalidCursor();
    if ('postedSequence' in cursor.position && (cursor.position.postedSequence > cursor.asOfSequence || cursor.position.postingDate > data.to || cursor.position.postingDate < (data.type === 'debt' ? snapshot.startDate : data.from))) invalidCursor();
    run.sequence = cursor.asOfSequence; run.position = cursor.position;
  }
  const base = { type: data.type, asOfSequence: run.sequence, from: data.from, to: data.to };
  if (data.type === 'debt') return { ...base, ...debtReport(store, run) };
  if (data.type === 'trial-balance' || data.type === 'cash-bank') {
    const items: AccountReportRow[] = [];
    const position = run.position as { accountId: string } | undefined;
    let anchorFound = !position;
    const totals = accountTotals(store, run, (row) => {
      if (row.accountId === position?.accountId) anchorFound = true;
      if ((!position || row.accountId > position.accountId) && items.length < PAGE_SIZE + 1) items.push(row);
    });
    if (!anchorFound) invalidCursor();
    const hasMore = items.length > PAGE_SIZE;
    if (hasMore) items.pop();
    return { ...base, items, totals, hasMore, ...(hasMore ? { cursor: encodeCursor(run, { accountId: items[PAGE_SIZE - 1]!.accountId }) } : {}) };
  }
  const filter = predicate(run);
  const position = run.position as z.infer<typeof linePositionSchema> | undefined;
  const parameters = [...filter.parameters, data.from];
  const range = `${filter.sql} AND j.postingDate>=?`;
  if (position) {
    if (!store.get(`SELECT 1 ${lineJoin} WHERE ${range} AND j.postingDate=? AND j.postedSequence=? AND l.lineIndex=?`, ...parameters, position.postingDate, position.postedSequence, position.lineIndex)) invalidCursor();
    parameters.push(position.postingDate, position.postedSequence, position.lineIndex);
  }
  const rows = store.all<LineRow>(`SELECT ${lineColumns},(SELECT r.id FROM erp_ac_journals r WHERE r.reversalOf=j.id AND r.status='posted' AND r.postedSequence<=? AND r.postingDate<=?) AS reversedBy ${lineJoin} WHERE ${range}${position ? ' AND (j.postingDate,j.postedSequence,l.lineIndex)>(?,?,?)' : ''} ORDER BY j.postingDate,j.postedSequence,l.lineIndex LIMIT ${PAGE_SIZE + 1}`, run.sequence, data.to, ...parameters);
  const hasMore = rows.length > PAGE_SIZE;
  if (hasMore) rows.pop();
  return { ...base, items: rows.map(journalRow), totals: accountTotals(store, run, () => {}), hasMore, ...(hasMore ? { cursor: encodeCursor(run, linePosition(rows[PAGE_SIZE - 1]!)) } : {}) };
}
