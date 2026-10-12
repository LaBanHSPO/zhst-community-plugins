# Lưu trữ, transport và vận hành accounting

Hướng dẫn cho accounting nội bộ **Node/VND** đã triển khai. [Contract nghiệp vụ](accounting.md) giữ các yêu cầu B01–B21 và non-goals; tài liệu này giữ quyết định storage, ranh giới host và quy trình vận hành, không phải release evidence hoặc chứng nhận kế toán/thuế.

## 1. Quyết định và trade-offs

Chọn **host-owned SQLite accounting riêng, transaction thực, domain/server exports thuộc ERP mini**, UI trong workspace hiện có. CMS/CRM tiếp tục dùng EmDash storage; accounting không phụ thuộc schema nội bộ của CMS.

| Phương án | Giả định và điểm hỏng đầu tiên | Quyết định |
| --- | --- | --- |
| Journal aggregate trong plugin storage, mỗi journal một CAS | Post một journal cân bằng là atomic; settlement/reversal/account guards và snapshot báo cáo nhiều record không có primitive transaction/global watermark | Loại: không đáp ứng toàn bộ consistency contract |
| Một record chứa toàn bộ ledger | Một CAS giữ mọi invariant nhưng copy/parse/write ledger tăng không giới hạn, conflict toàn installation và request/storage bounds | Loại: tránh thiết kế không bounded |
| Public `emdash/runtime.getDb()` + transaction Node, thêm schema accounting vào CMS DB | API public có thật nhưng RouteContext không inject transaction; coupling schema/backup/lifecycle CMS, và D1 driver không hỗ trợ callback transaction | Không chọn dù có thể làm Node; tránh đụng owner migrations CMS |
| SQLite riêng + host transport | Node/writable durable directory, một transaction trong một file; phải tự giữ auth/CSRF và thêm resource lifecycle | Chọn: rõ owner, có transaction và SQL/indexes bounded, reuse pattern host→plugin/server đã có trong restaurant |

Better approach so với dùng CAS cho ledger: transaction SQLite giữ header/lines/allocations/audit/command chung một commit. Đổi transport và thêm DB là chi phí cần cho invariant; không thêm framework/ORM/DI container/queue/event broker.

Không truyền DB/function trong `erpMiniPlugin(options)`: options được JSON.stringify. Plain JSON capability flag được phép; credential, connection hoặc actor không được nhét vào options. Không dùng global singleton registry để âm thầm inject runtime từ build.

## 2. Owners và ranh giới runtime

P = `plugins/erp-mini` trong checkout plugins; H = `themes/erp-mini` trong checkout themes. Chọn và ghi rõ source pair/artifact khi vận hành; không dùng một branch companion đang di chuyển làm chứng cứ compatibility.

- [`package.json`](../package.json) khai báo hai exports: `@zerohost/plugin-erp-mini/accounting` qua [`server.ts`](../src/accounting/server.ts) không import Node driver; `@zerohost/plugin-erp-mini/accounting-node` qua [`sqlite.ts`](../src/accounting/sqlite.ts) sở hữu SQLite và migration. Không import Node entry vào admin/shared descriptor hoặc Cloudflare.
- [`model.ts`](../src/accounting/model.ts), [`validation.ts`](../src/accounting/validation.ts), [`service.ts`](../src/accounting/service.ts) và [`reports.ts`](../src/accounting/reports.ts) là owners cho commands, immutable financial receipts, allocation/reversal và snapshot reports. [`0001_accounting.sql`](../migrations/0001_accounting.sql) là schema/triggers executable; không chỉnh checksum của migration đã áp dụng để sửa dữ liệu.
- [`http.ts`](../src/accounting/http.ts) và [`admin/api.ts`](../src/admin/api.ts) sở hữu action/method/body/envelope contract. HTTP 200 không tự chứng minh financial success.
- H `scripts/accounting-integration.mjs`, `scripts/accounting-settings.mjs`, `src/server/accounting-resources.ts` và `src/server/accounting-endpoint.ts` sở hữu captured scalar settings, Node-only route, resource lifecycle và quyền. Dùng hướng dẫn của paired theme cho lệnh khởi chạy/migration; không copy settings hoặc auth wrapper sang plugin.

