import type { MessageBatch } from "@cloudflare/workers-types";
import { processInvoice, type JobDisposition } from "../integrations/invoices.js";
import { processPayment } from "../integrations/payments.js";
import {
	reconcileBankTransactions,
	type BankReconciliationInput,
} from "../integrations/reconciliation.js";
import { ProviderError } from "../integrations/http.js";
import {
	clock,
	IntegrationError,
	object,
	string,
	type IntegrationOptions,
	type JobLease,
} from "../integrations/types.js";

const LEASE_MS = 120_000;
const MAX_BATCH = 10;

export async function claimJob(id: string, options: IntegrationOptions): Promise<JobLease | null> {
	const now = clock(options);
	return options.db
		.prepare(
			`UPDATE rc_outbox SET state='running',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND state='pending' AND available_at<=? RETURNING id,kind,payload_json,attempts,lease_token,lease_until,created_at`,
		)
		.bind(crypto.randomUUID(), now + LEASE_MS, now, id, now)
		.first<JobLease>();
}

export async function finishJob(
	lease: JobLease,
	disposition: JobDisposition,
	options: IntegrationOptions,
): Promise<boolean> {
	const now = clock(options);
	const result = await options.db
		.prepare(
			`UPDATE rc_outbox SET state=?,available_at=?,lease_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?`,
		)
		.bind(
			disposition.state,
			now + (disposition.delayMs ?? 0),
			disposition.error ?? null,
			now,
			lease.id,
			lease.lease_token,
			now,
		)
		.run();
	return result.meta.changes > 0;
}

async function executeJob(lease: JobLease, options: IntegrationOptions): Promise<JobDisposition> {
	const payload = object(JSON.parse(lease.payload_json));
	if (lease.kind === "payment.process") {
		await processPayment(string(payload.inboxId, 200), lease, options);
		return { state: "done" };
	}
	if (
		[
			"invoice.create",
			"invoice.issue",
			"invoice.reconcile",
			"invoice.poll",
			"invoice.adjust",
			"invoice.replace",
		].includes(lease.kind)
	)
		return processInvoice(string(payload.invoiceId, 100), lease, options);
	if (lease.kind === "bank.reconcile") {
		const input: BankReconciliationInput = {
			contextId: string(payload.contextId, 80),
			from: string(payload.from, 40),
			to: string(payload.to, 40),
		};
		if (payload.page !== undefined) {
			if (typeof payload.page !== "number") throw new IntegrationError("INVALID_JOB_PAYLOAD", 400);
			input.page = payload.page;
		}
		if (payload.bankAccountId !== undefined)
			input.bankAccountId = string(payload.bankAccountId, 36);
		const result = await reconcileBankTransactions(input, options, lease);
		if (result.nextPage) {
			const now = clock(options);
			const next = { ...input, page: result.nextPage };
			const id = `bank:${input.contextId}:${input.from}:${input.to}:${next.page}`;
			await options.db
				.prepare(
					`INSERT INTO rc_outbox (id,kind,payload_json,state,attempts,available_at,created_at,updated_at) SELECT ?,'bank.reconcile',?,'pending',0,?,?,? WHERE EXISTS (SELECT 1 FROM rc_outbox WHERE id=? AND state='running' AND lease_token=? AND lease_until>?) ON CONFLICT(id) DO NOTHING`,
				)
				.bind(id, JSON.stringify(next), now + 1000, now, now, lease.id, lease.lease_token, now)
				.run();
		}
		return { state: "done" };
	}
	return { state: "review", error: "UNKNOWN_JOB_KIND" };
}

