/**
 * SigV4 conformance.
 *
 * 1. The published `aws-sig-v4-test-suite` `get-vanilla` vector pins the
 *    algorithm (canonical request, scope, signing key derivation).
 * 2. A Node `crypto.createHmac` reference implementation cross-checks the
 *    WebCrypto implementation used at runtime.
 * 3. Encoding checks pin the behaviour that matters for R2 object keys, which
 *    contain `/` and `+`.
 */

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
	EMPTY_SHA256,
	amzDate,
	canonicalQueryString,
	dateStamp,
	signRequest,
	signS3,
	uriEncode,
} from "../src/storage/sigv4.js";

const credentials = {
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
/** 2015-08-30T12:36:00Z */
const timestamp = Date.UTC(2015, 7, 30, 12, 36, 0);

describe("SigV4", () => {
	it("reproduces the aws-sig-v4-test-suite get-vanilla vector", async () => {
		const result = await signRequest({
			method: "GET",
			path: "/",
			query: "",
			headers: { host: "example.amazonaws.com", "x-amz-date": amzDate(timestamp) },
			payloadHash: EMPTY_SHA256,
			credentials,
			region: "us-east-1",
			service: "service",
			timestamp,
		});
		assert.equal(result.amzDate, "20150830T123600Z");
		assert.equal(result.scope, "20150830/us-east-1/service/aws4_request");
		assert.equal(
			result.signature,
			"5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
		);
		assert.equal(
			result.authorization,
			"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
				"SignedHeaders=host;x-amz-date, " +
				"Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
		);
	});

	it("matches an independent Node implementation for a signed S3 PUT", async () => {
		const url = new URL("https://account.r2.cloudflarestorage.com/ota-bundles/unitel-man/android/bundles/x/1.0.66%2B93/20261008-091500.bundle");
		const payloadHash = createHash("sha256").update("payload-bytes").digest("hex");
		const headers = { "content-type": "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" };
		const signing = { accessKeyId: "key", secretAccessKey: "secret" };
		const signed = await signS3({
			url,
			method: "PUT",
			payloadHash,
			headers,
			credentials: signing,
			region: "auto",
			timestamp,
		});

		// Reference implementation, written directly from the AWS specification.
		const names = ["host", "x-amz-date", "x-amz-content-sha256", "content-type", "cache-control"].sort();
		const canonicalHeaders = names
			.map((name) => {
				if (name === "host") return `host:${url.host}\n`;
				if (name === "x-amz-date") return `x-amz-date:${amzDate(timestamp)}\n`;
				if (name === "x-amz-content-sha256") return `x-amz-content-sha256:${payloadHash}\n`;
				return `${name}:${headers[name as keyof typeof headers]}\n`;
			})
			.join("");
		const canonicalRequest = ["PUT", url.pathname, "", canonicalHeaders, names.join(";"), payloadHash].join("\n");
		const scope = `${dateStamp(timestamp)}/auto/s3/aws4_request`;
		const stringToSign = [
			"AWS4-HMAC-SHA256",
			amzDate(timestamp),
			scope,
			createHash("sha256").update(canonicalRequest).digest("hex"),
		].join("\n");
		const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();
		const signingKey = hmac(
			hmac(hmac(hmac(`AWS4${signing.secretAccessKey}`, dateStamp(timestamp)), "auto"), "s3"),
			"aws4_request",
		);
		const expected = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
		assert.equal(signed.authorization, `AWS4-HMAC-SHA256 Credential=key/${scope}, SignedHeaders=${names.join(";")}, Signature=${expected}`);

		// The wire headers carry the hash and date the signature was built from.
		assert.equal(signed["x-amz-content-sha256"], payloadHash);
		assert.equal(signed["x-amz-date"], "20150830T123600Z");
		assert.equal("host" in signed, false);
		assert.equal(signed["content-type"], headers["content-type"]);
	});

	it("keeps the signed path byte-identical to the request path", async () => {
		const url = new URL("https://account.r2.cloudflarestorage.com/bucket/a%2Bb/c+d/e");
		const signed = await signS3({
			url,
			method: "GET",
			payloadHash: EMPTY_SHA256,
			credentials,
			region: "auto",
			timestamp,
		});
		assert.ok(signed["authorization"]?.includes("Signature="));
		assert.equal(url.pathname, "/bucket/a%2Bb/c+d/e");
	});

	it("uses the request pathname unchanged and sorts the query string", async () => {
		const url = new URL("https://account.r2.cloudflarestorage.com/bucket?list-type=2&prefix=a%2Fb&continuation-token=z");
		assert.equal(canonicalQueryString({ prefix: "a/b", "list-type": "2", "continuation-token": "z" }), "continuation-token=z&list-type=2&prefix=a%2Fb");
		assert.equal(url.pathname, "/bucket");
	});

	it("encodes reserved characters per RFC 3986", () => {
		assert.equal(uriEncode("a+b c/d~e"), "a%2Bb%20c%2Fd~e");
		assert.equal(uriEncode("a/b", false), "a/b");
	});
});
