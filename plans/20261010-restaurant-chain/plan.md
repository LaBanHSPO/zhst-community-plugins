# Cloudflare restaurant chain

Status: implemented and locally verified. Provider conformance, production resources, load validation, and ZeroHostCMS promotion remain operator release gates, not completed claims. See [verification evidence](phase-04-verification.md#observed-results).

## Outcome

Deliver a new `restaurant-chain` native plugin and companion theme, derived from the public ERP mini conventions without changing ERP mini or EmDash core. One online-only installation serves approximately 50 Vietnamese restaurant branches. Guests scan a table QR or tap an NFC URL, submit orders, staff confirm, kitchen prepares, cashier generates a branch-specific SePay bank-transfer QR, and cashier/accountant issues SePay electronic invoices and exports accounting source data.

## Constraints and non-goals

Cloudflare Workers, D1, Queues, scheduled recovery, and R2 only. No PostgreSQL, offline synchronization, complex BOM, inventory valuation, purchasing, general ledger, production deployment, real bank transfers, or real tax invoice issuance. Local fixtures are synthetic. Separate branch bank accounts do not imply separate legal issuers. Legal issuer/tax configuration is operator-owned; no tax rate is inferred from Vietnamese law. Preserve independent ERP mini packages and their data namespaces.

Runtime baseline: released EmDash 1.2.0, Astro 7.3.5, Cloudflare adapter 14.3.3; local tooling needs Node 24.15+ within 24.x or Node 26+. Hosting promotion remains manual and must reconcile the documented older platform baseline.

## Source ownership

- `plugins/restaurant-chain`: package, domain schema/migrations, authorization, native registration, staff React UI, SePay adapters, recovery, tests, operator guide.
- `../zhst-community-themes/themes/restaurant-chain`: standalone Cloudflare host, guest React menu, API transport, Worker scheduled/queue handlers, local-only fixtures and runtime smoke, deployment configuration.
- No modifications to `emdashcms` or existing `erp-mini` source.

## Consistency architecture

A dedicated `RESTAURANT_DB` D1 binding owns all restaurant records. EmDash's `DB` owns CMS/auth. No cross-database atomicity is claimed. Restaurant commands use D1 `batch()` with parameterized statements, command idempotency, revision/state fences, and database constraints. A zero-row guarded update must not permit downstream effects. Accepted snapshots, kitchen work, bill/payment effects, audit records and outbox intent are committed together where they share an invariant.

D1 outbox records, not Queue delivery, are authoritative unfinished work. Messages carry job IDs. Jobs use bounded attempts, persisted next-attempt times and lease tokens; the scheduler rediscovers due work after missed enqueue, exhausted delivery or expired leases. Consumers acknowledge only after persistence. Duplicate deliveries must have no additional local effect. Do not put confirmed kitchen tickets behind queue availability.

Authenticated SePay webhooks commit an inbox receipt and processing intent before returning HTTP 200 with `{"success":true}`. Deduplicate by environment/provider context/provider transaction ID. Payment matching requires incoming direction, receiving account, reference and amount; mismatches remain visible exceptions. Numeric webhook IDs and API-v2 UUIDs are not interchangeable.

External invoice submission is not exactly once merely because an outbox exists. Persist request intent/reference/payload before sending; retain independent create/issue tracking codes. A lost response or expired lease during dispatch enters `outcome_unknown`, never automatic resubmission. Reconcile by reference; retain ambiguity for operator review when the provider contract cannot establish safe retry. Provider pending/issued/tax-authority state are separate from payment state.

## Domain and UI requirements

- Branches, branch memberships (manager, floor, kitchen, cashier, accountant), tables, visits and server-generated guest session tokens. EmDash admin is a provisioning override; other actors require explicit membership.
- Branch-scoped sellable menu with name/category/description/image, integer VND price, explicit tax rate, availability and modifiers. Accepted orders snapshot commercial data.
- A static table link permits joining the current visit but does not itself authorize ordering into all future visits. Staff opens/closes visits; guest receives a distinct visit-bound token. Closed/expired visits reject old tokens.
- Guest requests remain pending until staff confirmation. Additional requests are independent. Kitchen item transitions: queued -> preparing -> ready -> served. Rejections and authorized voids retain reason/history.
- Bill freeze creates an immutable payment attempt with receiving-account snapshot/reference/amount. Pending requests and unsettled preparation must be clearly represented. Late/superseded QR transfers remain reconcilable; generating a QR does not cancel previous bank-transfer capability.
- Cashier/accountant invoice request snapshots buyer and issuer data and accepted lines. Support draft/create/issue tracking, retrieval, adjustment/replacement, and visible failure/unknown recovery actions. No blind retry of unknown requests.
- Bounded branch/date-scoped CSV exports for sales lines, payments, invoices and audit/adjustments, with stable linking IDs, Asia/Ho_Chi_Minh business dates and spreadsheet formula-injection protection.
- Vietnamese primary UI; user-facing admin text through Lingui, semantic Kumo controls, logical CSS and accessible loading/error/pending states. Guest menu must be polished and mobile friendly. Verify actual browser surfaces including RTL.

## Shared implementation interfaces

Plugin server subpath `@zerohost/plugin-restaurant-chain/server` exports `RestaurantService`, `DomainError`, `handleRestaurantRequest`, `processJobs`, `dispatchOutbox`, `receivePaymentWebhook`. Public descriptor export is `restaurantChainPlugin`; native loader export is `createPlugin`; admin export follows `PluginAdminExports` with page `/workspace`.

`RestaurantService` is constructed with `(db: D1Database, actor: {id: string; administrator: boolean} | null)` and exposes `execute(action: string, input: unknown): Promise<unknown>`. Branch access is enforced in the service for all private actions, never just in UI. Guest methods validate visit tokens instead of actor. Domain agent owns concrete DTOs in `src/domain/types.ts` and posts them to other owners as soon as written.

HTTP is `/api/restaurant/[action]`: GET for `info`, `workspace`, `menu`, `guest-status`, `export`, `invoice-file`; POST for commands. GET input comes from URL query; POST JSON is bounded and validated. JSON responses are `{ok:true,data}` or `{ok:false,error:{code,message}}` with meaningful HTTP status. Browser mutation transport requires same-origin Origin and `X-EmDash-Request: 1`; webhooks are a separate authenticated endpoint. Never expose raw database/provider errors.

Service actions: `info`, `workspace`, `save-branch`, `save-member`, `save-table`, `save-menu-item`, `open-visit`, `close-visit`, `join-table`, `menu`, `guest-status`, `submit-order`, `confirm-order`, `reject-order`, `kitchen-transition`, `void-order`, `create-payment`, `request-invoice`, `issue-invoice`, `correct-invoice`, `reconcile-invoice`, `export`. Mutating staff/guest commands carry `commandId`; revision-sensitive commands carry `expectedVersion`. Role/action matrix and strict input schemas belong to domain owner. Admin UI must match actual DTOs, not invent response fields.

Resources for integration functions are dependency-injected D1, Queue and fetch/clock/config primitives, not process-global request state. Host binds actual Cloudflare env in its server adapter. Integration owner defines `IntegrationOptions` and job payloads with domain owner before code dependencies. Credentials are runtime secrets selected by branch credential-context identifiers, never editable raw keys in browser forms or public data. Secret JSON maps may support multiple company contexts. Sandbox/live mode is explicit.

## Delivery phases

1. [Phase 1: transactional domain](phase-01-domain.md).
2. [Phase 2: SePay and recovery](phase-02-integrations.md).
3. [Phase 3: staff and guest surfaces](phase-03-surfaces.md).
4. [Phase 4: verification and operations](phase-04-verification.md).

## External prerequisites and evidence ceiling

Local tests use real Miniflare D1 and controlled HTTP responses for provider failure scenarios. They do not establish SePay production eligibility, bank connectivity, tax compliance, 50-branch throughput, or production TLS. Authorized sandbox/live credentials and actual seller/provider configuration are required for provider conformance. No secrets are requested in chat. Unknown-outcome recovery and ambiguous cross-API payment identities remain operator-visible rather than simulated success.

## References

- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook
- https://developer.sepay.vn/vi/sepay-api/v2/nang-cap-tu-v1
- https://developer.sepay.vn/vi/einvoice-api/v1/tong-quan
- https://developer.sepay.vn/vi/einvoice-api/v1/xu-ly-loi
