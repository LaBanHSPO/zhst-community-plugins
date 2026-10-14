import { z } from 'zod';

export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  if (value.startsWith('0000-')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, 'Enter a real calendar date (YYYY-MM-DD).');
export const configureBookSchema = z.strictObject({ startDate: calendarDateSchema });
export const sourceCustomerSchema = z.strictObject({
  id: z.string().uuid().transform((value) => value.toLowerCase()),
  revision: z.string().min(1).max(2048),
});

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const revision = z.string().min(1).max(2048);
const text = (max: number) => z.string().trim().max(max);
const identity = { id: uuid, revision: revision.nullable() };
const money = z.number().int().min(0).max(1_000_000_000_000);
export const accountSchema = z.strictObject({
  ...identity, code: text(64).min(1), name: text(200).min(1),
  rootType: z.enum(['asset', 'liability', 'equity', 'income', 'expense', 'result']),
  purpose: z.enum(['general', 'cash', 'bank', 'receivable', 'payable']),
  isGroup: z.boolean(), parentId: uuid.nullable(), active: z.boolean(),
});
export const partySchema = z.strictObject({
  ...identity, kind: z.enum(['customer', 'supplier']), code: text(64).min(1), name: text(200).min(1), active: z.boolean(),
});
export const linkCustomerSchema = z.strictObject({ id: uuid, revision: z.null(), customerId: uuid, customerRevision: revision });
export const allocationSchema = z.strictObject({
  sourceJournalId: uuid, sourceLineIndex: z.number().int().min(0).max(49), amountMinor: money.refine((value) => value > 0, 'An allocation must be positive.'),
});
export const journalLineSchema = z.strictObject({
  accountId: uuid, partyId: uuid.nullable(), debitMinor: money, creditMinor: money, allocations: z.array(allocationSchema).max(49),
}).refine((line) => (line.debitMinor > 0 && line.creditMinor === 0) || (line.creditMinor > 0 && line.debitMinor === 0), 'Enter exactly one positive debit or credit.');
export const journalSchema = z.strictObject({
  ...identity, kind: z.enum(['journal', 'opening']), postingDate: calendarDateSchema,
  memo: text(2000), reference: text(200), lines: z.array(journalLineSchema).min(2).max(50),
});
export const draftActionSchema = z.strictObject({ id: uuid, revision });
export const postJournalSchema = z.strictObject({ id: uuid, revision, commandId: uuid });
export const reverseJournalSchema = z.strictObject({ id: uuid, revision, commandId: uuid, postingDate: calendarDateSchema, memo: text(2000) });
export const financialResultSchema = z.strictObject({
  id: uuid, revision, postedSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export const settlementSchema = z.strictObject({
  ...identity, kind: z.enum(['receipt', 'payment']), postingDate: calendarDateSchema, memo: text(2000), reference: text(200),
  moneyAccountId: uuid, partyId: uuid, allocations: z.array(allocationSchema).min(1).max(49),
});
export const accountingGetSchema = z.strictObject({ entity: z.enum(['accounts', 'parties', 'journals']), id: uuid });
export const accountingListSchema = z.strictObject({
  entity: z.enum(['accounts', 'parties', 'journals', 'sources']), cursor: z.string().min(1).max(4096).optional(),
  search: text(200).optional(), active: z.boolean().optional(), kind: z.enum(['customer', 'supplier']).optional(),
  status: z.enum(['draft', 'cancelled', 'posted']).optional(), accountId: uuid.optional(), partyId: uuid.optional(),
}).superRefine((input, context) => {
  const permitted = input.entity === 'accounts' ? ['search', 'active'] : input.entity === 'parties' ? ['search', 'active', 'kind'] : input.entity === 'journals' ? ['status'] : ['kind', 'accountId', 'partyId'];
  for (const key of ['search', 'active', 'kind', 'status', 'accountId', 'partyId'] as const) {
    if (input[key] !== undefined && !permitted.includes(key)) context.addIssue({ code: 'custom', path: [key], message: 'This filter is not available for the selected entity.' });
  }
});
export const reportSchema = z.strictObject({
  type: z.enum(['journal', 'ledger', 'trial-balance', 'cash-bank', 'debt']), from: calendarDateSchema, to: calendarDateSchema,
  accountId: uuid.optional(), partyId: uuid.optional(), cursor: z.string().min(1).max(2048).optional(),
}).refine((input) => input.from <= input.to, 'The report start must not be after its end.');

const coaTemplateId = z.enum(['vn-tt133-2016', 'vn-tt99-2025']);
const coaCode = z.string().regex(/^[0-9]{3,6}$/);
const coaCodes = z.array(coaCode).min(1).max(512).refine((codes) => new Set(codes).size === codes.length, 'Account codes must be unique.');
const coaSelectionFields = {
  templateId: coaTemplateId, templateVersion: z.string().min(1).max(32),
  selectedCodes: coaCodes.transform((codes) => [...codes].sort()),
};
export const coaTemplateSchema = z.strictObject({ templateId: coaTemplateId });
export const coaSelectionSchema = z.strictObject(coaSelectionFields);
export const coaImportSchema = z.strictObject({ ...coaSelectionFields, commandId: uuid });
const coaAccountRefSchema = z.strictObject({ code: coaCode, id: uuid, revision });
export const coaImportResultSchema = z.strictObject({
  commandId: uuid, templateId: coaTemplateId, templateVersion: z.string().min(1).max(32),
  selectedCodes: coaCodes,
  created: z.array(coaAccountRefSchema).max(512), existing: z.array(coaAccountRefSchema).max(512),
  completedAt: z.iso.datetime(),
}).superRefine((result, context) => {
  const refs = [...result.created, ...result.existing];
  const codes = new Set(refs.map((ref) => ref.code));
  const ids = new Set(refs.map((ref) => ref.id));
  const sorted = (values: string[]) => values.every((value, index) => index === 0 || values[index - 1]! < value);
  if (refs.length > 512 || codes.size !== refs.length || ids.size !== refs.length ||
      !sorted(result.selectedCodes) || !sorted(result.created.map((ref) => ref.code)) || !sorted(result.existing.map((ref) => ref.code)) ||
      result.selectedCodes.some((code) => !codes.has(code))) {
    context.addIssue({ code: 'custom', message: 'The immutable import receipt has inconsistent account references.' });
  }
});
