---
title: "Phase 4: Thu/chi và phân bổ"
status: todo
---

# Phase 4: Thu/chi và phân bổ

## Context / status

Pending; depends phase3. [Spec §3.4–3.5, B02/B03/B09/B11/B12/B14/B19](../../docs/accounting.md).

## File owners

P accounting model/validation/service/sqlite/http, new `src/admin/accounting/settlements.tsx`, journals UI và `tests/accounting.test.ts`. Giữ host là transport/resource owner.

## Implementation steps

1. Receipt/payment helper chọn party, bank/cash, sources; dựng balanced draft server-side từ amounts/allocations. Tối đa49 source lines +1 money account line; không client-authoritative totals.
2. Extend generic journal reducing AR/AP: chỉ chọn source role open-item, cùng party/account/VND, opposite direction; mỗi reducing line role settlement phải fully allocated. Group allocations per source/payment line before bounds, no per-row loophole. Reversal lines không eligible làm source.
3. Operational remaining từ posted source/effective settlements/reversals, không cache mirror. Source chưa post/reversed hoặc overpay/wrong party/account rejected. SQLite transaction serializes tranh remaining, không JS-only mutex.
4. Date fence trên mọi journal có allocation/reversal: ngày >=max(ngày source, mọi allocation/release dates). Allocation đầu tiên không trước source; generic journal cùng rule. Reject backdate gây historical over-allocation. Chứng từ tương lai cũng reserve operational capacity, report cutoff tách biệt.
5. Reverse mọi journal có outgoing allocation (helper hoặc generic) giải phóng tất cả allocations trong cùng commit, records vẫn immutable. Nếu journal có cả open-item và settlement, require hết active incoming allocations rồi release outgoing. Source reversal và mọi nguồn affected đều qua chronology; không cascade. Same command replay sau source state đổi trả stored result.
6. UI hiển thị original/allocated/remaining theo nguồn, draft preview và Post riêng, trace vào journal; preserve command after network ambiguity. Unsupported advance/overpayment hiển thị lỗi rõ.

## Todo / verification

- [ ] B02 AR1m/receipt600k→400k; B03 AP800k/payment300k→500k.
- [ ] B09 hai independent writer connections/processes tranh 400k với hai300k: chỉ một winner; grouped repeated-source inputs không vượt nợ.
- [ ] B11 source reversal denied khi còn settlement; B12 receipt reversal restores debt rồi source reversal zero; B21 generic allocation reversal release và mixed incoming/outgoing guard atomic, đủ audit/history.
- [ ] B14 allocation đầu tiên trước source, generic/payment/reverse trước activity gần nhất rejected; same-day hợp lệ.
- [ ] B19 wrong party/account/overpayment và unmatched amount rollback cả command; fault ở giữa allocations không leak money lines/audit/receipt.
- [ ] Actual browser customer receipt và supplier payment từng phần, reverse order đúng, lost-response recovery; restart kiểm amounts.

## Gates / risk / next

Focused tests + P check + H typecheck/build, real built host flow. Date fence là đề xuất đảm bảo lịch sử nhất quán, không statutory period lock. Phase5 phải filter allocations/reversals theo both sequence và postingDate; không dùng latest remaining làm report quá khứ.
