import assert from 'node:assert/strict';
import test from 'node:test';
import { ChapterService, type ChapterStorage } from '../src/service.js';
import { ChapterError, parseCsv, toCsv } from '../src/validation.js';
import {
	MAX_AMOUNT_MINOR, MAX_CSV_BYTES, MAX_IMPORT_BATCH_ROWS, MAX_IMPORT_ROWS,
	type DocumentSaveInput, type FundEntry, type FundSaveInput, type ListPage, type Member,
} from '../src/model.js';

type Value = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(value: Value, where: Where): boolean {
	for (const [key, expected] of Object.entries(where)) {
		const actual = value[key];
		if (expected && typeof expected === 'object' && 'startsWith' in expected) {
			if (typeof actual !== 'string' || !actual.startsWith(String((expected as { startsWith: unknown }).startsWith))) {
				return false;
			}
		} else if (actual !== expected) {
			return false;
		}
	}
	return true;
}

class MemoryCollection {
	private map = new Map<string, { value: unknown; revision: string }>();
	private counter = 0;
	reads = 0;
	writes = 0;
	afterQuery?: () => void;
	failWriteAt?: number;
	rejectWriteAt?: number;

	seed(id: string, value: unknown): string {
		const revision = `r${++this.counter}`;
		this.map.set(id, { value, revision });
		return revision;
	}

	async getVersioned(id: string) {
		this.reads += 1;
		const record = this.map.get(id);
		return record ? { value: record.value, revision: record.revision } : null;
	}

	async compareAndSet(id: string, expectedRevision: string | null, data: unknown) {
		this.writes += 1;
		if (this.writes === this.failWriteAt) throw new Error('Storage unavailable');
		if (this.writes === this.rejectWriteAt) return { applied: false as const };
		const current = this.map.get(id);
		const currentRevision = current?.revision ?? null;
		if (expectedRevision !== currentRevision) return { applied: false as const };
		const revision = this.seed(id, data);
		return { applied: true as const, revision };
	}

	async query(options?: { where?: Where; limit?: number; cursor?: string; orderBy?: Record<string, 'asc' | 'desc'> }) {
		const where = options?.where ?? {};
		const items = [...this.map.entries()]
			.filter(([, record]) => matches(record.value as Value, where))
			.map(([id, record]) => ({ id, data: record.value }))
			.sort((a, b) => {
				for (const [field, direction] of Object.entries(options?.orderBy ?? {})) {
					const compared = String((a.data as Value)[field]).localeCompare(String((b.data as Value)[field]));
					if (compared) return direction === 'desc' ? -compared : compared;
				}
				return a.id.localeCompare(b.id);
			});
		const offset = Number(options?.cursor ?? 0);
		assert.ok(Number.isSafeInteger(offset) && offset >= 0, 'Fixture requires a valid offset cursor');
		const limit = options?.limit ?? 100;
		const hasMore = offset + limit < items.length;
		const page = {
			items: items.slice(offset, offset + limit),
			hasMore,
			...(hasMore ? { cursor: String(offset + limit) } : {}),
		};
		this.afterQuery?.();
		return page;
	}
}

function storage() {
	const collections = {
		members: new MemoryCollection(),
		fund: new MemoryCollection(),
		documents: new MemoryCollection(),
	};
	// The fixture models the plugin's used storage surface, not the host's generic overloads.
	return collections as typeof collections & ChapterStorage;
}

const NOW = () => new Date('2026-03-18T00:00:00.000Z');

test('CSV parser handles quotes, CRLF and BOM', () => {
	const rows = parseCsv('\uFEFFMã HV,Họ tên\r\nHV-1,"Nguyễn, Văn ""A"""\r\nHV-2,Trần Thị B\r\n');
	assert.deepEqual(rows, [
		['Mã HV', 'Họ tên'],
		['HV-1', 'Nguyễn, Văn "A"'],
		['HV-2', 'Trần Thị B'],
	]);
	assert.equal(toCsv([['a,b', 'c']]), '"a,b",c');
});

