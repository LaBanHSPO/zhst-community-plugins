/**
 * Shared value helpers: errors, hashing, key naming and row mapping.
 *
 * Every function here is runtime-portable (Workers and Node): no Node built-ins,
 * only WebCrypto and standard language features.
 */

import type { OtaRelease, OtaPlatform, OtaAuditEvent } from "./types.js";
import { isOtaPlatform } from "./types.js";

/** Spec default: a bundle may not exceed 100 MiB. */
export const DEFAULT_MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
/** Spec default: a release not pushed again within this window is removed. */
export const DEFAULT_RETENTION_DAYS = 14;
/** Spec default: current build plus the one before it. */
export const KEEP_PER_BINARY = 2;
export const BUNDLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const MANIFEST_CACHE_CONTROL = "no-cache";
export const BUNDLE_CONTENT_TYPE = "application/octet-stream";
/** Admin sends this as `r2.secret` to remove a stored secret without re-entering it. */
export const CLEAR_SECRET = "__clear__";

export class OtaError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "OtaError";
	}
}

export function requireObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new OtaError("INVALID_INPUT", "A JSON object is required.", 400);
	return value as Record<string, unknown>;
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let out = "";
	for (const byte of view) out += byte.toString(16).padStart(2, "0");
	return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
}

/** Length-independent comparison, so a wrong token cannot be probed byte by byte. */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return diff === 0;
}

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

/** 32 random bytes rendered as an unguessable push token. */
export function createToken(): string {
	return `otak_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function tokenPrefix(token: string): string {
	return token.slice(0, 13);
}

export function newId(): string {
	return crypto.randomUUID();
}

/** `YYYYMMDD-HHMMSS` in UTC, the manifest `id` format. */
export function releaseIdFor(timestamp: number): string {
	const iso = new Date(timestamp).toISOString();
	return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

/**
 * Path segment for a channel inside a bundle key. Branches contain `/`, which
 * cannot appear in the generated file name, so each unsafe run collapses to `_`.
 */
export function channelSlug(channel: string): string {
	const slug = channel.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
	return slug === "" ? "default" : slug.slice(0, 120);
}

export function bundleFile(channel: string, binary: string, releaseId: string): string {
	return `bundles/${channelSlug(channel)}/${binary}/${releaseId}.bundle`;
}

/** Storage key for an app/platform scoped object. */
export function blobKey(app: string, platform: string, file: string): string {
	return `${app}/${platform}/${file}`;
}

export function releasePrefix(app: string, platform: string): string {
	return `${app}/${platform}/`;
}

export function isoOrNull(value: unknown): string | null {
	return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

export interface ReleaseRow {
	id: string;
	app: string;
	platform: string;
	channel: string;
	binary: string;
	release_id: string;
	file: string;
	sha256: string;
	size: number;
	note: string;
	commit_sha: string;
	signature: string;
	mandatory: number;
	branch: string;
	created_at: number;
}

export function releaseFromRow(row: ReleaseRow, current: boolean): OtaRelease {
	if (!isOtaPlatform(row.platform))
		throw new OtaError("CORRUPT_ROW", "Stored release has an unknown platform.", 500);
	return {
		id: row.id,
		app: row.app,
		platform: row.platform as OtaPlatform,
		channel: row.channel,
		binary: row.binary,
		releaseId: row.release_id,
		file: row.file,
		sha256: row.sha256,
		size: row.size,
		note: row.note,
		commit: row.commit_sha,
		signature: row.signature,
		mandatory: row.mandatory === 1,
		branch: row.branch,
		selected: current,
		createdAt: new Date(row.created_at).toISOString(),
	};
}

export interface AuditRow {
	id: string;
	action: string;
	actor_id: string | null;
	actor_kind: string;
	app: string | null;
	platform: string | null;
	channel: string | null;
	binary: string | null;
	detail_json: string;
	created_at: number;
}

export function auditFromRow(row: AuditRow): OtaAuditEvent {
	let detail: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(row.detail_json);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
			detail = parsed as Record<string, unknown>;
	} catch {
		detail = {};
	}
	return {
		id: row.id,
		action: row.action,
		actorId: row.actor_id,
		actorKind: row.actor_kind,
		app: row.app,
		platform: row.platform,
		channel: row.channel,
		binary: row.binary,
		detail,
		createdAt: new Date(row.created_at).toISOString(),
	};
}

/** Human-readable byte count with one decimal place, for admin summaries. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${unit === 0 ? value : Math.round(value * 10) / 10} ${units[unit]}`;
}

/**
 * Release-list cursor. The order key is `(created_at, id)`, so the cursor keeps
 * both: paging on the timestamp alone would skip rows that share a millisecond.
 */
export function encodeCursor(createdAt: number, id: string): string {
	return btoa(`${createdAt}:${id}`).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function decodeCursor(value: string): { createdAt: number; id: string } | null {
	try {
		const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
		const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
		const separator = decoded.indexOf(":");
		if (separator <= 0) return null;
		const createdAt = Number(decoded.slice(0, separator));
		const id = decoded.slice(separator + 1);
		if (!Number.isSafeInteger(createdAt) || id === "") return null;
		return { createdAt, id };
	} catch {
		return null;
	}
}