Accounting dùng `<ERP_DATA_DIR>/accounting.db`, riêng với CMS/CRM. Không nhận database path, tenant selector hay currency từ request. Một installation vẫn là một doanh nghiệp. Transactions không bao gồm CRM I/O; [`erp-source.ts`](../src/accounting/erp-source.ts) sở hữu one-time CRM customer link, không hứa cập nhật master đồng thời giữa hai DB.

Host chỉ cho enabled native ERP mini và EmDash user thật có `plugins:manage` truy cập accounting. Session-only, canonical same-origin, `X-EmDash-Request: 1`, không bearer/API-token context; responses private/no-store. Capability/UI không thay thế authorization. Disable plugin phải chặn route kể cả khi connection đã mở. Không dùng private EmDash imports hoặc patch core để vượt các guard.

## 3. Financial outcome chưa rõ

[`admin/accounting/intent.tsx`](../src/admin/accounting/intent.tsx) sở hữu exact persisted session intent và recovery UI; [`service.ts`](../src/accounting/service.ts) sở hữu receipt/replay theo command, actor và payload. Khi mất response, reload, lỗi commit hoặc acknowledgment không hợp lệ:

1. Giữ nguyên browser session và exact action/payload/command ID đã lưu. Không xóa session storage, sửa revision/payload, tạo UUID thay thế hoặc mở tab khác để post lại ý định đó.
2. Dùng **Retry / reconcile exact command** trong cùng installation để nhận lại kết quả immutable (`id`, `revision`, `postedSequence`). Không coi journal mutable hiện tại hoặc response HTTP 200 là receipt.
3. Nếu `IDEMPOTENCY_CONFLICT`, đăng nhập lại **original actor** mà không đổi intent. Actor khác hoặc payload khác không có quyền nhận kết quả bằng cách thay command ID. Nếu vẫn conflict, bảo toàn session và chuyển operator đối chiếu receipt/audit bằng quyền được cấp; không sửa trực tiếp DB.
4. Intent hỏng hoặc storage không dùng được chặn sending. Không tự dựng lại payload từ form; operator phải đối chiếu kết quả thật trước khi quyết định bước tiếp theo. Session intent không phải backup của sổ.

Posted history, snapshots, audit và financial receipts là bất biến. Sửa sai nghiệp vụ dùng full reversal rồi chứng từ đúng mới, không update/delete original hoặc receipts.

## 4. Currency, migration và vận hành

