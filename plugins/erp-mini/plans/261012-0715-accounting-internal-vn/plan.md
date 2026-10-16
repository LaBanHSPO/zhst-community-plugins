---
title: "Accounting nội bộ VND cho ERP mini"
description: "Ghi sổ kép, công nợ và báo cáo nhất quán cho doanh nghiệp nhỏ/rất nhỏ; Node SQLite, không statutory accounting."
status: completed
priority: P1
effort: ""
tags: [erp-mini, accounting, vnd, sqlite]
created: 2026-10-12
---

# Accounting nội bộ VND cho ERP mini

## Overview

Đã triển khai đủ sáu phase accounting nội bộ VND trên Node: storage/transport, masters, journals/opening/reversal, thu/chi/phân bổ, năm báo cáo snapshot và packed-artifact/restore QA. Hoàn tất implementation và kiểm chứng local, **không phải publication/deployment hoặc chứng nhận kế toán pháp định**.

Người dùng đã kiểm tra môi trường OK, xác nhận doanh nghiệp nhỏ/rất nhỏ, ghi sổ nội bộ và chọn ghi sổ kép có công nợ. Giữ scope này; không làm tax/einvoice/inventory/FX/statutory reports hoặc auto-post orders.

- [Đặc tả nghiệp vụ và scenario B01–B21](../../docs/accounting.md)
- [Storage/transport và quy trình vận hành](../../docs/accounting-storage.md)
- P = package plugin này; H = sibling `zhst-community-themes/themes/erp-mini`.
- Source pair: plugin branch `feat/erp-mini-accounting-vn` từ docs commit `5ee2391be665c7ab476549cf44252e06d1a76bfe`; theme branch `dev/erp-mini-accounting-vn` từ docs commit `c89c470d907cc784a4405b9863d0e0b0ee8dd50d`. Implementation được xác định bằng các accounting feature commits trên hai branch này, không dùng baseline docs commit như implementation revision. Người dùng đã cho phép commit; push/publication/deployment chưa được cho phép.
- Baseline EmDash 1.2.0/Astro 7.3.5; Node 26.9.0/npm 11.19.1 và Node 24.15.0 đã chạy thực. Engines/pins vẫn theo manifests.

## Architecture và execution contract

React admin ERP mini → Node-only host endpoint → plugin accounting service → accounting.db SQLite transaction. Host attests actor bằng session EmDash/plugins:manage. Domain và UI vẫn thuộc plugin `erp-mini`; không fork core/Frappe.

Giữ CMS/CRM storage hiện tại. Không distributed write giữa CRM CAS và accounting. CF vẫn CRM/sales, accounting disabled rõ; không Node driver trong Worker import graph, không fake financial fallback.

Theo thứ tự 1→6, một integration owner. Mỗi phase chỉ xong sau tests liên quan **và** runtime/browser smoke của path mới; phase boundary không phải permission publish/deploy. Không seed/reset `.local`, key hay credential người dùng. Fixture dùng installation riêng.

Trước thay đổi exported symbols, chạy LSP references; giữ current callers/contracts hoặc cut over đầy đủ. Không import private EmDash internals. Reuse integer validation, ErpError, two-envelope client, dirty/pending/revision guards.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Storage và transport Node](./phase-01-start.md) | Completed |
| 2 | [Tài khoản và đối tượng công nợ](./phase-02-accounts-parties.md) | Completed |
| 3 | [Bút toán, đầu kỳ và đảo](./phase-03-journals-opening-reversal.md) | Completed |
| 4 | [Thu/chi và phân bổ](./phase-04-payments-allocations.md) | Completed |
| 5 | [Báo cáo và đối chiếu](./phase-05-reports.md) | Completed |
| 6 | [Packed artifact, compatibility và vận hành](./phase-06-release-verification.md) | Completed |

## Success Criteria

- [x] Luồng AR 1.000.000 → thu 600.000 cho ledger/công nợ khớp 400.000; AP/opening cũng được chứng minh.
- [x] Financial writes atomic/idempotent, posted history immutable, partial allocation/reversal đúng, stale/denied calls không mutation.
- [x] Reports snapshot và money totals chính xác; restart/restore giữ balances và receipt replay.
- [x] Node built session/CSRF/permission/browser pass; CF CRM/sales không regress, accounting không được quảng cáo supported.
- [x] Source pair/lockfiles/artifact provenance và mọi environmental limits được ghi đúng, không suy production accounting compliance.

## Validation log implementation — 2026-10-12

