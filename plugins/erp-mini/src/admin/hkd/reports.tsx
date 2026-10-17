import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HkdBook, HkdProfile, HkdReport, HkdReportRow } from '../../accounting/hkd-model.js';
import { accountingRequest } from '../api.js';
import { Failure, Field } from '../shared.js';
const bookNames: Record<HkdBook, string> = {
  'S1a-HKD': 'Sổ doanh thu bán hàng hóa, dịch vụ',
  'S2a-HKD': 'Sổ doanh thu bán hàng hóa, dịch vụ',
  'S2b-HKD': 'Sổ doanh thu bán hàng hóa, dịch vụ',
  'S2c-HKD': 'Sổ chi tiết doanh thu, chi phí',
  'S2d-HKD': 'Sổ chi tiết vật liệu, dụng cụ, sản phẩm, hàng hóa',
  'S2e-HKD': 'Sổ chi tiết tiền',
  'S3a-HKD': 'Sổ theo dõi nghĩa vụ thuế khác',
};

const summaryLabels: Record<string, string> = {
  amountMinor: 'Số tiền (đồng)', vatTaxableMinor: 'Doanh thu tính GTGT', pitTaxableMinor: 'Doanh thu tính TNCN',
  vatMinor: 'Thuế GTGT', pitMinor: 'Thuế TNCN', incomeRevenueMinor: 'Doanh thu tính thu nhập',
  deductibleMinor: 'Tổng chi phí được trừ', differenceMinor: 'Chênh lệch doanh thu − chi phí',
  incomeTaxRateBps: 'Thuế suất TNCN (điểm cơ bản; 100 điểm = 1%)', incomeTaxMinor: 'Thuế TNCN trên thu nhập',
  openingMinor: 'Giá trị / số dư mở đầu', closingMinor: 'Giá trị / số dư cuối kỳ',
  openingQuantity: 'Số lượng mở đầu', closingQuantity: 'Số lượng cuối kỳ',
  inMinor: 'Giá trị nhập / thu', outMinor: 'Giá trị xuất / chi', inQuantity: 'Số lượng nhập', outQuantity: 'Số lượng xuất',
};
export function availableBooks(profile: HkdProfile): HkdBook[] {
  const books: HkdBook[] = profile.taxMethod === 'exempt' ? ['S1a-HKD'] : profile.taxMethod === 'revenue' ? ['S2a-HKD'] : ['S2b-HKD', 'S2c-HKD', 'S2d-HKD', 'S2e-HKD'];
  if (profile.otherTaxes) books.push('S3a-HKD');
  return books;
}
function checkedReport(value: HkdReport, profile: HkdProfile, book: HkdBook, period: number, first?: HkdReport) {
  if (!value || value.profile?.installationId !== profile.installationId || value.profile.revision !== profile.revision || value.profile.year !== profile.year || value.book !== book || value.period !== period || !Number.isSafeInteger(value.asOfSequence) || value.asOfSequence < 0 || !Array.isArray(value.columns) || !Array.isArray(value.rows) || value.rows.length > 25 || !Array.isArray(value.summaries) || !Array.isArray(value.notes) || typeof value.from !== 'string' || typeof value.to !== 'string' || typeof value.hasMore !== 'boolean' || (value.hasMore && (typeof value.cursor !== 'string' || !value.cursor))) throw new Error('Báo cáo trả về không hợp lệ hoặc không khớp bộ lọc.');
  const keys = new Set<string>();
  for (const column of value.columns) {
    if (typeof column.key !== 'string' || typeof column.label !== 'string' || keys.has(column.key)) throw new Error('Cột báo cáo không hợp lệ.');
    keys.add(column.key);
  }
  for (const row of [...value.rows, ...value.summaries]) if (!row.cells || Object.values(row.cells).some((cell) => typeof cell !== 'string')) throw new Error('Giá trị báo cáo không phải chuỗi chính xác.');
  if (first && (value.asOfSequence !== first.asOfSequence || value.from !== first.from || value.to !== first.to || JSON.stringify(value.columns) !== JSON.stringify(first.columns) || JSON.stringify(value.summaries) !== JSON.stringify(first.summaries))) throw new Error('Ảnh chụp báo cáo đã thay đổi giữa các trang. Không tải xuống dữ liệu không nhất quán.');
  return value;
}
function csvCell(value: string) {
  // Spreadsheet text with optional leading whitespace/control characters must never become a formula.
  const safe = /^[\s\u0000-\u001f]*[=+@-]/u.test(value) || /^[\t\r\n]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
interface CompleteBook { report: HkdReport; rows: HkdReportRow[]; generatedAt: string }
async function collectCompleteBook(initial: HkdReport, profile: HkdProfile, signal: AbortSignal, onProgress: (count: number) => void): Promise<CompleteBook> {
  const rows = [...initial.rows]; const seen = new Set<string>(); let page = initial;
  onProgress(rows.length);
  while (page.hasMore) {
    signal.throwIfAborted();
    if (!page.cursor || seen.has(page.cursor)) throw new Error('Con trỏ báo cáo bị lặp hoặc thiếu; không xuất hoặc in sổ bị cắt.');
    seen.add(page.cursor);
    page = checkedReport(await accountingRequest<HkdReport>('hkd-report', { year: profile.year, period: initial.period, book: initial.book, cursor: page.cursor }, signal), profile, initial.book, initial.period, initial);
    rows.push(...page.rows); onProgress(rows.length);
  }
  signal.throwIfAborted();
  return { report: initial, rows, generatedAt: new Date().toISOString() };
}
function CompleteBookPrint({ value }: { value: CompleteBook }) {
  const { report, rows, generatedAt } = value; const { profile } = report;
  return <article className="erp-hkd-print" aria-label="Toàn bộ sổ chuẩn bị in">
    <header><h1>{bookNames[report.book]}</h1><p>{report.book} — {profile.year}</p><h2>{profile.name}</h2><p>Địa chỉ: {profile.address} · Mã số thuế: {profile.taxCode}</p><p>Kỳ {report.period}: {report.from} — {report.to} · Đơn vị: VND</p><p>Tạo lúc {generatedAt} · Ảnh chụp đến trình tự #{report.asOfSequence} · Đủ {rows.length} dòng, không chỉ trang màn hình.</p></header>
    <table><caption>Chi tiết toàn bộ kỳ</caption><thead><tr>{report.columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.id}>{report.columns.map((column) => <td key={column.key} className={column.numeric ? 'erp-numeric' : undefined}>{row.cells[column.key] ?? ''}</td>)}</tr>)}</tbody></table>
    {!rows.length && <p>Không có dòng nghiệp vụ trong kỳ.</p>}
    <table><caption>Tổng hợp toàn bộ kỳ</caption><thead><tr><th scope="col">Nhóm</th><th scope="col">Chỉ tiêu</th><th scope="col">Giá trị chính xác</th></tr></thead><tbody>{report.summaries.flatMap((summary, i) => Object.entries(summary.cells).map(([key, cell]) => <tr key={`${i}:${key}`}><th scope="row">{summary.label}</th><td>{report.columns.find((column) => column.key === key)?.label ?? summaryLabels[key] ?? key}</td><td className="erp-numeric">{cell}</td></tr>))}</tbody></table>
    <ul>{report.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>
    <footer className="erp-hkd-signature"><p>{profile.location}, ngày …… tháng …… năm ……</p><strong>Người đại diện</strong><p>(Ký, ghi rõ họ tên)</p><p>{profile.representative}</p><small>Không tự xác định ngưỡng doanh thu, tỷ lệ thuế; không tự nộp tờ khai, không chứng nhận tuân thủ.</small></footer>
  </article>;
}
export function BookReports({ profile, onBusy }: { profile: HkdProfile; onBusy: (busy: boolean) => void }) {
  const startMonth = Number(profile.startDate.slice(5, 7));
  const firstPeriod = profile.periodType === 'month' ? startMonth : profile.periodType === 'quarter' ? Math.ceil(startMonth / 3) : 1;
  const [book, setBook] = useState<HkdBook>(availableBooks(profile)[0]!); const [period, setPeriod] = useState(firstPeriod);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]); const [index, setIndex] = useState(0);
  const [report, setReport] = useState<HkdReport>(); const first = useRef<HkdReport | undefined>(undefined);
  const [error, setError] = useState<unknown>(); const [loading, setLoading] = useState(false); const [retry, setRetry] = useState(0);
  const [exporting, setExporting] = useState(false); const [exportCount, setExportCount] = useState(0); const [notice, setNotice] = useState('');
  const [printReady, setPrintReady] = useState<CompleteBook>();
  const printed = useRef<CompleteBook | undefined>(undefined);
  const [generated, setGenerated] = useState(''); const exportController = useRef<AbortController | undefined>(undefined);
  const periods = profile.periodType === 'month' ? 12 : profile.periodType === 'quarter' ? 4 : 1;
  const cursor = cursors[index];
  useEffect(() => { onBusy(loading || exporting || Boolean(printReady)); return () => onBusy(false); }, [loading, exporting, printReady, onBusy]);
  useEffect(() => () => exportController.current?.abort(), []);
  useEffect(() => {
    if (!printReady || printed.current === printReady) return;
    const done = () => setPrintReady(undefined);
    window.addEventListener('afterprint', done);
    const frame = window.requestAnimationFrame(() => {
      printed.current = printReady;
      try { window.print(); } catch (cause) { setError(cause); setPrintReady(undefined); }
    });
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener('afterprint', done); };
  }, [printReady]);
  useEffect(() => {
    if (!cursor && first.current) { setReport(first.current); setError(undefined); setLoading(false); setGenerated(new Date().toISOString()); return; }
    const controller = new AbortController(); setLoading(true); setError(undefined); setReport(undefined);
    accountingRequest<HkdReport>('hkd-report', { year: profile.year, book, period, ...(cursor ? { cursor } : {}) }, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      try { const data = checkedReport(value, profile, book, period, cursor ? first.current : undefined); if (!cursor) first.current = data; setReport(data); setGenerated(new Date().toISOString()); } catch (cause) { setError(cause); }
      setLoading(false);
    }, (cause: unknown) => { if (!controller.signal.aborted) { setError(cause); setLoading(false); } });
    return () => controller.abort();
  }, [profile, book, period, cursor, retry]);
  function filters(nextBook: HkdBook, nextPeriod: number) {
    if (nextBook === book && nextPeriod === period) return;
    exportController.current?.abort(); first.current = undefined; setBook(nextBook); setPeriod(nextPeriod); setIndex(0); setCursors([undefined]); setNotice('');
  }
  async function prepareCompleteBook(mode: 'csv' | 'print') {
    if (exportController.current || loading || printReady || !first.current) return;
    const controller = new AbortController(); exportController.current = controller;
    setExporting(true); setError(undefined); setNotice(''); setExportCount(0);
    try {
      // Start from the displayed first page, not a fresh high-water read; every subsequent page is pinned to it.
      const snapshot = checkedReport(first.current, profile, book, period);
      const complete = await collectCompleteBook(snapshot, profile, controller.signal, setExportCount);
      const { report: initial, rows, generatedAt } = complete;
      if (mode === 'print') {
        setPrintReady(complete);
        setNotice(`Đang chuẩn bị in đầy đủ ${rows.length} dòng đến ảnh chụp #${initial.asOfSequence}.`);
        return;
      }
      const records: string[][] = [
        [book, bookNames[book], String(profile.year)], ['Hộ / cá nhân kinh doanh', profile.name], ['Địa chỉ', profile.address], ['Mã số thuế', profile.taxCode], ['Địa danh', profile.location], ['Người đại diện', profile.representative], ['Kỳ', String(period), initial.from, initial.to], ['Đơn vị tiền', 'VND'], ['Tạo lúc', generatedAt], ['Ảnh chụp đến trình tự', String(initial.asOfSequence)], [], initial.columns.map((column) => column.label),
        ...rows.map((row) => initial.columns.map((column) => row.cells[column.key] ?? '')),
        [], ['TỔNG HỢP TOÀN KỲ'], ['Nhóm', 'Chỉ tiêu', 'Giá trị'], ...initial.summaries.flatMap((summary) => Object.entries(summary.cells).map(([key, value]) => [summary.label, initial.columns.find((column) => column.key === key)?.label ?? summaryLabels[key] ?? key, value])),
        ...initial.notes.map((note) => ['Ghi chú', note]), [], [profile.location, 'Ngày …… tháng …… năm ……'], ['Người đại diện', profile.representative, '(Ký, ghi rõ họ tên)'], ['Không phải chứng nhận hoặc tờ khai đã nộp.'],
      ];
      const blob = new Blob(['\uFEFF', records.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${book}-${profile.year}-${period}.csv`; document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`Đã xuất đầy đủ ${rows.length} dòng, ảnh chụp đến #${initial.asOfSequence}, tạo lúc ${generatedAt}.`);
    } catch (cause) { if (!controller.signal.aborted) setError(cause); }
    finally { if (exportController.current === controller) { setExporting(false); exportController.current = undefined; } }
  }
  return <section aria-label="Sổ HKD theo kỳ" aria-busy={loading || exporting}>
    <div className="erp-toolbar"><Field label="Mẫu sổ"><select value={book} disabled={exporting || Boolean(printReady)} onChange={(e) => filters(e.target.value as HkdBook, period)}>{availableBooks(profile).map((value) => <option key={value} value={value}>{value} — {bookNames[value]}</option>)}</select></Field><Field label={`Kỳ ${profile.periodType === 'month' ? 'tháng' : profile.periodType === 'quarter' ? 'quý' : 'năm'}`}><select value={period} disabled={exporting || Boolean(printReady)} onChange={(e) => filters(book, Number(e.target.value))}>{Array.from({ length: periods - firstPeriod + 1 }, (_, i) => <option key={i + firstPeriod} value={i + firstPeriod}>{i + firstPeriod}</option>)}</select></Field><button type="button" disabled={exporting || loading || Boolean(printReady)} onClick={() => { first.current = undefined; setIndex(0); setCursors([undefined]); setRetry((value) => value + 1); setNotice(''); }}>Làm mới ảnh chụp sổ</button><button type="button" disabled={exporting || loading || Boolean(printReady) || !report} onClick={() => void prepareCompleteBook('csv')}>Xuất CSV đầy đủ mọi trang</button><button type="button" disabled={exporting || loading || Boolean(printReady) || !report} onClick={() => void prepareCompleteBook('print')}>In sổ đầy đủ</button>{exporting && <button type="button" onClick={() => exportController.current?.abort()}>Hủy thu thập</button>}</div>
    {exporting && <p role="status">Đang thu thập toàn bộ trang cùng ảnh chụp: {exportCount} dòng. Chưa tạo tệp hoặc in cho đến khi đủ mọi trang.</p>}{notice && <p role="status" className="erp-notice">{notice}</p>}
    {printReady && <p className="erp-notice" role="status">Đã chuẩn bị toàn bộ sổ để in. <button type="button" onClick={() => setPrintReady(undefined)}>Đóng bản in / trở lại sổ</button></p>}
    <Failure error={error} retry={() => setRetry((value) => value + 1)} />{loading && <p role="status">Đang tải sổ…</p>}
    {report && <article className="erp-hkd-book"><header><h3>{profile.name} — {bookNames[report.book]} ({report.book})</h3><p>{profile.address} · MST {profile.taxCode}</p><p>Kỳ {report.period}: {report.from} — {report.to} · Đơn vị: VND</p><p className="erp-muted">Tạo lúc {generated} · Ảnh chụp đến trình tự #{report.asOfSequence}. Tổng hợp bên dưới là toàn kỳ, không chỉ trang hiện tại.</p></header>
      <div className="erp-table-scroll" role="region" aria-label={`Chi tiết ${book}`} tabIndex={0}><table><caption>{book} — trang {index + 1}</caption><thead><tr>{report.columns.map((column) => <th key={column.key} scope="col" className={column.numeric ? 'erp-numeric' : undefined}>{column.label}</th>)}</tr></thead><tbody>{report.rows.map((row) => <tr key={row.id}>{report.columns.map((column) => <td key={column.key} className={column.numeric ? 'erp-numeric' : undefined}>{row.cells[column.key] ?? ''}</td>)}</tr>)}</tbody></table></div>
      {!report.rows.length && <p className="erp-empty">Chưa có dòng trong kỳ này. Không tự tạo nghiệp vụ hoặc số dư.</p>}
      <nav className="erp-pagination" aria-label="Trang sổ"><button type="button" disabled={loading || exporting || Boolean(printReady) || index === 0} onClick={() => setIndex((value) => value - 1)}>Trang trước</button><span>Trang {index + 1} · {report.rows.length} dòng</span><button type="button" disabled={loading || exporting || Boolean(printReady) || !report.hasMore || !report.cursor} onClick={() => { setCursors((values) => [...values.slice(0, index + 1), report.cursor]); setIndex((value) => value + 1); }}>Trang sau</button></nav>
      <div className="erp-table-scroll" role="region" aria-label="Tổng hợp toàn kỳ" tabIndex={0}><table><caption>Tổng hợp toàn bộ kỳ — không cộng các trang riêng lẻ</caption><thead><tr><th scope="col">Nhóm</th><th scope="col">Chỉ tiêu</th><th scope="col">Giá trị chính xác</th></tr></thead><tbody>{report.summaries.flatMap((summary, i) => Object.entries(summary.cells).map(([key, value]) => <tr key={`${i}:${key}`}><th scope="row">{summary.label}</th><td>{report.columns.find((column) => column.key === key)?.label ?? summaryLabels[key] ?? key}</td><td className="erp-numeric">{value}</td></tr>))}</tbody></table></div>
      <ul>{report.notes.map((note, i) => <li key={i}>{note}</li>)}</ul><footer className="erp-hkd-signature"><p>{profile.location}, ngày …… tháng …… năm ……</p><strong>Người đại diện</strong><p>(Ký, ghi rõ họ tên)</p><p>{profile.representative}</p><small>Không phải chứng nhận tuân thủ hoặc bằng chứng đã nộp tờ khai.</small></footer>
    </article>}
    {printReady && createPortal(<div className="erp-mini erp-hkd-print-root"><CompleteBookPrint value={printReady} /></div>, document.body)}
  </section>;
}
