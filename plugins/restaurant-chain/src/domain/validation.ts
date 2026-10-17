import { z } from "zod";

export const MAX_VND = 9_000_000_000_000;
const id = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[a-zA-Z0-9_-]+$/);
const text = z.string().trim().min(1).max(200);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const commandId = z
	.string()
	.min(8)
	.max(100)
	.regex(/^[a-zA-Z0-9_-]+$/);
const money = z.number().int().min(0).max(MAX_VND);
const tax = z.union([z.literal(0), z.literal(500), z.literal(800), z.literal(1000)]);
const paging = {
	cursor: z
		.string()
		.min(1)
		.max(512)
		.regex(/^[a-zA-Z0-9_:.-]+$/)
		.optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
};
const base = { commandId, branchId: id };
const revision = { ...base, id, expectedVersion: version };
export const issuerSchema = z.strictObject({
	name: text,
	taxCode: text,
	address: text,
	providerAccountId: z.uuid(),
	sellerStoreXid: z.uuid().optional(),
	templateCode: text,
	series: text,
});
const issuer = issuerSchema;
const buyer = z.strictObject({
	name: text,
	taxCode: z.string().trim().max(30),
	address: z.string().trim().max(500),
	email: z.union([z.literal(""), z.email()]),
});
const modifier = z.strictObject({ id, name: text, price: money });
const reason = z.string().trim().min(3).max(1000);
const optionalRevision = { id: id.optional(), expectedVersion: version.optional() };
function paired(value: { id?: string; expectedVersion?: number }) {
	return Boolean(value.id) === Boolean(value.expectedVersion);
}
export const schemas = {
	info: z.strictObject({}),
	workspace: z.strictObject({ branchId: id, ...paging }),
	"save-branch": z
		.strictObject({
			commandId,
			...optionalRevision,
			name: text,
			bankAccount: z.string().regex(/^[0-9]{4,40}$/),
			bankCode: z.string().regex(/^[a-zA-Z0-9]{2,30}$/),
			bankName: text,
			subAccount: z
				.string()
				.regex(/^[a-zA-Z0-9]{0,40}$/)
				.default(""),
			qrMode: z.enum(["direct", "virtual", "memo"]).default("direct"),
			transferPrefix: z
				.string()
				.trim()
				.max(40)
				.regex(/^[a-zA-Z0-9 ]*$/)
				.default(""),
			credentialContext: id,
			environment: z.enum(["sandbox", "live"]),
			issuer,
		})
		.refine(paired, "Existing records require a version")
		.refine(
			(value) => (value.qrMode === "direct" ? !value.subAccount : Boolean(value.subAccount)),
			"Virtual and memo QR modes require a sub-account; direct mode cannot use one",
		)
		.refine(
			(value) => value.qrMode !== "memo" || !/^TKP/i.test(value.transferPrefix),
			"Memo mode adds TKP automatically; do not duplicate it in the prefix",
		),
	"save-member": z.strictObject({
		...base,
		userId: id,
		role: z.enum(["manager", "floor", "kitchen", "cashier", "accountant"]),
		active: z.boolean().default(true),
		expectedVersion: version.optional(),
	}),
	"save-table": z
		.strictObject({ ...base, ...optionalRevision, name: text })
		.refine(paired, "Existing records require a version"),
	"save-menu-item": z
		.strictObject({
			...base,
			...optionalRevision,
			name: text,
			category: text,
			description: z.string().max(2000),
			image: z.union([
				z.literal(""),
				z.url().refine((value) => value.startsWith("https://"), "Images require HTTPS"),
			]),
			price: money,
			taxRate: tax,
			available: z.boolean(),
			modifiers: z
				.array(modifier)
				.max(20)
				.refine(
					(items) => new Set(items.map((item) => item.id)).size === items.length,
					"Modifier identifiers must be unique",
				),
		})
		.refine(paired, "Existing records require a version"),
	"open-visit": z.strictObject({ ...base, tableId: id, expectedVersion: version }),
	"close-visit": z.strictObject(revision),
	"open-shift": z.strictObject({ ...base, openingFloat: money.default(0) }),
	"close-shift": z.strictObject({
		...revision,
		countedCash: money,
		note: z.string().trim().max(1000).default(""),
	}),
	"freeze-bill": z.strictObject(revision),
	"settle-bill": z.strictObject({
		...revision,
		method: z.enum(["cash", "bank_transfer"]),
		reference: z.string().trim().max(100).default(""),
	}),
	"call-service": z.strictObject({
		commandId,
		token: id,
		kind: z.enum(["waiter", "bill"]),
		note: z.string().trim().max(500).default(""),
	}),
	"attend-request": z.strictObject(revision),
	"join-table": z.strictObject({ commandId, tableToken: id }),
	menu: z.strictObject({ token: id, ...paging }),
	"guest-status": z.strictObject({ token: id, ...paging }),
	"submit-order": z.strictObject({
		commandId,
		token: id,
		expectedVersion: version,
		note: z.string().max(1000),
		lines: z
			.array(
				z.strictObject({
					menuItemId: id,
					quantity: z.number().int().min(1).max(100),
					modifierIds: z
						.array(id)
						.max(20)
						.refine((items) => new Set(items).size === items.length),
				}),
			)
			.min(1)
			.max(50),
	}),
	"confirm-order": z.strictObject(revision),
	"reject-order": z.strictObject({ ...revision, reason }),
	"void-order": z.strictObject({ ...revision, reason }),
	"kitchen-transition": z.strictObject({
		...revision,
		status: z.enum(["preparing", "ready", "served"]),
	}),
	"create-payment": z.strictObject(revision),
	"request-invoice": z.strictObject({ ...base, paymentId: id, buyer }),
	"issue-invoice": z.strictObject(revision),
	"invoice-file": z.strictObject({ branchId: id, id, type: z.enum(["pdf", "xml"]) }),
	"correct-invoice": z.strictObject({
		...revision,
		kind: z.enum(["adjustment", "replacement"]),
		reason,
		buyer,
		lines: z
			.array(
				z.strictObject({
					name: text,
					quantity: z.number().int().min(1).max(100),
					unitPrice: z.number().int().min(-MAX_VND).max(MAX_VND),
					taxRate: tax,
				}),
			)
			.min(1)
			.max(100),
	}),
	"reconcile-invoice": z.strictObject(revision),
	export: z
		.strictObject({
			branchId: id,
			kind: z.enum(["sales", "payments", "invoices", "audit"]),
			from: z.iso.date(),
			to: z.iso.date(),
			...paging,
		})
		.refine((value) => {
			const days = (Date.parse(value.to) - Date.parse(value.from)) / 86400000;
			return days >= 0 && days <= 31;
		}, "Exports require an ordered range of at most 32 business dates"),
};
export type Action = keyof typeof schemas;
