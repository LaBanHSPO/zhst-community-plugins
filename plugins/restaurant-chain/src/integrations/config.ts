import { IntegrationError, object, type CredentialContext } from "./types.js";

export function parseCredentialContexts(raw: string): Record<string, CredentialContext> {
	try {
		if (!raw || raw.length > 256_000) throw new Error("Invalid configuration size");
		const input = object(JSON.parse(raw));
		if (Object.keys(input).length > 100) throw new Error("Too many credential contexts");
		const contexts: Record<string, CredentialContext> = Object.create(null);
		for (const [id, value] of Object.entries(input)) {
			if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid context identifier");
			const context = object(value);
			if (context.environment !== "sandbox" && context.environment !== "live")
				throw new Error("Invalid environment");
			const webhook = object(context.webhook);
			if (
				(webhook.mode !== "hmac" && webhook.mode !== "apikey") ||
				typeof webhook.secret !== "string" ||
				webhook.secret.length < 16 ||
				webhook.secret.length > 4096
			)
				throw new Error("Invalid webhook credentials");
			const parsed: CredentialContext = {
				environment: context.environment,
				webhook: { mode: webhook.mode, secret: webhook.secret },
			};
			if (context.bankApiToken !== undefined) {
				if (
					typeof context.bankApiToken !== "string" ||
					!/^[A-Za-z0-9]{64}$/.test(context.bankApiToken)
				)
					throw new Error("Invalid bank API token");
				parsed.bankApiToken = context.bankApiToken;
			}
			if (context.invoice !== undefined) {
				const invoice = object(context.invoice);
				if (
					typeof invoice.clientId !== "string" ||
					!invoice.clientId ||
					invoice.clientId.length > 512 ||
					invoice.clientId.includes(":") ||
					typeof invoice.clientSecret !== "string" ||
					!invoice.clientSecret ||
					invoice.clientSecret.length > 4096
				)
					throw new Error("Invalid invoice credentials");
				parsed.invoice = { clientId: invoice.clientId, clientSecret: invoice.clientSecret };
			}
			contexts[id] = parsed;
		}
		return contexts;
	} catch {
		throw new IntegrationError("INVALID_CREDENTIAL_CONFIGURATION", 503);
	}
}
