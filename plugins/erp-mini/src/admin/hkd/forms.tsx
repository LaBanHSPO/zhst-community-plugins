import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { HkdConfigureInput, HkdEntryPayload, HkdProfile, HkdTaxKind } from '../../accounting/hkd-model.js';
import { hkdConfigureSchema, hkdEntrySchema } from '../../accounting/hkd-validation.js';
import { parsePrice } from '../api.js';
import { Failure, Field } from '../shared.js';

export const methodLabels = { exempt: 'Không thuộc diện nộp GTGT, TNCN — S1a', revenue: 'TNCN theo tỷ lệ trên doanh thu — S2a', income: 'TNCN trên thu nhập tính thuế — S2b–S2e' };
export const kindLabels = { revenue: 'Doanh thu', expense: 'Chi phí được trừ', stock: 'Vật liệu / hàng hóa', money: 'Tiền mặt / ngân hàng', tax: 'Thuế khác' };
export const expenseLabels = { materials: 'Vật liệu, hàng hóa', labour: 'Nhân công', depreciation: 'Khấu hao', services: 'Dịch vụ mua ngoài', interest: 'Lãi vay', other: 'Chi phí khác' };
export const taxLabels = { export: 'Xuất khẩu', import: 'Nhập khẩu', excise: 'Tiêu thụ đặc biệt', environment: 'Bảo vệ môi trường', resource: 'Tài nguyên', land: 'Sử dụng đất' };
function text(data: FormData, name: string) { return String(data.get(name) ?? '').trim(); }
function amount(data: FormData, name: string) { return parsePrice(text(data, name), 0); }
function percent(data: FormData, name: string) { return parsePrice(text(data, name), 2); }
function Input({ name, label, type = 'text', required = true, hint, ...props }: { name: string; label: string; type?: string; required?: boolean; hint?: string; min?: string | number; max?: string | number; step?: string; defaultValue?: string; maxLength?: number }) {
  return <Field label={label} hint={hint}><input name={name} type={type} required={required} maxLength={200} {...props} /></Field>;
}
function MoneyInput({ name, label }: { name: string; label: string }) { return <Input name={name} label={`${label} (đồng)`} type="number" min={0} max={1_000_000_000_000} step="1" />; }
function RateInput({ name, label, max = 100 }: { name: string; label: string; max?: number }) { return <Input name={name} label={`${label} (%)`} type="number" min={0} max={max} step="0.01" hint="Tự xác định tỷ lệ áp dụng; không suy từ doanh thu/ngành nghề." />; }
export function ConfigureForm({ disabled, onDirty, onSubmit }: { disabled: boolean; onDirty: () => void; onSubmit: (input: HkdConfigureInput) => void }) {
  const [method, setMethod] = useState(''); const [error, setError] = useState<unknown>();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(undefined);
    try {
      const data = new FormData(event.currentTarget);
      const payload = hkdConfigureSchema.parse({ commandId: crypto.randomUUID(), year: Number(text(data, 'year')), startDate: text(data, 'startDate'), name: text(data, 'name'), address: text(data, 'address'), taxCode: text(data, 'taxCode'), representative: text(data, 'representative'), location: text(data, 'location'), taxMethod: method, periodType: text(data, 'periodType'), incomeTaxRateBps: method === 'income' ? percent(data, 'incomeRate') : null, otherTaxes: data.has('otherTaxes') });
      if (window.confirm(`Thiết lập chính sách bất biến năm ${payload.year} cho ${payload.name}?\n${methodLabels[payload.taxMethod]}\nNgày bắt đầu ${payload.startDate}. Không sửa/xóa chính sách sau xác nhận; không tự chuyển số dư hay ghi sổ từ CRM/Accounting.`)) onSubmit(payload);
    } catch (cause) { setError(cause); }
  }
  return <form onSubmit={submit} onChange={onDirty} className="erp-panel"><h3>Thiết lập năm HKD mới</h3><p className="erp-notice">Chọn chính sách thuế và kỳ ghi sổ theo trường hợp thực tế. Ứng dụng không tự chọn ngưỡng, xác nhận tuân thủ hoặc nộp tờ khai. Mỗi năm độc lập, không tự chuyển số dư; không cần sổ doanh nghiệp hoặc COA.</p><Failure error={error} /><fieldset className="erp-unframed" disabled={disabled}><div className="erp-form-grid">
    <Input name="year" label="Năm" type="number" min={2026} max={2100} step="1" /><Input name="startDate" label="Ngày bắt đầu trong năm" type="date" min="2026-01-01" max="2100-12-31" />
    <Input name="name" label="Tên hộ / cá nhân kinh doanh" /><Input name="taxCode" label="Mã số thuế" maxLength={64} /><Input name="address" label="Địa chỉ" maxLength={1000} /><Input name="representative" label="Người đại diện" /><Input name="location" label="Địa danh lập sổ" />
    <Field label="Phương pháp thuế"><select required name="taxMethod" value={method} onChange={(e) => setMethod(e.target.value)}><option value="">Chọn rõ phương pháp…</option>{Object.entries(methodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
    <Field label="Kỳ định giá và báo cáo"><select name="periodType" required defaultValue=""><option value="">Chọn kỳ…</option><option value="month">Tháng</option><option value="quarter">Quý</option><option value="year">Năm</option></select></Field>
    {method === 'income' && <RateInput name="incomeRate" label="Thuế suất TNCN trên thu nhập" />}
    </div><label className="erp-check"><input type="checkbox" name="otherTaxes" />Có thuế khác: mở sổ S3a-HKD</label><div className="erp-savebar"><button className="erp-primary" type="submit">Xác nhận thiết lập bất biến</button></div></fieldset></form>;
}
export function EntryForm({ profile, disabled, onDirty, onSubmit }: { profile: HkdProfile; disabled: boolean; onDirty: () => void; onSubmit: (entry: HkdEntryPayload) => void }) {
  const [kind, setKind] = useState<keyof typeof kindLabels>('revenue');
  const [direction, setDirection] = useState(''); const [fund, setFund] = useState(''); const [tax, setTax] = useState<HkdTaxKind | ''>(''); const [taxMode, setTaxMode] = useState('');
  const [error, setError] = useState<unknown>();
  const income = profile.taxMethod === 'income', taxed = profile.taxMethod !== 'exempt';
  const allowed = (Object.keys(kindLabels) as (keyof typeof kindLabels)[]).filter((value) => value === 'revenue' || (value === 'tax' ? profile.otherTaxes : income));
  const opening = (kind === 'stock' || kind === 'money') && direction === 'opening';
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(undefined);
    try {
      const data = new FormData(event.currentTarget);
      const base = { date: opening ? profile.startDate : text(data, 'date'), documentDate: text(data, 'documentDate'), documentNumber: text(data, 'documentNumber'), description: text(data, 'description') };
      let raw: unknown;
      if (kind === 'revenue') raw = { ...base, kind, amountMinor: amount(data, 'amount'), businessLine: taxed ? text(data, 'businessLine') : '', vatRateBps: taxed ? percent(data, 'vatRate') : 0, vatTaxableMinor: taxed ? amount(data, 'vatBase') : 0, pitRateBps: profile.taxMethod === 'revenue' ? percent(data, 'pitRate') : 0, pitTaxableMinor: profile.taxMethod === 'revenue' ? amount(data, 'pitBase') : 0, incomeRevenueMinor: income ? amount(data, 'incomeBase') : 0 };
      else if (kind === 'expense') {
        if (!data.has('certify')) throw new Error('Cần tự xác nhận phần chi phí được trừ cùng chứng từ.');
        raw = { ...base, kind, category: text(data, 'category'), amountMinor: amount(data, 'amount'), deductibleMinor: amount(data, 'deductible') };
      } else if (kind === 'stock') raw = { ...base, kind, direction, itemCode: text(data, 'itemCode'), itemName: text(data, 'itemName'), unit: text(data, 'unit'), quantity: text(data, 'quantity'), amountMinor: direction === 'out' ? null : amount(data, 'amount') };
      else if (kind === 'money') raw = { ...base, kind, direction, fund, bankName: fund === 'bank' ? text(data, 'bankName') : null, amountMinor: amount(data, 'amount') };
      else {
        const absolute = tax === 'environment' || (['export', 'import', 'excise'].includes(tax) && (taxMode === 'absolute' || taxMode === 'combined'));
        const percentage = tax === 'resource' || tax === 'land' || taxMode === 'percentage' || taxMode === 'combined';
        if (!tax || (['export', 'import', 'excise'].includes(tax) && !taxMode)) throw new Error('Chọn loại thuế và cách tính.');
        raw = { ...base, kind, taxKind: tax, quantity: text(data, 'quantity'), absoluteRateMinor: absolute ? amount(data, 'absoluteRate') : 0, unitTaxPriceMinor: percentage ? amount(data, 'unitTaxPrice') : 0, taxRateBps: percentage ? percent(data, 'taxRate') : 0 };
      }
      const entry = hkdEntrySchema.parse(raw);
      if (window.confirm(`Ghi sổ ngay ${kindLabels[kind]} ngày ${entry.date}?\nDữ liệu bất biến sau ghi. Chỉ có thể hủy bằng sự kiện và lý do, không sửa/xóa.`)) onSubmit(entry);
    } catch (cause) { setError(cause); }
  }
  let fields: ReactNode;
  if (kind === 'revenue') fields = <><MoneyInput name="amount" label="Doanh thu thực tế" />{taxed && <><Input name="businessLine" label="Ngành / hoạt động kinh doanh" /><MoneyInput name="vatBase" label="Doanh thu tính GTGT (không vượt doanh thu)" /><RateInput name="vatRate" label="Tỷ lệ GTGT" /></>}{profile.taxMethod === 'revenue' && <><MoneyInput name="pitBase" label="Doanh thu tính TNCN (không vượt doanh thu)" /><RateInput name="pitRate" label="Tỷ lệ TNCN" /></>}{income && <MoneyInput name="incomeBase" label="Doanh thu tính thu nhập S2c (không vượt doanh thu)" />}</>;
  else if (kind === 'expense') fields = <><Field label="Nhóm chi phí"><select name="category" required defaultValue=""><option value="">Chọn nhóm…</option>{Object.entries(expenseLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><MoneyInput name="amount" label="Chi phí thực tế" /><MoneyInput name="deductible" label="Phần đủ điều kiện được trừ (không vượt chi phí)" /><label className="erp-check"><input name="certify" type="checkbox" required />Tôi tự xác định và có chứng từ cho phần chi phí được trừ.</label></>;
  else if (kind === 'stock') fields = <><Input name="itemCode" label="Mã vật liệu / hàng hóa" maxLength={64} /><Input name="itemName" label="Tên vật liệu / hàng hóa (giữ nguyên theo mã)" /><Input name="unit" label="Đơn vị tính (giữ nguyên theo mã)" maxLength={32} /><Input name="quantity" maxLength={26} label={opening ? 'Số lượng đầu kỳ (cho phép 0)' : 'Số lượng'} hint="Số thập phân dùng dấu chấm, tối đa 6 chữ số lẻ; không dấu phân cách hàng nghìn." />{direction !== 'out' && <MoneyInput name="amount" label={opening ? 'Giá trị đầu kỳ' : 'Giá trị nhập'} />}</>;
  else if (kind === 'money') fields = <><Field label="Quỹ tiền"><select required value={fund} onChange={(e) => setFund(e.target.value)}><option value="">Chọn quỹ…</option><option value="cash">Tiền mặt</option><option value="bank">Ngân hàng / nhà cung cấp thanh toán</option></select></Field>{fund === 'bank' && <Input name="bankName" label="Tên ngân hàng / nhà cung cấp / tài khoản quỹ" />}<MoneyInput name="amount" label={opening ? 'Số dư đầu kỳ (cho phép 0)' : 'Số tiền'} /></>;
  else fields = <>
    <Field label="Loại thuế"><select required value={tax} onChange={(e) => { setTax(e.target.value as HkdTaxKind); setTaxMode(''); }}><option value="">Chọn loại…</option>{Object.entries(taxLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
    {['export', 'import', 'excise'].includes(tax) && <Field label="Cách tính"><select required value={taxMode} onChange={(e) => setTaxMode(e.target.value)}><option value="">Chọn cách tính…</option><option value="percentage">Theo tỷ lệ phần trăm</option><option value="absolute">Theo mức tuyệt đối</option><option value="combined">Kết hợp phần trăm và tuyệt đối</option></select></Field>}
    <Input name="quantity" label="Số lượng tính thuế" maxLength={26} hint="Tối đa 6 chữ số thập phân, dùng dấu chấm." />
    {(tax === 'environment' || taxMode === 'absolute' || taxMode === 'combined') && <MoneyInput name="absoluteRate" label="Mức thuế tuyệt đối / đơn vị" />}
    {(tax === 'resource' || tax === 'land' || taxMode === 'percentage' || taxMode === 'combined') && <><MoneyInput name="unitTaxPrice" label="Giá tính thuế / đơn vị" /><RateInput name="taxRate" label="Thuế suất" max={10000} /></>}
  </>;
  return <form onSubmit={submit} onChange={onDirty} className="erp-panel"><h3>Ghi nghiệp vụ — năm {profile.year}</h3><p className="erp-notice">Ghi sổ là thao tác tức thời, không có bản nháp trên máy chủ. Mỗi mặt hàng/quỹ phải có số dư mở đầu rõ ràng (kể cả 0) đúng ngày bắt đầu {profile.startDate}, chỉ một lần. Xuất kho được tính bình quân gia quyền cả kỳ, không nhập giá vốn xuất. Xuất kho không tự ghi chi phí S2c: chi phí được trừ phải ghi riêng với chứng từ.</p><Failure error={error} /><fieldset className="erp-unframed" disabled={disabled}><Field label="Loại nghiệp vụ"><select value={kind} onChange={(e) => { setKind(e.target.value as keyof typeof kindLabels); setDirection(''); setError(undefined); }}>{allowed.map((value) => <option key={value} value={value}>{kindLabels[value]}</option>)}</select></Field><div key={kind} className="erp-form-grid">
    {(kind === 'stock' || kind === 'money') && <Field label="Chiều ghi"><select required value={direction} onChange={(e) => setDirection(e.target.value)}><option value="">Chọn chiều…</option><option value="opening">Số dư đầu kỳ</option><option value="in">{kind === 'stock' ? 'Nhập' : 'Thu'}</option><option value="out">{kind === 'stock' ? 'Xuất' : 'Chi'}</option></select></Field>}
    {opening ? <p>Ngày ghi số dư mở đầu: <strong>{profile.startDate}</strong></p> : <Input name="date" label="Ngày ghi sổ" type="date" min={profile.startDate} max={`${profile.year}-12-31`} />}
    <Input name="documentDate" label="Ngày chứng từ" type="date" /><Input name="documentNumber" label="Số chứng từ" /><Input name="description" label="Diễn giải" maxLength={2000} />{fields}
    </div><div className="erp-savebar"><button type="submit" className="erp-primary">Ghi sổ</button></div></fieldset></form>;
}
