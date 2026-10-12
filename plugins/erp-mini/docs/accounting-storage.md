# Thiết kế lưu trữ và transport accounting

Trạng thái: **design, chưa triển khai**. Ngày 2026-10-12. Contract nghiệp vụ: [accounting.md](accounting.md). Kế hoạch: [implementation](../plans/261012-0715-accounting-internal-vn/plan.md).

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

## 2. Bằng chứng source pair

P = `plugins/erp-mini` trong checkout plugins; H = `themes/erp-mini` trong checkout themes. Pair: plugin `4b6f1e11f9b77fceae19b18fce8fc546d3811276`, theme `01f82bde4d99b9de6a93aef8ac133c346af3a953`; EmDash 1.2.0/Astro 7.3.5.

| Owner đã đọc | Evidence |
| --- | --- |
| P/src/service.ts:7-8,37-51,71-75,153-187 | Storage interface chỉ getVersioned/CAS/query; currency lock; quote/order nằm cùng một CAS aggregate |
| P/src/index.ts:17-45 | Authenticated actor và explicit plugins:manage ở native routes; options hiện currency-only |
| P/docs/porting.md:53-71 | Không private imports/core patch; cảnh báo cross-record transaction |
| Installed emdash/src/plugins/types.ts:271-311,1056-1121,1883-1905 | StorageCollection/PluginContext/RouteContext không có multi-record transaction hoặc snapshot/DB handle |
| Installed emdash/src/database/transaction.ts:28-64 | SQLite transaction nhưng fallback callback trực tiếp khi D1 không support; không dùng helper internal này cho finance |
| Installed emdash/src/astro/integration/virtual-modules.ts:301-305 | Native options được serialize thành runtime module |
| Installed emdash/src/runtime.ts và src/loader.ts:1563-1596 | getDb public trả configured Kysely; không chọn raw CMS DB cho accounting |
| Installed emdash/src/astro/middleware/auth.ts:182-262,488-507 | Custom /api routes chỉ soft session auth; endpoint mới phải tự require permission/CSRF |
| Installed @emdash-cms/auth/src/rbac.ts:84-129 | Public hasPermission; plugins:manage thuộc admin |
| H/astro.config.mjs:12-30; H/astro.cloudflare.config.mjs:16-34 | Node SQLite và CF D1/R2 là hai cấu hình; giữ dedupe/strictExecutionOrder |
| themes/restaurant-chain/src/pages/api/restaurant/[action].ts:13-21 | Pattern host locals.user/resources → plugin server export đã tồn tại; không copy branch/provider/guest scope |
| Installed emdash/src/astro/integration/index.ts:724-731 | injectRoute(prerender:false) hiện được dùng; Node-only route không cần nằm trong auto src/pages |

Installed source là bằng chứng phiên bản, **không** lời mời import `emdash/internal/*`. Runtime/accounting import public API và built-in Node.

## 3. Module/resource boundary đề xuất

- Plugin thêm các owners `src/accounting/model.ts`, `validation.ts`, `service.ts`, `reports.ts`, `http.ts`; pure domain/server entry `src/accounting/server.ts`, public subpath `@zerohost/plugin-erp-mini/accounting`.
- SQLite owner `src/accounting/sqlite.ts`, public Node-only subpath `@zerohost/plugin-erp-mini/accounting-node`; host truyền database/repository vào service bằng constructor/options explicit. Không import Node driver trong shared `src/index.ts`, admin, hoặc pure accounting server entry.
- Host thêm `src/server/accounting-resources.ts` và `src/server/accounting-endpoint.ts`, đăng ký từ Node-only `scripts/accounting-integration.mjs` bằng Astro injectRoute `/api/erp-mini/accounting/[action]`, prerender false. **Không đặt Node endpoint dưới src/pages**, vì CF cũng discover pages.
- Node integration capture currency/dataDirectory/canonical origin bằng cùng settings authority với Astro config; cung cấp cùng scalar payload vào virtual server module và generated settings manifest (dev `.astro/accounting-settings.json`, built `dist/accounting-settings.json`). Không có secrets trong manifest, không commit generated files. Built runtime không âm thầm dùng process env khác để reinterpret path/currency/origin. Module resource lazy-open một connection do host sở hữu, có close cho lifecycle dev/shutdown/test; không mở DB khi build hoặc import admin.
- Accounting path cố định `<ERP_DATA_DIR>/accounting.db`; không nhận path/tenantId/currency từ request. Separate file không có nghĩa shared multi-customer DB được hỗ trợ.
- Migration CLI bắt buộc chọn `--settings` manifest của target artifact/dev instance, không import virtual module từ plain Node. Relative dataDirectory resolve từ host release root sở hữu manifest, giống resource runtime; built start/dev launcher enforce đúng cwd/root hoặc fail trước DB access. Nếu env/settings hiện tại resolve path/currency/origin khác manifest thì từ chối trước khi mở file; không âm thầm migrate target mới. Artifact metadata/canonical resolved target được xác nhận trước mutation; test build tại A rồi đổi env sang B phải không tạo/migrate DB ở B. Missing manifest là prerequisite, không fallback sang `.env`.
- Shared descriptor chỉ thêm capability `accounting: true` khi Node host đã enable đúng wiring; CF false. Existing info/UI biết host capability, nhưng mọi accounting request vẫn require auth. Nếu enabled mà schema chưa migrate, trả lỗi setup thật; không giả trả bảng rỗng.
- Package exports/build/pack phải chứa pure server, Node driver và migrations; Node driver không kéo vào CF import graph. Nếu chưa chứng minh loại khỏi Worker bundle, không coi phase integration xong.
- Host trực tiếp import `@emdash-cms/auth` thì khai báo dependency pin **1.2.0** trong host manifest/lockfile; không dựa vào transitive hoisting. Chưa cài dependency trong nhiệm vụ thiết kế.

