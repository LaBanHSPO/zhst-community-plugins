---
title: "Phase 3: Bút toán, đầu kỳ và đảo"
status: todo
---

# Phase 3: Bút toán, đầu kỳ và đảo

## Context / status

Pending; depends phase2. [Spec §3.3/3.5, B01/B04–B08/B10/B16/B18/B20](../../docs/accounting.md).

## File owners

P modify accounting service/model/validation/sqlite/http/tests; new `src/admin/accounting/journals.tsx`; admin index/api integration. H keeps guarded transport, no business logic.

## Implementation steps

1. Reuse configure-book/currency guard và startDate đã có từ phase1, không tạo setup flow thứ hai. Read-only check CRM saved configuration qua scoped public helper; ordinary reads không initialize. User/operator chọn opening, không auto seed hoặc reinterpret USD records.
2. Save/edit/cancel draft với opaque revision, strict real calendar dates, 2–50 safe-integer lines; no ledger effect. Opening chỉ startDate; source AR debit/AP credit có role open-item server-owned với party. General/settlement/reversal roles được server xác định, không nhận từ body.
3. Post dưới BEGIN IMMEDIATE: receipt lookup trước state check; validate masters và snapshots dưới lock; balanced amounts, bounds; assign sequence, freeze lines/header, audit+receipt cùng commit.
4. Canonical hash includes actor/action/target/revision/business payload; response mất replay cùng command trả original result. Payload khác same command trả error, different post commands same draft chỉ một winner.
5. Full reverse dựng exact swapped original snapshots với line role reversal (không tạo debt source mới), unique reversal link, dates đúng; disabled master được đảo exact, không được post arbitrary new entry. No partial reverse/delete/reverse-of-reversal.
6. Journal UI Draft/Post/Reverse explicit review; retain submitted command+payload across ambiguous outcomes; no new command UUID đến khi old result đã clear. Read-only posted view links reversal/original.
7. Allocation/reducing AR/AP chưa triển khai phase4 phải reject rõ thay vì accept unlinked giảm nợ. Không ship intermediate accounting như đủ feature; toàn plan hoàn tất mới release.

## Todo / verification

- [ ] B01 draft zero ledger effect; B04 opening cân bằng và không tạo revenue.
- [ ] B05 invalid journal; B06 stale draft; B07 replay/lost response; B08 changed payload; B10 injected fault rollback giữ draft trước lệnh.
- [ ] B16 close/reopen giữ journal/receipt; B18 snapshots giữ qua master edits.
- [ ] B20 immutable header/lines via repository và SQL trigger, duplicate reversal/reversal-of-reversal reject; disabled original exact reverse vẫn thành công.
- [ ] Real browser journal/opening/Post/Reverse và conflict/ambiguous failure recovery; observe stored ledger state, không chỉ mock response.

## Gates / risk / next

Focused `node --import tsx --test tests/accounting.test.ts`; P `npm run check`; H typecheck/build và actual isolated built host. BigInt validate bounded journal sum; report formatting chưa đủ để claim aggregate precision. Phase4 nối allocation checks vào cùng post/reverse transaction, không save ở second commit.
