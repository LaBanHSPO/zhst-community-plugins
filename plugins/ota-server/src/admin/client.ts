/**
 * Admin API client. Talks to the theme route at `/api/ota/{action}`, which is
 * same-origin, session-authenticated and CSRF-protected.
 */

import type {
	OtaAuditEvent,
	OtaInfo,
	OtaRelease,
	OtaReleasePage,
	OtaStorageView,
	OtaTokenSummary,
} from "../domain/types.js";

export class OtaRequestError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "OtaRequestError";
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function send<T>(path: string, init: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			credentials: "same-origin",
			...init,
		});
	} catch {
		throw new OtaRequestError("NETWORK", "The server could not be reached. Check the connection and retry.");
	}
	let payload: unknown = null;
	try {
		payload = await response.json();
	} catch {
		payload = null;
	}
	if (!record(payload) || typeof payload.ok !== "boolean")
		throw new OtaRequestError("INVALID_RESPONSE", "The server returned an unexpected response. Reload the page.");
	if (!payload.ok) {
		const error = record(payload.error) ? payload.error : {};
		throw new OtaRequestError(
			typeof error.code === "string" ? error.code : "REQUEST_FAILED",
			typeof error.message === "string" ? error.message : "The request failed.",
		);
	}
	return payload.data as T;
}

function actionPath(action: string): string {
	return `/api/ota/${encodeURIComponent(action)}`;
}

export function get<T>(
	action: string,
	params: Record<string, string | number | undefined> = {},
	signal?: AbortSignal,
): Promise<T> {
	const url = new URL(actionPath(action), window.location.origin);
	for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
	return send<T>(url.pathname + url.search, { method: "GET", signal });
}

export function post<T>(action: string, body: unknown = {}): Promise<T> {
	return send<T>(actionPath(action), {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify(body),
	});
}

/** Multipart upload from the workspace: the server computes sha256. */
export function uploadBundle(form: FormData): Promise<OtaRelease> {
	return send<OtaRelease>(actionPath("release-upload"), {
		method: "POST",
		headers: { "X-EmDash-Request": "1" },
		body: form,
	});
}

export function errorMessage(error: unknown): string {
	if (error instanceof OtaRequestError) return error.message;
	return "The request could not be completed. Retry.";
}

export const api = {
	info: (signal?: AbortSignal) => get<OtaInfo>("info", {}, signal),
	releases: (params: Record<string, string | number | undefined>, signal?: AbortSignal) =>
		get<OtaReleasePage>("releases", params, signal),
	tokens: (params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
		get<OtaTokenSummary[]>("tokens", params, signal),
	storage: (signal?: AbortSignal) => get<OtaStorageView>("storage", {}, signal),
	audit: (params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
		get<OtaAuditEvent[]>("audit", params, signal),
};