## 4. Transport/security contract

Host wrapper đọc `locals.user` được EmDash chứng thực; require user.id + `hasPermission(user,'plugins:manage')` **trước** resource access cho cả info/read/report/write. Actor/role/admin trong JSON bị schema reject. Không custom login, API token hoặc public ledger loader.

- Session-only, same-origin. No cross-origin credentialed CORS.
- Mọi request yêu cầu `X-EmDash-Request: 1`. POST yêu cầu Origin đúng **canonical configured public site origin**, JSON content-type và bounded body; không tin Host/Forwarded tùy ý. GET có Origin thì cũng phải match; GET cùng origin không có Origin vẫn cần header/session/permission.
- Allowed actions/methods khai báo một bảng, không dispatch arbitrary method name. GET `info`; POST `configure-book`, `list`, `get`, `report`, `save-account`, `save-party`, `link-customer`, `save-journal`, `cancel-draft`, `post-journal`, `reverse-journal`, `save-settlement`.
- Read POST vẫn phải qua guards. `save-settlement` chỉ tạo draft helper, `post-journal` mới làm financial posting. Client không gọi auto-post khi save.
- Read/list/report body tối đa 4096 bytes; command body tối đa 65536 bytes và tối đa 50 journal lines. Parse stream bounded kể cả thiếu Content-Length; validation strict theo existing Zod/error conventions.
- Private/no-store cho tất cả accounting responses. HTTP auth/config/method/body failures dùng outer `{success:false,error}` với 401/403/405/413/503 tương ứng; expected domain failures giữ `{success:true,data:{ok:false,error}}`, giống native ERP business envelope. Success `{success:true,data:{ok:true,data}}`.
- Reuse parseApiResponse và strict checking hai envelopes trong admin client; không dùng HTTP 200 như bằng chứng post thành công.
- Dự kiến domain codes: CONFLICT, INVALID_TRANSITION, UNBALANCED, ACCOUNT_UNAVAILABLE, PARTY_REQUIRED, OVER_ALLOCATION, ALLOCATION_DATE_CONFLICT, ACTIVE_SETTLEMENT, IDEMPOTENCY_CONFLICT, CURRENCY_MISMATCH, SCHEMA_VERSION, INVALID_CURSOR, INTERNAL_ERROR; messages không in SQL, file path, actor/session token hoặc stack.
- SQLITE_BUSY/commit I/O lỗi không tự blind retry mutation. Rollback nếu transaction còn active, giữ command intent, trả error an toàn; client tra receipt/replay cùng payload sau outcome chưa rõ.

## 5. Logical schema, không phải migration executable

Tất cả tables dưới đây nằm trong accounting.db, prefix `erp_ac_`; schema strict, foreign_keys ON; indexes bám query, không ledger mirror/cache riêng.

