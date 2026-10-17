import { createHmac } from "node:crypto";
import type { D1Database, MessageBatch, Queue } from "@cloudflare/workers-types";
import type { Miniflare } from "miniflare";
import { applyMigrations, createTestRuntime } from "./runtime.js";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
	buildPaymentQr,
	parseCredentialContexts,
	receivePaymentWebhook,
	reconcileBankTransactions,
	downloadInvoice,
	type IntegrationOptions,
} from "../src/integrations/index.js";
import { InvoiceClient } from "../src/integrations/http.js";
import {
	claimJob,
	dispatchOutbox,
	finishJob,
	processJobs,
	recoverJobs,
} from "../src/jobs/index.js";

let mf: Miniflare;
let db: D1Database;
let now: number;
let options: IntegrationOptions;
const event = {
	id: 123,
	gateway: "ACB",
	transactionDate: "2026-10-10 10:00:00",
	accountNumber: "123456789",
	subAccount: "",
	code: "RCABC123",
	content: "RCABC123",
	transferType: "in",
	transferAmount: 108000,
	referenceCode: "BANK123",
};
const invoicePayload = {
	provider_account_id: "11111111-1111-4111-8111-111111111111",
	template_code: "1",
	invoice_series: "C26TSE",
	issued_date: "2026-10-10 10:00:00",
	currency: "VND",
	reference_code: "INV123",
	is_draft: true,
	buyer: { name: "Test buyer" },
	items: [
		{
			line_number: 1,
			line_type: 1,
			item_name: "Meal",
			quantity: 1,
			unit_price: 100000,
			tax_rate: 8,
			tax_amount: 8000,
		},
	],
	total_amount: 108000,
};

beforeEach(async () => {
	mf = createTestRuntime("RESTAURANT_DB");
	db = await mf.getD1Database("RESTAURANT_DB");
	await applyMigrations(db);
	now = Date.parse("2026-10-10T03:00:00Z");
	options = {
		db,
		now: () => now,
		contexts: {
			company: {
				environment: "sandbox",
				webhook: { mode: "hmac", secret: "test-webhook-secret-123456" },
				invoice: { clientId: "test-client", clientSecret: "test-secret" },
			},
		},
		fetch: async () => {
			throw new Error("Unexpected provider request");
		},
	};
	await db.batch([
		db
			.prepare(
				"INSERT INTO rc_branches (id,name,bank_account,bank_code,bank_name,credential_context,environment,issuer_json,created_at) VALUES ('branch','Test branch','123456789','ACB','ACB','company','sandbox','{}',?)",
			)
			.bind(now),
		db.prepare(
			"INSERT INTO rc_tables (id,branch_id,name,token) VALUES ('table','branch','T1','table-token')",
		),
		db
			.prepare(
				"INSERT INTO rc_visits (id,branch_id,table_id,status,expires_at,created_at) VALUES ('visit','branch','table','billing',?,?)",
			)
			.bind(now + 86400000, now),
		db
			.prepare(
				"INSERT INTO rc_payment_attempts (id,branch_id,visit_id,reference,amount,bank_account,bank_code,bank_name,credential_context,environment,status,created_at) VALUES ('payment','branch','visit','RCABC123',108000,'123456789','ACB','ACB','company','sandbox','pending',?)",
			)
			.bind(now),
	]);
});
afterEach(async () => {
	await mf.dispose();
});

