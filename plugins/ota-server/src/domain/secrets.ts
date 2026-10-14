/**
 * Secret-at-rest handling for stored R2 credentials.
 *
 * The operator supplies one 32-byte key; the plugin never persists a plaintext
 * access key secret. AES-GCM authenticates the ciphertext, so a tampered or
 * truncated value fails closed instead of decrypting to garbage.
 */

import { OtaError } from "./data.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function b64urlDecode(value: string): Uint8Array {
	const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

const KEY_HEX = /^[0-9a-fA-F]{64}$/;
const KEY_BASE64 = /^[A-Za-z0-9+/_-]{43,44}={0,2}$/;

/**
 * Accept a 32-byte key as 64 hex characters or base64/base64url. Returns null
 * for anything else so the caller can fail with an actionable message.
 */
export function parseKeyMaterial(value: string | undefined | null): Uint8Array | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed === "") return null;
	try {
		if (KEY_HEX.test(trimmed)) {
			const bytes = new Uint8Array(32);
			for (let index = 0; index < 32; index += 1)
				bytes[index] = Number.parseInt(trimmed.slice(index * 2, index * 2 + 2), 16);
			return bytes;
		}
		if (KEY_BASE64.test(trimmed)) {
			const bytes = b64urlDecode(trimmed);
			return bytes.byteLength === 32 ? bytes : null;
		}
	} catch {
		return null;
	}
	return null;
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", key as unknown as ArrayBuffer, { name: "AES-GCM" }, false, [
		"encrypt",
		"decrypt",
	]);
}

export async function encryptSecret(plaintext: string, key: Uint8Array): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: iv as unknown as ArrayBuffer },
		await importKey(key),
		encoder.encode(plaintext),
	);
	return `v1.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(payload: string, key: Uint8Array): Promise<string> {
	const parts = payload.split(".");
	if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2])
		throw new OtaError(
			"SECRET_UNREADABLE",
			"The stored storage secret cannot be read. Re-enter it in the OTA storage settings.",
			500,
		);
	try {
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: b64urlDecode(parts[1]) as unknown as ArrayBuffer },
			await importKey(key),
			b64urlDecode(parts[2]) as unknown as ArrayBuffer,
		);
		return decoder.decode(plaintext);
	} catch {
		throw new OtaError(
			"SECRET_UNREADABLE",
			"The stored storage secret cannot be read with the configured key. Re-enter it in the OTA storage settings.",
			500,
		);
	}
}
