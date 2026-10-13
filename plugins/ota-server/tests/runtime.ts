import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";

const BINDING = "OTA_DB";

const migrationDirectory = new URL("../migrations/", import.meta.url);
export const migrations = await Promise.all(
	(await readdir(migrationDirectory))
		.filter((name) => /^\d+_.*\.sql$/.test(name))
		.sort()
		.map(async (name) => ({ name, sql: await readFile(new URL(name, migrationDirectory), "utf8") })),
);

/** A Miniflare worker exposing one D1 database, matching the theme's binding shape. */
export function createTestRuntime(): Miniflare {
	return new Miniflare({
		workers: [
			{
				config: {
					name: "ota-test",
					compatibilityDate: "2026-10-10",
					manifest: {
						mainModule: "worker.mjs",
						modules: {
							"worker.mjs": {
								type: "esm",
								contents: 'export default { fetch() { return new Response("test"); } }',
							},
						},
					},
					env: { [BINDING]: { type: "d1", id: crypto.randomUUID() } },
				},
			},
		],
	});
}

export async function setupDatabase(): Promise<{ mf: Miniflare; db: D1Database }> {
	const mf = createTestRuntime();
	const db = await mf.getD1Database(BINDING);
	await migrate(db);
	return { mf, db };
}

/** Apply forward migrations in filename order, as `wrangler d1 migrations apply` does. */
export async function migrate(db: D1Database): Promise<void> {
	for (const migration of migrations) {
		await applyMigration(db, migration.sql);
	}
}

export async function applyMigration(db: D1Database, sql: string): Promise<void> {
	await db.batch(
		sql
			.split(";")
			.map((statement) => statement.trim())
			.filter((statement) => statement !== "" && !statement.startsWith("PRAGMA"))
			.map((statement) => db.prepare(statement)),
	);
}