test('member import upserts by code and export round-trips', async () => {
	const service = new ChapterService(storage(), 'admin-1', NOW);
	const csv = [
		'Mã HV,Họ tên,Năm sinh,Địa chỉ,SĐT,CCCD,Trạng thái',
		'HV-001,Nguyễn Thị Mai,1988,Bến Nghé,0901234567,001234567890,Hoạt động',
		'HV-002,Trần Văn Hùng,,Đa Kao,0912345678,,Tạm nghỉ',
	].join('\r\n');
	const first = await service.importMembers({ csv });
	assert.deepEqual(first, { created: 2, updated: 0, skipped: 0, errors: [] });

	const second = await service.importMembers({
		csv: 'Mã HV,Họ tên\nHV-001,Nguyễn Thị Mai (đổi tên)',
	});
	assert.equal(second.created, 0);
	assert.equal(second.updated, 1);

	const list = await service.listMembers({});
	assert.equal(list.items.length, 2);

	const exported = await service.exportMembers();
	assert.match(exported.filename, /^hoi-vien-2026-03-18\.csv$/);
	const reparsed = parseCsv(exported.csv);
	assert.equal(reparsed[0]?.[0], 'Mã HV');
	assert.equal(reparsed.length, 3);
});

test('member import reports invalid rows without aborting', async () => {
	const service = new ChapterService(storage(), 'admin-1', NOW);
	const result = await service.importMembers({
		csv: ['Mã HV,Họ tên,Năm sinh', 'HV-1,Hợp lệ,1990', ',Thiếu mã,1990', 'HV-3,Không hợp lệ,không-phải-số'].join('\n'),
	});
	assert.equal(result.created, 1);
	assert.equal(result.skipped, 2);
	assert.equal(result.errors.length, 2);
	assert.deepEqual(result.errors.map((error) => error.line), [3, 4]);
});

test('fund entries stay pending until approved and feed public totals', async () => {
	const service = new ChapterService(storage(), 'admin-1', NOW);
	const income = await service.saveFund({
		id: '11111111-1111-4111-8111-111111111111',
		revision: null,
		date: '2026-03-18',
		kind: 'in',
		category: 'Cứu trợ',
		description: 'Ủng hộ quỹ vùng lũ',
		amountMinor: 150_000_000,
		documentRef: '',
	});
	assert.equal(income.value.status, 'pending');

	const pendingPublic = await service.publicFund();
	assert.equal(pendingPublic.totals.totalInMinor, 0);
	assert.equal(pendingPublic.totals.pendingCount, 1);

	await service.approveFund({ id: income.id, revision: income.revision });
	const approvedPublic = await service.publicFund();
	assert.equal(approvedPublic.totals.totalInMinor, 150_000_000);
	assert.equal(approvedPublic.totals.balanceMinor, 150_000_000);
	assert.equal(approvedPublic.recent.length, 1);
});

test('approved entries are locked and cannot be edited again', async () => {
	const service = new ChapterService(storage(), 'admin-1', NOW);
	const entry = await service.saveFund({
		id: '22222222-2222-4222-8222-222222222222',
		revision: null,
		date: '2026-03-15',
		kind: 'out',
		category: 'Hiến máu',
		description: 'Chi phí chiến dịch',
		amountMinor: 12_500_000,
		documentRef: '',
	});
	await service.approveFund({ id: entry.id, revision: entry.revision });
	const stale = await service.listFund({});
	const current = stale.items[0];
	assert.ok(current);
	await assert.rejects(
		() =>
			service.saveFund({
				id: current.id,
				revision: current.revision,
				date: '2026-03-15',
				kind: 'out',
				category: 'Hiến máu',
				description: 'Sửa sau khi duyệt',
				amountMinor: 1,
				documentRef: '',
			}),
		/LOCKED|edited|Only pending/i,
	);
});

