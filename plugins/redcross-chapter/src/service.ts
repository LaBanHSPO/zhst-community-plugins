import type { StorageCollection } from 'emdash';
import { z } from 'zod';
import type {
	ApprovalStatus,
	DocumentRecord,
	DocumentSaveInput,
	DocumentType,
	FundEntry,
	FundSaveInput,
	FundTotals,
	ImportMembersResult,
	Info,
	ListPage,
	Member,
	Metadata,
	PublicDocument,
	PublicFund,
	PublicFundEntry,
	RecordView,
	VersionedListPage,
} from './model.js';
import { MAX_EXPORT_ROWS, MAX_IMPORT_BATCH_ROWS, MAX_IMPORT_ROWS, PAGE_SIZE } from './model.js';
import {
	ChapterError,
	approvalStatusSchema,
	documentListSchema,
	documentRecordSchema,
	documentSaveSchema,
	fundApproveSchema,
	fundListSchema,
	fundRecordSchema,
	fundSaveSchema,
	importMembersSchema,
	listMembersSchema,
	memberRecordSchema,
	memberSchema,
	parse,
	parseCsv,
	toCsv,
} from './validation.js';

export type ChapterCollection = Pick<
	StorageCollection<unknown>,
	'getVersioned' | 'compareAndSet' | 'query'
>;
export interface ChapterStorage {
	members: ChapterCollection;
	fund: ChapterCollection;
	documents: ChapterCollection;
}

type WhereClause = NonNullable<NonNullable<Parameters<ChapterCollection['query']>[0]>['where']>;
type StoredItem = { id: string; data: unknown };

const memberSearchCursorSchema = z.strictObject({
	search: z.string(),
	status: z.enum(['active', 'paused']).optional(),
	phase: z.enum(['name', 'code']),
	cursor: z.string().min(1).max(2048).optional(),
	offset: z.number().int().min(0).max(PAGE_SIZE),
});

function checkedAmount(value: number): number {
	if (!Number.isSafeInteger(value)) {
		throw new ChapterError('AMOUNT_OVERFLOW', 'The fund aggregate exceeds the safe integer range. No rounded total can be displayed.');
	}
	return value;
}

const MEMBER_HEADERS = ['Mã HV', 'Họ tên', 'Năm sinh', 'Địa chỉ', 'SĐT', 'CCCD', 'Trạng thái'];
const CSV_ENCODING_HEADER = '__redcross_encoding';
const CSV_ENCODING = 'apostrophe-v1';
const MEMBER_ALIASES: Record<string, string> = {
	'mã hv': 'code',
	ma: 'code',
	code: 'code',
	'họ tên': 'fullName',
	hoten: 'fullName',
	name: 'fullName',
	fullname: 'fullName',
	'năm sinh': 'birthYear',
	namsinh: 'birthYear',
	birthyear: 'birthYear',
	'ngày sinh': 'birthYear',
	'địa chỉ': 'address',
	diachi: 'address',
	address: 'address',
	'sđt': 'phone',
	sdt: 'phone',
	phone: 'phone',
	'điện thoại': 'phone',
	cccd: 'cccd',
	'cmnd': 'cccd',
	'căn cước': 'cccd',
	'trạng thái': 'status',
	trangthai: 'status',
	status: 'status',
};

function versionedValue<T>(schema: z.ZodType<T>, value: unknown): T {
	if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1) {
		throw new ChapterError(
			'SCHEMA_VERSION',
			'This installation contains an unsupported record schema. A reviewed migration is required.',
		);
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new ChapterError(
			'INVALID_RECORD',
			'A saved record is malformed. Ask your administrator to review it before continuing.',
		);
	}
	return parsed.data;
}

function conflict(): never {
	throw new ChapterError(
		'CONFLICT',
		'This record changed or its ID already exists. Reload before saving; your unsaved form should be kept.',
	);
}

function normalizeKey(value: string): string {
	return value.normalize('NFKC').toLowerCase();
}

function parseBirthYear(cell: string): number | null {
	const value = cell.trim();
	if (value === '') return null;
	const year = Number(value);
	if (!Number.isInteger(year)) throw new ChapterError('INVALID_INPUT', 'Enter the birth year as a whole number or leave it empty.');
	return year;
}

