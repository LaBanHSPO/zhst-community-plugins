---
title: "Phase 1: Storage và transport Node"
status: completed
---

# Phase 1: Storage và transport Node

## Overview

Completed; shared prerequisite cho phases2–5. Real SQLite, captured settings, built session transport và Node/CF boundary đã kiểm chứng; evidence tổng hợp ở [plan](plan.md).

Context: [storage](../../docs/accounting-storage.md), [spec](../../docs/accounting.md).

## Requirements và architecture

Một DB accounting.db riêng với schema/migrations của plugin; Node host sở hữu connection và transaction. Không tạo/reset DB hiện tại của người dùng. Schema đầy đủ cho journal/lines/allocations/audit/commands; hành vi được nối ở các phase sau, không ship API command giả.

## File owners

- P new: `src/accounting/model.ts`, `store.ts`, `validation.ts`, `server.ts`, `sqlite.ts`, `http.ts`, `migrations/0001_accounting.sql`, `tests/accounting.test.ts`.
- P new source helper `src/accounting/erp-source.ts`: read scoped existing records through injected public StorageCollection interfaces, reuse current persisted schemas/currency lock; no private CMS table access.
- P new setup service/UI `src/accounting/service.ts`, `src/admin/accounting/setup.tsx`; admin entry hiển thị configure-book thực khi missing settings, không financial menu giả.
- P modify: `package.json` exports/build scripts, `src/index.ts`/`src/model.ts` JSON-safe accounting capability; giữ existing routes/storage.
- H new: `scripts/accounting-integration.mjs`, `scripts/migrate-accounting.mjs`, `src/server/accounting-resources.ts`, `src/server/accounting-endpoint.ts`.
- H modify: Node `astro.config.mjs`, `package.json`/lockfile, settings/start lifecycle nếu cần; CF config giữ accounting false, không import Node integration.
- Owners trên đã triển khai; schema/build ownership theo executable source và manifests.

## Implementation steps

1. LSP refs trước exported options/info change. Thiết kế small typed transaction/read interfaces, explicit actor/clock injection; không DI container.
2. SQL strict tables/FKs/unique/check/immutable post guards; migrations version+checksum, atomic and restartable. Paired VND Node startup initialize/verify schema trước listen, dùng existing migration owner; CLI explicit vẫn có cho operator/CI. Install/build/typecheck/request không migrate hoặc tạo settings/actor. Unknown/newer/checksum mismatch fail startup; authenticated configure-book tạo VND/startDate bằng revision trước masters phase2.
3. Node-only `node:sqlite` adapter dùng BEGIN IMMEDIATE/COMMIT/ROLLBACK, busy timeout bounded, WAL, foreign_keys/defensive. Callback synchronous, no await; handle transaction errors và resource close.
4. Host integration injectRoute ngoài src/pages; cùng captured scalar settings vào virtual server module + manifest dev `.astro/accounting-settings.json`/built `dist/accounting-settings.json`. Dev server-setup hook và built startup gọi migration owner theo đúng manifest; CLI bắt buộc `--settings`. Resolve relative dataDir từ owning host root và kiểm env/cwd/artifact parity trước driver/file writes. No virtual module import từ plain Node; no env fallback. Request connection vẫn lazy sau auth, không request-triggered migration.
5. Host session-only guard locals.user + public hasPermission('plugins:manage'); add direct @emdash-cms/auth 1.2.0 dependency qua npm, không hand-edit lockfile. Header/strict Origin/stream byte bounds/allowlist/no-store/two envelopes theo storage doc.
6. Wire info và configure-book/setup UI có functionality thực; ordinary reads không initialize CRM, explicit admin setup mới được initialize lock qua existing service nếu chưa có. UI không hiển thị menu financial chưa có functionality. Capability không phải authorization. Pure accounting/server và Node adapter subpaths độc lập.

## Todo và gates

- [x] Real temporary SQLite migrations: fresh/re-run/checksum/newer schema/interrupted failure, không corrupt versions.
- [x] Driver fault injection rollback + hai independent connection writer lock; path isolation/close-reopen.
- [x] Build target A, đổi ERP_DATA_DIR/currency/origin sang B rồi gọi migration: reject trước file access, DB ở B không được tạo; manifest missing/cwd wrong fail; valid captured target vẫn migrate đúng.
- [x] Synthetic production host: anonymous401, insufficient permission403, forged actor/body/CSRF/method/oversize denied trước resource/mutation; enabled info trả VND.
- [x] Build và local CF runtime giữ CRM/sales, không import node:sqlite hoặc Node endpoint; disabled accounting không fake success.
- [x] Node supported engine matrix kiểm API DatabaseSync trên baseline24.15+ và Node26; chỉ report runtime thực sự chạy.
- [x] Fresh dev/built start tự initialize schema, không book/financial seed; typecheck/build không tạo accounting DB. Warm restart giữ posted history/audit/receipt replay; schema/checksum/target drift fail closed.

## Verification commands và smoke

Trong P: `node --import tsx --test tests/accounting.test.ts`, rồi `npm run check`. Trong H: `npm run typecheck && npm run build`, start built isolated host trên port riêng và request actual guarded info. Không dùng `.local` hay credential hiện có. Nếu credential thật cần cho browser/auth, ghi prerequisite và không claim authorization pass từ service tests/dev bypass.

## Success / risk / next

Transaction/schema/transport và Node–CF module boundary có evidence thật. Dedicated DB làm backup thêm một file, không hứa transaction với CMS. Chưa triển khai domain commands không được public hóa như xong. Phase 2 dùng đúng interface này; không thay consistency primitive giữa chừng.
