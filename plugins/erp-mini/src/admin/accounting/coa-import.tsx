import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AccountPurpose, CoaCategory, CoaEntry, CoaImportPreview, CoaImportResult, CoaSelection, CoaTemplate, CoaTemplateId, CoaTemplateMetadata, RootType } from '../../accounting/model.js';
import { accountingRequest } from '../api.js';
import { Failure, Field, useEditorBlock } from '../shared.js';
import type { BlockState } from '../shared.js';
import type { CoaImportIntentState } from './coa-import-intent.js';

const roots: Record<RootType, string> = { asset: 'Tài sản', liability: 'Nợ phải trả', equity: 'Vốn chủ sở hữu', income: 'Doanh thu / thu nhập', expense: 'Chi phí', result: 'Xác định kết quả' };
const purposes: Record<AccountPurpose, string> = { general: 'Thông thường', cash: 'Tiền mặt', bank: 'Ngân hàng', receivable: 'Phải thu (AR)', payable: 'Phải trả (AP)' };
const categories: Record<CoaCategory, string> = { asset: 'Tài sản', liability: 'Nợ phải trả', equity: 'Vốn chủ sở hữu', revenue: 'Doanh thu', 'operating-expense': 'Chi phí SXKD', 'other-income': 'Thu nhập khác', 'other-expense': 'Chi phí khác', result: 'Xác định kết quả' };
const statuses = { create: 'Tạo mới', existing: 'Đã có, tương thích', conflict: 'Xung đột' };
const fields = { name: 'Tên', rootType: 'Loại', purpose: 'Chức năng', isGroup: 'Tài khoản nhóm', parent: 'Tài khoản cha / phụ thuộc', active: 'Đang hoạt động' };
function searchable(value: string) { return value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLocaleLowerCase('vi'); }
function sameCodes(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((code, index) => code === sortedRight[index]);
}

function SelectionCheckbox({ label, checked, mixed, disabled, onChange }: { label: string; checked: boolean; mixed: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <input ref={input} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />;
}

function TemplateDetails({ template }: { template: CoaTemplateMetadata }) {
  return <section className="erp-notice erp-coa-metadata" aria-label="Phạm vi và nguồn bộ mẫu">
    <h4>{template.label}</h4>
    <dl><dt>Đối tượng áp dụng</dt><dd>{template.scope}</dd><dt>Hiệu lực</dt><dd>{template.effectiveDate}</dd><dt>Năm tài chính áp dụng</dt><dd>{template.fiscalYearApplication}</dd><dt>Phiên bản dữ liệu ứng dụng</dt><dd>{template.templateVersion} · {template.templateId}</dd></dl>
    {template.amendments.length > 0 && <ul>{template.amendments.map((text) => <li key={text}>{text}</li>)}</ul>}
    <p><strong>Nguồn đối chiếu:</strong></p><ul>{template.sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.label} (mở tab mới)</a></li>)}</ul>
    <p><strong>Giới hạn — không chứng nhận tuân thủ:</strong></p><ul>{template.limitations.map((text) => <li key={text}>{text}</li>)}</ul>
  </section>;
}

function verifiedPreview(data: CoaImportPreview, selection: CoaSelection, entries: Map<string, CoaEntry>, closure: Set<string>): boolean {
  if (!data || data.templateId !== selection.templateId || data.templateVersion !== selection.templateVersion || !Array.isArray(data.selectedCodes) || !sameCodes(data.selectedCodes, selection.selectedCodes) || !Array.isArray(data.rows) || data.rows.length !== closure.size) return false;
  const seen = new Set<string>();
  for (const row of data.rows) {
    const entry = entries.get(row.code);
    if (!entry || !closure.has(row.code) || seen.has(row.code) || row.name !== entry.name || row.parentCode !== entry.parentCode || row.rootType !== entry.rootType || row.purpose !== entry.purpose || row.isGroup !== entry.isGroup || row.category !== entry.category || row.automaticParent !== !selection.selectedCodes.includes(row.code) || !['create', 'existing', 'conflict'].includes(row.status)) return false;
    seen.add(row.code);
  }
  return data.createCount === data.rows.filter((row) => row.status === 'create').length && data.existingCount === data.rows.filter((row) => row.status === 'existing').length && data.conflictCount === data.rows.filter((row) => row.status === 'conflict').length && data.canImport === (selection.selectedCodes.length > 0 && data.conflictCount === 0);
}

