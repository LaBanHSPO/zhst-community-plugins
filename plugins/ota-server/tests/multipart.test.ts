import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readMultipart } from "../src/http/multipart.js";
import { OtaError, sha256Hex } from "../src/domain/data.js";
import { decode, multipartBody } from "./helpers.js";

const encoder = new TextEncoder();

function request(body: Uint8Array, contentType: string, method = "POST"): Request {
	return new Request("https://ota.test/ota/app/android/releases", {
		method,
		headers: { "content-type": contentType },
		// `@cloudflare/workers-types` narrows BodyInit away from Uint8Array; the
		// runtime and the fetch spec both accept one.
		body: body as unknown as BodyInit,
	});
}

function options(maxFileBytes = 1024 * 1024) {
	return { maxBytes: maxFileBytes + 64 * 1024, maxFileBytes, fileField: "bundle" };
}

async function failure(promise: Promise<unknown>): Promise<OtaError> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof OtaError, `expected OtaError, got ${String(error)}`);
		return error;
	}
	throw new Error("expected the parse to fail");
}

describe("multipart reader", () => {
	it("reads text fields and one bundle file", async () => {
		const bundle = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]);
		const { body, contentType } = multipartBody([
			{ name: "channel", value: "ducnv/feature/luu-kho" },
			{ name: "binary", value: "1.0.66+93" },
			{ name: "sha256", value: "a".repeat(64) },
			{ name: "note", value: "fix màn giao hàng" },
			{ name: "bundle", filename: "app.bundle", contentType: "application/octet-stream", bytes: bundle },
		]);
		const form = await readMultipart(request(body, contentType), options());
		assert.equal(form.fields.channel, "ducnv/feature/luu-kho");
		assert.equal(form.fields.binary, "1.0.66+93");
		assert.equal(form.fields.note, "fix màn giao hàng");
		assert.equal(form.file?.filename, "app.bundle");
		assert.equal(form.file?.contentType, "application/octet-stream");
		assert.deepEqual([...(form.file?.bytes ?? [])], [...bundle]);
	});

	it("keeps binary content that contains CRLF and near-miss boundary bytes", async () => {
		// A real boundary may not appear in the content, but a prefix of it and
		// boundary-like runs must survive the delimiter scan untouched.
		const nearMiss = `--${"----otaTestBoundary7MA4YWxkTrZu0gW".slice(0, -1)}`;
		const bundle = encoder.encode(
			`line1\r\n----otaTestBoundaryXX\r\n${nearMiss}\r\n--not-the-boundary--\r\n\r\nend`,
		);
		const { body, contentType } = multipartBody([
			{ name: "channel", value: "main" },
			{ name: "bundle", filename: "b.bundle", bytes: bundle },
		]);
		const form = await readMultipart(request(body, contentType), options());
		assert.deepEqual([...(form.file?.bytes ?? [])], [...bundle]);
		assert.equal(decode(form.file?.bytes ?? new Uint8Array()), decode(bundle));
	});

	it("parses a body that arrives in small, boundary-splitting chunks", async () => {
		const bundle = encoder.encode("payload-that-crosses-chunk-boundaries");
		const { body, contentType } = multipartBody([
			{ name: "channel", value: "release/1.2" },
			{ name: "bundle", filename: "b.bundle", bytes: bundle },
		]);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < body.byteLength; offset += 7)
					controller.enqueue(body.subarray(offset, Math.min(body.byteLength, offset + 7)));
				controller.close();
			},
		});
		const chunked = new Request("https://ota.test/ota/app/android/releases", {
			method: "POST",
			headers: { "content-type": contentType },
			body: stream,
			// @ts-expect-error -- Node needs this to stream a request body
			duplex: "half",
		});
		const form = await readMultipart(chunked, options());
		assert.equal(form.fields.channel, "release/1.2");
		assert.equal(decode(form.file?.bytes ?? new Uint8Array()), decode(bundle));
	});

	it("accepts a quoted boundary and ignores unrelated file parts", async () => {
		const { body } = multipartBody([
			{ name: "channel", value: "main" },
			{ name: "extra", filename: "ignored.txt", bytes: encoder.encode("ignore me") },
			{ name: "bundle", filename: "b.bundle", bytes: encoder.encode("kept") },
		]);
		const form = await readMultipart(
			request(body, 'multipart/form-data; boundary="----otaTestBoundary7MA4YWxkTrZu0gW"'),
			options(),
		);
		assert.equal(decode(form.file?.bytes ?? new Uint8Array()), "kept");
	});

	it("collects a part larger than the growth step without a declared length", async () => {
		// No `Content-Length` (a streamed body), so the buffer must grow in steps
		// and still return exactly the uploaded bytes.
		const bundle = new Uint8Array(9 * 1024 * 1024);
		for (let index = 0; index < bundle.byteLength; index += 4096) bundle[index] = index % 251;
		const { body, contentType } = multipartBody([
			{ name: "channel", value: "main" },
			{ name: "bundle", filename: "big.bundle", bytes: bundle },
		]);
		const form = await readMultipart(request(body, contentType), options(16 * 1024 * 1024));
		assert.equal(form.file?.bytes.byteLength, bundle.byteLength);
		assert.equal(await sha256Hex(form.file?.bytes ?? new Uint8Array()), await sha256Hex(bundle));
	});

	it("rejects a non-multipart content type", async () => {
		const error = await failure(
			readMultipart(
				new Request("https://ota.test/x", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
				options(),
			),
		);
		assert.equal(error.code, "UNSUPPORTED_MEDIA_TYPE");
		assert.equal(error.status, 415);
	});

	it("rejects a missing boundary", async () => {
		const error = await failure(readMultipart(request(encoder.encode("x"), "multipart/form-data"), options()));
		assert.equal(error.code, "UNSUPPORTED_MEDIA_TYPE");
	});

	it("rejects a truncated body", async () => {
		const { body, contentType } = multipartBody([
			{ name: "channel", value: "main" },
			{ name: "bundle", filename: "b.bundle", bytes: encoder.encode("partial") },
		]);
		const error = await failure(readMultipart(request(body.subarray(0, body.byteLength - 12), contentType), options()));
		assert.equal(error.code, "INVALID_MULTIPART");
	});

	it("rejects a bundle above the configured limit", async () => {
		const { body, contentType } = multipartBody([
			{ name: "channel", value: "main" },
			{ name: "bundle", filename: "b.bundle", bytes: new Uint8Array(4096) },
		]);
		const error = await failure(readMultipart(request(body, contentType), options(1024)));
		assert.equal(error.code, "BUNDLE_TOO_LARGE");
		assert.equal(error.status, 413);
	});

	it("rejects a body above the total limit", async () => {
		const { body, contentType } = multipartBody([{ name: "channel", value: "m".repeat(2048) }]);
		const error = await failure(
			readMultipart(request(body, contentType), { maxBytes: 1024, maxFileBytes: 1024, fileField: "bundle" }),
		);
		assert.equal(error.code, "BODY_TOO_LARGE");
		assert.equal(error.status, 413);
	});

	it("rejects too many parts", async () => {
		const parts = Array.from({ length: 102 }, (_, index) => ({ name: `f${index}`, value: "1" }));
		const { body, contentType } = multipartBody(parts);
		const error = await failure(readMultipart(request(body, contentType), options()));
		assert.equal(error.code, "INVALID_MULTIPART");
	});
});
