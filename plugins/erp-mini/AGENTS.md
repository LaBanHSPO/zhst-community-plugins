# ERP mini contributor contract

Read README.md and docs/porting.md before changing this package. Work only in the selected customer fork/branch; core stays an exact upstream npm dependency.

- Business rules belong in src/service.ts; input validation in src/validation.ts; persisted/API types in src/model.ts; native registration in src/index.ts; UI in src/admin/. Reuse these owners rather than adding a parallel API.
- Never patch EmDash, import internal core modules, evaluate saved JavaScript, add a public ERP route or expose plugin storage as a public content collection.
- Preserve administrator authentication/permission and CSRF checks. Actors come from the host session. No caller-selected tenant or user identity.
- One installation/database/resources/secret set per customer. Do not add a tenant switch to simulate isolation.
- Preserve safe integer money, bounded input/pagination, frozen submitted snapshots, allowed state transitions and required opaque revisions. Quotation/order conversion is one single-key CAS, not two writes.
- New persisted fields or shapes need a versioned migration and recovery decision before deployment. Reject unknown future schema versions. Never reinterpret saved currency or silently discard a field.
- Keep runtime/server imports out of React admin source. Do not duplicate React or replace the host's admin/auth shell.
- Add tests only for observable behavior, boundaries and failure states. Run npm run check, build the sibling theme, then exercise the changed browser workflow. HTTP 200 is not proof of a successful business mutation: check both response envelopes.
- Use synthetic data and private disposable databases. Never read production credentials/data into an AI prompt, commit .env/DB files, or publish unredacted evidence.
- ERPNext is GPL-3.0; this package is an independent MIT implementation. Do not copy ERPNext code/assets without a deliberate license review.
- Do not deploy, publish a package, merge a PR, migrate production, or upgrade all customers without explicit operator authorization. A passing daily core check is only candidate evidence.

Report exact commands exercised and remaining unverified targets. Do not claim Cloudflare deployment, accounting compliance, live ERPNext connectivity or thousand-customer capacity from a local build.
