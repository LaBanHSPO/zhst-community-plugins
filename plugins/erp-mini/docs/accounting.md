# Đặc tả accounting nội bộ — ERP mini

Contract nghiệp vụ cho module accounting nội bộ Node/VND đã triển khai. Đọc cùng [lưu trữ và vận hành](accounting-storage.md); nguồn thực thi nằm trong [`src/accounting/`](../src/accounting/) và UI [`src/admin/accounting/`](../src/admin/accounting/). Các tiêu chí B01–B21 bên dưới là yêu cầu chấp nhận, không phải tuyên bố tất cả cổng runtime/release đã được kiểm tra.

## 1. Outcome và nguồn yêu cầu

Người dùng đã xác nhận môi trường CRM/sales chạy OK; đối tượng là doanh nghiệp nhỏ/rất nhỏ; ưu tiên ghi sổ nội bộ; đã chọn **ghi sổ kép, có công nợ** thay vì chỉ tiền thực thu/chi. Không chạy lại setup để xác nhận quan sát này.

Outcome: người quản trị ghi nhận nghiệp vụ khi phát sinh, thu/trả tiền từng phần, sửa sai bằng chứng từ đảo; đối chiếu được nhật ký, sổ cái, bảng cân đối phát sinh, tiền và công nợ trên cùng dữ liệu đã ghi sổ.

CRM/sales owners: [`src/model.ts`](../src/model.ts), [`src/service.ts`](../src/service.ts), [`src/index.ts`](../src/index.ts). Accounting có owners riêng trong [`src/accounting/`](../src/accounting/); quotation và accepted/fulfilled order không tự chứng minh doanh thu, thanh toán hay ghi sổ.

Các lựa chọn bên dưới là **quyết định phạm vi accounting nội bộ**, không phải quy định kế toán Việt Nam hoặc chứng nhận pháp lý. Không có baseline về số chứng từ, thời gian nhập liệu hoặc capacity; không bịa mục tiêu hiệu năng.

## 2. Boundary

- Một installation = một doanh nghiệp. Installation này VND; mọi giá trị chứng từ là số nguyên đồng.
- EmDash vẫn sở hữu danh tính/session/passkey. Mọi đọc/ghi/report accounting chỉ cho người có `plugins:manage`; giữ admin-only hiện hữu, không thêm quy trình duyệt nhiều cấp.
- Scope: hệ thống tài khoản; khách hàng/nhà cung cấp kế toán; số dư đầu kỳ; bút toán thủ công; thu/chi thanh toán công nợ từng phần; đảo; nhật ký/sổ cái/bảng cân đối phát sinh/số dư tiền/công nợ.
- Runtime triển khai được chọn: Node SQLite local/standalone. Cloudflare CRM/sales hiện hữu được giữ; accounting Cloudflare không được quảng cáo là supported. Không cần cloud credentials hay deployment.
- Non-goals: VAT/tax, hóa đơn điện tử, invoice pháp định, tồn kho/giá vốn, ngoại tệ, payroll, tự ghi sổ từ order, hợp nhất công ty, fiscal closing và báo cáo pháp định.
- Thu/trả vượt nợ, ứng trước, bù trừ công nợ và nghiệp vụ giảm nợ không qua đảo chưa nằm trong luồng thu/chi đã chọn; lệnh ngoài phạm vi phải bị từ chối rõ, không tự biến thành doanh thu/chi phí. Bút toán tổng quát không có công nợ vẫn dùng được.
- Người vận hành có thể thiết lập tài khoản thủ công hoặc chọn **TT133/2016** / **TT99/2025** từ bộ mẫu đóng gói, chọn toàn bộ hoặc subset rồi xem trước và nhập. Không chọn chế độ ngầm từ ngày máy/ngày bắt đầu sổ, không seed lúc install/startup và không chuyển đổi chế độ kế toán của doanh nghiệp.

## 3. Quy trình và thông tin

### 3.1. Thiết lập sổ và tài khoản

