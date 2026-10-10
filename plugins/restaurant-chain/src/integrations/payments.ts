import { timingSafeEqual } from "node:crypto";
import { boundedBytes } from "./http.js";
import {
	clock,
	contextFor,
	IntegrationError,
	object,
	type IntegrationOptions,
	type JobLease,
} from "./types.js";

export interface BankWebhook {
	id: number;
	gateway: string;
	transactionDate: string;
	accountNumber: string;
	subAccount: string;
	code: string | null;
	content: string;
	transferType: "in" | "out";
	transferAmount: number;
	referenceCode: string;
}
function text(value: unknown, max: number, empty = false): string {
	if (typeof value !== "string" || value.length > max || (!empty && !value.length))
		throw new IntegrationError("INVALID_WEBHOOK", 400);
	return value;
}
export function parseBankWebhook(value: unknown): BankWebhook {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new IntegrationError("INVALID_WEBHOOK", 400);
	const row = object(value);
	if (
		typeof row.id !== "number" ||
		!Number.isSafeInteger(row.id) ||
		row.id <= 0 ||
		typeof row.transferAmount !== "number" ||
		!Number.isSafeInteger(row.transferAmount) ||
		row.transferAmount <= 0 ||
		(row.transferType !== "in" && row.transferType !== "out")
	)
		throw new IntegrationError("INVALID_WEBHOOK", 400);
	const transactionDate = text(row.transactionDate, 19);
	if (
		!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(transactionDate) ||
		!Number.isFinite(Date.parse(transactionDate.replace(" ", "T") + "+07:00"))
	)
		throw new IntegrationError("INVALID_WEBHOOK", 400);
	return {
		id: row.id,
		gateway: text(row.gateway, 100),
		transactionDate,
		accountNumber: text(row.accountNumber, 100),
		subAccount: row.subAccount === null ? "" : text(row.subAccount, 100, true),
		code: row.code === null ? null : text(row.code, 100, true),
		content: text(row.content, 4000, true),
		transferType: row.transferType,
		transferAmount: row.transferAmount,
		referenceCode: text(row.referenceCode, 200, true),
	};
}

async function authenticate(
	request: Request,
	bytes: Uint8Array,
	contextId: string,
	options: IntegrationOptions,
): Promise<void> {
	const { webhook } = contextFor(options, contextId);
	if (!webhook?.secret) throw new IntegrationError("WEBHOOK_NOT_CONFIGURED", 503);
	if (webhook.mode === "apikey") {
		const expected = new TextEncoder().encode(`Apikey ${webhook.secret}`);
		const actual = new TextEncoder().encode(request.headers.get("Authorization") ?? "");
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
			throw new IntegrationError("WEBHOOK_UNAUTHORIZED", 401);
		return;
	}
	if (webhook.mode !== "hmac") throw new IntegrationError("WEBHOOK_NOT_CONFIGURED", 503);
	const timestamp = request.headers.get("X-SePay-Timestamp") ?? "";
	const signature = request.headers.get("X-SePay-Signature") ?? "";
	if (
		!/^\d{10}$/.test(timestamp) ||
		Math.abs(clock(options) - Number(timestamp) * 1000) > 300_000 ||
		!/^sha256=[a-fA-F0-9]{64}$/.test(signature)
	)
		throw new IntegrationError("WEBHOOK_UNAUTHORIZED", 401);
	const prefix = new TextEncoder().encode(`${timestamp}.`);
	const signed = new Uint8Array(prefix.length + bytes.length);
	signed.set(prefix);
	signed.set(bytes, prefix.length);
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(webhook.secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const decoded = Uint8Array.from(signature.slice(7).match(/../g) ?? [], (hex) =>
		Number.parseInt(hex, 16),
	);
	if (!(await crypto.subtle.verify("HMAC", key, decoded, signed)))
		throw new IntegrationError("WEBHOOK_UNAUTHORIZED", 401);
}

export async function receivePaymentWebhook(
	request: Request,
	contextId: string,
	options: IntegrationOptions,
): Promise<Response> {
	try {
		if (request.method !== "POST")
			return Response.json({ success: false }, { status: 405, headers: { Allow: "POST" } });
		if (
			request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
			"application/json"
		)
			throw new IntegrationError("JSON_REQUIRED", 415);
		const bytes = await boundedBytes(request.body, 32_768);
		await authenticate(request, bytes, contextId, options);
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			throw new IntegrationError("INVALID_WEBHOOK", 400);
		}
		const event = parseBankWebhook(value);
		const context = contextFor(options, contextId);
		const id = `${context.environment}:${contextId}:${event.id}`;
		const now = clock(options);
		await options.db.batch([
			options.db
				.prepare(
					`INSERT INTO rc_payment_inbox (id,environment,credential_context,provider_transaction_id,payload_json,state,created_at) VALUES (?,?,?,?,?,'pending',?) ON CONFLICT(environment,credential_context,provider_transaction_id) DO NOTHING`,
				)
				.bind(id, context.environment, contextId, String(event.id), JSON.stringify(event), now),
			options.db
				.prepare(
					`INSERT INTO rc_outbox (id,kind,payload_json,state,attempts,available_at,created_at,updated_at) SELECT ?,'payment.process',?,'pending',0,?,?,? FROM rc_payment_inbox WHERE id=? AND state='pending' ON CONFLICT(id) DO NOTHING`,
				)
				.bind(`payment:${id}`, JSON.stringify({ inboxId: id }), now, now, now, id),
		]);
		if (options.queue) {
			try {
				await options.queue.send({ id: `payment:${id}` });
			} catch {
				console.error(
					"[restaurant-chain] Payment enqueue failed; durable outbox recovery will retry.",
				);
			}
		}
		return Response.json({ success: true });
	} catch (error) {
		const status = error instanceof IntegrationError ? error.status : 503;
		return Response.json(
			{
				success: false,
				error: error instanceof IntegrationError ? error.code : "PAYMENT_PERSISTENCE_UNAVAILABLE",
			},
			{ status },
		);
	}
}

