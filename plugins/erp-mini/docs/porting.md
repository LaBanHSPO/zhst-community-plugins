# Adapt ERPNext workflows; keep EmDash as the core

This guide is for ERP developers creating an independent customer-specific ERP mini, with or without an AI coding assistant. Start with the [working CRM/sales package](../README.md), not a Frappe fork. The implementation uses TypeScript, Astro, React and EmDash plugin storage; no Bench, Python, Redis, MariaDB or ERPNext server is required.

## 1. Pick the customer boundary before code

One installation is one business and its administrators. Keep its hostname, database, media, sessions, secrets and backups separate. Forked source is not data isolation by itself. Never put two customers into the same database and rely on a browser-provided `tenantId`, a different plugin name, hidden menu items or a filtered frontend.

Choose the business currency before entering CRM/sales records. That workflow supports USD/EUR/GBP (two minor digits) and VND/JPY (zero) and rejects currency reinterpretation. Internal accounting requires VND on the paired Node host; its immutable book setup and separate database do not convert existing sales data. Document the customer's timezone and remember that quotation expiry uses UTC dates.

For each requested customization, record:

- The business actor and permission needed; the starter allows administrators only.
- Inputs, units and money precision; authoritative master records and immutable snapshots.
- Allowed states and transitions, including cancellation, repeated requests and concurrent users.
- What must commit atomically; which data may be temporarily inconsistent.
- Private data, retention, backups, migration and recovery owner.
- Observable acceptance examples and explicit exclusions.

Do not call a feature accounting, tax-compliant invoicing or stock valuation without implementing and reviewing the corresponding rules.

## 2. Understand the mapping, not just the names

| ERPNext concept | ERP mini owner | Adaptation boundary |
| --- | --- | --- |
| Company | One separately configured installation | No cross-company consolidation or shared company selector |
| Customer | `customers` plugin collection | Code/name/contact/address and archive; no credit limit or accounting defaults |
| Contact linked to Customer | Embedded bounded contacts | No polymorphic Dynamic Link or global contact merge |
| Item and selling Item Price | `items` plugin collection | One price/currency/unit; no price-list rules or warehouses |
| Quotation and child items | `sales` aggregate, draft then submitted | Up to 50 lines; server-created customer/item/price snapshots |
| Submit / `docstatus` | Explicit plugin transitions | No arbitrary client-controlled status or generic Frappe document hooks |
| Accepted quotation → Sales Order | Conditional update of the same aggregate | Exactly one order per quotation, not two nontransactional inserts |
| Delivery/billing progress | Open → fulfilled/cancelled order | Manual commercial completion only; no delivery note, invoice, payment or ledger effect |
| Custom Field / Client Script | Typed schema, service, React form in the fork | No stored arbitrary JavaScript evaluation |
| Role Permission Manager | EmDash `plugins:manage` | Admin-only baseline; do not claim salesperson-level permissions |
| App migrations / patches | Reviewed versioned plugin-data migration in a fork | Core and plugin data versions are separate; changing a seed is not migration |

Reference behavior comes from ERPNext's [Quotation](https://docs.frappe.io/erpnext/quotation) and [Sales Order](https://docs.frappe.io/erpnext/sales-order) documentation. Terminology is not full feature parity. CRM/sales intentionally omits ERPNext taxes, stock, pricing rules, partial fulfillment, amendments, invoicing and email delivery. The independent [internal accounting contract](accounting.md) adds manual Node/VND bookkeeping, not automatic sales posting or statutory ERPNext accounting parity.

## 3. Fork only the extension layer

Fork both community repositories to the customer or development organization. Clone them as sibling directories named `zhst-community-plugins` and `zhst-community-themes`; follow the package README to install and run.

Within each clone, add the community source as an upstream remote and create a feature branch:

```sh
git remote add upstream https://github.com/ZeroHostCMS/zhst-community-plugins.git
git switch -c customer/acme-sales
```

In the theme clone, use `https://github.com/ZeroHostCMS/zhst-community-themes.git` for its upstream instead. `acme` is a synthetic example, not an existing customer. Do not commit real records or secrets.

Keep EmDash as an exact npm dependency. Do not vendor its source, patch `node_modules`, import `emdash/internal/*`, or maintain a private core branch to add customer business fields. If a necessary capability is missing upstream, open a focused EmDash issue/PR and keep the customer release pinned until a supported API exists. Do not paper over it with an internal import.

Keep the existing `erp-mini` plugin identity for a fork that replaces this starter in its own installation. Renaming the plugin changes its storage namespace and does **not** migrate records. Use a new identity only for a deliberately separate plugin with a reviewed data-transfer plan.

Maintain one reusable community implementation where possible. Thousands of independently modified copies increase upgrade/support cost. Prefer small typed configuration and narrowly scoped customer commits; do not create a general metadata framework or remote-code loader merely to avoid a few explicit business rules.

## 4. Make one complete customization

Example requirement: a customer needs a purchase-order reference on a quotation, immutable after submission.

