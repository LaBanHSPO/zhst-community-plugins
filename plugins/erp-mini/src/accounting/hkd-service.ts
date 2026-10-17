import { z } from 'zod';
import { ErpError, parse } from '../validation.js';
import type { AccountingStore } from './store.js';
import type { HkdCommandResult, HkdEntry, HkdEntryPayload, HkdInfo, HkdPage, HkdProfile, HkdReport } from './hkd-model.js';
import { commandHash } from './commands.js';
import { hkdConfigureSchema, hkdEntrySchema, hkdListSchema, hkdPostSchema, hkdProfileSchema, hkdReportSchema, hkdVoidSchema } from './hkd-validation.js';
import { buildHkdReport, hkdEntries, hkdEntryFromRow, hkdMaxSequence, validateHkdBalances, type HkdEventRow } from './hkd-reports.js';

const sequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const entrySchema = z.strictObject({ id: z.string().uuid(), year: z.number().int().min(2026).max(2100), sequence: sequenceSchema.refine((value) => value > 0), createdAt: z.iso.datetime(), createdBy: z.string().min(1), entry: hkdEntrySchema, voided: z.boolean(), voidReason: z.string().min(1).nullable() });
const receiptSchema = z.strictObject({ commandId: z.string().uuid(), action: z.enum(['hkd-configure', 'hkd-post-entry', 'hkd-void-entry']), year: z.number().int().min(2026).max(2100), profile: hkdProfileSchema.optional(), entry: entrySchema.optional(), voidedId: z.string().uuid().optional(), asOfSequence: sequenceSchema }).superRefine((result, context) => {
  const valid = result.action === 'hkd-configure' ? result.profile?.year === result.year && !result.entry && !result.voidedId : result.action === 'hkd-post-entry' ? result.entry?.year === result.year && result.entry.sequence === result.asOfSequence && !result.entry.voided && result.entry.voidReason === null && !result.profile && !result.voidedId : !!result.voidedId && !result.profile && !result.entry;
  if (!valid) context.addIssue({ code: 'custom', message: 'Inconsistent household command receipt.' });
});
const listCursorSchema = z.strictObject({ v: z.literal(1), year: z.number().int(), installationId: z.string().uuid(), revision: z.string().uuid(), sequence: sequenceSchema, after: sequenceSchema.refine((value) => value > 0) });
interface ProfileRow { year: number; installationId: string; revision: string; profileJson: string; createdAt: string; createdBy: string }
interface ReceiptRow { commandId: string; action: string; actorId: string; canonicalPayloadHash: string; resultJson: string }
function invalidCursor(): never { throw new ErpError('INVALID_CURSOR', 'Refresh the household list: this cursor is invalid or belongs to a different year/profile.'); }

