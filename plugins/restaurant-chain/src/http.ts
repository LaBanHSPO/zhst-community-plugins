import { z } from "zod";
import { RestaurantService, DomainError } from "./domain/service.js";
import type { Actor, ExportResult } from "./domain/types.js";
import { downloadInvoice } from "./integrations/index.js";
import type { IntegrationOptions } from "./integrations/index.js";

const reads: Record<string, true | undefined> = {
	info: true,
	workspace: true,
	menu: true,
	"guest-status": true,
	export: true,
	"invoice-file": true,
};
const commands: Record<string, true | undefined> = {
	"save-branch": true,
	"save-member": true,
	"save-table": true,
	"save-menu-item": true,
	"open-visit": true,
	"close-visit": true,
	"clean-table": true,
	"open-shift": true,
	"close-shift": true,
	"freeze-bill": true,
	"settle-bill": true,
	"apply-discount": true,
	"refund-bill": true,
	"call-service": true,
	"attend-request": true,
	"join-table": true,
	"submit-order": true,
	"confirm-order": true,
	"reject-order": true,
	"void-order": true,
	"kitchen-transition": true,
	"create-payment": true,
	"request-invoice": true,
	"issue-invoice": true,
	"correct-invoice": true,
	"reconcile-invoice": true,
};
const maxBody = 65_536;

export function apiFailure(code: string, message: string, status: number): Response {
	return Response.json(
		{ ok: false, error: { code, message } },
		{
			status,
			headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
		},
	);
}

async function readJson(request: Request): Promise<unknown> {
	if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
		throw new DomainError("CONTENT_TYPE", "JSON request required.", 415);
	}
	if (Number(request.headers.get("content-length")) > maxBody)
		throw new DomainError("BODY_TOO_LARGE", "Request too large.", 413);
	if (!request.body) throw new DomainError("INVALID_INPUT", "Request body required.", 400);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBody) {
				await reader.cancel();
				throw new DomainError("BODY_TOO_LARGE", "Request too large.", 413);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new DomainError("INVALID_INPUT", "Invalid JSON request.", 400);
	}
}

export async function handleRestaurantRequest(
	request: Request,
	action: string,
	actor: Actor | null,
	options: IntegrationOptions,
): Promise<Response> {
	if (!Object.hasOwn(reads, action) && !Object.hasOwn(commands, action))
		return apiFailure("NOT_FOUND", "Unknown action.", 404);
	const method = Object.hasOwn(reads, action) ? "GET" : "POST";
	if (request.method !== method) {
		const response = apiFailure("METHOD_NOT_ALLOWED", `Use ${method}.`, 405);
		response.headers.set("Allow", method);
		return response;
	}
	if (
		method === "POST" &&
		(request.headers.get("X-EmDash-Request") !== "1" ||
			request.headers.get("Origin") !== new URL(request.url).origin)
	) {
		return apiFailure("CSRF", "Same-origin request required.", 403);
	}
	try {
		const input: Record<string, unknown> | unknown =
			method === "GET"
				? Object.fromEntries(new URL(request.url).searchParams)
				: await readJson(request);
		if (method === "GET" && typeof input === "object" && input !== null && "limit" in input) {
			(input as Record<string, unknown>).limit = Number(input.limit);
		}
		const service = new RestaurantService(options.db, actor);
		const data = await service.execute(action, input);
		if (action === "export") {
			const result = data as ExportResult;
			return new Response(result.csv, {
				headers: {
					"Content-Type": result.contentType,
					"Content-Disposition": `attachment; filename="${result.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
					"Cache-Control": "private, no-store",
					"X-Content-Type-Options": "nosniff",
					...(result.nextCursor ? { "X-Next-Cursor": result.nextCursor } : {}),
				},
			});
		}
		if (action === "invoice-file") {
			const authorized = z.object({ invoiceId: z.string(), branchId: z.string() }).parse(data);
			const type = z.object({ type: z.enum(["pdf", "xml"]) }).parse(input).type;
			return await downloadInvoice(authorized.invoiceId, type, options);
		}
		return Response.json(
			{ ok: true, data },
			{
				headers: {
					"Cache-Control": "private, no-store",
					"X-Content-Type-Options": "nosniff",
				},
			},
		);
	} catch (error) {
		if (error instanceof DomainError) return apiFailure(error.code, error.message, error.status);
		if (error instanceof z.ZodError)
			return apiFailure("INVALID_INPUT", "Invalid request data.", 400);
		console.error("[restaurant] request failed", {
			action,
			errorType: error instanceof Error ? error.name : "unknown",
		});
		return apiFailure(
			"INTERNAL_ERROR",
			"The action could not be completed. Retry with the same command identifier.",
			500,
		);
	}
}
