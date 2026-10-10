export class RestaurantRequestError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "RestaurantRequestError";
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function request<T>(
	action: string,
	input: Record<string, unknown> = {},
	options: { mutation?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
	const url = new URL(`/api/restaurant/${encodeURIComponent(action)}`, window.location.origin);
	if (!options.mutation)
		for (const [key, value] of Object.entries(input))
			if (value !== undefined) url.searchParams.set(key, String(value));
	const response = await fetch(url, {
		method: options.mutation ? "POST" : "GET",
		credentials: "same-origin",
		headers: options.mutation
			? { "Content-Type": "application/json", "X-EmDash-Request": "1" }
			: undefined,
		body: options.mutation ? JSON.stringify(input) : undefined,
		signal: options.signal,
	});
	let result: unknown;
	try {
		result = await response.json();
	} catch {
		throw new RestaurantRequestError("INVALID_RESPONSE", "Invalid response");
	}
	if (!record(result) || typeof result.ok !== "boolean")
		throw new RestaurantRequestError("INVALID_RESPONSE", "Invalid response");
	if (!result.ok) {
		const error = record(result.error) ? result.error : {};
		throw new RestaurantRequestError(
			typeof error.code === "string" ? error.code : "REQUEST_FAILED",
			typeof error.message === "string" ? error.message : "Request failed",
		);
	}
	if (!response.ok || !("data" in result))
		throw new RestaurantRequestError("INVALID_RESPONSE", "Invalid response");
	return result.data as T;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (record(value))
		return `{${Object.keys(value)
			.sort()
			.filter((key) => value[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

/** A failed transport may have committed: retain its identity until the payload changes. */
export class CommandIdentity {
	private fingerprint = "";
	private id = "";
	constructor(private readonly createId: () => string = () => crypto.randomUUID()) {}
	for(action: string, input: Record<string, unknown>): string {
		const fingerprint = `${action}:${canonical(input)}`;
		if (fingerprint !== this.fingerprint) {
			this.fingerprint = fingerprint;
			this.id = this.createId();
		}
		return this.id;
	}
	complete(): void {
		this.fingerprint = "";
		this.id = "";
	}
}

export function money(amount: number, locale = "vi"): string {
	return new Intl.NumberFormat(locale === "ar" ? "ar" : "vi-VN", {
		style: "currency",
		currency: "VND",
		maximumFractionDigits: 0,
	}).format(amount);
}

export function safeImage(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value, "https://restaurant.invalid");
		return url.protocol === "https:" || (value.startsWith("/") && !value.startsWith("//"))
			? value
			: undefined;
	} catch {
		return undefined;
	}
}
