# Phase 1: transactional domain

Status: implemented; real D1 regression checks and two-branch runtime smoke passed. See [verification evidence](phase-04-verification.md#observed-results).

Implement plugin-owned D1 migration, schema and strict command/query service. Enforce branch membership on every private read/write; use visit-bound random guest tokens. Implement menu, table visits, pending orders, staff acceptance/rejection, item preparation, bill/payment intent and invoice intent. Preserve historical snapshots and audit reasons. Use bounded pagination and exact VND arithmetic.

Commit each invariant with parameterized D1 batch statements, database constraints and idempotent commands. Store command payload hash/result; reject changed payload under the same key. Fence dependent writes when a revision predicate changes zero rows. No SQL transaction spanning the CMS database.

Acceptance: two branch actors cannot access one another; anonymous commands fail; duplicate order requests return one result; competing acceptance only succeeds once; only confirmed items appear in kitchen; closed-visit tokens fail; totals reflect snapshots rather than later menu changes; repeated migration is safe. Verify against actual local D1, not a mocked database.
