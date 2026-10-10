import type { D1Database, Queue } from "@cloudflare/workers-types";

export type Environment = "sandbox" | "live";
export interface CredentialContext {
	environment: Environment;
	webhook: { mode: "hmac" | "apikey"; secret: string };
	bankApiToken?: string;
	invoice?: { clientId: string; clientSecret: string };
}
export interface IntegrationOptions {
	db: D1Database;
	queue?: Queue<{ id: string }>;
	contexts: Record<string, CredentialContext>;
	fetch?: typeof fetch;
	now?: () => number;
}
export interface JobLease {
	id: string;
	kind: string;
	payload_json: string;
	attempts: number;
	lease_token: string;
	lease_until: number;
	created_at: number;
}
export interface InvoiceRow {
	id: string;
	branch_id: string;
	kind: "original" | "adjustment" | "replacement";
	status: string;
	version: number;
	reference: string;
	payload_json: string;
	issue_payload_json: string | null;
	credential_context: string;
	environment: Environment;
	create_tracking_code: string | null;
	issue_tracking_code: string | null;
	provider_json: string | null;
	dispatch_token: string | null;
	last_operation: string | null;
}
export class IntegrationError extends Error {
	constructor(
		public readonly code: string,
		public readonly status = 502,
		public readonly retryable = false,
	) {
		super(code);
		this.name = "IntegrationError";
	}
}
export function clock(options: IntegrationOptions): number {
	return options.now?.() ?? Date.now();
}
export function contextFor(
	options: IntegrationOptions,
	id: string,
	environment?: string,
): CredentialContext {
	const context = Object.hasOwn(options.contexts, id) ? options.contexts[id] : undefined;
	if (
		!context ||
		!["sandbox", "live"].includes(context.environment) ||
		(environment && context.environment !== environment)
	) {
		throw new IntegrationError("CREDENTIAL_CONTEXT_UNAVAILABLE", 503);
	}
	return context;
}
export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new IntegrationError("INVALID_PROVIDER_RESPONSE");
	return value as Record<string, unknown>;
}
export function string(value: unknown, max = 512): string {
	if (typeof value !== "string" || !value.length || value.length > max)
		throw new IntegrationError("INVALID_PROVIDER_RESPONSE");
	return value;
}
