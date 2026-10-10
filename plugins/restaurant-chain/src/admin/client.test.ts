import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandIdentity, request, RestaurantRequestError, safeImage } from "./client.js";

test("an uncertain order retry retains the command identity; changed contents do not", () => {
	let sequence = 0;
	const identity = new CommandIdentity(() => `command-${++sequence}`);
	const input = {
		token: "visit-token",
		expectedVersion: 3,
		note: "Không hành",
		lines: [{ menuItemId: "soup", quantity: 2, modifierIds: ["large"] }],
	};
	const first = identity.for("submit-order", input);
	assert.equal(identity.for("submit-order", structuredClone(input)), first);
	assert.notEqual(identity.for("submit-order", { ...input, note: "Ít cay" }), first);
	const revised = identity.for("submit-order", { ...input, note: "Ít cay" });
	assert.equal(
		identity.for("submit-order", {
			lines: input.lines,
			note: "Ít cay",
			expectedVersion: 3,
			token: "visit-token",
		}),
		revised,
	);
	identity.complete();
	assert.notEqual(identity.for("submit-order", { ...input, note: "Ít cay" }), revised);
});

test("different actions cannot reuse an id even when their input matches", () => {
	let sequence = 0;
	const identity = new CommandIdentity(() => String(++sequence));
	const input = { branchId: "branch", id: "record", expectedVersion: 1 };
	assert.notEqual(identity.for("confirm-order", input), identity.for("void-order", input));
});

test("invalid responses and authorization failures never become apparent success", async (context) => {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { location: { origin: "https://restaurant.example" } },
	});
	context.after(() => {
		Reflect.deleteProperty(globalThis, "window");
	});
	const responses = [
		Response.json({ data: {} }),
		Response.json({ ok: true }),
		Response.json(
			{ ok: false, error: { code: "FORBIDDEN", message: "No access" } },
			{ status: 403 },
		),
	];
	context.mock.method(globalThis, "fetch", async () => responses.shift()!);
	await assert.rejects(
		request("info"),
		(error: unknown) =>
			error instanceof RestaurantRequestError && error.code === "INVALID_RESPONSE",
	);
	await assert.rejects(
		request("info"),
		(error: unknown) =>
			error instanceof RestaurantRequestError && error.code === "INVALID_RESPONSE",
	);
	await assert.rejects(
		request("workspace", { branchId: "other" }),
		(error: unknown) => error instanceof RestaurantRequestError && error.code === "FORBIDDEN",
	);
});

test("menu images reject executable and insecure remote schemes", () => {
	assert.equal(safeImage("javascript:alert(1)"), undefined);
	assert.equal(safeImage("data:image/svg+xml,<svg/>"), undefined);
	assert.equal(safeImage("http://remote.example/photo.jpg"), undefined);
	assert.equal(safeImage("/media/dish.webp"), "/media/dish.webp");
	assert.equal(safeImage("https://images.example/dish.webp"), "https://images.example/dish.webp");
});