function webhook(body: unknown = event, timestamp = Math.floor(now / 1000)): Request {
	const raw = JSON.stringify(body);
	const signature = createHmac("sha256", "test-webhook-secret-123456")
		.update(`${timestamp}.${raw}`)
		.digest("hex");
	return new Request("https://restaurant.test/webhooks/company", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-SePay-Timestamp": String(timestamp),
			"X-SePay-Signature": `sha256=${signature}`,
		},
		body: raw,
	});
}
async function deliver(id: string) {
	const ack = mock.fn();
	const retry = mock.fn();
	const batch: MessageBatch<{ id: string }> = {
		queue: "restaurant",
		metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
		messages: [
			{ id: crypto.randomUUID(), timestamp: new Date(now), body: { id }, attempts: 1, ack, retry },
		],
		ackAll: mock.fn(),
		retryAll: mock.fn(),
	};
	await processJobs(batch, options);
	return { ack, retry };
}
async function seedInvoice(kind = "original", payload: unknown = invoicePayload) {
	await db.batch([
		db
			.prepare(
				"INSERT INTO rc_invoices (id,branch_id,visit_id,payment_id,kind,status,reference,payload_json,credential_context,environment,created_at,updated_at) VALUES ('invoice','branch','visit','payment',?,'queued','INV123',?,'company','sandbox',?,?)",
			)
			.bind(kind, JSON.stringify(payload), now, now),
		db
			.prepare(
				"INSERT INTO rc_outbox (id,kind,payload_json,available_at,created_at,updated_at) VALUES ('invoice-job','invoice.create','{\"invoiceId\":\"invoice\"}',?,?,?)",
			)
			.bind(now, now, now),
	]);
}
function provider(
	handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
) {
	const calls: string[] = [];
	options.fetch = async (input, init) => {
		const url = new URL(String(input));
		calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
		if (url.pathname === "/v1/token") {
			assert.deepEqual(init?.headers, {
				Authorization: `Basic ${btoa("test-client:test-secret")}`,
			});
			return Response.json({
				success: true,
				data: { access_token: "controlled-token", token_type: "Bearer", expires_in: 86400 },
			});
		}
		return handler(url, init);
	};
	return calls;
}

describe("durable bank transfer ingestion", () => {
	it("authenticates exact bytes and persists receipt and outbox before acknowledging", async () => {
		const response = await receivePaymentWebhook(webhook(), "company", options);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { success: true });
		assert.deepEqual(await db.prepare("SELECT state FROM rc_payment_inbox").first(), {
			state: "pending",
		});
		assert.deepEqual(await db.prepare("SELECT kind,state FROM rc_outbox").first(), {
			kind: "payment.process",
			state: "pending",
		});
		assert.deepEqual(await db.prepare("SELECT status FROM rc_payment_attempts").first(), {
			status: "pending",
		});
		const tampered = webhook();
		tampered.headers.set("X-SePay-Signature", `sha256=${"0".repeat(64)}`);
		assert.equal((await receivePaymentWebhook(tampered, "company", options)).status, 401);
		assert.equal(
			(
				await receivePaymentWebhook(
					webhook(event, Math.floor(now / 1000) - 301),
					"company",
					options,
				)
			).status,
			401,
		);
	});
	it("deduplicates simultaneous receipts and delivery without hiding a distinct second transfer", async () => {
		await Promise.all([
			receivePaymentWebhook(webhook(), "company", options),
			receivePaymentWebhook(webhook(), "company", options),
		]);
		await Promise.all([
			deliver("payment:sandbox:company:123"),
			deliver("payment:sandbox:company:123"),
		]);
		assert.deepEqual(
			await db.prepare("SELECT count(*) AS count FROM rc_payment_allocations").first(),
			{ count: 1 },
		);
		assert.deepEqual(await db.prepare("SELECT status FROM rc_visits").first(), { status: "paid" });
		assert.deepEqual(
			await db
				.prepare("SELECT count(*) AS count FROM rc_audit WHERE action='payment.applied'")
				.first(),
			{ count: 1 },
		);
		await receivePaymentWebhook(webhook({ ...event, id: 124 }), "company", options);
		await deliver("payment:sandbox:company:124");
		assert.deepEqual(
			await db
				.prepare("SELECT exception FROM rc_payment_inbox WHERE provider_transaction_id='124'")
				.first(),
			{ exception: "DISTINCT_SECOND_TRANSFER" },
		);
	});
	for (const [change, exception] of [
		[{ accountNumber: "wrong-account" }, "ACCOUNT_MISMATCH"],
		[{ gateway: "BIDV" }, "ACCOUNT_MISMATCH"],
		[{ subAccount: "different-va" }, "ACCOUNT_MISMATCH"],
		[{ transferAmount: 107999 }, "UNDERPAYMENT"],
		[{ transferAmount: 108001 }, "OVERPAYMENT"],
		[{ transferType: "out" }, "OUTGOING_TRANSFER"],
		[{ code: null }, "REFERENCE_NOT_FOUND"],
	] as const) {
		it(`retains a nonmatching transfer as an exception (${exception}: ${JSON.stringify(change)})`, async () => {
			await receivePaymentWebhook(webhook({ ...event, ...change }), "company", options);
			await deliver("payment:sandbox:company:123");
			assert.deepEqual(await db.prepare("SELECT state,exception FROM rc_payment_inbox").first(), {
				state: "exception",
				exception,
			});
			assert.deepEqual(
				await db.prepare("SELECT count(*) AS count FROM rc_payment_allocations").first(),
				{ count: 0 },
			);
			assert.deepEqual(await db.prepare("SELECT status FROM rc_visits").first(), {
				status: "billing",
			});
		});
	}
	it("never allocates a late superseded QR transfer", async () => {
		await db.prepare("UPDATE rc_payment_attempts SET status='superseded'").run();
		await receivePaymentWebhook(webhook(), "company", options);
		await deliver("payment:sandbox:company:123");
		assert.deepEqual(await db.prepare("SELECT exception FROM rc_payment_inbox").first(), {
			exception: "SUPERSEDED_ATTEMPT",
		});
	});
	it("does not acknowledge when receipt persistence fails", async () => {
		await db.prepare("DROP TABLE rc_outbox").run();
		assert.equal((await receivePaymentWebhook(webhook(), "company", options)).status, 503);
		assert.deepEqual(await db.prepare("SELECT count(*) AS count FROM rc_payment_inbox").first(), {
			count: 0,
		});
	});
	it("generates QR only from the immutable account, reference and amount", () => {
		const url = new URL(
			buildPaymentQr({
				bank_account: "123456789",
				bank_code: "ACB",
				reference: "RCABC123",
				amount: 108000,
			}),
		);
		assert.deepEqual(Object.fromEntries(url.searchParams), {
			acc: "123456789",
			bank: "ACB",
			des: "RCABC123",
			amount: "108000",
			template: "compact",
		});
		assert.throws(() =>
			buildPaymentQr({ bank_account: "123", bank_code: "ACB", reference: "RCABC123", amount: 1.5 }),
		);
	});
});