- Chọn ngày bắt đầu sổ `startDate` một lần trên installation accounting mới; không đổi ngày/currency qua settings, kể cả trước bút toán đầu tiên. Muốn thay đổi phải có kế hoạch migration riêng.
- Tài khoản có ID ổn định, code duy nhất sau chuẩn hóa, tên, root type asset/liability/equity/income/expense/result, group/ledger, parent, active và purpose general/cash/bank/receivable/payable.
- Group không nhận bút toán; parent phải là group cùng root type; không được tạo chu kỳ cây. Không có parent chuyển root ngầm.
- Purpose cash/bank/receivable chỉ cho ledger root asset; payable chỉ cho ledger root liability. Group chỉ purpose general. Không cho purpose sai root khiến báo cáo tiền/công nợ bị phân loại sai.
- Sửa tên/code giữ ID và snapshot lịch sử. Khi tài khoản có lịch sử, không đổi root/purpose/group/parent; có thể ngừng dùng. Không hard-delete tài khoản được tham chiếu.
- Disabled tài khoản chặn chứng từ mới, nhưng vẫn hiện báo cáo/lịch sử. Đảo chính xác chứng từ cũ vẫn được phép với account/party đã disabled; không cho mượn ngoại lệ này để post bút toán mới tùy ý.

#### 3.1.1. Bộ mẫu Việt Nam và phân loại

Owners: [`coa.ts`](../src/accounting/coa.ts), [`coa-tt133.ts`](../src/accounting/coa-tt133.ts), [`coa-tt99.ts`](../src/accounting/coa-tt99.ts). Dataset version **`"1"`** độc lập DB schema và record format. Thư viện offline chứa đầy đủ các cấp chính thức, không lấy mã trong ví dụ định khoản làm tài khoản con:

| Template ID | Danh mục | Hiệu lực / áp dụng |
| --- | --- | --- |
| `vn-tt133-2016` | 123 tài khoản, 49 cấp1; Phụ lục 1 | Hiệu lực 01/01/2017; doanh nghiệp nhỏ/vừa phù hợp đối tượng và chính sách đã chọn. TT46/2025 sửa Điều 10, không thay danh mục. |
| `vn-tt99-2025` | 184 tài khoản, 71 cấp1; Phụ lục II phần A | Hiệu lực 01/01/2026, năm tài chính bắt đầu từ/sau ngày đó. SME có thể chọn, nhất quán ít nhất một kỳ kế toán năm. |

| Nhóm pháp lý / mã | Root ứng dụng | Giới hạn |
| --- | --- | --- |
| Tài sản 1xx/2xx | `asset` | 214/229 và 215122 (TT99) điều chỉnh giảm, thường dư Có; vẫn là tài sản. |
| Nợ phải trả 3xx | `liability` | Không suy AR/AP từ bên số dư hoặc tên “phải thu/phải trả”. |
| Vốn chủ sở hữu 4xx | `equity` | 419 điều chỉnh giảm; 413/421 có thể dư Nợ hoặc Có. |
| Doanh thu 5xx | `income` | 521 chỉ trong TT99, giảm trừ doanh thu, không phải expense. |
| Chi phí SXKD 6xx | `expense` | Không tự sinh giá vốn, giá thành hoặc module kho. |
| Thu nhập khác 7xx | `income` | Nhóm trình bày riêng; không cần root mới. |
| Chi phí khác 8xx | `expense` | Có TK thuế TNDN không có nghĩa có kê khai thuế. |
| Xác định kết quả 9xx / 911 | `result` | Chỉ purpose general; không tự kết chuyển hoặc khóa sổ, không ép số dư về 0. |

Root là bản chất kinh tế, không là quy tắc cấm ghi Nợ/Có. Báo cáo tiếp tục tính Nợ−Có bằng số nguyên chính xác. Group được xác định theo **toàn bộ** catalog và luôn general; chỉ lá được hạch toán. Không biến cha thành ledger khi chỉ chọn một nhánh, không tạo heading giả mã 1/2/3.

