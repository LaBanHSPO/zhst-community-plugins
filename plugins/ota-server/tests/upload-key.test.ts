import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Miniflare } from "miniflare";
import { handleOtaAdminRequest } from "../src/http/admin.js";
import { handleOtaAppRequest } from "../src/http/app.js";
import type { OtaAdminRuntime } from "../src/http/shared.js";
import type { PlatformStorage } from "../src/domain/types.js";
import { sha256Hex } from "../src/domain/data.js";
import { memoryPlatformStorage, multipartBody, type MemoryStore } from "./helpers.js";
import { setupDatabase } from "./runtime.js";

const origin = "https://ota.test";
let mf: Miniflare;
let runtime: OtaAdminRuntime;
let storage: MemoryStore & { platform: PlatformStorage };
const encoder = new TextEncoder();

beforeEach(async () => {
	const setup = await setupDatabase();
	mf = setup.mf;
	storage = memoryPlatformStorage();
	runtime = { db: setup.db, platform: storage.platform, actor: { id: "admin", administrator: true }, maxBundleBytes: 1024 * 1024 };
});
afterEach(async () => { await mf.dispose(); });

async function admin(action: string, body?: unknown, options: { actor?: OtaAdminRuntime["actor"]; csrf?: boolean; origin?: string } = {}) {
	return handleOtaAdminRequest(new Request(`${origin}/api/ota/${action}`, {
		method: body === undefined ? "GET" : "POST",
		headers: body === undefined ? {} : { "Content-Type": "application/json", ...(options.csrf === false ? {} : { Origin: options.origin ?? origin, "X-EmDash-Request": "1" }) },
		body: body === undefined ? undefined : JSON.stringify(body),
	}), action.split("?")[0]!, { ...runtime, actor: options.actor === undefined ? runtime.actor : options.actor });
}
async function rotate(app = "unitel-man") {
	const response = await admin("upload-key-rotate", { app });
	assert.equal(response.status, 201);
	return (await response.json() as { data: { key: string } }).data.key;
}
async function token(app = "unitel-man") {
	return (await (await admin("token-create", { app, name: "CI" })).json() as { data: { token: string } }).data.token;
}
async function upload(bearer: string, key?: string, app = "unitel-man", signature?: string) {
	const bytes = encoder.encode("real-bundle");
	const form = multipartBody([
		{ name: "channel", value: "main" }, { name: "binary", value: "1.0+1" },
		{ name: "sha256", value: await sha256Hex(bytes) },
		...(signature === undefined ? [] : [{ name: "signature", value: signature }]),
		{ name: "bundle", filename: "app.bundle", bytes },
	]);
	const request = new Request(`${origin}/ota/${app}/android/releases`, {
		method: "POST", headers: { "Content-Type": form.contentType, Authorization: `Bearer ${bearer}`, ...(key === undefined ? {} : { "X-OTA-Upload-Key": key }) },
		body: form.body as unknown as BodyInit,
	});
	const response = await handleOtaAppRequest(request, `${app}/android/releases`, runtime);
	assert.equal(request.bodyUsed, true);
	return response;
}

describe("admin-owned extra upload key", () => {
	it("rejects non-admin creation, status reads and cross-origin/CSRF writes", async () => {
		for (const actor of [null, { id: "editor", administrator: false }]) {
			assert.equal((await admin("upload-key-rotate", { app: "unitel-man" }, { actor })).status, 403);
			assert.equal((await admin("upload-key?app=unitel-man", undefined, { actor })).status, 403);
		}
		assert.equal((await admin("upload-key-rotate", { app: "unitel-man" }, { csrf: false })).status, 403);
		assert.equal((await admin("upload-key-rotate", { app: "unitel-man" }, { origin: "https://untrusted.test" })).status, 403);
		assert.equal((await runtime.db.prepare("SELECT count(*) AS n FROM ota_settings WHERE key LIKE 'upload-key:%'").first<{ n: number }>())?.n, 0);
	});

	it("requires both credentials after activation, scopes keys per app and invalidates rotated keys", async () => {
		const bearer = await token();
		const key = await rotate();
		assert.equal(Buffer.from(key, "base64").byteLength, 64);
		const missing = await upload(bearer);
		assert.equal(missing.status, 403);
		assert.equal((await missing.json() as { error: { code: string } }).error.code, "UPLOAD_KEY_REQUIRED");
		assert.equal((await upload(bearer, key.replace(/^./, key[0] === "A" ? "B" : "A"))).status, 403);
		assert.equal((await upload("invalid", key)).status, 401);
		assert.equal(storage.objects.size, 0);
		assert.equal((await runtime.db.prepare("SELECT count(*) AS n FROM ota_releases").first<{ n: number }>())?.n, 0);
		const otherBearer = await token("unitel-logistics");
		await rotate("unitel-logistics");
		assert.equal((await upload(otherBearer, key, "unitel-logistics")).status, 403);
		assert.equal((await upload(bearer, key, "unitel-man", Buffer.alloc(64, 1).toString("base64"))).status, 201);
		const next = await rotate();
		const old = await upload(bearer, key);
		assert.equal(old.status, 403);
		assert.equal((await old.json() as { error: { code: string } }).error.code, "UPLOAD_KEY_INVALID");
		assert.equal((await upload(bearer, next)).status, 201);
		const status = await (await admin("upload-key?app=unitel-man")).json();
		const stored = await runtime.db.prepare("SELECT value FROM ota_settings WHERE key = 'upload-key:unitel-man'").first<{ value: string }>();
		const audit = await (await admin("audit")).json();
		const manifest = await handleOtaAppRequest(new Request(`${origin}/ota/unitel-man/android/manifest.json`), "unitel-man/android/manifest.json", runtime);
		for (const text of [JSON.stringify(status), stored?.value ?? "", JSON.stringify(audit), await manifest.text()]) {
			assert.equal(text.includes(key), false);
			assert.equal(text.includes(next), false);
		}
	});

	it("fails closed when stored upload protection is corrupt", async () => {
		const bearer = await token();
		await rotate();
		await runtime.db.prepare("UPDATE ota_settings SET value = '{}' WHERE key = 'upload-key:unitel-man'").run();
		const response = await upload(bearer);
		assert.equal(response.status, 500);
		assert.equal(storage.objects.size, 0);
	});

	it("preserves existing unconfigured app publishing and permits authenticated admin upload", async () => {
		assert.equal((await upload(await token())).status, 201);
		await rotate();
		const form = multipartBody([
			{ name: "app", value: "unitel-man" }, { name: "platform", value: "ios" },
			{ name: "channel", value: "main" }, { name: "binary", value: "1.0+1" },
			{ name: "bundle", filename: "app.bundle", bytes: encoder.encode("admin-bundle") },
		]);
		const response = await handleOtaAdminRequest(new Request(`${origin}/api/ota/release-upload`, {
			method: "POST", headers: { Origin: origin, "X-EmDash-Request": "1", "Content-Type": form.contentType }, body: form.body as unknown as BodyInit,
		}), "release-upload", runtime);
		assert.equal(response.status, 201);
		const result = await response.json() as { data: { sha256: string } };
		assert.equal(result.data.sha256, await sha256Hex(encoder.encode("admin-bundle")));
	});
});
