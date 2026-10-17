import { useEffect, useRef, useState } from 'react';
import type { PluginAdminExports } from 'emdash';
import type {
	DocumentRecord,
	DocumentType,
	FundEntry,
	FundTotals,
	Info,
	ListPage,
	Member,
	MemberStatus,
	RecordView,
} from '../model.js';
import {
	downloadCsv,
	formatDate,
	money,
	parseAmount,
	request,
} from './api.js';
import { Failure, Field, Pager, useDebounced, useMutation } from './shared.js';
import './styles.css';

type Tab = 'members' | 'fund' | 'documents';

const MEMBER_STATUS: Record<MemberStatus, string> = { active: 'Hoạt động', paused: 'Tạm nghỉ' };
const DOC_TYPES: { value: DocumentType; label: string }[] = [
	{ value: 'decision', label: 'Quyết định' },
	{ value: 'resolution', label: 'Nghị quyết' },
	{ value: 'circular', label: 'Công văn' },
	{ value: 'report', label: 'Báo cáo' },
	{ value: 'ledger', label: 'Hồ sơ thu chi' },
];
const DOC_TYPE_LABEL: Record<DocumentType, string> = Object.fromEntries(
	DOC_TYPES.map((entry) => [entry.value, entry.label]),
) as Record<DocumentType, string>;

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

// --- Members -------------------------------------------------------------------

