import { ErpError } from '../validation.js';
import type { AccountPurpose, CoaCategory, CoaEntry, CoaSelection, CoaTemplate, CoaTemplateId, CoaTemplateMetadata, RootType } from './model.js';
import { tt133Accounts } from './coa-tt133.js';
import { tt99Accounts } from './coa-tt99.js';

const limitations = [
  'Bộ mẫu chỉ thêm danh mục; không chứng nhận tuân thủ thuế hoặc báo cáo tài chính pháp định, không chuyển đổi chế độ kế toán.',
  'Sổ chỉ dùng VND. Tài khoản ngoại tệ chỉ ghi giá trị quy đổi VND; không theo dõi nguyên tệ, tỷ giá hoặc tự đánh giá lại.',
  '131/331 dùng AR/AP hiện có: chiều tăng mở khoản, chiều giảm cần phân bổ hợp lệ; chưa hỗ trợ ứng trước hoặc trả vượt.',
  'Tài khoản ngành nghề không cung cấp module kho, tài sản, giá thành, thuế, số dư đầu kỳ hoặc tự kết chuyển/khóa sổ.',
  'TT200 không là mẫu cho kỳ mới 2026; ngoại lệ cổ phần hóa tại khoản 2 Điều 31 TT99 vẫn cần xem xét. TT132/TT58, ngân hàng, hành chính sự nghiệp và hộ kinh doanh ngoài phạm vi.',
];
const metadata: Record<CoaTemplateId, CoaTemplateMetadata> = {
  'vn-tt133-2016': {
    templateId: 'vn-tt133-2016', templateVersion: '1', label: 'TT133/2016 — Doanh nghiệp nhỏ và vừa',
    scope: 'Doanh nghiệp nhỏ và vừa phù hợp đối tượng áp dụng và chính sách kế toán đã lựa chọn; operator tự xác định chế độ.',
    effectiveDate: '2017-01-01', fiscalYearApplication: 'Áp dụng theo TT133 và chính sách của doanh nghiệp; không suy chế độ từ ngày bắt đầu sổ.',
    amendments: ['TT46/2025 sửa Điều 10 về quyền sửa đổi chế độ; không ban hành lại danh mục Phụ lục 1.'],
    sources: [{ label: 'TT133/2016 — Công báo, Phụ lục 1', url: 'https://congbao.chinhphu.vn/van-ban/thong-tu-so-133-2016-tt-btc-21048.htm' }, { label: 'TT46/2025 — Chính phủ', url: 'https://chinhphu.vn/?docid=214192&pageid=27160' }], limitations,
  },
  'vn-tt99-2025': {
    templateId: 'vn-tt99-2025', templateVersion: '1', label: 'TT99/2025 — Chế độ kế toán doanh nghiệp',
    scope: 'Chế độ kế toán doanh nghiệp; doanh nghiệp nhỏ và vừa có thể lựa chọn và áp dụng nhất quán ít nhất một kỳ kế toán năm.',
    effectiveDate: '2026-01-01', fiscalYearApplication: 'Năm tài chính bắt đầu từ hoặc sau 01/01/2026 (Điều 31).',
    amendments: ['Điều 11: thay đổi tên, mã hoặc kết cấu cần quy chế, không làm sai thông tin BCTC.'],
    sources: [{ label: 'TT99/2025 — Công báo', url: 'https://congbao.chinhphu.vn/van-ban/thong-tu-so-99-2025-tt-btc-46529.htm' }, { label: 'Phụ lục II phần A, trang 33–43', url: 'https://congbaocdn.chinhphu.vn/CongBaoCP/VanBan/2025/10/46529/59634-1-20251565-156699-2025-tt-btc.pdf' }], limitations,
  },
};
const classifications: Record<string, [RootType, CoaCategory]> = {
  '1': ['asset', 'asset'], '2': ['asset', 'asset'], '3': ['liability', 'liability'], '4': ['equity', 'equity'],
  '5': ['income', 'revenue'], '6': ['expense', 'operating-expense'], '7': ['income', 'other-income'],
  '8': ['expense', 'other-expense'], '9': ['result', 'result'],
};
function assemble(id: CoaTemplateId, data: readonly (readonly [string, string, string | null])[]): CoaTemplate {
  if (data.length > 512 || !data.length) throw new Error(`Invalid catalog size: ${id}`);
  const parents = new Set(data.map(([, , parent]) => parent).filter((code) => code !== null));
  const entries: CoaEntry[] = data.map(([code, name, parentCode]) => {
    const classification = classifications[code[0]!];
    if (!/^\d{3,6}$/.test(code) || !name.trim() || name !== name.trim() || name.length > 200 || !classification) throw new Error(`Invalid catalog entry: ${id}/${code}`);
    const isGroup = parents.has(code);
    let purpose: AccountPurpose = 'general';
    if (!isGroup) {
      if (code === '111' || code.startsWith('111')) purpose = 'cash';
      else if (code === '112' || code.startsWith('112')) purpose = 'bank';
      else if (code === '131') purpose = 'receivable';
      else if (code === '331') purpose = 'payable';
    }
    return { code, name, parentCode, rootType: classification[0], category: classification[1], purpose, isGroup };
  }).sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const byCode = new Map(entries.map((entry) => [entry.code, entry]));
  if (byCode.size !== entries.length) throw new Error(`Duplicate catalog codes: ${id}`);
  for (const entry of entries) {
    const seen = new Set([entry.code]);
    let parentCode = entry.parentCode;
    while (parentCode !== null) {
      const parent = byCode.get(parentCode);
      if (!parent || parent.rootType !== entry.rootType || !parent.isGroup || parent.purpose !== 'general' || seen.has(parentCode)) throw new Error(`Invalid catalog ancestry: ${id}/${entry.code}`);
      seen.add(parentCode); parentCode = parent.parentCode;
    }
  }
  return { ...metadata[id], entries };
}
const catalogs: Record<CoaTemplateId, CoaTemplate> = {
  'vn-tt133-2016': assemble('vn-tt133-2016', tt133Accounts),
  'vn-tt99-2025': assemble('vn-tt99-2025', tt99Accounts),
};
export function accountTemplates(): CoaTemplateMetadata[] {
  return Object.values(metadata).map((value) => structuredClone(value));
}
export function accountTemplate(id: CoaTemplateId, version?: string): CoaTemplate {
  const template = catalogs[id];
  if (!template) throw new ErpError('INVALID_INPUT', 'Select a supplied account template.');
  if (version !== undefined && version !== template.templateVersion) throw new ErpError('COA_TEMPLATE_VERSION', 'The selected catalog version is unavailable. Reload the template and preview again.');
  return structuredClone(template);
}
export function accountImportClosure(input: CoaSelection): CoaEntry[] {
  const template = accountTemplate(input.templateId, input.templateVersion);
  const byCode = new Map(template.entries.map((entry) => [entry.code, entry]));
  const closure = new Set<string>();
  for (const code of input.selectedCodes) {
    const leaf = byCode.get(code);
    if (!leaf || leaf.isGroup) throw new ErpError('INVALID_INPUT', 'Select only ledger codes from this catalog.');
    let entry: CoaEntry | undefined = leaf;
    while (entry) { closure.add(entry.code); entry = entry.parentCode === null ? undefined : byCode.get(entry.parentCode); }
  }
  return template.entries.filter((entry) => closure.has(entry.code));
}