- P `npm run check`: typecheck, **52/52 tests** (35 accounting/report + 17 native ERP) và build pass. Hai accounting suites chạy lại bằng Node **24.15.0: 35/35 pass**. Real SQLite migrations, fault rollback, immutable history, independent writer processes, chronology và generic/mixed reversal B21 được kiểm chứng; không lấy design probes thay acceptance.
- Baseline compatibility với **đúng H working tree**: isolated `npm ci`, plugin/host checks, packed installation, explicit Node VND migration, built Node home200/native anonymous401/accounting401 và actual local Worker home200/native401/accounting404 pass. Không chạy latest-core upgrade hoặc deploy.
- Runtime-tested plugin tarball `@zerohost/plugin-erp-mini@0.1.0` SHA-256 `c9bb2a34a08affe6e0ad1547493e93d1cf520a40027288befd727854ff02a020`: physical install, exports/migration present; xóa disposable sibling plugin source rồi host typecheck/build/browser vẫn pass. Digest này định danh tarball chạy QA, không định danh một release đã publish; docs/plan hoàn tất sau QA.
- Real EmDash passkey sessions, không dev bypass/auth DB edits: admin thành công, anonymous401/lower-role403, forged actor/CSRF/origin/method/query/oversize/token denied. Disable ERP mini chặn cả reads và valid financial/master commands bằng404, không mutation; re-enable giữ sổ.
- Browser actual masters/CRM link, duplicate/stale account và journal forms, explicit revision reload giữ edits, opening, post/reverse, partial receipt/payment và cả năm reports pass. Viewport375px/keyboard table scrolling được quan sát. AR1m/thu600k còn400k; AP800k/chi300k còn500k.
- Unknown outcome kiểm chứng sau **real commit** với lost response/malformed acknowledgment; exact replay không double-post. Corrupt stored payload, different actor, storage set/remove failures giữ hoặc chặn đúng intent. Ba recovery regressions và activation bypass đã reproduce-before/fix/confirm-after.
- Journal report33 lines: page25 + page8 giữ `asOfSequence=16` qua backdated post và reversals mới17–19; refresh lấy19. Historical cutoff không lộ reversal tương lai. Exact total `9050000000000001` từ362 real50-line posted journals; AR/AP controls, opening/movements/closing và cash flows reconcile.
- Quiesced paired capture CMS/accounting/media/key/artifacts → restore sang thư mục độc lập → rebuild/capture settings/migrate → actual Node24.15 host. Original data path không còn; cả **5 report JSON**, installation/VND/startDate, CRM source revision, media hash và4 post/reversal receipts giống hệt. Receipt replay không thêm command/audit/sequence. Snapshot là fixture riêng, không dữ liệu người dùng.
- Packed CF build graph557 server modules không có `node:sqlite`/accounting-node; actual local packed Worker home200/native401/accounting404. Node accounting không supported trên CF.
- Financial/security/UX review hoàn tất và findings đã xử lý. LSP không được cấu hình trong environment; đã dùng explicit caller/source inspection, compiler và runtime proof thay vì claim references query đã pass. README/contributor/storage/compatibility/porting được cập nhật; credentials và evidence chỉ dùng synthetic installation.
- Final documented `npm pack` SHA-256 `f0e8ec9a5a1985178f216c77edb32dce6fa405b994a3406842ae50dabadb7d2a`: so sánh archive xác nhận **38 src/dist/migration files byte-identical** với tarball đã chạy toàn bộ QA; package runtime manifest giống hệt ngoài description. Pure/Node exports và SQL asset vẫn có đủ. Docs thay đổi không được mô tả như một runtime run khác.
- Final documentation validation: **17 Markdown files, 110 relative links, 0 broken**. Không để status pending/todo hoặc acceptance unchecked trong bảy plan files.

## Startup migration change — 2026-10-13

- Người dùng yêu cầu không phải migrate thủ công khi cài plugin. Chọn paired Node startup, không browser reload/postinstall/build: dev server-setup hook và built `scripts/start.mjs` gọi migration owner với captured manifest trước listen. Standalone CLI giữ cho operator; không auto configure book/actor/StartDate/masters/opening.
- Physical plugin tarball trong host isolated: typecheck0 errors/warnings/hints và build pass; accounting DB chưa tồn tại sau install/typecheck/build. Fresh built Node26 và fresh dev tự tạo schema hợp lệ, settings/journals/commands/audits đều0 trước synthetic fixture.
- Seed synthetic posted journal/receipt rồi restart: built Node24.15 và actual dev restart giữ digest toàn bộ9 tables; replay original command trả đúng receipt, không thêm audit/command/sequence.
- Actual built startup với checksum sai hoặc version mới hơn exit1 trước listen, digest DB không đổi. Captured data-directory drift exit1 trước tạo redirected directory. Actual dev với version mới hơn cũng exit1/no listener/giữ dữ liệu; daemon CLI chỉ báo child exited, không claim đã quan sát schema stack từ parent.
- USD dev startup: accounting route404, không tạo accounting.db. Existing baseline compatibility runner đã đổi thành fresh Node startup không migrate trước, mở real packed adapter để kiểm schema/no business seed; selected-pair baseline EmDash1.2 pass, **52/52 tests**, host typecheck/build, Node home200/accounting401 và actual local Worker home200/accounting404.
- QA dependency symlink ban đầu gây Astro cross-root compile-cache failure; đổi sang physical dependencies/plugin tar rồi typecheck/build pass. Đây là lỗi layout QA, không sửa core hoặc suppress lỗi để vượt gate.
- Người dùng đã cho phép commit local các thay đổi startup/runner/docs; chưa cho phép push cặp thay đổi mới này. GitHub workflows vẫn pin companion revisions cũ; cần cập nhật sang exact tested accounting-startup commits khi publishing được cho phép. Local selected-pair run không phải bằng chứng GitHub CI của pinned pair đã pass. Không chạy latest upgrade, deploy hoặc browser-auth QA lại cho thay đổi không sửa UI/auth.
- Recheck docs sau thay đổi: **17 Markdown files, 110 relative links và6 Markdown anchors, 0 broken**. Sửa cả release README và compatibility guide sang heading backup/rollback hiện tại.

## Operator inputs và giới hạn

StartDate, tài khoản nội bộ và số dư đầu kỳ do operator cung cấp khi setup accounting; không suy từ CRM hoặc mặc định pháp định. Chưa có performance/capacity, stress/crash durability, live-provider hoặc production baseline; chưa chạy latest-core upgrade. Restart/migration trên instance dev hiện có chỉ thực hiện theo yêu cầu người dùng; không reset dữ liệu, `.env` hoặc key. Production rollout, push/PR và chế độ kế toán pháp định cần authorization riêng; commit và local QA không cấp quyền deploy.

<!-- slug: accounting-internal-vn -->