describe("outbox recovery and fencing", () => {
	it("recovers missed publishing and makes repeated queue delivery harmless", async () => {
		await receivePaymentWebhook(webhook(), "company", options);
		let sends = 0;
		const send = mock.fn(async (_message: { id: string }) => {
			if (sends++ === 0) throw new Error("Queue unavailable");
			return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } };
		});
		options.queue = {
			send,
			sendBatch: async () => ({ metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } }),
			metrics: async () => ({ backlogCount: 1, backlogBytes: 1 }),
		} satisfies Queue<{ id: string }>;
		assert.deepEqual(await dispatchOutbox(options), { configured: true, published: 0, failed: 1 });
		await recoverJobs(options);
		assert.deepEqual(await dispatchOutbox(options), { configured: true, published: 1, failed: 0 });
		assert.deepEqual(send.mock.calls.at(-1)?.arguments, [{ id: "payment:sandbox:company:123" }]);
		const first = await deliver("payment:sandbox:company:123");
		const replay = await deliver("payment:sandbox:company:123");
		assert.equal(first.ack.mock.callCount(), 1);
		assert.equal(replay.ack.mock.callCount(), 1);
	});
	it("fences an old consumer after its lease expires", async () => {
		await receivePaymentWebhook(webhook(), "company", options);
		const stale = await claimJob("payment:sandbox:company:123", options);
		assert.ok(stale);
		now += 120001;
		await recoverJobs(options);
		const current = await claimJob("payment:sandbox:company:123", options);
		assert.ok(current);
		assert.equal(await finishJob(stale, { state: "done" }, options), false);
		assert.deepEqual(await db.prepare("SELECT lease_token FROM rc_outbox").first(), {
			lease_token: current.lease_token,
		});
	});
});

