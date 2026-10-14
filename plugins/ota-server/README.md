# OTA server plugin

A native EmDash plugin that hosts over-the-air builds for Android and iOS apps: it publishes the manifest the clients poll, stores the bundles, and gives an app manager a workspace to inspect, roll back and remove releases. It replaces a temporary Vercel Blob setup with storage that belongs to the installation — either the ZeroHostCMS storage plan the site already has, or the operator's own Cloudflare R2 bucket.

Use it with the companion [OTA server theme](../../../zhst-community-themes/themes/ota-server/README.md). The plugin owns the rules, the storage adapters and the admin UI; the theme owns the HTTP paths, because EmDash mounts plugin routes under `/_emdash/api/plugins/{id}/*` with an 8 MiB body ceiling while a bundle is 25–100 MiB.

## Install and check

```sh
npm ci
npm run check          # typecheck, 65 tests, build
```

Then follow the [theme setup](../../../zhst-community-themes/themes/ota-server/README.md#run-locally). The admin page is `/_emdash/admin/plugins/ota-server/workspace`. This package alone does not mount HTTP routes and does not touch the database until the theme's routes call it.

## The client contract

The paths and bodies below are frozen: the mobile apps are already integrated.

| Method | Path | Auth | Behaviour |
| --- | --- | --- | --- |
| `GET` | `/ota/{app}/{platform}/manifest.json` | none | `{"channels":{"<channel>":{"<binary>":{…}}}}`; `{"channels":{}}` when empty; `Cache-Control: no-cache` |
| `GET` | `/ota/{app}/{platform}/{file}` | none | Bundle bytes with an exact `Content-Length`, no content coding, `Cache-Control: public, max-age=31536000, immutable`, an `ETag` of the sha256, and `Range` support for resumed downloads |
| `POST` | `/ota/{app}/{platform}/releases` | Bearer | `multipart/form-data`; answers `201` with the manifest entry it created |
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

The response is exactly one manifest entry. The server derives the rest:

```json
{
  "id": "20261008-091500",
  "file": "bundles/ducnv_feature_luu-kho/1.0.66+93/20261008-091500.bundle",
  "sha256": "8a8adac4…",
  "size": 19707016,
  "note": "fix màn giao hàng",
  "commit": "e39c6d34",
  "branch": "ducnv/feature/luu-kho",
  "createdAt": "2026-10-08T02:15:00.000Z"
}
```

`id` is the UTC push time; `file` is the storage-relative path, with `/` in the channel collapsed to `_` because a generated file name cannot contain it; `branch` repeats `channel`.

```sh
TOKEN=…                       # created in the workspace, shown once
BASE=https://ota.example.com
BUNDLE=./build/app.bundle

curl --fail-with-body -X POST "$BASE/ota/unitel-man/android/releases" \
  -H "Authorization: Bearer $TOKEN" \
  -F "bundle=@$BUNDLE" \
  -F "channel=ducnv/feature/luu-kho" \
  -F "binary=1.0.66+93" \
  -F "sha256=$(shasum -a 256 "$BUNDLE" | awk '{print $1}')" \
  -F "commit=$(git rev-parse --short HEAD)"
```

`channel` and `binary` are URL-encoded on the wire when they appear in a query string (`%2F`, `%2B`). The server also accepts an unencoded `+`, because `+` is not a space in this position.

### Errors

Failures are `{"error":{"code":"…","message":"…"}}` with a status that matches: `401 AUTH_REQUIRED` / `TOKEN_INVALID` / `TOKEN_REVOKED`, `403 TOKEN_APP_MISMATCH`, `404 APP_UNKNOWN` / `NOT_FOUND` / `BUNDLE_UNAVAILABLE`, `400 SHA_MISMATCH` / `INVALID_INPUT` / `BUNDLE_MISSING`, `409 APP_DISABLED`, `413 BUNDLE_TOO_LARGE`, `502 STORAGE_*`, `503 STORAGE_NOT_CONFIGURED`.

## Rules the server enforces

- **The manifest is a query, not a document.** It is rebuilt from the release table inside one transaction, so two simultaneous pushes cannot publish a half-written manifest or lose each other's build.
- **Two builds per channel + binary.** The current one plus the one immediately before it; anything older is deleted with its object. A rollback to the previous build is one click and needs no client change.
- **Builds expire after 14 days** (`OTA_RETENTION_DAYS`) if they are not pushed again, including the current one. Every push sweeps expired builds, and a daily cron covers a channel that stops receiving pushes.
- **A rejected push stores nothing.** The sha256 is verified before an object is written.
- **A repeated push with identical bytes for the same channel + binary is a retry**, not a second release: the stored build is returned with `201` and no duplicate row or object is created.
- **A recorded bundle is served from the database, never by guessable key.** An object that is missing from storage answers `404 BUNDLE_UNAVAILABLE` rather than an empty file.

## Storage

The workspace configures where bundles live. Both modes are first-class; switching does not move existing objects, so drain the old backend yourself (a `DELETE` of each channel, then re-push) before you switch.

| Mode | Where bundles go | What it needs |
| --- | --- | --- |
| **ZeroHostCMS storage plan** | The storage adapter the site already has (R2 binding, S3-compatible endpoint or local directory, as configured in `astro.config.mjs`) | Nothing beyond a working site storage |
| **Private R2 bucket** | The operator's own bucket, reached through its S3 endpoint | Endpoint, bucket, access key ID and secret access key |

The private mode signs S3 requests itself (SigV4 on WebCrypto, no AWS SDK) so bundles never leave the Worker unencrypted, and a signed request's payload hash is the real bundle hash.

A private secret is written **encrypted** with AES-GCM under `OTA_SECRET_KEY` (32 bytes, `openssl rand -base64 32`); the plaintext is never persisted and is never returned to the browser — the workspace only reports whether a secret is stored. Losing that key means re-entering the secret, not losing bundles. Without the key, the storage-plan mode still works.

## Push tokens

One bearer token per app, created under **Push tokens**. A token is stored only as a SHA-256 hash plus a display prefix, it is shown once at creation, and it can be revoked. A token is scoped to one app: a valid `unitel-man` token pushing to `unitel-logistics` is refused with `403` and the attempt is audited. Last use is recorded (throttled to once a minute).

## The workspace

`/_emdash/admin/plugins/ota-server/workspace` requires `settings:manage`, is same-origin and CSRF-protected, and answers with a `{ok, data}` envelope. Tabs:

- **Releases** — filter by app, platform, channel and binary; see size, sha256, note, commit and age; copy a device URL; roll back to the previous build; delete one build; or upload a bundle manually (the server computes its sha256).
- **Apps** — add, rename, enable or disable an app namespace.
- **Push tokens** — create, list and revoke, with the plaintext shown once.
- **Storage** — choose the mode, enter R2 credentials, test the backend (writes, reads back and deletes one probe object) and see the current mode and warnings.
- **Activity** — the audit trail of pushes, replays, rollbacks, removals, expiries, token and storage changes.
- **Integration** — the contract, a copy-paste publishing script and the retention rules.

## Data, upgrade and removal

The plugin owns four tables (`ota_apps`, `ota_releases`, `ota_current`, `ota_tokens`, plus `ota_settings` and `ota_audit`) in a dedicated database. `ota_current` is a pointer per channel + binary rather than a flag on each row, which is what makes a push a single upsert instead of a race between competing unique indexes.

Migrations are forward-only and idempotent (`CREATE TABLE IF NOT EXISTS`), applied with `wrangler d1 migrations apply OTA_DB`. There is one migration today, so an upgrade is a no-op. Deactivating the plugin keeps every row and every object; removing the plugin registration keeps the data too. Dropping the database removes the metadata and leaves orphaned objects in the bucket — empty the bucket first if that matters, and note that removing a release is immediate and irreversible for devices that have not downloaded it yet.

## Limits and unverified behaviour

- The 100 MiB ceiling is the contract's; what a Worker can hold in memory is smaller (a 128 MB isolate). On Workers, keep bundles at or below ~64 MiB via `OTA_MAX_BUNDLE_BYTES`, or store them on a host with more memory. The plugin buffers one copy of the bundle to verify and upload it.
- SigV4 is verified against the published AWS test vectors and a second implementation, but **no live R2 bucket was exercised** in this repository: the private mode needs the operator's own credentials. Treat the first push after configuring it as the acceptance test, then check the object and its size in the bucket.
- Only the Cloudflare Workers host is provided. A Node host would need its own adapter wiring; the plugin's storage layer is runtime-portable.
- Manifest reads hit the metadata database on every poll. That is deliberate (a manifest is never stale) and cheap for a dev-release server; add a cache only with a measured reason.

## Tests

```sh
npm test          # 65 tests
npm run check     # typecheck, tests, build
```

Coverage that matters here: the AWS SigV4 vectors and a second-implementation cross-check; multipart parsing including boundary-splitting chunks and oversized parts; the exact manifest and push shapes; sha256 rejection; the two-build window; expiry; rollback; pointer healing after deletion; concurrent pushes keeping their own bytes; per-app token scoping; secret encryption round-trip; and the frozen HTTP contract end to end. The theme adds an end-to-end run against the built Worker (`npm run verify:local`).

## License

MIT. See [LICENSE](LICENSE).
