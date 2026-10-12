---
title: "Phase 6: Packed artifact, compatibility và vận hành"
status: todo
---

# Phase 6: Packed artifact, compatibility và vận hành

## Context / status

Pending; depends all phases1–5. [Full spec B01–B21](../../docs/accounting.md), [compatibility](../../docs/compatibility.md), [storage migration/backup](../../docs/accounting-storage.md).

## Scope / file owners

Review all changed P/H callsites/exports/docs. Update existing README, porting/compatibility and contributor instructions to truthful supported behavior. Package export/build ownership is package.json; không invent tsdown.config.ts nếu package vẫn build bằng CLI. Tests/scripts only necessary runtime gates; no text/wiring assertions.

## Implementation steps

1. Finish every business scenario and permission/error branch on real Node DB and host; no leftover placeholder, no broken old CRM routes/currency/schema behavior. Exported symbol changes require references/caller cutover.
2. Plugin `npm ci && npm run check`; host `npm ci`, `npm run typecheck && npm run build`; retain pinned core/dependencies unless required change justified. Existing suite continues; don't re-pin incidental wording tests.
3. `npm pack` inspect file list; install artifact into disposable host with no live sibling source. Migrations and pure/Node exports actually present; build and exercise browser journals/receipt/payment/reports/reversal.
4. Run baseline compatibility against **this host**, not upstream default companion: `npm run compatibility -- --core baseline --theme /absolute/path/to/zhst-community-themes/themes/erp-mini`. Extend runner additive for new Node accounting migration/API where needed; local CF CRM/sales Worker must start, accounting capability disabled and Node module absent. No cloud provision/deploy. Latest core upgrade not required.
5. Built Node real session admin/read/write, anonymous401, lower-role403, CSRF/origin/method/oversize denied, no unauthorized mutations. Dev bypass label distinct. Browser narrow375px, keyboard, dirty/conflict and ambiguous command recovery.
6. Independent DB isolation; post+restart persistence; consistent WAL-aware backup cả EmDash/accounting/media/key while host quiesced; restore into isolated directory, reconcile reports+replay receipts. Unknown/newer migration/checksum/currency fails closed.
7. Sanitize evidence and remove own throwaway artifacts. Existing user credential/data/server must be preserved. No commit/push/PR/deploy without explicit authorization; eventual linked community PRs record exact tested pair and migration/operator risks.

## Todo / acceptance

- [ ] B01–B21 all executed with actual path evidence; environmental blockers explicit, no fake completion from compiler or mocks.
- [ ] Packed Node host works without source symlink; CF CRM/sales no Node accounting import/fallback.
- [ ] Restore amounts/receipts/currency, artifact+schema pair rollback documented; removing route retains data.
- [ ] Docs describe implemented behavior, commands and support boundary; internal bookkeeping not tax/statutory certification.

## Exit / risk

Plan complete only after all end-to-end scope works and acceptance passes. If missing credential/runtime prerequisite, finish reachable work and report exact unrun gates; no auth bypass/database edits to fake pass. Local evidence never authorizes private hosting publication.
