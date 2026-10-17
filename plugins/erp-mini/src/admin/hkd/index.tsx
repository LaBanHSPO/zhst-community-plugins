import { useCallback, useEffect, useRef, useState } from 'react';
import type { HkdCommandResult, HkdEntry, HkdInfo, HkdPage, HkdProfile } from '../../accounting/hkd-model.js';
import { hkdEntrySchema, hkdProfileSchema } from '../../accounting/hkd-validation.js';
import { accountingRequest } from '../api.js';
import { Failure, Field, useEditorBlock } from '../shared.js';
import type { BlockState } from '../shared.js';
import { ConfigureForm, EntryForm, expenseLabels, kindLabels, methodLabels, taxLabels } from './forms.js';
import { useHkdIntent } from './intent.js';
import { BookReports } from './reports.js';

type View = 'entries' | 'new' | 'reports';
const entryFieldLabels: Record<string, string> = {
  date: 'Ngày ghi sổ', documentDate: 'Ngày chứng từ', documentNumber: 'Số chứng từ', description: 'Diễn giải',
  kind: 'Loại nghiệp vụ', amountMinor: 'Số tiền / giá trị (đồng)', businessLine: 'Ngành / hoạt động',
  vatRateBps: 'Tỷ lệ GTGT (điểm cơ bản; 100 điểm = 1%)', pitRateBps: 'Tỷ lệ TNCN (điểm cơ bản; 100 điểm = 1%)',
  vatTaxableMinor: 'Doanh thu tính GTGT (đồng)', pitTaxableMinor: 'Doanh thu tính TNCN (đồng)', incomeRevenueMinor: 'Doanh thu tính thu nhập S2c (đồng)',
  category: 'Nhóm chi phí', deductibleMinor: 'Phần chi phí được trừ (đồng)', direction: 'Chiều ghi',
  itemCode: 'Mã hàng', itemName: 'Tên hàng', unit: 'Đơn vị tính', quantity: 'Số lượng',
  fund: 'Quỹ', bankName: 'Ngân hàng / tổ chức thanh toán', taxKind: 'Loại thuế',
  absoluteRateMinor: 'Mức thuế tuyệt đối / đơn vị (đồng)', unitTaxPriceMinor: 'Giá tính thuế / đơn vị (đồng)',
  taxRateBps: 'Thuế suất (điểm cơ bản; 100 điểm = 1%)',
};
const entryValueLabels: Record<string, string> = {
  ...kindLabels, ...expenseLabels, ...taxLabels, opening: 'Số dư đầu kỳ', in: 'Nhập / thu', out: 'Xuất / chi',
  cash: 'Tiền mặt', bank: 'Ngân hàng / tổ chức thanh toán',
};
function Entries({ profile, disabled, onBusy, onVoid }: { profile: HkdProfile; disabled: boolean; onBusy: (busy: boolean) => void; onVoid: (entry: HkdEntry) => void }) {
  const [page, setPage] = useState<HkdPage>(); const [error, setError] = useState<unknown>(); const [loading, setLoading] = useState(false); const [retry, setRetry] = useState(0);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]); const [index, setIndex] = useState(0); const cursor = cursors[index]; const firstPage = useRef<HkdPage | undefined>(undefined);
  useEffect(() => { onBusy(loading); return () => onBusy(false); }, [loading, onBusy]);
  useEffect(() => {
    if (!cursor && firstPage.current) { setPage(firstPage.current); setError(undefined); setLoading(false); return; }
    const controller = new AbortController(); setLoading(true); setError(undefined); setPage(undefined);
    accountingRequest<HkdPage>('hkd-list', { year: profile.year, ...(cursor ? { cursor } : {}) }, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      if (!data || !Array.isArray(data.items) || data.items.length > 25 || !Number.isSafeInteger(data.asOfSequence) || typeof data.hasMore !== 'boolean' || (data.hasMore && !data.cursor) || data.items.some((entry) => entry.year !== profile.year || !hkdEntrySchema.safeParse(entry.entry).success) || (cursor && firstPage.current?.asOfSequence !== data.asOfSequence)) setError(new Error('Trang chứng từ không hợp lệ hoặc ảnh chụp đã thay đổi.'));
      else { if (!cursor) firstPage.current = data; setPage(data); }
      setLoading(false);
    }, (cause: unknown) => { if (!controller.signal.aborted) { setError(cause); setLoading(false); } });
    return () => controller.abort();
  }, [profile, cursor, retry]);
  return <section aria-label="Nghiệp vụ đã ghi" aria-busy={loading}><h3>Nghiệp vụ đã ghi</h3><p className="erp-muted">Chỉ ghi trực tiếp từ thao tác Ghi sổ. Không tự lấy từ CRM, không ghi sổ kép. Hủy giữ nguyên chứng từ gốc và thêm lý do bất biến.</p><Failure error={error} retry={() => setRetry((value) => value + 1)} />{loading && <p role="status">Đang tải chứng từ…</p>}
    <button type="button" disabled={disabled || loading} onClick={() => { firstPage.current = undefined; setIndex(0); setCursors([undefined]); setRetry((value) => value + 1); }}>Làm mới ảnh chụp chứng từ</button>
    {page && <><p className="erp-muted">Ảnh chụp đến trình tự #{page.asOfSequence}. Trạng thái hủy theo ảnh chụp này.</p>{page.items.length ? <div className="erp-table-scroll" role="region" aria-label="Danh sách nghiệp vụ HKD" tabIndex={0}><table><caption>Năm {profile.year} — trang {index + 1}, tối đa 25 dòng</caption><thead><tr><th scope="col">Ngày / chứng từ</th><th scope="col">Loại / nội dung</th><th scope="col">Trạng thái</th><th scope="col">Người ghi</th><th scope="col">Thao tác</th></tr></thead><tbody>{page.items.map((item) => <tr key={item.id}>
      <th scope="row">{item.entry.date}<small>{item.entry.documentNumber} · ngày chứng từ {item.entry.documentDate}</small><small>#{item.sequence} · {item.id}</small></th>
      <td>{kindLabels[item.entry.kind]}<p>{item.entry.description}</p><details><summary>Chi tiết đã ghi</summary><dl>{Object.entries(item.entry).map(([key, value]) => <div key={key}><dt>{entryFieldLabels[key] ?? key}</dt><dd>{value === null ? '—' : ['kind', 'category', 'direction', 'fund', 'taxKind'].includes(key) ? entryValueLabels[String(value)] ?? String(value) : String(value)}</dd></div>)}</dl></details></td>
      <td><span className="erp-status">{item.voided ? 'Đã hủy' : 'Đã ghi sổ'}</span>{item.voidReason && <p>Lý do: {item.voidReason}</p>}</td><td>{item.createdBy}<small>{item.createdAt}</small></td>
      <td><button type="button" className="erp-danger" disabled={disabled || item.voided} onClick={() => onVoid(item)} aria-label={`Hủy chứng từ ${item.entry.documentNumber || item.sequence}`}>Hủy với lý do</button></td>
    </tr>)}</tbody></table></div> : <p className="erp-empty">Chưa có nghiệp vụ. Chọn Ghi nghiệp vụ để ghi rõ từng chứng từ và số dư đầu kỳ.</p>}
    <nav className="erp-pagination" aria-label="Trang nghiệp vụ"><button type="button" disabled={disabled || loading || index === 0} onClick={() => setIndex((value) => value - 1)}>Trang trước</button><span>Trang {index + 1}</span><button type="button" disabled={disabled || loading || !page.hasMore || !page.cursor} onClick={() => { setCursors((values) => [...values.slice(0, index + 1), page.cursor]); setIndex((value) => value + 1); }}>Trang sau</button></nav></>}
  </section>;
}
export function HkdWorkspace({ onBlock, onLoading, allowLeave }: { onBlock: (state: BlockState) => void; onLoading: (busy: boolean) => void; allowLeave: () => boolean }) {
  const [info, setInfo] = useState<HkdInfo>(); const [error, setError] = useState<unknown>(); const [retry, setRetry] = useState(0); const [loading, setLoading] = useState(true);
  const [year, setYear] = useState<number>(); const [configuring, setConfiguring] = useState(false); const [view, setView] = useState<View>('entries'); const [dirty, setDirty] = useState(false); const [refresh, setRefresh] = useState(0); const [childBusy, setChildBusy] = useState(false);
  const [voidEntry, setVoidEntry] = useState<HkdEntry>(); const [reason, setReason] = useState(''); const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement>(null); const launcher = useRef<HTMLButtonElement>(null);
  const onResult = useCallback((result: HkdCommandResult) => {
    setNotice(`Đã xác nhận ${result.action === 'hkd-configure' ? 'thiết lập năm' : result.action === 'hkd-post-entry' ? 'ghi sổ' : 'hủy chứng từ'} ${result.year}. Mã lệnh ${result.commandId}; ảnh chụp biên nhận #${result.asOfSequence}.`);
    setYear(result.year); setConfiguring(false); setView('entries'); setDirty(false); setVoidEntry(undefined); setReason(''); setRefresh((value) => value + 1); setRetry((value) => value + 1);
    window.requestAnimationFrame(() => heading.current?.focus());
  }, []);
  const intent = useHkdIntent(onResult);
  const busy = loading || childBusy || intent.pending;
  useEditorBlock(dirty, intent.locked, onBlock);
  useEffect(() => { onLoading(busy); return () => onLoading(false); }, [busy, onLoading]);
  const reportBusy = useCallback((value: boolean) => setChildBusy(value), []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(undefined);
    accountingRequest<HkdInfo>('hkd-info', undefined, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      if (!value || value.currency !== 'VND' || value.pageSize !== 25 || !Array.isArray(value.profiles) || value.profiles.some((candidate) => !hkdProfileSchema.safeParse(candidate).success)) setError(new Error('Thông tin HKD không hợp lệ.'));
      else setInfo(value);
      setLoading(false);
    }, (cause: unknown) => { if (!controller.signal.aborted) { setError(cause); setLoading(false); } });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => { if (intent.error || intent.locked) heading.current?.focus(); }, [intent.error, intent.locked]);
  const profile = info?.profiles.find((value) => value.year === year);
  const savedIntent = intent.intent;
  const reconcileScope = Boolean(info && savedIntent && (
    (savedIntent.command.action === 'hkd-configure' && savedIntent.key === `erp-mini:hkd:initial-origin:${savedIntent.command.payload.year}:command`) ||
    info.profiles.some((candidate) => savedIntent.key === `erp-mini:hkd:${candidate.installationId}:${savedIntent.command.payload.year}:command` &&
      (savedIntent.command.action === 'hkd-configure' || candidate.year === savedIntent.command.payload.year))
  ));
  function change(operation: () => void) {
    if (intent.locked || !allowLeave()) return;
    setDirty(false); setVoidEntry(undefined); setReason(''); setNotice(''); operation();
  }
  return <section className="erp-hkd" aria-labelledby="erp-hkd-heading"><div className="erp-section-heading"><div><h2 id="erp-hkd-heading" ref={heading} tabIndex={-1}>Sổ hộ / cá nhân kinh doanh — TT152/2025</h2><p className="erp-muted">Sổ HKD độc lập với hệ thống tài khoản và sổ kép doanh nghiệp. Không tự xác định ngưỡng doanh thu, phương pháp hoặc tỷ lệ thuế; không tự nộp tờ khai và không chứng nhận tuân thủ.</p></div><button ref={launcher} type="button" disabled={intent.locked || busy || configuring || info?.profiles.length === 0} onClick={() => change(() => setConfiguring(true))}>Thiết lập năm mới</button></div>
    {notice && <p className="erp-notice" role="status">{notice}</p>}<Failure error={error} retry={() => setRetry((value) => value + 1)} /><Failure error={intent.error} />
    {intent.locked && <section className="erp-notice" role="status" aria-live="polite">
      <h3>Chưa xác nhận kết quả lệnh HKD</h3>
      {savedIntent && <><p>{savedIntent.command.action} · năm {savedIntent.command.payload.year} · mã lệnh {savedIntent.command.payload.commandId}</p><details><summary>Xem chính xác lệnh đang giữ</summary><pre className="erp-hkd-command">{JSON.stringify(savedIntent.command, null, 2)}</pre></details></>}
      <p>Giữ nguyên phiên này. Không đổi nội dung, mã lệnh, năm hoặc tài khoản người gửi; không xóa bộ nhớ phiên, mở tab khác để ghi lại, hoặc coi lỗi mạng là chưa ghi. Lệnh chính xác được lưu trước khi gửi và khôi phục sau tải lại. Các thao tác mới và rời workspace bị khóa đến khi đối soát.</p>
      {savedIntent ? <><button type="button" disabled={intent.pending || loading || !reconcileScope} onClick={() => void intent.retry()}>{intent.pending ? 'Đang đối soát…' : 'Thử lại / đối soát cùng lệnh gốc'}</button>{!loading && info && !reconcileScope && <p>Lệnh thuộc hồ sơ cài đặt khác hoặc không tìm thấy hồ sơ năm gốc. Không gửi sang hồ sơ thay thế; liên hệ người vận hành để khôi phục đúng tài nguyên.</p>}</> : <p>Không đọc được lệnh gốc. Liên hệ người vận hành để khôi phục; không tạo lệnh thay thế.</p>}
    </section>}
    {loading && <p role="status">Đang tải các năm HKD…</p>}
    {info && <><div className="erp-toolbar"><Field label="Chọn hồ sơ năm đã thiết lập"><select value={year ?? ''} disabled={intent.locked || busy} onChange={(e) => change(() => { setYear(e.target.value ? Number(e.target.value) : undefined); setConfiguring(false); setView('entries'); })}><option value="">Chọn năm…</option>{[...info.profiles].sort((a, b) => b.year - a.year).map((value) => <option key={value.year} value={value.year}>{value.year} — {value.name}</option>)}</select></Field>{configuring && <button type="button" disabled={intent.locked || busy} onClick={() => change(() => { setConfiguring(false); window.requestAnimationFrame(() => launcher.current?.focus()); })}>Đóng thiết lập</button>}</div>
      {configuring || info.profiles.length === 0 ? <ConfigureForm key={`configure:${refresh}`} disabled={intent.locked} onDirty={() => setDirty(true)} onSubmit={(payload) => void intent.execute({ action: 'hkd-configure', payload }, info.profiles[0]?.installationId)} /> : profile ? <>
        <div className="erp-notice"><h3>{profile.name} · {profile.year}</h3><p>{profile.address} · MST {profile.taxCode} · Người đại diện: {profile.representative}</p><p>{methodLabels[profile.taxMethod]} · Kỳ {profile.periodType === 'month' ? 'tháng' : profile.periodType === 'quarter' ? 'quý' : 'năm'} · Bắt đầu {profile.startDate}{profile.taxMethod === 'income' ? ` · Thuế suất TNCN ${profile.incomeTaxRateBps! / 100}%` : ''} · {profile.otherTaxes ? 'Có S3a' : 'Không S3a'} · VND</p><small>Chính sách bất biến; mỗi năm cần tự ghi rõ số dư đầu kỳ. Không tự chuyển số dư năm trước.</small></div>
        <nav className="erp-actions" aria-label="Chức năng HKD">{([['entries', 'Nghiệp vụ đã ghi'], ['new', 'Ghi nghiệp vụ'], ['reports', 'Xem / xuất sổ']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={view === value} disabled={intent.locked || busy || view === value} onClick={() => change(() => setView(value))}>{label}</button>)}</nav>
        {voidEntry && <form className="erp-panel" onChange={() => setDirty(true)} onSubmit={(e) => { e.preventDefault(); if (!reason.trim() || intent.locked) return; if (window.confirm(`Hủy bất biến chứng từ ${voidEntry.entry.documentNumber || voidEntry.id}?\nLý do: ${reason.trim()}\nChứng từ gốc vẫn được giữ. Số dư kho/tiền sẽ được kiểm tra lại toàn bộ.`)) void intent.execute({ action: 'hkd-void-entry', payload: { commandId: crypto.randomUUID(), year: profile.year, installationId: profile.installationId, revision: profile.revision, id: voidEntry.id, reason: reason.trim() } }, profile.installationId); }}><h3>Hủy chứng từ #{voidEntry.sequence}</h3><Field label="Lý do hủy bắt buộc"><textarea required maxLength={2000} value={reason} disabled={intent.locked} onChange={(e) => setReason(e.target.value)} /></Field><div className="erp-actions"><button type="submit" className="erp-danger" disabled={intent.locked}>Xác nhận hủy với lý do</button><button type="button" disabled={intent.locked} onClick={() => change(() => { setVoidEntry(undefined); window.requestAnimationFrame(() => heading.current?.focus()); })}>Bỏ hủy</button></div></form>}
        {view === 'entries' && <Entries key={`${profile.year}:${refresh}`} profile={profile} disabled={intent.locked || Boolean(voidEntry)} onBusy={reportBusy} onVoid={(entry) => change(() => { setVoidEntry(entry); window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.erp-hkd textarea')?.focus()); })} />}
        {view === 'new' && <EntryForm key={`${profile.year}:${refresh}`} profile={profile} disabled={intent.locked} onDirty={() => setDirty(true)} onSubmit={(entry) => void intent.execute({ action: 'hkd-post-entry', payload: { commandId: crypto.randomUUID(), year: profile.year, installationId: profile.installationId, revision: profile.revision, entry } }, profile.installationId)} />}
        {view === 'reports' && <BookReports key={`${profile.year}:${refresh}`} profile={profile} onBusy={reportBusy} />}
      </> : <p className="erp-empty">Chọn rõ hồ sơ năm để ghi và xem sổ, hoặc thiết lập một năm mới. Không dùng hồ sơ doanh nghiệp thay hồ sơ HKD.</p>}
    </>}
  </section>;
}