function parseMemberStatus(cell: string): 'active' | 'paused' {
	const value = normalizeKey(cell.trim());
	if (value === '' || value === 'hoạt động' || value === 'active') return 'active';
	if (value === 'tạm nghỉ' || value === 'paused' || value === 'inactive') return 'paused';
	throw new ChapterError('INVALID_INPUT', 'Status must be "Hoạt động" or "Tạm nghỉ".');
}

export class ChapterService {
	constructor(
		private readonly storage: ChapterStorage,
		private readonly actorId: string,
		private readonly now: () => Date = () => new Date(),
	) {}

	private metadata(previous?: Metadata): Metadata {
		const timestamp = this.now().toISOString();
		return {
			schemaVersion: 1,
			createdAt: previous?.createdAt ?? timestamp,
			createdBy: previous?.createdBy ?? this.actorId,
			updatedAt: timestamp,
			updatedBy: this.actorId,
		};
	}

	private async queryAll(collection: ChapterCollection, where: WhereClause, allowTruncation = false): Promise<StoredItem[]> {
		const items: StoredItem[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 100; page += 1) {
			const result = await collection.query({ where, limit: 100, ...(cursor ? { cursor } : {}) });
			items.push(...result.items);
			if (!result.hasMore) return items;
			if (page === 99 && allowTruncation) return items;
			if (!result.cursor || result.cursor === cursor) {
				throw new ChapterError('QUERY_LIMIT', 'The storage query cannot continue safely. No partial total can be displayed.');
			}
			cursor = result.cursor;
		}
		throw new ChapterError('QUERY_LIMIT', 'This complete report exceeds the 10,000-record query limit. No partial total can be displayed.');
	}

	private async current<T>(
		collection: ChapterCollection,
		id: string,
		schema: z.ZodType<T>,
	): Promise<{ value: T; revision: string } | null> {
		const record = await collection.getVersioned(id);
		if (!record) return null;
		return { value: versionedValue(schema, record.value), revision: record.revision };
	}

	private checkRevision(expected: string | null, actual: string | null): void {
		if (expected !== actual) conflict();
	}

	private async save<T>(
		collection: ChapterCollection,
		id: string,
		revision: string | null,
		value: T,
	): Promise<RecordView<T>> {
		const result = await collection.compareAndSet(id, revision, value);
		if (!result.applied) conflict();
		return { id, revision: result.revision, value };
	}

	async info(): Promise<Info> {
		const approved = await this.approvedEntries();
		const categories = [...new Set(approved.map((entry) => entry.category))].sort((a, b) =>
			a.localeCompare(b),
		);
		return {
			version: '0.1.0',
			currency: 'VND',
			minorUnits: 0,
			pageSize: PAGE_SIZE,
			documentTypes: ['decision', 'resolution', 'circular', 'report', 'ledger'],
			fundCategories: categories.length ? categories : ['Cứu trợ', 'Hiến máu', 'Học bổng', 'Hành chính'],
		};
	}

	// --- Members -----------------------------------------------------------------

	async listMembers(input: unknown): Promise<ListPage<Member>> {
		const data = parse(listMembersSchema, input);
		const where: WhereClause = {};
		if (data.status) where.status = data.status;
		if (data.search) {
			const key = normalizeKey(data.search);
			let state: z.infer<typeof memberSearchCursorSchema> = {
				search: key, ...(data.status ? { status: data.status } : {}), phase: 'name', offset: 0,
			};
			if (data.cursor) {
				try {
					state = memberSearchCursorSchema.parse(JSON.parse(data.cursor));
				} catch {
					throw new ChapterError('INVALID_CURSOR', 'Reload member search from its first page.');
				}
				if (state.search !== key || state.status !== data.status) {
					throw new ChapterError('INVALID_CURSOR', 'This cursor belongs to a different member search.');
				}
			}
			const items: ListPage<Member>['items'] = [];
			// Scan name matches first, then code-only matches. The cursor retains a position
			// within a fixed-size storage page, so lookahead never loses a matching row.
			for (;;) {
				const page = await this.storage.members.query({
					where: { ...where, [state.phase === 'name' ? 'nameKey' : 'codeKey']: { startsWith: key } },
					limit: PAGE_SIZE,
					...(state.cursor ? { cursor: state.cursor } : {}),
				});
				for (let index = state.offset; index < page.items.length; index += 1) {
					const item = page.items[index]!;
					const value = versionedValue(memberRecordSchema, item.data);
					if (state.phase === 'code' && value.nameKey.startsWith(key)) continue;
					if (items.length === PAGE_SIZE) {
						return { items, hasMore: true, cursor: JSON.stringify({ ...state, offset: index }) };
					}
					items.push({ id: item.id, value });
				}
				if (page.hasMore) {
					if (!page.cursor || page.cursor === state.cursor) {
						throw new ChapterError('INVALID_CURSOR', 'The member search cannot continue safely. Reload the list.');
					}
					state = { ...state, cursor: page.cursor, offset: 0 };
				} else if (state.phase === 'name') {
					state = { search: key, ...(data.status ? { status: data.status } : {}), phase: 'code', offset: 0 };
				} else {
					return { items, hasMore: false };
				}
			}
		}
		const page = await this.storage.members.query({
			where, limit: PAGE_SIZE, ...(data.cursor ? { cursor: data.cursor } : {}),
		});
		return {
			items: page.items.map((item) => ({
				id: item.id,
				value: versionedValue(memberRecordSchema, item.data),
			})),
			...(page.cursor ? { cursor: page.cursor } : {}),
			hasMore: page.hasMore,
		};
	}

