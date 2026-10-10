# Phase 3: staff and guest surfaces

Status: implemented; guest/staff workflows, compiled native-plugin mounting, QR rendering, and narrow Arabic layouts verified in Chromium. See [verification evidence](phase-04-verification.md#observed-results).

Register a native restaurant plugin with a role-aware workspace: branches/configuration, floor tables and pending requests, kitchen item queue, cashier bills/payment QR, accountant invoice lifecycle and exports. Vietnamese admin text uses Lingui; use Kumo and accessible keyboard controls, semantic status, logical layout and pending/error/conflict recovery. Never grant plugins:manage to restaurant staff as a substitute for branch authorization.

Create independent Cloudflare-only theme with EmDash auth/CMS, restaurant D1 binding, R2, queue consumer and scheduler. Guest QR and NFC target the same /order/[tableToken] page; joining yields a current-visit token. Build responsive menu, modifier selection, request basket, submission and status/bill view with explicit unconfirmed state. Wire private/public API transport and provider-only webhook authentication separately. Retain failed forms and command IDs for network retry; rotate command IDs when input changes.

Acceptance: browser complete walk-through from open table to guest request, staff acceptance, kitchen progression, cashier QR and invoice request; old table visit cannot mutate new visit; narrow mobile and Arabic/RTL admin layouts remain usable. Theme packages and deploy configuration contain no production resource IDs or secrets.
