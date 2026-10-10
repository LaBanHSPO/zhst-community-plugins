# Phase 4: verification and operations

Status: local verification complete. External release gates remain explicit below.

After concurrent implementation finishes, install pinned dependencies using compatible Node, generate Worker binding types, build/typecheck plugin and Cloudflare host, and run behavioral tests once before fixing observed failures. Use real local Miniflare D1 for transaction/rollback/concurrency/restart scenarios. Smoke the actual Worker/API and inspect guest/staff surfaces in a browser; preserve synthetic fixture-only screenshots. No baseline test run before implementation.

Exercise complete two-branch workflow plus duplicate commands, stale revisions, duplicate webhook/queue deliveries, crash before enqueue, crash after provider dispatch, restart/lease recovery, closed visits, blocked cross-branch reads and exports. Validate CSV protection and invoice PDF/XML access permissions. Review source/package exports and direct runtime bindings. Resolve findings before delivery.

Update operator README with exact commands, migration ownership, secret names, backup/restore and retention requirements, queue recovery, ambiguous-provider handling, safe release/promotion and evidence limitations. Retain no throwaway smoke scripts or credentials. Do not deploy, open a PR, publish packages, issue real invoices or claim performance capacity without separate authorization/evidence.

## Observed results

Verification ran on 2026-10-10 with Node 24.21.0 against the separate restaurant packages; EmDash core and ERP mini were not changed.

- Plugin `npm run check`: TypeScript passed, 72 behavioral tests passed with zero failures/skips, and ESM/declaration build passed.
- Theme `npm run typecheck`: zero errors, warnings, or hints. `npm run build`: passed; Vite retains a warning about chunks exceeding 500 kB.
- Actual Wrangler local migration applied successfully. Real Miniflare D1 tests cover repeated migration, batch rollback, competing confirmations, branch isolation, closed/expired tokens, duplicate receipts, lease recovery, and invoice dispatch ambiguity.
- Browser smoke used synthetic Maison Sài Gòn and Maison Hà Nội branches with distinct receiving accounts. A guest submitted a dish, staff confirmed, kitchen progressed through preparation/readiness/service, and the cashier froze the bill and generated the QR. A second branch independently completed checkout.
- Authenticated synthetic webhooks traversed the actual local Worker and Queue consumer. The first two branches became paid for 480,000 VND and 130,000 VND. Replaying the first receipt retained payment version 2 rather than allocating twice.
- A later 65,000 VND attempt exercised the corrected 30-character SePay suffix, rendered the external QR image, and became paid through the compiled Worker's webhook/Queue path.
- Paid-bill invoice creation persisted the invoice and outbox atomically. With no invoice credentials supplied, its job visibly entered review with `INVOICE_CREDENTIALS_UNAVAILABLE`; no provider submission occurred. Controlled-provider tests prove draft/create/issue, corrections, file retrieval, recovered polling, and lost-response handling.
- The accounting API returned the expected branch-scoped CSV, including the 480,000 VND sale and 35,556 VND tax. The export UI completed its CSV action. Table QR rendered a local 600-pixel PNG; the NFC copy action produced the exact table URL.
- Guest and staff layouts were inspected at 390 × 844 and staff at 1440 × 1000. Arabic set `dir=rtl` with no document-level horizontal overflow. Compiled guest session restoration and the native staff plugin mounted successfully.
- Both compiled development-bypass endpoints returned 403. The deploy command refused the local build before invoking Wrangler deployment. The configure command generated a synthetic, isolated mapping without creating resources; that temporary mapping was removed.

Review and runtime fixes included administrator permission argument shape, composite pagination cursors, reviewed invoice polling recovery, issuing a recovered remote draft without inventing a lost tracking code, historical account exception visibility, correction amount guidance, select display labels, SePay payment-code length, JSONC parsing, and compiled-preview persistence. The SePay code-length regression failed before the fix and passed afterward.

## Browser captures

All captures contain synthetic data. Do not transfer money to the displayed test accounts. The guest route is `/order/<table-token>`; the staff route is `/_emdash/admin/plugins/restaurant-chain/workspace`.

- [Vietnamese guest menu](evidence/guest-menu.webp): 390 × 844, light theme, development host.
- [Arabic guest pending order](evidence/guest-rtl.webp): 390 × 844, light theme, development host.
- [Arabic mobile staff workspace](evidence/staff-rtl-mobile.webp): 390 × 844, dark theme, development host.
- [Cashier payment QR](evidence/cashier-qr.webp): 390 × 844, dark theme, development host.
- [Compiled staff workspace](evidence/staff-compiled.webp): 1440 × 1000, dark theme, compiled Wrangler Worker.

## External release gates

No live bank transfer, tax invoice, deployment, package publication, or hosting promotion was performed. Production rollout requires authorized SePay sandbox/live conformance, bank/account eligibility, approved legal seller/template/series/location mappings, TLS validation, backup/restore rehearsal, and expected-peak load validation for approximately 50 branches. The actual tax provider and accountant must approve invoice treatment and rounding. Ambiguous external outcomes remain review states; local tests do not establish a stronger provider guarantee.
