/**
 * Public server surface used by the companion theme.
 *
 * The theme owns the HTTP paths (`/ota/*`, `/api/ota/*`) because EmDash mounts
 * plugin routes under `/_emdash/api/plugins/{id}/*` and caps their request
 * bodies at 8 MiB, which cannot carry a 25-100 MiB bundle. Everything below is
 * framework-free: it takes a `Request` and returns a `Response`.
 */

export { OtaService, storageView, readBearer, DEFAULT_STORAGE_SETTINGS } from "./domain/service.js";
export { buildManifest, manifestEntry } from "./domain/manifest.js";
export { handleOtaAppRequest } from "./http/app.js";
export { handleOtaAdminRequest } from "./http/admin.js";
export {
	decryptSecret,
	encryptSecret,
	parseKeyMaterial,
	platformBlobStore,
	probeBlobStore,
	r2BlobStore,
	resolveBlobStore,
} from "./storage/index.js";
export {
	CLEAR_SECRET,
	DEFAULT_MAX_BUNDLE_BYTES,
	DEFAULT_RETENTION_DAYS,
	KEEP_PER_BINARY,
	OtaError,
	channelSlug,
	formatBytes,
} from "./domain/data.js";
export { resolveMaxBundleBytes } from "./domain/validation.js";
export { OTA_PLATFORMS, isOtaPlatform } from "./domain/types.js";

export type { OtaRuntime, OtaAdminRuntime } from "./http/shared.js";
export type {
	BlobRead,
	OtaActor,
	OtaApp,
	OtaAuditEvent,
	OtaBlobStore,
	OtaInfo,
	OtaManifest,
	OtaManifestEntry,
	OtaPlatform,
	OtaRelease,
	OtaReleasePage,
	OtaStorageMode,
	OtaStorageSettings,
	OtaStorageView,
	OtaTokenSummary,
	PlatformStorage,
} from "./domain/types.js";
