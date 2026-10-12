/**
 * `multipart/form-data` reader for bundle pushes.
 *
 * The app-facing route is the only place a large body is accepted, and EmDash
 * plugin routes cap bodies at 8 MiB, so parsing is owned here. Bytes are consumed
 * as a stream and only the file part is retained, which keeps peak memory close
 * to one copy of the bundle instead of two.
 */

import { OtaError } from "../domain/data.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface MultipartFile {
	field: string;
	filename: string;
	contentType: string;
	bytes: Uint8Array;
}

export interface MultipartForm {
	fields: Record<string, string>;
	file: MultipartFile | null;
}

export interface MultipartOptions {
	/** Reject the whole body above this many bytes. */
	maxBytes: number;
	/** Reject a single file part above this many bytes. */
	maxFileBytes: number;
	/** Field name of the file part to keep; other file parts are drained. */
	fileField: string;
	/** Reject a text part above this many bytes. */
	maxFieldBytes?: number;
	/**
	 * The request's declared length, when the client sent one. Sizing the file
	 * buffer up front avoids both a second copy of the bundle and the transient
	 * doubling a growable buffer would need.
	 */
	sizeHint?: number;
}

const HEADER_LIMIT = 16 * 1024;
/** Growth step for a part whose length the client did not declare. */
const GROWTH_STEP = 8 * 1024 * 1024;
const DEFAULT_FIELD_LIMIT = 64 * 1024;
const CRLF = new Uint8Array([13, 10]);
const HEADER_END = new Uint8Array([13, 10, 13, 10]);

function invalid(reason: string): OtaError {
	return new OtaError("INVALID_MULTIPART", `The upload is not a valid multipart form: ${reason}.`, 400);
}

/**
 * Collects one part into a single contiguous buffer.
 *
 * With a size hint — the normal case, because a push carries `Content-Length` —
 * the buffer is allocated once and each chunk is copied straight into it, so the
 * bundle exists in memory exactly once. Without a hint the buffer grows in fixed
 * steps rather than by doubling, which keeps the transient peak at one copy.
 */
class ByteSink {
	private buffer: Uint8Array;
	private used = 0;

	constructor(
		private readonly limit: number,
		sizeHint = 0,
	) {
		this.buffer = new Uint8Array(Math.max(1, Math.min(sizeHint > 0 ? sizeHint : GROWTH_STEP, limit)));
	}

	write(bytes: Uint8Array): void {
		if (bytes.byteLength === 0) return;
		const needed = this.used + bytes.byteLength;
		if (needed > this.limit) throw new OtaError("BUNDLE_TOO_LARGE", "The uploaded bundle is too large.", 413);
		if (needed > this.buffer.byteLength) {
			const grown = new Uint8Array(Math.min(this.limit, Math.max(needed, this.buffer.byteLength + GROWTH_STEP)));
			grown.set(this.buffer.subarray(0, this.used), 0);
			this.buffer = grown;
		}
		this.buffer.set(bytes, this.used);
		this.used = needed;
	}

	view(): Uint8Array {
		return this.buffer.subarray(0, this.used);
	}
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
	if (needle.byteLength === 0 || haystack.byteLength < needle.byteLength) return -1;
	const limit = haystack.byteLength - needle.byteLength;
	outer: for (let start = 0; start <= limit; start += 1) {
		if (haystack[start] !== needle[0]) continue;
		for (let index = 1; index < needle.byteLength; index += 1)
			if (haystack[start + index] !== needle[index]) continue outer;
		return start;
	}
	return -1;
}

class Scanner {
	private buffer = new Uint8Array(0);
	private exhausted = false;
	private consumed = 0;

	constructor(
		private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
		private readonly maxBytes: number,
	) {}

	private async pull(): Promise<boolean> {
		if (this.exhausted) return false;
		const { value, done } = await this.reader.read();
		if (done || !value) {
			this.exhausted = true;
			return false;
		}
		this.consumed += value.byteLength;
		if (this.consumed > this.maxBytes)
			throw new OtaError("BODY_TOO_LARGE", "The uploaded payload is larger than this server accepts.", 413);
		const next = new Uint8Array(this.buffer.byteLength + value.byteLength);
		next.set(this.buffer, 0);
		next.set(value, this.buffer.byteLength);
		this.buffer = next;
		return true;
	}

	async readExact(count: number): Promise<Uint8Array> {
		while (this.buffer.byteLength < count) if (!(await this.pull())) throw invalid("the body ended early");
		const out = this.buffer.slice(0, count);
		this.buffer = this.buffer.subarray(count);
		return out;
	}

	/**
	 * Emit everything before `pattern`, consume `pattern`, and report whether it
	 * was found. Bytes that could still be the start of `pattern` are retained.
	 */
	async readUntil(
		pattern: Uint8Array,
		sink: (bytes: Uint8Array) => void,
		limit: number,
		onLimit: () => OtaError,
	): Promise<boolean> {
		let seen = 0;
		for (;;) {
			const found = indexOf(this.buffer, pattern);
			if (found >= 0) {
				sink(this.buffer.subarray(0, found));
				this.buffer = this.buffer.subarray(found + pattern.byteLength);
				return true;
			}
			const keep = pattern.byteLength - 1;
			const flush = this.buffer.byteLength - keep;
			if (flush > 0) {
				seen += flush;
				if (seen > limit) throw onLimit();
				sink(this.buffer.subarray(0, flush));
				this.buffer = this.buffer.subarray(flush);
			}
			if (!(await this.pull())) return false;
		}
	}

