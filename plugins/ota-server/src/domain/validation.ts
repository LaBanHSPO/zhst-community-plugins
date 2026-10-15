/**
 * Input validation. Every value that reaches SQL, a storage key or the manifest
 * passes through this module.
 */

import { z } from "zod";
import { OTA_PLATFORMS } from "./types.js";
import { DEFAULT_MAX_BUNDLE_BYTES, OtaError } from "./data.js";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const appSlugSchema = z
	.string()
	.min(1)
	.max(40)
	.regex(/^[a-z0-9][a-z0-9-]*$/, "App names use lowercase letters, digits and dashes.");

export const platformSchema = z.enum(OTA_PLATFORMS);

export const channelSchema = z
	.string()
	.min(1)
	.max(200)
	.refine((value) => !CONTROL_CHARS.test(value), "Channel contains control characters.")
	.refine((value) => !value.includes("\\"), "Channel contains a backslash.")
	.refine((value) => value.trim() === value, "Channel must not start or end with whitespace.")
	.refine((value) => value !== "." && value !== "..", "Channel is not a valid name.");

export const binarySchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/, "Binary must look like 1.0.66+93 or 1.6.6.");

export const sha256Schema = z
	.string()
	.regex(/^[0-9a-fA-F]{64}$/, "sha256 must be 64 hexadecimal characters.")
	.transform((value) => value.toLowerCase());

const shortText = (max: number) =>
	z
		.string()
		.max(max)
		.refine((value) => !CONTROL_CHARS.test(value), "Value contains control characters.")
		.default("");

export const noteSchema = shortText(500);
export const commitSchema = z
	.string()
	.max(64)
	.regex(/^[0-9A-Za-z._/-]*$/, "Commit must be a plain identifier.")
	.default("");

/** Public metadata, preserved verbatim; this does not verify a signing algorithm. */
export const signatureSchema = z
	.string()
	.max(4096)
	.refine(
		(value) =>
			value === "" ||
			(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
				btoa(atob(value)) === value),
		"Signature must be standard base64.",
	)
	.default("");

/** Direct domain callers supply a boolean, never a truthy form string. */
export const releaseMetadataSchema = z.object({
	signature: signatureSchema,
	mandatory: z.boolean().default(false),
});

export const pushMetaSchema = z.object({
	channel: channelSchema,
	binary: binarySchema,
	sha256: sha256Schema,
	note: noteSchema,
	commit: commitSchema,
	signature: signatureSchema,
	mandatory: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});

export const releaseListSchema = z.object({
	app: appSlugSchema.optional(),
	platform: platformSchema.optional(),
	channel: channelSchema.optional(),
	binary: binarySchema.optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.string().max(200).optional(),
});

export const idSchema = z.object({ id: z.string().min(1).max(64) });

export const tokenCreateSchema = z.object({
	app: appSlugSchema,
	name: z.string().min(1).max(80).refine((value) => !CONTROL_CHARS.test(value), "Name contains control characters."),
});

export const appSaveSchema = z.object({
	slug: appSlugSchema,
	name: z.string().min(1).max(80).refine((value) => !CONTROL_CHARS.test(value), "Name contains control characters."),
	enabled: z.boolean().default(true),
});

export const r2Schema = z.object({
	endpoint: z
		.string()
		.max(300)
		.refine((value) => value === "" || /^https:\/\/[^\s]+$/.test(value), "Endpoint must be an https URL.")
		.default(""),
	bucket: z
		.string()
		.max(120)
		.regex(/^[a-z0-9][a-z0-9.-]*$/, "Bucket names use lowercase letters, digits, dots and dashes.")
		.or(z.literal("")),
	accessKeyId: z.string().max(200).default(""),
	secret: z.string().max(400).default(""),
	region: z.string().max(64).default("auto"),
	publicUrl: z
		.string()
		.max(300)
		.refine((value) => value === "" || /^https:\/\/[^\s]+$/.test(value), "Public URL must be an https URL.")
		.default(""),
});

export const storageSaveSchema = z.object({
	mode: z.enum(["platform", "r2"]),
	r2: r2Schema.default({ endpoint: "", bucket: "", accessKeyId: "", secret: "", region: "auto", publicUrl: "" }),
});

export const auditListSchema = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const storageSettingsSchema = z.object({
	mode: z.enum(["platform", "r2"]).default("platform"),
	r2: r2Schema.default({ endpoint: "", bucket: "", accessKeyId: "", secret: "", region: "auto", publicUrl: "" }),
	updatedAt: z.string().default(""),
});

/** Fail closed when `Content-Length` already exceeds the accepted bundle size. */
export function assertDeclaredLength(contentLength: string | null, maxBundleBytes: number): void {
	if (contentLength === null) return;
	const declared = Number(contentLength);
	if (!Number.isFinite(declared) || declared < 0) throw new OtaError("INVALID_LENGTH", "Invalid Content-Length.", 400);
	// Multipart framing adds a small, bounded overhead around the bundle itself.
	if (declared > maxBundleBytes + 64 * 1024)
		throw new OtaError(
			"BUNDLE_TOO_LARGE",
			`The uploaded payload exceeds the ${Math.floor(maxBundleBytes / (1024 * 1024))} MB limit.`,
			413,
		);
}

export function resolveMaxBundleBytes(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MAX_BUNDLE_BYTES;
	if (!Number.isSafeInteger(value) || value < 1024 * 1024 || value > 512 * 1024 * 1024)
		throw new OtaError("INVALID_CONFIGURATION", "maxBundleBytes is out of range.", 500);
	return value;
}
