# Core compatibility and reviewed releases

EmDash stays upstream: https://github.com/emdash-cms/emdash. The ERP project pins released npm packages and uses their public interfaces. Do not maintain a customer core fork or import `emdash/internal/*` to pass a build.

## What is checked frequently

Each community repository has a daily **ERP compatibility** workflow plus PR/manual runs. Each tests its current source with an explicitly pinned companion-repository commit, not an unrecorded moving branch. Update that companion SHA in a linked PR when a cross-repository contract changes. The checkout steps report both exact commits. Scheduled checks and Dependabot become active after these files reach the default branch. Customer forks must enable Actions and change both the companion repository and its pinned SHA to their own reviewed source pair.

The matrix compares the checked-in baseline with npm's current `emdash` release. The shared runner at `scripts/compatibility.mjs`:

1. Copies both projects into a disposable sibling-clone layout, excluding secrets, local state, generated deployments and dependencies. It does not edit the developer's checkout.
2. Installs lockfiles, runs the existing Node/domain tests, typechecks/builds the plugin, then runs the compiled Cloudflare adapter against real Miniflare/workerd SQLite Durable Objects without Node compatibility.
3. Packs the native plugin and installs that tarball into the theme, so successful source-link resolution alone cannot hide missing package files.
4. Typechecks/builds the Node host and requires that no accounting database was created by install/build. It starts the **production-mode** server without a prior migration, verifies its homepage and unauthenticated CRM/accounting denial, then opens the real packed SQLite adapter to confirm startup applied the complete schema1→2→3 chain without business seeds, including HKD profiles/events/receipts. After stopping Node, it runs the paired theme's `accounting:test` for configured accounting operations through the exported Durable Object class in local workerd; that harness is distinct from authenticated HTTP/browser acceptance.
5. Stops the Node server, generates **local-only synthetic** Cloudflare identifiers and a disposable secret, then builds/starts VND and USD Workers sequentially with Wrangler `--local`. It checks homepages, unauthenticated ERP denial, the actual VND accounting session denial, and USD accounting route exclusion in workerd. The paired theme smoke also checks the Worker runtime import boundary.
6. Stops the process and removes the disposable directory. It never provisions, publishes, migrates a customer's database or deploys.

The latest candidate must have an identically versioned `@emdash-cms/cloudflare` package. A missing adapter, unsupported new core major or broken contract fails visibly; the runner does not silently fall back. If baseline and latest resolve to the same release, the two checks are not evidence for two different core versions.

Run the baseline against the **selected paired host**, from `plugins/erp-mini`, after reviewing both source revisions:

```sh
npm run compatibility -- --core baseline --theme /absolute/path/to/zhst-community-themes/themes/erp-mini
```

The sibling layout is the default when `--theme` is omitted. Optional `--core latest` evaluates npm's current candidate; `--core 1.2.0` selects an exact stable candidate. These are instructions, not evidence that a latest upgrade or compatibility run has been performed for the current accounting source pair. This executes native code and dependency lifecycle scripts; use isolated synthetic data, never production credentials. GitHub PR jobs have read-only permissions and no deployment secrets; do not substitute privileged execution of untrusted source.

The automatic-startup gate requires the paired host's matching startup implementation. Before publishing a cross-repository change, update both workflows' reviewed companion SHA to the tested immutable commits; a pre-startup-migration host cannot pass the new fresh-install gate. Local `--theme` validation can exercise unpublished working trees, but does not prove that GitHub's currently pinned pair passes.

Dependabot opens daily reviewable dependency-update PRs. In the theme, `emdash` and `@emdash-cms/cloudflare` are grouped so their exact versions move together. There is no auto-merge. A peer range expresses an allowed installation range, not evidence that every release within it has been tested. Record the actual tested baseline and candidate in the PR.

The baseline intentionally pins `@vitejs/plugin-react` 6.1.1 beneath `@astrojs/react` 7.0.1: both require the same `oxc-transform-react` 0.145.x peer. Plugin-react 6.1.2 instead requires 0.152.x, which does not overlap Astro React 7.0.1's peer range. Review/remove that narrow override when upgrading the adapter; do not suppress peer failures with `--force` or `--legacy-peer-deps`.