export class HkdService {
  constructor(private readonly store: AccountingStore, private readonly actorId: string, private readonly now: () => Date = () => new Date()) {}
  private authenticated(): void { if (!this.actorId) throw new ErpError('AUTH_REQUIRED', 'An authenticated administrator is required.'); }
  private profile(year: number): HkdProfile {
    const row = this.store.get<ProfileRow>('SELECT * FROM erp_ac_hkd_profiles WHERE year=?', year);
    if (!row) throw new ErpError('HKD_PROFILE_REQUIRED', 'Choose an explicit household accounting policy for this calendar year first.');
    let saved: unknown; try { saved = JSON.parse(row.profileJson); } catch { throw new ErpError('INVALID_RECORD', 'Malformed household profile.'); }
    const result = hkdProfileSchema.safeParse(saved);
    if (!result.success || result.data.year !== row.year || result.data.installationId !== row.installationId || result.data.revision !== row.revision || result.data.createdAt !== row.createdAt || result.data.createdBy !== row.createdBy) throw new ErpError('INVALID_RECORD', 'Malformed household profile; a reviewed repair is required.');
    return result.data;
  }
  private replay(commandId: string, action: HkdCommandResult['action'], hash: string): HkdCommandResult | undefined {
    if (this.store.get('SELECT commandId FROM erp_ac_commands WHERE commandId=?', commandId) || this.store.get('SELECT commandId FROM erp_ac_coa_imports WHERE commandId=?', commandId)) throw new ErpError('IDEMPOTENCY_CONFLICT', 'This command identity belongs to another operation.');
    const saved = this.store.get<ReceiptRow>('SELECT * FROM erp_ac_hkd_commands WHERE commandId=?', commandId);
    if (!saved) return undefined;
    if (saved.action !== action || saved.actorId !== this.actorId || saved.canonicalPayloadHash !== hash) throw new ErpError('IDEMPOTENCY_CONFLICT', 'Reuse the original household command and payload under the original actor.');
    let value: unknown; try { value = JSON.parse(saved.resultJson); } catch { throw new ErpError('INVALID_RECORD', 'Malformed immutable household receipt.'); }
    const parsed = receiptSchema.safeParse(value);
    if (!parsed.success || parsed.data.commandId !== commandId || parsed.data.action !== action) throw new ErpError('INVALID_RECORD', 'Malformed immutable household receipt.');
    return parsed.data;
  }
  private receipt(result: HkdCommandResult, hash: string): HkdCommandResult {
    this.store.run('INSERT INTO erp_ac_hkd_commands(commandId,action,actorId,canonicalPayloadHash,resultJson,createdAt) VALUES(?,?,?,?,?,?)', result.commandId, result.action, this.actorId, hash, JSON.stringify(result), this.now().toISOString());
    return result;
  }
  private sequence(): number {
    const next = hkdMaxSequence(this.store) + 1;
    if (!Number.isSafeInteger(next)) throw new ErpError('LIMIT_EXCEEDED', 'The household event sequence is exhausted.');
    return next;
  }
  async info(): Promise<HkdInfo> {
    this.authenticated();
    return this.store.transaction<HkdInfo>(() => ({ profiles: this.store.all<{ year: number }>('SELECT year FROM erp_ac_hkd_profiles ORDER BY year').map((row) => this.profile(row.year)), currency: 'VND', pageSize: 25 }));
  }
  async configure(input: unknown): Promise<HkdCommandResult> {
    this.authenticated(); const data = parse(hkdConfigureSchema, input); const action = 'hkd-configure';
    const hash = await commandHash(action, this.actorId, data);
    return this.store.transaction(() => {
      const replay = this.replay(data.commandId, action, hash); if (replay) return replay;
      if (this.store.get('SELECT year FROM erp_ac_hkd_profiles WHERE year=?', data.year)) throw new ErpError('CONFLICT', 'The annual household policy is immutable and already configured.');
      const { commandId, ...policy } = data;
      const profile: HkdProfile = { ...policy, installationId: globalThis.crypto.randomUUID(), revision: globalThis.crypto.randomUUID(), createdAt: this.now().toISOString(), createdBy: this.actorId };
      this.store.run('INSERT INTO erp_ac_hkd_profiles(year,installationId,revision,profileJson,createdAt,createdBy) VALUES(?,?,?,?,?,?)', profile.year, profile.installationId, profile.revision, JSON.stringify(profile), profile.createdAt, profile.createdBy);
      return this.receipt({ commandId, action, year: data.year, profile, asOfSequence: hkdMaxSequence(this.store) }, hash);
    });
  }
  private validateEntry(profile: HkdProfile, entry: HkdEntryPayload): void {
    if (entry.date < profile.startDate || entry.date > `${profile.year}-12-31`) throw new ErpError('INVALID_INPUT', 'The recording date must be within this annual profile on or after its start date.');
    if (entry.kind === 'revenue') {
      if (profile.taxMethod === 'exempt' && (entry.businessLine !== '' || entry.vatRateBps !== 0 || entry.pitRateBps !== 0 || entry.vatTaxableMinor !== 0 || entry.pitTaxableMinor !== 0 || entry.incomeRevenueMinor !== 0)) throw new ErpError('INVALID_INPUT', 'Exempt revenue must not declare tax fields or an industry tax group.');
      if (profile.taxMethod !== 'exempt' && entry.businessLine === '') throw new ErpError('INVALID_INPUT', 'Choose the business line explicitly on every taxable revenue entry.');
      if (profile.taxMethod === 'revenue' && entry.incomeRevenueMinor !== 0) throw new ErpError('INVALID_INPUT', 'Revenue-method entries cannot declare income-method revenue.');
      if (profile.taxMethod === 'income' && (entry.pitRateBps !== 0 || entry.pitTaxableMinor !== 0)) throw new ErpError('INVALID_INPUT', 'Income-method entries cannot declare turnover-based personal income tax.');
    } else if (entry.kind === 'tax') {
      if (!profile.otherTaxes) throw new ErpError('HKD_BOOK_UNAVAILABLE', 'Enable other taxes explicitly in the annual profile before recording tax obligations.');
    } else if (profile.taxMethod !== 'income') throw new ErpError('HKD_BOOK_UNAVAILABLE', 'Expenses, stock and funds are available only under the income method.');
  }
  async postEntry(input: unknown): Promise<HkdCommandResult> {
    this.authenticated(); const data = parse(hkdPostSchema, input); const action = 'hkd-post-entry';
    const hash = await commandHash(action, this.actorId, data);
    return this.store.transaction(() => {
      const replay = this.replay(data.commandId, action, hash); if (replay) return replay;
      const profile = this.profile(data.year);
      if (profile.installationId !== data.installationId || profile.revision !== data.revision) throw new ErpError('HKD_PROFILE_MISMATCH', 'This command belongs to a different annual profile. Restore the original resource before reconciling it.');
      this.validateEntry(profile, data.entry);
      const entry: HkdEntry = { id: globalThis.crypto.randomUUID(), year: data.year, sequence: this.sequence(), createdAt: this.now().toISOString(), createdBy: this.actorId, entry: data.entry, voided: false, voidReason: null };
      if (entry.entry.kind === 'stock' || entry.entry.kind === 'money') {
        const entries = hkdEntries(this.store, data.year, entry.sequence - 1, entry.entry.kind); entries.push(entry); validateHkdBalances(profile, entries);
      }
      this.store.run("INSERT INTO erp_ac_hkd_events(id,year,sequence,eventType,targetId,payloadJson,createdAt,createdBy) VALUES(?,?,?,'entry',NULL,?,?,?)", entry.id, entry.year, entry.sequence, JSON.stringify(entry.entry), entry.createdAt, entry.createdBy);
      return this.receipt({ commandId: data.commandId, action, year: data.year, entry, asOfSequence: entry.sequence }, hash);
    });
  }
  async voidEntry(input: unknown): Promise<HkdCommandResult> {
    this.authenticated(); const data = parse(hkdVoidSchema, input); const action = 'hkd-void-entry';
    const hash = await commandHash(action, this.actorId, data);
    return this.store.transaction(() => {
      const replay = this.replay(data.commandId, action, hash); if (replay) return replay;
      const profile = this.profile(data.year);
      if (profile.installationId !== data.installationId || profile.revision !== data.revision) throw new ErpError('HKD_PROFILE_MISMATCH', 'This command belongs to a different annual profile. Restore the original resource before reconciling it.');
      const sequence = this.sequence();
      const row = this.store.get<HkdEventRow>("SELECT e.*,v.payloadJson AS voidReason FROM erp_ac_hkd_events e LEFT JOIN erp_ac_hkd_events v ON v.targetId=e.id AND v.eventType='void' AND v.sequence<=? WHERE e.year=? AND e.id=? AND e.eventType='entry'", sequence - 1, data.year, data.id);
      if (!row) throw new ErpError('NOT_FOUND', 'The household entry does not belong to this annual profile.');
      const target = hkdEntryFromRow(row);
      if (target.voided) throw new ErpError('CONFLICT', 'This entry is already voided.');
      if (target.entry.kind === 'stock' || target.entry.kind === 'money') {
        const entries = hkdEntries(this.store, data.year, sequence - 1, target.entry.kind);
        const removed = entries.find((entry) => entry.id === target.id)!;
        removed.voided = true; removed.voidReason = data.reason; validateHkdBalances(profile, entries);
      }
      this.store.run("INSERT INTO erp_ac_hkd_events(id,year,sequence,eventType,targetId,payloadJson,createdAt,createdBy) VALUES(?,?,?,'void',?,?,?,?)", globalThis.crypto.randomUUID(), data.year, sequence, data.id, JSON.stringify({ reason: data.reason }), this.now().toISOString(), this.actorId);
      return this.receipt({ commandId: data.commandId, action, year: data.year, voidedId: data.id, asOfSequence: sequence }, hash);
    });
  }
  async list(input: unknown): Promise<HkdPage> {
    this.authenticated(); const data = parse(hkdListSchema, input);
    return this.store.transaction(() => {
      const profile = this.profile(data.year); const maximum = hkdMaxSequence(this.store); let sequence = maximum; let after = 0;
      if (data.cursor) {
        let value: unknown; try { value = JSON.parse(data.cursor); } catch { return invalidCursor(); }
        const parsed = listCursorSchema.safeParse(value); if (!parsed.success) return invalidCursor();
        const c = parsed.data;
        if (c.year !== data.year || c.installationId !== profile.installationId || c.revision !== profile.revision || c.sequence > maximum || c.after > c.sequence) return invalidCursor();
        sequence = c.sequence; after = c.after;
      }
      if (after !== 0) {
        const prior = this.store.all<{ sequence: number }>("SELECT sequence FROM erp_ac_hkd_events WHERE year=? AND eventType='entry' AND sequence<=? ORDER BY sequence DESC LIMIT 25", data.year, after);
        if (prior.length !== 25 || prior[0]!.sequence !== after) return invalidCursor();
      }
      const rows = this.store.all<HkdEventRow>("SELECT e.*,v.payloadJson AS voidReason FROM erp_ac_hkd_events e LEFT JOIN erp_ac_hkd_events v ON v.targetId=e.id AND v.eventType='void' AND v.sequence<=? WHERE e.year=? AND e.eventType='entry' AND e.sequence>? AND e.sequence<=? ORDER BY e.sequence LIMIT 26", sequence, data.year, after, sequence);
      if (after !== 0 && rows.length === 0) return invalidCursor();
      const items = rows.slice(0, 25).map(hkdEntryFromRow); const hasMore = rows.length > 25;
      return { items, asOfSequence: sequence, hasMore, ...(hasMore ? { cursor: JSON.stringify({ v: 1, year: data.year, installationId: profile.installationId, revision: profile.revision, sequence, after: items[items.length - 1]!.sequence }) } : {}) };
    });
  }
  async report(input: unknown): Promise<HkdReport> {
    this.authenticated(); const data = parse(hkdReportSchema, input);
    return this.store.transaction(() => buildHkdReport(this.store, this.profile(data.year), data));
  }
}
