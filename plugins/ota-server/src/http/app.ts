/**
 * App-facing OTA API, served by the companion theme at `/ota/*`.
 *
 * Contract (the mobile clients are already integrated):
 *   GET    /ota/{app}/{platform}/manifest.json           -> { channels: { ... } }
 *   GET    /ota/{app}/{platform}/{file}                  -> bundle bytes
 *   POST   /ota/{app}/{platform}/releases                -> 201 created entry
 *   DELETE /ota/{app}/{platform}/releases?channel&binary -> 204
 *   GET    /ota/{app}/{platform}/releases                -> same shape as the manifest
 *
 * Reads are anonymous; writes require `Authorization: Bearer <token>`.
 */

import { BUNDLE_CACHE_CONTROL, MANIFEST_CACHE_CONTROL, OtaError } from "../domain/data.js";
import { buildManifest, manifestEntry } from "../domain/manifest.js";
import { isOtaPlatform } from "../domain/types.js";
import {
	assertDeclaredLength,
	binarySchema,
	channelSchema,
	pushMetaSchema,
	resolveMaxBundleBytes,
} from "../domain/validation.js";
import { readMultipart } from "./multipart.js";
import {
	appFailure,
	asOtaError,
	discardRequestBody,
	emptyResponse,
	jsonResponse,
	methodNotAllowed,
	parseQuery,
	parseRange,
	serviceFor,
} from "./shared.js";
import type { OtaRuntime } from "./shared.js";

const MULTIPART_OVERHEAD = 64 * 1024;

type Platform = "android" | "ios";

function requirePlatform(value: string): asserts value is Platform {
	if (!isOtaPlatform(value)) throw new OtaError("NOT_FOUND", "Unknown platform. Use android or ios.", 404);
}

export async function handleOtaAppRequest(request: Request, path: string, runtime: OtaRuntime): Promise<Response> {
	try {
		const segments = path.split("/").filter((segment) => segment !== "");
		if (segments.length < 3) throw new OtaError("NOT_FOUND", "Unknown OTA endpoint.", 404);
		const app = segments[0] ?? "";
		const platform = segments[1] ?? "";
		requirePlatform(platform);
		const rest = segments.slice(2);
		if (app === "" || app.length > 40) throw new OtaError("NOT_FOUND", "Unknown OTA app.", 404);

		if (rest.length === 1 && rest[0] === "manifest.json") return await manifest(request, runtime, app, platform);
		if (rest.length === 1 && rest[0] === "releases")
			return await releases(request, runtime, app, platform, resolveMaxBundleBytes(runtime.maxBundleBytes));

		if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
		const file = rest.join("/");
		if (file === "" || file.includes("..")) throw new OtaError("NOT_FOUND", "Unknown bundle.", 404);
		return await serveFile(request, runtime, app, platform, file);
	} catch (error) {
		return appFailure(asOtaError(error, "app request"));
	} finally {
		await discardRequestBody(request, resolveMaxBundleBytes(runtime.maxBundleBytes) + MULTIPART_OVERHEAD);
	}
}

async function manifest(request: Request, runtime: OtaRuntime, app: string, platform: Platform): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
	const { service } = serviceFor(runtime, null);
	const body = JSON.stringify(await service.manifest(app, platform));
	return new Response(request.method === "HEAD" ? null : body, {
		status: 200,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Length": String(new TextEncoder().encode(body).byteLength),
			"Cache-Control": MANIFEST_CACHE_CONTROL,
			"X-Content-Type-Options": "nosniff",
		},
	});
}

async function releases(
	request: Request,
	runtime: OtaRuntime,
	app: string,
	platform: Platform,
	maxBundleBytes: number,
): Promise<Response> {
	if (request.method === "GET" || request.method === "HEAD") return await listReleases(request, runtime, app, platform);
	if (request.method === "POST") return await push(request, runtime, app, platform, maxBundleBytes);
	if (request.method === "DELETE") return await remove(request, runtime, app, platform);
	return methodNotAllowed("GET, POST, DELETE");
}