| Table | Fields và constraints chính |
| --- | --- |
| migrations | version PK, checksum, appliedAt; transactional additive migration, unknown/newer version fail closed |
| settings | singleton ID, schemaVersion, currency='VND', minorUnits=0, startDate, installationId; lock sau posting đầu |
| accounts | UUID PK, codeKey UNIQUE, name, rootType, purpose, isGroup, parentId FK, active, opaque revision, actor/time |
| parties | UUID PK, kind, codeKey UNIQUE theo kind, name, active, sourceKind/sourceId/sourceRevision nullable, source uniqueness, opaque revision |
| journals | UUID PK, number unique từ sequence, kind, status draft/cancelled/posted, postingDate, memo/reference, currency, revision, created/posted actor/time, postedSequence UNIQUE NULL trước post, reversalOf UNIQUE FK, snapshots |
| lines | journalId+lineIndex PK/FK, accountId FK, partyId FK nullable, role general/open-item/settlement/reversal do server chọn, snapshot code/name/root/purpose/party kind, debitMinor/creditMinor INTEGER, CHECK đúng một bên dương, mỗi bên ≤1e12 |
| allocations | settlement journal/line FK, source journal/line FK, amountMinor >0, uniqueness source+settlement line; append-only khi settlement posted |
| audit | append-only event ID, journalId/record identity, event, actor/time, sequence khi financial; không chứa secret; lưu cùng mutation |
| commands | commandId PK, action, actorId, canonicalPayloadHash, result journalId+revision/sequence; receipt immutable, cùng commit financial |

Indexes cần có: `(postingDate,postedSequence,id)` journals; `(accountId,journalId,lineIndex)` và `(partyId,accountId,journalId,lineIndex)` lines; allocations source FK pair/payment FK pair; `(reversalOf,postedSequence)`; account/party normalized code/name cho bounded search. Unique constraints phải thật, không chỉ service precheck.

Ledger **là posted journals + lines**, không thêm GL copy. Header original không đổi sang reversed; UI trạng thái reversed derive từ một reversal posted. This preserves as-of semantics.

Chỉ line role open-item AR Nợ/AP Có mới là source allocation. Reversal lines luôn role reversal, không sinh nguồn mới. Service/DB assertions kiểm purpose↔root type và role↔direction/account/journal kind; client không được tự gán role để bypass allocation.

Immutability được chặn trong repository và SQL triggers: không update/delete posted journal/lines; không insert thêm line vào posted header; không sửa/xóa/add allocation của posted settlement; không sửa command/audit. Cấm reparent/root/purpose changes của posted-used account; không đổi party.kind đã được dùng. Trigger bảo vệ supported write paths, không hứa chống operator tùy quyền sửa file SQLite.

Cross-row post trigger/assertion: đủ lines, bounded count, tổng Nợ/Có nguyên bằng nhau, snapshots/reference nhất quán, non-group/active account và đúng party cho lệnh mới. Reversal phải được server tạo full exact copy đổi bên từ original; chỉ case đó được bỏ active check, không bỏ FK/amount/balance check. Sequence cấp dưới write lock, không theo client clock.

## 6. Transaction algorithm

Node dùng `node:sqlite.DatabaseSync`, API có trên runtime 26.9.0 và baseline engines 24.15+. Không private EmDash driver. WAL, foreign_keys, defensive mode; busy timeout bounded rõ trong implementation. Synchronous transaction callback, không await/fetch/CRM I/O bên trong.

### Post journal

1. Auth/CSRF/body/schema và xác nhận installation currency thực hiện trước DB mutation. Chọn server actor; canonical hash object keys deterministic, **giữ thứ tự arrays** và bao gồm action/target/revision/payload, không gồm generated timestamps.
2. `BEGIN IMMEDIATE`. Receipt đã có: cùng actor/action/hash trả đúng result sau khi authorize; khác trả IDEMPOTENCY_CONFLICT. Lookup receipt **trước** stale revision/state check để replay sau thành công không bị CONFLICT giả.
3. Đọc draft theo ID/revision, require draft/currency/schema; đọc và validate accounts/parties ngay dưới write lock, lấy snapshots. Master changes và post serialized trên cùng DB.
4. Kiểm tra whole journal bằng integer/BigInt, never floating rounding. Kiểm tra allocations **grouped per source và payment line**, đúng party/account/opposite side, source posted chưa reversed, remaining operational và date fence.
5. Insert/update prepared lines/snapshots/allocations, cấp next postedSequence, chuyển header posted bằng revision check; DB assertions/triggers chạy trước transition. Source balance không ghi thành cache thứ hai.
6. Insert audit và receipt, `COMMIT`. Chỉ trả success sau commit. Any error rollback mọi thay đổi của lệnh; giữ draft từ trước khi lệnh chạy. SQLite write lock mới là fence, không process-local mutex.

