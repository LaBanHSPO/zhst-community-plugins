/**
 * Wire and persisted types for the OTA release server.
 *
 * The app-facing shapes in this file are contractual: the mobile clients are
 * already integrated, so `OtaManifest`, `OtaManifestEntry` and the release
 * object returned by a push must not change without a client release.
 */

export const OTA_PLATFORMS = ["android", "ios"] as const;
export type OtaPlatform = (typeof OTA_PLATFORMS)[number];

export function isOtaPlatform(value: unknown): value is OtaPlatform {
	return typeof value === "string" && (OTA_PLATFORMS as readonly string[]).includes(value);
}

/**
 * A stored build. `releaseId` is the manifest `id` (`YYYYMMDD-HHMMSS` in UTC);
 * `id` is the opaque row identity used by the admin API.
 */
export interface OtaRelease {
	id: string;
	app: string;
	platform: OtaPlatform;
	channel: string;
	binary: string;
	releaseId: string;
	file: string;
	sha256: string;
	size: number;
	note: string;
	commit: string;
	branch: string;
	selected: boolean;
	createdAt: string;
}

/** One `channels[channel][binary]` entry of `GET /ota/{app}/{platform}/manifest.json`. */
export interface OtaManifestEntry {
	id: string;
	file: string;
	sha256: string;
	size: number;
	note: string;
	commit: string;
	branch: string;
	createdAt: string;
}

/** `GET /ota/{app}/{platform}/manifest.json` body. */
export interface OtaManifest {
	channels: Record<string, Record<string, OtaManifestEntry>>;
}

/** Push input after multipart parsing and validation. */
export interface OtaPushInput {
	channel: string;
	binary: string;
	sha256: string;
	note: string;
	commit: string;
	bytes: Uint8Array;
}

export type OtaStorageMode = "platform" | "r2";

/** Persisted storage configuration. `r2.secret` is ciphertext, never plaintext. */
export interface OtaStorageSettings {
	mode: OtaStorageMode;
	r2: {
		endpoint: string;
		bucket: string;
		accessKeyId: string;
		region: string;
		publicUrl: string;
		/** AES-GCM payload produced by `encryptSecret`; empty when unset. */
		secret: string;
	};
	updatedAt: string;
}

/** Storage configuration as returned to the admin UI: the secret is reduced to a flag. */
export interface OtaStorageView {
	mode: OtaStorageMode;
	r2: {
		endpoint: string;
		bucket: string;
		accessKeyId: string;
		region: string;
		publicUrl: string;
		hasSecret: boolean;
	};
	/** Whether the host supplied a storage adapter for `platform` mode. */
	platformAvailable: boolean;
	/** Whether key material for stored R2 secrets is configured. */
	keyConfigured: boolean;
	updatedAt: string | null;
}

export interface OtaApp {
	slug: string;
	name: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface OtaTokenSummary {
	id: string;
	app: string;
	name: string;
	prefix: string;
	createdAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
}

export interface OtaAuditEvent {
	id: string;
	action: string;
	actorId: string | null;
	actorKind: string;
	app: string | null;
	platform: string | null;
	channel: string | null;
	binary: string | null;
	detail: Record<string, unknown>;
	createdAt: string;
}

export interface OtaInfo {
	apps: OtaApp[];
	platforms: readonly OtaPlatform[];
	storage: OtaStorageView;
	counts: { releases: number; channels: number; bytes: number; tokens: number };
	limits: { maxBundleBytes: number; retentionDays: number; keepPerBinary: number };
	baseUrl: string;
}

export interface OtaReleasePage {
	items: OtaRelease[];
	nextCursor: string | null;
}

/** Actor resolved by the host route. `null` means unauthenticated. */
export interface OtaActor {
	id: string;
	administrator: boolean;
}

/** Read-only host storage contract (structurally compatible with EmDash `Storage`). */
export interface PlatformStorage {
	upload(options: {
		key: string;
		body: Uint8Array;
		contentType: string;
		cacheControl?: string;
	}): Promise<unknown>;
	download(
		key: string,
		options?: { range?: { offset: number; length?: number } | { suffix: number } },
	): Promise<{
		body: ReadableStream<Uint8Array>;
		contentType: string;
		size: number;
		range?: { offset: number; length: number };
	}>;
	delete(key: string): Promise<void>;
	exists(key: string): Promise<boolean>;
}

/** A single ranged read result. `size` is always the whole object size. */
export interface BlobRead {
	body: ReadableStream<Uint8Array>;
	contentType: string;
	size: number;
	range?: { offset: number; length: number };
}

export interface BlobWriteOptions {
	contentType?: string;
	cacheControl?: string;
}

/** Storage backend used for bundle objects. */
export interface OtaBlobStore {
	put(key: string, bytes: Uint8Array, options?: BlobWriteOptions): Promise<void>;
	get(key: string, range?: { offset: number; length?: number }): Promise<BlobRead | null>;
	head(key: string): Promise<{ size: number; contentType: string } | null>;
	delete(key: string): Promise<void>;
	/** Short human-readable backend description for the admin UI and audit detail. */
	describe(): string;
}
