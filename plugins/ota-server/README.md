# OTA server plugin

A native EmDash plugin that hosts over-the-air builds for Android and iOS apps: it publishes the manifest the clients poll, stores the bundles, and gives an app manager a workspace to inspect, roll back and remove releases. It replaces a temporary Vercel Blob setup with storage that belongs to the installation — either the ZeroHostCMS storage plan the site already has, or the operator's own Cloudflare R2 bucket.

Use it with the companion [OTA server theme](../../../zhst-community-themes/themes/ota-server/README.md). The plugin owns the rules, the storage adapters and the admin UI; the theme owns the HTTP paths, because EmDash mounts plugin routes under `/_emdash/api/plugins/{id}/*` with an 8 MiB body ceiling while a bundle is 25–100 MiB.

The canonical [Vietnamese API and operations handover](../../../zhst-community-themes/themes/ota-server/docs/ota-van-hanh.vi.md) covers mobile responsibilities, CI publishing, administrator credentials, setup, approved deployment, migrations and recovery. Its separately requested Downloads copy is an export, not another authority.

## Install and check

```sh
npm ci
npm run check          # typecheck, tests, build
```

Then follow the [theme setup](../../../zhst-community-themes/themes/ota-server/README.md#run-locally). The admin page is `/_emdash/admin/plugins/ota-server/workspace`. This package alone does not mount HTTP routes and does not touch the database until the theme's routes call it.

## The client contract

The paths and bodies below are frozen: the mobile apps are already integrated.

| Method | Path | Auth | Behaviour |
| --- | --- | --- | --- |
| `GET` | `/ota/{app}/{platform}/manifest.json` | none | `{"channels":{"<channel>":{"<binary>":{…}}}}`; `{"channels":{}}` when empty; `Cache-Control: no-cache` |
| `GET` | `/ota/{app}/{platform}/{file}` | none | Bundle bytes with an exact `Content-Length`, no content coding, `Cache-Control: public, max-age=31536000, immutable`, an `ETag` of the sha256, and `Range` support for resumed downloads |
| `POST` | `/ota/{app}/{platform}/releases` | Bearer + per-app upload key when configured | `multipart/form-data`; answers `201` with the manifest entry it created |
| `DELETE` | `/ota/{app}/{platform}/releases?channel=&binary=` | Bearer | Removes one channel + binary; answers `204` |
| `GET` | `/ota/{app}/{platform}/releases` | Bearer | Same body as the manifest |

`app` is a registered slug (`unitel-man` and `unitel-logistics` ship in the migration); `platform` is `android` or `ios`.

### Push

| Field | Kind | Notes |
| --- | --- | --- |
| `bundle` | file | The `.bundle` file. Required, non-empty, at most `OTA_MAX_BUNDLE_BYTES` (100 MiB by default) |
| `channel` | text | Branch name; may contain `/` |
| `binary` | text | `version+build` (`1.0.66+93`) or `version` (`1.6.6`) |
| `sha256` | text | 64 hex characters. The server recomputes it and answers `400 SHA_MISMATCH` when it differs; nothing is stored in that case |
| `note` | text | Optional, at most 500 characters |
| `commit` | text | Optional, at most 64 characters |
| `signature` | text | Optional public metadata, default `""`; canonical standard base64, at most 4096 characters. A 64-byte value is 88 characters; the server does not verify signatures or require an algorithm-specific length |
| `mandatory` | text | Optional, exactly `true` or `false`, default `false`; persisted and returned as a JSON boolean |

The response is exactly one manifest entry. The server derives the rest:

```json
{
  "id": "20261008-091500",
  "file": "bundles/ducnv_feature_luu-kho/1.0.66+93/20261008-091500.bundle",
  "sha256": "8a8adac4…",
  "size": 19707016,
  "note": "fix màn giao hàng",
  "commit": "e39c6d34",
  "signature": "",
  "mandatory": false,
  "branch": "ducnv/feature/luu-kho",
  "createdAt": "2026-10-08T09:15:00.000Z"
}
```

`id` is the UTC push time; `file` is the storage-relative path, with `/` in the channel collapsed to `_` because a generated file name cannot contain it; `branch` repeats `channel`.

Publishing examples are maintained in the [Vietnamese handover](../../../zhst-community-themes/themes/ota-server/docs/ota-van-hanh.vi.md). Keep the public `signature` separate from the private bearer token and `X-OTA-Upload-Key`; SHA-256 checks bytes against the publisher's declared hash, not trusted bundle origin.

`mandatory: true` means the mobile app must apply the compatible update; `false` means optional. The backend stores and returns this flag only. Mobile must implement the update policy; deleting or promoting a release cannot force an already-running device to change bundles.

`channel` and `binary` are URL-encoded on the wire when they appear in a query string (`%2F`, `%2B`). The server also accepts an unencoded `+`, because `+` is not a space in this position.

### Errors

Failures are `{"error":{"code":"…","message":"…"}}`; [HTTP handlers](src/http/) and [storage adapters](src/storage/) own the status/code mapping. In addition to bearer authentication, protected public pushes reject missing or wrong upload keys with `403 UPLOAD_KEY_REQUIRED` or `UPLOAD_KEY_INVALID`. The handover includes troubleshooting without exposing credentials.

## Rules the server enforces

- **The manifest is a query, not a document.** It is rebuilt from the release table inside one transaction, so two simultaneous pushes cannot publish a half-written manifest or lose each other's build.
- **Two builds per channel + binary.** The current one plus the one immediately before it; anything older is deleted with its object. Rollback changes the manifest pointer, not the bundle already running on a device.
- **Builds expire by creation time** after `OTA_RETENTION_DAYS` (14 by default), including the current one. New pushes sweep expired builds; the daily cron covers idle channels.
- **A rejected hash check stores nothing.** The sha256 is checked before an object is written; this is integrity checking, not cryptographic origin authentication.
- **A repeated push with identical bytes and identical `signature`/`mandatory` is a replay**, not a second release: the stored build is returned with `201`, without refreshing its creation time. Changing either metadata field creates a new release.
- **A recorded bundle is served from the database, never by guessable key.** An object that is missing from storage answers `404 BUNDLE_UNAVAILABLE` rather than an empty file.

## Storage

The workspace configures where bundles live. Both modes are first-class; switching does not move existing objects, so drain the old backend yourself (a `DELETE` of each channel, then re-push) before you switch.

| Mode | Where bundles go | What it needs |
| --- | --- | --- |
| **ZeroHostCMS storage plan** | The storage adapter the site already has (R2 binding, S3-compatible endpoint or local directory, as configured in `astro.config.mjs`) | Nothing beyond a working site storage |
| **Private R2 bucket** | The operator's own bucket, reached through its S3 endpoint | Endpoint, bucket, access key ID and secret access key |

The private mode authenticates HTTPS S3 requests using SigV4 on WebCrypto, without an AWS SDK. This storage authentication is separate from public release metadata and does not sign bundles for mobile.

A private secret is written **encrypted** with AES-GCM under `OTA_SECRET_KEY` (32 bytes, `openssl rand -base64 32`); the plaintext is never persisted and is never returned to the browser — the workspace only reports whether a secret is stored. Losing that key means re-entering the secret, not losing bundles. Without the key, the storage-plan mode still works.

## Push tokens

Bearer tokens are scoped to one app, created under **Push tokens**, stored as hashes, displayed once and individually revocable. Creating a new bearer does not revoke old ones. [Token and upload-key methods in the service](src/domain/service.ts) own the credential lifecycle.

**Extra upload protection** in the same tab creates or rotates a private per-app upload key: 64 random bytes encoded as standard base64 (88 characters), hash-only persistence, one-time plaintext response. First creation enables the additional `X-OTA-Upload-Key` requirement for public POST releases; unconfigured apps keep existing bearer auth. Rotation invalidates the old key for newly authenticated pushes, not uploads already authenticated. Existing releases, anonymous downloads, list and DELETE are unchanged; session-authorized manual admin upload does not require this key.

Admin key metadata is `GET /api/ota/upload-key?app=…`; first creation/rotation is `POST /api/ota/upload-key-rotate` with JSON `{app}`. The [handover](../../../zhst-community-themes/themes/ota-server/docs/ota-van-hanh.vi.md) owns the envelope/header examples and credential runbook. Never put the upload key in `signature`, the manifest or the mobile app.

## The workspace

The page requires `settings:manage`. Its `/api/ota/*` API uses the EmDash session, same-origin CSRF for writes and a `{ok, data}` envelope; [admin HTTP plumbing](src/http/shared.ts) and the [browser client](src/admin/client.ts) own those gates. Tabs:

- **Releases** — inspect release metadata, including public signature and mandatory status; copy a device URL; promote/rollback, delete or upload manually.
- **Apps** — add, rename, enable or disable an app namespace.
- **Push tokens** — create, list and revoke bearer tokens; create/rotate extra per-app upload protection, with each credential shown once.
- **Storage** — choose the mode, enter R2 credentials, test the backend (writes, reads back and deletes one probe object) and see the current mode and warnings.
- **Activity** — the audit trail of pushes, replays, rollbacks, removals, expiries, token and storage changes.
- **Integration** — the contract, a copy-paste publishing script and the retention rules.

## Data, upgrade and removal

The [migration directory](migrations/) owns the schema; [service](src/domain/service.ts) owns release/current-pointer changes. Prefer the theme's dedicated OTA database, with its CMS database kept separate.

Apply every pending migration through Wrangler's migration tracking before running upgraded code. The metadata migration adds `signature` and `mandatory`; existing releases default to `""` and `false` on the wire. Do not replay `ALTER TABLE` manually or assume upgrades are no-ops. The [handover](../../../zhst-community-themes/themes/ota-server/docs/ota-van-hanh.vi.md) covers production config selection, backup/restore and database-binding fallback.

Deactivation or removal of the plugin registration does not remove data or objects. Dropping the database leaves bucket objects behind. Release deletion removes its server download route but cannot retract bytes already downloaded by a device.

## Limits and unverified behaviour

- The application defaults to a 100 MiB ceiling; this is not a Worker memory guarantee. Bundle hashing/upload buffers bytes, and buffer growth can temporarily copy them. Choose a lower `OTA_MAX_BUNDLE_BYTES` appropriate to measured overhead and concurrency (about 64 MiB or less as an initial Worker constraint).
- SigV4 is verified against the published AWS test vectors and a second implementation, but **no live R2 bucket was exercised** in this repository: the private mode needs the operator's own credentials. Treat the first push after configuring it as the acceptance test, then check the object and its size in the bucket.
- Only the Cloudflare Workers host is provided. A Node host would need its own adapter wiring; the plugin's storage layer is runtime-portable.
- Manifest reads hit the metadata database on every poll. That is deliberate (a manifest is never stale) and cheap for a dev-release server; add a cache only with a measured reason.

## Tests

```sh
npm test
npm run check     # typecheck, tests, build
```

Coverage that matters here: the AWS SigV4 vectors and a second-implementation cross-check; multipart parsing including boundary-splitting chunks and oversized parts; the exact manifest and push shapes; sha256 rejection; the two-build window; expiry; rollback; pointer healing after deletion; concurrent pushes keeping their own bytes; per-app token scoping; secret encryption round-trip; and the frozen HTTP contract end to end. The theme adds an end-to-end run against the built Worker (`npm run verify:local`).

## License

MIT. See [LICENSE](LICENSE).
