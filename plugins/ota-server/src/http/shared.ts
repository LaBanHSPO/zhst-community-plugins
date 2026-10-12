/**
 * Request plumbing shared by the app-facing and admin surfaces.
 *
 * Two envelopes are used on purpose:
 * - `/ota/*` answers with the contracted client shapes and a plain `{error}` body,
 *   because the mobile apps are already integrated.
 * - `/api/ota/*` answers with `{ok, data|error}` for the admin UI.
 */

import { ZodError } from "zod";
import { OtaError } from "../domain/data.js";
import { OtaService } from "../domain/service.js";
import type { OtaActor, PlatformStorage } from "../domain/types.js";
import { parseKeyMaterial, resolveBlobStore } from "../storage/index.js";
import { resolveMaxBundleBytes } from "../domain/validation.js";

export interface OtaRuntime {
	/** Metadata database: the OTA tables from this plugin's migrations. */
	db: D1Database;
	/** Host site storage adapter; absent when the theme does not supply one. */
	platform?: PlatformStorage | null;
	/** Raw `OTA_SECRET_KEY` secret value. */
	secretKey?: string | null;
	/** Absolute site origin used for copy-paste URLs in the admin UI. */
	baseUrl?: string;
	maxBundleBytes?: number;
	retentionDays?: number;
	now?: () => number;
}

export interface OtaAdminRuntime extends OtaRuntime {
	actor: OtaActor | null;
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...JSON_HEADERS, "X-Content-Type-Options": "nosniff", ...headers },
	});
}

export function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
	return new Response(null, { status, headers: { "X-Content-Type-Options": "nosniff", ...headers } });
}

/** Client-facing failure: `{"error":{"code","message"}}`. */
export function appFailure(error: OtaError): Response {
	return jsonResponse(
		{ error: { code: error.code, message: error.message } },
		error.status,
		error.code === "AUTH_REQUIRED" || error.code === "TOKEN_INVALID" || error.code === "TOKEN_REVOKED"
			? { "WWW-Authenticate": "Bearer" }
			: {},
	);
}

/** Admin failure: `{"ok":false,"error":{...}}` with a private cache policy. */
export function adminFailure(error: OtaError): Response {
	return jsonResponse({ ok: false, error: { code: error.code, message: error.message } }, error.status, {
		"Cache-Control": "private, no-store",
	});
}

export function adminSuccess(data: unknown, status = 200): Response {
	return jsonResponse({ ok: true, data }, status, { "Cache-Control": "private, no-store" });
}

/**
 * Normalize anything a handler can throw. Validation failures must reach the
 * client as 400, never as an internal error with a leaked message; only the
 * already-sanitized `OtaError` messages are ever returned.
 */
export function asOtaError(error: unknown, scope: string): OtaError {
	if (error instanceof OtaError) return error;
	if (error instanceof ZodError)
		return new OtaError("INVALID_INPUT", "The request data is not valid for this endpoint.", 400);
	console.error(`[ota] ${scope} failed`, {
		errorType: error instanceof Error ? error.name : "unknown",
	});
	return new OtaError("INTERNAL_ERROR", "The request could not be completed. Retry, or contact the app team.", 500);
}

/**
 * Drain the request body when a handler answered without reading it.
 *
 * A rejected upload (a missing token, a bad `Content-Length`) leaves a large
 * unread body on the wire. If the handler answers immediately, the runtime
 * cannot reuse the connection: the client sees a dropped connection instead of
 * the 401 it was sent. Reading the body to its end — bounded by the same ceiling
 * the endpoint accepts — keeps the connection healthy so the caller can read the
 * error. Beyond that ceiling the body is cancelled rather than drained.
 */
export async function discardRequestBody(request: Request, maxBytes = 128 * 1024 * 1024): Promise<void> {
	if (request.bodyUsed) return;
	const body = request.body;
	if (!body) return;
	const reader = body.getReader();
	let read = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			read += value.byteLength;
			if (read > maxBytes) {
				await reader.cancel().catch(() => undefined);
				return;
			}
		}
	} catch {
		// The caller went away, or the runtime rejected the read.
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Already released.
		}
	}
}

