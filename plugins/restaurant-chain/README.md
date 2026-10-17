# Restaurant chain plugin

A native EmDash plugin for online restaurant operations in Vietnam: table ordering, staff confirmation, kitchen preparation, branch bank-transfer collection through SePay, electronic invoices, and accounting source exports. Use it with the [Cloudflare restaurant theme](../../../zhst-community-themes/themes/restaurant-chain/README.md).

The plugin uses a dedicated D1 database. It does not modify ERP mini collections or EmDash core. Inventory, bills of materials, purchasing, payroll, offline ordering, and a general ledger are outside this package.

## Run locally

Clone `zhst-community-plugins` and `zhst-community-themes` as siblings. Use Node 24.15 or later in the 24.x line, or Node 26 or later. Run the following commands from this directory to install, check, and build the plugin.

```sh
npm ci
npm run check
```

Then follow the [theme setup](../../../zhst-community-themes/themes/restaurant-chain/README.md#run-locally). The native admin page is `/_emdash/admin/plugins/restaurant-chain/workspace`. This package alone does not mount HTTP routes or consume Cloudflare Queues; the paired theme does both.

## Configure a branch

1. Sign in as an EmDash administrator and open **Nhà hàng → Thiết lập**.
2. Create the branch. Enter its receiving bank code, account number, and bank name as reported by SePay's `gateway` field. The bank name is not the account holder's name.
3. Select the receiving mode: `direct` uses the bank account; `virtual` uses the configured virtual account; `memo` uses the bank account with `TKP` and the sub-account in transfer content. Use SePay's exact onboarding configuration. A transfer prefix such as `SEVQR` is separate from the payment reference.
4. Set a credential-context identifier and explicit `sandbox` or `live` environment. Configure that context in the host's `SEPAY_CONTEXTS` secret, not in the browser.
5. Enter the approved invoice seller, provider-account UUID, template code, invoice series, and optional business-location UUID (`seller_store_xid`). Separate receiving accounts do not establish separate legal sellers. Obtain these values from the approved SePay provider account.
6. Create tables, menu items, and branch memberships. Invite users through EmDash first, then use their user IDs when assigning restaurant roles.
7. Generate each table's ordering QR under **Mã QR gọi món tại bàn**. Download the PNG or print it. Copy the same URL into an NFC tag using the tag writer of your choice. The application does not require Web NFC support.

Configure SePay payment-code extraction with prefix **RC**, an **alphanumeric suffix of 30 characters**, and the appropriate receiving accounts. Do not configure a shorter numeric-only pattern. The cashier QR contains the server-generated reference; webhook allocation requires SePay to return the complete reference in `code`.

Read SePay's [QR configuration](https://developer.sepay.vn/vi/tien-ich-khac/tao-qr-code) and [payment-code recognition](https://developer.sepay.vn/vi/sepay-webhooks/cau-hinh-ma-thanh-toan) before onboarding each bank. Some bank/account types require a virtual account or a particular transfer prefix.

## Operate a table

Staff opens a visit before guests join. Guests scan the table QR or tap NFC, choose dishes and modifiers, and submit a request. Pending requests do not contribute to the bill. Staff confirms or rejects each request; only confirmed dishes enter the kitchen. A guest line carries the unit price it saw; if the menu price changed meanwhile, the submission is refused with `PRICE_CHANGED` until the guest re-confirms the new price, so a party is never charged a price it did not see.

Kitchen progresses each line through **queued → preparing → ready**. Floor staff marks delivery as **served**. The cashier can freeze the bill and generate a payment QR only after pending requests and unserved dishes are resolved. Prices, tax, modifiers, and receiving details are snapshotted; editing the menu or branch configuration does not rewrite earlier transactions.

A table URL is a bearer link, not proof of physical presence. Guest sessions are bound to the current visit, and closed or expired visits reject their tokens. Someone retaining the static table URL can attempt to join a later open visit. Staff confirmation remains necessary.

The role selector on an administrator's screen changes the workspace view; it does not impersonate another user or replace server authorization. Non-administrators receive only their assigned branch role.

| Role | Allowed work within assigned branches |
| --- | --- |
| Manager | Tables, menu, memberships, floor operations, kitchen preparation, collection, invoices, exports |
| Floor | Open/close visits, confirm/reject requests, mark dishes served |
| Kitchen | View confirmed orders, start preparation, mark dishes ready |
| Cashier | Floor operations, authorized voids, payment QR, invoices |
| Accountant | Invoice operations and accounting exports |

EmDash administrators can configure bank accounts and legal issuers and access all branches. Branch managers cannot change those receiving or issuer settings.

## Call staff and request the bill from the table

While their visit is open, a guest can raise a service request from the table surface:
**Gọi nhân viên** (a waiter) or **Yêu cầu tính tiền** (the bill). At most one open
request of each kind exists per visit, so repeated taps do not flood the floor. Floor,
cashier and manager roles see the open queue in the workspace and mark a request
**Đã xử lý**; the guest status shows an open request until it is handled. Kitchen roles
do not receive these requests. A closed or expired visit rejects new requests.

## Open a shift and settle a bill by hand

The dine-in MVP settles tables without any external provider. A cashier or manager
opens one shift per branch (**Ca làm việc → Mở ca**), recording the opening float.
Recording cash requires an open shift; bank transfers do not.

Freezing a bill (**Chốt bill**) snapshots every confirmed, served and still-unbilled
order of one visit into a single payable amount using one method. Freezing is refused
while any request is pending or a confirmed dish is unserved, and a table can hold only
one open bill. Once frozen, the orders are locked: they cannot be voided, and additional
guest requests start a new round with its own bill after the first is settled.

Settlement records the method (`cash` or `bank_transfer`), an optional transfer
reference, and the operator. Cash is counted toward the shift drawer; the transfer rule
is that a cashier confirms a bank transfer only after checking the money actually
received. Settling does not free the table — staff still close the visit. Closing a
shift (**Chốt ca**) compares the counted cash against the expected drawer (opening float
plus settled cash) and stores the variance and note.

The SePay QR flow below remains available for operators who configure a provider; it is
independent of manual bills and is not required for the MVP.

## Clean a table between parties

Settling a bill does not free the table. Closing the visit (**Kết thúc lượt**) marks the
table dirty, and a new visit cannot open on that table until staff mark it clean (**Đã
dọn bàn**). The floor plan shows a distinct "needs cleaning" state, so the sequence is
settle → close → clean → seat the next party.

## Discount and refund a bill

A manager can apply a discount to an open bill by amount or percent with a reason
(**Giảm giá**); the payable amount becomes the bill total minus the discount, and cash
settlement and the shift drawer use that payable amount. A settled bill is never edited
in place: a manager refunds it (**Hoàn tiền**) up to the amount actually received,
recording a method and reason. Cash refunds require an open shift and reduce that shift's
expected drawer. Every discount and refund is written to the audit log and listed in the
refund history. A dish that is already in preparation can only be voided by a manager.

## Confirm payment

Generating or displaying a QR does not mark a bill paid. The host authenticates the SePay webhook, saves the inbox receipt and processing job in one D1 batch, then acknowledges it. Queue processing verifies incoming direction, context/environment, receiving bank/account/sub-account, reference, amount, and attempt status before allocating money.

Repeated delivery of the same provider transaction does not allocate again. Underpayments, overpayments, wrong-account transfers, missing references, distinct second transfers, and superseded QR transfers remain exceptions. Review them against the bank/SePay statement; do not clear them by editing financial rows. Correct the source or request an authenticated SePay replay when a webhook was missed.

An old QR remains usable at the bank after a replacement QR is generated. The application preserves both attempts and rejects automatic allocation to a superseded attempt.

Optional SePay API-v2 reconciliation records bank transactions for review. Its UUIDs are not equivalent to webhook numeric IDs. Ambiguous matches never create a second financial effect. Retain the credential context for an old company/account while historical payments and invoices still need reconciliation.

## Issue an electronic invoice

For a paid bill, enter the buyer information and select **Lập hóa đơn**. This creates a durable intent and requests a provider draft. Request acceptance is not issuance. After a confirmed draft appears, select **Phát hành hóa đơn**. Create and issue operations retain separate tracking codes. Provider status and tax-authority status are displayed independently.

Prices are integer VND and tax-inclusive. Configure the applicable rate explicitly; supported rates are 0%, 5%, 8%, and 10%. The software does not determine which tax treatment applies. Invoice lines preserve the paid total and quantity; where an integer net unit price cannot represent a line exactly, the payload splits it into at most two unit-price groups. Template `2` sends the gross price without VAT fields. Have the accountant verify the selected template and rounding against the actual provider before production use.

For an issued invoice, adjustment sends only the difference: positive prices increase, negative prices decrease, and a single adjustment cannot mix directions. Replacement sends the full replacement content. Changing the correction type resets its lines. The original issuer configuration is retained. PDF/XML downloads require branch finance access and are served as private attachments.

| Visible state or job error | Operator action |
| --- | --- |
| `INVOICE_CREDENTIALS_UNAVAILABLE` or reviewed pre-dispatch job | Correct host credentials/configuration, then select **Đối soát trạng thái**. An undispatched operation can resume with its original payload and reference. |
| `pending` with a reviewed polling job | Select **Đối soát trạng thái** to resume polling the known tracking code. Do not create another invoice. |
| `outcome_unknown` | Reconcile by reference. A timeout or immediate 404 does not prove the provider rejected the operation. Do not resubmit or change its reference; contact SePay if ambiguity remains. |
| Provider `failed` | Review the provider/account/quota problem and reconcile. This implementation does not automatically resubmit a dispatched failed operation. Obtain a definitive provider recovery decision. |
| Issued but tax-authority response pending | Reconcile the existing invoice; do not issue another one. |

See the [SePay invoice lifecycle](https://developer.sepay.vn/vi/einvoice-api/v1/tong-quan) and [error/recovery contract](https://developer.sepay.vn/vi/einvoice-api/v1/xu-ly-loi). Lost tracking responses can require SePay assistance, including for later document retrieval.

## Export accounting source data

Managers and accountants can export sales lines, payments, invoices, and audit records under **Xuất dữ liệu**. Exports are branch-scoped and use `Asia/Ho_Chi_Minh` business dates, with a maximum 32-date inclusive range. The interface follows cursor pages to produce the CSV. Stable IDs link order lines, visits, payments, receipts, and invoices. Text cells are protected against spreadsheet formula execution.

These are source-data exports, not a tax return or a general ledger. Keep the original provider-issued XML/PDF and apply the company's approved accounting and retention procedures.

## Recover and preserve data

D1 is authoritative. Restaurant mutations, command replay records, audit entries, and relevant outbox intent commit atomically. Confirmed kitchen work does not depend on queue availability. Messages contain job IDs; consumers acquire persisted leases and fence writes. The host's one-minute schedule recovers expired leases and republishes due work after missed enqueue or delivery failure. Bounded retries eventually require review rather than looping forever.

Monitor reviewed jobs, payment exceptions, pending/unknown invoice age, queue failures, and the dead-letter queue. Inspect `rc_outbox`, `rc_payment_inbox`, `rc_bank_reconciliation`, and `rc_audit` in the restaurant database when diagnosing a failure. Never infer success from an empty queue.

Back up the CMS D1 database, restaurant D1 database, R2 objects, deployment mapping, and secrets through separate approved procedures. Restaurant migrations belong to this package's `migrations/`; apply them before serving the new host. Do not run them against EmDash's `DB` or change an already deployed migration.

Before a restore, pause ordering and external job consumers. Restore into isolated resources first. Preserve command IDs, inbox receipts, allocations, invoice references, tracking codes, and dispatch evidence. Restoring an older snapshot can erase evidence of a bank transfer or external invoice; reconcile the restored state with SePay before resuming jobs. Do not automatically replay restored queued invoices. Define retention with the accountant before deleting financial or idempotency data; no automatic financial purge is supplied.

## Development and verification

`npm run check` runs TypeScript checking, Node test-runner behavioral tests against real Miniflare D1, and the package build. HTTP provider responses are controlled in tests; no live transfers or invoices are created. Tests cover rollback, concurrency, branch permissions, guest-session expiry, outbox recovery, duplicate receipts, provider timeouts, polling recovery, corrections, and CSV boundaries.

Local browser verification exercises the paired Worker, two receiving accounts, guest/staff/kitchen/collection flows, authenticated synthetic webhooks through the actual local Queue consumer, invoice intent persistence, CSV output, table QR/NFC links, and Vietnamese/Arabic layouts. See the [execution plan and evidence](../../plans/20261010-restaurant-chain/plan.md).

Production readiness still requires authorized SePay conformance, approved bank and issuer mappings, backup/restore rehearsal, expected-peak load testing for the chain, and ZeroHostCMS promotion review. Neither this package nor a successful local build establishes those approvals.

## License and provenance

[MIT](LICENSE). The application is an independent TypeScript implementation using public EmDash APIs and the ERP mini native-plugin conventions. It contains no copied ERPNext/Frappe code or private hosting runtime. UI dependencies include React, Kumo, Lingui, and `qrcode`; validation uses Zod. Preserve dependency licenses when redistributing. No restaurant photography or customer content is bundled.