test('only public documents are exposed publicly', async () => {
	const service = new ChapterService(storage(), 'admin-1', NOW);
	await service.saveDocument({
		id: '33333333-3333-4333-8333-333333333333',
		revision: null,
		number: '45/QĐ-CTĐV',
		title: 'Kế hoạch cứu trợ thiên tai 2026',
		type: 'decision',
		date: '2026-03-12',
		signer: 'Phạm Tuấn Vũ',
		fileUrl: '/_emdash/api/media/file/qd45.pdf',
		fileName: 'qd45.pdf',
		isPublic: true,
	});
	await service.saveDocument({
		id: '44444444-4444-4444-8444-444444444444',
		revision: null,
		number: '08/BC-CTĐV',
		title: 'Báo cáo nội bộ',
		type: 'report',
		date: '2026-04-05',
		signer: 'Hoàng Văn Quân',
		fileUrl: '',
		fileName: '',
		isPublic: false,
	});
	const publicDocs = await service.publicDocuments();
	assert.equal(publicDocs.length, 1);
	assert.equal(publicDocs[0]?.number, '45/QĐ-CTĐV');
});

const FUND_INPUT: FundSaveInput = {
	id: '55555555-5555-4555-8555-555555555555',
	revision: null,
	date: '2026-03-18',
	kind: 'in',
	category: 'Cứu trợ',
	description: 'Reviewed entry',
	amountMinor: 100,
	documentRef: '',
};

const DOCUMENT_INPUT: DocumentSaveInput = {
	id: '66666666-6666-4666-8666-666666666666',
	revision: null,
	number: '01/QĐ',
	title: 'Reviewed document',
	type: 'decision',
	date: '2026-03-18',
	signer: 'Administrator',
	fileUrl: '/_emdash/api/media/file/reviewed.pdf',
	fileName: 'reviewed.pdf',
	isPublic: true,
};

function approvedEntry(amountMinor: number, kind: 'in' | 'out' = 'in'): FundEntry {
	return {
		schemaVersion: 1,
		createdAt: NOW().toISOString(),
		updatedAt: NOW().toISOString(),
		createdBy: 'admin-1',
		updatedBy: 'admin-1',
		date: '2026-03-18',
		kind,
		category: 'Cứu trợ',
		description: 'Approved',
		amountMinor,
		documentRef: '',
		status: 'approved',
		approvedAt: NOW().toISOString(),
		approvedBy: 'admin-1',
		monthKey: '2026-03',
		approvedAmountMinor: amountMinor,
	};
}

test('stale document saves cannot overwrite or republish a private document', async () => {
	const service = new ChapterService(storage(), 'admin-1', NOW);
	const created = await service.saveDocument(DOCUMENT_INPUT);
	const displayed = (await service.listDocuments({})).items[0]!;
	assert.equal(displayed.revision, created.revision);
	const privateDocument = await service.saveDocument({
		...DOCUMENT_INPUT, revision: displayed.revision, isPublic: false,
	});
	for (const revision of [null, displayed.revision]) {
		await assert.rejects(
			() => service.saveDocument({ ...DOCUMENT_INPUT, revision }),
			(error: unknown) => error instanceof ChapterError && error.code === 'CONFLICT',
		);
	}
	assert.deepEqual(await service.publicDocuments(), []);
	const latest = (await service.listDocuments({})).items[0]!;
	assert.equal(latest.value.isPublic, false);
	assert.equal(latest.revision, privateDocument.revision);
	await service.saveDocument({ ...DOCUMENT_INPUT, revision: latest.revision, isPublic: false, title: 'Current edit' });
	assert.equal((await service.listDocuments({})).items[0]?.value.title, 'Current edit');
});

