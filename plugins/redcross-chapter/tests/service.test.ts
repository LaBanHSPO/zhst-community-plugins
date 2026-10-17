import assert from 'node:assert/strict';
import test from 'node:test';
import { ChapterService, type ChapterStorage } from '../src/service.js';
import { parseCsv, toCsv } from '../src/validation.js';

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

	async getVersioned(id: string) {
		const record = this.map.get(id);
		return record ? { value: record.value, revision: record.revision } : null;
	}

	async compareAndSet(id: string, expectedRevision: string | null, data: unknown) {
		const current = this.map.get(id);
		const currentRevision = current?.revision ?? null;
		if (expectedRevision !== currentRevision) return { applied: false as const };
		const revision = `r${++this.counter}`;
		this.map.set(id, { value: data, revision });
		return { applied: true as const, revision };
	}

	async query(options?: { where?: Where; limit?: number }) {
		const where = options?.where ?? {};
		const items = [...this.map.entries()]
			.filter(([, record]) => matches(record.value as Value, where))
			.map(([id, record]) => ({ id, data: record.value }));
		return { items, hasMore: false };
	}
}

function storage(): ChapterStorage {
	return {
		members: new MemoryCollection() as unknown as ChapterStorage['members'],
		fund: new MemoryCollection() as unknown as ChapterStorage['fund'],
		documents: new MemoryCollection() as unknown as ChapterStorage['documents'],
	};
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

	await service.approveFund({ id: income.id });
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
	await service.approveFund({ id: entry.id });
	const stale = await service.listFund({});
	const current = stale.items[0];
	assert.ok(current);
	await assert.rejects(
		() =>
			service.saveFund({
				id: current.id,
				revision: null,
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
