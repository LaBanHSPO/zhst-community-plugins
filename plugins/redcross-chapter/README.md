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

## Document files

The plugin stores a **file URL** (and display file name) rather than uploading bytes itself. Upload PDFs to the EmDash media library, then paste the resulting URL into the document record. This keeps the plugin free of media-write capabilities.

## Limitations

- Local Node/SQLite results only; no Cloudflare deployment is claimed.
- Fund figures are an internal transparency ledger, not statutory accounting.
- CSV import is capped at ~4 MB / 10,000 rows per request; export at 10,000 rows.

## License

MIT. See `LICENSE`.