type PanelProps = { commands: CoaImportIntentState; result?: CoaImportResult; onClose: () => void; onOpenAccount: (id: string) => void; onBlock: (state: BlockState) => void; onLoading: (loading: boolean) => void };

export function CoaImportPanel({ commands, result, onClose, onOpenAccount, onBlock, onLoading }: PanelProps) {
  const titleId = useId();
  const searchId = useId();
  const summaryId = useId();
  const [metadata, setMetadata] = useState<CoaTemplateMetadata[]>();
  const [templateId, setTemplateId] = useState<CoaTemplateId | ''>('');
  const [template, setTemplate] = useState<CoaTemplate>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<CoaImportPreview>();
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [retry, setRetry] = useState(0);
  const previewRequest = useRef<{ controller: AbortController; generation: number } | undefined>(undefined);
  const templateRequest = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const submitLock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLDivElement>(null);
  const conflictAlert = useRef<HTMLParagraphElement>(null);
  const lastResult = useRef(result?.commandId);
  const failureGeneration = useRef(commands.failureGeneration);
  const loading = metadataLoading || templateLoading || previewLoading || commands.pending;
  const selectionDisabled = commands.blocked || commands.pending || templateLoading;
  useEditorBlock(selected.size > 0 || commands.blocked, loading || commands.blocked, onBlock);
  useEffect(() => { onLoading(loading); }, [loading, onLoading]);
  useEffect(() => () => onLoading(false), [onLoading]);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { if (error || commands.error) alert.current?.focus(); }, [error, commands.error]);
  useEffect(() => { if (preview?.conflictCount) conflictAlert.current?.focus(); }, [preview]);

  function invalidatePreview() {
    generation.current += 1;
    previewRequest.current?.controller.abort();
    previewRequest.current = undefined;
    setPreview(undefined);
    setPreviewLoading(false);
  }
  useEffect(() => () => { generation.current += 1; previewRequest.current?.controller.abort(); }, []);
  useEffect(() => {
    if (failureGeneration.current === commands.failureGeneration) return;
    failureGeneration.current = commands.failureGeneration;
    invalidatePreview();
  }, [commands.failureGeneration]);
  useEffect(() => {
    if (!result || lastResult.current === result.commandId) return;
    lastResult.current = result.commandId;
    invalidatePreview();
    setSelected(new Set());
    setError(undefined);
  }, [result]);

  useEffect(() => {
    const controller = new AbortController();
    setMetadataLoading(true);
    setError(undefined);
    accountingRequest<CoaTemplateMetadata[]>('account-templates', undefined, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setMetadata(data); setMetadataLoading(false);
    }, (cause: unknown) => { if (!controller.signal.aborted) { setError(cause); setMetadataLoading(false); } });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    const controller = new AbortController();
    templateRequest.current = controller;
    if (!templateId) { setTemplate(undefined); setTemplateLoading(false); return () => controller.abort(); }
    setTemplateLoading(true);
    setTemplate(undefined);
    setError(undefined);
    accountingRequest<CoaTemplate>('account-template', { templateId }, controller.signal).then((data) => {
      if (controller.signal.aborted || templateRequest.current !== controller) return;
      if (data.templateId !== templateId) { setError(new Error('Bộ mẫu trả về không khớp lựa chọn. Hãy tải lại trước khi chọn tài khoản.')); }
      else setTemplate(data);
      setTemplateLoading(false);
    }, (cause: unknown) => { if (!controller.signal.aborted && templateRequest.current === controller) { setError(cause); setTemplateLoading(false); } });
    return () => controller.abort();
  }, [templateId, retry]);

  const tree = useMemo(() => {
    const byCode = new Map((template?.entries ?? []).map((entry) => [entry.code, entry]));
    const children = new Map<string | null, CoaEntry[]>();
    for (const entry of byCode.values()) { const siblings = children.get(entry.parentCode) ?? []; siblings.push(entry); children.set(entry.parentCode, siblings); }
    for (const siblings of children.values()) siblings.sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
    const rows: { entry: CoaEntry; depth: number }[] = [];
    const descendantLeaves = new Map<string, string[]>();
    function visit(entry: CoaEntry, depth: number): string[] {
      rows.push({ entry, depth });
      const leaves = entry.isGroup ? (children.get(entry.code) ?? []).flatMap((child) => visit(child, depth + 1)) : [entry.code];
      descendantLeaves.set(entry.code, leaves);
      return leaves;
    }
    const leaves = (children.get(null) ?? []).flatMap((entry) => visit(entry, 0));
    return { byCode, rows, descendantLeaves, leaves };
  }, [template]);
  const selectedCodes = useMemo(() => [...selected].sort(), [selected]);
  const closure = useMemo(() => {
    const codes = new Set<string>();
    for (const code of selected) {
      let entry = tree.byCode.get(code);
      while (entry) { codes.add(entry.code); entry = entry.parentCode === null ? undefined : tree.byCode.get(entry.parentCode); }
    }
    return codes;
  }, [selected, tree]);
  const visible = useMemo(() => {
    const query = searchable(search.trim());
    if (!query) return tree.rows;
    const codes = new Set<string>();
    for (const { entry } of tree.rows) {
      if (!searchable(`${entry.code} ${entry.name}`).includes(query)) continue;
      let current: CoaEntry | undefined = entry;
      while (current) { codes.add(current.code); current = current.parentCode === null ? undefined : tree.byCode.get(current.parentCode); }
    }
    return tree.rows.filter(({ entry }) => codes.has(entry.code));
  }, [tree, search]);
  const visibleSelectedCount = visible.filter(({ entry }) => !entry.isGroup && selected.has(entry.code)).length;
  const matchingPreview = Boolean(template && preview && failureGeneration.current === commands.failureGeneration && preview.templateId === template.templateId && preview.templateVersion === template.templateVersion && sameCodes(preview.selectedCodes, selectedCodes));
  const canConfirm = matchingPreview && Boolean(preview?.canImport && preview.conflictCount === 0 && preview.createCount > 0) && !loading && !commands.blocked;

  function changeTemplate(value: CoaTemplateId | '') {
    if (commands.blocked || commands.pending || value === templateId) return;
    if ((selected.size > 0 || preview) && !window.confirm('Đổi bộ mẫu sẽ bỏ toàn bộ lựa chọn và bản xem trước hiện tại. Tiếp tục?')) return;
    templateRequest.current?.abort();
    invalidatePreview(); setSelected(new Set()); setSearch(''); setTemplate(undefined); setTemplateLoading(Boolean(value)); setError(undefined); setTemplateId(value);
  }
  function chooseLeaves(codes: string[], checked: boolean) {
    if (selectionDisabled) return;
    invalidatePreview(); setError(undefined);
    setSelected((previous) => { const next = new Set(previous); for (const code of codes) { if (checked) next.add(code); else next.delete(code); } return next; });
  }
  async function loadPreview() {
    if (!template || !selectedCodes.length || commands.blocked || submitLock.current) return;
    invalidatePreview(); setError(undefined);
    const controller = new AbortController();
    const requestGeneration = generation.current;
    previewRequest.current = { controller, generation: requestGeneration };
    const selection: CoaSelection = { templateId: template.templateId, templateVersion: template.templateVersion, selectedCodes };
    setPreviewLoading(true);
    try {
      const data = await accountingRequest<CoaImportPreview>('preview-account-import', selection, controller.signal);
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      if (!verifiedPreview(data, selection, tree.byCode, closure)) throw new Error('Bản xem trước không khớp bộ mẫu, lựa chọn hoặc cây tài khoản. Không có lệnh nhập nào được gửi; hãy xem trước lại.');
      setPreview(data);
    } catch (cause) { if (!controller.signal.aborted && generation.current === requestGeneration) setError(cause); }
    finally { if (generation.current === requestGeneration) { previewRequest.current = undefined; setPreviewLoading(false); } }
  }
  async function confirmImport() {
    if (!canConfirm || !template || !preview || submitLock.current) return;
    submitLock.current = true;
    try { await commands.execute({ templateId: template.templateId, templateVersion: template.templateVersion, selectedCodes: [...selectedCodes], commandId: crypto.randomUUID() }, preview.rows.map((row) => row.code)); }
    catch (cause) { setError(cause); }
    finally { submitLock.current = false; }
  }

  return <section className="erp-panel erp-coa-import" aria-labelledby={titleId} aria-busy={loading}>
    <div className="erp-panel-heading"><div><h3 id={titleId} ref={heading} tabIndex={-1}>Nhập từ bộ tài khoản mẫu</h3><p className="erp-muted">Chỉ tạo mới hoặc giữ nguyên tài khoản tương thích; không sửa tài khoản hay chứng từ đã có.</p></div><button type="button" disabled={loading || commands.blocked} onClick={onClose}>Đóng bộ mẫu</button></div>
    <div ref={alert} tabIndex={-1}>{Boolean(error) && <Failure error={error} retry={() => { if (template) void loadPreview(); else { invalidatePreview(); setRetry((value) => value + 1); } }} />}{Boolean(commands.error) && <p className="erp-error" role="alert">{commands.blocked ? 'Có lỗi với lệnh nhập. Xem thông báo khôi phục lệnh trong workspace; không tạo lệnh thay thế khi kết quả chưa được xác nhận.' : 'Lệnh nhập không được thực hiện. Xem chi tiết lỗi trong workspace và xem trước lại lựa chọn trước khi gửi lệnh mới.'}</p>}</div>
    {metadataLoading && <p role="status">Đang tải thông tin bộ mẫu…</p>}
    <Field label="Chọn chế độ kế toán — không chọn mặc định" hint="Bạn tự xác định đối tượng và chính sách áp dụng. Import danh mục không chuyển đổi chế độ kế toán của sổ."><select disabled={commands.blocked || commands.pending || metadataLoading || !metadata} value={templateId} onChange={(event) => changeTemplate(event.target.value as CoaTemplateId | '')}><option value="">— Chọn TT133 hoặc TT99 —</option>{metadata?.map((value) => <option key={value.templateId} value={value.templateId}>{value.label}</option>)}</select></Field>
    {!templateId && <p className="erp-empty">Chọn một bộ mẫu, chọn các tài khoản cần dùng rồi xem trước. Không có tài khoản nào được nhập tự động.</p>}
    {templateLoading && <p role="status">Đang tải đầy đủ danh mục…</p>}
    {template && <>
      <TemplateDetails template={template} />
      <p className="erp-muted">Loại phản ánh bản chất kinh tế, không giới hạn bên Nợ/Có. Tài khoản điều chỉnh 214/229 vẫn là tài sản; 419 vẫn là vốn; 521 (TT99) là giảm trừ doanh thu. 911 là xác định kết quả, không tự kết chuyển.</p>
      <div className="erp-toolbar"><div className="erp-search"><label htmlFor={searchId}>Tìm mã hoặc tên (không phân biệt dấu / hoa thường)</label><input id={searchId} type="search" maxLength={200} value={search} placeholder="Ví dụ: 33311 hoặc thue" onChange={(event) => setSearch(event.target.value)} /></div><label className="erp-check"><SelectionCheckbox label={`Chọn toàn bộ ${tree.leaves.length} tài khoản lá trong bộ mẫu, kể cả đang ẩn`} checked={selected.size === tree.leaves.length && tree.leaves.length > 0} mixed={selected.size > 0 && selected.size < tree.leaves.length} disabled={selectionDisabled} onChange={(checked) => chooseLeaves(tree.leaves, checked)} />Chọn toàn bộ bộ mẫu ({tree.leaves.length} tài khoản lá)</label><button type="button" disabled={selectionDisabled || selected.size === 0} onClick={() => chooseLeaves(tree.leaves, false)}>Bỏ toàn bộ lựa chọn</button></div>
      <p id={summaryId} className="erp-notice" role="status" aria-live="polite">Đã chọn {selected.size}/{tree.leaves.length} tài khoản lá trong toàn bộ bộ mẫu; {selected.size - visibleSelectedCount} lựa chọn đang ẩn bởi tìm kiếm. Tự kèm {closure.size - selected.size} tài khoản cha. Chọn nhóm áp dụng cho tất cả lá hậu duệ, không chỉ hàng đang hiện.</p>
      <div className="erp-table-scroll" role="region" aria-label="Danh mục tài khoản bộ mẫu" tabIndex={0}><table className="erp-coa-table" aria-describedby={summaryId}><caption>{template.label} · {visible.length}/{tree.rows.length} hàng đang hiện. Nhóm chỉ dùng tổ chức cây, không nhận bút toán; không thể bỏ cha riêng khi vẫn chọn con.</caption><thead><tr><th scope="col">Chọn</th><th scope="col">Mã / tên</th><th scope="col">Nhóm trình bày</th><th scope="col">Cha</th><th scope="col">Loại</th><th scope="col">Chức năng</th></tr></thead><tbody>{visible.map(({ entry, depth }) => {
        const leaves = tree.descendantLeaves.get(entry.code) ?? [];
        const count = leaves.filter((code) => selected.has(code)).length;
        return <tr key={entry.code}><td><SelectionCheckbox label={entry.isGroup ? `Chọn toàn bộ ${leaves.length} lá dưới nhóm ${entry.code} ${entry.name}, kể cả đang ẩn` : `Chọn tài khoản ${entry.code} ${entry.name}`} checked={count === leaves.length && leaves.length > 0} mixed={count > 0 && count < leaves.length} disabled={selectionDisabled} onChange={(checked) => chooseLeaves(leaves, checked)} /></td><th scope="row"><div className="erp-coa-account" style={{ paddingInlineStart: `${depth * 1.25}rem` }}><span className="erp-number">{entry.code}</span> · {entry.name}<small>{entry.isGroup ? `Nhóm · ${count}/${leaves.length} lá đã chọn${closure.has(entry.code) ? ' · tự kèm khi chọn con' : ''}` : 'Tài khoản lá · được hạch toán'}</small></div></th><td>{categories[entry.category]}</td><td>{entry.parentCode ?? '—'}</td><td>{roots[entry.rootType]}</td><td>{purposes[entry.purpose]}</td></tr>;
      })}</tbody></table></div>
      {visible.length === 0 && <p className="erp-empty">Không có mã hoặc tên khớp tìm kiếm. Xóa tìm kiếm để xem toàn bộ; lựa chọn đã có vẫn được giữ.</p>}
      <div className="erp-actions"><button type="button" disabled={!selected.size || loading || commands.blocked} onClick={() => void loadPreview()}>{previewLoading ? 'Đang xem trước…' : 'Xem trước'}</button><span className="erp-muted">Xem trước chỉ đọc; dữ liệu hiện tại sẽ được kiểm tra lại khi nhập.</span></div>
      {matchingPreview && preview && <section className="erp-coa-preview" aria-label="Xem trước nhập tài khoản"><h4>Xem trước lựa chọn hiện tại</h4><p className="erp-notice" role="status" aria-live="polite">Tạo mới: {preview.createCount} · Đã có tương thích: {preview.existingCount} · Xung đột: {preview.conflictCount} · Tổng gồm cha tự kèm: {preview.rows.length}</p>
        {preview.conflictCount > 0 && <p ref={conflictAlert} tabIndex={-1} className="erp-error" role="alert">Xung đột chặn toàn bộ lô, kể cả tài khoản phụ thuộc vào cha không tương thích. Bỏ chọn nhánh hoặc giải quyết ngoài bộ mẫu rồi xem trước lại; import không ghi đè, đổi cha hay kích hoạt lại tài khoản.</p>}
        {preview.conflictCount === 0 && preview.createCount === 0 && <p className="erp-notice">Tất cả tài khoản đã có và tương thích. Không có tài khoản mới để nhập; không gửi lệnh.</p>}
        <div className="erp-table-scroll" role="region" aria-label="Chi tiết xem trước và xung đột" tabIndex={0}>
          <table className="erp-coa-table">
            <caption>Thông tin từ server; không thể sửa các trường của bộ mẫu tại đây.</caption>
            <thead><tr><th scope="col">Mã / tên</th><th scope="col">Cha</th><th scope="col">Loại / chức năng</th><th scope="col">Nhóm / lựa chọn</th><th scope="col">Trạng thái và chi tiết</th></tr></thead>
            <tbody>{preview.rows.map((row) => <tr key={row.code}>
              <th scope="row">{row.code} · {row.name}<small>{categories[row.category]}</small></th>
              <td>{row.parentCode ?? '—'}</td>
              <td>{roots[row.rootType]}<small>{purposes[row.purpose]}</small></td>
              <td>{row.isGroup ? 'Nhóm' : 'Lá'}<small>{row.automaticParent ? 'Cha tự kèm' : 'Đã chọn trực tiếp'}</small></td>
              <td><span className="erp-status">{statuses[row.status]}</span>
                {row.conflicts && <ul className="erp-coa-conflicts">{row.conflicts.map((conflict, index) => <li key={`${conflict.field}-${index}`}>
                  <strong>{fields[conflict.field]}:</strong> yêu cầu {conflict.expected === null ? 'Không có' : typeof conflict.expected === 'boolean' ? conflict.expected ? 'Có' : 'Không' : conflict.expected};
                  {' '}hiện tại {conflict.actual === null ? 'Không có' : typeof conflict.actual === 'boolean' ? conflict.actual ? 'Có' : 'Không' : conflict.actual}.
                </li>)}</ul>}
                {row.existingId && <small>ID hiện có: {row.existingId}</small>}
              </td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="erp-savebar"><button className="erp-primary" type="button" disabled={!canConfirm} onClick={() => void confirmImport()}>{commands.pending ? 'Đang xác nhận nhập…' : `Xác nhận nhập ${preview.createCount} tài khoản mới`}</button><span>Toàn bộ lô được nhập nguyên tử. Lệnh chính xác được lưu trong session trước khi gửi.</span></div>
      </section>}
    </>}
    {result && <section className="erp-section" aria-label="Kết quả nhập tài khoản"><h4>Kết quả đã được xác nhận</h4><p className="erp-notice" role="status" aria-live="polite">Thực tế tạo {result.created.length} tài khoản; giữ nguyên {result.existing.length} tài khoản tương thích · {result.templateId} · phiên bản {result.templateVersion} · hoàn tất {result.completedAt}.</p><p className="erp-muted">Đây là kết quả tại thời điểm nhập, không phải cache trạng thái hiện tại. Danh sách Accounts đã được làm mới; không phải mọi tài khoản đều nằm trong trang 25 hàng đầu.</p><div className="erp-table-scroll" role="region" aria-label="Mở tài khoản từ kết quả nhập" tabIndex={0}><table><caption>Lệnh {result.commandId}; mở bằng ID trả về từ server.</caption><thead><tr><th scope="col">Mã</th><th scope="col">Kết quả</th><th scope="col">Tài khoản</th></tr></thead><tbody>{[...result.created.map((ref) => ({ ...ref, created: true })), ...result.existing.map((ref) => ({ ...ref, created: false }))].sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0).map((ref) => <tr key={ref.id}><th scope="row">{ref.code}</th><td>{ref.created ? 'Đã tạo' : 'Đã có, giữ nguyên'}</td><td><button type="button" disabled={loading || commands.blocked} onClick={() => onOpenAccount(ref.id)}>Mở tài khoản {ref.code}</button></td></tr>)}</tbody></table></div></section>}
  </section>;
}
