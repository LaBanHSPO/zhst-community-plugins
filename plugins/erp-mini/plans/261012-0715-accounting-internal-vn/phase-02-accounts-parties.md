---
title: "Phase 2: Tài khoản và đối tượng công nợ"
status: todo
---

# Phase 2: Tài khoản và đối tượng công nợ

## Context / status

Pending; depends phase1. [Spec §3.1–3.2](../../docs/accounting.md), [storage](../../docs/accounting-storage.md).

## Requirements

Tài khoản group/ledger, account tree/purpose; customer/supplier accounting parties. Reuse CRM customer một lần bằng public access và snapshot, không mutate CRM từ accounting transaction.

## File owners

P modify `src/accounting/service.ts` từ phase1, new `src/admin/accounting/masters.tsx`; modify model/validation/http/sqlite, `src/admin/index.tsx`, shared request handling. H endpoint chỉ forward implemented allowlisted actions. Tests `tests/accounting.test.ts` theo current Node/tsx convention.

## Implementation steps

1. CRUD create/edit/disable account và party: strict schema, UUID, code normalization uniqueness, revision CAS; references stable. Group parent/same root/no-cycle; cash/bank/AR thuộc asset, AP thuộc liability, group chỉ general. Used-account structure và party kind bất biến.
2. `link-customer`: host sau auth dùng public getDb + exported PluginStorageRepository, scoped namespace erp-mini, truyền public read interface vào source helper; kiểm customer/revision và current persisted schema trước accounting transaction, lưu party source+snapshot unique. CRM snapshot race không phải distributed transaction; no dual write hoặc unguarded server fetch.
3. SQL checks/unique+service validate dưới same write lock. Metadata actor/time do server, không hard-delete history. Bounded list/search/keyset page25.
4. UI master forms có labels, errors, pending/dirty guards, giữ input khi stale conflict, explicit reload; không auto retry stale save.
5. Update envelope client dùng chung parser và separate accounting base URL, không duplicate auth stack hoặc kéo server modules vào React.

## Todo / verification

- [ ] Account cycle/sai parent/group/posting purpose invalid không lưu; code collisions và stale revision đúng một winner.
- [ ] Party kind/source link uniqueness; unauthorized CRM selection không linked; archived source snapshot không rewrite lịch sử.
- [ ] Independent installations không share accounts/parties/settings.
- [ ] Browser thực: tạo cash/bank/AR/AP/revenue/expense/equity accounts, customer/supplier; duplicate/stale form, keyboard focus và narrow screen.
- [ ] Chạy focused accounting tests, P check, H typecheck/build; exercise built master UI với synthetic auth/DB.

## Success / risk / next

Account/party usable end-to-end, no fictitious legal chart. B01–B21 cần các master này; phase3 thêm actual financial journal. Không biến CRM archiving thành data deletion.
