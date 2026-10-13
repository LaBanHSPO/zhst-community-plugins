import { z } from 'zod';
import type { Metadata, RecordView } from '../model.js';
import { ErpError, parse } from '../validation.js';
import type { Account, AccountingInfo, AccountingListInput, AccountingPage, AllocationInput, BookSettings, FinancialResult, Journal, JournalInput, JournalKind, JournalLine, JournalLineInput, Party, PartyInput, SourceSummary } from './model.js';
import type { AccountingStore, SqlParameter } from './store.js';
import type { ErpAccountingSource } from './erp-source.js';
import { buildAccountingReport } from './reports.js';
import { accountSchema, accountingGetSchema, accountingListSchema, calendarDateSchema, configureBookSchema, draftActionSchema, journalSchema, linkCustomerSchema, partySchema, postJournalSchema, reportSchema, reverseJournalSchema, settlementSchema } from './validation.js';

const savedBookSchema = z.strictObject({
  schemaVersion: z.literal(1), currency: z.literal('VND'), minorUnits: z.literal(0),
  startDate: calendarDateSchema, installationId: z.string().uuid(),
  createdAt: z.iso.datetime(), createdBy: z.string().min(1), updatedAt: z.iso.datetime(), updatedBy: z.string().min(1),
});
interface BookRow extends BookSettings { id: string; revision: string }
interface AccountRow extends Omit<Account, 'active' | 'isGroup'> { id: string; revision: string; active: number; isGroup: number; codeKey: string; nameKey: string }
interface PartyRow extends Omit<Party, 'active'> { id: string; revision: string; active: number; codeKey: string; nameKey: string }
interface JournalRow extends Omit<Journal, 'lines' | 'reversedBy'> { id: string; revision: string }
interface LineRow { journalId: string; lineIndex: number; accountId: string; partyId: string | null; role: JournalLine['role']; accountCode: string | null; accountName: string | null; accountRootType: Account['rootType'] | null; accountPurpose: Account['purpose'] | null; partyCode: string | null; partyName: string | null; partyKind: Party['kind'] | null; debitMinor: number; creditMinor: number }
interface SourceRow extends LineRow { postingDate: string; reference: string; revision: string }
interface ReceiptRow { action: string; actorId: string; canonicalPayloadHash: string; journalId: string; revision: string; postedSequence: number }