describe("invoice external outcome safety", () => {
	it("keeps independent create/issue tracking and preserves provider/tax state", async () => {
		await seedInvoice();
		const calls = provider((url, init) => {
			if (url.pathname === "/v1/invoices/create") {
				assert.equal(init?.body, JSON.stringify(invoicePayload));
				return Response.json({ success: true, data: { tracking_code: "create-track" } });
			}
			if (url.pathname === "/v1/invoices/create/check/create-track")
				return Response.json({
					success: true,
					data: {
						status: "Success",
						invoice: { reference_code: "INV123", status: "draft", provider_status: "1" },
					},
				});
			if (url.pathname === "/v1/invoices/issue") {
				assert.equal(init?.body, '{"reference_code":"INV123"}');
				return Response.json({ success: true, data: { tracking_code: "issue-track" } });
			}
			if (url.pathname === "/v1/invoices/issue/check/issue-track")
				return Response.json({
					success: true,
					data: {
						status: "Success",
						invoice: {
							reference_code: "INV123",
							status: "issued",
							provider_status: "5",
							tax_authority_code: null,
						},
					},
				});
			throw new Error("Unexpected URL");
		});
		await deliver("invoice-job");
		assert.deepEqual(await db.prepare("SELECT status FROM rc_invoices").first(), {
			status: "pending",
		});
		now += 30001;
		await deliver("invoice-job");
		assert.deepEqual(await db.prepare("SELECT status FROM rc_invoices").first(), {
			status: "draft",
		});
		await db.batch([
			db.prepare(
				"UPDATE rc_invoices SET status='queued',issue_payload_json='{\"reference_code\":\"INV123\"}'",
			),
			db
				.prepare(
					"INSERT INTO rc_outbox (id,kind,payload_json,available_at,created_at,updated_at) VALUES ('issue-job','invoice.issue','{\"invoiceId\":\"invoice\"}',?,?,?)",
				)
				.bind(now, now, now),
		]);
		await deliver("issue-job");
		now += 30001;
		await deliver("issue-job");
		assert.deepEqual(
			await db
				.prepare(
					"SELECT status,create_tracking_code,issue_tracking_code,tax_authority_status FROM rc_invoices",
				)
				.first(),
			{
				status: "issued",
				create_tracking_code: "create-track",
				issue_tracking_code: "issue-track",
				tax_authority_status: "5",
			},
		);
		assert.equal(calls.filter((call) => call === "POST /v1/invoices/create").length, 1);
	});
	it("issues a recovered remote draft without requiring its lost create tracking response", async () => {
		await seedInvoice();
		await db.batch([
			db.prepare(
				'UPDATE rc_invoices SET last_operation=\'issue\',issue_payload_json=\'{"reference_code":"INV123"}\',provider_json=\'{"reference_code":"INV123","status":"draft"}\'',
			),
			db.prepare("UPDATE rc_outbox SET kind='invoice.issue' WHERE id='invoice-job'"),
		]);
		const calls = provider((url) => {
			if (url.pathname === "/v1/invoices/issue")
				return Response.json({ success: true, data: { tracking_code: "recovered-issue" } });
			if (url.pathname === "/v1/invoices/issue/check/recovered-issue")
				return Response.json({
					success: true,
					data: { status: "Success", invoice: { reference_code: "INV123", status: "issued" } },
				});
			throw new Error("Unexpected provider operation");
		});
		await deliver("invoice-job");
		now += 30001;
		await deliver("invoice-job");
		assert.deepEqual(
			await db
				.prepare("SELECT status,create_tracking_code,issue_tracking_code FROM rc_invoices")
				.first(),
			{ status: "issued", create_tracking_code: null, issue_tracking_code: "recovered-issue" },
		);
		assert.equal(calls.filter((call) => call === "POST /v1/invoices/issue").length, 1);
		assert.equal(calls.filter((call) => call === "POST /v1/invoices/create").length, 0);
	});
	it("polls provider Pending rather than submitting creation again", async () => {
		await seedInvoice();
		const calls = provider((url) =>
			Response.json({
				success: true,
				data: url.pathname.endsWith("/create")
					? { tracking_code: "pending-track" }
					: { status: "Pending", retry: { next_retry_at: null } },
			}),
		);
		await deliver("invoice-job");
		for (let i = 0; i < 3; i++) {
			now += 30001;
			await deliver("invoice-job");
		}
		assert.equal(calls.filter((call) => call === "POST /v1/invoices/create").length, 1);
		assert.deepEqual(await db.prepare("SELECT status FROM rc_invoices").first(), {
			status: "pending",
		});
	});
	it("never repeats a create after a lost response, even when reference lookup is 404", async () => {
		await seedInvoice();
		const calls = provider((url) => {
			if (url.pathname.endsWith("/create"))
				throw new TypeError("Connection lost after provider acceptance");
			return Response.json({ success: false, error: { code: "NOT_FOUND" } }, { status: 404 });
		});
		await deliver("invoice-job");
		assert.deepEqual(await db.prepare("SELECT status,payload_json FROM rc_invoices").first(), {
			status: "outcome_unknown",
			payload_json: JSON.stringify(invoicePayload),
		});
		await db
			.prepare(
				"INSERT INTO rc_outbox (id,kind,payload_json,available_at,created_at,updated_at) VALUES ('reconcile-job','invoice.reconcile','{\"invoiceId\":\"invoice\"}',?,?,?)",
			)
			.bind(now, now, now)
			.run();
		await deliver("reconcile-job");
		assert.deepEqual(await db.prepare("SELECT status FROM rc_invoices").first(), {
			status: "outcome_unknown",
		});
		assert.equal(calls.filter((call) => call === "POST /v1/invoices/create").length, 1);
	});
	it("recovers a crash between dispatch and response without another mutation", async () => {
		await seedInvoice();
		const lease = await claimJob("invoice-job", options);
		if (!lease) throw new Error("Missing lease");
		await db
			.prepare(
				"UPDATE rc_invoices SET status='dispatching',dispatch_token=?,dispatch_at=?,last_operation='create'",
			)
			.bind(lease.lease_token, now)
			.run();
		now += 120001;
		assert.deepEqual(await recoverJobs(options), { expired: 1, unknownInvoices: 1 });
		const calls = provider(() =>
			Response.json({
				success: true,
				data: {
					reference_code: "INV123",
					status: "issued",
					provider_status: "4",
					tax_authority_code: "test-tax-code",
				},
			}),
		);
		await deliver("invoice-job");
		assert.deepEqual(await db.prepare("SELECT status FROM rc_invoices").first(), {
			status: "issued",
		});
		assert.equal(calls.filter((call) => call.startsWith("POST /v1/invoices")).length, 0);
	});
	it("keeps unknown issuance unresolved when the reference still shows draft", async () => {
		await seedInvoice();
		await db
			.prepare(
				"UPDATE rc_invoices SET status='outcome_unknown',last_operation='issue',create_tracking_code='old-create'",
			)
			.run();
		provider(() =>
			Response.json({ success: true, data: { reference_code: "INV123", status: "draft" } }),
		);
		await deliver("invoice-job");
		assert.deepEqual(await db.prepare("SELECT status FROM rc_invoices").first(), {
			status: "outcome_unknown",
		});
	});
	for (const kind of ["adjustment", "replacement"]) {
		it(`dispatches ${kind} with its stable correction reference`, async () => {
			const payload = {
				...invoicePayload,
				original_invoice_reference_code: "ORIGINAL",
				...(kind === "adjustment" ? { adjustment_type: "increase" } : {}),
			};
			await seedInvoice(kind, payload);
			const calls = provider((_url, init) => {
				assert.equal(init?.body, JSON.stringify(payload));
				return Response.json({ success: true, data: { tracking_code: "correction-track" } });
			});
			await deliver("invoice-job");
			assert.ok(
				calls.includes(`POST /v1/invoices/${kind === "adjustment" ? "adjust" : "replace"}`),
			);
		});
	}
	it("retains quota failure instead of reporting issuance or blindly retrying", async () => {
		await seedInvoice();
		provider(() =>
			Response.json(
				{ success: false, error: { code: "QUOTA_HAS_BEEN_USERD_UP" } },
				{ status: 500 },
			),
		);
		await deliver("invoice-job");
		assert.deepEqual(await db.prepare("SELECT status,last_error FROM rc_invoices").first(), {
			status: "failed",
			last_error: "QUOTA_HAS_BEEN_USERD_UP",
		});
		assert.deepEqual(await db.prepare("SELECT state FROM rc_outbox").first(), { state: "review" });
	});
	it("downloads the actual provider file through the issuance tracking code", async () => {
		await seedInvoice();
		await db
			.prepare(
				"UPDATE rc_invoices SET status='issued',create_tracking_code='create-track',issue_tracking_code='issue-track'",
			)
			.run();
		const calls = provider(() =>
			Response.json({
				success: true,
				data: {
					file_type: "pdf",
					file_name: "untrusted\r\n.pdf",
					content: btoa("%PDF-1.7\ncontrolled invoice"),
				},
			}),
		);
		const response = await downloadInvoice("invoice", "pdf", options);
		assert.equal(await response.text(), "%PDF-1.7\ncontrolled invoice");
		assert.equal(
			response.headers.get("Content-Disposition"),
			'attachment; filename="invoice-invoice.pdf"',
		);
		assert.ok(calls.includes("GET /v1/invoices/issue-track/download"));
	});
});

