# Core compatibility and reviewed releases

EmDash stays upstream: https://github.com/emdash-cms/emdash. The ERP project pins released npm packages and uses their public interfaces. Do not maintain a customer core fork or import `emdash/internal/*` to pass a build.

## What is checked frequently

Each community repository has a daily **ERP compatibility** workflow plus PR/manual runs. Each tests its current source with an explicitly pinned companion-repository commit, not an unrecorded moving branch. Update that companion SHA in a linked PR when a cross-repository contract changes. The checkout steps report both exact commits. Scheduled checks and Dependabot become active after these files reach the default branch. Customer forks must enable Actions and change both the companion repository and its pinned SHA to their own reviewed source pair.

The matrix compares the checked-in baseline with npm's current `emdash` release. The shared runner at `scripts/compatibility.mjs`:

1. Copies both projects into a disposable sibling-clone layout, excluding secrets, local state, generated deployments and dependencies. It does not edit the developer's checkout.
2. Installs lockfiles, tests the plugin against actual temporary EmDash SQLite storage, typechecks and builds it.
3. Packs the native plugin and installs that tarball into the theme, so successful source-link resolution alone cannot hide missing package files.
4. Typechecks/builds the Node host, starts the **production-mode** server with disposable credentials/data, requests its homepage and verifies the private ERP API rejects an unauthenticated request.
5. Stops the Node server, generates **local-only synthetic** Cloudflare identifiers and a disposable secret, builds the Worker, and starts it with Wrangler `--local`. It checks a successful homepage and unauthenticated ERP denial in workerd, not just compilation.
6. Stops the process and removes the disposable directory. It never provisions, publishes, migrates a customer's database or deploys.

The latest candidate must have an identically versioned `@emdash-cms/cloudflare` package. A missing adapter, unsupported new core major or broken contract fails visibly; the runner does not silently fall back. If baseline and latest resolve to the same release, the two checks are not evidence for two different core versions.

Run locally from `plugins/erp-mini` after reviewing both clones:

```sh
npm run compatibility -- --core baseline
npm run compatibility -- --core latest
```

Use `--theme /absolute/path/to/zhst-community-themes/themes/erp-mini` for a non-default location. `--core 1.2.0` selects an exact stable candidate. This executes native code and dependency lifecycle scripts from the selected sources; use an isolated environment and synthetic data, not production credentials. GitHub PR jobs have read-only repository permissions and no deployment secrets; do not replace them with `pull_request_target` or privileged self-hosted execution of untrusted source.

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
- For Cloudflare approval, run these checks on an isolated deployed review Worker with its own D1, R2 and session resources. A Node build is not D1/Worker evidence.

## Recorded local verification — 2026-10-10

For the 0.1.0 implementation, Node 24.21.0 tested the pinned baseline and npm's current latest, both **EmDash 1.2.0**:

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
4. Take a consistent backup of the customer's database and media plus protected copies of the encryption key and resource mapping. Keep the previous application artifact. Restore the backup into isolated resources and demonstrate that it works before relying on it.
5. Record migration status/target identity before allowing the upgraded app to receive traffic. EmDash may apply core migrations on the **first request**. Do not let an automated health probe perform an unreviewed migration against a valuable database. Use the installed `emdash migrate --status --json` / `--check` and target-fingerprint confirmation flow described by the version's CLI; never substitute a public migration endpoint.
6. Manually deploy to the isolated ZeroHostCMS review environment, then seek the separate private hosting-platform promotion approval where relevant. Roll out to approved customer cohorts only after recording a compatible artifact/database pair and agreed health checks.

`upgrade-emdash` can help inspect dependency changes, but it is not a customer rollout controller and does not itself migrate a database. Review its dry-run output and any generated upgrade instructions. Do not schedule it to rewrite every customer's production installation automatically.

## Schema and rollback contract

The starter's plugin records use `schemaVersion: 1`. Core's own schema migrations do not migrate a custom field added by a customer fork. Every persisted model change needs an explicit author-owned migration and recovery plan. Changing an EmDash seed or a TypeScript interface is not such a plan.

Do not implement a downgrade by removing revision checks, treating future schema versions as old values, dropping unknown fields, changing the plugin ID or blanking configuration. Those approaches can erase customer data while appearing to make the UI work.

A code rollback does not undo database migration. Restore the approved old artifact together with its compatible database/media snapshot when required, and reconcile any writes accepted after the backup before reopening traffic. Never claim lossless rollback without exercising it.

Deactivation/registration removal retains plugin storage; it does not satisfy data erasure, retention or backup requirements. Preserve records until an explicitly authorized, verified deletion procedure says otherwise.
