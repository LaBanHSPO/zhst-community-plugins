/**
 * AWS Signature Version 4 for S3-compatible object storage.
 *
 * Implemented directly on WebCrypto so the plugin needs no AWS SDK and runs
 * unchanged on Workers and Node. Verified against the published
 * `aws-sig-v4-test-suite` vectors in `tests/sigv4.test.ts`.
 */

const encoder = new TextEncoder();

/** sha256 of an empty body; S3 requires a real payload hash for header-signed requests. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface AwsCredentials {
	accessKeyId: string;
	secretAccessKey: string;
}

export interface SignRequestInput {
	method: string;
	/** Already percent-encoded once; the same value must be sent on the wire. */
	path: string;
	/** Already percent-encoded query string without the leading `?`, or `""`. */
	query: string;
	/** Headers to sign: lower-case names, exact values. */
	headers: Record<string, string>;
	/** Hex sha256 of the request payload, or `UNSIGNED-PAYLOAD`. */
	payloadHash: string;
	credentials: AwsCredentials;
	region: string;
	service: string;
	timestamp: number;
}

export interface SignResult {
	authorization: string;
	amzDate: string;
	scope: string;
	canonicalRequest: string;
	stringToSign: string;
	signature: string;
}

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

async function sha256Hex(value: string): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmacSign(key: Uint8Array, value: string): Promise<ArrayBuffer> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key as unknown as ArrayBuffer,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
	return new Uint8Array(await hmacSign(key, value));
}

export function amzDate(timestamp: number): string {
	const iso = new Date(timestamp).toISOString();
	return `${iso.slice(0, 10).replaceAll("-", "")}T${iso.slice(11, 19).replaceAll(":", "")}Z`;
}

export function dateStamp(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10).replaceAll("-", "");
}

/** RFC 3986 encoding, the only form accepted in a canonical request. */
export function uriEncode(value: string, encodeSlash = true): string {
	let out = "";
	for (const char of value) {
		if (/[A-Za-z0-9\-._~]/.test(char)) out += char;
		else if (char === "/" && !encodeSlash) out += char;
		else out += encoder.encode(char).reduce((acc, byte) => acc + `%${byte.toString(16).toUpperCase().padStart(2, "0")}`, "");
	}
	return out;
}

export function canonicalQueryString(params: Record<string, string>): string {
	return Object.keys(params)
		.sort()
		.map((key) => `${uriEncode(key)}=${uriEncode(params[key] ?? "")}`)
		.join("&");
}

function canonicalHeaderValue(value: string): string {
	return value.trim().replace(/ +/g, " ");
}

export async function signRequest(input: SignRequestInput): Promise<SignResult> {
	const names = Object.keys(input.headers)
		.map((name) => name.toLowerCase())
		.sort();
	const canonicalHeaders = names
		.map((name) => `${name}:${canonicalHeaderValue(input.headers[name] ?? "")}\n`)
		.join("");
	const signedHeaders = names.join(";");
	const canonicalRequest = [
		input.method.toUpperCase(),
		input.path,
		input.query,
		canonicalHeaders,
		signedHeaders,
		input.payloadHash,
	].join("\n");

	const stamp = dateStamp(input.timestamp);
	const scope = `${stamp}/${input.region}/${input.service}/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate(input.timestamp),
		scope,
		await sha256Hex(canonicalRequest),
	].join("\n");

	const secret = encoder.encode(`AWS4${input.credentials.secretAccessKey}`);
	const signingKey = await hmac(
		await hmac(await hmac(await hmac(secret, stamp), input.region), input.service),
		"aws4_request",
	);
	const signature = toHex(await hmacSign(signingKey, stringToSign));

	return {
		authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
		amzDate: amzDate(input.timestamp),
		scope,
		canonicalRequest,
		stringToSign,
		signature,
	};
}

export interface SignS3Input {
	url: URL;
	method: string;
	payloadHash: string;
	/** Extra headers to send and sign, e.g. `content-type` and `range`. */
	headers?: Record<string, string>;
	credentials: AwsCredentials;
	region: string;
	timestamp: number;
}

/**
 * Sign an S3 request. The returned map carries every header the caller must
 * send; the URL itself is never modified. `x-amz-date` and
 * `x-amz-content-sha256` are signed as well as sent, because S3 rejects any
 * `x-amz-*` header that is present on the wire but absent from `SignedHeaders`.
 */
export async function signS3(input: SignS3Input): Promise<Record<string, string>> {
	const headers: Record<string, string> = {
		host: input.url.host,
		"x-amz-date": amzDate(input.timestamp),
		"x-amz-content-sha256": input.payloadHash,
	};
	for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value;
	const result = await signRequest({
		method: input.method,
		path: input.url.pathname,
		query: input.url.search.startsWith("?") ? input.url.search.slice(1) : "",
		headers,
		payloadHash: input.payloadHash,
		credentials: input.credentials,
		region: input.region,
		service: "s3",
		timestamp: input.timestamp,
	});
	const sent: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) if (name !== "host") sent[name] = value;
	sent.authorization = result.authorization;
	return sent;
}
