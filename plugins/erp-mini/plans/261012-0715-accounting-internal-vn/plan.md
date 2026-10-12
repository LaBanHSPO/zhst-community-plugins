---
title: "Accounting nội bộ VND cho ERP mini"
description: "Ghi sổ kép, công nợ và báo cáo nhất quán cho doanh nghiệp nhỏ/rất nhỏ; Node SQLite, không statutory accounting."
status: pending
priority: P1
effort: ""
tags: [erp-mini, accounting, vnd, sqlite]
created: 2026-10-12
---

# Accounting nội bộ VND cho ERP mini

## Overview

Deliverable của nhiệm vụ hiện tại là đặc tả + thiết kế + kế hoạch, **không phải module accounting đã chạy**. Mọi phase implementation dưới đây còn pending.

Người dùng đã kiểm tra môi trường OK, xác nhận doanh nghiệp nhỏ/rất nhỏ, ghi sổ nội bộ và chọn ghi sổ kép có công nợ. Giữ scope này; không làm tax/einvoice/inventory/FX/statutory reports hoặc auto-post orders.

- [Đặc tả nghiệp vụ và scenario B01–B21](../../docs/accounting.md)
- [Storage/transport, evidence và smoke design](../../docs/accounting-storage.md)
- P = package plugin này; H = sibling `zhst-community-themes/themes/erp-mini`.
- Pair khảo sát: plugin `4b6f1e11f9b77fceae19b18fce8fc546d3811276`, theme `01f82bde4d99b9de6a93aef8ac133c346af3a953`; EmDash 1.2.0/Astro 7.3.5.
- Node 26.9.0/npm 11.19.1 đã dùng; engines vẫn theo manifests, không hạ pins.

## Architecture và execution contract

React admin ERP mini → Node-only host endpoint → plugin accounting service → accounting.db SQLite transaction. Host attests actor bằng session EmDash/plugins:manage. Domain và UI vẫn thuộc plugin `erp-mini`; không fork core/Frappe.

Giữ CMS/CRM storage hiện tại. Không distributed write giữa CRM CAS và accounting. CF vẫn CRM/sales, accounting disabled rõ; không Node driver trong Worker import graph, không fake financial fallback.

Theo thứ tự 1→6, một integration owner. Mỗi phase chỉ xong sau tests liên quan **và** runtime/browser smoke của path mới; phase boundary không phải permission publish/deploy. Không seed/reset `.local`, key hay credential người dùng. Fixture dùng installation riêng.

Trước thay đổi exported symbols, chạy LSP references; giữ current callers/contracts hoặc cut over đầy đủ. Không import private EmDash internals. Reuse integer validation, ErpError, two-envelope client, dirty/pending/revision guards.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Storage và transport Node](./phase-01-start.md) | Pending |
| 2 | [Tài khoản và đối tượng công nợ](./phase-02-accounts-parties.md) | Pending |
| 3 | [Bút toán, đầu kỳ và đảo](./phase-03-journals-opening-reversal.md) | Pending |
| 4 | [Thu/chi và phân bổ](./phase-04-payments-allocations.md) | Pending |
| 5 | [Báo cáo và đối chiếu](./phase-05-reports.md) | Pending |
| 6 | [Packed artifact, compatibility và vận hành](./phase-06-release-verification.md) | Pending |

## Success Criteria

- [ ] Luồng AR 1.000.000 → thu 600.000 cho ledger/công nợ khớp 400.000; AP/opening cũng được chứng minh.
- [ ] Financial writes atomic/idempotent, posted history immutable, partial allocation/reversal đúng, stale/denied calls không mutation.
- [ ] Reports snapshot và money totals chính xác; restart/restore giữ balances và receipt replay.
- [ ] Node built session/CSRF/permission/browser pass; CF CRM/sales không regress, accounting không được quảng cáo supported.
- [ ] Source pair/lockfiles/artifact provenance và mọi environmental limits được ghi đúng, không suy production accounting compliance.

## Validation log của thiết kế

- Đã đối chiếu CAS, currency lock, serialization, public auth và Node-only route integration với installed source; xem evidence table trong storage doc.
- Probe SQLite synthetic Node26.9.0: 14 nhóm assertion pass, 4 journals sau hai reversals; balanced/partial/replay/rollback/over-allocation/immutability/as-of/writer-lock/reopen.
- Reduced SQLite allocation probe sau review: 4 nhóm pass cho first-allocation date fence, generic reversal release/no new source, mixed incoming guard/atomic outgoing và release-date fence/same-day.
- Probe không chứng minh full production schema/service, HTTP/auth/UI, AP/opening, chronology integration, stress/crash, Node24, manifest target A→B hoặc CF; những mục này vẫn là gates implementation.
- Không chạy lại setup người dùng đã xác nhận. Không thay runtime, DB, secrets hoặc credential.
- Hai reviewer độc lập: đã xử lý source-date fence, generic/mixed reversal và migration/build manifest parity; correction review không còn findings. Setup được đưa về phase1 trước masters.
- Whole-plan sweep: 9 docs/plan files, 26 relative links hợp lệ, không template placeholders hoặc stale B01–B20 scope; AgentKit validate pass. Không đánh dấu implementation phase done từ doc/probe.

## Operator inputs và giới hạn

StartDate, tài khoản nội bộ và số dư đầu kỳ được operator cung cấp khi setup accounting; không suy từ CRM hoặc mặc định pháp định. Chưa có performance/capacity baseline. Production rollout, push/PR và lựa chọn chế độ kế toán pháp định cần authorization riêng.

<!-- slug: accounting-internal-vn -->