	async drain(): Promise<void> {
		try {
			for (;;) if (!(await this.pull())) return;
		} finally {
			this.buffer = new Uint8Array(0);
		}
	}
}

function extractBoundary(contentType: string): string {
	const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
	const boundary = (match?.[1] ?? match?.[2] ?? "").trim();
	if (boundary === "" || boundary.length > 70 || /[\r\n]/.test(boundary))
		throw new OtaError("UNSUPPORTED_MEDIA_TYPE", "A multipart/form-data body with a boundary is required.", 415);
	return boundary;
}

function parseHeaderBlock(block: Uint8Array): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const line of decoder.decode(block).split("\r\n")) {
		if (line.trim() === "") continue;
		const separator = line.indexOf(":");
		if (separator <= 0) throw invalid("a part header is malformed");
		const name = line.slice(0, separator).trim().toLowerCase();
		headers[name] = line.slice(separator + 1).trim();
	}
	return headers;
}

function parseDisposition(value: string | undefined): { field: string; filename: string | null } {
	if (!value) throw invalid("a part is missing Content-Disposition");
	const field = /(?:^|;)\s*name="([^"]*)"/i.exec(value)?.[1];
	if (field === undefined) throw invalid("a part is missing its field name");
	const filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(value)?.[1];
	return { field, filename: filename === undefined ? null : filename };
}

export async function readMultipart(request: Request, options: MultipartOptions): Promise<MultipartForm> {
	const contentType = request.headers.get("content-type") ?? "";
	if (!/^multipart\/form-data\b/i.test(contentType))
		throw new OtaError("UNSUPPORTED_MEDIA_TYPE", "A multipart/form-data body is required.", 415);
	const boundary = extractBoundary(contentType);
	if (!request.body) throw new OtaError("INVALID_INPUT", "A request body is required.", 400);

	const maxFieldBytes = options.maxFieldBytes ?? DEFAULT_FIELD_LIMIT;
	const delimiter = encoder.encode(`--${boundary}`);
	const partEnd = new Uint8Array(CRLF.byteLength + delimiter.byteLength);
	partEnd.set(CRLF, 0);
	partEnd.set(delimiter, CRLF.byteLength);

	const scanner = new Scanner(request.body.getReader(), options.maxBytes);
	const fields: Record<string, string> = {};
	let file: MultipartFile | null = null;
	let parts = 0;

	try {
		if (!(await scanner.readUntil(delimiter, () => undefined, 0, () => invalid("no boundary was found"))))
			throw invalid("no boundary was found");

		for (;;) {
			parts += 1;
			if (parts > 100) throw new OtaError("INVALID_MULTIPART", "The upload contains too many parts.", 400);
			const marker = await scanner.readExact(2);
			if (marker[0] === 45 && marker[1] === 45) break;
			if (marker[0] !== 13 || marker[1] !== 10) throw invalid("the part separator is malformed");

			const headerChunks: Uint8Array[] = [];
			let headerBytes = 0;
			const headerFound = await scanner.readUntil(
				HEADER_END,
				(bytes) => {
					headerBytes += bytes.byteLength;
					if (headerBytes > HEADER_LIMIT) throw invalid("a part header block is too large");
					headerChunks.push(bytes);
				},
				HEADER_LIMIT,
				() => invalid("a part header block is too large"),
			);
			if (!headerFound) throw invalid("a part header block ended early");
			const headers = parseHeaderBlock(concat(headerChunks, headerBytes));
			const disposition = parseDisposition(headers["content-disposition"]);
			const isFile = disposition.filename !== null && disposition.filename !== "";

			if (isFile && disposition.field === options.fileField && file === null) {
				const sink = new ByteSink(options.maxFileBytes, options.sizeHint ?? 0);
				const bodyFound = await scanner.readUntil(
					partEnd,
					(bytes) => sink.write(bytes),
					options.maxFileBytes,
					() => new OtaError("BUNDLE_TOO_LARGE", "The uploaded bundle is too large.", 413),
				);
				if (!bodyFound) throw invalid("the file part ended early");
				file = {
					field: disposition.field,
					filename: disposition.filename ?? "",
					contentType: headers["content-type"] ?? "application/octet-stream",
					bytes: sink.view(),
				};
				continue;
			}

			const chunks: Uint8Array[] = [];
			let total = 0;
			const bodyFound = await scanner.readUntil(
				partEnd,
				(bytes) => {
					if (isFile) {
						total += bytes.byteLength;
						if (total > options.maxFileBytes) throw new OtaError("BUNDLE_TOO_LARGE", "An uploaded file is too large.", 413);
						return;
					}
					total += bytes.byteLength;
					if (total > maxFieldBytes) throw new OtaError("INVALID_MULTIPART", `The "${disposition.field}" field is too large.`, 400);
					if (bytes.byteLength > 0) chunks.push(bytes);
				},
				isFile ? options.maxFileBytes : maxFieldBytes,
				() => (isFile ? new OtaError("BUNDLE_TOO_LARGE", "An uploaded file is too large.", 413) : new OtaError("INVALID_MULTIPART", `The "${disposition.field}" field is too large.`, 400)),
			);
			if (!bodyFound) throw invalid("a part ended early");
			if (isFile) continue;
			fields[disposition.field] = decoder.decode(concat(chunks, total));
		}
	} finally {
		await scanner.drain().catch(() => undefined);
	}

	return { fields, file };
}
