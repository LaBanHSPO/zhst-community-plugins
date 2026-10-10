import { z } from 'zod';
import { MAX_CONTACTS, MAX_LINES, MAX_PRICE_MINOR } from './model.js';

export class ErpError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ErpError'; }
}
const text = (max: number) => z.string().trim().max(max);
const requiredText = (max: number) => text(max).min(1);
const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const revision = z.string().min(1).max(2048);
const email = text(254).refine((value) => value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'Enter a valid email address or leave it empty.');
export const currencySchema = z.enum(['USD', 'EUR', 'GBP', 'VND', 'JPY']);
export const contactSchema = z.strictObject({ name: requiredText(200), email, phone: text(64) });
const identity = { id: uuid, revision: revision.nullable() };
export const customerSchema = z.strictObject({
  ...identity, code: requiredText(64), name: requiredText(200), email,
  phone: text(64), address: text(1000), contacts: z.array(contactSchema).max(MAX_CONTACTS), active: z.boolean(),
});
export const itemSchema = z.strictObject({
  ...identity, code: requiredText(64), name: requiredText(200), unit: requiredText(32),
  priceMinor: z.number().int().min(0).max(MAX_PRICE_MINOR), active: z.boolean(),
});
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, 'Enter a real calendar date (YYYY-MM-DD).');
export const quoteSchema = z.strictObject({
  ...identity, reference: text(200), customerId: uuid, contactIndex: z.number().int().min(0).max(MAX_CONTACTS - 1).optional(),
  lines: z.array(z.strictObject({ itemId: uuid, quantity: z.number().int().min(1).max(1_000_000) })).min(1).max(MAX_LINES),
  validUntil: date, notes: text(2000),
});
export const transitionSchema = z.strictObject({
  id: uuid, revision,
  action: z.enum(['submit', 'accept', 'convert', 'cancel-quote', 'fulfill-order', 'cancel-order']),
});
const entity = z.enum(['customers', 'items', 'quotes', 'orders']);
export const getSchema = z.strictObject({ entity, id: uuid });
export const listSchema = z.strictObject({
  entity, cursor: z.string().min(1).max(2048).optional(), search: text(200).optional(), active: z.boolean().optional(),
}).superRefine((input, ctx) => {
  if ((input.entity === 'quotes' || input.entity === 'orders') && (input.search !== undefined || input.active !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Search and active filters are only available for customers and items.' });
  }
});

const auditFields = {
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  createdBy: z.string().min(1), updatedBy: z.string().min(1),
};
const metadataFields = { schemaVersion: z.literal(1), ...auditFields };
export const settingsRecordSchema = z.strictObject({ ...metadataFields, currency: currencySchema });
export const customerRecordSchema = customerSchema.omit({ id: true, revision: true }).extend({ ...metadataFields, nameKey: z.string() });
export const itemRecordSchema = itemSchema.omit({ id: true, revision: true }).extend({ ...metadataFields, nameKey: z.string(), currency: currencySchema });
export const saleRecordSchema = z.strictObject({
  ...metadataFields,
  number: z.string().startsWith('Q-'), reference: text(200), currency: currencySchema,
  customer: z.strictObject({ id: uuid, name: requiredText(200), email, phone: text(64), address: text(1000), contact: contactSchema.optional() }),
  lines: z.array(z.strictObject({
    itemId: uuid, code: requiredText(64), name: requiredText(200), unit: requiredText(32),
    quantity: z.number().int().min(1).max(1_000_000),
    priceMinor: z.number().int().min(0).max(MAX_PRICE_MINOR), totalMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })).min(1).max(MAX_LINES),
  totalMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), validUntil: date, notes: text(2000),
  status: z.enum(['draft', 'submitted', 'accepted', 'converted', 'cancelled']), hasOrder: z.boolean(),
  order: z.strictObject({ id: uuid, number: z.string().startsWith('SO-'), status: z.enum(['open', 'fulfilled', 'cancelled']), ...auditFields }).nullable(),
  submittedAt: z.iso.datetime().optional(), acceptedAt: z.iso.datetime().optional(), cancelledAt: z.iso.datetime().optional(),
});

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new ErpError('INVALID_INPUT', `${field}${issue?.message ?? 'Invalid input.'}`);
  }
  return result.data;
}
export function checkedLineTotal(priceMinor: number, quantity: number): number {
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 0 || priceMinor > MAX_PRICE_MINOR ||
      !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
    throw new ErpError('INVALID_INPUT', 'Price or quantity is outside its supported integer range.');
  }
  if (priceMinor > 0 && quantity > Math.floor(Number.MAX_SAFE_INTEGER / priceMinor)) {
    throw new ErpError('MONEY_OVERFLOW', 'A line total exceeds the supported money range.');
  }
  return priceMinor * quantity;
}
export function checkedAdd(total: number, amount: number): number {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(amount) || total < 0 || amount < 0 || amount > Number.MAX_SAFE_INTEGER - total) {
    throw new ErpError('MONEY_OVERFLOW', 'The quotation total exceeds the supported money range.');
  }
  return total + amount;
}
