/**
 * Storage resolution: turns the persisted settings into a blob store, or fails
 * with an actionable configuration error.
 */

import { OtaError } from "../domain/data.js";
import type { OtaBlobStore, OtaStorageSettings, PlatformStorage } from "../domain/types.js";
import { platformBlobStore } from "./platform.js";
import { r2BlobStore } from "./r2.js";
import { decryptSecret } from "../domain/secrets.js";

export { encryptSecret, decryptSecret, parseKeyMaterial } from "../domain/secrets.js";
export { platformBlobStore } from "./platform.js";
export { r2BlobStore } from "./r2.js";

export interface ResolveStorageOptions {
	settings: OtaStorageSettings;
	/** Host storage adapter, present when the theme supplies one. */
	platform?: PlatformStorage | null;
	/** 32-byte secret key material, or null when unset. */
	key: Uint8Array | null;
}

export async function resolveBlobStore(options: ResolveStorageOptions): Promise<OtaBlobStore> {
	if (options.settings.mode === "platform") {
		if (!options.platform)
			throw new OtaError(
				"STORAGE_NOT_CONFIGURED",
				"This site has no storage adapter for OTA bundles. Configure the site storage or switch the OTA storage mode to a private R2 bucket.",
				503,
			);
		return platformBlobStore(options.platform);
	}

	const r2 = options.settings.r2;
	const missing: string[] = [];
	if (r2.endpoint === "") missing.push("endpoint");
	if (r2.bucket === "") missing.push("bucket");
	if (r2.accessKeyId === "") missing.push("access key ID");
	if (r2.secret === "") missing.push("secret access key");
	if (missing.length > 0)
		throw new OtaError(
			"STORAGE_NOT_CONFIGURED",
			`The private R2 bucket is incomplete. Set the ${missing.join(", ")} in the OTA storage settings.`,
			503,
		);
	if (!options.key)
		throw new OtaError(
			"SECRET_KEY_MISSING",
			"OTA_SECRET_KEY is not configured, so the stored R2 secret cannot be decrypted. Set the secret on the host and save the storage settings again.",
			503,
		);

	return r2BlobStore({
		endpoint: r2.endpoint,
		bucket: r2.bucket,
		accessKeyId: r2.accessKeyId,
		secretAccessKey: await decryptSecret(r2.secret, options.key),
		region: r2.region,
	});
}

/** Write, read back and delete one small object to prove the backend works. */
export async function probeBlobStore(store: OtaBlobStore): Promise<{ backend: string; bytes: number }> {
	const key = `_health/ota-probe-${Date.now()}.txt`;
	const payload = new TextEncoder().encode(`ota-probe ${new Date().toISOString()}`);
	await store.put(key, payload, { contentType: "text/plain", cacheControl: "no-store" });
	try {
		const read = await store.get(key);
		if (!read) throw new OtaError("STORAGE_FAILED", "The probe object could not be read back.", 502);
		await read.body.cancel().catch(() => undefined);
		if (read.size !== payload.byteLength)
			throw new OtaError("STORAGE_FAILED", "The probe object read back with an unexpected size.", 502);
		return { backend: store.describe(), bytes: payload.byteLength };
	} finally {
		await store.delete(key).catch(() => undefined);
	}
}
