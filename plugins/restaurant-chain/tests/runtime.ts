import { readdir, readFile } from "node:fs/promises";
import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";

export function createTestRuntime(binding: string): Miniflare {
	return new Miniflare({
		workers: [
			{
				config: {
					name: "restaurant-test",
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
					env: { [binding]: { type: "d1", id: crypto.randomUUID() } },
				},
			},
		],
	});
}

/** Apply every plugin migration in order, matching `wrangler d1 migrations apply`. */
export async function applyMigrations(db: D1Database): Promise<void> {
	const directory = new URL("../migrations/", import.meta.url);
	const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
	await db
		.prepare(
			"CREATE TABLE IF NOT EXISTS rc_test_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
		)
		.run();
	const applied = new Set(
		(
			await db.prepare("SELECT name FROM rc_test_migrations").all<{ name: string }>()
		).results.map((row) => row.name),
	);
	for (const file of files) {
		if (applied.has(file)) continue;
		const sql = await readFile(new URL(file, directory), "utf8");
		await db.batch(
			sql
				.replace(/^\s*--.*$/gm, "")
				.split(";")
				.map((statement) => statement.trim())
				.filter((statement) => statement && !statement.startsWith("PRAGMA"))
				.map((statement) => db.prepare(statement)),
		);
		await db
			.prepare("INSERT INTO rc_test_migrations(name,applied_at) VALUES (?,?)")
			.bind(file, Date.now())
			.run();
	}
}