async function listReleases(request: Request, runtime: OtaRuntime, app: string, platform: Platform): Promise<Response> {
	const { service } = serviceFor(runtime, null);
	await service.authenticatePush(app, request.headers.get("authorization"));
	const query = parseQuery(new URL(request.url).search);
	const channel = query.channel === undefined ? undefined : channelSchema.parse(query.channel);
	const binary = query.binary === undefined ? undefined : binarySchema.parse(query.binary);
	const rows = await service.releases(app, platform, channel, binary);
	const body = JSON.stringify(buildManifest(rows));
	return new Response(request.method === "HEAD" ? null : body, {
		status: 200,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": MANIFEST_CACHE_CONTROL,
			"X-Content-Type-Options": "nosniff",
		},
	});
}

async function push(
	request: Request,
	runtime: OtaRuntime,
	app: string,
	platform: Platform,
	maxBundleBytes: number,
): Promise<Response> {
	const { service } = serviceFor(runtime, null);
	await service.authenticatePush(app, request.headers.get("authorization"));
	await service.authenticateUploadKey(app, request.headers.get("x-ota-upload-key"));
	assertDeclaredLength(request.headers.get("content-length"), maxBundleBytes);

	const declared = Number(request.headers.get("content-length") ?? "0");
	const form = await readMultipart(request, {
		maxBytes: maxBundleBytes + MULTIPART_OVERHEAD,
		maxFileBytes: maxBundleBytes,
		fileField: "bundle",
		...(Number.isFinite(declared) && declared > 0 ? { sizeHint: declared } : {}),
	});
	if (!form.file) throw new OtaError("BUNDLE_MISSING", 'The multipart form must include a "bundle" file part.', 400);
	const meta = pushMetaSchema.parse({
		channel: form.fields.channel ?? "",
		binary: form.fields.binary ?? "",
		sha256: form.fields.sha256 ?? "",
		note: form.fields.note ?? "",
		commit: form.fields.commit ?? "",
		signature: form.fields.signature,
		mandatory: form.fields.mandatory,
	});

	const release = await service.push(app, platform, {
		channel: meta.channel,
		binary: meta.binary,
		sha256: meta.sha256,
		note: meta.note,
		commit: meta.commit,
		signature: meta.signature,
		mandatory: meta.mandatory,
		bytes: form.file.bytes,
	});
	return jsonResponse(manifestEntry(release), 201, {
		"Cache-Control": "no-store",
		Location: `/ota/${encodeURIComponent(app)}/${platform}/${release.file}`,
	});
}

async function remove(request: Request, runtime: OtaRuntime, app: string, platform: Platform): Promise<Response> {
	const { service } = serviceFor(runtime, null);
	await service.authenticatePush(app, request.headers.get("authorization"));
	const query = parseQuery(new URL(request.url).search);
	const channel = channelSchema.parse(query.channel ?? "");
	const binary = binarySchema.parse(query.binary ?? "");
	await service.deleteChannel(app, platform, channel, binary);
	return emptyResponse(204, { "Cache-Control": "no-store" });
}

async function serveFile(
	request: Request,
	runtime: OtaRuntime,
	app: string,
	platform: Platform,
	file: string,
): Promise<Response> {
	const { service } = serviceFor(runtime, null);
	const baseHeaders: Record<string, string> = {
		"Cache-Control": BUNDLE_CACHE_CONTROL,
		"Accept-Ranges": "bytes",
		"X-Content-Type-Options": "nosniff",
	};

	if (request.method === "HEAD") {
		const value = await service.headBundle(app, platform, file);
		if (!value) throw new OtaError("NOT_FOUND", "Unknown bundle.", 404);
		return new Response(null, {
			status: 200,
			headers: {
				...baseHeaders,
				"Content-Type": value.contentType,
				"Content-Length": String(value.size),
				ETag: `"${value.release.sha256}"`,
			},
		});
	}

	const opened = await service.openBundle(app, platform, file, parseRange(request.headers.get("range")) ?? undefined);
	if (!opened) throw new OtaError("NOT_FOUND", "Unknown bundle.", 404);
	const { release, read } = opened;

	if (read.range) {
		const last = read.range.offset + read.range.length - 1;
		return new Response(read.body, {
			status: 206,
			headers: {
				...baseHeaders,
				"Content-Type": read.contentType,
				"Content-Length": String(read.range.length),
				"Content-Range": `bytes ${read.range.offset}-${last}/${read.size}`,
				ETag: `"${release.sha256}"`,
			},
		});
	}

	return new Response(read.body, {
		status: 200,
		headers: {
			...baseHeaders,
			"Content-Type": read.contentType,
			"Content-Length": String(read.size),
			ETag: `"${release.sha256}"`,
		},
	});
}
