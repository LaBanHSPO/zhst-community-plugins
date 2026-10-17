import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Miniflare } from "miniflare";
import { applyMigrations, createTestRuntime } from "./runtime.js";
import { DomainError, RestaurantService } from "../src/domain/service.js";
import type {
	ActionInputs,
	CommandResult,
	ExportResult,
	GuestMenu,
	GuestSession,
	GuestStatus,
	Info,
	Payment,
	Workspace,
} from "../src/domain/types.js";

let mf: Miniflare;
let db: D1Database;
let admin: RestaurantService;
let guest: RestaurantService;
let branchId: string;
let tableId: string;
let menuId: string;
let session: GuestSession;
const issuer = {
	name: "Synthetic Restaurant",
	taxCode: "TEST-TAX",
	address: "Test Address",
	providerAccountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	templateCode: "1",
	series: "C26TST",
};
const buyer = { name: "Synthetic Buyer", taxCode: "", address: "", email: "" };
const menuFields = {
	name: "Phở",
	category: "Món chính",
	description: "Nấu trong ngày",
	image: "",
	price: 50000,
	taxRate: 800,
	available: true,
	modifiers: [{ id: "extra", name: "Thêm thịt", price: 10000 }],
};

async function command<A extends keyof ActionInputs>(
	service: RestaurantService,
	action: A,
	input: Omit<ActionInputs[A], "commandId">,
): Promise<CommandResult> {
	return (await service.execute(action, {
		...input,
		commandId: crypto.randomUUID(),
	})) as CommandResult;
}
async function workspace(service = admin): Promise<Workspace> {
	return (await service.execute("workspace", { branchId })) as Workspace;
}
async function submit(quantity = 2): Promise<CommandResult> {
	const status = (await guest.execute("guest-status", { token: session.token })) as GuestStatus;
	return command(guest, "submit-order", {
		token: session.token,
		expectedVersion: status.visit.version,
		note: "Không hành",
		lines: [{ menuItemId: menuId, quantity, modifierIds: ["extra"] }],
	});
}
async function serve(quantity = 2): Promise<CommandResult> {
	const order = await submit(quantity);
	await command(admin, "confirm-order", { branchId, id: order.id, expectedVersion: order.version });
	const line = (await workspace()).orders.find((candidate) => candidate.id === order.id)!.lines[0]!;
	await command(admin, "kitchen-transition", {
		branchId,
		id: line.id,
		expectedVersion: 1,
		status: "preparing",
	});
	await command(admin, "kitchen-transition", {
		branchId,
		id: line.id,
		expectedVersion: 2,
		status: "ready",
	});
	await command(admin, "kitchen-transition", {
		branchId,
		id: line.id,
		expectedVersion: 3,
		status: "served",
	});
	return order;
}
async function bill(quantity = 2): Promise<Payment> {
	await serve(quantity);
	const visit = (await workspace()).visits.find((candidate) => candidate.id === session.visit.id)!;
	return (await admin.execute("create-payment", {
		branchId,
		id: visit.id,
		expectedVersion: visit.version,
		commandId: crypto.randomUUID(),
	})) as Payment;
}

beforeEach(async () => {
	mf = createTestRuntime("RESTAURANT_DB");
	db = await mf.getD1Database("RESTAURANT_DB");
	await applyMigrations(db);
	admin = new RestaurantService(db, { id: "admin", administrator: true });
	guest = new RestaurantService(db, null);
	branchId = (
		await command(admin, "save-branch", {
			name: "Quận 1",
			bankAccount: "000000001",
			bankCode: "TESTBANK",
			bankName: "TestBank",
			credentialContext: "test-context",
			environment: "sandbox",
			issuer,
		})
	).id;
	tableId = (await command(admin, "save-table", { branchId, name: "Bàn 01" })).id;
	menuId = (await command(admin, "save-menu-item", { branchId, ...menuFields })).id;
	await command(admin, "open-visit", { branchId, tableId, expectedVersion: 1 });
	const table = (await workspace()).tables[0]!;
	session = (await guest.execute("join-table", {
		tableToken: table.token,
		commandId: crypto.randomUUID(),
	})) as GuestSession;
});
afterEach(async () => {
	await mf.dispose();
});

