# Phase 2: SePay and recovery

Status: implemented; controlled-provider tests and actual local webhook/Queue processing passed. Live provider conformance was not attempted. See [verification evidence](phase-04-verification.md#observed-results).

Implement authenticated bounded bank-transfer webhook ingestion, durable inbox and processor. Validate account/context/reference/amount/direction, preserve unmatched transfers, deduplicate both delivery and allocation. Generate payment QR from immutable server data. Implement SePay API reconciliation without treating numeric webhook IDs and UUID API IDs as interchangeable.

Implement outbox dispatcher, claim leases/fencing, bounded consumer batches, scheduled rediscovery and review states. Queue messages identify persisted jobs only. Implement eInvoice token authentication, draft/create/issue/poll/detail/download and adjustment/replacement. Persist stable references, exact payloads, create/issue tracking separately. Unknown external outcome never automatically resubmits; polls and reconciliation retain recoverable state. Credentials remain runtime secrets.

Acceptance: missed enqueue is recovered; duplicate messages/receipts do not duplicate effects; stale workers cannot overwrite newer results; account mismatch cannot settle; partial/overpayment becomes an exception; invoice timeout before tracking becomes unknown; provider Pending polls rather than recreates; provider errors do not masquerade as invoice issuance. Tests use real D1 and controlled HTTP at the provider boundary; actual SePay conformance remains an operator step.