Purpose của lá: 111/lá dưới111 → cash; 112/lá dưới112 → bank; 131 → receivable; 331 → payable; các mã khác → general. Không map138 thành AR,338 thành AP hoặc1281 thành bank. TT133 giữ1111/1112,1121/1122 và5111/5112/5113/5118; TT99 không thêm các mã này. TT99 giữ215→2151→21512→215121/215122,332,3525,821→8211→82111/82112. Cùng code không đồng nghĩa: TT1333386 là nhận ký quỹ/ký cược, TT993386 là BHTN; TT1336421 là bán hàng, TT996421 là nhân viên quản lý.

Danh mục ngoại tệ và ngành nghề vẫn đầy đủ. Sổ hiện chỉ VND: chỉ ghi giá trị quy đổi, không nguyên tệ/tỷ giá/tự đánh giá lại. 131/331 dùng AR/AP hiện có: chiều tăng mở khoản, chiều giảm cần allocation; **không** bổ sung ứng trước/overpayment chỉ vì import. Import không tạo bút toán, số dư đầu kỳ, tài sản/kho/thuế/BCTC và không chứng nhận tuân thủ đầy đủ TT133/TT99.

TT200 không là mẫu cho kỳ mới2026; giữ ngoại lệ cổ phần hóa tại khoản2 Điều31 TT99, không tuyên bố bãi bỏ mọi nội dung vô điều kiện. TT132/TT58, ngân hàng, hành chính sự nghiệp và hộ kinh doanh ngoài hai bộ mẫu. TT58 hiệu lực01/07/2026, áp dụng năm tài chính bắt đầu từ/sau01/07/2026; TT132 hết hiệu lực từ ngày đó. TT58 quy định sổ theo phương pháp thuế, không là catalog ghi sổ kép; DNSN có thể chọn chế độ SME nhất quán trong năm theo Điều4.3.