	async importMembers(input: unknown): Promise<ImportMembersResult> {
		const data = parse(importMembersSchema, input);
		const rows = parseCsv(data.csv);
		if (rows.length === 0) throw new ChapterError('INVALID_INPUT', 'The uploaded file is empty.');
		const rowCount = rows.length - 1;
		if (rowCount > MAX_IMPORT_ROWS) {
			throw new ChapterError('INVALID_INPUT', `CSV files must not exceed ${MAX_IMPORT_ROWS} data rows.`);
		}
		if (rowCount > MAX_IMPORT_BATCH_ROWS) {
			throw new ChapterError('INVALID_INPUT', `Import requests must not exceed ${MAX_IMPORT_BATCH_ROWS} data rows. Split the file into batches.`);
		}
		const header = rows[0]!.map((cell) => MEMBER_ALIASES[normalizeKey(cell.trim())] ?? cell.trim());
		const indexOf = (column: string) => header.indexOf(column);
		if (indexOf('code') === -1 || indexOf('fullName') === -1) {
			throw new ChapterError(
				'INVALID_INPUT',
				'The CSV must include a "Mã HV" (code) and "Họ tên" (fullName) column. Export an existing list to see the expected format.',
			);
		}
		let created = 0;
		let updated = 0;
		let skipped = 0;
		const errors: { line: number; message: string }[] = [];
		for (let i = 1; i < rows.length; i += 1) {
			const cells = rows[i]!;
			const line = i + 1;
			const cell = (column: string): string => {
				const position = indexOf(column);
				const value = position === -1 ? '' : (cells[position] ?? '');
				return indexOf(CSV_ENCODING_HEADER) !== -1 && cells[indexOf(CSV_ENCODING_HEADER)] === CSV_ENCODING && value.startsWith("'")
					? value.slice(1)
					: value;
			};
			try {
				const candidate = memberSchema.safeParse({
					code: cell('code'),
					fullName: cell('fullName'),
					birthYear: parseBirthYear(cell('birthYear')),
					address: cell('address'),
					phone: cell('phone'),
					cccd: cell('cccd'),
					status: parseMemberStatus(cell('status')),
				});
				if (!candidate.success) {
					errors.push({ line, message: candidate.error.issues[0]?.message ?? 'Invalid row.' });
					skipped += 1;
					continue;
				}
				const value = candidate.data;
				const codeKey = normalizeKey(value.code);
				const id = codeKey;
				const existing = await this.storage.members.getVersioned(id);
				const record: Member = {
					...value,
					...this.metadata(existing ? versionedValue(memberRecordSchema, existing.value) : undefined),
					nameKey: normalizeKey(value.fullName),
					codeKey,
					searchKey: `${codeKey}|${normalizeKey(value.fullName)}`,
				};
				if (!data.dryRun) {
					const result = await this.storage.members.compareAndSet(id, existing?.revision ?? null, record);
					if (!result.applied) conflict();
				}
				if (existing) updated += 1;
				else created += 1;
			} catch (error) {
				// Only row validation is recoverable; infrastructure, schema and write
				// conflicts must fail the batch so the caller keeps it available to retry.
				if (!(error instanceof ChapterError) || error.code !== 'INVALID_INPUT') throw error;
				errors.push({ line, message: error.message });
				skipped += 1;
			}
		}
		return { created, updated, skipped, errors };
	}

