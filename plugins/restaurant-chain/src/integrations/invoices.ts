import { InvoiceClient, ProviderError } from "./http.js";
import {
	clock,
	contextFor,
	IntegrationError,
	object,
	string,
	type IntegrationOptions,
	type InvoiceRow,
	type JobLease,
} from "./types.js";

export interface JobDisposition {
	state: "done" | "pending" | "review";
	delayMs?: number;
	error?: string;
}
const pending = (): JobDisposition => ({ state: "pending", delayMs: 30_000 });

function validatePayload(invoice: InvoiceRow, issue: boolean): string {
	const payload = issue ? invoice.issue_payload_json : invoice.payload_json;
	if (!payload || payload.length > 256_000)
		throw new IntegrationError("INVALID_INVOICE_INTENT", 400);
	const data = object(JSON.parse(payload));
	if (data.reference_code !== invoice.reference)
		throw new IntegrationError("INVOICE_REFERENCE_MISMATCH", 400);
	if (!issue) {
		string(data.provider_account_id);
		if (
			typeof data.is_draft !== "boolean" ||
			!Array.isArray(data.items) ||
			data.items.length < 1 ||
			data.items.length > 500
		)
			throw new IntegrationError("INVALID_INVOICE_INTENT", 400);
		if (invoice.kind !== "original") string(data.original_invoice_reference_code);
		if (
			invoice.kind === "adjustment" &&
			!["increase", "decrease", "combined", "info"].includes(String(data.adjustment_type))
		)
			throw new IntegrationError("INVALID_ADJUSTMENT_TYPE", 400);
	}
	return payload;
}

async function persistInvoice(
	invoice: InvoiceRow,
	lease: JobLease,
	options: IntegrationOptions,
	values: {
		status: string;
		data?: Record<string, unknown>;
		error?: string | null;
		tracking?: string;
		operation?: string;
	},
): Promise<boolean> {
	const now = clock(options);
	const data = values.data;
	const taxStatus = data?.provider_status === undefined ? null : String(data.provider_status);
	const result = await options.db.batch([
		options.db
			.prepare(
				`UPDATE rc_invoices SET status=?,provider_json=COALESCE(?,provider_json),provider_id=COALESCE(?,provider_id),tax_authority_status=COALESCE(?,tax_authority_status),last_error=?,create_tracking_code=CASE WHEN ? IS NOT NULL AND ?<>'issue' THEN ? ELSE create_tracking_code END,issue_tracking_code=CASE WHEN ? IS NOT NULL AND ?='issue' THEN ? ELSE issue_tracking_code END,version=version+1,updated_at=? WHERE id=? AND version=? AND (dispatch_token IS ? OR dispatch_token=?) AND EXISTS (SELECT 1 FROM rc_outbox WHERE id=? AND state='running' AND lease_token=? AND lease_until>?)`,
			)
			.bind(
				values.status,
				data ? JSON.stringify(data) : null,
				typeof data?.id === "string" ? data.id : null,
				taxStatus,
				values.error ?? null,
				values.tracking ?? null,
				values.operation ?? "",
				values.tracking ?? null,
				values.tracking ?? null,
				values.operation ?? "",
				values.tracking ?? null,
				now,
				invoice.id,
				invoice.version,
				invoice.dispatch_token,
				lease.lease_token,
				lease.id,
				lease.lease_token,
				now,
			),
		options.db
			.prepare(
				`INSERT INTO rc_audit (id,branch_id,actor_id,action,entity_id,detail_json,created_at) SELECT ?,?,NULL,'invoice.state',?,?,? WHERE changes()>0`,
			)
			.bind(
				crypto.randomUUID(),
				invoice.branch_id,
				invoice.id,
				JSON.stringify({
					status: values.status,
					operation: values.operation ?? invoice.last_operation,
					error: values.error ?? null,
				}),
				now,
			),
		options.db
			.prepare(
				`INSERT INTO rc_outbox (id,kind,payload_json,state,attempts,available_at,created_at,updated_at) SELECT 'invoice:original:'||id,'invoice.reconcile',json_object('invoiceId',original_invoice_id),'pending',0,?,?,? FROM rc_invoices WHERE id=? AND kind IN ('adjustment','replacement') AND original_invoice_id IS NOT NULL AND status='issued' AND changes()>0 ON CONFLICT(id) DO NOTHING`,
			)
			.bind(now, now, now, invoice.id),
	]);
	const changed = (result[0]?.meta.changes ?? 0) > 0;
	if (changed) invoice.version++;
	return changed;
}

function providerStatus(data: Record<string, unknown>): "draft" | "issued" | "cancelled" {
	if (data.status !== "draft" && data.status !== "issued" && data.status !== "cancelled")
		throw new IntegrationError("UNRECOGNIZED_INVOICE_STATUS");
	return data.status;
}