- CRM giữ currency lock của ErpService. Host sau auth dùng public `emdash/runtime.getDb()` và exported `PluginStorageRepository` để lấy scoped records namespace erp-mini (constructor db/pluginId/collection/indexes), truyền read/storage interfaces vào plugin source helper; không query raw CMS tables hoặc private import. Reuse persisted schemas và ErpService currency guard, không copy validation/index convention. CRM reads hoàn tất ngoài accounting write transaction.
- `accounting:migrate` chỉ áp dụng schema, không fabricate user actor hoặc tạo book settings. Authenticated POST `configure-book` xác nhận CRM VND và operator startDate, tạo settings với revision/actor; missing settings chỉ cho info/setup actions, financial commands trả prerequisite. Nếu CRM chưa initialized, chỉ explicit admin setup được gọi existing ErpService.info để initialize đúng currency; không đổi installation đã dùng. Host capability không override saved lock.
- Settings accounting ghi VND/startDate một lần. Endpoint fail closed nếu host build currency, CRM lock hoặc accounting currency bất đồng. Không cần atomic distributed currency migration vì không hỗ trợ đổi currency; không viết tiếp vào một DB sau khi check mismatch.
- Migration explicit ở H: `npm run accounting:migrate -- --settings <target-manifest>`, owner `scripts/migrate-accounting.mjs`. Chạy từ root của đúng Node release; chọn `.astro/accounting-settings.json` cho dev hoặc `dist/accounting-settings.json` cho built artifact. Manifest phải do đúng integration/artifact sinh ra, không tự sửa hoặc fallback sang env. CLI dùng captured target sau khi kiểm tra root/path/currency/origin parity; drift, missing manifest, checksum sai, unknown/newer schema đều fail closed. Re-run cùng schema/checksum không tạo book hoặc seed nghiệp vụ.
- Build/typecheck/import không migrate hoặc seed database. Resource runtime xác minh schema rồi mới phục vụ; missing schema trả setup prerequisite, không tự reset. StartDate/operator accounts/opening không tự seed từ fixture.
- Giữ `.local`, `.env`, key và credential hiện tại; migration additive không thay EmDash schema hoặc CAS records. Unknown data version phải dừng, không hạ requirement hoặc auto overwrite.
- **Paired capture:** quiesce/dừng mọi writer của cả CMS/CRM và accounting trong cùng installation, không chỉ đóng tab. Lưu CMS `emdash.db`, `accounting.db`, media và bản sao bảo vệ của installation encryption key/config/resource mapping cùng release artifacts/lockfiles/captured settings/schema checksums. Key giữ trong restricted secret storage, không trong Git hoặc evidence công khai.
- Dùng SQLite backup API hoặc quy trình checkpoint/backup-aware capture trong khi writers vẫn quiesced. Không copy một file `.db` đang ghi rồi bỏ WAL; nếu capture file set có WAL thì giữ bộ nhất quán theo công cụ backup, không trộn DB/WAL từ thời điểm khác. Hai DB không có distributed transaction; khoảng quiesce là ranh giới nhất quán cho paired capture.
- **Restore rehearsal:** restore toàn bộ pair vào installation/resources isolated, dùng đúng artifact/schema và key tương ứng; điều chỉnh target qua cấu hình/build được review, không hand-edit generated manifest. Đối chiếu CRM links, posted history/balances, reports và same-command recovery trước khi mở traffic. Một backup chưa restore không phải chứng cứ recovery.
- **Rollback:** source rollback không undo schema. Chỉ khởi chạy artifact tương thích schema hoặc restore approved paired capture; đối chiếu các writes sau capture trước khi mở traffic. Không đổi currency/startDate, xóa DB/WAL, blank settings, sửa migration checksum hay bỏ schema/revision guard để downgrade.
- Disable plugin, bỏ registration/UI hoặc gỡ accounting route giữ CMS records và accounting DB/history/audit/receipts. Giữ dữ liệu và backup theo chính sách retention đã được chấp thuận; uninstall không phải erasure. Xóa dữ liệu cần thủ tục destructive riêng được operator/customer cho phép.
- Node-only route/resource không được kéo vào CF. CF vẫn chạy CRM/sales, accounting absent/disabled capability rõ, không giả dùng CAS thay transaction. D1 accounting cần thiết kế/batch fences và QA riêng, không thuộc plan này.

## 5. Acceptance và release evidence

[`tests/accounting.test.ts`](../tests/accounting.test.ts) và [`tests/accounting-reports.test.ts`](../tests/accounting-reports.test.ts) là executable behavior owners; matrix B01–B21 trong [business contract](accounting.md) là business acceptance surface. [Compatibility operations](compatibility.md) giữ các cổng paired artifact/runtime.

Ghi kết quả từng cổng với exact source pair/runtime/artifact trong release record: schema migration và drift rejection, original-actor recovery, permission/disable boundary, immutable history, restore rehearsal, packed migrations và Cloudflare exclusion. Không suy ra đã pass từ design probe, build thành công, unit tests hoặc tài liệu này. Accounting Cloudflare không được hỗ trợ; CRM/sales Worker acceptance vẫn là cổng riêng.

## Nguồn public

- [SQLite transactions](https://www.sqlite.org/lang_transaction.html): BEGIN IMMEDIATE, một writer, read snapshot, rollback khi lỗi.
- [Node 26.9 SQLite API](https://nodejs.org/download/release/v26.9.0/docs/api/sqlite.html): DatabaseSync built-in, integer conversion.
- [Astro Integration API](https://docs.astro.build/en/reference/integrations-reference/): injectRoute; installed EmDash source chứng minh API trên baseline.
- [ERPNext reference/licensing boundary](porting.md).