// Preserve arrays (including their order), while sorting every object key for a command's durable identity.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
async function commandHash(action: string, actorId: string, input: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ action, actorId, input })));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class AccountingService {
  constructor(private readonly store: AccountingStore, private readonly actorId: string, private readonly now: () => Date = () => new Date()) {}

  private authenticated(): void {
    if (!this.actorId) throw new ErpError('AUTH_REQUIRED', 'An authenticated administrator is required.');
  }
  private book(): RecordView<BookSettings> | null {
    const row = this.store.get<BookRow>('SELECT * FROM erp_ac_settings WHERE id = ?', 'book');
    if (!row) return null;
    const { id, revision, ...value } = row;
    if (value.schemaVersion !== 1) throw new ErpError('SCHEMA_VERSION', 'This book requires a compatible accounting schema.');
    if (value.currency !== 'VND' || value.minorUnits !== 0) throw new ErpError('CURRENCY_MISMATCH', 'Accounting requires the saved VND installation lock.');
    const parsed = savedBookSchema.safeParse(value);
    if (!parsed.success || id !== 'book' || typeof revision !== 'string' || !revision) throw new ErpError('INVALID_RECORD', 'The saved accounting book is malformed. A reviewed repair is required.');
    return { id, revision, value: parsed.data };
  }
  private requiredBook(): RecordView<BookSettings> {
    const book = this.book();
    if (!book) throw new ErpError('BOOK_REQUIRED', 'Configure the accounting book before using accounting.');
    return book;
  }
  private metadata(previous?: Metadata): Metadata {
    const timestamp = this.now().toISOString();
    return { schemaVersion: 1, createdAt: previous?.createdAt ?? timestamp, createdBy: previous?.createdBy ?? this.actorId, updatedAt: timestamp, updatedBy: this.actorId };
  }
  private audit(entity: 'account' | 'party' | 'journal', id: string, event: string, revision: string, postedSequence: number | null = null): void {
    this.store.run('INSERT INTO erp_ac_audit(id,entity,recordId,journalId,event,actorId,occurredAt,revision,postedSequence) VALUES(?,?,?,?,?,?,?,?,?)', globalThis.crypto.randomUUID(), entity, id, entity === 'journal' ? id : null, event, this.actorId, this.now().toISOString(), revision, postedSequence);
  }
  private revision(previous: { revision: string } | undefined, submitted: string | null): void {
    if (previous ? previous.revision !== submitted : submitted !== null) throw new ErpError('CONFLICT', 'This record changed. Keep your input and reload before saving.');
  }
  private account(id: string): RecordView<Account> {
    const row = this.store.get<AccountRow>('SELECT * FROM erp_ac_accounts WHERE id=?', id);
    if (!row) throw new ErpError('NOT_FOUND', 'The requested account does not exist.');
    const { revision, codeKey: _codeKey, nameKey: _nameKey, ...value } = row;
    const { id: recordId, ...fields } = value;
    return { id: recordId, revision, value: { ...fields, active: fields.active === 1, isGroup: fields.isGroup === 1 } };
  }
  private party(id: string): RecordView<Party> {
    const row = this.store.get<PartyRow>('SELECT * FROM erp_ac_parties WHERE id=?', id);
    if (!row) throw new ErpError('NOT_FOUND', 'The requested party does not exist.');
    const { id: recordId, revision, codeKey: _codeKey, nameKey: _nameKey, ...value } = row;
    return { id: recordId, revision, value: { ...value, active: value.active === 1 } };
  }
  private eligibleAccount(id: string): RecordView<Account> {
    const account = this.account(id);
    if (!account.value.active || account.value.isGroup) throw new ErpError('ACCOUNT_UNAVAILABLE', 'Select an active ledger account.');
    const seen = new Set([id]);
    let parentId = account.value.parentId;
    while (parentId) {
      if (seen.has(parentId)) throw new ErpError('ACCOUNT_UNAVAILABLE', 'The account tree contains a cycle.');
      seen.add(parentId);
      const parent = this.account(parentId).value;
      if (!parent.active || !parent.isGroup || parent.rootType !== account.value.rootType) throw new ErpError('ACCOUNT_UNAVAILABLE', 'Every parent must be an active group in the same root.');
      parentId = parent.parentId;
    }
    return account;
  }
  private validateDate(postingDate: string, kind: JournalKind): void {
    const book = this.requiredBook();
    if (postingDate < book.value.startDate || (kind === 'opening' && postingDate !== book.value.startDate)) throw new ErpError('INVALID_INPUT', 'Posting dates must be on or after the book start; opening entries must use the book start date.');
  }

  async info(): Promise<AccountingInfo> {
    this.authenticated();
    return { enabled: true, currency: 'VND', minorUnits: 0, pageSize: 25, maxLines: 50, book: this.book() };
  }
  async configureBook(input: unknown): Promise<RecordView<BookSettings>> {
    this.authenticated();
    const data = parse(configureBookSchema, input);
    return this.store.transaction(() => {
      if (this.book()) throw new ErpError('CONFLICT', 'This accounting book is already configured. Its start date and currency are immutable.');
      const timestamp = this.now().toISOString();
      const revision = globalThis.crypto.randomUUID();
      const value: BookSettings = { schemaVersion: 1, currency: 'VND', minorUnits: 0, startDate: data.startDate, installationId: globalThis.crypto.randomUUID(), createdAt: timestamp, createdBy: this.actorId, updatedAt: timestamp, updatedBy: this.actorId };
      this.store.run('INSERT INTO erp_ac_settings(id,schemaVersion,revision,currency,minorUnits,startDate,installationId,createdAt,createdBy,updatedAt,updatedBy) VALUES(?,?,?,?,?,?,?,?,?,?,?)', 'book', value.schemaVersion, revision, value.currency, value.minorUnits, value.startDate, value.installationId, timestamp, this.actorId, timestamp, this.actorId);
      this.store.run('INSERT INTO erp_ac_audit(id,entity,recordId,journalId,event,actorId,occurredAt,revision,postedSequence) VALUES(?,?,?,?,?,?,?,?,?)', globalThis.crypto.randomUUID(), 'book', 'book', null, 'configure-book', this.actorId, timestamp, revision, null);
      return { id: 'book', revision, value };
    });
  }
  async saveAccount(input: unknown): Promise<RecordView<Account>> {
    this.authenticated();
    const data = parse(accountSchema, input);
    return this.store.transaction(() => {
      this.requiredBook();
      const previous = this.store.get<AccountRow>('SELECT * FROM erp_ac_accounts WHERE id=?', data.id);
      this.revision(previous, data.revision);
      if ((data.isGroup && data.purpose !== 'general') || (['cash', 'bank', 'receivable'].includes(data.purpose) && (data.rootType !== 'asset' || data.isGroup)) || (data.purpose === 'payable' && (data.rootType !== 'liability' || data.isGroup))) throw new ErpError('ACCOUNT_UNAVAILABLE', 'Account purpose must match its ledger/root classification.');
      const seen = new Set([data.id]);
      let parentId = data.parentId;
      while (parentId) {
        if (seen.has(parentId)) throw new ErpError('ACCOUNT_CYCLE', 'An account cannot be its own ancestor.');
        seen.add(parentId);
        const parent = this.account(parentId).value;
        if (!parent.isGroup || parent.rootType !== data.rootType || (data.active && !parent.active)) throw new ErpError('ACCOUNT_UNAVAILABLE', 'Select an active group parent in the same root.');
        parentId = parent.parentId;
      }
      if (this.store.get('SELECT 1 FROM erp_ac_accounts WHERE parentId=? AND (rootType<>? OR ?=0) LIMIT 1', data.id, data.rootType, Number(data.isGroup))) throw new ErpError('ACCOUNT_UNAVAILABLE', 'An account with children must remain a group in their root.');
      if (previous && (previous.rootType !== data.rootType || previous.purpose !== data.purpose || previous.isGroup !== Number(data.isGroup) || previous.parentId !== data.parentId) && this.store.get("SELECT 1 FROM erp_ac_lines l JOIN erp_ac_journals j ON j.id=l.journalId WHERE l.accountId=? AND j.status='posted' LIMIT 1", data.id)) throw new ErpError('ACCOUNT_HISTORY', 'The structure of an account with posted history is immutable.');
      const codeKey = data.code.normalize('NFKC').toLowerCase();
      if (this.store.get('SELECT 1 FROM erp_ac_accounts WHERE codeKey=? AND id<>?', codeKey, data.id)) throw new ErpError('CONFLICT', 'This normalized account code is already in use.');
      const revision = globalThis.crypto.randomUUID();
      const value: Account = { ...data, ...this.metadata(previous) };
      const parameters: SqlParameter[] = [revision, data.code, codeKey, data.name, data.name.normalize('NFKC').toLowerCase(), data.rootType, data.purpose, Number(data.isGroup), data.parentId, Number(data.active), value.updatedAt, this.actorId];
      if (previous) this.store.run('UPDATE erp_ac_accounts SET revision=?,code=?,codeKey=?,name=?,nameKey=?,rootType=?,purpose=?,isGroup=?,parentId=?,active=?,updatedAt=?,updatedBy=? WHERE id=? AND revision=?', ...parameters, data.id, data.revision);
      else this.store.run('INSERT INTO erp_ac_accounts(revision,code,codeKey,name,nameKey,rootType,purpose,isGroup,parentId,active,updatedAt,updatedBy,id,schemaVersion,createdAt,createdBy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)', ...parameters, data.id, value.createdAt, value.createdBy);
      this.audit('account', data.id, 'save-account', revision);
      return this.account(data.id);
    });
  }
  private writeParty(data: PartyInput, source?: Awaited<ReturnType<ErpAccountingSource['customer']>>): RecordView<Party> {
    this.requiredBook();
    const previous = this.store.get<PartyRow>('SELECT * FROM erp_ac_parties WHERE id=?', data.id);
    this.revision(previous, data.revision);
    if (previous && previous.kind !== data.kind && (previous.sourceKind !== null || this.store.get("SELECT 1 FROM erp_ac_lines l JOIN erp_ac_journals j ON j.id=l.journalId WHERE l.partyId=? AND j.status='posted' LIMIT 1", data.id))) throw new ErpError('PARTY_HISTORY', 'A linked party or party with posted history cannot change kind.');
    const codeKey = data.code.normalize('NFKC').toLowerCase();
    if (this.store.get('SELECT 1 FROM erp_ac_parties WHERE kind=? AND codeKey=? AND id<>?', data.kind, codeKey, data.id)) throw new ErpError('CONFLICT', 'This normalized party code is already in use for that kind.');
    if (source && this.store.get('SELECT 1 FROM erp_ac_parties WHERE sourceKind=? AND sourceId=? AND kind=?', source.sourceKind, source.sourceId, data.kind)) throw new ErpError('CONFLICT', 'This CRM customer is already linked.');
    const metadata = this.metadata(previous);
    const revision = globalThis.crypto.randomUUID();
    if (previous) this.store.run('UPDATE erp_ac_parties SET revision=?,kind=?,code=?,codeKey=?,name=?,nameKey=?,active=?,updatedAt=?,updatedBy=? WHERE id=? AND revision=?', revision, data.kind, data.code, codeKey, data.name, data.name.normalize('NFKC').toLowerCase(), Number(data.active), metadata.updatedAt, this.actorId, data.id, data.revision);
    else this.store.run('INSERT INTO erp_ac_parties(id,schemaVersion,revision,kind,code,codeKey,name,nameKey,active,sourceKind,sourceId,sourceRevision,createdAt,createdBy,updatedAt,updatedBy) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', data.id, revision, data.kind, data.code, codeKey, data.name, data.name.normalize('NFKC').toLowerCase(), Number(data.active), source?.sourceKind ?? null, source?.sourceId ?? null, source?.sourceRevision ?? null, metadata.createdAt, metadata.createdBy, metadata.updatedAt, metadata.updatedBy);
    this.audit('party', data.id, source ? 'link-customer' : 'save-party', revision);
    return this.party(data.id);
  }
  async saveParty(input: unknown): Promise<RecordView<Party>> {
    this.authenticated();
    const data = parse(partySchema, input);
    return this.store.transaction(() => this.writeParty(data));
  }
  async linkCustomer(input: unknown, source?: ErpAccountingSource): Promise<RecordView<Party>> {
    this.authenticated();
    const data = parse(linkCustomerSchema, input);
    this.requiredBook();
    if (!source) throw new ErpError('SOURCE_UNAVAILABLE', 'CRM customer access is unavailable on this host.');
    const snapshot = await source.customer(data.customerId, data.customerRevision);
    const party = parse(partySchema, { id: data.id, revision: null, kind: 'customer', code: snapshot.code, name: snapshot.name, active: true });
    return this.store.transaction(() => this.writeParty(party, snapshot));
  }

  private journal(id: string): RecordView<Journal> {
    const row = this.store.get<JournalRow>('SELECT * FROM erp_ac_journals WHERE id=?', id);
    if (!row) throw new ErpError('NOT_FOUND', 'The requested journal does not exist.');
    const { id: recordId, revision, ...header } = row;
    const allocations = this.store.all<AllocationInput & { settlementLineIndex: number }>('SELECT settlementLineIndex,sourceJournalId,sourceLineIndex,amountMinor FROM erp_ac_allocations WHERE settlementJournalId=? ORDER BY settlementLineIndex,sourceJournalId,sourceLineIndex', id);
    const lines = this.store.all<LineRow>('SELECT * FROM erp_ac_lines WHERE journalId=? ORDER BY lineIndex', id).map((line): JournalLine => ({
      lineIndex: line.lineIndex, accountId: line.accountId, partyId: line.partyId, role: line.role, debitMinor: line.debitMinor, creditMinor: line.creditMinor,
      account: line.accountCode !== null && line.accountName !== null && line.accountRootType !== null && line.accountPurpose !== null ? { code: line.accountCode, name: line.accountName, rootType: line.accountRootType, purpose: line.accountPurpose } : null,
      party: line.partyCode !== null && line.partyName !== null && line.partyKind !== null ? { code: line.partyCode, name: line.partyName, kind: line.partyKind } : null,
      allocations: allocations.filter((item) => item.settlementLineIndex === line.lineIndex).map(({ settlementLineIndex: _index, ...item }) => item),
    }));
    const reversedBy = this.store.get<{ id: string }>("SELECT id FROM erp_ac_journals WHERE reversalOf=? AND status='posted'", id)?.id ?? null;
    return { id: recordId, revision, value: { ...header, reversedBy, lines } };
  }
  private sourceState(journalId: string, lineIndex: number): { source: SourceRow; allocated: bigint; remaining: bigint; fence: string } {
    const source = this.store.get<SourceRow>("SELECT l.*,j.postingDate,j.reference,j.revision FROM erp_ac_lines l JOIN erp_ac_journals j ON j.id=l.journalId WHERE l.journalId=? AND l.lineIndex=? AND l.role='open-item' AND j.status='posted' AND NOT EXISTS(SELECT 1 FROM erp_ac_journals r WHERE r.reversalOf=j.id AND r.status='posted')", journalId, lineIndex);
    if (!source) throw new ErpError('OVER_ALLOCATION', 'Select an unreversed posted open-item source.');
    let allocated = 0n;
    let fence = source.postingDate;
    let afterJournal = '';
    let afterIndex = -1;
    for (;;) {
      const rows = this.store.all<{ settlementJournalId: string; settlementLineIndex: number; amountMinor: number; postingDate: string; releaseDate: string | null }>("SELECT x.settlementJournalId,x.settlementLineIndex,x.amountMinor,j.postingDate,r.postingDate AS releaseDate FROM erp_ac_allocations x JOIN erp_ac_journals j ON j.id=x.settlementJournalId LEFT JOIN erp_ac_journals r ON r.reversalOf=j.id AND r.status='posted' WHERE x.sourceJournalId=? AND x.sourceLineIndex=? AND j.status='posted' AND (x.settlementJournalId,x.settlementLineIndex)>(?,?) ORDER BY x.settlementJournalId,x.settlementLineIndex LIMIT 256", journalId, lineIndex, afterJournal, afterIndex);
      for (const row of rows) {
        if (row.releaseDate === null) allocated += BigInt(row.amountMinor);
        if (row.postingDate > fence) fence = row.postingDate;
        if (row.releaseDate !== null && row.releaseDate > fence) fence = row.releaseDate;
        afterJournal = row.settlementJournalId;
        afterIndex = row.settlementLineIndex;
      }
      if (rows.length < 256) break;
    }
    const remaining = BigInt(source.debitMinor) + BigInt(source.creditMinor) - allocated;
    return { source, allocated, remaining, fence };
  }
  private prepareLines(lines: JournalLineInput[], postingDate: string): JournalLine[] {
    let debit = 0n;
    let credit = 0n;
    const groupedSources = new Map<string, { state: ReturnType<AccountingService['sourceState']>; amount: bigint }>();
    const accounts = new Map<string, Account>();
    const parties = new Map<string, Party>();
    const prepared = lines.map((line, lineIndex): JournalLine => {
      let account = accounts.get(line.accountId);
      if (!account) { account = this.eligibleAccount(line.accountId).value; accounts.set(line.accountId, account); }
      let party: Party | null = null;
      const control = account.purpose === 'receivable' || account.purpose === 'payable';
      if (control) {
        if (!line.partyId) throw new ErpError('PARTY_REQUIRED', 'Receivable/payable lines require a party.');
        party = parties.get(line.partyId) ?? null;
        if (!party) { party = this.party(line.partyId).value; parties.set(line.partyId, party); }
        if (!party.active || party.kind !== (account.purpose === 'receivable' ? 'customer' : 'supplier')) throw new ErpError('PARTY_REQUIRED', 'Select an active party of the correct kind.');
      } else if (line.partyId !== null) throw new ErpError('PARTY_REQUIRED', 'Only receivable/payable control lines can carry a party.');
      const role = control ? ((account.purpose === 'receivable' ? line.debitMinor : line.creditMinor) > 0 ? 'open-item' : 'settlement') : 'general';
      debit += BigInt(line.debitMinor);
      credit += BigInt(line.creditMinor);
      const allocationsBySource = new Map<string, AllocationInput>();
      let allocated = 0n;
      for (const allocation of line.allocations) {
        if (role !== 'settlement') throw new ErpError('OVER_ALLOCATION', 'Only a reducing control line can carry allocations.');
        const key = `${allocation.sourceJournalId}:${allocation.sourceLineIndex}`;
        let group = groupedSources.get(key);
        if (!group) { group = { state: this.sourceState(allocation.sourceJournalId, allocation.sourceLineIndex), amount: 0n }; groupedSources.set(key, group); }
        const state = group.state;
        if (state.source.accountId !== line.accountId || state.source.partyId !== line.partyId || (state.source.debitMinor > 0) === (line.debitMinor > 0)) throw new ErpError('OVER_ALLOCATION', 'Every allocation must match the control account, party and opposite side.');
        if (postingDate < state.fence) throw new ErpError('ALLOCATION_DATE_CONFLICT', 'The date cannot precede the source or its latest allocation/release.');
        allocated += BigInt(allocation.amountMinor);
        const existing = allocationsBySource.get(key);
        if (existing) existing.amountMinor += allocation.amountMinor;
        else allocationsBySource.set(key, { ...allocation });
        group.amount += BigInt(allocation.amountMinor);
      }
      if (role === 'settlement' && allocated !== BigInt(line.debitMinor) + BigInt(line.creditMinor)) throw new ErpError('OVER_ALLOCATION', 'Each reducing control line must be fully allocated to posted sources.');
      return { ...line, allocations: [...allocationsBySource.values()], lineIndex, role, account: { code: account.code, name: account.name, rootType: account.rootType, purpose: account.purpose }, party: party ? { code: party.code, name: party.name, kind: party.kind } : null };
    });
    if (debit <= 0n || debit !== credit) throw new ErpError('UNBALANCED', 'Total debits and credits must be equal and positive.');
    for (const group of groupedSources.values()) {
      if (group.amount > group.state.remaining) throw new ErpError('OVER_ALLOCATION', 'The grouped allocation exceeds this source’s operational remaining amount.');
    }
    return prepared;
  }
  private writeLines(id: string, lines: JournalLine[]): void {
    this.store.run('DELETE FROM erp_ac_allocations WHERE settlementJournalId=?', id);
    this.store.run('DELETE FROM erp_ac_lines WHERE journalId=?', id);
    for (const line of lines) {
      this.store.run('INSERT INTO erp_ac_lines(journalId,lineIndex,accountId,partyId,role,accountCode,accountName,accountRootType,accountPurpose,partyCode,partyName,partyKind,debitMinor,creditMinor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, line.lineIndex, line.accountId, line.partyId, line.role, line.account?.code ?? null, line.account?.name ?? null, line.account?.rootType ?? null, line.account?.purpose ?? null, line.party?.code ?? null, line.party?.name ?? null, line.party?.kind ?? null, line.debitMinor, line.creditMinor);
      for (const allocation of line.allocations) this.store.run('INSERT INTO erp_ac_allocations(settlementJournalId,settlementLineIndex,sourceJournalId,sourceLineIndex,amountMinor) VALUES(?,?,?,?,?)', id, line.lineIndex, allocation.sourceJournalId, allocation.sourceLineIndex, allocation.amountMinor);
    }
  }
  private writeDraft(data: Omit<JournalInput, 'kind'> & { kind: JournalKind }, reversalOf: string | null = null, exactLines?: JournalLine[]): RecordView<Journal> {
    this.validateDate(data.postingDate, data.kind);
    const previous = this.store.get<JournalRow>('SELECT * FROM erp_ac_journals WHERE id=?', data.id);
    this.revision(previous, data.revision);
    if (previous && previous.status !== 'draft') throw new ErpError('INVALID_TRANSITION', 'Only drafts can be edited. Cancelled drafts cannot be revived.');
    if (previous && previous.kind !== data.kind) throw new ErpError('INVALID_TRANSITION', 'A draft’s kind cannot be changed.');
    const lines = exactLines ?? this.prepareLines(data.lines, data.postingDate);
    const revision = globalThis.crypto.randomUUID();
    const metadata = this.metadata(previous);
    if (previous) this.store.run('UPDATE erp_ac_journals SET revision=?,postingDate=?,memo=?,reference=?,updatedAt=?,updatedBy=? WHERE id=? AND revision=?', revision, data.postingDate, data.memo, data.reference, metadata.updatedAt, this.actorId, data.id, data.revision);
    else this.store.run("INSERT INTO erp_ac_journals(id,schemaVersion,revision,kind,status,postingDate,memo,reference,currency,number,postedSequence,postedAt,postedBy,reversalOf,createdAt,createdBy,updatedAt,updatedBy) VALUES(?,1,?,?,'draft',?,?,?,'VND',NULL,NULL,NULL,NULL,?,?,?,?,?)", data.id, revision, data.kind, data.postingDate, data.memo, data.reference, reversalOf, metadata.createdAt, metadata.createdBy, metadata.updatedAt, metadata.updatedBy);
    this.writeLines(data.id, lines);
    if (!exactLines) this.audit('journal', data.id, data.kind === 'receipt' || data.kind === 'payment' ? 'save-settlement' : 'save-journal', revision);
    return this.journal(data.id);
  }
  async saveJournal(input: unknown): Promise<RecordView<Journal>> {
    this.authenticated();
    const data = parse(journalSchema, input);
    return this.store.transaction(() => this.writeDraft(data));
  }
  async saveSettlement(input: unknown): Promise<RecordView<Journal>> {
    this.authenticated();
    const data = parse(settlementSchema, input);
    return this.store.transaction(() => {
      this.validateDate(data.postingDate, data.kind);
      const money = this.eligibleAccount(data.moneyAccountId).value;
      if (money.purpose !== 'cash' && money.purpose !== 'bank') throw new ErpError('ACCOUNT_UNAVAILABLE', 'Select a cash or bank ledger account.');
      const party = this.party(data.partyId).value;
      if (!party.active || party.kind !== (data.kind === 'receipt' ? 'customer' : 'supplier')) throw new ErpError('PARTY_REQUIRED', 'Select an active party of the correct kind.');
      let total = 0n;
      let controlAccountId: string | undefined;
      const controls = data.allocations.map((allocation): JournalLineInput => {
        const { source } = this.sourceState(allocation.sourceJournalId, allocation.sourceLineIndex);
        if (source.partyId !== data.partyId || source.accountPurpose !== (data.kind === 'receipt' ? 'receivable' : 'payable') || (controlAccountId !== undefined && controlAccountId !== source.accountId)) throw new ErpError('OVER_ALLOCATION', 'Helper sources must share the selected party and one correct control account.');
        controlAccountId = source.accountId;
        total += BigInt(allocation.amountMinor);
        return { accountId: source.accountId, partyId: data.partyId, debitMinor: data.kind === 'payment' ? allocation.amountMinor : 0, creditMinor: data.kind === 'receipt' ? allocation.amountMinor : 0, allocations: [allocation] };
      });
      if (total > 1_000_000_000_000n) throw new ErpError('INVALID_INPUT', 'The cash/bank line exceeds the supported integer money limit.');
      const moneyLine: JournalLineInput = { accountId: data.moneyAccountId, partyId: null, debitMinor: data.kind === 'receipt' ? Number(total) : 0, creditMinor: data.kind === 'payment' ? Number(total) : 0, allocations: [] };
      return this.writeDraft({ id: data.id, revision: data.revision, kind: data.kind, postingDate: data.postingDate, memo: data.memo, reference: data.reference, lines: [moneyLine, ...controls] });
    });
  }
  async cancelDraft(input: unknown): Promise<RecordView<Journal>> {
    this.authenticated();
    const data = parse(draftActionSchema, input);
    return this.store.transaction(() => {
      this.requiredBook();
      const journal = this.journal(data.id);
      this.revision(journal, data.revision);
      if (journal.value.status !== 'draft') throw new ErpError('INVALID_TRANSITION', 'Only a draft can be cancelled.');
      const revision = globalThis.crypto.randomUUID();
      this.store.run("UPDATE erp_ac_journals SET status='cancelled',revision=?,updatedAt=?,updatedBy=? WHERE id=? AND revision=?", revision, this.now().toISOString(), this.actorId, data.id, data.revision);
      this.audit('journal', data.id, 'cancel-draft', revision);
      return this.journal(data.id);
    });
  }
  private receipt(commandId: string, action: string, hash: string): FinancialResult | undefined {
    const receipt = this.store.get<ReceiptRow>('SELECT * FROM erp_ac_commands WHERE commandId=?', commandId);
    if (!receipt) return undefined;
    if (receipt.action !== action || receipt.actorId !== this.actorId || receipt.canonicalPayloadHash !== hash) throw new ErpError('IDEMPOTENCY_CONFLICT', 'This command ID belongs to a different action, actor or payload.');
    return { id: receipt.journalId, revision: receipt.revision, postedSequence: receipt.postedSequence };
  }
  private finalize(id: string, revision: string, commandId: string, action: 'post-journal' | 'reverse-journal', hash: string): FinancialResult {
    const last = this.store.get<{ sequence: number }>('SELECT coalesce(max(postedSequence),0) AS sequence FROM erp_ac_journals')!.sequence;
    if (last >= Number.MAX_SAFE_INTEGER) throw new ErpError('MONEY_OVERFLOW', 'The posting sequence has reached its supported bound.');
    const postedSequence = last + 1;
    const nextRevision = globalThis.crypto.randomUUID();
    const timestamp = this.now().toISOString();
    const result = this.store.run("UPDATE erp_ac_journals SET status='posted',revision=?,number=?,postedSequence=?,postedAt=?,postedBy=?,updatedAt=?,updatedBy=? WHERE id=? AND revision=? AND status='draft'", nextRevision, `J-${String(postedSequence).padStart(8, '0')}`, postedSequence, timestamp, this.actorId, timestamp, this.actorId, id, revision);
    if (result.changes !== 1) throw new ErpError('CONFLICT', 'The draft changed before posting.');
    this.audit('journal', id, action, nextRevision, postedSequence);
    this.store.run('INSERT INTO erp_ac_commands(commandId,action,actorId,canonicalPayloadHash,journalId,revision,postedSequence,createdAt) VALUES(?,?,?,?,?,?,?,?)', commandId, action, this.actorId, hash, id, nextRevision, postedSequence, timestamp);
    return { id, revision: nextRevision, postedSequence };
  }
  async postJournal(input: unknown): Promise<FinancialResult> {
    this.authenticated();
    const data = parse(postJournalSchema, input);
    const hash = await commandHash('post-journal', this.actorId, data);
    return this.store.transaction(() => {
      const replay = this.receipt(data.commandId, 'post-journal', hash);
      if (replay) return replay;
      this.requiredBook();
      const draft = this.journal(data.id);
      this.revision(draft, data.revision);
      if (draft.value.status !== 'draft' || draft.value.kind === 'reversal') throw new ErpError('INVALID_TRANSITION', 'Only a saved, non-reversal draft can be posted.');
      this.validateDate(draft.value.postingDate, draft.value.kind);
      const parsedLines = parse(journalSchema.shape.lines, draft.value.lines.map(({ accountId, partyId, debitMinor, creditMinor, allocations }) => ({ accountId, partyId, debitMinor, creditMinor, allocations })));
      this.writeLines(data.id, this.prepareLines(parsedLines, draft.value.postingDate));
      return this.finalize(data.id, data.revision, data.commandId, 'post-journal', hash);
    });
  }
  async reverseJournal(input: unknown): Promise<FinancialResult> {
    this.authenticated();
    const data = parse(reverseJournalSchema, input);
    const hash = await commandHash('reverse-journal', this.actorId, data);
    return this.store.transaction(() => {
      const replay = this.receipt(data.commandId, 'reverse-journal', hash);
      if (replay) return replay;
      this.validateDate(data.postingDate, 'reversal');
      const original = this.journal(data.id);
      this.revision(original, data.revision);
      if (original.value.status !== 'posted' || original.value.kind === 'reversal' || original.value.reversedBy !== null) throw new ErpError('INVALID_TRANSITION', 'Only an unreversed posted original can be reversed once.');
      if (data.postingDate < original.value.postingDate) throw new ErpError('ALLOCATION_DATE_CONFLICT', 'A reversal cannot precede the original.');
      // Validate every incoming source before releasing any outgoing allocation on mixed journals.
      const affected = new Map<string, { journalId: string; lineIndex: number }>();
      for (const line of original.value.lines) {
        if (line.role === 'open-item') {
          const state = this.sourceState(data.id, line.lineIndex);
          if (state.allocated > 0n) throw new ErpError('ACTIVE_SETTLEMENT', 'Reverse all active settlements before reversing their source.');
          affected.set(`${data.id}:${line.lineIndex}`, { journalId: data.id, lineIndex: line.lineIndex });
        }
        for (const allocation of line.allocations) affected.set(`${allocation.sourceJournalId}:${allocation.sourceLineIndex}`, { journalId: allocation.sourceJournalId, lineIndex: allocation.sourceLineIndex });
      }
      for (const source of affected.values()) if (data.postingDate < this.sourceState(source.journalId, source.lineIndex).fence) throw new ErpError('ALLOCATION_DATE_CONFLICT', 'A reversal cannot precede the latest activity of any affected source.');
      const lines: JournalLine[] = original.value.lines.map((line) => ({ ...line, role: 'reversal', debitMinor: line.creditMinor, creditMinor: line.debitMinor, allocations: [] }));
      const reversal = this.writeDraft({ id: globalThis.crypto.randomUUID(), revision: null, kind: 'reversal', postingDate: data.postingDate, memo: data.memo, reference: original.value.reference, lines }, data.id, lines);
      return this.finalize(reversal.id, reversal.revision, data.commandId, 'reverse-journal', hash);
    });
  }

  async get(input: unknown): Promise<RecordView<Account> | RecordView<Party> | RecordView<Journal>> {
    this.authenticated();
    const data = parse(accountingGetSchema, input);
    return this.store.transaction(() => {
      this.requiredBook();
      if (data.entity === 'accounts') return this.account(data.id);
      if (data.entity === 'parties') return this.party(data.id);
      return this.journal(data.id);
    });
  }
  async list(input: unknown): Promise<AccountingPage<Account | Party | Journal | SourceSummary>> {
    this.authenticated();
    const data = parse(accountingListSchema, input);
    return this.store.transaction(() => this.listPage(data));
  }
  private listPage(data: AccountingListInput): AccountingPage<Account | Party | Journal | SourceSummary> {
    this.requiredBook();
    const { cursor: _cursor, ...filters } = data;
    const filter = canonical(filters);
    let key: (string | number)[] = [];
    if (data.cursor) {
      try {
        const token = JSON.parse(data.cursor) as { v?: unknown; filter?: unknown; key?: unknown };
        if (Object.keys(token).some((name) => !['v', 'filter', 'key'].includes(name)) || token.v !== 1 || token.filter !== filter || !Array.isArray(token.key)) throw new Error('cursor');
        key = token.key;
        if (data.entity === 'accounts' || data.entity === 'parties') {
          if (key.length !== 1 || !z.string().uuid().safeParse(key[0]).success) throw new Error('cursor');
        } else if (key.length !== (data.entity === 'sources' ? 3 : 2) || !calendarDateSchema.safeParse(key[0]).success || !z.string().uuid().safeParse(key[1]).success || (data.entity === 'sources' && (!Number.isInteger(key[2]) || Number(key[2]) < 0 || Number(key[2]) > 49))) throw new Error('cursor');
      } catch { throw new ErpError('INVALID_CURSOR', 'This list cursor is invalid or belongs to different filters.'); }
    }
    const items: RecordView<Account | Party | Journal | SourceSummary>[] = [];
    let lastKey: (string | number)[] | undefined;
    if (data.entity === 'sources') {
      let scan = key.length ? key : ['', '', -1];
      for (;;) {
        const clauses = ["j.status='posted'", "l.role='open-item'", "NOT EXISTS(SELECT 1 FROM erp_ac_journals r WHERE r.reversalOf=j.id AND r.status='posted')", '(j.postingDate,j.id,l.lineIndex)>(?,?,?)'];
        const parameters: SqlParameter[] = [...scan];
        if (data.accountId) { clauses.push('l.accountId=?'); parameters.push(data.accountId); }
        if (data.partyId) { clauses.push('l.partyId=?'); parameters.push(data.partyId); }
        if (data.kind) { clauses.push('l.partyKind=?'); parameters.push(data.kind); }
        const rows = this.store.all<SourceRow>(`SELECT l.*,j.postingDate,j.reference,j.revision FROM erp_ac_lines l JOIN erp_ac_journals j ON j.id=l.journalId WHERE ${clauses.join(' AND ')} ORDER BY j.postingDate,j.id,l.lineIndex LIMIT 26`, ...parameters);
        for (const row of rows) {
          scan = [row.postingDate, row.journalId, row.lineIndex];
          const state = this.sourceState(row.journalId, row.lineIndex);
          if (state.remaining <= 0n) continue;
          const value: SourceSummary = { journalId: row.journalId, lineIndex: row.lineIndex, postingDate: row.postingDate, reference: row.reference, accountId: row.accountId, accountCode: row.accountCode!, accountName: row.accountName!, partyId: row.partyId!, partyCode: row.partyCode!, partyName: row.partyName!, partyKind: row.partyKind!, originalMinor: (BigInt(row.debitMinor) + BigInt(row.creditMinor)).toString(), allocatedMinor: state.allocated.toString(), remainingMinor: state.remaining.toString() };
          items.push({ id: `${row.journalId}:${row.lineIndex}`, revision: row.revision, value });
          if (items.length <= 25) lastKey = scan;
          if (items.length === 26) break;
        }
        if (items.length === 26 || rows.length < 26) break;
      }
    } else {
      const clauses: string[] = [];
      const parameters: SqlParameter[] = [];
      if (data.entity === 'journals') {
        if (key.length) { clauses.push('(postingDate,id)>(?,?)'); parameters.push(...key); }
        if (data.status !== undefined) { clauses.push('status=?'); parameters.push(data.status); }
      } else {
        if (key.length) { clauses.push('id>?'); parameters.push(...key); }
        if (data.active !== undefined) { clauses.push('active=?'); parameters.push(Number(data.active)); }
        if (data.kind !== undefined) { clauses.push('kind=?'); parameters.push(data.kind); }
        if (data.search) {
          clauses.push("(nameKey LIKE ? ESCAPE '\\' OR codeKey LIKE ? ESCAPE '\\')");
          const term = `%${data.search.normalize('NFKC').toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
          parameters.push(term, term);
        }
      }
      const rows = this.store.all<{ id: string; postingDate?: string }>(`SELECT id${data.entity === 'journals' ? ',postingDate' : ''} FROM erp_ac_${data.entity} ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${data.entity === 'journals' ? 'postingDate,id' : 'id'} LIMIT 26`, ...parameters);
      for (const row of rows) {
        items.push(data.entity === 'accounts' ? this.account(row.id) : data.entity === 'parties' ? this.party(row.id) : this.journal(row.id));
        if (items.length <= 25) lastKey = data.entity === 'journals' ? [row.postingDate!, row.id] : [row.id];
      }
    }
    const hasMore = items.length > 25;
    return { items: items.slice(0, 25), hasMore, ...(hasMore && lastKey ? { cursor: JSON.stringify({ v: 1, filter, key: lastKey }) } : {}) };
  }
  async report(input: unknown) {
    this.authenticated();
    const data = parse(reportSchema, input);
    this.requiredBook();
    return buildAccountingReport(this.store, data);
  }
}
