# Core compatibility and reviewed releases

EmDash stays upstream: https://github.com/emdash-cms/emdash. The ERP project pins released npm packages and uses their public interfaces. Do not maintain a customer core fork or import `emdash/internal/*` to pass a build.

## What is checked frequently

Each community repository has a daily **ERP compatibility** workflow plus PR/manual runs. Each tests its current source with an explicitly pinned companion-repository commit, not an unrecorded moving branch. Update that companion SHA in a linked PR when a cross-repository contract changes. The checkout steps report both exact commits. Scheduled checks and Dependabot become active after these files reach the default branch. Customer forks must enable Actions and change both the companion repository and its pinned SHA to their own reviewed source pair.

The matrix compares the checked-in baseline with npm's current `emdash` release. The shared runner at `scripts/compatibility.mjs`:

1. Copies both projects into a disposable sibling-clone layout, excluding secrets, local state, generated deployments and dependencies. It does not edit the developer's checkout.
2. Installs lockfiles, runs the existing Node/domain tests, typechecks/builds the plugin, then runs the compiled Cloudflare adapter against real Miniflare/workerd SQLite Durable Objects without Node compatibility.
3. Packs the native plugin and installs that tarball into the theme, so successful source-link resolution alone cannot hide missing package files.
4. Typechecks/builds the Node host, explicitly migrates the disposable accounting schema using its captured settings manifest, starts the **production-mode** server and verifies its homepage plus unauthenticated CRM and accounting denial. Schema migration does not configure a business book.
5. Stops the Node server, generates **local-only synthetic** Cloudflare identifiers and a disposable secret, then builds/starts VND and USD Workers sequentially with Wrangler `--local`. It checks homepages, unauthenticated ERP denial, the actual VND accounting session denial, and USD accounting route exclusion in workerd. The paired theme smoke also checks the Worker runtime import boundary.
6. Stops the process and removes the disposable directory. It never provisions, publishes, migrates a customer's database or deploys.

The latest candidate must have an identically versioned `@emdash-cms/cloudflare` package. A missing adapter, unsupported new core major or broken contract fails visibly; the runner does not silently fall back. If baseline and latest resolve to the same release, the two checks are not evidence for two different core versions.

Run the baseline against the **selected paired host**, from `plugins/erp-mini`, after reviewing both source revisions:

```sh
npm run compatibility -- --core baseline --theme /absolute/path/to/zhst-community-themes/themes/erp-mini
```

The sibling layout is the default when `--theme` is omitted. Optional `--core latest` evaluates npm's current candidate; `--core 1.2.0` selects an exact stable candidate. These are instructions, not evidence that a latest upgrade or compatibility run has been performed for the current accounting source pair. This executes native code and dependency lifecycle scripts; use isolated synthetic data, never production credentials. GitHub PR jobs have read-only permissions and no deployment secrets; do not substitute privileged execution of untrusted source.

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
- For Node accounting approval, exercise explicit migration/setup, masters, draft/post/cancel, AR/AP allocation, full reversal, snapshot reports and exact financial-intent recovery with the original actor. Verify anonymous/lower-role/bearer/cross-origin denial and plugin-disable revocation. Follow the [storage guide](accounting-storage.md) for paired restore/rollback; record these results separately from packed smoke checks.
- For Cloudflare approval, use an isolated deployed review Worker with its own D1, R2, session and dedicated SQLite accounting Durable Object namespace. On VND, exercise the same B01–B21 business acceptance, signed explicit migration, administrator book setup, original-actor command replay and a paired D1/media/key/accounting PITR restore rehearsal. Verify native session/permission/CSRF/plugin-disable boundaries and that operator methods are inaccessible through public admin accounting. On USD, preserve the saved currency and verify accounting is absent. D1 is not the financial transaction owner; Node or local workerd success is not deployed-Worker/PITR evidence.

## Recorded local verification — 2026-10-10

This historical record covers the pre-accounting CRM/sales source, not acceptance of the current accounting pair. For that 0.1.0 implementation, Node 24.21.0 tested the pinned baseline and npm's current latest, both **EmDash 1.2.0**:

- All 17 business tests passed using real temporary EmDash SQLite repositories, including concurrent conversion, stale revisions, snapshot retention, contact-selection changes, money bounds, schema rejection and separate-database isolation.
- The packed-plugin runner passed typechecks/builds, production Node startup and local Cloudflare/workerd startup. Both homepages returned 200 and both private ERP APIs returned 401 without authentication.
- A real production-mode browser session completed first-admin passkey enrollment, customer/contact and item creation, a USD 370.35 quotation, submission, acceptance, one order conversion and fulfillment.
- Actual HTTP checks rejected anonymous access (401), missing CSRF headers (403), an editor session (403) and an invalid method in the authenticated session (405).
- The browser retained unsaved input after a stale-save conflict and declined navigation, selected a customer beyond page one, and displayed the workspace at a 375px viewport.
- A contact-selection regression failed before the fix and passed afterward. The production browser also preserved the selected recipient across a concurrent contact reorder; changing that contact rejected the save while retaining the form and leaving the stored quotation revision/snapshot unchanged.

Observed upstream warnings remain visible: the admin client has a chunk over 500 kB, and EmDash's locale loader reports a fallback for the native plugin's plain-text English navigation label. No core patch or warning suppression was added. These local results are **not** remote Cloudflare deployment, a full accessibility/security audit, email delivery, backup restoration, accounting acceptance or measured thousand-installation capacity.

## Updating core without surprising customers

1. Read the [official update guide](https://docs.emdashcms.com/deployment/updating/), the exact core package release notes and the [core migration guide](https://docs.emdashcms.com/deployment/core-migrations/). GitHub's monorepo `releases/latest` can identify a different package; use npm's `emdash` dist-tag for the core candidate.
2. Create a release branch. Review the dependency PR or update exact `emdash` versions in the plugin and theme, plus the matching exact Cloudflare adapter in the theme. Regenerate both lockfiles; do not merely edit version strings in the lock.
3. Run the shared compatibility check and the manual checks above against the exact source pair. Test any plugin-data migration against old and new records, interrupted/resumed work and unsupported future versions.
4. Follow the [paired CMS/accounting/media/key capture and restore guidance](accounting-storage.md#4-currency-migration-và-vận-hành). Keep the previous compatible artifact and prove recovery in isolation before relying on it.
5. Record migration status/target identity before allowing the upgraded app to receive traffic. EmDash may apply core migrations on the **first request**. Do not let an automated health probe perform an unreviewed migration against a valuable database. Use the installed `emdash migrate --status --json` / `--check` and target-fingerprint confirmation flow described by the version's CLI; never substitute a public migration endpoint.
6. Manually deploy to the isolated ZeroHostCMS review environment, then seek the separate private hosting-platform promotion approval where relevant. Roll out to approved customer cohorts only after recording a compatible artifact/database pair and agreed health checks.

`upgrade-emdash` can help inspect dependency changes, but it is not a customer rollout controller and does not itself migrate a database. Review its dry-run output and any generated upgrade instructions. Do not schedule it to rewrite every customer's production installation automatically.

## Schema and rollback contract

CRM/sales records and the separate accounting schema have distinct version owners. Core migrations do not migrate a customer field or the accounting database. Accounting's [checksummed migration owner](../src/accounting/sqlite.ts) is explicit through the paired host; changing a seed or a TypeScript interface is not migration. Each persisted model change needs an author-owned migration and recovery plan.

Do not implement a downgrade by removing revision checks, treating future schema versions as old values, dropping unknown fields, changing the plugin ID or blanking configuration. Those approaches can erase customer data while appearing to make the UI work.

A code rollback does not undo database migration. Restore the approved old artifact together with its compatible database/media snapshot when required, and reconcile any writes accepted after the backup before reopening traffic. Never claim lossless rollback without exercising it.

Deactivation/registration or accounting-route removal retains CRM records and accounting history/receipts; it does not satisfy erasure, retention or backup requirements. Preserve records until an explicitly authorized, verified deletion procedure says otherwise.
