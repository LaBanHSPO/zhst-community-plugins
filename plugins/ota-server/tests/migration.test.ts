import assert from "node:assert/strict";
import { it } from "node:test";
import { OtaService } from "../src/domain/service.js";
import { memoryStore } from "./helpers.js";
import { applyMigration, createTestRuntime, migrations } from "./runtime.js";

it("upgrades existing releases with empty signature and boolean false without rewriting the original migration", async () => {
	const mf = createTestRuntime();
	try {
		const db = await mf.getD1Database("OTA_DB");
		const initial = migrations.find((migration) => migration.name === "0001_ota.sql");
		assert.ok(initial);
		await applyMigration(db, initial.sql);
		const createdAt = Date.UTC(2026, 9, 8, 2, 15, 0);
		const file = "bundles/main/1.0.0/20261008-021500.bundle";
		await db.prepare(
			`INSERT INTO ota_releases (id, app, platform, channel, binary, release_id, file, sha256, size, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind("legacy-release", "unitel-man", "android", "main", "1.0.0", "20261008-021500", file, "a".repeat(64), 1, createdAt).run();
		await db.prepare(
			"INSERT INTO ota_current (app, platform, channel, binary, release_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		).bind("unitel-man", "android", "main", "1.0.0", "legacy-release", createdAt).run();

		for (const migration of migrations.filter((migration) => migration.name > initial.name)) {
			await applyMigration(db, migration.sql);
		}
		const stored = await db.prepare("SELECT signature, mandatory FROM ota_releases WHERE id = ?")
			.bind("legacy-release").first<{ signature: string; mandatory: number }>();
		assert.deepEqual(stored, { signature: "", mandatory: 0 });
		const blobs = memoryStore();
		const service = new OtaService({
			db,
			actor: { id: "admin-1", administrator: true },
			blobs: async () => blobs.store,
			now: () => createdAt,
			maxBundleBytes: 1024 * 1024,
			secretKey: null,
			platformAvailable: true,
			baseUrl: "https://ota.test",
		});
		const manifest = await service.manifest("unitel-man", "android");
		assert.equal(manifest.channels.main?.["1.0.0"]?.signature, "");
		assert.equal(manifest.channels.main?.["1.0.0"]?.mandatory, false);
		const release = await service.findByFile("unitel-man", "android", file);
		assert.ok(release);
		assert.equal(release.signature, "");
		assert.equal(release.mandatory, false);
		assert.equal((await service.listReleases({ app: "unitel-man" })).items[0]?.mandatory, false);
		await assert.rejects(db.prepare("UPDATE ota_releases SET mandatory = 2 WHERE id = ?").bind("legacy-release").run());
	} finally {
		await mf.dispose();
	}
});
