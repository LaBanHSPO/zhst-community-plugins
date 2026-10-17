export type HkdTaxMethod = 'exempt' | 'revenue' | 'income';
export type HkdPeriodType = 'month' | 'quarter' | 'year';
export type HkdBook = 'S1a-HKD' | 'S2a-HKD' | 'S2b-HKD' | 'S2c-HKD' | 'S2d-HKD' | 'S2e-HKD' | 'S3a-HKD';
export interface HkdConfigureInput {
  commandId: string; year: number; startDate: string; name: string; address: string;
  taxCode: string; representative: string; location: string; taxMethod: HkdTaxMethod;
  periodType: HkdPeriodType; incomeTaxRateBps: number | null; otherTaxes: boolean;
}
/** Explicit immutable annual policy; never inferred from revenue or enterprise COA. */
export interface HkdProfile extends Omit<HkdConfigureInput, 'commandId'> {
  installationId: string; revision: string; createdAt: string; createdBy: string;
}
export interface HkdInfo { profiles: HkdProfile[]; currency: 'VND'; pageSize: 25 }
export interface HkdEntryBase { date: string; documentDate: string; documentNumber: string; description: string }
export interface HkdRevenue extends HkdEntryBase {
  kind: 'revenue'; amountMinor: number; businessLine: string;
  vatRateBps: number; pitRateBps: number; vatTaxableMinor: number; pitTaxableMinor: number;
  incomeRevenueMinor: number;
}
export type HkdExpenseCategory = 'materials' | 'labour' | 'depreciation' | 'services' | 'interest' | 'other';
export interface HkdExpense extends HkdEntryBase { kind: 'expense'; category: HkdExpenseCategory; amountMinor: number; deductibleMinor: number }
/** Quantities are canonical decimal strings with up to six fractional digits. Outbound valuation is server-owned. */
export interface HkdStock extends HkdEntryBase {
  kind: 'stock'; direction: 'opening' | 'in' | 'out'; itemCode: string; itemName: string; unit: string;
  quantity: string; amountMinor: number | null;
}
export interface HkdMoney extends HkdEntryBase {
  kind: 'money'; direction: 'opening' | 'in' | 'out'; fund: 'cash' | 'bank'; bankName: string | null; amountMinor: number;
}
export type HkdTaxKind = 'export' | 'import' | 'excise' | 'environment' | 'resource' | 'land';
export interface HkdOtherTax extends HkdEntryBase {
  kind: 'tax'; taxKind: HkdTaxKind; quantity: string; absoluteRateMinor: number; unitTaxPriceMinor: number; taxRateBps: number;
}
export type HkdEntryPayload = HkdRevenue | HkdExpense | HkdStock | HkdMoney | HkdOtherTax;
export interface HkdPostInput { commandId: string; year: number; installationId: string; revision: string; entry: HkdEntryPayload }
export interface HkdVoidInput { commandId: string; year: number; installationId: string; revision: string; id: string; reason: string }
export interface HkdEntry {
  id: string; year: number; sequence: number; createdAt: string; createdBy: string;
  entry: HkdEntryPayload; voided: boolean; voidReason: string | null;
}
export interface HkdListInput { year: number; cursor?: string }
export interface HkdPage { items: HkdEntry[]; asOfSequence: number; hasMore: boolean; cursor?: string }
export interface HkdReportInput { year: number; period: number; book: HkdBook; cursor?: string }
export interface HkdColumn { key: string; label: string; numeric?: boolean }
export interface HkdReportRow { id: string; entryId?: string; cells: Record<string, string> }
export interface HkdReport {
  profile: HkdProfile; book: HkdBook; period: number; from: string; to: string; asOfSequence: number;
  columns: HkdColumn[]; rows: HkdReportRow[]; summaries: { label: string; cells: Record<string, string> }[];
  hasMore: boolean; cursor?: string; notes: string[];
}
/** Frozen exact-command outcome; refresh entries/reports separately for current state. */
export interface HkdCommandResult {
  commandId: string; action: 'hkd-configure' | 'hkd-post-entry' | 'hkd-void-entry'; year: number;
  profile?: HkdProfile; entry?: HkdEntry; voidedId?: string; asOfSequence: number;
}
