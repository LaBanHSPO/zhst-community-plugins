import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import type { Miniflare } from "miniflare";
import { createTestRuntime } from "./runtime.js";
import { handleRestaurantRequest } from "../src/http.js";
import type { IntegrationOptions } from "../src/integrations/index.js";

let runtime: Miniflare;
let options: IntegrationOptions;
before(async () => {
	runtime = createTestRuntime("DB");
	const db = await runtime.getD1Database("DB");
	const migration = await readFile(
		new URL("../migrations/0001_restaurant.sql", import.meta.url),
		"utf8",
	);
	await db.exec(migration);
	options = { db, contexts: {} };
});
after(async () => {
	await runtime?.dispose();
});

const actor = { id: "admin-test", administrator: true };
const origin = "https://restaurant.example";

test("cross-origin and missing-CSRF commands cannot reach provisioning", async () => {
	for (const headers of [
		new Headers({
			Origin: "https://attacker.example",
			"X-EmDash-Request": "1",
			"Content-Type": "application/json",
		}),
		new Headers({ Origin: origin, "Content-Type": "application/json" }),
	]) {
		const response = await handleRestaurantRequest(
			new Request(`${origin}/api/restaurant/save-branch`, {
				method: "POST",
				headers,
				body: "{}",
			}),
			"save-branch",
			actor,
			options,
		);
		assert.equal(response.status, 403);
		const body = (await response.json()) as { error: { code: string } };
		assert.equal(body.error.code, "CSRF");
	}
	assert.equal(
		(
			await options.db
				.prepare("SELECT count(*) AS count FROM rc_branches")
				.first<{ count: number }>()
		)?.count,
		0,
	);
});

test("anonymous private workspace reads are denied", async () => {
	const response = await handleRestaurantRequest(
		new Request(`${origin}/api/restaurant/workspace?branchId=not-owned`),
		"workspace",
		null,
		options,
	);
	assert.equal(response.status, 401);
});

test("GET cannot invoke a mutation, and inherited names are not actions", async () => {
	const mutation = await handleRestaurantRequest(
		new Request(`${origin}/api/restaurant/open-visit`),
		"open-visit",
		actor,
		options,
	);
	assert.equal(mutation.status, 405);
	assert.equal(mutation.headers.get("allow"), "POST");
	const inherited = await handleRestaurantRequest(
		new Request(`${origin}/api/restaurant/toString`),
		"toString",
		actor,
		options,
	);
	assert.equal(inherited.status, 404);
});

test("oversized and malformed command bodies are rejected without mutations", async () => {
	for (const [body, expected] of [
		["x".repeat(65_537), 413],
		['{"bad":', 400],
	] as const) {
		const response = await handleRestaurantRequest(
			new Request(`${origin}/api/restaurant/save-branch`, {
				method: "POST",
				headers: { Origin: origin, "X-EmDash-Request": "1", "Content-Type": "application/json" },
				body,
			}),
			"save-branch",
			actor,
			options,
		);
		assert.equal(response.status, expected);
	}
	assert.equal(
		(
			await options.db
				.prepare("SELECT count(*) AS count FROM rc_branches")
				.first<{ count: number }>()
		)?.count,
		0,
	);
});