export function buildPaymentQr(payment: {
	bank_account: string;
	bank_code: string;
	reference: string;
	amount: number;
	sub_account?: string;
	qr_mode?: "direct" | "virtual" | "memo";
	transfer_prefix?: string;
}): string {
	if (
		!payment.bank_account ||
		!payment.bank_code ||
		!/^[A-Z0-9]{3,35}$/.test(payment.reference) ||
		!Number.isSafeInteger(payment.amount) ||
		payment.amount <= 0
	)
		throw new IntegrationError("INVALID_PAYMENT_QR", 400);
	const mode = payment.qr_mode ?? "direct";
	const subAccount = payment.sub_account ?? "";
	const prefix = payment.transfer_prefix?.trim() ?? "";
	if (
		!["direct", "virtual", "memo"].includes(mode) ||
		(mode === "direct" ? !!subAccount : !subAccount) ||
		prefix.length > 50 ||
		!/^[A-Za-z0-9 ]*$/.test(prefix) ||
		(mode === "memo" && /^TKP/i.test(prefix))
	)
		throw new IntegrationError("INVALID_PAYMENT_QR_CONFIGURATION", 400);
	const description = `${prefix ? `${prefix} ` : ""}${mode === "memo" ? `TKP${subAccount} ` : ""}${payment.reference}`;
	const url = new URL("https://vietqr.app/img");
	url.search = new URLSearchParams({
		acc: mode === "virtual" ? subAccount : payment.bank_account,
		bank: payment.bank_code,
		amount: String(payment.amount),
		des: description,
		template: "compact",
	}).toString();
	return url.toString();
}

