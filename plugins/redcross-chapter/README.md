# Red Cross Chapter

A native EmDash plugin for the back-office records of a **local Red Cross chapter**:

- **Member registry** — read-only list with search/filter, plus **CSV import/export**. There is no per-row add/edit/delete by design; bulk updates go through CSV keyed on the member code (`Mã HV`).
- **Fund ledger** — record income (`thu`) and expense (`chi`) entries, each created as `pending` and only counted once an administrator **approves** it. Totals, monthly and category breakdowns are derived from approved entries.
- **Document library** — decisions, resolutions, circulars, reports and financial files (`Số hiệu`, `Trích yếu`, type, date, signer, file URL, public flag).

Public read routes (`public-fund`, `public-documents`) expose aggregated fund figures and documents marked public, so a theme can render a transparency page without opening the private storage.

The organisation chart, the news feed and media authoring are intentionally **out of scope** here: those are handled by the theme (static chart) and EmDash's native `posts`/media and admin login.

## Package layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | `PluginDescriptor` + `createPlugin()` (routes, storage, admin pages) |
| `src/model.ts` | Persisted and API types |
| `src/validation.ts` | Zod schemas + CSV parser/serializer |
| `src/service.ts` | Business rules (`ChapterService`) |
| `src/admin/` | React admin workspace (`/workspace`) |
| `tests/service.test.ts` | Behaviour, boundary and failure tests |

## Storage

Three plugin-owned collections: `members`, `fund`, `documents`. Money is stored as an **integer amount in đồng** (VND has no minor units) with a safe-integer ceiling. New persisted fields need a reviewed schema change; the service rejects unknown `schemaVersion` values.

## Routes

| Route | Method | Access | Purpose |
| --- | --- | --- | --- |
| `info` | GET | `plugins:manage` | Workspace configuration |
| `members-list` | POST | `plugins:manage` | Search/filter members |
| `members-import` | POST | `plugins:manage` | Upsert members from CSV text |
| `members-export` | GET | `plugins:manage` | Export members as CSV |
| `fund-list` | POST | `plugins:manage` | Filter entries |
| `fund-totals` | GET | `plugins:manage` | Totals and breakdowns |
| `fund-save` | POST | `plugins:manage` | Create a pending entry |
| `fund-approve` | POST | `plugins:manage` | Approve a pending entry |
| `documents-list` | POST | `plugins:manage` | Search/filter documents |
| `documents-save` | POST | `plugins:manage` | Create or update a document |
| `public-fund` | GET | public | Aggregated transparency figures |
| `public-documents` | GET | public | Published documents |

Private routes require an authenticated administrator (`ctx.user`); the caller's identity is taken from the host session, never from the request body. Public routes expose only aggregated fund figures and published documents.

Fund and document list responses include the revision matching each displayed value. Existing edits and fund approval must send that revision; a stale revision is rejected without changing the record. `revision: null` is create-only, so an old document form cannot republish a document another administrator made private.

## Develop

```sh
npm install
npm run build      # tsdown -> dist/
npm run typecheck
npm test           # node:test via tsx
```

Install into a standalone EmDash host (`file:` dependency) and register the exported factory in `astro.config.mjs`:

```js
import { redcrossChapterPlugin } from "@zerohost/plugin-redcross-chapter";
// emdash({ plugins: [redcrossChapterPlugin()] })
```

The admin workspace appears in the EmDash admin under Plugins.

## CSV format

Header row, comma-separated, UTF-8. Recognised columns (Vietnamese or English):

`Mã HV`/`code`, `Họ tên`/`fullName`, `Năm sinh`/`birthYear`, `Địa chỉ`/`address`, `SĐT`/`phone`, `CCCD`/`cccd`, `Trạng thái`/`status` (`Hoạt động` | `Tạm nghỉ`).

`Mã HV` and `Họ tên` are required. Rows are matched on the normalised member code, so re-importing updates existing members.

The workspace validates the selected UTF-8 file before writing (4,000,000 bytes, at most 10,000 data records), then sends sequential batches of at most 50 records. Direct API callers must use the same batch bound. Progress and errors use logical CSV record numbers, counting the header as record 1; a quoted multiline field is one record. Failed batches stop the import and retain retry state; already acknowledged batches remain committed. Re-importing is an upsert, not an all-or-nothing file transaction.

Exports prefix formula-like spreadsheet cells and literal leading apostrophes with an apostrophe so cells are not evaluated as formulas. The additional `__redcross_encoding` column marks this reversible `apostrophe-v1` encoding. Re-importing a marked export restores exact member codes, names and phone fields; unmarked CSV input remains literal. Preserve the marker column when editing an exported file.

## Document files

The plugin stores a **file URL** (and display file name) rather than uploading bytes itself. Upload PDFs to the EmDash media library, then paste the resulting URL into the document record. This keeps the plugin free of media-write capabilities.

## Limitations

- Local Node/SQLite results only; no Cloudflare deployment is claimed.
- Fund figures are an internal transparency ledger, not statutory accounting.
- CSV files are capped at 4,000,000 UTF-8 bytes / 10,000 data records, with at most 50 records per API request; export is capped at 10,000 records.
- Complete financial reads fail explicitly if they exceed 10,000 approved or pending records; they never return a silently truncated total. Unrepresentable safe-integer totals fail rather than rounding VND.

## License

MIT. See `LICENSE`.