async function reconcile(
	invoice: InvoiceRow,
	lease: JobLease,
	client: InvoiceClient,
	options: IntegrationOptions,
): Promise<JobDisposition> {
	try {
		const data = await client.request(`/invoices/${encodeURIComponent(invoice.reference)}`);
		if (data.reference_code !== invoice.reference)
			throw new IntegrationError("INVOICE_REFERENCE_MISMATCH");
		const status = providerStatus(data);
		const unresolvedIssue =
			invoice.status === "outcome_unknown" &&
			status === "draft" &&
			(invoice.last_operation === "issue" ||
				object(JSON.parse(invoice.payload_json)).is_draft !== true);
		await persistInvoice(invoice, lease, options, {
			status: unresolvedIssue ? "outcome_unknown" : status,
			data,
			error: unresolvedIssue ? "ISSUANCE_OUTCOME_UNRESOLVED" : null,
		});
		return unresolvedIssue
			? { state: "review", error: "ISSUANCE_OUTCOME_UNRESOLVED" }
			: { state: "done" };
	} catch (error) {
		if (error instanceof ProviderError && error.status === 404) {
			await persistInvoice(invoice, lease, options, {
				status: "outcome_unknown",
				error: "REFERENCE_NOT_FOUND_OUTCOME_UNRESOLVED",
			});
			return { state: "review", error: "REFERENCE_NOT_FOUND_OUTCOME_UNRESOLVED" };
		}
		throw error;
	}
}

async function poll(
	invoice: InvoiceRow,
	lease: JobLease,
	client: InvoiceClient,
	options: IntegrationOptions,
): Promise<JobDisposition> {
	const issue = invoice.last_operation === "issue";
	const tracking = issue ? invoice.issue_tracking_code : invoice.create_tracking_code;
	if (!tracking) {
		await persistInvoice(invoice, lease, options, {
			status: "outcome_unknown",
			error: "TRACKING_CODE_MISSING",
		});
		return { state: "review", error: "TRACKING_CODE_MISSING" };
	}
	const data = await client.request(
		`/invoices/${issue ? "issue" : "create"}/check/${encodeURIComponent(tracking)}`,
	);
	if (data.status === "Pending") {
		await persistInvoice(invoice, lease, options, { status: "pending", data });
		return clock(options) - lease.created_at < 24 * 60 * 60_000
			? pending()
			: { state: "review", error: "PROVIDER_PENDING_OVER_24_HOURS" };
	}
	if (data.status === "Failed") {
		// Failed can include an unknown provider/CQT outcome; only a reference lookup is safe.
		await persistInvoice(invoice, lease, options, {
			status: "outcome_unknown",
			data,
			error:
				typeof data.message === "string" ? data.message.slice(0, 2000) : "PROVIDER_ASYNC_FAILED",
		});
		return { state: "review", error: "PROVIDER_ASYNC_FAILED_RECONCILE_REQUIRED" };
	}
	if (data.status !== "Success") throw new IntegrationError("UNRECOGNIZED_TRACKING_STATUS");
	const remote = data.invoice
		? object(data.invoice)
		: await client.request(`/invoices/${encodeURIComponent(invoice.reference)}`);
	if (remote.reference_code !== invoice.reference)
		throw new IntegrationError("INVOICE_REFERENCE_MISMATCH");
	const status = providerStatus(remote);
	if (issue && status === "draft") {
		await persistInvoice(invoice, lease, options, {
			status: "outcome_unknown",
			data: remote,
			error: "ISSUE_SUCCESS_WITH_DRAFT",
		});
		return { state: "review", error: "ISSUE_SUCCESS_WITH_DRAFT" };
	}
	await persistInvoice(invoice, lease, options, { status, data: remote });
	return { state: "done" };
}

