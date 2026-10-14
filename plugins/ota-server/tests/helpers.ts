import type { OtaBlobStore, PlatformStorage } from "../src/domain/types.js";

const encoder = new TextEncoder();

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (bytes.byteLength > 0) controller.enqueue(bytes);
			controller.close();
		},
	});
}

export interface MemoryStore {
	store: OtaBlobStore;
	objects: Map<string, { bytes: Uint8Array; contentType: string }>;
}

/** In-memory blob store with real ranged reads, used instead of a network bucket. */
export function memoryStore(): MemoryStore {
	const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
	return {
		objects,
		store: {
			describe: () => "memory store",
			async put(key, bytes, options = {}) {
				objects.set(key, {
					bytes: bytes.slice(),
					contentType: options.contentType ?? "application/octet-stream",
				});
			},
			async get(key, range) {
				const object = objects.get(key);
				if (!object) return null;
				if (!range) return { body: streamOf(object.bytes), contentType: object.contentType, size: object.bytes.byteLength };
				const end =
					range.length === undefined
						? object.bytes.byteLength
						: Math.min(object.bytes.byteLength, range.offset + range.length);
				const slice = object.bytes.slice(range.offset, end);
				return {
					body: streamOf(slice),
					contentType: object.contentType,
					size: object.bytes.byteLength,
					range: { offset: range.offset, length: slice.byteLength },
				};
			},
			async head(key) {
				const object = objects.get(key);
				return object ? { size: object.bytes.byteLength, contentType: object.contentType } : null;
			},
			async delete(key) {
				objects.delete(key);
			},
		},
	};
}

/** Host storage adapter double, exercising the platform storage path. */
export function memoryPlatformStorage(): MemoryStore & { platform: PlatformStorage } {
	const memory = memoryStore();
	const platform: PlatformStorage = {
		async upload({ key, body, contentType }) {
			await memory.store.put(key, body, { contentType });
			return { key, url: `/media/${key}`, size: body.byteLength };
		},
		async download(key, options) {
			const range = options?.range;
			const normalized =
				range && "offset" in range
					? { offset: range.offset, ...(range.length === undefined ? {} : { length: range.length }) }
					: undefined;
			const read = await memory.store.get(key, normalized);
			if (!read)
				throw Object.assign(new Error(`ENOENT: ${key}`), { name: "EmDashStorageError", code: "NOT_FOUND" });
			return {
				body: read.body,
				contentType: read.contentType,
				size: read.size,
				...(read.range ? { range: read.range } : {}),
			};
		},
		async delete(key) {
			await memory.store.delete(key);
		},
		async exists(key) {
			return memory.objects.has(key);
		},
	};
	return { ...memory, platform };
}

export interface MultipartPart {
	name: string;
	value?: string;
	filename?: string;
	contentType?: string;
	bytes?: Uint8Array;
}

export const TEST_BOUNDARY = "----otaTestBoundary7MA4YWxkTrZu0gW";

/** Build a multipart/form-data body byte-exactly, including CRLF-sensitive content. */
export function multipartBody(
	parts: readonly MultipartPart[],
	boundary: string = TEST_BOUNDARY,
): { body: Uint8Array; contentType: string } {
	const chunks: Uint8Array[] = [];
	for (const part of parts) {
		chunks.push(encoder.encode(`--${boundary}\r\n`));
		const filename = part.filename === undefined ? "" : `; filename="${part.filename}"`;
		chunks.push(encoder.encode(`Content-Disposition: form-data; name="${part.name}"${filename}\r\n`));
		if (part.contentType) chunks.push(encoder.encode(`Content-Type: ${part.contentType}\r\n`));
		chunks.push(encoder.encode("\r\n"));
		chunks.push(part.bytes ?? encoder.encode(part.value ?? ""));
		chunks.push(encoder.encode("\r\n"));
	}
	chunks.push(encoder.encode(`--${boundary}--\r\n`));
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}