Nguồn: [TT133 Công báo](https://congbao.chinhphu.vn/van-ban/thong-tu-so-133-2016-tt-btc-21048/15524.htm), [Phụ lục 1 chính thức, PDF trang76–81](https://congbaocdn.chinhphu.vn/CongBaoCP/VanBan/2016/8/21048/15524-1-1332016tt-btc15581pdf), [TT46 Chính phủ](https://chinhphu.vn/?docid=214192&pageid=27160), [TT99 Công báo](https://congbao.chinhphu.vn/van-ban/thong-tu-so-99-2025-tt-btc-46529.htm), [Phụ lục II phần A, PDF trang33–43](https://congbaocdn.chinhphu.vn/CongBaoCP/VanBan/2025/10/46529/59634-1-20251565-156699-2025-tt-btc.pdf), [TT58 Công báo](https://congbao.chinhphu.vn/van-ban/thong-tu-so-58-2026-tt-btc-469663.htm).

#### 3.1.2. Chọn, xem trước và nhập nguyên tử

Sau setup sổ, Accounts → **Nhập từ bộ tài khoản mẫu** → chọn một chế độ → chọn lá/toàn bộ → **Xem trước** → **Xác nhận nhập**. Checkbox nhóm chọn toàn bộ lá hậu duệ; checkbox toàn bộ chọn cả hàng bị filter ẩn. Selection chỉ giữ lá; server thêm đúng ancestors, không kéo siblings. Thay template/selection vô hiệu preview cũ; UI hiển thị số lựa chọn ẩn và cha tự kèm.

| Action tại `/api/erp-mini/accounting/` | Method / byte cap | Input |
| --- | --- | --- |
| `account-templates` | GET / 0 | Không body |
| `account-template` | POST / 4096 | `{templateId}` |
| `preview-account-import` | POST / 65536 | `{templateId,templateVersion,selectedCodes}` |
| `import-accounts` | POST / 65536 | Selection + `commandId` UUID |

Mọi action kể cả catalog cần session, plugins:manage, plugin enabled, Node/VND và sổ đã setup. POST giữ same-origin/header/content-type/actual-byte guards. Strict input từ chối fields giả actor/name/root/parent/UUID account; 1–512 mã ASCII3–6 chữ số, unique, chỉ lá catalog. Selection được sort để thứ tự khác có cùng identity. Unknown/group/empty/duplicate trả INVALID_INPUT; version chưa hỗ trợ trả COA_TEMPLATE_VERSION.

Preview là snapshot chỉ đọc, không tạo pending record/group. Mỗi row trả code/name/parent/root/purpose/group/category, automaticParent, status `create|existing|conflict`, existingId và chi tiết field xung đột. Existing chỉ khi name/root/purpose/group/parent và active=true đều khớp; code tìm theo NFKC/lowercase nhưng giữ display code cũ. Không đoán synonyms. Cha xung đột chặn cả dependency. Tất cả đã có là preview hợp lệ create0, UI không gửi lệnh.

Import **create-only**, recheck DB dưới một transaction: conflict bất kỳ trả COA_IMPORT_CONFLICT và rollback toàn bộ, không overwrite/rename/reparent/reactivate/convert account911 cũ. Tạo cha trước con, reuse IDs cha existing, audit mỗi account mới với actor thật/event `import-accounts:<templateId>:<version>`; existing không đổi revision/audit. Không đổi balances hoặc journal sequence. Account/audit/receipt fault rollback cùng nhau; race tạo account giống hệt được skip và receipt phản ánh số thực tế.

Receipt riêng `{commandId,templateId,templateVersion,selectedCodes,created:[{code,id,revision}],existing:[{code,id,revision}],completedAt}` gồm đầy đủ closure, hai tập rời nhau, sort code. Đây là kết quả tại thời điểm import, không là cache account hiện tại hoặc FinancialResult. Command ID dùng chung namespace với post/reverse: khác actor/action/payload trả IDEMPOTENCY_CONFLICT. Cùng command trả receipt cũ **trước** lookup catalog/account hiện tại, kể cả account đã đổi code hoặc catalog nâng version; command mới cùng selection tương thích có thể trả create0.

UI lưu exact payload + closure dự kiến vào sessionStorage theo installation **trước gửi**, kiểm strict acknowledgment trước xóa intent. Storage hỏng fail closed. Mất mạng/timeout/storage/busy/INTERNAL_ERROR/receipt sai/IDEMPOTENCY_CONFLICT giữ intent, thông báo **Chưa xác nhận kết quả nhập** và khóa lựa chọn/sửa mới, kể cả sau reload ngoài panel. Retry/đối soát dùng đúng command; không UUID mới hoặc tab thay thế. Chỉ INVALID_INPUT/COA_TEMPLATE_VERSION/COA_IMPORT_CONFLICT chứng minh chưa commit mới cho clear và preview lại. Thành công refresh Accounts và mở account bằng ID receipt; không hứa nằm trên page25 đầu.

Người vận hành có thể tùy biến bằng editor và quy chế kế toán riêng; import không là công cụ chuyển TT133↔TT99 hoặc sửa lịch sử.


### 3.2. Đối tượng công nợ

- Party có ID ổn định, kind customer/supplier, code, name, active. Một tổ chức có cả hai vai trò dùng hai party records rõ ràng; không tự bù trừ.
- Customer CRM có thể được **liên kết một lần**: chọn record hiện hữu, kiểm tra quyền và revision tại lúc lấy dữ liệu, lưu party cùng snapshot tên/code trong DB accounting; uniqueness trên `(sourceKind, sourceId, partyKind)` tránh liên kết trùng.
- Supplier được tạo trong accounting. Party customer cũng được tạo độc lập nếu không cần CRM link.
- CRM link chỉ là tham chiếu nguồn, không cam kết snapshot cập nhật đồng thời với master CRM. Không ghi CRM và accounting trong cùng một lệnh được gọi là atomic. Đổi/archiving CRM sau đó không sửa chứng từ đã post.
- Dòng receivable phải có customer; payable phải có supplier. Party không đúng vai trò hoặc thiếu party phải bị từ chối. Party disabled chặn chứng từ mới, không chặn lịch sử/đảo.

### 3.3. Bút toán thủ công và đầu kỳ

- Header: ID, revision, kind journal/opening/receipt/payment/reversal, ngày ghi sổ, diễn giải, reference nội bộ, metadata actor/time server-owned; VND từ installation, không từ body.
- Mỗi dòng: account, party khi bắt buộc, debit hoặc credit; tối thiểu 2, tối đa 50 dòng. Mỗi dòng có đúng một bên dương, bên kia bằng 0; tối đa `1_000_000_000_000` đồng mỗi bên/dòng, dùng bound tiền hiện có. Tổng Nợ = tổng Có > 0; không làm tròn.
- Ngày ghi sổ là ngày lịch `YYYY-MM-DD` do người vận hành chọn, không convert qua timezone của server. Phải là ngày có thật và không trước startDate.
- Save draft chưa làm thay đổi sổ/công nợ. Draft dùng revision để không mất cập nhật; archive/cancel draft giữ record nhưng loại khỏi danh sách cần post.
- Post khóa nội dung, lưu snapshots account/party, lines, allocations, audit, command receipt và thứ tự ghi sổ trong **một transaction**. Không tự post khi save.
- Opening là bút toán cân bằng tại startDate, có party và nguồn nợ riêng cho từng khoản đầu kỳ. Người vận hành chọn đúng tài khoản đối ứng; không tự dùng tài khoản chênh lệch để ép cân bằng.
- Không tự suy ra số dư đầu kỳ từ customers/items/quotes/orders. Không giả lập closing hàng năm; các bút toán opening là dữ liệu thật và không được xóa khỏi ledger.
- Dòng AR Nợ tạo khoản phải thu mở; dòng AP Có tạo khoản phải trả mở. Dòng AR Có/AP Nợ giảm nợ phải có phân bổ tới nguồn đã post, ngoại trừ đảo do server tạo. Đây là giới hạn công nợ thông thường; ứng trước cần thiết kế riêng, không nhận ngầm thành khoản nợ âm.
- Mỗi dòng có role server-owned `general`, `open-item`, `settlement` hoặc `reversal`. Chỉ open-item AR Nợ/AP Có được chọn làm nguồn; dòng từ chứng từ đảo không tạo nguồn nợ mới, dù có cùng bên Nợ/Có.

### 3.4. Thu/chi và phân bổ công nợ

- Receipt: Nợ cash/bank, Có receivable; chọn customer và nguồn phải thu đã post. Payment: Nợ payable, Có cash/bank; chọn supplier và nguồn phải trả đã post.
- Một chứng từ có thể phân bổ cho nhiều nguồn cùng party/account/currency. Có tối đa 49 nguồn trong helper thu/chi, để một dòng cash/bank + các dòng control vẫn không vượt 50 dòng. Bút toán tổng quát có giảm công nợ phải tuân cùng kiểm tra allocation.
- Allocation liên kết tới **dòng nguồn**, không chỉ header hoặc tên customer. Tổng phân bổ của dòng giảm nợ phải bằng đúng số tiền dòng đó; không tạo phần tiền chưa giải thích.
- Mỗi nguồn không được phân bổ vượt còn lại; một lệnh có nhiều allocation cùng nguồn phải kiểm tra tổng, không kiểm tra từng dòng độc lập. Tổng tiền helper do server dựng từ allocations, không tin total client gửi.
- Mọi lệnh có allocation và mọi reversal tác động nguồn phải có ngày `>= max(ngày nguồn, ngày của mọi hoạt động phân bổ/giải phóng đã post của nguồn)`. Bao gồm bút toán tổng quát, không chỉ helper thu/chi; allocation đầu tiên cũng không được trước nguồn. Không cho backdate làm báo cáo quá khứ vượt nợ dù số dư hiện tại hợp lệ. Bút toán không tác động nguồn này không chịu fence ngày đó.
- Còn lại operational tính trên mọi lệnh đã post, kể cả chứng từ có ngày tương lai; số dư báo cáo theo ngày có cutoff riêng. UI phân biệt rõ hai khái niệm, không dùng số dư tại cutoff cũ để authorize thanh toán mới.
- Lỗi hoặc response bị mất: giữ command ID và payload đã gửi; gửi lại đúng lệnh hoặc tra kết quả. Không tạo UUID mới cho cùng một ý định đã có kết quả chưa rõ.

### 3.5. Đảo và sửa sai

- Chứng từ posted không được sửa/xóa. Reverse tạo một chứng từ mới đảo bên Nợ/Có của toàn bộ lines, giữ snapshot và link original, ngày không trước original. Nguyên bản luôn còn trong ledger.
- Chỉ một full reversal trên một original; không đảo chứng từ reversal. Sửa sai: đảo original, sau đó lập/post chứng từ đúng với ID mới.
- Nguồn nợ còn allocation active: chặn đảo nguồn. Phải đảo chứng từ thanh toán trước; không tự cascade thay đổi tiền/công nợ.
- Đảo bất kỳ chứng từ có outgoing allocations (payment/receipt **hoặc journal tổng quát**) giải phóng tất cả allocations của chính nó trong cùng transaction; không xóa allocation gốc. Nếu cùng chứng từ cũng tạo nguồn có incoming allocations active thì vẫn chặn đảo. Ngày đảo tuân fence ngày của mọi nguồn bị tác động.
- Đảo nguồn đã giải phóng hết phải có ngày không trước các lần giải phóng đó; không làm biến mất nguồn ở lịch sử trước khi thanh toán được đảo.
- Repeated same command trả lại cùng kết quả; command khác cố đảo lần nữa trả conflict, không thêm lines.

## 4. Báo cáo và đối chiếu

Mọi report chỉ đọc posted lines, bao gồm original **và** reversal đúng ngày; không filter bỏ original chỉ vì hiện tại đã reversed. Draft/cancelled draft không ảnh hưởng.

- Nhật ký: header/lines theo ngày, tham chiếu, actor, original/reversal links; phân trang, không trả toàn database.
- Sổ cái: số dư trước `from`, phát sinh Nợ/Có trong `[from,to]`, số dư cuối `to`; drill-down tới chứng từ.
- Bảng cân đối phát sinh: đầu kỳ Nợ/Có, phát sinh Nợ/Có, cuối kỳ Nợ/Có theo account. Số dư một tài khoản được trình bày một bên theo dấu; báo cáo toàn sổ phải cân ở cả đầu kỳ, phát sinh và cuối kỳ.
- Cash/bank: số dư và phát sinh từ các accounts purpose cash/bank, không phải dòng tiền pháp định.
- Công nợ: số dư theo party/account và từng dòng nguồn, số tiền gốc/đã phân bổ/còn lại. Tổng party phải bằng control account ledger cùng cutoff; số dư tại ngày không dựa trên trạng thái reversed hiện tại.
- Một report run có `asOfSequence` cố định cùng bộ lọc ngày. Post/reversal/backdated journal mới không đổi các trang thuộc run đang mở; Refresh tạo run mới. History dùng snapshots, không đọc tên/purpose master hiện tại làm thay đổi phân loại cũ.
- Tiền chứng từ là safe integer; tổng report dùng phép tính nguyên chính xác và trả chuỗi số nguyên để không overflow JavaScript Number. UI hiển thị VND không phần lẻ, không cộng totals bằng floating point.

## 5. Matrix chứng minh nghiệp vụ

Đây là scenario nghiệp vụ + verification contract, không phải kết quả đã chạy trên plugin.

| ID | Tình huống | Kết quả bắt buộc |
| --- | --- | --- |
| B01 | Draft AR Nợ/Revenue Có 1.000.000 | Ledger/công nợ chưa thay đổi |
| B02 | Post B01, rồi receipt 600.000 | AR 400.000, bank 600.000, revenue 1.000.000; source còn 400.000 |
| B03 | Expense Nợ/AP Có 800.000; trả 300.000 | Expense 800.000, AP 500.000; nguồn phải trả còn 500.000 |
| B04 | Opening bank 2.000.000 + AR customer 400.000 đối ứng equity 2.400.000 | Đầu kỳ và party khớp ledger; chưa có phát sinh doanh thu từ opening |
| B05 | Nợ/Có lệch, group/disabled account, party sai/thiếu, tiền phân số | Không post và không có financial side effect |
| B06 | Hai editor cùng revision draft | Một save thắng, save stale thất bại; form stale được giữ |
| B07 | Post cùng command/payload sau response mất | Đúng một journal/sequence/result; không thêm cash/AR |
| B08 | Command ID cũ với payload khác | Từ chối; không sửa kết quả cũ |
| B09 | Hai payment cùng tranh phần nợ 400.000; mỗi payment 300.000 | Tối đa một post thành công; không over-allocation |
| B10 | Fault sau insert lines nhưng trước commit | Header/lines/allocations/audit/command cùng rollback; draft trước lệnh còn nguyên |
| B11 | Đảo nguồn B02 khi receipt còn active | Chặn; số tiền không đổi |
| B12 | Đảo receipt, rồi đảo nguồn B02 theo đúng ngày | Sau receipt reversal AR trở về 1.000.000; sau source reversal AR/revenue/bank net 0; lịch sử còn đủ |
| B13 | Report cutoff trước reversal; rồi chạy tiếp pagination sau reversal | Kết quả run cũ không đổi; run mới bao gồm reversal đúng ngày |
| B14 | Allocation đầu tiên trước ngày nguồn; payment/generic allocation/reversal trước activity gần nhất | Từ chối trước mutation; same-day hợp lệ, report lịch sử không vượt nợ |
| B15 | Admin thật / anonymous / user không quyền / giả actor trong body / cross-origin | Chỉ session được cấp plugins:manage đọc/ghi; CSRF/giả actor bị chặn, không mutation |
| B16 | Restart/reopen database | Posted lines, allocations, command replay và VND giữ nguyên |
| B17 | Post report totals vượt Number.MAX_SAFE_INTEGER trong fixture | Tổng chuỗi chính xác; không rounded hoặc SQL floating total |
| B18 | Sửa/disable CRM master hoặc accounting master sau post | Snapshot lịch sử và số dư không đổi; chứng từ mới bị kiểm tra lại |
| B19 | Receipt 400.001 khi còn 400.000 hoặc phân bổ sai party/account | Chặn toàn lệnh; không ngầm thành ứng trước |
| B20 | Lần đảo thứ hai / đảo reversal / sửa SQL qua supported repository vào posted lines | Chặn; original/reversal bất biến |
| B21 | Generic journal có outgoing allocations; hoặc mixed journal vừa tạo source vừa settle nợ khác | Đảo generic giải phóng outgoing allocations; mixed còn incoming active phải chặn toàn lệnh, không release nửa chừng |

## 6. Delivery, vận hành và giới hạn

- Giữ plugin ID `erp-mini`; không tạo plugin Accounting shell hoặc bản fork EmDash/Frappe.
- Mọi thay đổi nguồn cần plugin check, host typecheck/build, built auth denial và browser workflow thật. Dev bypass chỉ chứng minh dev-mode, không thay thế production session/permission evidence.
- Không reset `.local`, credential hoặc key installation người dùng đã kiểm tra. Phát triển/tests dùng DB synthetic tách biệt.
- Backup/restore phải giữ accounting DB, EmDash DB, media và key cùng installation; xem thiết kế storage cho tính nhất quán và WAL. Không triển khai/publish từ nhiệm vụ thiết kế.
- Internal ledger không tự động đáp ứng chế độ kế toán/thuế Việt Nam. Tài liệu ERPNext là reference behavior, không copy GPL source vào package MIT.

## Tham khảo

- [Accounting Introduction](https://docs.frappe.io/erpnext/accounting-introduction)
- [Chart of Accounts](https://docs.frappe.io/erpnext/chart-of-accounts)
- [Journal Entry](https://docs.frappe.io/erpnext/journal-entry)
- [Porting/CAS boundary](porting.md)
