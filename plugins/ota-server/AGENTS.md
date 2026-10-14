# OTA server contributor contract

Read [README.md](README.md) first. The app-facing contract in it is frozen: the mobile clients are already integrated, so a change to a path, a field name or a status code is a client release, not a refactor.

Work only inside this package and its companion theme. Do not patch EmDash, import its internal modules, or make the plugin serve routes outside the theme.

## Where things belong

| Concern | Owner |
| --- | --- |
| Manifest, release lifecycle, retention, tokens, audit | `src/domain/service.ts` |
| Input validation and bounds | `src/domain/validation.ts` |
| Wire and persisted types (contractual payloads) | `src/domain/types.ts` |
| Manifest assembly | `src/domain/manifest.ts` |
| Shared values, key naming, errors | `src/domain/data.ts` |
| Secret encryption, key parsing | `src/domain/secrets.ts` |
| Storage adapters | `src/storage/` |
| App and admin HTTP surfaces | `src/http/` |
| Admin UI | `src/admin/` |
| Native registration (admin page only) | `src/index.ts` |

Reuse these owners rather than adding a parallel path. `src/server.ts` is the only public server surface the theme may import.

## Rules

- **Never mount the app API as a plugin route.** EmDash caps plugin route bodies at 8 MiB and 1 MiB per multipart part, while a bundle is 25–100 MiB. The theme's `/ota/*` route is the contract's home.
- **Keep the manifest a query.** Do not persist a manifest document, and do not reintroduce a `selected` column with a partial unique index: `ota_current` exists because a pointer upsert cannot race the way competing unique indexes do.
- **A rejected push must store nothing** and must not lose the pushed bytes of a concurrent push. Each build owns a key containing its own release id; never write two attempts to the same object key.
- **Verify the sha256 before writing an object**, and keep the bundle ceiling enforced from both the declared `Content-Length` and the parsed bytes.
- **Keep both storage modes working.** The storage-plan mode must keep working with no extra secret configured; the private mode must never persist or return a plaintext secret.
- **Scope every token to one app** and keep the hash-only storage, the one-time display and the audit entry.
- **Drain an unread request body before answering** an early rejection. Without it, a refused 100 MiB upload drops the connection and the client never reads the error.
- **Return only sanitized messages.** `OtaError` messages are user-facing; internal errors are logged with their type and answered generically.

## Tests

Add tests for observable behaviour and failure states, not for the shape of the implementation: contract payloads, sha256 rejection, retention and expiry, rollback, pointer healing, concurrent pushes, token scoping, secret handling, and the HTTP status/header/caching behaviour the apps depend on.

```sh
npm run check
```

Run the companion theme's `npm run verify:local` after a change that affects routing, headers or storage, and report which runtime you exercised. Nothing here proves Cloudflare production behaviour; label unrun checks as unrun rather than inferring them.
