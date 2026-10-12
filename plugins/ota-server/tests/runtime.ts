import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

const BINDING = "OTA_DB";

export const migration = await readFile(new URL("../migrations/0001_ota.sql", import.meta.url), "utf8");

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

/** Apply the plugin migration the same way `wrangler d1 migrations apply` does. */
export async function migrate(db: D1Database): Promise<void> {
	await db.batch(
		migration
			.split(";")
			.map((sql) => sql.trim())
			.filter((sql) => sql !== "" && !sql.startsWith("PRAGMA"))
			.map((sql) => db.prepare(sql)),
	);
}
