---
title: "Phase 5: Báo cáo và đối chiếu"
status: todo
---

# Phase 5: Báo cáo và đối chiếu

## Context / status

Pending; depends phase4. [Spec §4, B02–B04/B13/B17](../../docs/accounting.md), [storage snapshot algorithm](../../docs/accounting-storage.md).

## File owners

P new `src/accounting/reports.ts`, `src/admin/accounting/reports.tsx`, `tests/accounting-reports.test.ts`; accounting http/model/sqlite/query indexes; existing admin client money helpers nếu cần safe string totals.

## Implementation steps

1. Authenticated report request first captures max sequence+filters; validated keyset cursor pins sequence/filter identity across requests. Page25 rows, no open transaction across HTTP pages.
2. Indexed immutable lines+journals: journal/GL/trial balance/cash-bank; date ranges inclusive calendar dates, opening before from and movements in range, normal balance side split.
3. Reports include original + reverse at their dates; classifications/names from stored snapshot. Backdated post after capture không lọt old run. No mutable latest-reversal or master joins breaking cutoff.
4. Party/source report: sources and effective allocations/reversals filter same sequence AND cutoff date; compare AR/AP sum to control ledger; operational funds capacity remains current, not report as-of.
5. Exact BigInt accumulation from bounded indexed streams; avoid unbounded SQL SUM/REAL and giant arrays. Aggregate decimal strings across API; UI VND no fraction, không Number coercion. Define bounds/cursor for accounts/parties result sets and traversal.
6. UI filter date/account/party, Refresh explicitly new run, opening/debit/credit/closing visible, drill-down journals, original/reversal links. Loading/error/empty/error recovery with input retained.

## Todo / verification

- [ ] B13 multiple pages stable through new post/backdated post/reversal/master rename; refreshed run changes correctly.
- [ ] B17 synthetic accumulated total >Number.MAX_SAFE_INTEGER exact decimal strings; overflow not floating/rounded.
- [ ] AR/AP source totals match control ledger before/after partial payments, reversals, opening and historical dates.
- [ ] Trial balance full-book totals cân cho opening/movements/closing; limited account report không falsely require full-book balance.
- [ ] Date boundary/before source/after reversal; draft/cancelled excluded; no reclassify old lines via changed masters.
- [ ] Actual browser all five report surfaces, pagination beyond25, drill-down, keyboard/mobile, auth denial.

## Gates / risk / next

`node --import tsx --test tests/accounting-reports.test.ts` và accounting suite, P check, H typecheck/build. Actual browser report must reconcile stored journal—not fixture text assertion. No capacity/latency promise before measurement; bounded CPU/read traversal observed in QA. Phase6 release proof includes restore and packed Node/CF artifact separation.
