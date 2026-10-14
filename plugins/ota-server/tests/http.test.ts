/**
 * The frozen HTTP contract, exercised through the same handlers the theme
 * mounts at `/ota/*` and `/api/ota/*`, against real D1 and a real (in-memory)
 * storage adapter.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Miniflare } from "miniflare";
import { handleOtaAppRequest } from "../src/http/app.js";
import { handleOtaAdminRequest } from "../src/http/admin.js";
import type { OtaAdminRuntime, OtaRuntime } from "../src/http/shared.js";
import { sha256Hex } from "../src/domain/data.js";
import type { OtaInfo, OtaManifest, OtaManifestEntry, OtaRelease, OtaStorageView, OtaTokenSummary } from "../src/domain/types.js";
import { memoryPlatformStorage, multipartBody, TEST_BOUNDARY, type MultipartPart } from "./helpers.js";
import { setupDatabase } from "./runtime.js";

const encoder = new TextEncoder();
const ORIGIN = "https://ota.test";
const admin = { id: "admin-1", administrator: true };

let mf: Miniflare;
let db: D1Database;
let platform: ReturnType<typeof memoryPlatformStorage>;
let clock: number;
let runtime: OtaRuntime;

function adminRuntime(actor: OtaAdminRuntime["actor"] | null = admin): OtaAdminRuntime {
	return { ...runtime, actor };
}

function appRequest(path: string, init: RequestInit = {}): Request {
	return new Request(`${ORIGIN}/ota/${path}`, init);
}

function adminRequest(action: string, init: { method?: string; body?: unknown; csrf?: boolean } = {}): Request {
	const method = init.method ?? (init.body === undefined ? "GET" : "POST");
	const headers: Record<string, string> = {};
	if (init.body !== undefined) headers["Content-Type"] = "application/json";
	if (init.csrf !== false && method === "POST") {
		headers["X-EmDash-Request"] = "1";
		headers.Origin = ORIGIN;
	}
	return new Request(`${ORIGIN}/api/ota/${action}`, {
		method,
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
}

async function adminCall<T>(
	action: string,
	init: { method?: string; body?: unknown; csrf?: boolean } = {},
	actor: OtaAdminRuntime["actor"] | null = admin,
): Promise<T> {
	const response = await handleOtaAdminRequest(adminRequest(action, init), action, adminRuntime(actor));
	const payload = (await response.json()) as { ok: boolean; data?: T; error?: { code: string; message: string } };
	assert.ok(response.ok, `admin ${action} failed: ${response.status} ${JSON.stringify(payload.error)}`);
	assert.equal(payload.ok, true);
	return payload.data as T;
}

async function adminFailure(
	action: string,
	init: { method?: string; body?: unknown; csrf?: boolean },
	actor: OtaAdminRuntime["actor"] | null = admin,
) {
	const response = await handleOtaAdminRequest(adminRequest(action, init), action, adminRuntime(actor));
	const payload = (await response.json()) as { ok: boolean; error: { code: string; message: string } };
	assert.equal(response.ok, false);
	return { status: response.status, code: payload.error.code };
}

function bundleRequest(parts: readonly MultipartPart[], token?: string, path = "unitel-man/android/releases"): Request {
	const multipart = multipartBody(parts);
	return appRequest(path, {
		method: "POST",
		headers: {
			"content-type": multipart.contentType,
			...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
		},
		body: multipart.body as unknown as BodyInit,
	});
}

async function pushBundle(token: string, payload: string, overrides: Partial<{ channel: string; binary: string; sha256: string }> = {}) {
	const bytes = encoder.encode(payload);
	const sha = overrides.sha256 ?? (await sha256Hex(bytes));
	return handleOtaAppRequest(
		bundleRequest([
			{ name: "channel", value: overrides.channel ?? "ducnv/feature/luu-kho" },
			{ name: "binary", value: overrides.binary ?? "1.0.66+93" },
			{ name: "sha256", value: sha },
			{ name: "note", value: "fix màn giao hàng" },
			{ name: "commit", value: "e39c6d34" },
			{ name: "bundle", filename: "app.bundle", contentType: "application/octet-stream", bytes },
		], token),
		"unitel-man/android/releases",
		runtime,
	);
}

async function issueToken(app = "unitel-man"): Promise<string> {
	const created = await adminCall<{ token: string; record: OtaTokenSummary }>("token-create", { body: { app, name: "CI" } });
	return created.token;
}

async function readJson<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

beforeEach(async () => {
	const setup = await setupDatabase();
	mf = setup.mf;
	db = setup.db;
	platform = memoryPlatformStorage();
	clock = Date.UTC(2026, 9, 8, 2, 15, 0);
	runtime = {
		db,
		platform: platform.platform,
		secretKey: null,
		baseUrl: ORIGIN,
		maxBundleBytes: 1024 * 1024,
		now: () => clock,
	};
});

afterEach(async () => {
	await mf.dispose();
});

describe("GET /ota/{app}/{platform}/manifest.json", () => {
	it("answers an empty channel map, uncached, when nothing was pushed", async () => {
		const response = await handleOtaAppRequest(appRequest("unitel-man/android/manifest.json"), "unitel-man/android/manifest.json", runtime);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-cache");
		assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
		assert.deepEqual(await readJson(response), { channels: {} });
	});

	it("serves the documented shape and one entry per channel + binary", async () => {
		const token = await issueToken();
		const created = await readJson<OtaManifestEntry>(await pushBundle(token, "bundle-one"));
		const response = await handleOtaAppRequest(appRequest("unitel-man/android/manifest.json"), "unitel-man/android/manifest.json", runtime);
		const manifest = await readJson<OtaManifest>(response);
		assert.deepEqual(manifest, {
			channels: {
				"ducnv/feature/luu-kho": { "1.0.66+93": created },
			},
		});
		assert.match(created.file, /^bundles\/ducnv_feature_luu-kho\/1\.0\.66\+93\/\d{8}-\d{6}\.bundle$/);
		assert.equal(created.createdAt, "2026-10-08T02:15:00.000Z");
	});

	it("rejects an unknown platform and app", async () => {
		const platformResponse = await handleOtaAppRequest(appRequest("unitel-man/windows/manifest.json"), "unitel-man/windows/manifest.json", runtime);
		assert.equal(platformResponse.status, 404);
		const appResponse = await handleOtaAppRequest(appRequest("nope/android/manifest.json"), "nope/android/manifest.json", runtime);
		assert.equal(appResponse.status, 404);
		assert.equal((await readJson<{ error: { code: string } }>(appResponse)).error.code, "APP_UNKNOWN");
	});

	it("rejects a method that is not GET or HEAD", async () => {
		const response = await handleOtaAppRequest(
			appRequest("unitel-man/android/manifest.json", { method: "POST" }),
			"unitel-man/android/manifest.json",
			runtime,
		);
		assert.equal(response.status, 405);
		assert.equal(response.headers.get("allow"), "GET, HEAD");
	});
});

describe("POST /ota/{app}/{platform}/releases", () => {
	it("verifies the token, stores the bundle and answers 201 with the manifest entry", async () => {
		const token = await issueToken();
		const response = await pushBundle(token, "bundle-one");
		assert.equal(response.status, 201);
		const entry = await readJson<OtaManifestEntry>(response);
		assert.equal(entry.size, 10);
		assert.equal(entry.branch, "ducnv/feature/luu-kho");
		assert.equal(entry.note, "fix màn giao hàng");
		assert.equal(platform.objects.size, 1);
		assert.ok(platform.objects.has(`unitel-man/android/${entry.file}`));
	});

	it("refuses an unauthenticated, wrong-app or malformed token", async () => {
		const logistics = await issueToken("unitel-logistics");
		const unauthorized = bundleRequest(
			[
				{ name: "channel", value: "main" },
				{ name: "binary", value: "1.0.0" },
				{ name: "sha256", value: "a".repeat(64) },
				{ name: "bundle", filename: "b.bundle", bytes: encoder.encode("x") },
			],
			undefined,
		);
		const missing = await handleOtaAppRequest(unauthorized, "unitel-man/android/releases", runtime);
		// An early rejection must release the body, or a real 100 MB upload that is
		// refused for its token tears the connection down instead of reading the 401.
		assert.equal(unauthorized.bodyUsed, true, "the rejected request body must be discarded");
		assert.equal(missing.status, 401);
		assert.equal((await readJson<{ error: { code: string } }>(missing)).error.code, "AUTH_REQUIRED");
		assert.equal(missing.headers.get("www-authenticate"), "Bearer");

		const wrongApp = await pushBundle(logistics, "one");
		assert.equal(wrongApp.status, 403);
		assert.equal((await readJson<{ error: { code: string } }>(wrongApp)).error.code, "TOKEN_APP_MISMATCH");

		const fabricated = await handleOtaAppRequest(
			bundleRequest(
				[
					{ name: "channel", value: "main" },
					{ name: "binary", value: "1.0.0" },
					{ name: "sha256", value: "a".repeat(64) },
					{ name: "bundle", filename: "b.bundle", bytes: encoder.encode("x") },
				],
				"otak_not-a-real-token",
			),
			"unitel-man/android/releases",
			runtime,
		);
		assert.equal(fabricated.status, 401);
		assert.equal(platform.objects.size, 0, "a rejected push must not store an object");
	});

	it("rejects a sha256 mismatch with 400 and stores nothing", async () => {
		const token = await issueToken();
		const response = await pushBundle(token, "bundle-one", { sha256: "0".repeat(64) });
		assert.equal(response.status, 400);
		assert.equal((await readJson<{ error: { code: string } }>(response)).error.code, "SHA_MISMATCH");
		assert.equal(platform.objects.size, 0);
	});

	it("rejects a missing bundle part and invalid metadata", async () => {
		const token = await issueToken();
		const noFile = await handleOtaAppRequest(
			bundleRequest([{ name: "channel", value: "main" }], token),
			"unitel-man/android/releases",
			runtime,
		);
		assert.equal(noFile.status, 400);
		assert.equal((await readJson<{ error: { code: string } }>(noFile)).error.code, "BUNDLE_MISSING");

		const badBinary = await pushBundle(token, "one", { binary: "not a binary!" });
		assert.equal(badBinary.status, 400);

		const missingChannel = await handleOtaAppRequest(
			bundleRequest(
				[
					{ name: "binary", value: "1.0.0" },
					{ name: "sha256", value: await sha256Hex(encoder.encode("one")) },
					{ name: "bundle", filename: "b.bundle", bytes: encoder.encode("one") },
				],
				token,
			),
			"unitel-man/android/releases",
			runtime,
		);
		assert.equal(missingChannel.status, 400);
	});

	it("rejects a declared Content-Length above the ceiling with 413", async () => {
		const token = await issueToken();
		const request = appRequest("unitel-man/android/releases", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": `multipart/form-data; boundary=${TEST_BOUNDARY}`,
				"content-length": String(8 * 1024 * 1024),
			},
			body: encoder.encode("x") as unknown as BodyInit,
		});
		const response = await handleOtaAppRequest(request, "unitel-man/android/releases", runtime);
		assert.equal(response.status, 413);
		assert.equal((await readJson<{ error: { code: string } }>(response)).error.code, "BUNDLE_TOO_LARGE");
	});

	it("treats an identical retried push as the stored build", async () => {
		const token = await issueToken();
		const first = await readJson<OtaManifestEntry>(await pushBundle(token, "same"));
		clock += 60_000;
		const again = await readJson<OtaManifestEntry>(await pushBundle(token, "same"));
		assert.equal(again.id, first.id);
		assert.equal(platform.objects.size, 1);
	});
});

describe("GET /ota/{app}/{platform}/{file}", () => {
	it("serves the bytes with Content-Length, immutable caching and no compression", async () => {
		const token = await issueToken();
		const entry = await readJson<OtaManifestEntry>(await pushBundle(token, "bundle-payload"));
		const response = await handleOtaAppRequest(
			appRequest(`unitel-man/android/${entry.file}`, { headers: { "accept-encoding": "identity" } }),
			`unitel-man/android/${entry.file}`,
			runtime,
		);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-length"), String(entry.size));
		assert.equal(response.headers.get("content-encoding"), null);
		assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
		assert.equal(response.headers.get("accept-ranges"), "bytes");
		assert.equal(response.headers.get("etag"), `"${entry.sha256}"`);
		assert.equal(await response.text(), "bundle-payload");
	});

	it("answers HEAD with the headers and no body", async () => {
		const token = await issueToken();
		const entry = await readJson<OtaManifestEntry>(await pushBundle(token, "bundle-payload"));
		const response = await handleOtaAppRequest(
			appRequest(`unitel-man/android/${entry.file}`, { method: "HEAD" }),
			`unitel-man/android/${entry.file}`,
			runtime,
		);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-length"), String(entry.size));
		assert.equal(await response.text(), "");
	});

	it("serves a byte range for a resumed download", async () => {
		const token = await issueToken();
		const entry = await readJson<OtaManifestEntry>(await pushBundle(token, "0123456789"));
		const response = await handleOtaAppRequest(
			appRequest(`unitel-man/android/${entry.file}`, { headers: { range: "bytes=2-5" } }),
			`unitel-man/android/${entry.file}`,
			runtime,
		);
		assert.equal(response.status, 206);
		assert.equal(response.headers.get("content-length"), "4");
		assert.equal(response.headers.get("content-range"), `bytes 2-5/${entry.size}`);
		assert.equal(await response.text(), "2345");

		const openEnded = await handleOtaAppRequest(
			appRequest(`unitel-man/android/${entry.file}`, { headers: { range: "bytes=6-" } }),
			`unitel-man/android/${entry.file}`,
			runtime,
		);
		assert.equal(openEnded.status, 206);
		assert.equal(await openEnded.text(), "6789");
	});

	it("ignores an unsupported range instead of failing", async () => {
		const token = await issueToken();
		const entry = await readJson<OtaManifestEntry>(await pushBundle(token, "0123456789"));
		const response = await handleOtaAppRequest(
			appRequest(`unitel-man/android/${entry.file}`, { headers: { range: "bytes=-4" } }),
			`unitel-man/android/${entry.file}`,
			runtime,
		);
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "0123456789");
	});

	it("never serves a file that is not recorded", async () => {
		const response = await handleOtaAppRequest(
			appRequest("unitel-man/android/bundles/guess/1.0.0/x.bundle"),
			"unitel-man/android/bundles/guess/1.0.0/x.bundle",
			runtime,
		);
		assert.equal(response.status, 404);
	});

	it("reports a recorded-but-missing object as unavailable", async () => {
		const token = await issueToken();
		const entry = await readJson<OtaManifestEntry>(await pushBundle(token, "payload"));
		platform.objects.clear();
		const response = await handleOtaAppRequest(
			appRequest(`unitel-man/android/${entry.file}`),
			`unitel-man/android/${entry.file}`,
			runtime,
		);
		assert.equal(response.status, 404);
		assert.equal((await readJson<{ error: { code: string } }>(response)).error.code, "BUNDLE_UNAVAILABLE");
	});
});

describe("DELETE and GET /ota/{app}/{platform}/releases", () => {
	it("removes one channel + binary, decoding / and + in the query string", async () => {
		const token = await issueToken();
		await pushBundle(token, "one");
		const encoded = await handleOtaAppRequest(
			appRequest("unitel-man/android/releases?channel=ducnv%2Ffeature%2Fluu-kho&binary=1.0.66%2B93", {
				method: "DELETE",
				headers: { authorization: `Bearer ${token}` },
			}),
			"unitel-man/android/releases",
			runtime,
		);
		assert.equal(encoded.status, 204);
		assert.equal(await encoded.text(), "");
		assert.equal(platform.objects.size, 0);

		// A client that sends the raw characters must work too: `+` is not a space here.
		await pushBundle(token, "two");
		const raw = await handleOtaAppRequest(
			appRequest("unitel-man/android/releases?channel=ducnv/feature/luu-kho&binary=1.0.66+93", {
				method: "DELETE",
				headers: { authorization: `Bearer ${token}` },
			}),
			"unitel-man/android/releases",
			runtime,
		);
		assert.equal(raw.status, 204);
		assert.deepEqual(
			await readJson<OtaManifest>(await handleOtaAppRequest(appRequest("unitel-man/android/manifest.json"), "unitel-man/android/manifest.json", runtime)),
			{ channels: {} },
		);
	});

	it("requires the token for reads and deletions in section 2", async () => {
		const list = await handleOtaAppRequest(appRequest("unitel-man/android/releases"), "unitel-man/android/releases", runtime);
		assert.equal(list.status, 401);
		const remove = await handleOtaAppRequest(
			appRequest("unitel-man/android/releases?channel=main&binary=1.0.0", { method: "DELETE" }),
			"unitel-man/android/releases",
			runtime,
		);
		assert.equal(remove.status, 401);
	});

	it("lists the same body as the manifest for an authenticated caller", async () => {
		const token = await issueToken();
		const entry = await readJson<OtaManifestEntry>(await pushBundle(token, "one"));
		const response = await handleOtaAppRequest(
			appRequest("unitel-man/android/releases", { headers: { authorization: `Bearer ${token}` } }),
			"unitel-man/android/releases",
			runtime,
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await readJson<OtaManifest>(response), {
			channels: { "ducnv/feature/luu-kho": { "1.0.66+93": entry } },
		});
	});
});

describe("/api/ota admin surface", () => {
	it("requires an administrator and a same-origin CSRF header", async () => {
		assert.deepEqual(await adminFailure("info", {}, { id: "editor", administrator: false }), {
			status: 403,
			code: "FORBIDDEN",
		});
		assert.deepEqual(await adminFailure("info", {}, null), { status: 403, code: "FORBIDDEN" });
		assert.deepEqual(await adminFailure("token-create", { body: { app: "unitel-man", name: "CI" }, csrf: false }), {
			status: 403,
			code: "CSRF",
		});
	});

	it("reports info with apps, limits and the storage view", async () => {
		const info = await adminCall<OtaInfo>("info");
		assert.deepEqual(
			info.apps.map((app) => app.slug),
			["unitel-logistics", "unitel-man"],
		);
		assert.equal(info.storage.mode, "platform");
		assert.equal(info.storage.platformAvailable, true);
		assert.equal(info.storage.keyConfigured, false);
		assert.equal(info.limits.maxBundleBytes, 1024 * 1024);
		assert.equal(info.limits.retentionDays, 14);
		assert.equal(info.limits.keepPerBinary, 2);
		assert.equal(info.baseUrl, ORIGIN);
		assert.equal(info.counts.releases, 0);
	});

	it("creates a token once, lists it, and revokes it", async () => {
		const created = await adminCall<{ token: string; record: OtaTokenSummary }>("token-create", {
			body: { app: "unitel-man", name: "GitHub Actions" },
		});
		assert.match(created.token, /^otak_/);
		const listed = await adminCall<OtaTokenSummary[]>("tokens");
		assert.equal(listed.length, 1);
		assert.equal(listed[0]?.prefix, created.token.slice(0, 13));
		assert.equal(JSON.stringify(listed).includes(created.token), false, "the plaintext token is never listed");

		await adminCall("token-revoke", { body: { id: created.record.id } });
		const response = await pushBundle(created.token, "one");
		assert.equal(response.status, 401);
		assert.equal((await readJson<{ error: { code: string } }>(response)).error.code, "TOKEN_REVOKED");
	});

	it("stores R2 settings with the secret encrypted, and refuses them without key material", async () => {
		const missingKey = await adminFailure("storage-save", {
			body: {
				mode: "r2",
				r2: { endpoint: "https://account.r2.cloudflarestorage.com", bucket: "ota", accessKeyId: "key", secret: "s3cret" },
			},
		});
		assert.equal(missingKey.code, "SECRET_KEY_MISSING");

		const withKey: OtaRuntime = { ...runtime, secretKey: "11".repeat(32) };
		const saved = await handleOtaAdminRequest(
			adminRequest("storage-save", {
				body: {
					mode: "r2",
					r2: {
						endpoint: "https://account.r2.cloudflarestorage.com",
						bucket: "ota-bundles",
						accessKeyId: "key-id",
						secret: "s3cret-value",
					},
				},
			}),
			"storage-save",
			{ ...withKey, actor: admin },
		);
		const view = (await saved.json()) as { ok: boolean; data: OtaStorageView };
		assert.equal(view.ok, true);
		assert.equal(view.data.mode, "r2");
		assert.equal(view.data.r2.hasSecret, true);
		assert.equal(JSON.stringify(view.data).includes("s3cret-value"), false);

		const stored = await db.prepare("SELECT value FROM ota_settings WHERE key = 'storage'").first<{ value: string }>();
		assert.equal(stored?.value.includes("s3cret-value"), false, "the raw secret is never persisted");
		assert.match(stored?.value ?? "", /"secret":"v1\./);

		// The stored ciphertext must round-trip back to the original secret.
		const { resolveBlobStore } = await import("../src/storage/index.js");
		const store = await resolveBlobStore({
			settings: JSON.parse(stored?.value ?? "{}") as never,
			platform: null,
			key: (await import("../src/domain/secrets.js")).parseKeyMaterial("11".repeat(32)),
		});
		assert.match(store.describe(), /ota-bundles/);
	});

	it("probes the site storage backend without writing a bundle", async () => {
		const result = await adminCall<{ backend: string; bytes: number }>("storage-test", { body: { mode: "platform" } });
		assert.match(result.backend, /site storage/);
		assert.ok(result.bytes > 0);
		assert.equal(platform.objects.size, 0, "the probe cleans up after itself");
	});

	it("uploads a bundle from the workspace and computes its sha256", async () => {
		const multipart = multipartBody([
			{ name: "app", value: "unitel-man" },
			{ name: "platform", value: "ios" },
			{ name: "channel", value: "release/1.0" },
			{ name: "binary", value: "1.6.6" },
			{ name: "bundle", filename: "app.bundle", bytes: encoder.encode("admin-upload") },
		]);
		const response = await handleOtaAdminRequest(
			new Request(`${ORIGIN}/api/ota/release-upload`, {
				method: "POST",
				headers: { "X-EmDash-Request": "1", Origin: ORIGIN, "content-type": multipart.contentType },
				body: multipart.body as unknown as BodyInit,
			}),
			"release-upload",
			adminRuntime(),
		);
		assert.equal(response.status, 201);
		const payload = (await response.json()) as { ok: boolean; data: OtaRelease };
		assert.equal(payload.data.sha256, await sha256Hex(encoder.encode("admin-upload")));
		assert.equal(payload.data.platform, "ios");
		assert.equal(payload.data.selected, true);
	});

	it("deletes and promotes a release, then records the activity", async () => {
		const token = await issueToken();
		const first = await readJson<OtaManifestEntry>(await pushBundle(token, "one"));
		clock += 1000;
		const second = await readJson<OtaManifestEntry>(await pushBundle(token, "two"));
		const listed = await adminCall<{ items: OtaRelease[] }>("releases", {});
		assert.equal(listed.items.length, 2);
		assert.equal(listed.items.filter((item) => item.selected).length, 1);

		const previous = listed.items.find((item) => !item.selected);
		assert.ok(previous);
		await adminCall("release-promote", { body: { id: previous.id } });
		const promoted = await adminCall<{ items: OtaRelease[] }>("releases", {});
		assert.equal(promoted.items.find((item) => item.selected)?.releaseId, previous.releaseId);

		await adminCall("release-delete", { body: { id: previous.id } });
		const after = await adminCall<{ items: OtaRelease[] }>("releases", {});
		assert.equal(after.items.length, 1);
		assert.equal(after.items[0]?.releaseId, second.id);

		const activity = await adminCall<{ action: string }[]>("audit", {});
		const actions = activity.map((event) => event.action);
		assert.ok(actions.includes("push"));
		assert.ok(actions.includes("release-promote"));
		assert.ok(actions.includes("release-delete"));
		// Deleting the current build heals the pointer to the retained previous one.
		const manifest = await readJson<OtaManifest>(
			await handleOtaAppRequest(appRequest("unitel-man/android/manifest.json"), "unitel-man/android/manifest.json", runtime),
		);
		assert.equal(manifest.channels["ducnv/feature/luu-kho"]?.["1.0.66+93"]?.id, second.id);
		void first;
	});

	it("sweeps expired builds on request", async () => {
		const token = await issueToken();
		await pushBundle(token, "one");
		clock += 15 * 24 * 60 * 60 * 1000;
		const result = await adminCall<{ expired: number }>("purge", { body: {} });
		assert.equal(result.expired, 1);
		assert.equal(platform.objects.size, 0);
	});

	it("rejects an unknown action and the wrong method", async () => {
		assert.deepEqual(await adminFailure("nope", {}), { status: 404, code: "NOT_FOUND" });
		assert.deepEqual(await adminFailure("info", { method: "POST", body: {} }), {
			status: 405,
			code: "METHOD_NOT_ALLOWED",
		});
	});
});