export function methodNotAllowed(allowed: string): Response {
	const response = jsonResponse({ error: { code: "METHOD_NOT_ALLOWED", message: `Use ${allowed}.` } }, 405);
	response.headers.set("Allow", allowed);
	return response;
}

/**
 * Lenient query decoding: `+` stays a literal `+` so `binary=1.0.66+93` works
 * even when a client sends it unencoded, while `%2B` and `%2F` still decode.
 */
export function parseQuery(search: string): Record<string, string> {
	const out: Record<string, string> = {};
	const raw = search.startsWith("?") ? search.slice(1) : search;
	if (raw === "") return out;
	for (const pair of raw.split("&")) {
		if (pair === "") continue;
		const separator = pair.indexOf("=");
		const key = separator === -1 ? pair : pair.slice(0, separator);
		let decodedKey: string;
		let decodedValue: string;
		try {
			decodedKey = decodeURIComponent(key);
			decodedValue = separator === -1 ? "" : decodeURIComponent(pair.slice(separator + 1));
		} catch {
			throw new OtaError("INVALID_INPUT", "The query string is not valid URL encoding.", 400);
		}
		if (!(decodedKey in out)) out[decodedKey] = decodedValue;
	}
	return out;
}

/**
 * Single explicit byte range. Suffix and multi-range requests are ignored, and
 * the caller then serves the whole object, which is always a valid answer.
 */
export function parseRange(header: string | null): { offset: number; length?: number } | null {
	if (!header) return null;
	const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
	if (!match?.[1]) return null;
	const offset = Number(match[1]);
	if (!Number.isSafeInteger(offset) || offset < 0) return null;
	if (match[2] === undefined || match[2] === "") return { offset };
	const end = Number(match[2]);
	if (!Number.isSafeInteger(end) || end < offset) return null;
	return { offset, length: end - offset + 1 };
}

export function requireAdminRequest(request: Request): void {
	if (request.method === "GET") return;
	if (
		request.headers.get("X-EmDash-Request") !== "1" ||
		request.headers.get("Origin") !== new URL(request.url).origin
	)
		throw new OtaError("CSRF", "Same-origin request required.", 403);
}

export function requireJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
	const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.startsWith("application/json"))
		throw new OtaError("CONTENT_TYPE", "A JSON request body is required.", 415);
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > maxBytes)
		throw new OtaError("BODY_TOO_LARGE", "The request body is too large.", 413);
	return request
		.text()
		.then((text) => (text.trim() === "" ? {} : (JSON.parse(text) as unknown)))
		.catch(() => {
			throw new OtaError("INVALID_INPUT", "The request body is not valid JSON.", 400);
		});
}

export interface ServiceBundle {
	service: OtaService;
	secretKey: Uint8Array | null;
	maxBundleBytes: number;
}

/** Build the service for one request. Storage is resolved only when used. */
export function serviceFor(runtime: OtaRuntime, actor: OtaActor | null): ServiceBundle {
	const secretKey = parseKeyMaterial(runtime.secretKey ?? null);
	const maxBundleBytes = resolveMaxBundleBytes(runtime.maxBundleBytes);
	let service!: OtaService;
	service = new OtaService({
		db: runtime.db,
		actor,
		secretKey,
		platformAvailable: Boolean(runtime.platform),
		maxBundleBytes,
		...(runtime.retentionDays === undefined ? {} : { retentionDays: runtime.retentionDays }),
		...(runtime.baseUrl === undefined ? {} : { baseUrl: runtime.baseUrl }),
		...(runtime.now === undefined ? {} : { now: runtime.now }),
		blobs: async () =>
			resolveBlobStore({
				settings: await service.getStorageSettings(),
				platform: runtime.platform ?? null,
				key: secretKey,
			}),
	});
	return { service, secretKey, maxBundleBytes };
}
