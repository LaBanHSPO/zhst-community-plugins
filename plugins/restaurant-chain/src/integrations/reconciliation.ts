import { requestJson } from "./http.js";
import {
	clock,
	contextFor,
	IntegrationError,
	object,
	string,
	type IntegrationOptions,
	type JobLease,
} from "./types.js";

export interface BankReconciliationInput {
	contextId: string;
	from: string;
	to: string;
	page?: number;
	bankAccountId?: string;
}
export async function reconcileBankTransactions(
	input: BankReconciliationInput,
	options: IntegrationOptions,
	lease?: JobLease,
): Promise<{ reviewed: number; nextPage: number | null }> {
	const context = contextFor(options, input.contextId);
	if (!context.bankApiToken) throw new IntegrationError("BANK_API_NOT_CONFIGURED", 503);
	const page = input.page ?? 1;
	const from = Date.parse(input.from);
	const to = Date.parse(input.to);
	if (
		!Number.isSafeInteger(page) ||
		page < 1 ||
		page > 1000 ||
		!Number.isFinite(from) ||
		!Number.isFinite(to) ||
		to < from ||
		to - from > 7 * 86400_000
	)
		throw new IntegrationError("INVALID_RECONCILIATION_RANGE", 400);
	const url = new URL(
		`${context.environment === "sandbox" ? "https://userapi-sandbox.sepay.vn" : "https://userapi.sepay.vn"}/v2/transactions`,
	);
	url.search = new URLSearchParams({
		transaction_date_from: input.from,
		transaction_date_to: input.to,
		page: String(page),
		per_page: "100",
		timestamp_format: "iso8601",
		...(input.bankAccountId ? { bank_account_id: input.bankAccountId } : {}),
	}).toString();
	const response = await requestJson(options, url.toString(), {
		headers: { Authorization: `Bearer ${context.bankApiToken}` },
	});
	if (response.status !== "success" || !Array.isArray(response.data) || response.data.length > 100)
		throw new IntegrationError("INVALID_BANK_API_RESPONSE");
	const pagination = object(object(response.meta).pagination);
	if (typeof pagination.has_more !== "boolean")
		throw new IntegrationError("INVALID_BANK_PAGINATION");
	const now = clock(options);
	for (const value of response.data) {
		const transaction = object(value);
		const providerId = string(transaction.id, 36);
		if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(providerId))
			throw new IntegrationError("INVALID_BANK_TRANSACTION_ID");
		const account = string(transaction.account_number, 100);
		const bank = string(transaction.bank_brand_name, 100);
		const date = string(transaction.transaction_date, 40);
		if (
			!Number.isFinite(Date.parse(date)) ||
			!["in", "out"].includes(String(transaction.transfer_type)) ||
			typeof transaction.amount_in !== "number" ||
			typeof transaction.amount_out !== "number" ||
			!Number.isSafeInteger(transaction.amount_in) ||
			!Number.isSafeInteger(transaction.amount_out) ||
			transaction.amount_in < 0 ||
			transaction.amount_out < 0 ||
			(transaction.va != null && typeof transaction.va !== "string")
		)
			throw new IntegrationError("INVALID_BANK_TRANSACTION");
		const reference =
			typeof transaction.reference_number === "string" ? transaction.reference_number : "";
		const amount =
			transaction.transfer_type === "in" ? transaction.amount_in : transaction.amount_out;
		const normalizedDate = new Date(Date.parse(date) + 7 * 3600_000)
			.toISOString()
			.slice(0, 19)
			.replace("T", " ");
		const candidates = reference
			? await options.db
					.prepare(
						`SELECT id FROM rc_payment_inbox WHERE environment=? AND credential_context=? AND json_extract(payload_json,'$.referenceCode')=? AND json_extract(payload_json,'$.accountNumber')=? AND lower(json_extract(payload_json,'$.gateway'))=lower(?) AND json_extract(payload_json,'$.transferType')=? AND json_extract(payload_json,'$.transferAmount')=? AND json_extract(payload_json,'$.transactionDate')=? AND json_extract(payload_json,'$.subAccount')=? LIMIT 2`,
					)
					.bind(
						context.environment,
						input.contextId,
						reference,
						account,
						bank,
						transaction.transfer_type,
						amount,
						normalizedDate,
						transaction.va ?? "",
					)
					.all<{ id: string }>()
			: { results: [] };
		// A unique business-field match is evidence for review, not a cross-API identity guarantee.
		const match = candidates.results.length === 1 ? (candidates.results[0]?.id ?? null) : null;
		await options.db
			.prepare(
				`INSERT INTO rc_bank_reconciliation (id,environment,credential_context,provider_transaction_id,payload_json,state,matched_inbox_id,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM rc_outbox WHERE id=? AND state='running' AND lease_token=? AND lease_until>?) ON CONFLICT(environment,credential_context,provider_transaction_id) DO UPDATE SET payload_json=excluded.payload_json,state=excluded.state,matched_inbox_id=excluded.matched_inbox_id`,
			)
			.bind(
				`${context.environment}:${input.contextId}:${providerId}`,
				context.environment,
				input.contextId,
				providerId,
				JSON.stringify(transaction),
				match ? "candidate_match" : "identity_review",
				match,
				now,
				lease?.id ?? null,
				lease?.id ?? null,
				lease?.lease_token ?? null,
				now,
			)
			.run();
	}
	if (pagination.has_more && page === 1000)
		throw new IntegrationError("BANK_RECONCILIATION_PAGE_LIMIT", 409);
	return { reviewed: response.data.length, nextPage: pagination.has_more ? page + 1 : null };
}
