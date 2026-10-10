import {
	IntegrationError,
	object,
	string,
	clock,
	type CredentialContext,
	type IntegrationOptions,
} from "./types.js";

export async function boundedBytes(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
): Promise<Uint8Array> {
	if (!body) return new Uint8Array();
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new IntegrationError("BODY_READ_TIMEOUT", 408, true)), 12_000);
	});
	try {
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), deadline]);
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel();
				throw new IntegrationError("BODY_TOO_LARGE", 413);
			}
			chunks.push(value);
		}
	} catch (error) {
		try {
			await reader.cancel(error);
		} finally {
			throw error;
		}
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

export class ProviderError extends IntegrationError {
	constructor(
		code: string,
		status: number,
		public readonly definitive: boolean,
		public readonly retryAfterMs = 0,
	) {
		super(code, status, status === 429 || status >= 500);
	}
}

export async function requestJson(
	options: IntegrationOptions,
	url: string,
	init: RequestInit = {},
	limit = 1024 * 1024,
): Promise<Record<string, unknown>> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 12_000);
	try {
		const response = await (options.fetch ?? fetch)(url, {
			...init,
			redirect: "error",
			signal: controller.signal,
		});
		const bytes = await boundedBytes(response.body, limit);
		let json: Record<string, unknown>;
		try {
			json = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
		} catch {
			throw new ProviderError("INVALID_PROVIDER_RESPONSE", response.status, false);
		}
		if (!response.ok || json.success === false) {
			const error = json.error && typeof json.error === "object" ? object(json.error) : {};
			const code =
				typeof error.code === "string"
					? error.code.slice(0, 160)
					: `PROVIDER_HTTP_${response.status}`;
			const retry = Number(response.headers.get("Retry-After"));
			const definitive =
				json.success === false &&
				([400, 401, 403, 422].includes(response.status) ||
					["QUOTA_HAS_BEEN_USERD_UP", "REGISTRATION_NOT_COMPLETE", "BILLING_IS_UNPAID"].includes(
						code,
					));
			throw new ProviderError(
				code,
				response.status,
				definitive,
				Number.isFinite(retry) ? Math.min(Math.max(retry, 0), 3600) * 1000 : 0,
			);
		}
		return json;
	} catch (error) {
		if (error instanceof IntegrationError) throw error;
		throw new ProviderError("PROVIDER_TRANSPORT_UNKNOWN", 502, false);
	} finally {
		clearTimeout(timer);
	}
}

export class InvoiceClient {
	private token: { value: string; expiresAt: number } | undefined;
	readonly base: string;
	constructor(
		private readonly options: IntegrationOptions,
		private readonly context: CredentialContext,
	) {
		this.base =
			context.environment === "sandbox"
				? "https://einvoice-api-sandbox.sepay.vn"
				: "https://einvoice-api.sepay.vn";
	}
	async authorize(): Promise<string> {
		if (this.token && this.token.expiresAt > clock(this.options) + 60_000) return this.token.value;
		const credentials = this.context.invoice;
		if (!credentials?.clientId || !credentials.clientSecret)
			throw new IntegrationError("INVOICE_CREDENTIALS_UNAVAILABLE", 503);
		const basic = btoa(
			String.fromCharCode(
				...new TextEncoder().encode(`${credentials.clientId}:${credentials.clientSecret}`),
			),
		);
		const response = await requestJson(this.options, `${this.base}/v1/token`, {
			method: "POST",
			headers: { Authorization: `Basic ${basic}` },
		});
		const data = object(response.data);
		const value = string(data.access_token, 16_384);
		if (
			data.token_type !== "Bearer" ||
			typeof data.expires_in !== "number" ||
			data.expires_in <= 0 ||
			!Number.isFinite(data.expires_in)
		)
			throw new IntegrationError("INVALID_TOKEN_RESPONSE");
		this.token = {
			value,
			expiresAt: clock(this.options) + Math.min(data.expires_in, 86400) * 1000,
		};
		return value;
	}
	async request(path: string, body?: string, maxBytes?: number): Promise<Record<string, unknown>> {
		const token = await this.authorize();
		try {
			const response = await requestJson(
				this.options,
				`${this.base}/v1${path}`,
				{
					method: body === undefined ? "GET" : "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						...(body === undefined ? {} : { "Content-Type": "application/json" }),
					},
					...(body === undefined ? {} : { body }),
				},
				maxBytes,
			);
			if (response.success !== true) throw new IntegrationError("INVALID_PROVIDER_RESPONSE");
			return object(response.data);
		} catch (error) {
			if (error instanceof ProviderError && error.status === 401) {
				this.token = undefined;
				if (body === undefined) {
					const refreshed = await this.authorize();
					const response = await requestJson(
						this.options,
						`${this.base}/v1${path}`,
						{ headers: { Authorization: `Bearer ${refreshed}` } },
						maxBytes,
					);
					if (response.success !== true) throw new IntegrationError("INVALID_PROVIDER_RESPONSE");
					return object(response.data);
				}
			}
			throw error;
		}
	}
}
