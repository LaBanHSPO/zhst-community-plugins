import type { StorageCollection } from 'emdash';
import type { z } from 'zod';
import type {
	ApprovalStatus,
	DocumentRecord,
	DocumentSaveInput,
	DocumentType,
	FundEntry,
	FundSaveInput,
	FundTotals,
	Info,
	ListPage,
	Member,
	Metadata,
	PublicDocument,
	PublicFund,
	PublicFundEntry,
	RecordView,
} from './model.js';
import { MAX_EXPORT_ROWS, PAGE_SIZE } from './model.js';
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

const MEMBER_HEADERS = ['Mã HV', 'Họ tên', 'Năm sinh', 'Địa chỉ', 'SĐT', 'CCCD', 'Trạng thái'];
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
	if (!Number.isInteger(year)) throw new Error('Enter the birth year as a whole number or leave it empty.');
	return year;
}

function parseMemberStatus(cell: string): 'active' | 'paused' {
	const value = normalizeKey(cell.trim());
	if (value === '' || value === 'hoạt động' || value === 'active') return 'active';
	if (value === 'tạm nghỉ' || value === 'paused' || value === 'inactive') return 'paused';
	throw new Error('Status must be "Hoạt động" or "Tạm nghỉ".');
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

	private async queryAll(collection: ChapterCollection, where: WhereClause): Promise<StoredItem[]> {
		const items: StoredItem[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 100; page += 1) {
			const result = await collection.query({ where, limit: 100, ...(cursor ? { cursor } : {}) });
			items.push(...result.items);
			if (!result.hasMore || !result.cursor) break;
			cursor = result.cursor;
		}
		return items;
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
		if (expected !== null && expected !== actual) conflict();
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
		let items: StoredItem[];
		if (data.search) {
			const key = normalizeKey(data.search);
			const [byName, byCode] = await Promise.all([
				this.storage.members.query({
					where: { ...where, nameKey: { startsWith: key } },
					limit: 100,
				}),
				this.storage.members.query({
					where: { ...where, codeKey: { startsWith: key } },
					limit: 100,
				}),
			]);
			const merged = new Map<string, StoredItem>();
			for (const item of [...byName.items, ...byCode.items]) merged.set(item.id, item);
			items = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
			const start = 0;
			const page = items.slice(start, start + PAGE_SIZE);
			return {
				items: page.map((item) => ({ id: item.id, value: versionedValue(memberRecordSchema, item.data) })),
				hasMore: false,
			};
		}
		const page = await this.storage.members.query({ where, limit: PAGE_SIZE });
		return {
			items: page.items.map((item) => ({
				id: item.id,
				value: versionedValue(memberRecordSchema, item.data),
			})),
			...(page.cursor ? { cursor: page.cursor } : {}),
			hasMore: page.hasMore,
		};
	}

	async importMembers(input: unknown): Promise<{ created: number; updated: number; skipped: number; errors: { line: number; message: string }[] }> {
		const data = parse(importMembersSchema, input);
		const rows = parseCsv(data.csv);
		if (rows.length === 0) throw new ChapterError('INVALID_INPUT', 'The uploaded file is empty.');
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
				return position === -1 ? '' : (cells[position] ?? '');
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
				if (existing && !data.dryRun) versionedValue(memberRecordSchema, existing.value);
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
				errors.push({ line, message: error instanceof Error ? error.message : 'Invalid row.' });
				skipped += 1;
			}
		}
		return { created, updated, skipped, errors: errors.slice(0, 200) };
	}

	async exportMembers(): Promise<{ filename: string; csv: string }> {
		const items = await this.queryAll(this.storage.members, {});
		const members = items
			.map((item) => versionedValue(memberRecordSchema, item.data))
			.slice(0, MAX_EXPORT_ROWS);
		const rows: string[][] = [MEMBER_HEADERS];
		for (const member of members) {
			rows.push([
				member.code,
				member.fullName,
				member.birthYear === null ? '' : String(member.birthYear),
				member.address,
				member.phone,
				member.cccd,
				member.status === 'active' ? 'Hoạt động' : 'Tạm nghỉ',
			]);
		}
		const stamp = this.now().toISOString().slice(0, 10);
		return { filename: `hoi-vien-${stamp}.csv`, csv: toCsv(rows) };
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
				totalInMinor += amount;
				if (bucket) bucket.inMinor += amount;
			} else {
				totalOutMinor += amount;
				if (bucket) bucket.outMinor += amount;
				categoryMap.set(entry.category, (categoryMap.get(entry.category) ?? 0) + amount);
			}
		}
		const pendingItems = await this.queryAll(this.storage.fund, { status: 'pending' });
		return {
			currency: 'VND',
			minorUnits: 0,
			totalInMinor,
			totalOutMinor,
			balanceMinor: totalInMinor - totalOutMinor,
			pendingCount: pendingItems.length,
			monthly,
			byCategory: [...categoryMap.entries()]
				.map(([category, amountMinor]) => ({ category, amountMinor }))
				.sort((a, b) => b.amountMinor - a.amountMinor),
		};
	}

	async listFund(input: unknown): Promise<ListPage<FundEntry>> {
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
			items: page.items.map((item) => ({
				id: item.id,
				value: versionedValue(fundRecordSchema, item.data),
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
		return this.save(this.storage.fund, data.id, current?.revision ?? null, value);
	}

	async approveFund(input: unknown): Promise<RecordView<FundEntry>> {
		const data = parse(fundApproveSchema, input);
		const current = await this.current(this.storage.fund, data.id, fundRecordSchema);
		if (!current) throw new ChapterError('NOT_FOUND', 'The requested entry does not exist.');
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
		return this.save(this.storage.fund, data.id, current.revision, value);
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

	async listDocuments(input: unknown): Promise<ListPage<DocumentRecord>> {
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
			items: page.items.map((item) => ({
				id: item.id,
				value: versionedValue(documentRecordSchema, item.data),
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
		return this.save(this.storage.documents, data.id, current?.revision ?? null, value);
	}

	async publicDocuments(): Promise<PublicDocument[]> {
		const items = await this.queryAll(this.storage.documents, { isPublic: true });
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
