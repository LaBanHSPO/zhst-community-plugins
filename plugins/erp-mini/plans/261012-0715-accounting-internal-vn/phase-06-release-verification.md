---
title: "Phase 6: Packed artifact, compatibility và vận hành"
status: completed
---

# Phase 6: Packed artifact, compatibility và vận hành

## Context / status

Completed sau phases1–5: packed Node/browser, baseline compatibility, local packed CF và independent paired restore đã pass. [Full spec B01–B21](../../docs/accounting.md), [compatibility](../../docs/compatibility.md), [storage migration/backup](../../docs/accounting-storage.md), [exact QA evidence và limits](plan.md). Không có publication/deploy authorization.

## Scope / file owners

Review all changed P/H callsites/exports/docs. Update existing README, porting/compatibility and contributor instructions to truthful supported behavior. Package export/build ownership is package.json; không invent tsdown.config.ts nếu package vẫn build bằng CLI. Tests/scripts only necessary runtime gates; no text/wiring assertions.

## Implementation steps

1. Finish every business scenario and permission/error branch on real Node DB and host; no leftover placeholder, no broken old CRM routes/currency/schema behavior. Exported symbol changes require references/caller cutover.
2. Plugin `npm ci && npm run check`; host `npm ci`, `npm run typecheck && npm run build`; retain pinned core/dependencies unless required change justified. Existing suite continues; don't re-pin incidental wording tests.
3. `npm pack` inspect file list; install artifact into disposable host with no live sibling source. Migrations and pure/Node exports actually present; build and exercise browser journals/receipt/payment/reports/reversal.
4. Run baseline compatibility against **this host**, not upstream default companion: `npm run compatibility -- --core baseline --theme /absolute/path/to/zhst-community-themes/themes/erp-mini`. Runner starts fresh built Node without a prior migration and opens the real packed adapter to assert a compatible empty schema; install/build must not create the DB. Local CF CRM/sales Worker must start with accounting excluded. No cloud provision/deploy; latest upgrade not required. Publishing requires both reviewed companion SHA pins to identify the matching startup implementation.
5. Built Node real session admin/read/write, anonymous401, lower-role403, CSRF/origin/method/oversize denied, no unauthorized mutations. Dev bypass label distinct. Browser narrow375px, keyboard, dirty/conflict and ambiguous command recovery.
6. Independent DB isolation; post+restart persistence; consistent WAL-aware backup cả EmDash/accounting/media/key while host quiesced; restore into isolated directory, reconcile reports+replay receipts. Unknown/newer migration/checksum/currency fails closed.
7. Sanitize evidence and remove own throwaway artifacts. Existing user credential/data/server must be preserved. No commit/push/PR/deploy without explicit authorization; eventual linked community PRs record exact tested pair and migration/operator risks.

## Todo / acceptance

- [x] B01–B21 all executed with actual path evidence; environmental limits explicit, no fake completion from compiler or mocks.
- [x] Packed Node host works without source symlink; CF CRM/sales no Node accounting import/fallback.
- [x] Restore amounts/receipts/currency, artifact+schema pair rollback documented; removing route retains data.
- [x] Docs describe implemented behavior, commands and support boundary; internal bookkeeping not tax/statutory certification.

## Exit / risk

Plan complete only after all end-to-end scope works and acceptance passes. If missing credential/runtime prerequisite, finish reachable work and report exact unrun gates; no auth bypass/database edits to fake pass. Local evidence never authorizes private hosting publication.
