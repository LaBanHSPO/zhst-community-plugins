# ERP mini — CRM, sales and internal VND bookkeeping for EmDash

A native EmDash plugin for **customers and contacts → items/services → quotations → sales orders**, with separate **internal VND bookkeeping on the paired Node host**. It implements independent workflows inspired by ERPNext; it does not run Frappe apps, import Python DocTypes or connect to an ERPNext server. Statutory accounting, tax, stock valuation and payroll remain outside scope.

Use it for a separately operated business installation, not as a tenant selector in one shared database. The browser UI lives inside EmDash's authenticated admin shell at `/_emdash/admin/plugins/erp-mini/workspace`. All operations require an EmDash administrator. Native plugin code has the host's authority; a capability declaration is not a security sandbox.

## Start from two standalone clones

Prerequisites: Git, Node **24.15 or newer in the 24.x line** and npm. The checked-in projects pin **EmDash 1.2.0**, **Astro 7.3.5** and **React 19.3.0**. No private hosting-platform checkout, cloud account or paid API is required locally.

```sh
mkdir my-erp
cd my-erp
git clone https://github.com/ZeroHostCMS/zhst-community-plugins.git
git clone https://github.com/ZeroHostCMS/zhst-community-themes.git
cd zhst-community-plugins/plugins/erp-mini
npm ci
npm run check
cd ../../../zhst-community-themes/themes/erp-mini
npm ci
cp .env.example .env
npm run secrets:generate
npm run typecheck
npm run build
npm run dev
```

