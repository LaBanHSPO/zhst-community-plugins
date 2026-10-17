import assert from "node:assert/strict";
import { test } from "node:test";
import type { Workspace } from "../domain/types.js";
import { mergeWorkspacePage } from "./workspace-data.js";

const empty: Workspace = {
	branch: { id: "branch-one", name: "Chi nhánh một", version: 1 },
	role: "floor",
	members: [],
	tables: [],
	visits: [],
	menu: [],
	orders: [],
	payments: [],
	invoices: [],
	jobs: [],
	exceptions: [],
	shift: null,
	shifts: [],
	bills: [],
	serviceRequests: [],
	nextCursor: "next",
};

test("loading later workspace pages preserves earlier tables and replaces overlapping snapshots", () => {
	const first: Workspace = {
		...empty,
		tables: [
			{ id: "table-a", name: "Bàn A", token: "token-a", version: 1 },
			{ id: "table-b", name: "Bàn B", token: "token-b", version: 1 },
		],
		members: [{ userId: "floor-user", role: "floor", active: true, version: 1 }],
	};
	const next: Workspace = {
		...empty,
		nextCursor: null,
		tables: [
			{ id: "table-b", name: "Bàn mới", token: "token-b", version: 2 },
			{ id: "table-c", name: "Bàn C", token: "token-c", version: 1 },
		],
		members: [{ userId: "floor-user", role: "floor", active: false, version: 2 }],
	};
	const result = mergeWorkspacePage(first, next);
	assert.deepEqual(
		result.tables.map((table) => table.id),
		["table-a", "table-b", "table-c"],
	);
	assert.equal(result.tables[1]?.name, "Bàn mới");
	assert.equal(result.members.length, 1);
	assert.equal(result.members[0]?.active, false);
	assert.equal(result.nextCursor, null);
	assert.equal(first.tables[1]?.version, 1);
});

test("stale responses from a previous branch cannot contaminate the new branch", () => {
	assert.throws(
		() =>
			mergeWorkspacePage(empty, {
				...empty,
				branch: { id: "other-branch", name: "Khác", version: 1 },
			}),
		/different branches/,
	);
});

test("visit totals and blockers remain authoritative when loaded pages contain no order lines", () => {
	const first: Workspace = {
		...empty,
		visits: [
			{
				id: "visit",
				tableId: "table",
				status: "open",
				version: 7,
				expiresAt: 10000,
				createdAt: 1,
				total: 540000,
				pendingCount: 3,
				unsettledCount: 2,
			},
		],
	};
	const result = mergeWorkspacePage(first, { ...empty, nextCursor: null });
	assert.equal(result.orders.length, 0);
	assert.equal(result.visits[0]?.total, 540000);
	assert.equal(result.visits[0]?.pendingCount, 3);
	assert.equal(result.visits[0]?.unsettledCount, 2);
});