The theme deduplicates runtime peers when using a sibling `file:` plugin. Its Cloudflare SSR configuration preserves Rolldown source execution order across chunks: without it, the baseline compiled successfully but failed at Worker startup in Kysely's class hierarchy. The runtime smoke guards this failure. Do not replace it with a build-only check or patch EmDash internals.

## What CI does not prove

CI's built-host smoke checks are not the authenticated browser journey, a deployed Cloudflare Worker, a permission audit, email delivery, a restore rehearsal, a load test, or accounting/legal acceptance. The manual release record must say which of those were actually exercised. Thousands of customer forks still require an operator-managed inventory, tested resource limits and a rollout process.

Before approving any candidate, exercise the browser using the **built** application:

- Create a customer and contact; create a priced item; save and submit a quotation; accept, convert once and fulfill/cancel an order.
- Confirm unauthorized and lower-role users cannot list, read or mutate records; verify CSRF and method restrictions.
- Edit the same record in two sessions: only one stale revision may win, and the other form remains recoverable.
- Change/archive master records after submission and verify the offered snapshot stays unchanged.
- Verify selections past the first page, keyboard operation and narrow-screen layouts.
- Use two independent databases/installations; records and currency configuration from one must not appear in the other.
- For Node accounting approval, exercise automatic fresh startup, idempotent restart and fail-closed schema/target checks, explicit administrator book setup, masters, draft/post/cancel, AR/AP allocation, full reversal, snapshot reports and exact financial-intent recovery with the original actor. Verify anonymous/lower-role/bearer/cross-origin denial and plugin-disable revocation. Follow the [storage guide](accounting-storage.md) for paired restore/rollback; record these results separately from packed smoke checks.
- For Cloudflare approval, use an isolated deployed review Worker with its own D1, R2, session and dedicated SQLite accounting Durable Object namespace. On VND, exercise the same B01–B21 business acceptance, signed explicit migration, administrator book setup, original-actor command replay and a paired D1/media/key/accounting PITR restore rehearsal. Verify native session/permission/CSRF/plugin-disable boundaries and that operator methods are inaccessible through public admin accounting. On USD, preserve the saved currency and verify accounting is absent. D1 is not the financial transaction owner; Node or local workerd success is not deployed-Worker/PITR evidence.
- On both runtimes, exercise exact schema1/2→3 preservation and the complete TT133/TT99 [catalog/import contract](accounting.md#311-bộ-mẫu-việt-nam-và-phân-loại): full/subset selection, ancestor closure, exact/conflicting existing accounts, atomic rollback, result-root posting and exact-command recovery after response loss or account rename. Historical migration2 rebuilds accounts/lines; additive migration3 must preserve enterprise rows and receipts. Migration creates no business seed; COA import remains an explicit administrator action, not legal certification. See [Schema upgrades](accounting-storage.md#schema-upgrades).
- For [Sổ HKD (TT152/2025)](accounting.md#hkd-tt1522025), use isolated VND fixtures for each method (`exempt`, `revenue`, `income`) and optional other taxes, without configuring an enterprise book/COA. Exercise all applicable books, explicit annual openings, canonical month/quarter/year periods, whole-period tax rounding and S2d periodic weighted-average valuation, including backdated/voided receipts revaluing later periods and full stock depletion. Check correction by reasoned void/new entry and chronological quantity/fund guards; stock issues must not silently create deductible expenses.
- Exercise HKD response-loss/reload/exact-command recovery under the original actor; wrong actor/resource/profile must require reconciliation, not a replacement command. Restore profiles/events/receipts as part of the coherent recovery set and verify via `hkd-info`/`hkd-list`/`hkd-report`, even with enterprise-only `bookConfigured=false`. In maintenance, those reads remain available while configure/post/void are denied. Check multi-page stable snapshots, bounded Prev/explicit refresh and **full** snapshot-pinned CSV/print output, totals, identity/date/signature, formula-safe CSV text and unclipped print layout. Record actual runtime/browser/recovery evidence separately; this checklist is neither production execution nor legal acceptance.

## Recorded local verification — 2026-10-10

This historical record covers the pre-accounting CRM/sales source, not acceptance of the current accounting pair. For that 0.1.0 implementation, Node 24.21.0 tested the pinned baseline and npm's current latest, both **EmDash 1.2.0**:

- All 17 business tests passed using real temporary EmDash SQLite repositories, including concurrent conversion, stale revisions, snapshot retention, contact-selection changes, money bounds, schema rejection and separate-database isolation.
- The packed-plugin runner passed typechecks/builds, production Node startup and local Cloudflare/workerd startup. Both homepages returned 200 and both private ERP APIs returned 401 without authentication.
- A real production-mode browser session completed first-admin passkey enrollment, customer/contact and item creation, a USD 370.35 quotation, submission, acceptance, one order conversion and fulfillment.
- Actual HTTP checks rejected anonymous access (401), missing CSRF headers (403), an editor session (403) and an invalid method in the authenticated session (405).
- The browser retained unsaved input after a stale-save conflict and declined navigation, selected a customer beyond page one, and displayed the workspace at a 375px viewport.
- A contact-selection regression failed before the fix and passed afterward. The production browser also preserved the selected recipient across a concurrent contact reorder; changing that contact rejected the save while retaining the form and leaving the stored quotation revision/snapshot unchanged.

Observed upstream warnings remain visible: the admin client has a chunk over 500 kB, and EmDash's locale loader reports a fallback for the native plugin's plain-text English navigation label. No core patch or warning suppression was added. These local results are **not** remote Cloudflare deployment, a full accessibility/security audit, email delivery, backup restoration, accounting acceptance or measured thousand-installation capacity.

## Recorded local HKD verification — 2026-10-17

The HKD source pair was exercised with Node 26.9.0/npm 11.19.1, EmDash 1.2.0 and Astro 7.3.5 in disposable installations, separate from the operator's running host and browser cookies:

- Plugin `npm run check` passed: build/typecheck, 118 Node tests and 15 real workerd tests. The paired host passed `accounting:test` (30 tests), typecheck and build. Schema1/2→3 fixtures preserve enterprise history/receipts through interrupted upgrade and retry; HKD profiles/events/receipts persist through reopen.
- Packed compatibility gates passed for `--core baseline` (EmDash 1.2.0) and `--core latest` (resolved candidate 1.3.0): temporary packed installation, Node startup migration, paired-host checks and built Node/VND/USD local Worker denial/exclusion smokes. Repository dependency pins remain unchanged; this is not an upgrade or authenticated-browser acceptance of 1.3.0.
- A production-mode Node host completed native first-administrator passkey enrollment/sign-in and actual UI setup, recording and reporting for all three methods and all seven applicable book forms, without an enterprise book/COA. Reasoned void correction was exercised on the income-method UI. Month/quarter/year policies were selected explicitly. Real anonymous requests to all six HKD actions returned 401.
- A 32-entry quarterly revenue fixture yielded VND 1,600 revenue, 16 VAT and 8 revenue-based PIT. Report/list Prev retained their original snapshot after later writes/voids; explicit refresh updated it. The downloaded CSV retained all 32 old-snapshot rows, totals, identity/signature fields and escaped formula-like text. Chromium's print engine rendered the complete book across two PDF pages, including the last row, totals and signature; the actual print layout was visually inspected. This does not test an operating-system print dialog or physical printer.
- Period-average stock valued a 10-unit issue at 150 from opening 10/100 plus a later 10/200 receipt, leaving 10/150; the temporary negative value did not imply negative quantity. Cash/bank books and hybrid/absolute/percentage other-tax entries were exercised. A 2,000-character Vietnamese void reason crossed the real HTTP boundary successfully; voiding cash needed by a later payment was rejected without an event.
- A real committed response was dropped at the browser network boundary. The exact saved command survived a missing-profile replacement resource and reload, remained blocked on that wrong scope, then replayed its original receipt after restoring the original isolated accounting SQLite/WAL set: one entry and unchanged sequence. This is a resource-fence/replay check, **not** a coherent CMS/media/accounting production restore rehearsal.
- Desktop and 390px layouts were visually inspected. Narrow book columns were corrected; tables scroll inside labelled keyboard-focusable regions without outer-page overflow. Native keyboard editing and cancel/accept dirty-form navigation were exercised; the final fresh browser load emitted no console/page errors.

Local build chunk-size warnings remain visible. These results do not establish deployed Cloudflare sessions, provider PITR, long-term/off-provider backup recovery, tax/legal certification, comprehensive accessibility/security or customer-scale capacity.

## Updating core without surprising customers

1. Read the [official update guide](https://docs.emdashcms.com/deployment/updating/), the exact core package release notes and the [core migration guide](https://docs.emdashcms.com/deployment/core-migrations/). GitHub's monorepo `releases/latest` can identify a different package; use npm's `emdash` dist-tag for the core candidate.
2. Create a release branch. Review the dependency PR or update exact `emdash` versions in the plugin and theme, plus the matching exact Cloudflare adapter in the theme. Regenerate both lockfiles; do not merely edit version strings in the lock.
3. Run the shared compatibility check and the manual checks above against the exact source pair. Test any plugin-data migration against old and new records, interrupted/resumed work and unsupported future versions.
4. Follow the [paired CMS/accounting/media/key capture and restore guidance](accounting-storage.md#4-currency-migration-và-vận-hành). Keep the previous compatible artifact and prove recovery in isolation before relying on it.
5. Record migration status/target identity before allowing the upgraded app to receive traffic. EmDash may apply core migrations on the **first request**. Do not let an automated health probe perform an unreviewed migration against a valuable database. Use the installed `emdash migrate --status --json` / `--check` and target-fingerprint confirmation flow described by the version's CLI; never substitute a public migration endpoint.
6. Manually deploy to the isolated ZeroHostCMS review environment, then seek the separate private hosting-platform promotion approval where relevant. Roll out to approved customer cohorts only after recording a compatible artifact/database pair and agreed health checks.

`upgrade-emdash` can help inspect dependency changes, but it is not a customer rollout controller and does not itself migrate a database. Review its dry-run output and any generated upgrade instructions. Do not schedule it to rewrite every customer's production installation automatically.

## Schema and rollback contract

CRM/sales records and the separate accounting schema have distinct version owners. Core migrations do not migrate a customer field or the accounting resource. Both accounting runtimes require exact schema3 with the immutable schema1→2→3 checksum chain; migration accepts a fresh empty resource or exact checksummed prefixes1/2/3, not drift or corruption. Migration1/2 bytes remain unchanged; only historical schema2 rebuilds enterprise tables, while schema3 is additive HKD storage. Follow [Schema upgrades](accounting-storage.md#schema-upgrades). The paired VND Node host invokes the [checksummed migration owner](../src/accounting/sqlite.ts) before listening; the explicit CLI remains available for operator checks. Cloudflare uses the [pure adapter](../src/accounting/cloudflare.ts) through separately authorized authenticated operator migration, never its constructor or admin accounting requests. Install/build paths do not run accounting migrations. Changing a seed or a TypeScript interface is not migration; each persisted model change needs an author-owned migration and recovery plan.

Do not implement a downgrade by removing revision checks, treating future schema versions as old values, dropping unknown fields, changing the plugin ID or blanking configuration. Those approaches can erase customer data while appearing to make the UI work.

A code rollback does not undo database migration; schema1/2 artifacts refuse schema3. Restore the approved old artifact together with its coherent compatible CMS/accounting/media/key recovery set when required, including HKD profiles/events/command receipts, and reconcile writes accepted after capture before reopening traffic. Never claim lossless rollback without exercising it.

Deactivation/registration or accounting-route removal retains CRM records and accounting history/receipts; it does not satisfy erasure, retention or backup requirements. Preserve records until an explicitly authorized, verified deletion procedure says otherwise.