describe("D1 restaurant domain", () => {
	it("applies the migration repeatedly without losing records", async () => {
		await applyMigrations(db);
		assert.equal((await workspace()).tables[0]!.id, tableId);
	});

	it("rejects unauthenticated staff calls, cross-branch access and revoked memberships", async () => {
		await assert.rejects(guest.execute("workspace", { branchId }), { code: "UNAUTHENTICATED" });
		await command(admin, "save-member", { branchId, userId: "floor-user", role: "floor" });
		const staff = new RestaurantService(db, { id: "floor-user", administrator: false });
		assert.equal((await workspace(staff)).role, "floor");
		await assert.rejects(staff.execute("workspace", { branchId: "other-branch" }), {
			code: "FORBIDDEN",
		});
		await assert.rejects(command(staff, "save-menu-item", { branchId, ...menuFields }), {
			code: "FORBIDDEN",
		});
		await command(admin, "save-member", {
			branchId,
			userId: "floor-user",
			role: "floor",
			active: false,
			expectedVersion: 1,
		});
		await assert.rejects(staff.execute("workspace", { branchId }), { code: "FORBIDDEN" });
		assert.deepEqual(((await staff.execute("info", {})) as Info).branches, []);
	});

	it("returns stored results for identical guest commands and rejects changed payloads", async () => {
		const input = {
			commandId: crypto.randomUUID(),
			token: session.token,
			expectedVersion: 1,
			note: "",
			lines: [{ menuItemId: menuId, quantity: 1, modifierIds: [] }],
		};
		const results = await Promise.all([
			guest.execute("submit-order", input),
			guest.execute("submit-order", input),
		]);
		assert.deepEqual(results[0], results[1]);
		assert.equal((await workspace()).orders.length, 1);
		await assert.rejects(guest.execute("submit-order", { ...input, note: "changed" }), {
			code: "IDEMPOTENCY_CONFLICT",
		});
	});

	it("fences cross-branch menu identifiers even for valid guest sessions", async () => {
		const other = (
			await command(admin, "save-branch", {
				name: "Quận 2",
				bankAccount: "000000002",
				bankCode: "TESTBANK",
				bankName: "TestBank",
				credentialContext: "test-context",
				environment: "sandbox",
				issuer,
			})
		).id;
		const foreignMenu = await command(admin, "save-menu-item", { branchId: other, ...menuFields });
		await assert.rejects(
			command(guest, "submit-order", {
				token: session.token,
				expectedVersion: 1,
				note: "",
				lines: [{ menuItemId: foreignMenu.id, quantity: 1, modifierIds: [] }],
			}),
			{ code: "NOT_FOUND" },
		);
		assert.equal((await workspace()).orders.length, 0);
	});

	it("rolls back dependent writes and the command receipt after a zero-row revision update", async () => {
		const input = {
			commandId: crypto.randomUUID(),
			token: session.token,
			expectedVersion: 999,
			note: "",
			lines: [{ menuItemId: menuId, quantity: 1, modifierIds: [] }],
		};
		await assert.rejects(guest.execute("submit-order", input), { code: "CONFLICT" });
		assert.equal((await workspace()).orders.length, 0);
		assert.equal(
			await db.prepare("SELECT COUNT(*) AS count FROM rc_order_lines").first("count"),
			0,
		);
		assert.equal(
			await db
				.prepare("SELECT COUNT(*) AS count FROM rc_commands WHERE id=?")
				.bind(input.commandId)
				.first("count"),
			0,
		);
		assert.equal(
			await db
				.prepare("SELECT COUNT(*) AS count FROM rc_audit WHERE action='submit-order'")
				.first("count"),
			0,
		);
		assert.equal((await workspace()).visits[0]!.version, 1);
	});

	it("allows exactly one competing confirmation and no pending kitchen work", async () => {
		await command(admin, "save-member", { branchId, userId: "cook", role: "kitchen" });
		const cook = new RestaurantService(db, { id: "cook", administrator: false });
		const order = await submit();
		assert.equal((await workspace(cook)).orders.length, 0);
		const results = await Promise.allSettled([
			command(admin, "confirm-order", { branchId, id: order.id, expectedVersion: 1 }),
			command(admin, "confirm-order", { branchId, id: order.id, expectedVersion: 1 }),
		]);
		assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
		assert.equal((await workspace(cook)).orders.length, 1);
		assert.equal((await workspace()).visits[0]!.version, 3);
	});

	it("preserves commercial snapshots when menu prices change and retains void reasons", async () => {
		const order = await submit();
		await command(admin, "save-menu-item", {
			branchId,
			id: menuId,
			expectedVersion: 1,
			...menuFields,
			price: 90000,
			modifiers: [],
		});
		await command(admin, "confirm-order", { branchId, id: order.id, expectedVersion: 1 });
		let snapshot = (await workspace()).orders[0]!;
		assert.equal(snapshot.total, 120000);
		assert.equal(snapshot.lines[0]!.unitPrice, 60000);
		assert.equal(snapshot.lines[0]!.taxAmount, 8889);
		await command(admin, "void-order", {
			branchId,
			id: order.id,
			expectedVersion: 2,
			reason: "Khách đổi món",
		});
		snapshot = (await workspace()).orders[0]!;
		assert.equal(snapshot.status, "voided");
		assert.equal(snapshot.reason, "Khách đổi món");
		assert.equal(snapshot.total, 120000);
	});

	it("denies closed or expired guest tokens, including after another visit opens", async () => {
		await command(admin, "close-visit", { branchId, id: session.visit.id, expectedVersion: 1 });
		await command(admin, "clean-table", { branchId, tableId, expectedVersion: 3 });
		await command(admin, "open-visit", { branchId, tableId, expectedVersion: 4 });
		await assert.rejects(guest.execute("menu", { token: session.token }), {
			code: "SESSION_CLOSED",
		});
		const table = (await workspace()).tables[0]!;
		const fresh = (await guest.execute("join-table", {
			tableToken: table.token,
			commandId: crypto.randomUUID(),
		})) as GuestSession;
		assert.notEqual(fresh.token, session.token);
		await db.prepare("UPDATE rc_visits SET expires_at=0 WHERE id=?").bind(fresh.visit.id).run();
		await assert.rejects(guest.execute("guest-status", { token: fresh.token }), {
			code: "SESSION_CLOSED",
		});
	});

	it("never includes bank configuration or secret contexts in the public menu", async () => {
		const menu = (await guest.execute("menu", { token: session.token })) as GuestMenu;
		assert.equal(menu.items[0]!.price, 50000);
		const json = JSON.stringify(menu);
		assert.equal(json.includes("000000001"), false);
		assert.equal(json.includes("test-context"), false);
		assert.equal(json.includes("providerAccountId"), false);
		await assert.rejects(guest.execute("menu", { token: (await workspace()).tables[0]!.token }), {
			code: "SESSION_CLOSED",
		});
	});

	it("requires settled preparation before freezing and preserves superseded QR attempts", async () => {
		const order = await submit();
		await assert.rejects(
			command(admin, "create-payment", { branchId, id: session.visit.id, expectedVersion: 2 }),
			{ code: "EMPTY_BILL" },
		);
		await command(admin, "confirm-order", { branchId, id: order.id, expectedVersion: 1 });
		await assert.rejects(
			command(admin, "create-payment", { branchId, id: session.visit.id, expectedVersion: 3 }),
			{ code: "CONFLICT" },
		);
		const line = (await workspace()).orders[0]!.lines[0]!;
		for (const [index, status] of (["preparing", "ready", "served"] as const).entries())
			await command(admin, "kitchen-transition", {
				branchId,
				id: line.id,
				expectedVersion: index + 1,
				status,
			});
		const first = (await admin.execute("create-payment", {
			commandId: crypto.randomUUID(),
			branchId,
			id: session.visit.id,
			expectedVersion: 6,
		})) as Payment;
		const second = (await admin.execute("create-payment", {
			commandId: crypto.randomUUID(),
			branchId,
			id: session.visit.id,
			expectedVersion: 7,
		})) as Payment;
		assert.equal(first.amount, 120000);
		assert.notEqual(first.reference, second.reference);
		assert.match(first.qrUrl, /acc=000000001/);
		const transferContent = new URL(first.qrUrl).searchParams.get("des")!;
		assert.equal(
			/\bRC[A-Z0-9]{1,30}\b/.exec(transferContent)?.[0],
			first.reference,
			"SePay must recognize the entire payment code within its 30-character suffix limit",
		);
		assert.equal(
			(await workspace()).payments.find((payment) => payment.id === first.id)!.status,
			"superseded",
		);
		await assert.rejects(
			command(guest, "submit-order", {
				token: session.token,
				expectedVersion: 8,
				note: "",
				lines: [{ menuItemId: menuId, quantity: 1, modifierIds: [] }],
			}),
			{ code: "CONFLICT" },
		);
	});

	it("stores invoice intent, exact payload and job atomically and fences issue/correction", async () => {
		const payment = await bill();
		await assert.rejects(
			command(admin, "request-invoice", { branchId, paymentId: payment.id, buyer }),
			{ code: "NOT_FOUND" },
		);
		await db.batch([
			db
				.prepare("UPDATE rc_payment_attempts SET status='paid',paid_at=? WHERE id=?")
				.bind(Date.now(), payment.id),
			db
				.prepare("UPDATE rc_visits SET status='paid',version=version+1 WHERE id=?")
				.bind(session.visit.id),
		]);
		const input = { commandId: crypto.randomUUID(), branchId, paymentId: payment.id, buyer };
		const invoice = (await admin.execute("request-invoice", input)) as CommandResult;
		assert.deepEqual(await admin.execute("request-invoice", input), invoice);
		const row = await db
			.prepare("SELECT payload_json FROM rc_invoices WHERE id=?")
			.bind(invoice.id)
			.first<{ payload_json: string }>();
		const payload = JSON.parse(row!.payload_json) as {
			total_amount: number;
			reference_code: string;
			provider_account_id: string;
		};
		assert.equal(payload.total_amount, 120000);
		assert.equal(payload.provider_account_id, issuer.providerAccountId);
		assert.equal(
			await db
				.prepare("SELECT COUNT(*) AS count FROM rc_outbox WHERE id=?")
				.bind(invoice.jobId!)
				.first("count"),
			1,
		);
		await assert.rejects(
			command(admin, "issue-invoice", { branchId, id: invoice.id, expectedVersion: 1 }),
			{ code: "CONFLICT" },
		);
		await db.batch([
			db.prepare("UPDATE rc_outbox SET state='done' WHERE id=?").bind(invoice.jobId!),
			db
				.prepare(
					"UPDATE rc_invoices SET status='draft',create_tracking_code='remote-draft',version=2 WHERE id=?",
				)
				.bind(invoice.id),
		]);
		const issue = await command(admin, "issue-invoice", {
			branchId,
			id: invoice.id,
			expectedVersion: 2,
		});
		assert.equal(issue.version, 3);
		assert.equal(
			await db
				.prepare("SELECT issue_payload_json FROM rc_invoices WHERE id=?")
				.bind(invoice.id)
				.first("issue_payload_json"),
			JSON.stringify({ reference_code: payload.reference_code }),
		);
		await db.batch([
			db.prepare("UPDATE rc_outbox SET state='done' WHERE id=?").bind(issue.jobId!),
			db.prepare("UPDATE rc_invoices SET status='issued',version=4 WHERE id=?").bind(invoice.id),
		]);
		const correction = await command(admin, "correct-invoice", {
			branchId,
			id: invoice.id,
			expectedVersion: 4,
			kind: "adjustment",
			reason: "Giảm giá sau thanh toán",
			buyer,
			lines: [{ name: "Giảm giá", quantity: 1, unitPrice: -10000, taxRate: 800 }],
		});
		const corrected = await db
			.prepare("SELECT original_invoice_id,payload_json FROM rc_invoices WHERE id=?")
			.bind(correction.id)
			.first<{ original_invoice_id: string; payload_json: string }>();
		assert.equal(corrected!.original_invoice_id, invoice.id);
		const correctionPayload: unknown = JSON.parse(corrected!.payload_json);
		assert.ok(
			correctionPayload &&
				typeof correctionPayload === "object" &&
				"adjustment_type" in correctionPayload,
		);
		assert.equal(correctionPayload.adjustment_type, "decrease");
	});

	it("splits nondivisible invoice prices into exact integer VND without changing quantities or totals", async () => {
		const payment = await bill(3);
		await db
			.prepare("UPDATE rc_payment_attempts SET status='paid' WHERE id=?")
			.bind(payment.id)
			.run();
		const invoice = await command(admin, "request-invoice", {
			branchId,
			paymentId: payment.id,
			buyer,
		});
		const json = await db
			.prepare("SELECT payload_json FROM rc_invoices WHERE id=?")
			.bind(invoice.id)
			.first<string>("payload_json");
		const payload = JSON.parse(json!) as {
			total_amount: number;
			items: { quantity: number; unit_price: number; tax_amount: number }[];
		};
		assert.equal(payload.items.length, 2);
		assert.equal(
			payload.items.reduce((sum, item) => sum + item.quantity, 0),
			3,
		);
		assert.equal(
			payload.items.reduce((sum, item) => sum + item.tax_amount, 0),
			13333,
		);
		assert.equal(
			payload.items.reduce(
				(sum, item) => sum + item.quantity * item.unit_price + item.tax_amount,
				0,
			),
			180000,
		);
		assert.equal(payload.total_amount, 180000);
		assert.ok(
			payload.items.every(
				(item) => Number.isSafeInteger(item.unit_price) && Number.isSafeInteger(item.tax_amount),
			),
		);
	});

	it("preserves gross prices for template 2 and its issuer snapshot through replacement", async () => {
		const branchFields = {
			name: "Quận 1",
			bankAccount: "000000001",
			bankCode: "TESTBANK",
			bankName: "TestBank",
			credentialContext: "test-context",
			environment: "sandbox" as const,
		};
		const originalIssuer = {
			...issuer,
			templateCode: "2",
			sellerStoreXid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		};
		await command(admin, "save-branch", {
			...branchFields,
			id: branchId,
			expectedVersion: 1,
			issuer: originalIssuer,
		});
		const payment = await bill(3);
		await db
			.prepare("UPDATE rc_payment_attempts SET status='paid' WHERE id=?")
			.bind(payment.id)
			.run();
		const invoice = await command(admin, "request-invoice", {
			branchId,
			paymentId: payment.id,
			buyer,
		});
		const json = await db
			.prepare("SELECT payload_json FROM rc_invoices WHERE id=?")
			.bind(invoice.id)
			.first<string>("payload_json");
		const payload = JSON.parse(json!) as {
			total_amount: number;
			items: { quantity: number; unit_price: number; tax_amount: number }[];
		};
		assert.equal(payload.items.length, 1);
		assert.equal(payload.items[0]!.unit_price, 60000);
		assert.equal(payload.items[0]!.tax_amount, 0);
		assert.equal(payload.total_amount, 180000);
		await db.prepare("UPDATE rc_invoices SET status='issued' WHERE id=?").bind(invoice.id).run();
		await command(admin, "save-branch", {
			...branchFields,
			id: branchId,
			expectedVersion: 2,
			issuer: { ...issuer, providerAccountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
		});
		const replacement = await command(admin, "correct-invoice", {
			branchId,
			id: invoice.id,
			expectedVersion: 1,
			kind: "replacement",
			reason: "Sửa thông tin người mua",
			buyer,
			lines: [{ name: "Phở", quantity: 3, unitPrice: 60000, taxRate: 800 }],
		});
		const row = await db
			.prepare("SELECT payload_json,issuer_json FROM rc_invoices WHERE id=?")
			.bind(replacement.id)
			.first<{ payload_json: string; issuer_json: string }>();
		const replacementPayload = JSON.parse(row!.payload_json) as {
			provider_account_id: string;
			seller_store_xid: string;
			adjustment_type?: string;
			items: { unit_price: number; tax_amount: number }[];
		};
		assert.equal(replacementPayload.provider_account_id, issuer.providerAccountId);
		assert.equal(replacementPayload.seller_store_xid, originalIssuer.sellerStoreXid);
		assert.equal(replacementPayload.adjustment_type, undefined);
		assert.equal(replacementPayload.items[0]!.unit_price, 60000);
		assert.equal(replacementPayload.items[0]!.tax_amount, 0);
		assert.deepEqual(JSON.parse(row!.issuer_json), originalIssuer);
	});

	it("snapshots explicit VA and memo QR settings without guessing the receiving account", async () => {
		const fields = {
			name: "Quận 1",
			bankAccount: "000000001",
			bankCode: "TESTBANK",
			bankName: "TestBank",
			credentialContext: "test-context",
			environment: "sandbox" as const,
			issuer,
		};
		await command(admin, "save-branch", {
			...fields,
			id: branchId,
			expectedVersion: 1,
			qrMode: "virtual",
			subAccount: "VA001",
			transferPrefix: "SEVQR",
		});
		const first = await bill();
		const qr = new URL(first.qrUrl);
		assert.equal(qr.searchParams.get("acc"), "VA001");
		assert.equal(qr.searchParams.get("des"), `SEVQR ${first.reference}`);
		await command(admin, "save-branch", {
			...fields,
			id: branchId,
			expectedVersion: 2,
			qrMode: "memo",
			subAccount: "VA002",
		});
		const visit = (await workspace()).visits[0]!;
		const second = (await admin.execute("create-payment", {
			branchId,
			id: visit.id,
			expectedVersion: visit.version,
			commandId: crypto.randomUUID(),
		})) as Payment;
		const memo = new URL(second.qrUrl);
		assert.equal(memo.searchParams.get("acc"), "000000001");
		assert.equal(memo.searchParams.get("des"), `TKPVA002 ${second.reference}`);
		const oldPayment = (await workspace()).payments.find((payment) => payment.id === first.id)!;
		assert.equal(oldPayment.subAccount, "VA001");
		assert.equal(oldPayment.qrMode, "virtual");
	});

	it("resumes reviewed pre-dispatch creation without changing intent and never resends dispatch evidence", async () => {
		const payment = await bill();
		await db
			.prepare("UPDATE rc_payment_attempts SET status='paid' WHERE id=?")
			.bind(payment.id)
			.run();
		const invoice = await command(admin, "request-invoice", {
			branchId,
			paymentId: payment.id,
			buyer,
		});
		const original = await db
			.prepare("SELECT reference,payload_json FROM rc_invoices WHERE id=?")
			.bind(invoice.id)
			.first<{ reference: string; payload_json: string }>();
		await db
			.prepare("UPDATE rc_outbox SET state='review',last_error='PROVIDER_AUTHORIZATION' WHERE id=?")
			.bind(invoice.jobId!)
			.run();
		const input = { commandId: crypto.randomUUID(), branchId, id: invoice.id, expectedVersion: 1 };
		const retry = (await admin.execute("reconcile-invoice", input)) as CommandResult;
		assert.deepEqual(await admin.execute("reconcile-invoice", input), retry);
		assert.equal(
			await db.prepare("SELECT kind FROM rc_outbox WHERE id=?").bind(retry.jobId!).first("kind"),
			"invoice.create",
		);
		assert.deepEqual(
			await db
				.prepare("SELECT reference,payload_json FROM rc_invoices WHERE id=?")
				.bind(invoice.id)
				.first(),
			original,
		);
		await assert.rejects(
			command(admin, "reconcile-invoice", { branchId, id: invoice.id, expectedVersion: 2 }),
			{ code: "CONFLICT" },
		);
		await db.batch([
			db.prepare("UPDATE rc_outbox SET state='review' WHERE id=?").bind(retry.jobId!),
			db
				.prepare("UPDATE rc_invoices SET dispatch_at=?,dispatch_token='dispatched' WHERE id=?")
				.bind(Date.now(), invoice.id),
		]);
		await assert.rejects(
			command(admin, "reconcile-invoice", { branchId, id: invoice.id, expectedVersion: 2 }),
			{ code: "CONFLICT" },
		);
		await db
			.prepare("UPDATE rc_invoices SET status='outcome_unknown',version=3 WHERE id=?")
			.bind(invoice.id)
			.run();
		const reconcile = await command(admin, "reconcile-invoice", {
			branchId,
			id: invoice.id,
			expectedVersion: 3,
		});
		assert.equal(
			await db
				.prepare("SELECT kind FROM rc_outbox WHERE id=?")
				.bind(reconcile.jobId!)
				.first("kind"),
			"invoice.reconcile",
		);
		const jobs = (await workspace()).jobs;
		assert.ok(jobs.some((job) => job.invoiceId === invoice.id && job.state === "review"));
	});

	it("resumes an undispatched reviewed issue while retaining the confirmed create tracking code", async () => {
		const payment = await bill();
		await db
			.prepare("UPDATE rc_payment_attempts SET status='paid' WHERE id=?")
			.bind(payment.id)
			.run();
		const invoice = await command(admin, "request-invoice", {
			branchId,
			paymentId: payment.id,
			buyer,
		});
		await db.batch([
			db.prepare("UPDATE rc_outbox SET state='done' WHERE id=?").bind(invoice.jobId!),
			db
				.prepare(
					"UPDATE rc_invoices SET status='draft',create_tracking_code='created',dispatch_at=?,dispatch_token='create-dispatch',last_operation='create' WHERE id=?",
				)
				.bind(Date.now(), invoice.id),
		]);
		const issue = await command(admin, "issue-invoice", {
			branchId,
			id: invoice.id,
			expectedVersion: 1,
		});
		const before = await db
			.prepare(
				"SELECT issue_payload_json,create_tracking_code,dispatch_at,dispatch_token FROM rc_invoices WHERE id=?",
			)
			.bind(invoice.id)
			.first<{
				issue_payload_json: string;
				create_tracking_code: string;
				dispatch_at: number | null;
				dispatch_token: string | null;
			}>();
		assert.equal(before!.dispatch_at, null);
		assert.equal(before!.dispatch_token, null);
		assert.equal(before!.create_tracking_code, "created");
		await db
			.prepare("UPDATE rc_outbox SET state='review',last_error='PROVIDER_AUTHORIZATION' WHERE id=?")
			.bind(issue.jobId!)
			.run();
		const retry = await command(admin, "reconcile-invoice", {
			branchId,
			id: invoice.id,
			expectedVersion: 2,
		});
		assert.equal(
			await db.prepare("SELECT kind FROM rc_outbox WHERE id=?").bind(retry.jobId!).first("kind"),
			"invoice.issue",
		);
		assert.deepEqual(
			await db
				.prepare(
					"SELECT issue_payload_json,create_tracking_code,dispatch_at,dispatch_token FROM rc_invoices WHERE id=?",
				)
				.bind(invoice.id)
				.first(),
			before,
		);
	});

	it("bounds and scopes CSV exports with business dates and formula protection", async () => {
		await command(admin, "save-menu-item", {
			branchId,
			id: menuId,
			expectedVersion: 1,
			...menuFields,
			name: '=IMPORTXML("https://invalid")',
		});
		await serve();
		const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
		const result = (await admin.execute("export", {
			branchId,
			kind: "sales",
			from: today,
			to: today,
		})) as ExportResult;
		assert.match(result.csv, /business_date/);
		assert.match(result.csv, /'=IMPORTXML/);
		assert.match(result.csv, /120000/);
		await assert.rejects(
			admin.execute("export", { branchId, kind: "sales", from: "2026-01-01", to: "2026-12-31" }),
			{ code: "VALIDATION_ERROR" },
		);
	});

	it("rejects unsupported taxes, unsafe VND, duplicate modifiers and unknown fields", async () => {
		for (const invalid of [
			{ price: 0.1 },
			{ price: Number.MAX_SAFE_INTEGER + 1 },
			{ taxRate: 750 },
			{ modifiers: [menuFields.modifiers[0]!, menuFields.modifiers[0]!] },
			{ injected: true },
		]) {
			await assert.rejects(
				command(admin, "save-menu-item", { branchId, ...menuFields, ...invalid }),
				(error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR",
			);
		}
	});

	it("keeps bank mismatches and API identity reviews visible only to the receiving branch", async () => {
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					"INSERT INTO rc_payment_inbox(id,environment,credential_context,provider_transaction_id,payload_json,state,exception,created_at) VALUES ('receipt-review','sandbox','test-context','123',?,'review','UNKNOWN_REFERENCE',?)",
				)
				.bind(
					JSON.stringify({ accountNumber: "000000001", gateway: "TestBank", subAccount: "" }),
					now,
				),
			db
				.prepare(
					"INSERT INTO rc_payment_inbox(id,environment,credential_context,provider_transaction_id,payload_json,state,exception,created_at) VALUES ('receipt-other','sandbox','test-context','456',?,'review','UNKNOWN_REFERENCE',?)",
				)
				.bind(
					JSON.stringify({ accountNumber: "000000099", gateway: "TestBank", subAccount: "" }),
					now,
				),
			db
				.prepare(
					"INSERT INTO rc_bank_reconciliation(id,environment,credential_context,provider_transaction_id,payload_json,state,created_at) VALUES ('bank-review','sandbox','test-context','bank-uuid',?,'identity_review',?)",
				)
				.bind(
					JSON.stringify({ account_number: "000000001", bank_brand_name: "TestBank", va: "" }),
					now,
				),
		]);
		assert.deepEqual(
			(await workspace()).exceptions.map((exception) => exception.id),
			["bank-review", "receipt-review"],
		);
		await command(admin, "save-member", { branchId, userId: "floor-user", role: "floor" });
		const floor = new RestaurantService(db, { id: "floor-user", administrator: false });
		assert.deepEqual((await workspace(floor)).exceptions, []);
	});

	it("denies floor preparation, skipped kitchen states and financial cross-branch reads", async () => {
		await command(admin, "save-member", { branchId, userId: "floor-user", role: "floor" });
		const floor = new RestaurantService(db, { id: "floor-user", administrator: false });
		const order = await submit();
		await command(floor, "confirm-order", { branchId, id: order.id, expectedVersion: 1 });
		const line = (await workspace()).orders[0]!.lines[0]!;
		await assert.rejects(
			command(floor, "kitchen-transition", {
				branchId,
				id: line.id,
				expectedVersion: 1,
				status: "preparing",
			}),
			{ code: "FORBIDDEN" },
		);
		await assert.rejects(
			command(admin, "kitchen-transition", {
				branchId,
				id: line.id,
				expectedVersion: 1,
				status: "ready",
			}),
			{ code: "CONFLICT" },
		);
		assert.equal((await workspace()).visits[0]!.version, 3);
		await assert.rejects(floor.execute("invoice-file", { branchId, id: "invoice", type: "pdf" }), {
			code: "FORBIDDEN",
		});
		await assert.rejects(
			floor.execute("export", {
				branchId: "another-branch",
				kind: "audit",
				from: "2026-10-10",
				to: "2026-10-10",
			}),
			{ code: "FORBIDDEN" },
		);
	});

	it("returns authoritative visit totals and blockers when order details span pages", async () => {
		for (let index = 0; index < 2; index++) {
			const order = await submit();
			await command(admin, "confirm-order", { branchId, id: order.id, expectedVersion: 1 });
		}
		await submit();
		let cursor: string | undefined;
		let summary: Workspace["visits"][number] | undefined;
		do {
			const page = (await admin.execute("workspace", {
				branchId,
				limit: 1,
				...(cursor ? { cursor } : {}),
			})) as Workspace;
			assert.ok(page.orders.length <= 1);
			summary ??= page.visits.find((visit) => visit.id === session.visit.id);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		assert.ok(summary);
		assert.equal(summary.total, 240000);
		assert.equal(summary.pendingCount, 1);
		assert.equal(summary.unsettledCount, 2);
	});

	it("paginates workspace without skipping identifiers across resource types", async () => {
		for (let index = 0; index < 4; index++)
			await command(admin, "save-table", { branchId, name: `Bàn ${index + 2}` });
		const ids: string[] = [];
		let cursor: string | undefined;
		do {
			const page = (await admin.execute("workspace", {
				branchId,
				limit: 2,
				...(cursor ? { cursor } : {}),
			})) as Workspace;
			ids.push(...page.tables.map((table) => table.id));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		assert.equal(ids.length, 5);
		assert.equal(new Set(ids).size, 5);
	});
	it("resumes reviewed invoice polling without resubmitting the external mutation", async () => {
		const payment = await bill();
		await db
			.prepare("UPDATE rc_payment_attempts SET status='paid' WHERE id=?")
			.bind(payment.id)
			.run();
		const invoice = await command(admin, "request-invoice", {
			branchId,
			paymentId: payment.id,
			buyer,
		});
		await db.batch([
			db
				.prepare(
					"UPDATE rc_invoices SET status='pending',last_operation='create',create_tracking_code='tracking-known' WHERE id=?",
				)
				.bind(invoice.id),
			db
				.prepare("UPDATE rc_outbox SET state='review',last_error='PROVIDER_UNAVAILABLE' WHERE id=?")
				.bind(invoice.jobId!),
		]);
		const recovered = await command(admin, "reconcile-invoice", {
			branchId,
			id: invoice.id,
			expectedVersion: invoice.version,
		});
		assert.deepEqual(
			await db.prepare("SELECT kind FROM rc_outbox WHERE id=?").bind(recovered.jobId!).first(),
			{ kind: "invoice.poll" },
		);
		assert.deepEqual(
			await db
				.prepare("SELECT status,create_tracking_code FROM rc_invoices WHERE id=?")
				.bind(invoice.id)
				.first(),
			{ status: "pending", create_tracking_code: "tracking-known" },
		);
	});

	it("accepts generated payment exception cursors on subsequent workspace pages", async () => {
		for (const suffix of ["100", "101"]) {
			await db
				.prepare(
					"INSERT INTO rc_payment_inbox(id,environment,credential_context,provider_transaction_id,payload_json,state,exception,created_at) VALUES (?,'sandbox','test-context',?,?,'review','UNKNOWN_REFERENCE',?)",
				)
				.bind(
					`sandbox:test-context:${suffix}`,
					suffix,
					JSON.stringify({ accountNumber: "000000001", gateway: "TestBank", subAccount: "" }),
					Date.now(),
				)
				.run();
		}
		const found: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			assert.ok(pages++ < 20, "workspace pagination must advance");
			const page = (await admin.execute("workspace", {
				branchId,
				limit: 1,
				...(cursor ? { cursor } : {}),
			})) as Workspace;
			found.push(...page.exceptions.map((entry) => entry.id));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		assert.deepEqual(found, ["sandbox:test-context:100", "sandbox:test-context:101"]);
	});
	it("allows issuing a remotely recovered draft without inventing a lost create tracking code", async () => {
		const payment = await bill();
		await db
			.prepare("UPDATE rc_payment_attempts SET status='paid' WHERE id=?")
			.bind(payment.id)
			.run();
		const invoice = await command(admin, "request-invoice", {
			branchId,
			paymentId: payment.id,
			buyer,
		});
		const row = await db
			.prepare("SELECT reference FROM rc_invoices WHERE id=?")
			.bind(invoice.id)
			.first<{ reference: string }>();
		await db.batch([
			db
				.prepare("UPDATE rc_invoices SET status='draft',provider_json=? WHERE id=?")
				.bind(JSON.stringify({ reference_code: row!.reference, status: "draft" }), invoice.id),
			db.prepare("UPDATE rc_outbox SET state='done' WHERE id=?").bind(invoice.jobId!),
		]);
		const issue = await command(admin, "issue-invoice", {
			branchId,
			id: invoice.id,
			expectedVersion: 1,
		});
		assert.deepEqual(
			await db
				.prepare("SELECT status,create_tracking_code FROM rc_invoices WHERE id=?")
				.bind(invoice.id)
				.first(),
			{ status: "queued", create_tracking_code: null },
		);
		assert.deepEqual(
			await db.prepare("SELECT kind FROM rc_outbox WHERE id=?").bind(issue.jobId!).first(),
			{ kind: "invoice.issue" },
		);
	});

	it("retains historical receiving-account exceptions after branch settlement configuration changes", async () => {
		await bill();
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					"INSERT INTO rc_payment_inbox(id,environment,credential_context,provider_transaction_id,payload_json,state,exception,created_at) VALUES ('historical-receipt','sandbox','test-context','999',?,'review','UNKNOWN_REFERENCE',?)",
				)
				.bind(
					JSON.stringify({ accountNumber: "000000001", gateway: "TestBank", subAccount: "" }),
					now,
				),
			db
				.prepare(
					"INSERT INTO rc_bank_reconciliation(id,environment,credential_context,provider_transaction_id,payload_json,state,created_at) VALUES ('historical-api','sandbox','test-context','bank-historical',?,'identity_review',?)",
				)
				.bind(
					JSON.stringify({ account_number: "000000001", bank_brand_name: "TestBank", va: "" }),
					now,
				),
		]);
		await command(admin, "save-branch", {
			id: branchId,
			expectedVersion: 1,
			name: "Quận 1",
			bankAccount: "000000099",
			bankCode: "TESTBANK",
			bankName: "TestBank",
			credentialContext: "new-context",
			environment: "sandbox",
			issuer,
		});
		assert.deepEqual(
			(await workspace()).exceptions.map((entry) => entry.id),
			["historical-api", "historical-receipt"],
		);
	});

	it("opens a shift, bills a table and reconciles counted cash on close", async () => {
		await command(admin, "open-shift", { branchId, openingFloat: 100000 });
		const opened = (await workspace()).shift!;
		assert.equal(opened.status, "open");
		assert.equal(opened.openingFloat, 100000);
		await assert.rejects(command(admin, "open-shift", { branchId, openingFloat: 0 }), {
			code: "CONFLICT",
		});
		await serve(2);
		let visit = (await workspace()).visits.find((entry) => entry.id === session.visit.id)!;
		const bill = await command(admin, "freeze-bill", {
			branchId,
			id: visit.id,
			expectedVersion: visit.version,
		});
		visit = (await workspace()).visits.find((entry) => entry.id === session.visit.id)!;
		assert.equal(visit.status, "billing");
		const frozen = (await workspace()).bills.find((entry) => entry.id === bill.id)!;
		assert.equal(frozen.status, "open");
		assert.equal(frozen.total, 120000);
		assert.equal(frozen.shiftId, opened.id);
		assert.equal(frozen.lines[0]!.name, "Phở");
		await assert.rejects(
			command(admin, "settle-bill", {
				branchId,
				id: bill.id,
				expectedVersion: 2,
				method: "cash",
				reference: "",
			}),
			{ code: "CONFLICT" },
		);
		await command(admin, "settle-bill", {
			branchId,
			id: bill.id,
			expectedVersion: 1,
			method: "cash",
			reference: "",
		});
		const settled = (await workspace()).bills.find((entry) => entry.id === bill.id)!;
		assert.equal(settled.status, "settled");
		assert.equal(settled.method, "cash");
		assert.equal(
			(await workspace()).visits.find((entry) => entry.id === session.visit.id)!.status,
			"paid",
		);
		const shift = (await workspace()).shift!;
		const closed = (await command(admin, "close-shift", {
			branchId,
			id: shift.id,
			expectedVersion: shift.version,
			countedCash: 215000,
			note: "Thiếu 5.000",
		})) as unknown as { expectedCash: number; variance: number };
		assert.equal(closed.expectedCash, 220000);
		assert.equal(closed.variance, -5000);
		const history = (await workspace()).shifts.find((entry) => entry.id === shift.id)!;
		assert.equal(history.status, "closed");
		assert.equal(history.countedCash, 215000);
		assert.equal((await workspace()).shift, null);
	});

	it("requires an open shift for cash and settles a later round as a new bill", async () => {
		await serve(1);
		let visit = (await workspace()).visits.find((entry) => entry.id === session.visit.id)!;
		const first = await command(admin, "freeze-bill", {
			branchId,
			id: visit.id,
			expectedVersion: visit.version,
		});
		await assert.rejects(
			command(admin, "settle-bill", {
				branchId,
				id: first.id,
				expectedVersion: 1,
				method: "cash",
				reference: "",
			}),
			{ code: "SHIFT_REQUIRED" },
		);
		await command(admin, "settle-bill", {
			branchId,
			id: first.id,
			expectedVersion: 1,
			method: "bank_transfer",
			reference: "FT-123",
		});
		const firstBill = (await workspace()).bills.find((entry) => entry.id === first.id)!;
		assert.equal(firstBill.shiftId, null);
		assert.equal(firstBill.reference, "FT-123");
		assert.equal(
			(await workspace()).visits.find((entry) => entry.id === session.visit.id)!.status,
			"paid",
		);
		const extra = await submit(1);
		assert.equal(
			(await workspace()).visits.find((entry) => entry.id === session.visit.id)!.status,
			"open",
		);
		await command(admin, "confirm-order", { branchId, id: extra.id, expectedVersion: 1 });
		const line = (await workspace()).orders.find((entry) => entry.id === extra.id)!.lines[0]!;
		for (const [index, status] of (["preparing", "ready", "served"] as const).entries())
			await command(admin, "kitchen-transition", {
				branchId,
				id: line.id,
				expectedVersion: index + 1,
				status,
			});
		visit = (await workspace()).visits.find((entry) => entry.id === session.visit.id)!;
		const second = await command(admin, "freeze-bill", {
			branchId,
			id: visit.id,
			expectedVersion: visit.version,
		});
		assert.notEqual(second.id, first.id);
		const secondBill = (await workspace()).bills.find((entry) => entry.id === second.id)!;
		assert.equal(secondBill.status, "open");
		assert.equal(secondBill.total, 60000);
		assert.equal((await workspace()).bills.find((entry) => entry.id === first.id)!.method, "bank_transfer");
	});

	it("locks billed orders against voiding and refuses to freeze unresolved work", async () => {
		const pending = await submit(1);
		let visit = (await workspace()).visits.find((entry) => entry.id === session.visit.id)!;
		await assert.rejects(
			command(admin, "freeze-bill", { branchId, id: visit.id, expectedVersion: visit.version }),
			{ code: "PENDING_ORDERS" },
		);
		await command(admin, "open-shift", { branchId, openingFloat: 0 });
		await command(admin, "confirm-order", {
			branchId,
			id: pending.id,
			expectedVersion: 1,
		});
		visit = (await workspace()).visits.find((entry) => entry.id === session.visit.id)!;
		await assert.rejects(
			command(admin, "freeze-bill", { branchId, id: visit.id, expectedVersion: visit.version }),
			{ code: "UNSERVED_DISHES" },
		);
		const line = (await workspace()).orders.find((entry) => entry.id === pending.id)!.lines[0]!;
		for (const [index, status] of (["preparing", "ready", "served"] as const).entries())
			await command(admin, "kitchen-transition", {
				branchId,
				id: line.id,
				expectedVersion: index + 1,
				status,
			});
		visit = (await workspace()).visits.find((entry) => entry.id === session.visit.id)!;
		const frozen = await command(admin, "freeze-bill", {
			branchId,
			id: visit.id,
			expectedVersion: visit.version,
		});
		await command(admin, "settle-bill", {
			branchId,
			id: frozen.id,
			expectedVersion: 1,
			method: "cash",
			reference: "",
		});
		await submit(1);
		const billed = (await workspace()).orders.find((entry) => entry.id === pending.id)!;
		assert.equal(billed.billId, frozen.id);
		await assert.rejects(
			command(admin, "void-order", {
				branchId,
				id: pending.id,
				expectedVersion: billed.version,
				reason: "Thử hủy sau khi thu",
			}),
			{ code: "CONFLICT" },
		);
	});

	it("restricts shifts and manual billing to cashier or manager roles", async () => {
		await command(admin, "save-member", { branchId, userId: "floor-user", role: "floor" });
		const staff = new RestaurantService(db, { id: "floor-user", administrator: false });
		await assert.rejects(command(staff, "open-shift", { branchId, openingFloat: 0 }), {
			code: "FORBIDDEN",
		});
		await assert.rejects(
			command(staff, "freeze-bill", { branchId, id: session.visit.id, expectedVersion: 1 }),
			{ code: "FORBIDDEN" },
		);
	});

	it("records guest service requests, deduplicates them and lets staff handle them", async () => {
		const request = await command(guest, "call-service", {
			token: session.token,
			kind: "waiter",
			note: "",
		});
		await assert.rejects(
			command(guest, "call-service", { token: session.token, kind: "waiter", note: "" }),
			{ code: "ALREADY_REQUESTED" },
		);
		const status = (await guest.execute("guest-status", { token: session.token })) as GuestStatus;
		assert.equal(status.requests.length, 1);
		assert.equal(status.requests[0]!.kind, "waiter");
		assert.equal(
			(await workspace()).serviceRequests.filter((entry) => entry.status === "open").length,
			1,
		);
		await command(admin, "attend-request", { branchId, id: request.id, expectedVersion: 1 });
		assert.equal(
			(await workspace()).serviceRequests.filter((entry) => entry.status === "open").length,
			0,
		);
		const again = await command(guest, "call-service", {
			token: session.token,
			kind: "waiter",
			note: "",
		});
		assert.notEqual(again.id, request.id);
	});

	it("scopes guest requests to the visit and restricts handling to floor roles", async () => {
		const request = await command(guest, "call-service", {
			token: session.token,
			kind: "bill",
			note: "Xin hóa đơn",
		});
		await command(admin, "save-member", { branchId, userId: "cook", role: "kitchen" });
		const cook = new RestaurantService(db, { id: "cook", administrator: false });
		await assert.rejects(
			command(cook, "attend-request", { branchId, id: request.id, expectedVersion: 1 }),
			{ code: "FORBIDDEN" },
		);
		await assert.rejects(
			command(admin, "attend-request", {
				branchId,
				id: "other-branch-request",
				expectedVersion: 1,
			}),
			{ code: "NOT_FOUND" },
		);
	});

	it("requires cleaning a table before the next visit", async () => {
		await command(admin, "close-visit", { branchId, id: session.visit.id, expectedVersion: 1 });
		const dirty = (await workspace()).tables.find((entry) => entry.id === tableId)!;
		assert.equal(dirty.dirty, true);
		await assert.rejects(
			command(admin, "open-visit", { branchId, tableId, expectedVersion: dirty.version }),
			{ code: "CONFLICT" },
		);
		await command(admin, "clean-table", { branchId, tableId, expectedVersion: dirty.version });
		const clean = (await workspace()).tables.find((entry) => entry.id === tableId)!;
		assert.equal(clean.dirty, false);
		await command(admin, "open-visit", { branchId, tableId, expectedVersion: clean.version });
		assert.ok(
			(await workspace()).visits.some(
				(entry) => entry.tableId === tableId && entry.status === "open",
			),
		);
	});
});