test('approval requires the exact displayed fund revision and null fund saves are create-only', async () => {
	const service = new ChapterService(storage(), 'admin-1', NOW);
	await service.saveFund(FUND_INPUT);
	const displayed = (await service.listFund({})).items[0]!;
	const changed = await service.saveFund({
		...FUND_INPUT, revision: displayed.revision, amountMinor: 900,
	});
	await assert.rejects(
		() => service.saveFund(FUND_INPUT),
		(error: unknown) => error instanceof ChapterError && error.code === 'CONFLICT',
	);
	await assert.rejects(
		() => service.approveFund({ id: displayed.id }),
		(error: unknown) => error instanceof ChapterError && error.code === 'INVALID_INPUT',
	);
	await assert.rejects(
		() => service.approveFund({ id: displayed.id, revision: displayed.revision }),
		(error: unknown) => error instanceof ChapterError && error.code === 'CONFLICT',
	);
	const pending = await service.publicFund();
	assert.equal(pending.totals.pendingCount, 1);
	assert.equal(pending.totals.totalInMinor, 0);
	assert.deepEqual(pending.recent, []);
	await service.approveFund({ id: changed.id, revision: changed.revision });
	assert.equal((await service.publicFund()).totals.totalInMinor, 900);
});

test('fund and document lists pair values and revisions from the same versioned read', async () => {
	const collections = storage();
	const service = new ChapterService(collections, 'admin-1', NOW);
	const fund = await service.saveFund(FUND_INPUT);
	let fundRevision = '';
	collections.fund.afterQuery = () => {
		collections.fund.afterQuery = undefined;
		fundRevision = collections.fund.seed(fund.id, { ...fund.value, amountMinor: 777 });
	};
	const displayedFund = (await service.listFund({})).items[0]!;
	assert.equal(displayedFund.revision, fundRevision);
	assert.equal(displayedFund.value.amountMinor, 777);

	const document = await service.saveDocument(DOCUMENT_INPUT);
	let documentRevision = '';
	collections.documents.afterQuery = () => {
		collections.documents.afterQuery = undefined;
		documentRevision = collections.documents.seed(document.id, { ...document.value, title: 'New title', isPublic: false });
	};
	const displayedDocument = (await service.listDocuments({})).items[0]!;
	assert.equal(displayedDocument.revision, documentRevision);
	assert.equal(displayedDocument.value.title, 'New title');
	assert.equal(displayedDocument.value.isPublic, false);
});

test('oversized import batches and files are rejected before reads or writes', async () => {
	const collections = storage();
	const service = new ChapterService(collections, 'admin-1', NOW);
	for (const count of [MAX_IMPORT_BATCH_ROWS + 1, MAX_IMPORT_ROWS + 1]) {
		const csv = toCsv([['code', 'fullName'], ...Array.from({ length: count }, (_, i) => [`HV-${i}`, `Member ${i}`])]);
		await assert.rejects(
			() => service.importMembers({ csv }),
			(error: unknown) => error instanceof ChapterError && error.code === 'INVALID_INPUT',
		);
	}
	const csv = `code,fullName\nHV-1,${'漢'.repeat(Math.floor(MAX_CSV_BYTES / 3) + 1)}`;
	await assert.rejects(
		() => service.importMembers({ csv }),
		(error: unknown) => error instanceof ChapterError && error.code === 'INVALID_INPUT',
	);
	assert.equal(collections.members.reads, 0);
	assert.equal(collections.members.writes, 0);
	const accepted = await service.importMembers({
		csv: toCsv([['code', 'fullName'], ...Array.from({ length: MAX_IMPORT_BATCH_ROWS }, (_, i) => [`HV-${i}`, `Member ${i}`])]),
	});
	assert.equal(accepted.created, MAX_IMPORT_BATCH_ROWS);
});

test('import fails on infrastructure errors instead of reporting a harmless skipped row', async () => {
	const collections = storage();
	collections.members.failWriteAt = 2;
	const service = new ChapterService(collections, 'admin-1', NOW);
	await assert.rejects(
		() => service.importMembers({ csv: 'code,fullName\nHV-1,First\nHV-2,Second\nHV-3,Third' }),
		/Storage unavailable/,
	);
	assert.equal(collections.members.writes, 2);
	assert.deepEqual((await service.listMembers({})).items.map((item) => item.id), ['hv-1']);
	collections.members.failWriteAt = undefined;
	const retry = await service.importMembers({ csv: 'code,fullName\nHV-1,First\nHV-2,Second\nHV-3,Third' });
	assert.deepEqual(retry, { created: 2, updated: 1, skipped: 0, errors: [] });
});