describe("provider boundary and identity gaps", () => {
	it("refreshes expired tokens without reusing credentials across contexts", async () => {
		const calls = provider(() => Response.json({ success: true, data: { status: "draft" } }));
		const context = options.contexts.company;
		if (!context) throw new Error("Missing context");
		const client = new InvoiceClient(options, context);
		await client.request("/invoices/INV123");
		await client.request("/invoices/INV123");
		now += 86400000;
		await client.request("/invoices/INV123");
		assert.equal(calls.filter((call) => call === "POST /v1/token").length, 2);
		assert.throws(
			() =>
				parseCredentialContexts(
					'{"company":{"environment":"production","webhook":{"mode":"none","secret":"x"}}}',
				),
			/INVALID_CREDENTIAL_CONFIGURATION/,
		);
	});
	it("never posts UUID reconciliation money again, even with a unique business-field candidate", async () => {
		await receivePaymentWebhook(webhook(), "company", options);
		await deliver("payment:sandbox:company:123");
		const context = options.contexts.company;
		if (!context) throw new Error("Missing context");
		context.bankApiToken = "a".repeat(64);
		options.fetch = async () =>
			Response.json({
				status: "success",
				data: [
					{
						id: "11111111-2222-4333-8444-555555555555",
						account_number: event.accountNumber,
						bank_brand_name: event.gateway,
						transaction_date: "2026-10-10T10:00:00+07:00",
						transfer_type: "in",
						amount_in: event.transferAmount,
						amount_out: 0,
						reference_number: event.referenceCode,
						va: "",
						code: event.code,
					},
				],
				meta: { pagination: { has_more: false } },
			});
		await reconcileBankTransactions(
			{ contextId: "company", from: "2026-10-10T00:00:00+07:00", to: "2026-10-10T23:59:59+07:00" },
			options,
		);
		assert.deepEqual(
			await db.prepare("SELECT state,matched_inbox_id FROM rc_bank_reconciliation").first(),
			{ state: "candidate_match", matched_inbox_id: "sandbox:company:123" },
		);
		assert.deepEqual(
			await db.prepare("SELECT count(*) AS count FROM rc_payment_allocations").first(),
			{ count: 1 },
		);
	});
});

