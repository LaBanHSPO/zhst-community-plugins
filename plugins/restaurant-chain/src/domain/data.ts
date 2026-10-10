import type {
	Branch,
	Invoice,
	MenuItem,
	Modifier,
	Order,
	OrderLine,
	Payment,
	Visit,
} from "./types.js";
import { issuerSchema, MAX_VND } from "./validation.js";
import { buildPaymentQr } from "../integrations/payments.js";

export class DomainError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status = 400,
	) {
		super(message);
		this.name = "DomainError";
	}
}
export const columns = {
	branch:
		"id,name,bank_account AS bankAccount,bank_code AS bankCode,bank_name AS bankName,sub_account AS subAccount,qr_mode AS qrMode,transfer_prefix AS transferPrefix,credential_context AS credentialContext,environment,issuer_json AS issuerJson,version",
	visit: "id,table_id AS tableId,status,version,expires_at AS expiresAt,created_at AS createdAt",
	menu: "id,name,category,description,image,price,tax_rate AS taxRate,available,modifiers_json AS modifiersJson,version",
	order: "id,visit_id AS visitId,status,note,reason,total,version,created_at AS createdAt",
	line: "id,menu_item_id AS menuItemId,name,quantity,unit_price AS unitPrice,tax_rate AS taxRate,modifiers_json AS modifiersJson,total,tax_amount AS taxAmount,kitchen_status AS kitchenStatus,version",
	payment:
		"id,visit_id AS visitId,reference,amount,bank_account AS bankAccount,bank_code AS bankCode,bank_name AS bankName,sub_account AS subAccount,qr_mode AS qrMode,transfer_prefix AS transferPrefix,status,version,created_at AS createdAt",
	invoice:
		"id,visit_id AS visitId,payment_id AS paymentId,kind,original_invoice_id AS originalInvoiceId,status,reference,create_tracking_code AS createTrackingCode,issue_tracking_code AS issueTrackingCode,tax_authority_status AS taxAuthorityStatus,last_error AS lastError,version,created_at AS createdAt",
} as const;
export type BranchRow = Omit<Branch, "issuer"> & { issuerJson: string };
export type MenuRow = Omit<MenuItem, "modifiers" | "available"> & {
	modifiersJson: string;
	available: number;
};
export type LineRow = Omit<OrderLine, "modifiers"> & { modifiersJson: string; orderId: string };
export type VisitRow = Visit & { branchId: string };
export type OrderRow = Omit<Order, "lines">;
export type InvoiceRow = Invoice & {
	credentialContext: string;
	environment: string;
	payloadJson: string;
	issuerJson: string;
};
export function branchDto(row: BranchRow): Branch {
	const { issuerJson, ...rest } = row;
	return { ...rest, issuer: issuerSchema.parse(JSON.parse(issuerJson)) };
}
export function menuDto(row: MenuRow): MenuItem {
	const { modifiersJson, available, ...rest } = row;
	return {
		...rest,
		available: available === 1,
		modifiers: JSON.parse(modifiersJson) as Modifier[],
	};
}
export function paymentDto(row: Omit<Payment, "qrUrl">): Payment {
	return {
		...row,
		qrUrl: buildPaymentQr({
			bank_account: row.bankAccount,
			bank_code: row.bankCode,
			reference: row.reference,
			amount: row.amount,
			sub_account: row.subAccount,
			qr_mode: row.qrMode,
			transfer_prefix: row.transferPrefix,
		}),
	};
}
export function exactVnd(value: bigint, signed = false): number {
	if (value > BigInt(MAX_VND) || value < (signed ? -BigInt(MAX_VND) : 0n))
		throw new DomainError("AMOUNT_RANGE", "Amount exceeds the supported VND range");
	return Number(value);
}
export function taxIncluded(gross: number, rate: number): number {
	const sign = gross < 0 ? -1n : 1n;
	const denominator = 10000n + BigInt(rate);
	return Number(sign * ((BigInt(Math.abs(gross)) * BigInt(rate) + denominator / 2n) / denominator));
}
export async function hash(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
export function csvCell(value: unknown): string {
	let text = value === null || value === undefined ? "" : String(value);
	if (/^[\s]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
	return `"${text.replaceAll('"', '""')}"`;
}
