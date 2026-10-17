# Red Cross Chapter contributor contract

Read `README.md` before changing this package. Keep it an independent MIT implementation; do not copy private platform code or proprietary assets.

- Business rules belong in `src/service.ts`; validation and CSV in `src/validation.ts`; persisted/API types in `src/model.ts`; native registration in `src/index.ts`; UI in `src/admin/`. Reuse these owners rather than adding a parallel API.
- Never patch EmDash, import internal core modules, evaluate saved JavaScript, or expose plugin storage as a public content collection.
- Preserve administrator authentication and permission checks. Actors come from the host session (`ctx.user`); never trust a caller-supplied identity or tenant.
- Public routes must remain aggregate/published-only. Do not leak member CCCD/phone, pending fund entries, or unpublished documents through `public-fund`/`public-documents`.
- Money is an integer amount in đồng with a safe-integer ceiling. Keep the pending → approved transition one-directional; approved entries are locked.
- Member registry is read-only in the UI; bulk changes go through CSV upsert keyed on the normalised member code. Do not add per-row add/edit/delete.
- New persisted fields or shapes need a versioned schema decision before deployment. Reject unknown future schema versions.
- Keep runtime/server imports out of React admin source. Do not duplicate React or replace the host admin/auth shell.
- Add tests only for observable behaviour, boundaries and failure states. Run `npm run check` and exercise the changed browser workflow.
- Use synthetic data and private disposable databases. Never commit `.env`, databases, or real personal data (CCCD, phone).
- Do not deploy, publish, merge a PR, or migrate production without explicit operator authorization.

Report exact commands exercised and remaining unverified targets. Do not claim Cloudflare deployment or statutory accounting compliance from a local build.
