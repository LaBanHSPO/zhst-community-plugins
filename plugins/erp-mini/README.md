# ERP mini — CRM and sales for EmDash

A native EmDash plugin for **customers and contacts → items/services → quotations → sales orders**. It implements a small, independent sales workflow inspired by ERPNext. It does not run Frappe apps, import Python DocTypes, connect to an ERPNext server, or implement accounting, tax, stock valuation, payments or payroll.

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

- **Private records:** plugin storage, never a public CMS collection or unauthenticated Astro endpoint. Every route requires `plugins:manage`; the UI is not the authorization boundary. Editors, authors and subscribers cannot operate ERP mini.
- **One customer installation:** separate database, uploads/bucket, session storage, hostname and secrets. A supplied `tenantId` cannot switch installations. Sharing one database between customer forks is unsupported.
- **One business currency:** USD, EUR, GBP, VND or JPY; choose before first use. USD is the default. The saved configuration prevents an environment change from reinterpreting existing prices. Currency conversion requires a reviewed data migration, not changing a symbol.
- **Exact money:** prices are nonnegative integer minor units, capped at 1,000,000,000,000; quantities are positive integers up to 1,000,000. Server-checked multiplication and addition must remain safe integers. No taxes, discounts, foreign exchange or fractional quantities are implied.
- **Bounded work:** 25 records per page; at most 10 embedded contacts and 50 quotation lines. Search is a case-normalized name prefix on customer/item indexes. The UI offers pagination for lists and master-record selection.
- **No lost updates:** creates use a client UUID and absent-record compare-and-set; edits/actions require the last returned opaque revision. A conflict retains the user's form. Reload intentionally and reapply the change; never remove the revision or silently retry a stale mutation.
- **Historical truth:** submitted customer/contact/item/price snapshots do not follow later master edits or archives. Archiving does not erase history. No hard-delete API exists.
- **Stable contact selection:** `save-quote` accepts the displayed contact's `{ name, email, phone }` snapshot, not an array index. The server matches it against that customer's current contacts. Reordering cannot change the recipient; a changed/removed contact returns a conflict until the operator explicitly reloads/reselects.
- **Atomic conversion:** quotation and its optional order are one `sales` aggregate. Cross-record storage calls are not a transaction; this package is not a general financial ledger.
- **Versioned data:** values carry `schemaVersion`. Unknown versions are rejected rather than overwritten by an older fork. Metadata comes from the authenticated actor and server clock, not user input. Timestamps are not a full append-only audit log.

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

Before an upgrade, take a consistent database and media backup, keep the old artifact, and restore the backup into an isolated installation to prove recovery. EmDash can apply core migrations on the **first request**, before a human visits the dashboard. Database migrations are not undone by rolling back a package. Restore a compatible database/artifact pair; do not start older code against newer data and hope for compatibility.

Removing the plugin registration or deactivating it removes access to its pages/routes but retains stored business records. Uninstall is not deletion, archival or a backup. Destructive erasure and retention policies need an explicit operator-approved procedure and customer authorization.

## Licensing and scope

This independent implementation is [MIT](LICENSE). Upstream [EmDash](https://github.com/emdash-cms/emdash) is MIT. [ERPNext](https://github.com/frappe/erpnext) is GPL-3.0; its public [Quotation](https://docs.frappe.io/erpnext/quotation) and [Sales Order](https://docs.frappe.io/erpnext/sales-order) workflows inform terminology, not copied code/assets. Do not paste ERPNext source into this MIT package and assume the license changes. Obtain license review before redistributing derived GPL work.

The architecture permits independently maintained customer variants. It is **not evidence of capacity for thousands of customers**; database limits, Worker CPU, backups, support, upgrade cohorts and per-customer cost still need operational measurement. Cloudflare review/deployment is a separate manual acceptance gate; a local Node build is not deployed-Worker evidence.
