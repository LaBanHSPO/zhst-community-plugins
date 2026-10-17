import { z } from 'zod';
import { calendarDateSchema } from './validation.js';

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const text = (max: number) => z.string().trim().min(1).max(max);
const money = z.number().int().min(0).max(1_000_000_000_000);
const rate = z.number().int().min(0).max(10_000);
const year = z.number().int().min(2026).max(2100);
export const hkdQuantitySchema = z.string().max(26).regex(/^\d{1,13}(?:\.\d{1,6})?$/).transform((value) => {
  const [whole, fraction = ''] = value.split('.');
  const normalized = `${BigInt(whole!)}.${fraction.replace(/0+$/, '')}`;
  return normalized.endsWith('.') ? normalized.slice(0, -1) : normalized;
}).refine((value) => quantityUnits(value) <= 1_000_000_000_000_000_000n, 'Quantity must not exceed 1,000,000,000,000.');
export function quantityUnits(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}
export function quantityText(value: bigint): string {
  const negative = value < 0n; const absolute = negative ? -value : value;
  const fraction = String(absolute % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${absolute / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}
const configureBase = z.strictObject({
  commandId: uuid, year, startDate: calendarDateSchema, name: text(200), address: text(1000), taxCode: text(64),
  representative: text(200), location: text(200), taxMethod: z.enum(['exempt', 'revenue', 'income']),
  periodType: z.enum(['month', 'quarter', 'year']), incomeTaxRateBps: rate.nullable(), otherTaxes: z.boolean(),
});
function refinePolicy(value: { year: number; startDate: string; taxMethod: string; incomeTaxRateBps: number | null }, context: z.RefinementCtx): void {
  if (Number(value.startDate.slice(0, 4)) !== value.year) context.addIssue({ code: 'custom', path: ['startDate'], message: 'The start date must belong to the selected year.' });
  if ((value.taxMethod === 'income') !== (value.incomeTaxRateBps !== null)) context.addIssue({ code: 'custom', path: ['incomeTaxRateBps'], message: 'Choose an explicit income tax rate only for the income method.' });
}
export const hkdConfigureSchema = configureBase.superRefine(refinePolicy);
const base = { date: calendarDateSchema, documentDate: calendarDateSchema, documentNumber: text(200), description: text(2000) };
const revenue = z.strictObject({ ...base, kind: z.literal('revenue'), amountMinor: money.refine((n) => n > 0), businessLine: z.string().trim().max(200), vatRateBps: rate, pitRateBps: rate, vatTaxableMinor: money, pitTaxableMinor: money, incomeRevenueMinor: money }).superRefine((value, context) => {
  for (const key of ['vatTaxableMinor', 'pitTaxableMinor', 'incomeRevenueMinor'] as const) if (value[key] > value.amountMinor) context.addIssue({ code: 'custom', path: [key], message: 'The explicitly declared tax base cannot exceed the recorded revenue.' });
});
const expense = z.strictObject({ ...base, kind: z.literal('expense'), category: z.enum(['materials', 'labour', 'depreciation', 'services', 'interest', 'other']), amountMinor: money.refine((n) => n > 0), deductibleMinor: money }).refine((value) => value.deductibleMinor <= value.amountMinor, 'The certified deductible portion cannot exceed the expense.');
const stock = z.strictObject({ ...base, kind: z.literal('stock'), direction: z.enum(['opening', 'in', 'out']), itemCode: text(64), itemName: text(200), unit: text(32), quantity: hkdQuantitySchema, amountMinor: money.nullable() }).superRefine((value, context) => {
  const q = quantityUnits(value.quantity);
  if ((value.direction !== 'opening' && q === 0n) || (value.direction === 'out' ? value.amountMinor !== null : value.amountMinor === null) || (q === 0n && value.amountMinor !== 0)) context.addIssue({ code: 'custom', message: 'Opening may be zero with zero value; receipts need an amount, issues a positive quantity and no client cost.' });
});
const moneyEntry = z.strictObject({ ...base, kind: z.literal('money'), direction: z.enum(['opening', 'in', 'out']), fund: z.enum(['cash', 'bank']), bankName: text(200).nullable(), amountMinor: money }).superRefine((value, context) => {
  if ((value.fund === 'bank') !== (value.bankName !== null) || (value.direction !== 'opening' && value.amountMinor === 0)) context.addIssue({ code: 'custom', message: 'Name each bank/payment provider, leave cash bankName null, and record positive movements.' });
});
const tax = z.strictObject({ ...base, kind: z.literal('tax'), taxKind: z.enum(['export', 'import', 'excise', 'environment', 'resource', 'land']), quantity: hkdQuantitySchema.refine((q) => quantityUnits(q) > 0n), absoluteRateMinor: money, unitTaxPriceMinor: money, taxRateBps: z.number().int().min(0).max(1_000_000) }).superRefine((value, context) => {
  const percentage = value.unitTaxPriceMinor > 0 && value.taxRateBps > 0;
  const paired = (value.unitTaxPriceMinor === 0) === (value.taxRateBps === 0);
  const valid = value.taxKind === 'environment' ? value.absoluteRateMinor > 0 && value.unitTaxPriceMinor === 0 && value.taxRateBps === 0 : value.taxKind === 'resource' || value.taxKind === 'land' ? value.absoluteRateMinor === 0 && percentage : paired && (percentage || value.absoluteRateMinor > 0);
  if (!valid) context.addIssue({ code: 'custom', message: 'Supply only the applicable absolute and/or percentage operands for this tax.' });
});
export const hkdEntrySchema = z.discriminatedUnion('kind', [revenue, expense, stock, moneyEntry, tax]);
export const hkdPostSchema = z.strictObject({ commandId: uuid, year, installationId: uuid, revision: uuid, entry: hkdEntrySchema });
export const hkdVoidSchema = z.strictObject({ commandId: uuid, year, installationId: uuid, revision: uuid, id: uuid, reason: text(2000) });
export const hkdListSchema = z.strictObject({ year, cursor: z.string().min(1).max(4096).optional() });
export const hkdReportSchema = z.strictObject({ year, period: z.number().int().min(1).max(12), book: z.enum(['S1a-HKD', 'S2a-HKD', 'S2b-HKD', 'S2c-HKD', 'S2d-HKD', 'S2e-HKD', 'S3a-HKD']), cursor: z.string().min(1).max(4096).optional() });
export const hkdProfileSchema = configureBase.omit({ commandId: true }).extend({ installationId: uuid, revision: uuid, createdAt: z.iso.datetime(), createdBy: text(2048) }).superRefine(refinePolicy);
