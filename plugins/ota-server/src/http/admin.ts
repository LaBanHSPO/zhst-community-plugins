/**
 * Admin API for the OTA workspace, served by the companion theme at
 * `/api/ota/*`. Every action requires an administrator; the theme route
 * resolves the session and passes the actor in.
 */

import { OtaError, sha256Hex } from "../domain/data.js";
import { storageView } from "../domain/service.js";
import { storageSaveSchema, platformSchema, appSlugSchema, channelSchema, binarySchema } from "../domain/validation.js";
import { probeBlobStore, resolveBlobStore, r2BlobStore } from "../storage/index.js";
import { readMultipart } from "./multipart.js";
import {
	adminFailure,
	adminSuccess,
	asOtaError,
	discardRequestBody,
	parseQuery,
	requireAdminRequest,
	requireJson,
	serviceFor,
} from "./shared.js";
import type { OtaAdminRuntime } from "./shared.js";
import type { OtaBlobStore, OtaStorageSettings } from "../domain/types.js";

const READS: Record<string, true> = { info: true, releases: true, tokens: true, storage: true, audit: true };
const WRITES: Record<string, true> = {
	"release-delete": true,
	"release-promote": true,
	"release-upload": true,
	"token-create": true,
	"token-revoke": true,
	"app-save": true,
	"storage-save": true,
	"storage-test": true,
	purge: true,
};

const MULTIPART_OVERHEAD = 64 * 1024;

export async function handleOtaAdminRequest(
	request: Request,
	action: string,
	runtime: OtaAdminRuntime,
): Promise<Response> {
	const isRead = Object.hasOwn(READS, action);
	const isWrite = Object.hasOwn(WRITES, action);
	try {
		if (!isRead && !isWrite) throw new OtaError("NOT_FOUND", "Unknown OTA admin action.", 404);
		if (!runtime.actor?.administrator)
			throw new OtaError("FORBIDDEN", "An administrator account is required.", 403);
		requireAdminRequest(request);
		const expected = isRead ? "GET" : "POST";
		if (request.method !== expected) {
			const response = adminFailure(new OtaError("METHOD_NOT_ALLOWED", `Use ${expected} for this action.`, 405));
			response.headers.set("Allow", expected);
			return response;
		}

		const { service, secretKey, maxBundleBytes } = serviceFor(runtime, runtime.actor);

		switch (action) {
			case "info": {
				const settings = await service.getStorageSettings();
				return adminSuccess(
					await service.info(
						storageView(settings, {
							platformAvailable: Boolean(runtime.platform),
							keyConfigured: Boolean(secretKey),
						}),
					),
				);
			}
			case "releases":
				return adminSuccess(await service.listReleases(parseQuery(new URL(request.url).search)));
			case "tokens": {
				const app = parseQuery(new URL(request.url).search).app;
				const parsed = app === undefined ? undefined : appSlugSchema.parse(app);
				return adminSuccess(await service.listTokens(parsed));
			}
			case "storage": {
				const settings = await service.getStorageSettings();
				return adminSuccess(
					storageView(settings, {
						platformAvailable: Boolean(runtime.platform),
						keyConfigured: Boolean(secretKey),
					}),
				);
			}
			case "audit":
				return adminSuccess(await service.listAudit(parseQuery(new URL(request.url).search)));
			case "release-delete":
				return adminSuccess(await service.deleteRelease(await requireJson(request)));
			case "release-promote":
				return adminSuccess(await service.promoteRelease(await requireJson(request)));
			case "token-create":
				return adminSuccess(await service.createToken(await requireJson(request)), 201);
			case "token-revoke":
				return adminSuccess(await service.revokeToken(await requireJson(request)));
			case "app-save":
				return adminSuccess(await service.saveApp(await requireJson(request)));
			case "storage-save":
				return adminSuccess(await service.saveStorageSettings(await requireJson(request)));
			case "purge":
				return adminSuccess({ expired: await service.purgeExpired() });
			case "storage-test": {
				const input = (await requireJson(request)) as Record<string, unknown>;
				const saved = await service.getStorageSettings();
				const mode =
					input.mode === "platform" || input.mode === "r2" ? (input.mode as "platform" | "r2") : saved.mode;
				const raw = (typeof input.r2 === "object" && input.r2 !== null ? input.r2 : {}) as Record<string, unknown>;
				const text = (value: unknown, fallback: string) =>
					typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
				const draft = storageSaveSchema.parse({
					mode,
					r2: {
						endpoint: text(raw.endpoint, saved.r2.endpoint),
						bucket: text(raw.bucket, saved.r2.bucket),
						accessKeyId: text(raw.accessKeyId, saved.r2.accessKeyId),
						secret: typeof raw.secret === "string" ? raw.secret : "",
						region: text(raw.region, saved.r2.region),
						publicUrl: text(raw.publicUrl, saved.r2.publicUrl),
					},
				});
				let store: OtaBlobStore;
				if (draft.mode === "platform") {
					store = await resolveBlobStore({
						settings: { ...saved, mode: "platform" },
						platform: runtime.platform ?? null,
						key: secretKey,
					});
				} else if (draft.r2.secret !== "") {
					store = r2BlobStore({
						endpoint: draft.r2.endpoint,
						bucket: draft.r2.bucket,
						accessKeyId: draft.r2.accessKeyId,
						secretAccessKey: draft.r2.secret,
						region: draft.r2.region,
					});
				} else {
					const settings: OtaStorageSettings = { ...saved, mode: "r2", r2: { ...saved.r2, ...draft.r2, secret: saved.r2.secret } };
					store = await resolveBlobStore({ settings, platform: null, key: secretKey });
				}
				const probe = await probeBlobStore(store);
				return adminSuccess({ backend: probe.backend, bytes: probe.bytes });
			}
			case "release-upload": {
				const declared = Number(request.headers.get("content-length") ?? "0");
				const form = await readMultipart(request, {
					maxBytes: maxBundleBytes + MULTIPART_OVERHEAD,
					maxFileBytes: maxBundleBytes,
					fileField: "bundle",
					...(Number.isFinite(declared) && declared > 0 ? { sizeHint: declared } : {}),
				});
				if (!form.file) throw new OtaError("BUNDLE_MISSING", 'The upload must include a "bundle" file part.', 400);
				const app = appSlugSchema.parse(form.fields.app ?? "");
				const platform = platformSchema.parse(form.fields.platform ?? "");
				const channel = channelSchema.parse(form.fields.channel ?? "");
				const binary = binarySchema.parse(form.fields.binary ?? "");
				const release = await service.push(app, platform, {
					channel,
					binary,
					sha256: await sha256Hex(form.file.bytes),
					note: form.fields.note ?? "",
					commit: form.fields.commit ?? "",
					bytes: form.file.bytes,
				});
				return adminSuccess(release, 201);
			}
			default:
				throw new OtaError("NOT_FOUND", "Unknown OTA admin action.", 404);
		}
	} catch (error) {
		return adminFailure(asOtaError(error, "admin request"));
	} finally {
		await discardRequestBody(request);
	}
}