	async exportMembers(): Promise<{ filename: string; csv: string }> {
		const items = await this.queryAll(this.storage.members, {}, true);
		const members = items
			.map((item) => versionedValue(memberRecordSchema, item.data))
			.slice(0, MAX_EXPORT_ROWS);
		const rows: string[][] = [[...MEMBER_HEADERS, CSV_ENCODING_HEADER]];
		for (const member of members) {
			rows.push([
				member.code,
				member.fullName,
				member.birthYear === null ? '' : String(member.birthYear),
				member.address,
				member.phone,
				member.cccd,
				member.status === 'active' ? 'Hoạt động' : 'Tạm nghỉ',
				CSV_ENCODING,
			]);
		}
		const stamp = this.now().toISOString().slice(0, 10);
		return { filename: `hoi-vien-${stamp}.csv`, csv: toCsv(rows, { spreadsheetSafe: true }) };
	}

	// --- Fund --------------------------------------------------------------------

	private async approvedEntries(): Promise<(FundEntry & { id: string })[]> {
		const items = await this.queryAll(this.storage.fund, { status: 'approved' });
		return items.map((item) => ({
			id: item.id,
			...versionedValue(fundRecordSchema, item.data),
		}));
	}

	async fundTotals(): Promise<FundTotals> {
		const entries = await this.approvedEntries();
		let totalInMinor = 0;
		let totalOutMinor = 0;
		const monthly = Array.from({ length: 12 }, (_, index) => ({ month: index + 1, inMinor: 0, outMinor: 0 }));
		const categoryMap = new Map<string, number>();
		for (const entry of entries) {
			const amount = entry.approvedAmountMinor;
			const month = Number(entry.monthKey.slice(5, 7));
			const bucket = monthly[month - 1];
			if (entry.kind === 'in') {
				totalInMinor = checkedAmount(totalInMinor + amount);
				if (bucket) bucket.inMinor = checkedAmount(bucket.inMinor + amount);
			} else {
				totalOutMinor = checkedAmount(totalOutMinor + amount);
				if (bucket) bucket.outMinor = checkedAmount(bucket.outMinor + amount);
				categoryMap.set(entry.category, checkedAmount((categoryMap.get(entry.category) ?? 0) + amount));
			}
		}
		const pendingItems = await this.queryAll(this.storage.fund, { status: 'pending' });
		return {
			currency: 'VND',
			minorUnits: 0,
			totalInMinor,
			totalOutMinor,
			balanceMinor: checkedAmount(totalInMinor - totalOutMinor),
			pendingCount: pendingItems.length,
			monthly,
			byCategory: [...categoryMap.entries()]
				.map(([category, amountMinor]) => ({ category, amountMinor }))
				.sort((a, b) => b.amountMinor - a.amountMinor),
		};
	}

	async listFund(input: unknown): Promise<VersionedListPage<FundEntry>> {
		const data = parse(fundListSchema, input);
		const where: WhereClause = {};
		if (data.status) where.status = data.status;
		if (data.kind) where.kind = data.kind;
		if (data.category) where.category = data.category;
		if (data.year && data.month) where.monthKey = `${data.year}-${String(data.month).padStart(2, '0')}`;
		else if (data.year) where.monthKey = { startsWith: `${data.year}-` };
		const page = await this.storage.fund.query({
			where,
			orderBy: { date: 'desc' },
			limit: PAGE_SIZE,
			...(data.cursor ? { cursor: data.cursor } : {}),
		});
		return {
			items: await Promise.all(page.items.map(async (item) => {
				const record = await this.current(this.storage.fund, item.id, fundRecordSchema);
				if (!record) conflict();
				return { id: item.id, ...record };
			})),
			...(page.cursor ? { cursor: page.cursor } : {}),
			hasMore: page.hasMore,
		};
	}