### Reverse

Cùng transaction/receipt flow. Validate original posted, not reversal, chưa có reversal khác. Check active incoming allocations cho mọi open-item source trong original; nếu còn thì chặn. Đảo **mọi journal có outgoing allocations**, không chỉ payment kind, giải phóng allocations bằng link reversal mới, không DELETE/update. Mixed journal có cả source và settlement vẫn phải qua incoming guard và release outgoing atomically. Fence ngày là max(source postingDate, mọi allocation/release dates đã post) cho từng nguồn, kể cả allocation đầu tiên. Dựng lines role reversal từ snapshot gốc đổi debit/credit, ghi reversal/audit/receipt cùng commit. Không auto cascade hoặc retry với command ID mới.

### Snapshot reports

- First request capture max postedSequence tại một read transaction ngắn; report token chứa immutable asOfSequence + filters + keyset. Validate version/filter match và bounds, không cho cursor bỏ qua auth; không giữ DB transaction mở qua nhiều HTTP requests.
- Sau đó chỉ đọc append-only posted lines/journals `sequence <= cutoff`. Reversal và allocation-effect predicates **cũng** phải dùng cùng sequence cutoff và `postingDate <= to` khi tính report theo ngày. Không join master mutable để phân loại lại history.
- Existing drafts thay đổi không thuộc dataset. Backdated posting mới có sequence lớn nên không lọt run cũ. Report membership/keyset ổn định vì posted rows immutable; Refresh tạo cutoff mới.
- General ledger/trial balance include originals + reversals, tuyệt đối không loại original dựa trên latest reversed state. Open-source debt as-of = source amount trừ effective allocations ở cutoff, hoặc 0 sau source reversal tại cutoff; cross-check với sum control lines.
- SQL amounts mỗi line bounded; journal sums ≤50e12. Report lifetime tổng có thể vượt JS safe/SQLite SUM 64-bit: không dùng SQLite REAL `total()` hoặc unchecked unrestricted `SUM`. Stream indexed rows theo bounded pages, accumulate `BigInt`, giữ integer không rounded, trả aggregate decimal strings. Page size 25 như ERP hiện tại; intermediate aggregate memory theo account/party có pagination/server bounds, không tải toàn bộ ledger vào array. Timeout/capacity thực cần đo, không hứa fleet scale.

## 7. Currency, migration và vận hành

- CRM giữ currency lock của ErpService. Host sau auth dùng public `emdash/runtime.getDb()` và exported `PluginStorageRepository` để lấy scoped records namespace erp-mini (constructor db/pluginId/collection/indexes), truyền read/storage interfaces vào plugin source helper; không query raw CMS tables hoặc private import. Reuse persisted schemas và ErpService currency guard, không copy validation/index convention. CRM reads hoàn tất ngoài accounting write transaction.
- `accounting:migrate` chỉ áp dụng schema, không fabricate user actor hoặc tạo book settings. Authenticated POST `configure-book` xác nhận CRM VND và operator startDate, tạo settings với revision/actor; missing settings chỉ cho info/setup actions, financial commands trả prerequisite. Nếu CRM chưa initialized, chỉ explicit admin setup được gọi existing ErpService.info để initialize đúng currency; không đổi installation đã dùng. Host capability không override saved lock.
- Settings accounting ghi VND/startDate một lần. Endpoint fail closed nếu host build currency, CRM lock hoặc accounting currency bất đồng. Không cần atomic distributed currency migration vì không hỗ trợ đổi currency; không viết tiếp vào một DB sau khi check mismatch.
- Migrations là plugin-owned files + checksums, explicit host script dự kiến `accounting:migrate -- --settings <target-manifest>` (chưa là script hiện hữu). CLI chỉ dùng captured target sau kiểm tra manifest/path parity ở §3, không recompute một target mới từ env. Fresh schema transaction atomic; interrupted migration không để version tiến mà tables thiếu. Re-run cùng checksum no-op; checksum khác/newer schema từ chối.
- Build/typecheck/import không migrate hoặc seed database. Resource runtime xác minh schema rồi mới phục vụ; missing schema trả setup prerequisite, không tự reset. StartDate/operator accounts/opening không tự seed từ fixture.
- Giữ `.local`, `.env`, key và credential hiện tại; migration additive không thay EmDash schema hoặc CAS records. Unknown data version phải dừng, không hạ requirement hoặc auto overwrite.
- Backup thống nhất: dừng/quiesce host cả CRM và accounting; dùng SQLite backup API hoặc checkpoint/backup-aware copy cho mỗi DB, media và key. Không copy riêng accounting.db đang ghi rồi bỏ WAL. Restore pair vào installation isolated, verify số dư, command replay và CRM links trước dùng lại.
- Rollback source không undo schema; giữ artifact/schema compatible hoặc restore verified backup pair. Unregister accounting UI/route giữ DB/history; destructive erasure cần operator approval riêng.
- Node-only route/resource không được kéo vào CF. CF vẫn chạy CRM/sales, accounting absent/disabled capability rõ, không giả dùng CAS thay transaction. D1 accounting cần thiết kế/batch fences và QA riêng, không thuộc plan này.