function MembersSection() {
	const [search, setSearch] = useState('');
	const debouncedSearch = useDebounced(search);
	const [status, setStatus] = useState<'all' | MemberStatus>('all');
	const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
	const [pageIndex, setPageIndex] = useState(0);
	const [page, setPage] = useState<ListPage<Member>>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<unknown>(null);
	const [notice, setNotice] = useState('');
	const [retry, setRetry] = useState(0);
	const importInput = useRef<HTMLInputElement>(null);
	const mutation = useMutation();
	const cursor = cursors[pageIndex];

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		setPage(undefined);
		request<ListPage<Member>>(
			'members-list',
			{ search: debouncedSearch || undefined, status: status === 'all' ? undefined : status, cursor },
			controller.signal,
		).then(
			(value) => {
				setPage(value);
				setLoading(false);
			},
			(cause: unknown) => {
				if (!controller.signal.aborted) {
					setError(cause);
					setLoading(false);
				}
			},
		);
		return () => controller.abort();
	}, [debouncedSearch, status, cursor, retry]);

	async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		event.target.value = '';
		if (!file) return;
		const csv = await file.text();
		await mutation.run(
			() =>
				request<{ created: number; updated: number; skipped: number; errors: { line: number; message: string }[] }>(
					'members-import',
					{ csv },
				),
			(result) => {
				setNotice(
					`Đã nhập: ${result.created} mới, ${result.updated} cập nhật, ${result.skipped} bỏ qua${
						result.errors.length ? ` · ${result.errors.length} dòng lỗi` : ''
					}.`,
				);
				setRetry((value) => value + 1);
			},
		);
	}

	async function onExport() {
		await mutation.run(
			() => request<{ filename: string; csv: string }>('members-export'),
			(result) => downloadCsv(result.filename, result.csv),
		);
	}

	const items = page?.items ?? [];

	return (
		<section className="rc-section" aria-label="Hội viên">
			<div className="rc-section-head">
				<div>
					<h2>Quản lý hội viên</h2>
					<p className="rc-muted">
						Danh sách hội viên chỉ đọc. Cập nhật hàng loạt bằng cách nhập tệp CSV (khớp theo Mã HV).
					</p>
				</div>
				<div className="rc-actions">
					<button type="button" onClick={() => importInput.current?.click()} disabled={mutation.pending}>
						Nhập CSV
					</button>
					<button type="button" onClick={onExport} disabled={mutation.pending}>
						Xuất CSV
					</button>
					<input
						ref={importInput}
						type="file"
						accept=".csv,text/csv"
						hidden
						onChange={onFile}
					/>
				</div>
			</div>
			{notice && (
				<p className="rc-notice" role="status">
					{notice}
				</p>
			)}
			<Failure error={mutation.error} />
			<div className="rc-toolbar">
				<label className="rc-search">
					<span>Tìm theo tên / mã HV / SĐT</span>
					<input
						type="search"
						value={search}
						maxLength={200}
						placeholder="Nhập từ khoá…"
						onChange={(event) => {
							setSearch(event.target.value);
							setPageIndex(0);
							setCursors([undefined]);
						}}
					/>
				</label>
				<label className="rc-field rc-inline">
					<span>Trạng thái</span>
					<select
						value={status}
						onChange={(event) => {
							setStatus(event.target.value as 'all' | MemberStatus);
							setPageIndex(0);
							setCursors([undefined]);
						}}
					>
						<option value="all">Tất cả</option>
						<option value="active">Đang hoạt động</option>
						<option value="paused">Tạm nghỉ</option>
					</select>
				</label>
				<span className="rc-muted rc-note">CCCD/SĐT chỉ hiển thị cho quản trị viên.</span>
			</div>
			<Failure error={error} retry={() => setRetry((value) => value + 1)} />
			{loading && <p role="status">Đang tải danh sách hội viên…</p>}
			{!loading && !error && (
				<div className="rc-table-scroll" role="region" aria-label="Bảng hội viên" tabIndex={0}>
					<table>
						<thead>
							<tr>
								<th scope="col">Mã HV</th>
								<th scope="col">Họ tên</th>
								<th scope="col">Năm sinh</th>
								<th scope="col">Địa chỉ</th>
								<th scope="col">SĐT</th>
								<th scope="col">CCCD</th>
								<th scope="col">Trạng thái</th>
							</tr>
						</thead>
						<tbody>
							{items.map(({ id, value }) => (
								<tr key={id}>
									<td className="rc-mono">{value.code}</td>
									<td>{value.fullName}</td>
									<td>{value.birthYear ?? '—'}</td>
									<td>{value.address || '—'}</td>
									<td className="rc-mono">{value.phone || '—'}</td>
									<td className="rc-mono">{value.cccd || '—'}</td>
									<td>
										<span className={`rc-badge ${value.status}`}>{MEMBER_STATUS[value.status]}</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{items.length === 0 && <p className="rc-empty">Không có hội viên phù hợp. Xoá bộ lọc hoặc nhập tệp CSV.</p>}
				</div>
			)}
			<Pager
				pageIndex={pageIndex}
				hasMore={page?.hasMore ?? false}
				loading={loading}
				shown={items.length}
				onPrev={() => setPageIndex((index) => Math.max(0, index - 1))}
				onNext={() => {
					if (!page?.cursor) return;
					setCursors((values) => [...values.slice(0, pageIndex + 1), page.cursor]);
					setPageIndex((index) => index + 1);
				}}
			/>
		</section>
	);
}

// --- Fund ----------------------------------------------------------------------

function FundSection({ info }: { info?: Info }) {
	const [year, setYear] = useState(new Date().getFullYear());
	const [month, setMonth] = useState(0);
	const [kind, setKind] = useState<'all' | 'in' | 'out'>('all');
	const [category, setCategory] = useState('');
	const [status, setStatus] = useState<'all' | 'pending' | 'approved'>('all');
	const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
	const [pageIndex, setPageIndex] = useState(0);
	const [page, setPage] = useState<ListPage<FundEntry>>();
	const [totals, setTotals] = useState<FundTotals>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<unknown>(null);
	const [draft, setDraft] = useState<{ kind: 'in' | 'out'; date: string; category: string; description: string; amount: string; documentRef: string }>();
	const [retry, setRetry] = useState(0);
	const mutation = useMutation();
	const cursor = cursors[pageIndex];

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		request<ListPage<FundEntry>>(
			'fund-list',
			{
				year,
				month: month || undefined,
				kind: kind === 'all' ? undefined : kind,
				category: category || undefined,
				status: status === 'all' ? undefined : status,
				cursor,
			},
			controller.signal,
		).then(
			(value) => {
				setPage(value);
				setLoading(false);
			},
			(cause: unknown) => {
				if (!controller.signal.aborted) {
					setError(cause);
					setLoading(false);
				}
			},
		);
		return () => controller.abort();
	}, [year, month, kind, category, status, cursor, retry]);

	useEffect(() => {
		const controller = new AbortController();
		request<FundTotals>('fund-totals', undefined, controller.signal).then(setTotals, () => undefined);
		return () => controller.abort();
	}, [retry]);

	function save(kindValue: 'in' | 'out') {
		setDraft({ kind: kindValue, date: today(), category: '', description: '', amount: '', documentRef: '' });
	}

	async function submitDraft() {
		if (!draft) return;
		let amountMinor: number;
		try {
			amountMinor = parseAmount(draft.amount);
		} catch (cause) {
			mutation.setError(cause);
			return;
		}
		await mutation.run(
			() =>
				request<RecordView<FundEntry>>('fund-save', {
					id: crypto.randomUUID(),
					revision: null,
					date: draft.date,
					kind: draft.kind,
					category: draft.category,
					description: draft.description,
					amountMinor,
					documentRef: draft.documentRef,
				}),
			() => {
				setDraft(undefined);
				setRetry((value) => value + 1);
			},
		);
	}

	const items = page?.items ?? [];
	const maxMinor = Math.max(1, ...(totals?.monthly.map((m) => Math.max(m.inMinor, m.outMinor)) ?? [1]));

	return (
		<section className="rc-section" aria-label="Quỹ">
			<div className="rc-section-head">
				<div>
					<h2>Quản lý quỹ (Thu – Chi)</h2>
					<p className="rc-muted">Mọi khoản thu/chi vào ở trạng thái chờ duyệt và chỉ được tính vào báo cáo sau khi duyệt.</p>
				</div>
				<div className="rc-actions">
					<button type="button" onClick={() => save('in')} disabled={mutation.pending}>
						+ Ghi thu
					</button>
					<button type="button" className="rc-primary" onClick={() => save('out')} disabled={mutation.pending}>
						+ Ghi chi
					</button>
				</div>
			</div>
			<Failure error={mutation.error} />
			{totals && (
				<>
					<div className="rc-kpis">
						<div className="rc-kpi">
							<span>Số dư hiện tại</span>
							<b>{money(totals.balanceMinor)}</b>
						</div>
						<div className="rc-kpi">
							<span>Tổng thu</span>
							<b className="g">{money(totals.totalInMinor)}</b>
						</div>
						<div className="rc-kpi">
							<span>Tổng chi</span>
							<b className="r">{money(totals.totalOutMinor)}</b>
						</div>
						<div className="rc-kpi">
							<span>Chờ duyệt</span>
							<b className="t">{totals.pendingCount}</b>
						</div>
					</div>
					<div className="rc-bars" aria-label="Thu chi theo tháng">
						{totals.monthly.map((bucket) => (
							<div className="rc-bar-col" key={bucket.month}>
								<div className="rc-bar-pair">
									<i className="in" style={{ height: `${(bucket.inMinor / maxMinor) * 100}%` }} />
									<i className="out" style={{ height: `${(bucket.outMinor / maxMinor) * 100}%` }} />
								</div>
								<small>T{bucket.month}</small>
							</div>
						))}
					</div>
				</>
			)}
			{draft && (
				<form
					className="rc-card rc-editor"
					onSubmit={(event) => {
						event.preventDefault();
						void submitDraft();
					}}
				>
					<h3>{draft.kind === 'in' ? 'Ghi thu' : 'Ghi chi'}</h3>
					<div className="rc-grid-2">
						<Field label="Ngày">
							<input
								type="date"
								value={draft.date}
								required
								onChange={(event) => setDraft({ ...draft, date: event.target.value })}
							/>
						</Field>
						<Field label="Danh mục" hint="VD: Cứu trợ, Hiến máu, Học bổng, Hành chính">
							<input
								value={draft.category}
								maxLength={120}
								required
								list="rc-categories"
								onChange={(event) => setDraft({ ...draft, category: event.target.value })}
							/>
							<datalist id="rc-categories">
								{(info?.fundCategories ?? []).map((value) => (
									<option key={value} value={value} />
								))}
							</datalist>
						</Field>
						<Field label="Số tiền (đồng)">
							<input
								inputMode="numeric"
								value={draft.amount}
								required
								placeholder="VD: 150000000"
								onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
							/>
						</Field>
						<Field label="Chứng từ" hint="Đường dẫn/ghi chú tới tệp chứng từ (không bắt buộc)">
							<input
								value={draft.documentRef}
								maxLength={200}
								onChange={(event) => setDraft({ ...draft, documentRef: event.target.value })}
							/>
						</Field>
					</div>
					<Field label="Mô tả">
						<textarea
							rows={2}
							value={draft.description}
							maxLength={2000}
							onChange={(event) => setDraft({ ...draft, description: event.target.value })}
						/>
					</Field>
					<div className="rc-editor-actions">
						<button type="button" onClick={() => setDraft(undefined)} disabled={mutation.pending}>
							Huỷ
						</button>
						<button type="submit" className="rc-primary" disabled={mutation.pending}>
							{mutation.pending ? 'Đang lưu…' : 'Lưu (chờ duyệt)'}
						</button>
					</div>
				</form>
			)}
			<div className="rc-toolbar">
				<label className="rc-field rc-inline">
					<span>Năm</span>
					<input
						type="number"
						min={1900}
						max={2200}
						value={year}
						onChange={(event) => {
							setYear(Number(event.target.value) || new Date().getFullYear());
							setPageIndex(0);
							setCursors([undefined]);
						}}
					/>
				</label>
				<label className="rc-field rc-inline">
					<span>Tháng</span>
					<select
						value={month}
						onChange={(event) => {
							setMonth(Number(event.target.value));
							setPageIndex(0);
							setCursors([undefined]);
						}}
					>
						<option value={0}>Cả năm</option>
						{Array.from({ length: 12 }, (_, index) => (
							<option key={index + 1} value={index + 1}>
								Tháng {index + 1}
							</option>
						))}
					</select>
				</label>
				<label className="rc-field rc-inline">
					<span>Loại</span>
					<select value={kind} onChange={(event) => setKind(event.target.value as 'all' | 'in' | 'out')}>
						<option value="all">Tất cả</option>
						<option value="in">Thu</option>
						<option value="out">Chi</option>
					</select>
				</label>
				<label className="rc-field rc-inline">
					<span>Trạng thái</span>
					<select value={status} onChange={(event) => setStatus(event.target.value as 'all' | 'pending' | 'approved')}>
						<option value="all">Tất cả</option>
						<option value="pending">Chờ duyệt</option>
						<option value="approved">Đã duyệt</option>
					</select>
				</label>
				<label className="rc-field rc-inline">
					<span>Danh mục</span>
					<input value={category} maxLength={120} onChange={(event) => setCategory(event.target.value)} />
				</label>
			</div>
			<Failure error={error} retry={() => setRetry((value) => value + 1)} />
			{loading && <p role="status">Đang tải sổ quỹ…</p>}
			{!loading && !error && (
				<div className="rc-table-scroll" role="region" aria-label="Bảng thu chi" tabIndex={0}>
					<table>
						<thead>
							<tr>
								<th scope="col">Ngày</th>
								<th scope="col">Loại</th>
								<th scope="col">Danh mục</th>
								<th scope="col">Mô tả</th>
								<th scope="col" className="rc-right">
									Số tiền
								</th>
								<th scope="col">Chứng từ</th>
								<th scope="col">Trạng thái</th>
								<th scope="col">Duyệt</th>
							</tr>
						</thead>
						<tbody>
							{items.map((entry) => (
								<tr key={entry.id}>
									<td>{formatDate(entry.value.date)}</td>
									<td>
										<span className={`rc-badge ${entry.value.kind === 'in' ? 'in' : 'out'}`}>
											{entry.value.kind === 'in' ? 'Thu' : 'Chi'}
										</span>
									</td>
									<td>{entry.value.category}</td>
									<td>{entry.value.description || '—'}</td>
									<td className={`rc-right ${entry.value.kind === 'in' ? 'rc-in' : 'rc-out'}`}>
										{entry.value.kind === 'in' ? '+' : '−'}
										{money(entry.value.amountMinor)}
									</td>
									<td>{entry.value.documentRef || '—'}</td>
									<td>
										<span className={`rc-badge ${entry.value.status === 'approved' ? 'approved' : 'pending'}`}>
											{entry.value.status === 'approved' ? 'Đã duyệt' : 'Chờ duyệt'}
										</span>
									</td>
									<td>
										{entry.value.status === 'pending' && (
											<button
												type="button"
												className="rc-primary rc-sm"
												disabled={mutation.pending}
												onClick={() =>
													mutation.run(
														() => request<RecordView<FundEntry>>('fund-approve', { id: entry.id }),
														() => setRetry((value) => value + 1),
													)
												}
											>
												Duyệt
											</button>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{items.length === 0 && <p className="rc-empty">Không có giao dịch phù hợp bộ lọc.</p>}
				</div>
			)}
			<Pager
				pageIndex={pageIndex}
				hasMore={page?.hasMore ?? false}
				loading={loading}
				shown={items.length}
				onPrev={() => setPageIndex((index) => Math.max(0, index - 1))}
				onNext={() => {
					if (!page?.cursor) return;
					setCursors((values) => [...values.slice(0, pageIndex + 1), page.cursor]);
					setPageIndex((index) => index + 1);
				}}
			/>
		</section>
	);
}

// --- Documents -----------------------------------------------------------------

const BLANK_DOCUMENT = (): Omit<DocumentRecord, 'schemaVersion' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy' | 'titleKey'> => ({
	number: '',
	title: '',
	type: 'decision',
	date: today(),
	signer: '',
	fileUrl: '',
	fileName: '',
	isPublic: true,
});

function DocumentsSection() {
	const [search, setSearch] = useState('');
	const debouncedSearch = useDebounced(search);
	const [type, setType] = useState<'all' | DocumentType>('all');
	const [year, setYear] = useState(0);
	const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
	const [pageIndex, setPageIndex] = useState(0);
	const [page, setPage] = useState<ListPage<DocumentRecord>>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<unknown>(null);
	const [editing, setEditing] = useState<{ id: string; revision: string | null; value: ReturnType<typeof BLANK_DOCUMENT> }>();
	const [retry, setRetry] = useState(0);
	const mutation = useMutation();
	const cursor = cursors[pageIndex];

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		request<ListPage<DocumentRecord>>(
			'documents-list',
			{
				search: debouncedSearch || undefined,
				type: type === 'all' ? undefined : type,
				year: year || undefined,
				cursor,
			},
			controller.signal,
		).then(
			(value) => {
				setPage(value);
				setLoading(false);
			},
			(cause: unknown) => {
				if (!controller.signal.aborted) {
					setError(cause);
					setLoading(false);
				}
			},
		);
		return () => controller.abort();
	}, [debouncedSearch, type, year, cursor, retry]);

	async function submit() {
		if (!editing) return;
		await mutation.run(
			() => request<RecordView<DocumentRecord>>('documents-save', { id: editing.id, revision: editing.revision, ...editing.value }),
			() => {
				setEditing(undefined);
				setRetry((value) => value + 1);
			},
		);
	}

	const items = page?.items ?? [];

	return (
		<section className="rc-section" aria-label="Văn bản">
			<div className="rc-section-head">
				<div>
					<h2>Hồ sơ – Văn bản – Quyết định</h2>
					<p className="rc-muted">
						Lưu số hiệu, trích yếu và đường dẫn tệp PDF. Tải tệp lên Thư viện Media của EmDash rồi dán URL vào đây.
					</p>
				</div>
				<div className="rc-actions">
					<button
						type="button"
						className="rc-primary"
						onClick={() => setEditing({ id: crypto.randomUUID(), revision: null, value: BLANK_DOCUMENT() })}
						disabled={mutation.pending}
					>
						+ Thêm văn bản
					</button>
				</div>
			</div>
			<Failure error={mutation.error} />
			{editing && (
				<form
					className="rc-card rc-editor"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<h3>{editing.revision ? 'Sửa văn bản' : 'Văn bản mới'}</h3>
					<div className="rc-grid-2">
						<Field label="Số hiệu">
							<input
								value={editing.value.number}
								required
								maxLength={64}
								placeholder="VD: 45/QĐ-CTĐV"
								onChange={(event) => setEditing({ ...editing, value: { ...editing.value, number: event.target.value } })}
							/>
						</Field>
						<Field label="Loại">
							<select
								value={editing.value.type}
								onChange={(event) => setEditing({ ...editing, value: { ...editing.value, type: event.target.value as DocumentType } })}
							>
								{DOC_TYPES.map((entry) => (
									<option key={entry.value} value={entry.value}>
										{entry.label}
									</option>
								))}
							</select>
						</Field>
						<Field label="Ngày">
							<input
								type="date"
								value={editing.value.date}
								required
								onChange={(event) => setEditing({ ...editing, value: { ...editing.value, date: event.target.value } })}
							/>
						</Field>
						<Field label="Người ký">
							<input
								value={editing.value.signer}
								maxLength={200}
								onChange={(event) => setEditing({ ...editing, value: { ...editing.value, signer: event.target.value } })}
							/>
						</Field>
					</div>
					<Field label="Trích yếu">
						<input
							value={editing.value.title}
							required
							maxLength={300}
							onChange={(event) => setEditing({ ...editing, value: { ...editing.value, title: event.target.value } })}
						/>
					</Field>
					<div className="rc-grid-2">
						<Field label="Đường dẫn tệp PDF" hint="Dán URL media, ví dụ /_emdash/api/media/file/…">
							<input
								value={editing.value.fileUrl}
								maxLength={2000}
								onChange={(event) => setEditing({ ...editing, value: { ...editing.value, fileUrl: event.target.value } })}
							/>
						</Field>
						<Field label="Tên tệp hiển thị">
							<input
								value={editing.value.fileName}
								maxLength={300}
								placeholder="VD: 45-QD-CTDV.pdf"
								onChange={(event) => setEditing({ ...editing, value: { ...editing.value, fileName: event.target.value } })}
							/>
						</Field>
					</div>
					<label className="rc-check">
						<input
							type="checkbox"
							checked={editing.value.isPublic}
							onChange={(event) => setEditing({ ...editing, value: { ...editing.value, isPublic: event.target.checked } })}
						/>
						<span>Công khai trên website</span>
					</label>
					<div className="rc-editor-actions">
						<button type="button" onClick={() => setEditing(undefined)} disabled={mutation.pending}>
							Huỷ
						</button>
						<button type="submit" className="rc-primary" disabled={mutation.pending}>
							{mutation.pending ? 'Đang lưu…' : 'Lưu'}
						</button>
					</div>
				</form>
			)}
			<div className="rc-toolbar">
				<label className="rc-search">
					<span>Tìm theo số hiệu / trích yếu</span>
					<input
						type="search"
						value={search}
						maxLength={200}
						onChange={(event) => {
							setSearch(event.target.value);
							setPageIndex(0);
							setCursors([undefined]);
						}}
					/>
				</label>
				<label className="rc-field rc-inline">
					<span>Loại</span>
					<select value={type} onChange={(event) => setType(event.target.value as 'all' | DocumentType)}>
						<option value="all">Tất cả</option>
						{DOC_TYPES.map((entry) => (
							<option key={entry.value} value={entry.value}>
								{entry.label}
							</option>
						))}
					</select>
				</label>
				<label className="rc-field rc-inline">
					<span>Năm</span>
					<input
						type="number"
						min={1900}
						max={2200}
						value={year || ''}
						placeholder="Tất cả"
						onChange={(event) => setYear(Number(event.target.value) || 0)}
					/>
				</label>
			</div>
			<Failure error={error} retry={() => setRetry((value) => value + 1)} />
			{loading && <p role="status">Đang tải danh sách văn bản…</p>}
			{!loading && !error && (
				<div className="rc-table-scroll" role="region" aria-label="Bảng văn bản" tabIndex={0}>
					<table>
						<thead>
							<tr>
								<th scope="col">Số hiệu</th>
								<th scope="col">Trích yếu</th>
								<th scope="col">Loại</th>
								<th scope="col">Ngày</th>
								<th scope="col">Người ký</th>
								<th scope="col">Tệp</th>
								<th scope="col">Công khai</th>
								<th scope="col" />
							</tr>
						</thead>
						<tbody>
							{items.map((entry) => (
								<tr key={entry.id}>
									<td className="rc-mono">{entry.value.number}</td>
									<td>{entry.value.title}</td>
									<td>{DOC_TYPE_LABEL[entry.value.type]}</td>
									<td>{formatDate(entry.value.date)}</td>
									<td>{entry.value.signer || '—'}</td>
									<td>
										{entry.value.fileUrl ? (
											<a href={entry.value.fileUrl} target="_blank" rel="noopener noreferrer">
												{entry.value.fileName || 'Xem PDF'}
											</a>
										) : (
											'—'
										)}
									</td>
									<td>
										<span className={`rc-badge ${entry.value.isPublic ? 'approved' : 'pending'}`}>
											{entry.value.isPublic ? 'Bật' : 'Tắt'}
										</span>
									</td>
									<td>
										<button
											type="button"
											className="rc-link"
											onClick={() =>
												setEditing({
													id: entry.id,
													revision: null,
													value: {
														number: entry.value.number,
														title: entry.value.title,
														type: entry.value.type,
														date: entry.value.date,
														signer: entry.value.signer,
														fileUrl: entry.value.fileUrl,
														fileName: entry.value.fileName,
														isPublic: entry.value.isPublic,
													},
												})
											}
										>
											Sửa
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{items.length === 0 && <p className="rc-empty">Chưa có văn bản nào. Bấm “Thêm văn bản”.</p>}
				</div>
			)}
			<Pager
				pageIndex={pageIndex}
				hasMore={page?.hasMore ?? false}
				loading={loading}
				shown={items.length}
				onPrev={() => setPageIndex((index) => Math.max(0, index - 1))}
				onNext={() => {
					if (!page?.cursor) return;
					setCursors((values) => [...values.slice(0, pageIndex + 1), page.cursor]);
					setPageIndex((index) => index + 1);
				}}
			/>
		</section>
	);
}

// --- Workspace -----------------------------------------------------------------

function Workspace() {
	const [tab, setTab] = useState<Tab>(() => {
		const value = typeof window === 'undefined' ? null : new URL(window.location.href).searchParams.get('rcTab');
		return value === 'fund' || value === 'documents' ? value : 'members';
	});
	const [info, setInfo] = useState<Info>();
	const [error, setError] = useState<unknown>(null);
	const [retry, setRetry] = useState(0);

	useEffect(() => {
		const controller = new AbortController();
		setError(null);
		request<Info>('info', undefined, controller.signal).then(setInfo, (cause: unknown) => {
			if (!controller.signal.aborted) setError(cause);
		});
		return () => controller.abort();
	}, [retry]);

	const tabs: { id: Tab; label: string }[] = [
		{ id: 'members', label: 'Hội viên' },
		{ id: 'fund', label: 'Quỹ (Thu – Chi)' },
		{ id: 'documents', label: 'Văn bản' },
	];

	return (
		<div className="rc-app">
			<header className="rc-header">
				<div>
					<p className="rc-eyebrow">Hội Chữ thập đỏ</p>
					<h1>Khu vực quản trị dữ liệu</h1>
					<p>Hội viên, quỹ thu–chi và hồ sơ văn bản của Hội.</p>
				</div>
				{info && <span className="rc-currency">{info.currency} · không đơn vị lẻ</span>}
			</header>
			<nav className="rc-tabs" aria-label="Khu vực quản trị">
				{tabs.map((entry) => (
					<a
						key={entry.id}
						href={`?rcTab=${entry.id}`}
						aria-current={tab === entry.id ? 'page' : undefined}
						onClick={(event) => {
							if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
							event.preventDefault();
							const url = new URL(window.location.href);
							url.searchParams.set('rcTab', entry.id);
							window.history.pushState(window.history.state, '', url);
							setTab(entry.id);
						}}
					>
						{entry.label}
					</a>
				))}
			</nav>
			<Failure error={error} retry={() => setRetry((value) => value + 1)} />
			{tab === 'members' && <MembersSection />}
			{tab === 'fund' && <FundSection info={info} />}
			{tab === 'documents' && <DocumentsSection />}
			<footer className="rc-footer">
				Khu vực quản trị riêng tư · Dữ liệu CCCD/SĐT chỉ dành cho quản trị viên. Mọi thao tác được ghi nhận
				theo phiên đăng nhập EmDash.
			</footer>
		</div>
	);
}

export const pages: PluginAdminExports['pages'] = { '/workspace': Workspace };
