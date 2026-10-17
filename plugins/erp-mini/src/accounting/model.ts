import type { Metadata, RecordView } from '../model.js';

export type RootType = 'asset' | 'liability' | 'equity' | 'income' | 'expense' | 'result';
export type AccountPurpose = 'general' | 'cash' | 'bank' | 'receivable' | 'payable';
export type PartyKind = 'customer' | 'supplier';
export type JournalKind = 'journal' | 'opening' | 'receipt' | 'payment' | 'reversal';
export type JournalStatus = 'draft' | 'cancelled' | 'posted';
export type LineRole = 'general' | 'open-item' | 'settlement' | 'reversal';
export type AccountingAction = 'info' | 'configure-book' | 'list' | 'get' | 'report' | 'save-account' | 'account-templates' | 'account-template' | 'preview-account-import' | 'import-accounts' | 'save-party' | 'link-customer' | 'save-journal' | 'cancel-draft' | 'post-journal' | 'reverse-journal' | 'save-settlement' | 'hkd-info' | 'hkd-configure' | 'hkd-post-entry' | 'hkd-void-entry' | 'hkd-list' | 'hkd-report';
export interface BookSettings extends Metadata { currency: 'VND'; minorUnits: 0; startDate: string; installationId: string }
export interface AccountingInfo { enabled: true; currency: 'VND'; minorUnits: 0; pageSize: 25; maxLines: 50; book: RecordView<BookSettings> | null }
export interface Account extends Metadata { code: string; name: string; rootType: RootType; purpose: AccountPurpose; isGroup: boolean; parentId: string | null; active: boolean }
export interface Party extends Metadata { kind: PartyKind; code: string; name: string; active: boolean; sourceKind: 'customer' | null; sourceId: string | null; sourceRevision: string | null }
export interface AccountInput { id: string; revision: string | null; code: string; name: string; rootType: RootType; purpose: AccountPurpose; isGroup: boolean; parentId: string | null; active: boolean }
export interface PartyInput { id: string; revision: string | null; kind: PartyKind; code: string; name: string; active: boolean }
export interface LinkCustomerInput { id: string; revision: null; customerId: string; customerRevision: string }
export interface ConfigureBookInput { startDate: string }
export interface AccountSnapshot { code: string; name: string; rootType: RootType; purpose: AccountPurpose }
export interface PartySnapshot { code: string; name: string; kind: PartyKind }
export interface AllocationInput { sourceJournalId: string; sourceLineIndex: number; amountMinor: number }
export interface JournalLineInput { accountId: string; partyId: string | null; debitMinor: number; creditMinor: number; allocations: AllocationInput[] }
export interface JournalLine extends JournalLineInput { lineIndex: number; role: LineRole; account: AccountSnapshot | null; party: PartySnapshot | null }
export interface Journal extends Metadata { kind: JournalKind; status: JournalStatus; postingDate: string; memo: string; reference: string; currency: 'VND'; number: string | null; postedSequence: number | null; postedAt: string | null; postedBy: string | null; reversalOf: string | null; reversedBy: string | null; lines: JournalLine[] }
export interface JournalInput { id: string; revision: string | null; kind: 'journal' | 'opening'; postingDate: string; memo: string; reference: string; lines: JournalLineInput[] }
export interface DraftActionInput { id: string; revision: string }
export interface PostJournalInput extends DraftActionInput { commandId: string }
export interface ReverseJournalInput extends PostJournalInput { postingDate: string; memo: string }
export interface SettlementInput { id: string; revision: string | null; kind: 'receipt' | 'payment'; postingDate: string; memo: string; reference: string; moneyAccountId: string; partyId: string; allocations: AllocationInput[] }
export interface SourceSummary { journalId: string; lineIndex: number; postingDate: string; reference: string; accountId: string; accountCode: string; accountName: string; partyId: string; partyCode: string; partyName: string; partyKind: PartyKind; originalMinor: string; allocatedMinor: string; remainingMinor: string }
export type AccountingEntity = 'accounts' | 'parties' | 'journals' | 'sources';
export interface AccountingListInput { entity: AccountingEntity; cursor?: string; search?: string; active?: boolean; kind?: PartyKind; status?: JournalStatus; accountId?: string; partyId?: string }
export interface AccountingGetInput { entity: 'accounts' | 'parties' | 'journals'; id: string }
export interface AccountingPage<T> { items: RecordView<T>[]; hasMore: boolean; cursor?: string }
export type ReportType = 'journal' | 'ledger' | 'trial-balance' | 'cash-bank' | 'debt';
export interface ReportInput { type: ReportType; from: string; to: string; accountId?: string; partyId?: string; cursor?: string }
export interface JournalReportRow { kind: 'journal'; journalId: string; lineIndex: number; postingDate: string; postedSequence: number; number: string; postedAt: string; postedBy: string; reference: string; memo: string; accountId: string; accountCode: string; accountName: string; partyId: string | null; partyName: string | null; debitMinor: string; creditMinor: string; reversalOf: string | null; reversedBy: string | null }
export interface AccountReportRow { kind: 'account'; accountId: string; accountCode: string; accountName: string; rootType: RootType; purpose: AccountPurpose; openingMinor: string; debitMinor: string; creditMinor: string; closingMinor: string; openingDebitMinor: string; openingCreditMinor: string; closingDebitMinor: string; closingCreditMinor: string }
export interface SourceReportRow extends SourceSummary { kind: 'source' }
export interface AccountingReport { type: ReportType; asOfSequence: number; from: string; to: string; items: (JournalReportRow | AccountReportRow | SourceReportRow)[]; hasMore: boolean; cursor?: string; totals: Record<string, string>; reconciled?: boolean }

/** Immutable financial command receipt; reload the journal separately for current links. */
export interface FinancialResult { id: string; revision: string; postedSequence: number }

export type CoaTemplateId = 'vn-tt133-2016' | 'vn-tt99-2025';
export type CoaCategory = 'asset' | 'liability' | 'equity' | 'revenue' | 'operating-expense' | 'other-income' | 'other-expense' | 'result';
export interface CoaTemplateMetadata {
  templateId: CoaTemplateId; templateVersion: string; label: string;
  scope: string; effectiveDate: string; fiscalYearApplication: string;
  amendments: string[]; sources: { label: string; url: string }[]; limitations: string[];
}
export interface CoaEntry {
  code: string; name: string; parentCode: string | null; rootType: RootType;
  purpose: AccountPurpose; isGroup: boolean; category: CoaCategory;
}
export interface CoaTemplate extends CoaTemplateMetadata { entries: CoaEntry[] }
export interface CoaSelection { templateId: CoaTemplateId; templateVersion: string; selectedCodes: string[] }
export interface CoaImportInput extends CoaSelection { commandId: string }
export interface CoaConflict { field: 'name' | 'rootType' | 'purpose' | 'isGroup' | 'parent' | 'active'; expected: string | boolean | null; actual: string | boolean | null }
export interface CoaPreviewRow extends CoaEntry {
  automaticParent: boolean; status: 'create' | 'existing' | 'conflict';
  existingId?: string; conflicts?: CoaConflict[];
}
export interface CoaImportPreview extends CoaSelection {
  rows: CoaPreviewRow[]; createCount: number; existingCount: number; conflictCount: number; canImport: boolean;
}
export interface CoaAccountRef { code: string; id: string; revision: string }
/** Immutable master-data receipt; not the current state of imported accounts. */
export interface CoaImportResult extends CoaImportInput {
  created: CoaAccountRef[]; existing: CoaAccountRef[]; completedAt: string;
}