export async function processJobs(
	batch: MessageBatch<{ id: string }>,
	options: IntegrationOptions,
): Promise<void> {
	for (const [index, message] of batch.messages.entries()) {
		if (index >= MAX_BATCH) {
			message.retry({ delaySeconds: 5 });
			continue;
		}
		let lease: JobLease | null = null;
		try {
			if (
				!message.body ||
				typeof message.body.id !== "string" ||
				message.body.id.length > 250 ||
				!message.body.id.length
			) {
				const now = clock(options);
				await options.db
					.prepare(
						`INSERT INTO rc_outbox (id,kind,payload_json,state,attempts,available_at,last_error,created_at,updated_at) VALUES (?,'invalid','{}','review',0,?,'INVALID_QUEUE_MESSAGE',?,?) ON CONFLICT(id) DO NOTHING`,
					)
					.bind(`invalid:${message.id}`, now, now, now)
					.run();
				message.ack();
				continue;
			}
			lease = await claimJob(message.body.id, options);
			if (!lease) {
				const persisted = await options.db
					.prepare("SELECT state FROM rc_outbox WHERE id=?")
					.bind(message.body.id)
					.first<{ state: string }>();
				if (persisted) message.ack();
				else message.retry({ delaySeconds: 30 });
				continue;
			}
			const disposition = await executeJob(lease, options);
			if (await finishJob(lease, disposition, options)) message.ack();
			else message.retry({ delaySeconds: 30 });
		} catch (error) {
			if (!lease) {
				message.retry({ delaySeconds: 30 });
				continue;
			}
			const retryable = !(error instanceof IntegrationError) || error.retryable;
			const delay = Math.max(
				Math.min(300_000, 1000 * 2 ** Math.min(lease.attempts, 8)),
				error instanceof ProviderError ? error.retryAfterMs : 0,
			);
			try {
				const persisted = await finishJob(
					lease,
					{
						state: retryable && lease.attempts < 8 ? "pending" : "review",
						delayMs: delay,
						error: error instanceof IntegrationError ? error.code : "JOB_EXECUTION_FAILED",
					},
					options,
				);
				if (persisted) message.ack();
				else message.retry({ delaySeconds: 30 });
			} catch {
				message.retry({ delaySeconds: 30 });
			}
		}
	}
}

export async function recoverJobs(
	options: IntegrationOptions,
): Promise<{ expired: number; unknownInvoices: number }> {
	const now = clock(options);
	const results = await options.db.batch([
		options.db
			.prepare(
				`UPDATE rc_invoices SET status='outcome_unknown',last_error='DISPATCH_LEASE_EXPIRED',version=version+1,updated_at=? WHERE status='dispatching' AND EXISTS (SELECT 1 FROM rc_outbox WHERE lease_token=rc_invoices.dispatch_token AND state='running' AND lease_until<=?)`,
			)
			.bind(now, now),
		options.db
			.prepare(
				`UPDATE rc_outbox SET state='pending',available_at=?,lease_token=NULL,lease_until=NULL,last_error='LEASE_EXPIRED',updated_at=? WHERE state='running' AND lease_until<=?`,
			)
			.bind(now, now, now),
	]);
	for (const [contextId, context] of Object.entries(options.contexts)) {
		if (!context.bankApiToken) continue;
		const hour = Math.floor(now / 3600_000) * 3600_000;
		const from = new Date(hour - 48 * 3600_000).toISOString();
		const to = new Date(hour).toISOString();
		await options.db
			.prepare(
				`INSERT INTO rc_outbox (id,kind,payload_json,state,attempts,available_at,created_at,updated_at) VALUES (?,'bank.reconcile',?,'pending',0,?,?,?) ON CONFLICT(id) DO NOTHING`,
			)
			.bind(
				`bank:${contextId}:${from}:${to}:1`,
				JSON.stringify({ contextId, from, to, page: 1 }),
				now,
				now,
				now,
			)
			.run();
	}
	return { expired: results[1]?.meta.changes ?? 0, unknownInvoices: results[0]?.meta.changes ?? 0 };
}

export async function dispatchOutbox(
	options: IntegrationOptions,
): Promise<{ configured: boolean; published: number; failed: number }> {
	if (!options.queue) return { configured: false, published: 0, failed: 0 };
	const now = clock(options);
	const due = await options.db
		.prepare(
			`SELECT id FROM rc_outbox WHERE state='pending' AND available_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY available_at,id LIMIT 50`,
		)
		.bind(now, now)
		.all<{ id: string }>();
	let published = 0;
	let failed = 0;
	for (const row of due.results) {
		try {
			await options.queue.send({ id: row.id });
			await options.db
				.prepare(`UPDATE rc_outbox SET lease_until=?,updated_at=? WHERE id=? AND state='pending'`)
				.bind(now + 30_000, now, row.id)
				.run();
			published++;
		} catch {
			failed++;
			await options.db
				.prepare(
					`UPDATE rc_outbox SET last_error='QUEUE_PUBLISH_FAILED',updated_at=? WHERE id=? AND state='pending'`,
				)
				.bind(now, row.id)
				.run();
		}
	}
	return { configured: true, published, failed };
}