test('import fails on write conflicts and unsupported saved schemas', async () => {
	const collections = storage();
	const service = new ChapterService(collections, 'admin-1', NOW);
	collections.members.rejectWriteAt = 1;
	await assert.rejects(
		() => service.importMembers({ csv: 'code,fullName\nHV-1,First' }),
		(error: unknown) => error instanceof ChapterError && error.code === 'CONFLICT',
	);
	collections.members.seed('hv-1', { schemaVersion: 2 });
	await assert.rejects(
		() => service.importMembers({ csv: 'code,fullName\nHV-1,First' }),
		(error: unknown) => error instanceof ChapterError && error.code === 'SCHEMA_VERSION',
	);
});

test('member pages forward cursors and search reaches all name/code matches without duplicates', async () => {
	const collections = storage();
	const service = new ChapterService(collections, 'admin-1', NOW);
	const rows = Array.from({ length: 180 }, (_, index) => [
		index < 130 ? `MATCH-${String(index).padStart(3, '0')}` : `OTHER-${index}`,
		index < 150 ? `MATCH person ${index}` : `Other person ${index}`,
		index % 2 === 0 ? 'active' : 'paused',
	]);
	for (let start = 0; start < rows.length; start += MAX_IMPORT_BATCH_ROWS) {
		await service.importMembers({ csv: toCsv([['code', 'fullName', 'status'], ...rows.slice(start, start + MAX_IMPORT_BATCH_ROWS)]) });
	}
	const collect = async (input: { search?: string; status?: 'active' | 'paused' }): Promise<string[]> => {
		const ids: string[] = [];
		let cursor: string | undefined;
		let page: ListPage<Member>;
		do {
			page = await service.listMembers({ ...input, ...(cursor ? { cursor } : {}) });
			assert.ok(page.items.length > 0);
			assert.ok(page.items.length <= 25);
			ids.push(...page.items.map((item) => item.id));
			if (page.hasMore) assert.ok(page.cursor && page.cursor !== cursor);
			cursor = page.cursor;
			assert.ok(ids.length <= rows.length, 'Pagination must not repeat the first page');
		} while (page.hasMore);
		assert.equal(new Set(ids).size, ids.length, 'Search must deduplicate name/code overlap');
		return ids;
	};
	assert.equal((await collect({})).length, 180);
	// Add code-only matches after the overlapping name/code matches.
	await service.importMembers({ csv: 'code,fullName,status\nMATCH-code-only,Another person,active' });
	const searched = await collect({ search: 'MATCH' });
	assert.equal(searched.length, 151);
	assert.ok(searched.includes('match-code-only'));
	assert.equal((await collect({ search: 'MATCH', status: 'active' })).length, 76);
	await assert.rejects(
		() => service.listMembers({ search: 'MATCH', cursor: 'not-json' }),
		(error: unknown) => error instanceof ChapterError && error.code === 'INVALID_CURSOR',
	);
	const first = await service.listMembers({ search: 'MATCH' });
	await assert.rejects(
		() => service.listMembers({ search: 'Other', cursor: first.cursor }),
		(error: unknown) => error instanceof ChapterError && error.code === 'INVALID_CURSOR',
	);
});