interface InboxRow {
	id: string;
	environment: string;
	credential_context: string;
	payload_json: string;
	state: string;
}
interface PaymentRow {
	id: string;
	branch_id: string;
	visit_id: string;
	reference: string;
	amount: number;
	bank_account: string;
	bank_code: string;
	bank_name: string;
	sub_account: string;
	status: string;
}
export async function processPayment(
	inboxId: string,
	lease: JobLease,
	options: IntegrationOptions,
): Promise<void> {
	const inbox = await options.db
		.prepare("SELECT * FROM rc_payment_inbox WHERE id=?")
		.bind(inboxId)
		.first<InboxRow>();
	if (!inbox) throw new IntegrationError("PAYMENT_INBOX_NOT_FOUND", 404);
	if (inbox.state !== "pending") return;
	const event = parseBankWebhook(JSON.parse(inbox.payload_json));
	const payment = event.code
		? await options.db
				.prepare(
					"SELECT * FROM rc_payment_attempts WHERE environment=? AND credential_context=? AND reference=?",
				)
				.bind(inbox.environment, inbox.credential_context, event.code)
				.first<PaymentRow>()
		: null;
	let exception: string | null = null;
	if (event.transferType !== "in") exception = "OUTGOING_TRANSFER";
	else if (!payment) exception = "REFERENCE_NOT_FOUND";
	else if (
		payment.bank_account !== event.accountNumber ||
		(payment.bank_name || payment.bank_code).toLowerCase() !== event.gateway.toLowerCase() ||
		payment.sub_account !== event.subAccount
	)
		exception = "ACCOUNT_MISMATCH";
	else if (payment.amount !== event.transferAmount)
		exception = event.transferAmount < payment.amount ? "UNDERPAYMENT" : "OVERPAYMENT";
	else if (payment.status === "superseded") exception = "SUPERSEDED_ATTEMPT";
	else if (payment.status !== "pending") exception = "DISTINCT_SECOND_TRANSFER";
	const now = clock(options);
	if (exception || !payment) {
		await options.db
			.prepare(
				`UPDATE rc_payment_inbox SET state='exception',exception=?,payment_id=?,processed_at=? WHERE id=? AND state='pending' AND EXISTS (SELECT 1 FROM rc_outbox WHERE id=? AND state='running' AND lease_token=? AND lease_until>?)`,
			)
			.bind(exception, payment?.id ?? null, now, inboxId, lease.id, lease.lease_token, now)
			.run();
		return;
	}
	const allocationId = crypto.randomUUID();
	await options.db.batch([
		options.db
			.prepare(
				`INSERT INTO rc_payment_allocations (id,inbox_id,payment_id,amount,created_at) SELECT ?,i.id,p.id,?,? FROM rc_payment_inbox i JOIN rc_payment_attempts p ON p.id=? JOIN rc_visits v ON v.id=p.visit_id WHERE i.id=? AND i.state='pending' AND p.status='pending' AND v.status='billing' AND NOT EXISTS (SELECT 1 FROM rc_payment_allocations a JOIN rc_payment_attempts paid ON paid.id=a.payment_id WHERE paid.visit_id=p.visit_id) AND EXISTS (SELECT 1 FROM rc_outbox WHERE id=? AND state='running' AND lease_token=? AND lease_until>?) ON CONFLICT DO NOTHING`,
			)
			.bind(
				allocationId,
				event.transferAmount,
				now,
				payment.id,
				inboxId,
				lease.id,
				lease.lease_token,
				now,
			),
		options.db
			.prepare(
				`UPDATE rc_payment_attempts SET status='paid',paid_at=?,version=version+1 WHERE id=? AND EXISTS (SELECT 1 FROM rc_payment_allocations WHERE id=?)`,
			)
			.bind(now, payment.id, allocationId),
		options.db
			.prepare(
				`UPDATE rc_visits SET status='paid',version=version+1 WHERE id=? AND status='billing' AND EXISTS (SELECT 1 FROM rc_payment_allocations WHERE id=?)`,
			)
			.bind(payment.visit_id, allocationId),
		options.db
			.prepare(
				`INSERT INTO rc_audit (id,branch_id,actor_id,action,entity_id,detail_json,created_at) SELECT ?,?,NULL,'payment.applied',?,?,? WHERE EXISTS (SELECT 1 FROM rc_payment_allocations WHERE id=?)`,
			)
			.bind(
				crypto.randomUUID(),
				payment.branch_id,
				payment.id,
				JSON.stringify({ inboxId, amount: event.transferAmount }),
				now,
				allocationId,
			),
		options.db
			.prepare(
				`UPDATE rc_payment_inbox SET state=CASE WHEN EXISTS (SELECT 1 FROM rc_payment_allocations WHERE inbox_id=?) THEN 'applied' ELSE 'exception' END,exception=CASE WHEN EXISTS (SELECT 1 FROM rc_payment_allocations WHERE inbox_id=?) THEN NULL ELSE 'PAYMENT_STATE_CONFLICT' END,payment_id=?,processed_at=? WHERE id=? AND state='pending' AND EXISTS (SELECT 1 FROM rc_outbox WHERE id=? AND state='running' AND lease_token=? AND lease_until>?)`,
			)
			.bind(inboxId, inboxId, payment.id, now, inboxId, lease.id, lease.lease_token, now),
	]);
}