describe("adverse provider and queue boundaries", () => {
	it("still acknowledges persisted payment when immediate queue publishing fails", async () => {
		const log = mock.method(console, "error", () => {});
		try {
			options.queue = {
				send: mock.fn(async () => {
					throw new Error("Queue unavailable");
				}),
				sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
				metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
			} satisfies Queue<{ id: string }>;
			assert.equal((await receivePaymentWebhook(webhook(), "company", options)).status, 200);
			assert.deepEqual(await db.prepare("SELECT state FROM rc_outbox").first(), {
				state: "pending",
			});
			assert.equal(log.mock.callCount(), 1);
		} finally {
			log.mock.restore();
		}
	});
	it("uses explicit virtual-account and memo settings without changing the settlement reference", () => {
		const payment = {
			bank_account: "123456789",
			bank_code: "ACB",
			reference: "RCABC123",
			amount: 108000,
			sub_account: "VA123",
		};
		const virtual = new URL(buildPaymentQr({ ...payment, qr_mode: "virtual" }));
		assert.equal(virtual.searchParams.get("acc"), "VA123");
		assert.equal(virtual.searchParams.get("des"), "RCABC123");
		const memo = new URL(buildPaymentQr({ ...payment, qr_mode: "memo", transfer_prefix: "SEVQR" }));
		assert.equal(memo.searchParams.get("acc"), "123456789");
		assert.equal(memo.searchParams.get("des"), "SEVQR TKPVA123 RCABC123");
		assert.throws(() =>
			buildPaymentQr({ ...payment, qr_mode: "memo", transfer_prefix: "TKPVA123" }),
		);
	});
	it("rejects a webhook from a different credential context before it can allocate money", async () => {
		options.contexts.other = {
			environment: "sandbox",
			webhook: { mode: "apikey", secret: "different-company-secret" },
		};
		const response = await receivePaymentWebhook(
			new Request("https://restaurant.test/webhook/other", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Apikey different-company-secret",
				},
				body: JSON.stringify(event),
			}),
			"other",
			options,
		);
		assert.equal(response.status, 200);
		await deliver("payment:sandbox:other:123");
		assert.deepEqual(await db.prepare("SELECT state,exception FROM rc_payment_inbox").first(), {
			state: "exception",
			exception: "REFERENCE_NOT_FOUND",
		});
		assert.deepEqual(
			await db.prepare("SELECT count(*) AS count FROM rc_payment_allocations").first(),
			{ count: 0 },
		);
	});
	it("does not let a late invoice response overwrite lease recovery", async () => {
		await seedInvoice();
		provider(async () => {
			now += 120001;
			await recoverJobs(options);
			return Response.json({ success: true, data: { tracking_code: "late-track" } });
		});
		const delivery = await deliver("invoice-job");
		assert.ok(delivery.retry.mock.callCount() > 0);
		assert.deepEqual(
			await db.prepare("SELECT status,create_tracking_code FROM rc_invoices").first(),
			{ status: "outcome_unknown", create_tracking_code: null },
		);
		assert.deepEqual(await db.prepare("SELECT state FROM rc_outbox").first(), { state: "pending" });
	});
	it("holds an oversized mutation response as unknown rather than retrying its POST", async () => {
		await seedInvoice();
		provider(
			() =>
				new Response("x".repeat(1024 * 1024 + 1), {
					headers: { "Content-Type": "application/json" },
				}),
		);
		await deliver("invoice-job");
		assert.deepEqual(await db.prepare("SELECT status,last_error FROM rc_invoices").first(), {
			status: "outcome_unknown",
			last_error: "BODY_TOO_LARGE",
		});
		assert.deepEqual(await db.prepare("SELECT state FROM rc_outbox").first(), { state: "review" });
	});
	it("does not turn provider asynchronous Failed into invoice issuance", async () => {
		await seedInvoice();
		await db
			.prepare(
				"UPDATE rc_invoices SET status='pending',last_operation='create',create_tracking_code='tracking'",
			)
			.run();
		provider(() =>
			Response.json({
				success: true,
				data: {
					status: "Failed",
					message: "Hệ thống chưa xác nhận được kết quả phát hành với nhà cung cấp hóa đơn",
				},
			}),
		);
		await deliver("invoice-job");
		assert.deepEqual(await db.prepare("SELECT status FROM rc_invoices").first(), {
			status: "outcome_unknown",
		});
		assert.deepEqual(await db.prepare("SELECT state FROM rc_outbox").first(), { state: "review" });
	});
	it("keeps UUID-only bank transfers visible without manufacturing numeric webhook identity", async () => {
		const context = options.contexts.company;
		if (!context) throw new Error("Missing context");
		context.bankApiToken = "a".repeat(64);
		options.fetch = async () =>
			Response.json({
				status: "success",
				data: [
					{
						id: "11111111-2222-4333-8444-555555555555",
						account_number: event.accountNumber,
						bank_brand_name: event.gateway,
						transaction_date: "2026-10-10T10:00:00+07:00",
						transfer_type: "in",
						amount_in: event.transferAmount,
						amount_out: 0,
						reference_number: "",
						va: "",
						code: event.code,
					},
				],
				meta: { pagination: { has_more: false } },
			});
		await reconcileBankTransactions(
			{ contextId: "company", from: "2026-10-10T00:00:00+07:00", to: "2026-10-10T23:59:59+07:00" },
			options,
		);
		assert.deepEqual(
			await db.prepare("SELECT state,matched_inbox_id FROM rc_bank_reconciliation").first(),
			{ state: "identity_review", matched_inbox_id: null },
		);
		assert.deepEqual(await db.prepare("SELECT count(*) AS count FROM rc_payment_inbox").first(), {
			count: 0,
		});
		assert.deepEqual(
			await db.prepare("SELECT count(*) AS count FROM rc_payment_allocations").first(),
			{ count: 0 },
		);
	});
});