test('fund totals preserve exact safe integers and reject incoming or outgoing overflow', async () => {
	for (const kind of ['in', 'out'] as const) {
		const collections = storage();
		const service = new ChapterService(collections, 'admin-1', NOW);
		for (let index = 0; index < 9; index += 1) {
			collections.fund.seed(`entry-${index}`, approvedEntry(MAX_AMOUNT_MINOR, kind));
		}
		const remainder = Number.MAX_SAFE_INTEGER - 9 * MAX_AMOUNT_MINOR;
		collections.fund.seed('remainder', approvedEntry(remainder, kind));
		const totals = await service.fundTotals();
		if (kind === 'in') {
			assert.equal(totals.totalInMinor, Number.MAX_SAFE_INTEGER);
			assert.equal(totals.balanceMinor, Number.MAX_SAFE_INTEGER);
			assert.equal(totals.monthly[2]?.inMinor, Number.MAX_SAFE_INTEGER);
		} else {
			assert.equal(totals.totalOutMinor, Number.MAX_SAFE_INTEGER);
			assert.equal(totals.balanceMinor, -Number.MAX_SAFE_INTEGER);
			assert.equal(totals.monthly[2]?.outMinor, Number.MAX_SAFE_INTEGER);
			assert.equal(totals.byCategory[0]?.amountMinor, Number.MAX_SAFE_INTEGER);
		}
		collections.fund.seed('overflow', approvedEntry(1, kind));
		for (const action of [() => service.fundTotals(), () => service.publicFund()]) {
			await assert.rejects(action, (error: unknown) => error instanceof ChapterError && error.code === 'AMOUNT_OVERFLOW');
		}
	}
});

test('complete financial reports fail explicitly when approved or pending records exceed the query cap', async () => {
	for (const status of ['approved', 'pending'] as const) {
		const collections = storage();
		const service = new ChapterService(collections, 'admin-1', NOW);
		const entry = { ...approvedEntry(1), status, approvedAmountMinor: status === 'approved' ? 1 : 0 };
		for (let index = 0; index < 10_000; index += 1) collections.fund.seed(`entry-${index}`, entry);
		const totals = await service.fundTotals();
		assert.equal(totals.totalInMinor, status === 'approved' ? 10_000 : 0);
		assert.equal(totals.pendingCount, status === 'pending' ? 10_000 : 0);
		collections.fund.seed('one-too-many', entry);
		for (const action of [() => service.fundTotals(), () => service.publicFund()]) {
			await assert.rejects(action, (error: unknown) => error instanceof ChapterError && error.code === 'QUERY_LIMIT');
		}
	}
});

test('spreadsheet-safe CSV protects formula/control prefixes without changing raw batching', async () => {
	const cells = ['=1+1', '+SUM(A1)', '-1+1', '@SUM(A1)', '\t=1+1', '\r\n=1+1', ' \u0000\u0085=1+1', 'Normal text', '0901234567'];
	assert.deepEqual(parseCsv(toCsv([cells])), [cells]);
	assert.deepEqual(
		parseCsv(toCsv([cells], { spreadsheetSafe: true })),
		[cells.map((cell, index) => index < 7 ? `'${cell}` : cell)],
	);
	const service = new ChapterService(storage(), 'admin-1', NOW);
	await service.importMembers({ csv: toCsv([['code', 'fullName', 'address'], ['HV-1', '=1+1', '@SUM(A1)']]) });
	const exported = parseCsv((await service.exportMembers()).csv);
	assert.equal(exported[1]?.[1], "'=1+1");
	assert.equal(exported[1]?.[3], "'@SUM(A1)");
	// Safe serialization is only at export, not a mutation of registry data.
	assert.equal((await service.listMembers({})).items[0]?.value.fullName, '=1+1');
});

test('spreadsheet-safe member export reimports without changing identity or literal apostrophes', async () => {
	const service = new ChapterService(storage(), 'admin-1', NOW);
	const records = [
		['+HV-1', '=Literal name', '+84901234567'],
		["'HV-2", "'=Literal apostrophe", "'+84901234568"],
	];
	await service.importMembers({ csv: toCsv([['code', 'fullName', 'phone'], ...records]) });
	const before = (await service.listMembers({})).items;
	const exported = await service.exportMembers();
	const imported = await service.importMembers({ csv: exported.csv });
	assert.deepEqual(imported, { created: 0, updated: 2, skipped: 0, errors: [] });
	assert.deepEqual((await service.listMembers({})).items, before);
});
