/**
 * Domain rules against a real D1 database (Miniflare), with an in-memory blob
 * store: the contract shapes, SHA-256 verification, the two-build retention
 * window, expiry, rollback and per-app tokens.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Miniflare } from "miniflare";
import { OtaService, storageView } from "../src/domain/service.js";
import { DEFAULT_MAX_BUNDLE_BYTES, OtaError, sha256Hex } from "../src/domain/data.js";
import { manifestEntry } from "../src/domain/manifest.js";
import type { OtaBlobStore } from "../src/domain/types.js";
import { memoryStore, memoryPlatformStorage, type MemoryStore } from "./helpers.js";
import { setupDatabase } from "./runtime.js";

const encoder = new TextEncoder();
const DAY = 24 * 60 * 60 * 1000;

let mf: Miniflare;
let db: D1Database;
let blobs: MemoryStore;
let clock: number;
let service: OtaService;
let guest: OtaService;

function build(options: { maxBundleBytes?: number; actor?: { id: string; administrator: boolean } | null } = {}): OtaService {
	return new OtaService({
		db,
		actor: options.actor === undefined ? { id: "admin-1", administrator: true } : options.actor,
		blobs: async () => blobs.store,
		now: () => clock,
		maxBundleBytes: options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES,
		secretKey: null,
		platformAvailable: true,
		baseUrl: "https://ota.example.com",
	});
}

async function expectError(promise: Promise<unknown>, code: string): Promise<OtaError> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof OtaError, `expected OtaError, got ${String(error)}`);
		assert.equal(error.code, code);
		return error;
	}
	throw new Error(`expected ${code}`);
}

async function push(
	target: OtaService,
	payload: string,
	overrides: Partial<{ channel: string; binary: string; note: string; commit: string; sha256: string; signature: string; mandatory: boolean }> = {},
) {
	const bytes = encoder.encode(payload);
	return target.push("unitel-man", "android", {
		channel: overrides.channel ?? "ducnv/feature/luu-kho",
		binary: overrides.binary ?? "1.0.66+93",
		sha256: overrides.sha256 ?? (await sha256Hex(bytes)),
		note: overrides.note ?? "fix màn giao hàng",
		commit: overrides.commit ?? "e39c6d34",
		signature: overrides.signature,
		mandatory: overrides.mandatory,
		bytes,
	});
}

beforeEach(async () => {
	const setup = await setupDatabase();
	mf = setup.mf;
	db = setup.db;
	blobs = memoryStore();
	clock = Date.UTC(2026, 9, 8, 2, 15, 0);
	service = build();
	guest = build({ actor: null });
});

afterEach(async () => {
	await mf.dispose();
});

describe("manifest contract", () => {
	it("returns an empty channel map when nothing was pushed", async () => {
		assert.deepEqual(await service.manifest("unitel-man", "android"), { channels: {} });
	});

	it("serves exactly one entry per channel and binary in the documented shape", async () => {
		const release = await push(service, "bundle-one");
		const manifest = await service.manifest("unitel-man", "android");
		assert.deepEqual(manifest, {
			channels: {
				"ducnv/feature/luu-kho": {
					"1.0.66+93": {
						id: release.releaseId,
						file: `bundles/ducnv_feature_luu-kho/1.0.66+93/${release.releaseId}.bundle`,
						sha256: release.sha256,
						size: 10,
						note: "fix màn giao hàng",
						commit: "e39c6d34",
						signature: "",
						mandatory: false,
						branch: "ducnv/feature/luu-kho",
						createdAt: "2026-10-08T02:15:00.000Z",
					},
				},
			},
		});
		assert.match(release.releaseId, /^\d{8}-\d{6}$/);
		assert.equal(release.createdAt, "2026-10-08T02:15:00.000Z");
		assert.deepEqual(manifestEntry(release), manifest.channels["ducnv/feature/luu-kho"]?.["1.0.66+93"]);
	});

	it("rejects a payload whose SHA-256 does not match the declaration", async () => {
		const error = await expectError(
			push(service, "bundle-one", { sha256: "0".repeat(64) }),
			"SHA_MISMATCH",
		);
		assert.equal(error.status, 400);
		assert.equal(blobs.objects.size, 0, "a rejected push must not store an object");
	});

	it("enforces the bundle ceiling and reports 413", async () => {
		const small = build({ maxBundleBytes: 8 });
		const error = await expectError(push(small, "0123456789"), "BUNDLE_TOO_LARGE");
		assert.equal(error.status, 413);
	});

	it("rejects an unknown app", async () => {
		await expectError(service.manifest("nope", "android"), "APP_UNKNOWN");
	});

	it("rejects a disabled app", async () => {
		await service.saveApp({ slug: "unitel-man", name: "Unitel Man", enabled: false });
		await expectError(service.manifest("unitel-man", "android"), "APP_DISABLED");
	});
});

describe("release metadata", () => {
	const signature = btoa(String.fromCharCode(...new Uint8Array(64).fill(255)));
	const otherSignature = btoa(String.fromCharCode(...new Uint8Array(64).fill(254)));

	it("persists exact signature text and integer flags, and reads boolean metadata after rollback", async () => {
		const first = await push(service, "first", { signature, mandatory: true });
		assert.equal(first.signature, signature);
		assert.equal(first.mandatory, true);
		const stored = await db.prepare("SELECT signature, mandatory FROM ota_releases WHERE id = ?")
			.bind(first.id).first<{ signature: string; mandatory: number }>();
		assert.deepEqual(stored, { signature, mandatory: 1 });
		assert.deepEqual(await service.findByFile("unitel-man", "android", first.file), first);
		const listed = await service.listReleases({ app: "unitel-man" });
		assert.equal(listed.items[0]?.signature, signature);
		assert.equal(listed.items[0]?.mandatory, true);

		clock += 1000;
		const second = await push(service, "second", { signature: otherSignature, mandatory: false });
		assert.equal(second.mandatory, false);
		assert.equal((await service.manifest("unitel-man", "android")).channels[first.channel]?.[first.binary]?.mandatory, false);
		await service.promoteRelease({ id: first.id });
		assert.deepEqual(
			(await service.manifest("unitel-man", "android")).channels[first.channel]?.[first.binary],
			manifestEntry(first),
		);
	});

	it("creates new releases for changed signature or mandatory despite identical bytes, but replays matching metadata", async () => {
		const first = await push(service, "same", { signature, mandatory: false });
		clock += 1000;
		const changedSignature = await push(service, "same", { signature: otherSignature, mandatory: false });
		assert.notEqual(changedSignature.id, first.id);
		assert.equal(changedSignature.signature, otherSignature);
		clock += 1000;
		const changedMandatory = await push(service, "same", { signature: otherSignature, mandatory: true });
		assert.notEqual(changedMandatory.id, changedSignature.id);
		assert.equal(changedMandatory.mandatory, true);
		const replay = await push(service, "same", { signature: otherSignature, mandatory: true });
		assert.equal(replay.id, changedMandatory.id);
		const count = await db.prepare("SELECT COUNT(*) AS n FROM ota_releases").first<{ n: number }>();
		assert.equal(count?.n, 2);
		assert.equal(blobs.objects.size, 2);
	});

	it("defaults omitted metadata for direct callers and rejects invalid domain metadata before storage", async () => {
		const release = await push(service, "legacy-client");
		assert.equal(release.signature, "");
		assert.equal(release.mandatory, false);
		await assert.rejects(push(service, "bad", { signature: "not base64" }), { name: "ZodError" });
		await assert.rejects(
			push(service, "bad", { mandatory: "false" as unknown as boolean }),
			{ name: "ZodError" },
		);
		assert.equal(blobs.objects.size, 1);
	});
});

describe("retention", () => {
	it("keeps the current build plus the previous one and deletes older objects", async () => {
		const first = await push(service, "one");
		clock += 1000;
		const second = await push(service, "two");
		clock += 1000;
		const third = await push(service, "three");

		const rows = await db
			.prepare(
				`SELECT r.release_id, CASE WHEN c.release_id IS NULL THEN 0 ELSE 1 END AS current
				 FROM ota_releases r LEFT JOIN ota_current c ON c.release_id = r.id ORDER BY r.created_at`,
			)
			.all<{ release_id: string; current: number }>();
		assert.deepEqual(
			rows.results?.map((row) => row.release_id),
			[second.releaseId, third.releaseId],
		);
		assert.equal(rows.results?.filter((row) => row.current === 1).length, 1);
		assert.equal(blobs.objects.size, 2, "the pruned build's object must be deleted");
		assert.equal(blobs.objects.has(`unitel-man/android/${first.file}`), false);

		const manifest = await service.manifest("unitel-man", "android");
		assert.equal(manifest.channels["ducnv/feature/luu-kho"]?.["1.0.66+93"]?.id, third.releaseId);
	});

	it("rolls a channel back to the previous build", async () => {
		const first = await push(service, "one");
		clock += 1000;
		const second = await push(service, "two");
		await service.promoteRelease({ id: first.id });
		let manifest = await service.manifest("unitel-man", "android");
		assert.equal(manifest.channels["ducnv/feature/luu-kho"]?.["1.0.66+93"]?.id, first.releaseId);

		// A later push becomes current again; retention keeps the two newest builds,
		// so the rolled-back one is dropped and the immediately previous one stays.
		clock += 1000;
		const third = await push(service, "three");
		manifest = await service.manifest("unitel-man", "android");
		assert.equal(manifest.channels["ducnv/feature/luu-kho"]?.["1.0.66+93"]?.id, third.releaseId);
		const ids = await db.prepare("SELECT release_id FROM ota_releases ORDER BY created_at").all<{ release_id: string }>();
		assert.deepEqual(
			ids.results?.map((row) => row.release_id).sort(),
			[second.releaseId, third.releaseId].sort(),
		);
		assert.equal(blobs.objects.has(`unitel-man/android/${first.file}`), false);
		assert.equal(blobs.objects.has(`unitel-man/android/${second.file}`), true);

		// Rolling back to the retained previous build keeps working.
		await service.promoteRelease({ id: second.id });
		manifest = await service.manifest("unitel-man", "android");
		assert.equal(manifest.channels["ducnv/feature/luu-kho"]?.["1.0.66+93"]?.id, second.releaseId);
	});

	it("expires builds that were not pushed again inside the window", async () => {
		const stale = await push(service, "one");
		clock += 15 * DAY;
		// Every push also sweeps expired builds, so the stale row never survives
		// the next push; the scheduled sweep is the same call.
		const fresh = await push(service, "two");
		assert.equal(blobs.objects.has(`unitel-man/android/${stale.file}`), false);
		assert.equal(blobs.objects.has(`unitel-man/android/${fresh.file}`), true);
		const rows = await db.prepare("SELECT release_id FROM ota_releases").all<{ release_id: string }>();
		assert.deepEqual(rows.results?.map((row) => row.release_id), [fresh.releaseId]);
		assert.equal(await service.purgeExpired(), 0);
	});

	it("keeps a build that is still inside the window", async () => {
		const recent = await push(service, "one");
		clock += 13 * DAY;
		await push(service, "two");
		assert.equal(blobs.objects.has(`unitel-man/android/${recent.file}`), true);
	});

	it("removes every build of one channel and binary", async () => {
		await push(service, "one");
		clock += 1000;
		await push(service, "two");
		const removed = await service.deleteChannel("unitel-man", "android", "ducnv/feature/luu-kho", "1.0.66+93");
		assert.equal(removed, 2);
		assert.equal(blobs.objects.size, 0);
		assert.deepEqual(await service.manifest("unitel-man", "android"), { channels: {} });
	});

	it("treats an identical retried push as the same release", async () => {
		const first = await push(service, "same-bytes");
		clock += 5000;
		const again = await push(service, "same-bytes");
		assert.equal(again.releaseId, first.releaseId);
		assert.equal(again.id, first.id);
		const count = await db.prepare("SELECT COUNT(*) AS n FROM ota_releases").first<{ n: number }>();
		assert.equal(count?.n, 1);
		assert.equal(blobs.objects.size, 1);
	});
});

describe("concurrency", () => {
	it("keeps both builds and their own bytes when two pushes race", async () => {
		const [left, right] = await Promise.all([push(service, "left"), push(service, "right")]);
		assert.notEqual(left.releaseId, right.releaseId);
		const rows = await db
			.prepare(
				`SELECT r.id, r.file, CASE WHEN c.release_id IS NULL THEN 0 ELSE 1 END AS current
				 FROM ota_releases r LEFT JOIN ota_current c ON c.release_id = r.id`,
			)
			.all<{ id: string; file: string; current: number }>();
		assert.equal(rows.results?.length, 2);
		assert.equal(rows.results?.filter((row) => row.current === 1).length, 1);
		assert.equal(blobs.objects.size, 2);

		// Each row must still own the exact bytes it was pushed with: a shared
		// object key would silently serve the wrong build.
		for (const row of rows.results ?? []) {
			const object = blobs.objects.get(`unitel-man/android/${row.file}`);
			assert.ok(object, `missing object for ${row.file}`);
			const text = new TextDecoder().decode(object.bytes);
			const expected = [...blobs.objects.entries()].find(([key]) => key.endsWith(row.file));
			assert.ok(expected);
			assert.ok(text === "left" || text === "right", `unexpected bytes ${text}`);
		}
	});

	it("allocates distinct release ids for two pushes in the same second", async () => {
		const [left, right] = await Promise.all([push(service, "same-second-a"), push(service, "same-second-b")]);
		assert.notEqual(left.releaseId, right.releaseId);
		const rows = await db.prepare("SELECT COUNT(*) AS n FROM ota_releases").first<{ n: number }>();
		assert.equal(rows?.n, 2);
	});

	it("heals the current pointer after the current build is deleted", async () => {
		const first = await push(service, "one");
		clock += 1000;
		const second = await push(service, "two");
		await service.deleteRelease({ id: second.id });
		const manifest = await service.manifest("unitel-man", "android");
		assert.equal(manifest.channels["ducnv/feature/luu-kho"]?.["1.0.66+93"]?.id, first.releaseId);
	});
});

describe("tokens", () => {
	it("authenticates a token only for its own app", async () => {
		const created = await service.createToken({ app: "unitel-man", name: "CI" });
		assert.match(created.token, /^otak_[A-Za-z0-9_-]{43}$/);
		assert.equal(created.record.prefix, created.token.slice(0, 13));
		await service.authenticatePush("unitel-man", `Bearer ${created.token}`);
		await expectError(service.authenticatePush("unitel-logistics", `Bearer ${created.token}`), "TOKEN_APP_MISMATCH");
		await expectError(service.authenticatePush("unitel-man", null), "AUTH_REQUIRED");
		await expectError(service.authenticatePush("unitel-man", "Bearer otak_wrong"), "TOKEN_INVALID");
		await expectError(service.authenticatePush("unitel-man", created.token), "AUTH_REQUIRED");
	});

	it("rejects a revoked token and never stores it in plaintext", async () => {
		const created = await service.createToken({ app: "unitel-man", name: "CI" });
		const stored = await db
			.prepare("SELECT token_hash, token_prefix FROM ota_tokens WHERE id = ?")
			.bind(created.record.id)
			.first<{ token_hash: string; token_prefix: string }>();
		assert.equal(stored?.token_hash, await sha256Hex(encoder.encode(created.token)));
		assert.equal(JSON.stringify(stored).includes(created.token), false);

		await service.revokeToken({ id: created.record.id });
		await expectError(service.authenticatePush("unitel-man", `Bearer ${created.token}`), "TOKEN_REVOKED");
		await expectError(service.revokeToken({ id: created.record.id }), "TOKEN_NOT_FOUND");
	});

	it("records last use", async () => {
		const created = await service.createToken({ app: "unitel-man", name: "CI" });
		clock += 120_000;
		await service.authenticatePush("unitel-man", `Bearer ${created.token}`);
		const tokens = await service.listTokens();
		assert.equal(tokens[0]?.lastUsedAt, new Date(clock).toISOString());
	});
});

describe("authorization and settings", () => {
	it("refuses admin operations for a non-administrator actor", async () => {
		const limited = build({ actor: { id: "editor", administrator: false } });
		await expectError(limited.listReleases({}), "FORBIDDEN");
		await expectError(limited.createToken({ app: "unitel-man", name: "x" }), "FORBIDDEN");
		await expectError(limited.saveStorageSettings({ mode: "platform" }), "FORBIDDEN");
		await expectError(limited.listAudit({}), "FORBIDDEN");
	});

	it("defaults to the site storage plan and refuses R2 settings without key material", async () => {
		const settings = await service.getStorageSettings();
		assert.equal(settings.mode, "platform");
		const view = storageView(settings, { platformAvailable: true, keyConfigured: false });
		assert.equal(view.platformAvailable, true);
		assert.equal(view.r2.hasSecret, false);
		assert.equal(view.updatedAt, null);

		await expectError(
			service.saveStorageSettings({
				mode: "r2",
				r2: { endpoint: "https://account.r2.cloudflarestorage.com", bucket: "ota", accessKeyId: "k", secret: "s" },
			}),
			"SECRET_KEY_MISSING",
		);
	});

	it("writes an audit trail", async () => {
		await push(service, "one");
		const events = await service.listAudit({ limit: 10 });
		assert.equal(events[0]?.action, "push");
		assert.equal(events[0]?.app, "unitel-man");
		assert.equal(events[0]?.actorKind, "administrator");
	});
});

describe("platform storage adapter", () => {
	it("stores, ranges and deletes through the host storage contract", async () => {
		const platform = memoryPlatformStorage();
		const store: OtaBlobStore = (await import("../src/storage/platform.js")).platformBlobStore(platform.platform);
		const bytes = encoder.encode("0123456789");
		await store.put("unitel-man/android/bundles/a/1.0.0/x.bundle", bytes, { contentType: "application/octet-stream" });
		const full = await store.get("unitel-man/android/bundles/a/1.0.0/x.bundle");
		assert.equal(full?.size, 10);
		assert.equal(new TextDecoder().decode(await new Response(full?.body).arrayBuffer()), "0123456789");

		const partial = await store.get("unitel-man/android/bundles/a/1.0.0/x.bundle", { offset: 2, length: 3 });
		assert.deepEqual(partial?.range, { offset: 2, length: 3 });
		assert.equal(new TextDecoder().decode(await new Response(partial?.body).arrayBuffer()), "234");

		const open = await store.get("unitel-man/android/bundles/a/1.0.0/x.bundle", { offset: 8 });
		assert.equal(new TextDecoder().decode(await new Response(open?.body).arrayBuffer()), "89");

		assert.equal(await store.head("missing"), null);
		await store.delete("unitel-man/android/bundles/a/1.0.0/x.bundle");
		assert.equal(await store.get("unitel-man/android/bundles/a/1.0.0/x.bundle"), null);
	});
});
