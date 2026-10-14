/**
 * S3-compatible object storage (Cloudflare R2, MinIO, AWS S3).
 *
 * Uploads are single `PutObject` calls signed with the real payload hash, which
 * is what R2 and S3 require for header-signed requests. The bundle is therefore
 * held in memory once; see the README for the size guidance on Workers.
 */

import { BUNDLE_CONTENT_TYPE, OtaError, sha256Hex } from "../domain/data.js";
import type { BlobRead, BlobWriteOptions, OtaBlobStore } from "../domain/types.js";
import { EMPTY_SHA256, signS3, type AwsCredentials } from "./sigv4.js";

export interface R2BlobStoreConfig {
	/** S3 endpoint, e.g. `https://<account-id>.r2.cloudflarestorage.com`. */
	endpoint: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Defaults to `auto`, which is what R2 expects. */
	region?: string;
}

interface RangeHeader {
	offset: number;
	length: number;
}

function trimSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function storageFailure(action: string, response: Response): OtaError {
	if (response.status === 403 || response.status === 401)
		return new OtaError(
			"STORAGE_UNAUTHORIZED",
			`The storage bucket rejected the ${action} request. Check the R2 endpoint, access key and bucket permissions.`,
			502,
		);
	if (response.status === 404) return new OtaError("STORAGE_MISSING", "The storage bucket or object was not found.", 502);
	return new OtaError("STORAGE_FAILED", `The storage bucket returned ${response.status} for the ${action} request.`, 502);
}

function parseContentRange(value: string | null): RangeHeader | null {
	if (!value) return null;
	const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value.trim());
	if (!match) return null;
	const offset = Number(match[1]);
	const end = Number(match[2]);
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || end < offset) return null;
	return { offset, length: end - offset + 1 };
}

export function r2BlobStore(config: R2BlobStoreConfig): OtaBlobStore {
	const endpoint = trimSlash(config.endpoint);
	const bucket = config.bucket;
	const region = config.region && config.region !== "" ? config.region : "auto";
	const credentials: AwsCredentials = {
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
	};

	function objectUrl(key: string): URL {
		const path = key
			.split("/")
			.map((segment) => encodeURIComponent(segment))
			.join("/");
		return new URL(`${endpoint}/${encodeURIComponent(bucket)}/${path}`);
	}

	async function send(
		url: URL,
		method: string,
		payloadHash: string,
		headers: Record<string, string>,
		body?: Uint8Array,
	): Promise<Response> {
		const signed = await signS3({
			url,
			method,
			payloadHash,
			headers,
			credentials,
			region,
			timestamp: Date.now(),
		});
		const sent: Record<string, string> = { ...signed, ...headers };
		if (body && !("content-length" in sent)) sent["content-length"] = String(body.byteLength);
		return fetch(url, {
			method,
			headers: sent,
			body: body ? (body as unknown as BodyInit) : undefined,
		});
	}

	return {
		describe() {
			return `R2 bucket ${bucket} at ${new URL(endpoint).host}`;
		},

		async put(key, bytes, options: BlobWriteOptions = {}) {
			const response = await send(
				objectUrl(key),
				"PUT",
				await sha256Hex(bytes),
				{
					"content-type": options.contentType ?? BUNDLE_CONTENT_TYPE,
					...(options.cacheControl ? { "cache-control": options.cacheControl } : {}),
				},
				bytes,
			);
			if (!response.ok) throw storageFailure("upload", response);
			await response.arrayBuffer();
		},

		async get(key, range): Promise<BlobRead | null> {
			const headers: Record<string, string> = {};
			if (range && range.length !== undefined && range.length > 0)
				headers.range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
			else if (range) headers.range = `bytes=${range.offset}-`;
			const response = await send(objectUrl(key), "GET", EMPTY_SHA256, headers);
			if (response.status === 404) {
				await response.body?.cancel();
				return null;
			}
			if (!response.ok) throw storageFailure("download", response);
			const contentType = response.headers.get("content-type") ?? BUNDLE_CONTENT_TYPE;
			const contentRangeHeader = response.headers.get("content-range");
			const served = parseContentRange(contentRangeHeader);
			const total = contentRangeHeader ? Number(/\/(\d+)$/.exec(contentRangeHeader.trim())?.[1] ?? "0") : 0;
			const size = served && total > 0 ? total : Number(response.headers.get("content-length") ?? "0");
			const body = response.body ?? new Response(null).body;
			if (!body) throw new OtaError("STORAGE_FAILED", "The storage bucket returned an empty response.", 502);
			return served ? { body, contentType, size, range: served } : { body, contentType, size };
		},

		async head(key) {
			const response = await send(objectUrl(key), "HEAD", EMPTY_SHA256, {});
			if (response.status === 404) {
				await response.body?.cancel();
				return null;
			}
			if (!response.ok) throw storageFailure("head", response);
			await response.body?.cancel();
			return {
				size: Number(response.headers.get("content-length") ?? "0"),
				contentType: response.headers.get("content-type") ?? BUNDLE_CONTENT_TYPE,
			};
		},

		async delete(key) {
			const response = await send(objectUrl(key), "DELETE", EMPTY_SHA256, {});
			await response.arrayBuffer();
			if (!response.ok && response.status !== 404) throw storageFailure("delete", response);
		},
	};
}