describe("original invoice state after corrections", () => {
	for (const kind of ["adjustment", "replacement"]) {
		it(`reconciles the original after ${kind} issuance without repeating mutations`, async () => {
			await seedInvoice();
			const originalBefore = {
				reference_code: "INV123",
				status: "issued",
				provider_status: "4",
				document_type: 2,
			};
			await db.batch([
				db
					.prepare(
						"UPDATE rc_invoices SET status='issued',provider_json=?,tax_authority_status='4' WHERE id='invoice'",
					)
					.bind(JSON.stringify(originalBefore)),
				db.prepare("UPDATE rc_outbox SET state='done' WHERE id='invoice-job'"),
			]);
			const correctionPayload = {
				...invoicePayload,
				reference_code: "COR123",
				original_invoice_reference_code: "INV123",
				is_draft: false,
				...(kind === "adjustment" ? { adjustment_type: "increase" } : {}),
			};
			await db.batch([
				db
					.prepare(
						"INSERT INTO rc_invoices (id,branch_id,visit_id,payment_id,kind,original_invoice_id,status,reference,payload_json,credential_context,environment,created_at,updated_at) VALUES ('correction','branch','visit','payment',?,'invoice','queued','COR123',?,'company','sandbox',?,?)",
					)
					.bind(kind, JSON.stringify(correctionPayload), now, now),
				db
					.prepare(
						"INSERT INTO rc_outbox (id,kind,payload_json,available_at,created_at,updated_at) VALUES ('correction-job','invoice.create','{\"invoiceId\":\"correction\"}',?,?,?)",
					)
					.bind(now, now, now),
			]);
			const originalAfter = {
				reference_code: "INV123",
				status: "issued",
				provider_status: "8",
				document_type: kind === "adjustment" ? 10 : 5,
			};
			const operation = kind === "adjustment" ? "adjust" : "replace";
			const calls = provider((url, init) => {
				if (url.pathname === `/v1/invoices/${operation}`) {
					assert.equal(init?.body, JSON.stringify(correctionPayload));
					return Response.json({ success: true, data: { tracking_code: "correction-tracking" } });
				}
				if (url.pathname === "/v1/invoices/create/check/correction-tracking")
					return Response.json({
						success: true,
						data: {
							status: "Success",
							invoice: { reference_code: "COR123", status: "issued", provider_status: "4" },
						},
					});
				if (url.pathname === "/v1/invoices/INV123")
					return Response.json({ success: true, data: originalAfter });
				if (url.pathname === "/v1/invoices/COR123")
					return Response.json({
						success: true,
						data: { reference_code: "COR123", status: "issued", provider_status: "4" },
					});
				throw new Error(`Unexpected provider URL: ${url.pathname}`);
			});
			await deliver("correction-job");
			assert.equal(
				await db.prepare("SELECT id FROM rc_outbox WHERE id='invoice:original:correction'").first(),
				null,
			);
			now += 30001;
			await deliver("correction-job");
			assert.deepEqual(
				await db
					.prepare(
						"SELECT state,payload_json FROM rc_outbox WHERE id='invoice:original:correction'",
					)
					.first(),
				{ state: "pending", payload_json: '{"invoiceId":"invoice"}' },
			);
			assert.deepEqual(
				await db.prepare("SELECT provider_json FROM rc_invoices WHERE id='invoice'").first(),
				{ provider_json: JSON.stringify(originalBefore) },
			);
			await deliver("invoice:original:correction");
			assert.deepEqual(
				await db
					.prepare(
						"SELECT status,tax_authority_status,provider_json FROM rc_invoices WHERE id='invoice'",
					)
					.first(),
				{
					status: "issued",
					tax_authority_status: "8",
					provider_json: JSON.stringify(originalAfter),
				},
			);
			await deliver("correction-job");
			await deliver("invoice:original:correction");
			await db
				.prepare(
					"INSERT INTO rc_outbox (id,kind,payload_json,available_at,created_at,updated_at) VALUES ('correction-recheck','invoice.reconcile','{\"invoiceId\":\"correction\"}',?,?,?)",
				)
				.bind(now, now, now)
				.run();
			await deliver("correction-recheck");
			assert.deepEqual(
				await db
					.prepare(
						"SELECT count(*) AS count FROM rc_outbox WHERE id='invoice:original:correction' AND state='done'",
					)
					.first(),
				{ count: 1 },
			);
			assert.equal(calls.filter((call) => call === `POST /v1/invoices/${operation}`).length, 1);
			assert.equal(calls.filter((call) => call === "GET /v1/invoices/INV123").length, 1);
		});
	}
});