## 8. Verification thiết kế đã chạy

Probe throwaway dưới `/tmp`, DB synthetic riêng, không đọc `.env` hoặc `.local` của người dùng; Node **26.9.0**. Không phải implementation plugin, production schema, EmDash HTTP/auth hoặc browser accounting test.

Observed: 4 posted journals sau source+receipt+hai reversals. Các assertions đã pass:

1. Post AR/Revenue 1.000.000 và receipt 600.000 → AR 400.000, revenue -1.000.000 theo debit-credit, bank 600.000.
2. asOfSequence trước receipt giữ AR 1.000.000; cutoff trước payment reversal giữ còn nợ 400.000 dù current đã đảo.
3. Same command/payload replay không thêm journal; changed payload cùng command bị chặn.
4. Over-allocation 500.000 khi remaining 400.000 rollback, không leak header.
5. Fault sau lines rollback header/lines/receipt; lệch Nợ/Có, group account và thiếu party bị chặn.
6. Update posted line bị trigger chặn; đảo source đang settled bị chặn.
7. Đảo receipt trả nợ về 1.000.000; đảo source sau đó net AR/revenue/bank 0, history còn đủ; đảo lần nữa bị chặn.
8. Hai SQLite connections: connection thứ hai không lấy được BEGIN IMMEDIATE khi writer thứ nhất giữ lock; sau release lấy được lock.
9. Close/reopen file giữ 4 posted journals và balances.

Probe reduced thứ hai sau review cũng pass 4 nhóm: allocation đầu tiên trước nguồn bị từ chối và rollback; đảo generic journal giải phóng outgoing mà không tạo source mới; mixed journal còn incoming chặn đảo và giữ outgoing nguyên; date fence bao gồm release dates và cho same-day. Đây là mô hình allocation/reversal SQLite tách biệt, không service/schema production.

Hai reviewer độc lập đã yêu cầu sửa ba điểm: ngày nguồn trong fence, outgoing allocations của generic/mixed journal, và target manifest cho migration CLI. Đã sửa spec/storage/phases; lượt review correction không còn findings. Configure-book được đặt ở phase1 để masters phase2 không phụ thuộc setup chưa có.

Document validation: 9 docs/plan files, 26 relative links đều tồn tại, không còn template placeholders. AgentKit plan validate pass; implementation checkboxes vẫn pending. Probe scripts/databases được xóa sau ghi evidence, không đưa vào package.

**Chưa chứng minh trên implementation thật:** full production schema/triggers, saved draft revision behavior, canonical hash/actor receipt scope, payable/opening flows, chronology fence/generic reversal trong service, aggregate vượt safe integer, multi-process stress/crash recovery, Node24 gate, migration artifact target A→B, host build/CF exclusion hoặc production auth/UI. Các kiểm tra này là acceptance gates trong phases, không ghi là đã pass.

## Nguồn public

- [SQLite transactions](https://www.sqlite.org/lang_transaction.html): BEGIN IMMEDIATE, một writer, read snapshot, rollback khi lỗi.
- [Node 26.9 SQLite API](https://nodejs.org/download/release/v26.9.0/docs/api/sqlite.html): DatabaseSync built-in, integer conversion.
- [Astro Integration API](https://docs.astro.build/en/reference/integrations-reference/): injectRoute; installed EmDash source chứng minh API trên baseline.
- [ERPNext reference/licensing boundary](porting.md).