export async function processInvoice(
	invoiceId: string,
	lease: JobLease,
	options: IntegrationOptions,
): Promise<JobDisposition> {
	const invoice = await options.db
		.prepare("SELECT * FROM rc_invoices WHERE id=?")
		.bind(invoiceId)
		.first<InvoiceRow>();
	if (!invoice) return { state: "review", error: "INVOICE_NOT_FOUND" };
	const client = new InvoiceClient(
		options,
		contextFor(options, invoice.credential_context, invoice.environment),
	);
	if (lease.kind === "invoice.reconcile" || invoice.status === "outcome_unknown")
		return reconcile(invoice, lease, client, options);
	if (invoice.status === "pending") return poll(invoice, lease, client, options);
	if (invoice.status === "dispatching") {
		await persistInvoice(invoice, lease, options, {
			status: "outcome_unknown",
			error: "DISPATCH_INTERRUPTED",
		});
		return { state: "review", error: "DISPATCH_INTERRUPTED" };
	}
	if (["issued", "cancelled"].includes(invoice.status)) return { state: "done" };
	if (invoice.status === "failed") return { state: "review", error: "PROVIDER_REQUEST_FAILED" };
	const issue = lease.kind === "invoice.issue";
	if (!issue && invoice.status === "draft") return { state: "done" };
	if (invoice.status !== "queued") return { state: "review", error: "INVOICE_STATE_CONFLICT" };
	const payload = validatePayload(invoice, issue);
	await client.authorize();
	const operation = issue
		? "issue"
		: invoice.kind === "adjustment"
			? "adjust"
			: invoice.kind === "replacement"
				? "replace"
				: "create";
	const now = clock(options);
	const claimed = await options.db
		.prepare(
			`UPDATE rc_invoices SET status='dispatching',dispatch_token=?,dispatch_at=?,last_operation=?,version=version+1,updated_at=? WHERE id=? AND status=? AND version=? AND EXISTS (SELECT 1 FROM rc_outbox WHERE id=? AND state='running' AND lease_token=? AND lease_until>?)`,
		)
		.bind(
			lease.lease_token,
			now,
			operation,
			now,
			invoice.id,
			invoice.status,
			invoice.version,
			lease.id,
			lease.lease_token,
			now,
		)
		.run();
	if (!claimed.meta.changes) return { state: "pending", delayMs: 30_000 };
	invoice.version++;
	invoice.dispatch_token = lease.lease_token;
	invoice.last_operation = operation;
	let data: Record<string, unknown>;
	try {
		data = await client.request(`/invoices/${operation}`, payload);
		string(data.tracking_code);
	} catch (error) {
		const definitive = error instanceof ProviderError && error.definitive;
		const code = error instanceof IntegrationError ? error.code : "INVOICE_SUBMISSION_UNKNOWN";
		await persistInvoice(invoice, lease, options, {
			status: definitive ? "failed" : "outcome_unknown",
			error: code,
		});
		return { state: "review", error: code };
	}
	await persistInvoice(invoice, lease, options, {
		status: "pending",
		data,
		tracking: string(data.tracking_code),
		operation,
	});
	return pending();
}

export async function getInvoiceDetail(
	invoiceId: string,
	options: IntegrationOptions,
): Promise<Record<string, unknown>> {
	const invoice = await options.db
		.prepare("SELECT * FROM rc_invoices WHERE id=?")
		.bind(invoiceId)
		.first<InvoiceRow>();
	if (!invoice) throw new IntegrationError("INVOICE_NOT_FOUND", 404);
	return new InvoiceClient(
		options,
		contextFor(options, invoice.credential_context, invoice.environment),
	).request(`/invoices/${encodeURIComponent(invoice.reference)}`);
}

export async function downloadInvoice(
	invoiceId: string,
	type: "pdf" | "xml",
	options: IntegrationOptions,
): Promise<Response> {
	if (type !== "pdf" && type !== "xml") throw new IntegrationError("INVALID_FILE_TYPE", 400);
	const invoice = await options.db
		.prepare("SELECT * FROM rc_invoices WHERE id=?")
		.bind(invoiceId)
		.first<InvoiceRow>();
	if (!invoice) throw new IntegrationError("INVOICE_NOT_FOUND", 404);
	if (invoice.status !== "issued") throw new IntegrationError("INVOICE_NOT_ISSUED", 409);
	const tracking = invoice.issue_tracking_code ?? invoice.create_tracking_code;
	if (!tracking) throw new IntegrationError("TRACKING_CODE_MISSING", 409);
	const client = new InvoiceClient(
		options,
		contextFor(options, invoice.credential_context, invoice.environment),
	);
	const data = await client.request(
		`/invoices/${encodeURIComponent(tracking)}/download?type=${type}`,
		undefined,
		8 * 1024 * 1024,
	);
	if (data.file_type !== type) throw new IntegrationError("INVALID_FILE_TYPE");
	const content = string(data.content, 8 * 1024 * 1024);
	if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content))
		throw new IntegrationError("INVALID_INVOICE_FILE");
	let binary: string;
	try {
		binary = atob(content);
	} catch {
		throw new IntegrationError("INVALID_INVOICE_FILE");
	}
	if (type === "pdf" && !binary.startsWith("%PDF-"))
		throw new IntegrationError("INVALID_INVOICE_FILE");
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return new Response(bytes, {
		headers: {
			"Content-Type": type === "pdf" ? "application/pdf" : "application/xml",
			"Content-Disposition": `attachment; filename="invoice-${invoice.id.replace(/[^a-zA-Z0-9_-]/g, "")}.${type}"`,
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
