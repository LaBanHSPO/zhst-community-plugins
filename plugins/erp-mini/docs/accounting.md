# Đặc tả accounting nội bộ — ERP mini

Trạng thái: **thiết kế để triển khai, chưa có module accounting trong runtime**. Ngày: 2026-10-12. Đọc cùng [thiết kế lưu trữ](accounting-storage.md) và [kế hoạch triển khai](../plans/261012-0715-accounting-internal-vn/plan.md).

## 1. Outcome và nguồn yêu cầu

Người dùng đã xác nhận môi trường CRM/sales chạy OK; đối tượng là doanh nghiệp nhỏ/rất nhỏ; ưu tiên ghi sổ nội bộ; đã chọn **ghi sổ kép, có công nợ** thay vì chỉ tiền thực thu/chi. Không chạy lại setup để xác nhận quan sát này.

Outcome: người quản trị ghi nhận nghiệp vụ khi phát sinh, thu/trả tiền từng phần, sửa sai bằng chứng từ đảo; đối chiếu được nhật ký, sổ cái, bảng cân đối phát sinh, tiền và công nợ trên cùng dữ liệu đã ghi sổ.

Baseline: [README](../README.md) và `src/model.ts`, `src/service.ts`, `src/index.ts` hiện chỉ có customers/items/quotations/orders. Quotation, accepted/fulfilled order không chứng minh doanh thu, thanh toán hay ghi sổ.

Các lựa chọn còn lại bên dưới là **quyết định thiết kế đề xuất**, không phải quy định kế toán Việt Nam hoặc yêu cầu pháp lý đã được người dùng xác nhận. Không có baseline về số chứng từ, thời gian nhập liệu hoặc capacity; không bịa mục tiêu hiệu năng.

## 2. Boundary

- Một installation = một doanh nghiệp. Installation này VND; mọi giá trị chứng từ là số nguyên đồng.
- EmDash vẫn sở hữu danh tính/session/passkey. Mọi đọc/ghi/report accounting chỉ cho người có `plugins:manage`; giữ admin-only hiện hữu, không thêm quy trình duyệt nhiều cấp.
- Scope: hệ thống tài khoản; khách hàng/nhà cung cấp kế toán; số dư đầu kỳ; bút toán thủ công; thu/chi thanh toán công nợ từng phần; đảo; nhật ký/sổ cái/bảng cân đối phát sinh/số dư tiền/công nợ.
- Runtime triển khai được chọn: Node SQLite local/standalone. Cloudflare CRM/sales hiện hữu được giữ; accounting Cloudflare không được quảng cáo là supported. Không cần cloud credentials hay deployment.
- Non-goals: VAT/tax, hóa đơn điện tử, invoice pháp định, tồn kho/giá vốn, ngoại tệ, payroll, tự ghi sổ từ order, hợp nhất công ty, fiscal closing và báo cáo pháp định.
- Thu/trả vượt nợ, ứng trước, bù trừ công nợ và nghiệp vụ giảm nợ không qua đảo chưa nằm trong luồng thu/chi đã chọn; lệnh ngoài phạm vi phải bị từ chối rõ, không tự biến thành doanh thu/chi phí. Bút toán tổng quát không có công nợ vẫn dùng được.
- Không chọn bộ mã tài khoản theo một chế độ pháp định. Tài khoản nội bộ do người vận hành thiết lập; fixture dùng mã mô tả, không tự nhận là localization Việt Nam.

## 3. Quy trình và thông tin

### 3.1. Thiết lập sổ và tài khoản

- Chọn ngày bắt đầu sổ `startDate` trên installation accounting mới; sau bút toán đầu tiên không đổi ngày/currency qua settings. Muốn thay đổi phải có kế hoạch migration.
- Tài khoản có ID ổn định, code duy nhất sau chuẩn hóa, tên, root type asset/liability/equity/income/expense, group/ledger, parent, active và purpose general/cash/bank/receivable/payable.
- Group không nhận bút toán; parent phải là group cùng root type; không được tạo chu kỳ cây. Không có parent chuyển root ngầm.
- Purpose cash/bank/receivable chỉ cho ledger root asset; payable chỉ cho ledger root liability. Group chỉ purpose general. Không cho purpose sai root khiến báo cáo tiền/công nợ bị phân loại sai.
- Sửa tên/code giữ ID và snapshot lịch sử. Khi tài khoản có lịch sử, không đổi root/purpose/group/parent; có thể ngừng dùng. Không hard-delete tài khoản được tham chiếu.
- Disabled tài khoản chặn chứng từ mới, nhưng vẫn hiện báo cáo/lịch sử. Đảo chính xác chứng từ cũ vẫn được phép với account/party đã disabled; không cho mượn ngoại lệ này để post bút toán mới tùy ý.

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
