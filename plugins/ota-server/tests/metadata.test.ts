import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pushMetaSchema, releaseMetadataSchema, signatureSchema } from "../src/domain/validation.js";

const requiredFields = { channel: "main", binary: "1.0.0", sha256: "a".repeat(64) };

describe("release metadata validation", () => {
	it("preserves standard base64 exactly without selecting a signing algorithm", () => {
		const signature = btoa(String.fromCharCode(...new Uint8Array(64).fill(255)));
		assert.equal(signature.length, 88);
		for (const value of ["", "YQ==", "YWI=", "YWJj", signature, "A".repeat(4096)]) {
			assert.equal(signatureSchema.parse(value), value);
		}
		assert.equal(signatureSchema.parse(undefined), "");
	});

	it("rejects noncanonical, URL-safe, whitespace and oversized signature values", () => {
		for (const value of ["____", "----", "YQ", "YR==", "YQ== ", "YQ==\n", "A".repeat(4100), null, 88]) {
			assert.equal(signatureSchema.safeParse(value).success, false);
		}
	});

	it("parses mandatory form strings strictly and defaults omissions to false", () => {
		assert.equal(pushMetaSchema.parse({ ...requiredFields, mandatory: "true" }).mandatory, true);
		assert.equal(pushMetaSchema.parse({ ...requiredFields, mandatory: "false" }).mandatory, false);
		const defaults = pushMetaSchema.parse(requiredFields);
		assert.equal(defaults.mandatory, false);
		assert.equal(defaults.signature, "");
		for (const mandatory of [true, false, 1, 0, "", "TRUE", "False", "yes", " false", null]) {
			assert.equal(pushMetaSchema.safeParse({ ...requiredFields, mandatory }).success, false);
		}
	});

	it("accepts only domain booleans and defaults legacy domain inputs", () => {
		assert.deepEqual(releaseMetadataSchema.parse({}), { signature: "", mandatory: false });
		assert.deepEqual(releaseMetadataSchema.parse({ signature: "YQ==", mandatory: true }), { signature: "YQ==", mandatory: true });
		assert.equal(releaseMetadataSchema.parse({ mandatory: false }).mandatory, false);
		for (const mandatory of ["false", "true", 0, 1, null]) {
			assert.equal(releaseMetadataSchema.safeParse({ mandatory }).success, false);
		}
	});
});
