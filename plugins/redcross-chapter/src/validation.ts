import { z } from 'zod';
import { MAX_AMOUNT_MINOR } from './model.js';

export class ChapterError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'ChapterError';
	}
}

const text = (max: number) => z.string().trim().max(max);
const requiredText = (max: number) => text(max).min(1);
const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const revision = z.string().min(1).max(2048);
const date = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((value) => {
		const parsed = new Date(`${value}T00:00:00.000Z`);
		return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
	}, 'Enter a real calendar date (YYYY-MM-DD).');

export const memberStatusSchema = z.enum(['active', 'paused']);
export const fundKindSchema = z.enum(['in', 'out']);
export const approvalStatusSchema = z.enum(['pending', 'approved']);
export const documentTypeSchema = z.enum(['decision', 'resolution', 'circular', 'report', 'ledger']);

export const memberSchema = z.strictObject({
	code: requiredText(64),
	fullName: requiredText(200),
	birthYear: z.number().int().min(1900).max(2200).nullable(),
	address: text(1000),
	phone: text(32),
	cccd: text(32),
	status: memberStatusSchema,
});

export const listMembersSchema = z.strictObject({
	search: text(200).optional(),
	status: memberStatusSchema.optional(),
	cursor: z.string().min(1).max(2048).optional(),
});

export const importMembersSchema = z.strictObject({
	csv: z.string().min(1).max(4_000_000),
	dryRun: z.boolean().optional(),
});

export const fundSaveSchema = z.strictObject({
	id: uuid,
	revision: revision.nullable(),
	date,
	kind: fundKindSchema,
	category: requiredText(120),
	description: text(2000),
	amountMinor: z.number().int().min(1).max(MAX_AMOUNT_MINOR),
	documentRef: text(200),
});

export const fundListSchema = z.strictObject({
	year: z.number().int().min(1900).max(2200).optional(),
	month: z.number().int().min(1).max(12).optional(),
	kind: fundKindSchema.optional(),
	category: text(120).optional(),
	status: approvalStatusSchema.optional(),
	cursor: z.string().min(1).max(2048).optional(),
});

export const fundApproveSchema = z.strictObject({ id: uuid });

export const documentSaveSchema = z.strictObject({
	id: uuid,
	revision: revision.nullable(),
	number: requiredText(64),
	title: requiredText(300),
	type: documentTypeSchema,
	date,
	signer: text(200),
	fileUrl: text(2000),
	fileName: text(300),
	isPublic: z.boolean(),
});

export const documentListSchema = z.strictObject({
	search: text(200).optional(),
	type: documentTypeSchema.optional(),
	year: z.number().int().min(1900).max(2200).optional(),
	cursor: z.string().min(1).max(2048).optional(),
});

const auditFields = {
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	createdBy: z.string().min(1),
	updatedBy: z.string().min(1),
};
const metadataFields = { schemaVersion: z.literal(1), ...auditFields };

export const memberRecordSchema = memberSchema.extend({
	...metadataFields,
	nameKey: z.string(),
	codeKey: z.string(),
	searchKey: z.string(),
});

export const fundRecordSchema = z.strictObject({
	...metadataFields,
	date,
	kind: fundKindSchema,
	category: requiredText(120),
	description: text(2000),
	amountMinor: z.number().int().min(1).max(MAX_AMOUNT_MINOR),
	documentRef: text(200),
	status: approvalStatusSchema,
	approvedAt: z.iso.datetime().optional(),
	approvedBy: z.string().min(1).optional(),
	monthKey: z.string(),
	approvedAmountMinor: z.number().int().min(0).max(MAX_AMOUNT_MINOR),
});

export const documentRecordSchema = z.strictObject({
	...metadataFields,
	number: requiredText(64),
	title: requiredText(300),
	type: documentTypeSchema,
	date,
	signer: text(200),
	fileUrl: text(2000),
	fileName: text(300),
	isPublic: z.boolean(),
	titleKey: z.string(),
});

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(input);
	if (!result.success) {
		const issue = result.error.issues[0];
		const field = issue?.path.length ? `${issue.path.join('.')}: ` : '';
		throw new ChapterError('INVALID_INPUT', `${field}${issue?.message ?? 'Invalid input.'}`);
	}
	return result.data;
}

/**
 * Minimal RFC 4180-ish CSV reader: quoted fields, escaped quotes, CRLF,
 * and a leading UTF-8 BOM. Returns rows of cells without a header decision.
 */
export function parseCsv(input: string): string[][] {
	const text = input.replace(/^\uFEFF/, '');
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index += 2;
					continue;
				}
				quoted = false;
				index += 1;
				continue;
			}
			field += char;
			index += 1;
			continue;
		}
		if (char === '"' && field === '') {
			quoted = true;
			index += 1;
			continue;
		}
		if (char === ',') {
			row.push(field);
			field = '';
			index += 1;
			continue;
		}
		if (char === '\r' && text[index + 1] === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
			index += 2;
			continue;
		}
		if (char === '\n' || char === '\r') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
			index += 1;
			continue;
		}
		field += char;
		index += 1;
	}
	if (field !== '' || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

function csvCell(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: string[][]): string {
	return rows.map((row) => row.map((cell) => csvCell(cell)).join(',')).join('\r\n');
}