Use your own fork URLs for customer-specific development; keep the two directory names above. The theme's `file:` dependency resolves the sibling plugin package. Build the plugin before starting or building the theme. Changing plugin server code requires another plugin build and host restart; React admin source is compiled by the host. The theme's [local setup and deployment guide](https://github.com/ZeroHostCMS/zhst-community-themes/tree/main/themes/erp-mini) owns its environment variables, auth setup and runtime commands.

Open the printed local URL, follow **Open workspace**, and complete EmDash's first-user/passkey setup. Use synthetic records. For a customer deployment, complete setup through a private operator-controlled route before exposing the site. Development bypass behavior is not production authentication evidence.

## First complete sale

1. **Customers:** create a customer; add the contact's name, email and phone. A contact belongs to one customer record.
2. **Items:** create a product or service with a unit and a price in the installation's currency. Quantities are whole units; a service can use visits, days or whole hours.
3. **Quotations:** choose the customer/contact, add items and quantities, set a valid-until date and save. Prices and customer details are copied server-side; totals are calculated in integer minor units.
4. Review the draft, then **Submit**. Submission freezes the offered details. It does **not** send email or create a tax invoice.
5. Record the customer's acceptance with **Accept quotation**, then **Create sales order**. Conversion creates exactly one order in the same atomic record.
6. **Orders:** view the original agreed details; record **Fulfilled** or **Cancelled** while the order is open. Fulfilled is an operator assertion, not proof of shipment, payment or an inventory movement.

A submitted quotation cannot be edited. Cancel an unconverted quotation and create a new draft for revised terms. Expired quotations cannot be accepted or converted; validity is evaluated against the server's UTC date. No background job silently changes statuses.

## Rules that customer forks must preserve

- **Private records:** CRM/sales use plugin storage; accounting uses its separate Node database. Neither is a public CMS collection or unauthenticated endpoint. Every route requires `plugins:manage`; the UI is not the authorization boundary. Editors, authors and subscribers cannot operate ERP mini.
- **One customer installation:** separate database, uploads/bucket, session storage, hostname and secrets. A supplied `tenantId` cannot switch installations. Sharing one database between customer forks is unsupported.
- **One business currency:** USD, EUR, GBP, VND or JPY; choose before first use. USD is the default. The saved configuration prevents an environment change from reinterpreting existing prices. Currency conversion requires a reviewed data migration, not changing a symbol.
- **Exact money:** prices are nonnegative integer minor units, capped at 1,000,000,000,000; quantities are positive integers up to 1,000,000. Server-checked multiplication and addition must remain safe integers. No taxes, discounts, foreign exchange or fractional quantities are implied.
- **Bounded work:** 25 records per page; at most 10 embedded contacts and 50 quotation lines. Search is a case-normalized name prefix on customer/item indexes. The UI offers pagination for lists and master-record selection.
- **No lost updates:** creates use a client UUID and absent-record compare-and-set; edits/actions require the last returned opaque revision. A conflict retains the user's form. Reload intentionally and reapply the change; never remove the revision or silently retry a stale mutation.
- **Historical truth:** submitted customer/contact/item/price snapshots do not follow later master edits or archives. Archiving does not erase history. No hard-delete API exists.
- **Stable contact selection:** `save-quote` accepts the displayed contact's `{ name, email, phone }` snapshot, not an array index. The server matches it against that customer's current contacts. Reordering cannot change the recipient; a changed/removed contact returns a conflict until the operator explicitly reloads/reselects.
- **Atomic sales conversion:** quotation and its optional order are one `sales` aggregate. Cross-record EmDash storage calls are not a financial transaction; accounting uses its separate SQLite transaction owner.
- **Versioned data:** unknown CRM/sales record versions and accounting schema versions are rejected rather than overwritten by older code. Metadata comes from the authenticated actor and server clock, not user input. CRM/sales timestamps are not a full append-only audit log; accounting has its own immutable audit owner.

The executable contract is in [`src/model.ts`](src/model.ts), [`src/validation.ts`](src/validation.ts), [`src/service.ts`](src/service.ts) and [`src/index.ts`](src/index.ts). Read those before changing a business rule.

## API and source layout

`src/index.ts` declares the native descriptor, private storage and bounded routes. `src/service.ts` owns business decisions and conditional writes. `src/admin/` owns the React UI; it must not import server runtime modules. `tests/` exercises observable business and storage behavior.

Routes use the prefix `/_emdash/api/plugins/erp-mini`:

| Route | Method | Operation |
| --- | --- | --- |
| `info` | GET | Installation currency and supported bounds |
| `list` | POST | Paginated customers, items, quotations or orders |
| `get` | POST | One record and its current opaque revision |
| `save-customer` | POST | Create/edit/archive customer and embedded contacts |
| `save-item` | POST | Create/edit/archive an item or service |
| `save-quote` | POST | Create/edit an unsubmitted quotation |
| `transition` | POST | Validated quotation/order state transition |

Use the same-origin EmDash client utilities, which include `X-EmDash-Request: 1`. Core authentication/permission failures use EmDash's HTTP error response. Expected business errors are **inside** the standard success envelope:

```json
{"success":true,"data":{"ok":false,"error":{"code":"CONFLICT","message":"…"}}}
```

Check both envelopes; HTTP 200 alone does not mean the change was applied. Do not bypass authorization by invoking the service from a public endpoint. No MCP tool or userless machine-token write access is provided by this plugin.

## Adapt ERPNext workflows and customize with AI

Read the [porting and customer-fork guide](docs/porting.md), then the local [AI engineering rules](AGENTS.md). Start from a written business rule and synthetic examples, not a bulk copy of a Frappe application. Reuse the EmDash auth, admin and storage interfaces rather than forking core.

The community root [contribution guide](../../CONTRIBUTING.md) owns fork/branch/PR review. A customer-only customization can remain in that customer's private fork; generic improvements should be submitted upstream without customer records, credentials or proprietary rules.

### Internal VND bookkeeping

The [business contract](docs/accounting.md) owns the accepted bookkeeping requirements and exclusions; the [storage and operations guide](docs/accounting-storage.md) owns startup schema migration, explicit book setup, financial recovery and paired backup/rollback decisions. The paired VND Node host initializes/verifies its separate `accounting.db` before listening; installing the plugin alone, building or refreshing a page does not migrate a database. It never automatically posts sales orders. Cloudflare continues to provide CRM/sales without accounting.

Public entry points are declared in [`package.json`](package.json): `./accounting` is the pure domain/HTTP export; `./accounting-node` owns the Node SQLite driver and checksummed schema migrations. The paired host owns authenticated routes and resource lifecycle. Enablement is not book setup: schema migration precedes an administrator's explicit immutable start-date setup, accounts and opening entries. No chart of accounts or business balances are seeded automatically, and VND support is not Vietnamese legal certification.

After book setup, **Accounting → Accounts → Nhập từ bộ tài khoản mẫu** offers the complete offline **TT133/2016** and **TT99/2025** catalogs (dataset version `"1"`). Choose the regime explicitly, select all or ledger subsets, preview ancestors/conflicts, then confirm. Import is atomic and create-only; it never overwrites existing accounts, converts regimes, posts journals or adds foreign-currency/statutory-report support. Uncertain outcomes retain the exact session command for reconciliation after reload. See the [catalog/import contract](docs/accounting.md#311-bộ-mẫu-việt-nam-và-phân-loại).

This release requires accounting **schema2**. Startup upgrades an exact checksummed schema1 without changing business history; `result` classifies account911 and import receipts are separate from journal receipts. Stop old writers and take the [paired SQLite-aware backup](docs/accounting-storage.md#schema1--schema2) **before starting** the rebuilt plugin/host pair. Upgrade is forward-only: older schema1 code cannot open schema2; rollback restores its matching DB/code backup, not a down-migration. Record/book format versions remain1.

## Pack and distribute an approved native plugin

After the source and dependency review, run from this package:

```sh
npm ci
npm run check
npm pack
```

Install the resulting `zerohost-plugin-erp-mini-0.1.0.tgz` into an isolated host with `npm install --save-exact /absolute/path/to/the.tgz`, then rebuild the host and exercise the browser workflow. The tarball ships compiled server code, React admin source and the shared model; it does not rely on a live community checkout. Record both repository commits, the lockfiles, tarball SHA-256 and exact core version. Keep the immutable tarball in your private approved artifact storage; do not publish a customer fork or package to npm without authorization.

The sibling `file:` dependency is for development. A deployed release uses a reviewed immutable artifact or a complete immutable application image, not a symlink to a moving branch.

## Upgrades, data retention and rollback

Follow [core compatibility and release operations](docs/compatibility.md). Daily CI checks a pinned release and npm's current `emdash` release. A passing candidate does not update a customer. Dependabot opens reviewable dependency PRs; nothing auto-merges or deploys.

Before an upgrade, follow the [paired backup and rollback procedure](docs/accounting-storage.md#4-currency-migration-và-vận-hành), keep the previous artifact, and prove recovery in an isolated installation. EmDash can apply core migrations on the **first request**, before a human visits the dashboard. Database migrations are not undone by rolling back a package. Restore a compatible database/artifact pair; do not start older code against newer data.

Removing the plugin registration or deactivating it removes access to its pages/routes but retains stored business records. Uninstall is not deletion, archival or a backup. Destructive erasure and retention policies need an explicit operator-approved procedure and customer authorization.

## Licensing and scope

This independent implementation is [MIT](LICENSE). Upstream [EmDash](https://github.com/emdash-cms/emdash) is MIT. [ERPNext](https://github.com/frappe/erpnext) is GPL-3.0; its public [Quotation](https://docs.frappe.io/erpnext/quotation) and [Sales Order](https://docs.frappe.io/erpnext/sales-order) workflows inform terminology, not copied code/assets. Do not paste ERPNext source into this MIT package and assume the license changes. Obtain license review before redistributing derived GPL work.

The architecture permits independently maintained customer variants. It is **not evidence of capacity for thousands of customers**; database limits, Worker CPU, backups, support, upgrade cohorts and per-customer cost still need operational measurement. Cloudflare review/deployment is a separate manual acceptance gate; a local Node build is not deployed-Worker evidence.