1. Define the reference's maximum length, whether it is required, and whether uniqueness is actually a business rule. A display label is not a unique document identifier.
2. Extend the quotation value and save-input schema in `src/model.ts` and `src/validation.ts`. Reject unknown input fields; do not accept arbitrary JSON metadata from the browser.
3. In `src/service.ts`, accept that field only during draft save. Preserve the server-owned metadata, currency, snapshots, totals and revision checks. The existing transition path must not rewrite it after submission.
4. In `src/admin/`, add a labeled draft control and a read-only quotation/order detail field. Preserve unsaved input on network errors or revision conflict. Do not send copied calculated totals to the server as authority.
5. For existing installations, define a new data version and an explicit migration/default for old records. Back up and test against a restored copy, including rerunning an interrupted migration and rejecting newer unsupported versions. The baseline package does not ship a generic migration runner; the extension author owns that migration before deploying a changed persisted schema.
6. Add behavior tests: allowed draft save, invalid/overlong input rejection, frozen field after submission, stale-edit rejection, old-record migration and failure recovery. Test outputs and persistence, not source-text snapshots.
7. Rebuild the plugin and theme, then perform the real browser workflow using synthetic data. Include the field in both the quotation and resulting order review.

Use the same vertical-slice method for another CRM/sales customization. Accounting is not a field extension: the existing [separate SQLite design and operations](accounting-storage.md) owns its financial consistency boundary. EmDash storage compare-and-set is **single-record atomicity**; `putMany()` is not a cross-record transaction, especially on D1. Do not extend accounting by distributing financial invariants across independent CRM writes. A new stock ledger still needs its own reviewed consistency and operational/legal design.

## 5. Use AI as a supervised development tool

The local [`AGENTS.md`](../AGENTS.md) is the enforceable starting context for a coding assistant. Give it source, synthetic examples, the business requirement and the intended acceptance check—not production database exports or credentials.

A useful request is:

> Read the ERP mini README, AGENTS.md, model, validation, service and relevant admin form. Add a draft-only purchase-order reference with a 100-character limit. Preserve EmDash authentication, private storage, integer totals, immutable submitted snapshots and revision conflicts. Propose the persisted-data migration before changing existing records. Add behavior tests and exercise the actual browser flow. Do not patch core, deploy, publish, add remote AI calls, or copy ERPNext code.

Review the resulting diff and dependency changes. Run the checks yourself. AI-generated code has no extra authority to migrate, install native code, publish, contact customers, or access production. The starter includes no runtime LLM service, AI API key, customer-data prompt pipeline or autonomous business-action tool.

## 6. Move data deliberately

No automatic ERPNext database, DocType or CSV importer is included. For a small initial dataset, create customers/contacts and items through the UI; preserve the source's stable external reference in the `code` field. That field is not a uniqueness constraint or an idempotency key.

For a larger migration, first design a separate reviewed import tool against the plugin's validated commands and supported authentication. The baseline disallows userless tokens; do not bypass that by exposing the service publicly. An operator-only offline migration may use documented EmDash database/storage APIs in a private environment, but must preserve the same validation, revisions, actor attribution and snapshot rules. Do not ship a fake success response or silently skip unsupported rows.

Before implementing an importer, produce a mapping and reconciliation sheet:

| Source data | Required decision |
| --- | --- |
| Customer name / identifier | Normalize names; map source IDs to new UUIDs; detect duplicates instead of treating `code` as unique |
| Contact links | Resolve the owning customer; reject ambiguity; split/review records over the 10-contact bound |
| Item UOM / quantity | Only whole-unit quantities supported; do not round fractional quantities without explicit business approval |
| Item Price / currency | One configured currency; parse exact minor units; reject excess precision and unsupported currencies |
| Quotation rows | Resolve current masters; do not silently import historical prices as today's item prices |
| Submitted historical documents | Preserve their original legal/history record elsewhere unless a separately reviewed historical-import contract exists |
| Historical sales invoices, payments, stock and taxes | No historical accounting-import contract; do not transform these into quotations or manual entries and claim a migrated statutory ledger |

Test dry-run rejection reports, deterministic source-ID mapping, interrupted resume, repeat-run behavior, amount reconciliation and rollback using synthetic or authorized redacted input. Keep real extracts in restricted storage, never public Git, CI artifacts or AI prompts. Archive the source ERP read-only until the customer accepts the reconciliation.

## 7. Contribute and release

Submit a reusable change as a PR to the relevant community repository. If both repositories change, link the PRs and provide the exact tested source pair. Include the business rule, behavior evidence, data-version/migration impact, permission/dependency changes and license provenance. Customer-only configuration and confidential business logic can stay private.

Community acceptance, manual ZeroHostCMS review deployment, and private hosting-platform publication are three separate decisions. Follow the root contribution guide. Do not expect a community merge, submodule refresh or dependency PR to register the ERP in the website catalog.

For many customer variants, retain a private release inventory with: customer installation ID; theme/plugin commits; core and adapter versions; lockfile/artifact hashes; database/resource identity; last verified backup; migration version; test evidence; rollout cohort; approver and rollback artifact. Never publish that inventory in these public repositories.

Roll out a reviewed upgrade to an isolated restored fixture, then an explicitly approved small cohort, then the remaining installations after observing agreed health checks. A daily compatibility job is an early warning, not a fleet deployment controller or evidence that thousands of customers were load-tested.