	async saveFund(input: unknown): Promise<RecordView<FundEntry>> {
		const data = parse(fundSaveSchema, input);
		const current = await this.current(this.storage.fund, data.id, fundRecordSchema);
		this.checkRevision(data.revision, current?.revision ?? null);
		if (current && current.value.status !== 'pending') {
			throw new ChapterError('INVALID_TRANSITION', 'Only pending entries can be edited. An approved entry is locked.');
		}
		const value: FundEntry = {
			date: data.date,
			kind: data.kind,
			category: data.category,
			description: data.description,
			amountMinor: data.amountMinor,
			documentRef: data.documentRef,
			...this.metadata(current?.value),
			status: 'pending',
			monthKey: data.date.slice(0, 7),
			approvedAmountMinor: 0,
		};
		return this.save(this.storage.fund, data.id, data.revision, value);
	}

	async approveFund(input: unknown): Promise<RecordView<FundEntry>> {
		const data = parse(fundApproveSchema, input);
		const current = await this.current(this.storage.fund, data.id, fundRecordSchema);
		if (!current) throw new ChapterError('NOT_FOUND', 'The requested entry does not exist.');
		this.checkRevision(data.revision, current.revision);
		if (current.value.status !== 'pending') {
			throw new ChapterError('INVALID_TRANSITION', 'Only a pending entry can be approved.');
		}
		const timestamp = this.now().toISOString();
		const value: FundEntry = {
			...current.value,
			...this.metadata(current.value),
			status: 'approved',
			approvedAt: timestamp,
			approvedBy: this.actorId,
			approvedAmountMinor: current.value.amountMinor,
		};
		return this.save(this.storage.fund, data.id, data.revision, value);
	}

	async publicFund(): Promise<PublicFund> {
		const totals = await this.fundTotals();
		const page = await this.storage.fund.query({
			where: { status: 'approved' },
			orderBy: { date: 'desc' },
			limit: 12,
		});
		const recent: PublicFundEntry[] = page.items.map((item) => {
			const entry = versionedValue(fundRecordSchema, item.data);
			return {
				date: entry.date,
				kind: entry.kind,
				category: entry.category,
				description: entry.description,
				amountMinor: entry.approvedAmountMinor,
			};
		});
		return { totals, recent };
	}

	// --- Documents ---------------------------------------------------------------

	async listDocuments(input: unknown): Promise<VersionedListPage<DocumentRecord>> {
		const data = parse(documentListSchema, input);
		const where: WhereClause = {};
		if (data.type) where.type = data.type;
		if (data.year) where.date = { startsWith: `${data.year}-` };
		if (data.search) where.titleKey = { startsWith: normalizeKey(data.search) };
		const page = await this.storage.documents.query({
			where,
			orderBy: { date: 'desc' },
			limit: PAGE_SIZE,
			...(data.cursor ? { cursor: data.cursor } : {}),
		});
		return {
			items: await Promise.all(page.items.map(async (item) => {
				const record = await this.current(this.storage.documents, item.id, documentRecordSchema);
				if (!record) conflict();
				return { id: item.id, ...record };
			})),
			...(page.cursor ? { cursor: page.cursor } : {}),
			hasMore: page.hasMore,
		};
	}

	async saveDocument(input: unknown): Promise<RecordView<DocumentRecord>> {
		const data = parse(documentSaveSchema, input);
		const current = await this.current(this.storage.documents, data.id, documentRecordSchema);
		this.checkRevision(data.revision, current?.revision ?? null);
		const value: DocumentRecord = {
			number: data.number,
			title: data.title,
			type: data.type,
			date: data.date,
			signer: data.signer,
			fileUrl: data.fileUrl,
			fileName: data.fileName,
			isPublic: data.isPublic,
			...this.metadata(current?.value),
			titleKey: normalizeKey(data.title),
		};
		return this.save(this.storage.documents, data.id, data.revision, value);
	}

	async publicDocuments(): Promise<PublicDocument[]> {
		const items = await this.queryAll(this.storage.documents, { isPublic: true }, true);
		return items
			.map((item) => versionedValue(documentRecordSchema, item.data))
			.sort((a, b) => b.date.localeCompare(a.date))
			.slice(0, MAX_EXPORT_ROWS)
			.map((doc) => ({
				number: doc.number,
				title: doc.title,
				type: doc.type,
				date: doc.date,
				signer: doc.signer,
				fileUrl: doc.fileUrl,
				fileName: doc.fileName,
			}));
	}
}
