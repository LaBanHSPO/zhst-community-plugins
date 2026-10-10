export type Role = "manager" | "floor" | "kitchen" | "cashier" | "accountant";
export type Actor = { id: string; administrator: boolean };
export type Environment = "sandbox" | "live";
export type QrMode = "direct" | "virtual" | "memo";
export interface Issuer {
	name: string;
	taxCode: string;
	address: string;
	providerAccountId: string;
	sellerStoreXid?: string;
	templateCode: string;
	series: string;
}
export interface Buyer {
	name: string;
	taxCode: string;
	address: string;
	email: string;
}
export interface Modifier {
	id: string;
	name: string;
	price: number;
}
export interface Branch {
	id: string;
	name: string;
	bankAccount: string;
	bankCode: string;
	bankName: string;
	subAccount: string;
	qrMode: QrMode;
	transferPrefix: string;
	credentialContext: string;
	environment: Environment;
	issuer: Issuer;
	version: number;
}
export interface Member {
	userId: string;
	role: Role;
	active: boolean;
	version: number;
}
export interface Table {
	id: string;
	name: string;
	token: string;
	version: number;
}
export interface Visit {
	id: string;
	tableId: string;
	status: "open" | "billing" | "paid" | "closed";
	version: number;
	expiresAt: number;
	createdAt: number;
}
export interface VisitSummary extends Visit {
	total: number;
	pendingCount: number;
	unsettledCount: number;
}
export interface MenuItem {
	id: string;
	name: string;
	category: string;
	description: string;
	image: string;
	price: number;
	taxRate: number;
	available: boolean;
	modifiers: Modifier[];
	version: number;
}
export interface OrderLine {
	id: string;
	menuItemId: string;
	name: string;
	quantity: number;
	unitPrice: number;
	taxRate: number;
	modifiers: Modifier[];
	total: number;
	taxAmount: number;
	kitchenStatus: "queued" | "preparing" | "ready" | "served";
	version: number;
}
export interface Order {
	id: string;
	visitId: string;
	status: "pending" | "confirmed" | "rejected" | "voided";
	note: string;
	reason: string | null;
	lines: OrderLine[];
	total: number;
	version: number;
	createdAt: number;
}
export interface Payment {
	id: string;
	visitId: string;
	reference: string;
	amount: number;
	bankAccount: string;
	bankCode: string;
	bankName: string;
	subAccount: string;
	qrMode: QrMode;
	transferPrefix: string;
	status: "pending" | "paid" | "superseded" | "exception";
	version: number;
	qrUrl: string;
	createdAt: number;
}
export interface Invoice {
	id: string;
	visitId: string;
	paymentId: string;
	kind: "original" | "adjustment" | "replacement";
	originalInvoiceId: string | null;
	status:
		| "queued"
		| "dispatching"
		| "pending"
		| "draft"
		| "issued"
		| "cancelled"
		| "failed"
		| "outcome_unknown";
	reference: string;
	createTrackingCode: string | null;
	issueTrackingCode: string | null;
	taxAuthorityStatus: string | null;
	lastError: string | null;
	version: number;
	createdAt: number;
}
export interface Job {
	id: string;
	invoiceId: string;
	kind: string;
	state: string;
	attempts: number;
	lastError: string | null;
	availableAt: number;
}
export interface PaymentException {
	id: string;
	exception: string;
	providerTransactionId: string;
	createdAt: number;
}
export interface Info {
	administrator: boolean;
	branches: { id: string; name: string; role: Role | "administrator" }[];
}
export interface Workspace {
	branch: Branch | { id: string; name: string; version: number };
	role: Role | "administrator";
	members: Member[];
	tables: Table[];
	visits: VisitSummary[];
	menu: MenuItem[];
	orders: Order[];
	payments: Payment[];
	invoices: Invoice[];
	jobs: Job[];
	exceptions: PaymentException[];
	nextCursor: string | null;
}
export interface GuestSession {
	token: string;
	visit: Visit;
	branch: { id: string; name: string };
	table: { id: string; name: string };
}
export interface GuestMenu {
	branch: { id: string; name: string };
	table: { id: string; name: string };
	visit: Visit;
	items: MenuItem[];
	nextCursor: string | null;
}
export interface GuestStatus {
	visit: Visit;
	orders: Order[];
	total: number;
	nextCursor: string | null;
}
export interface CommandResult {
	id: string;
	version: number;
	jobId?: string;
}
export interface ExportResult {
	filename: string;
	contentType: "text/csv; charset=utf-8";
	csv: string;
	nextCursor: string | null;
}
export interface Command {
	commandId: string;
	branchId: string;
}
export interface RevisionCommand extends Command {
	id: string;
	expectedVersion: number;
}
export interface ActionInputs {
	info: Record<string, never>;
	workspace: { branchId: string; cursor?: string; limit?: number };
	"save-branch": {
		commandId: string;
		id?: string;
		expectedVersion?: number;
		name: string;
		bankAccount: string;
		bankCode: string;
		bankName: string;
		subAccount?: string;
		qrMode?: QrMode;
		transferPrefix?: string;
		credentialContext: string;
		environment: Environment;
		issuer: Issuer;
	};
	"save-member": Command & {
		userId: string;
		role: Role;
		active?: boolean;
		expectedVersion?: number;
	};
	"save-table": Command & { id?: string; expectedVersion?: number; name: string };
	"save-menu-item": Command & {
		id?: string;
		expectedVersion?: number;
		name: string;
		category: string;
		description: string;
		image: string;
		price: number;
		taxRate: number;
		available: boolean;
		modifiers: Modifier[];
	};
	"open-visit": Command & { tableId: string; expectedVersion: number };
	"close-visit": RevisionCommand;
	"join-table": { commandId: string; tableToken: string };
	menu: { token: string; cursor?: string; limit?: number };
	"guest-status": { token: string; cursor?: string; limit?: number };
	"submit-order": {
		commandId: string;
		token: string;
		expectedVersion: number;
		note: string;
		lines: { menuItemId: string; quantity: number; modifierIds: string[] }[];
	};
	"confirm-order": RevisionCommand;
	"reject-order": RevisionCommand & { reason: string };
	"void-order": RevisionCommand & { reason: string };
	"kitchen-transition": RevisionCommand & { status: "preparing" | "ready" | "served" };
	"create-payment": RevisionCommand;
	"request-invoice": Command & { paymentId: string; buyer: Buyer };
	"issue-invoice": RevisionCommand;
	"correct-invoice": RevisionCommand & {
		kind: "adjustment" | "replacement";
		reason: string;
		buyer: Buyer;
		lines: { name: string; quantity: number; unitPrice: number; taxRate: number }[];
	};
	"reconcile-invoice": RevisionCommand;
	"invoice-file": { branchId: string; id: string; type: "pdf" | "xml" };
	export: {
		branchId: string;
		kind: "sales" | "payments" | "invoices" | "audit";
		from: string;
		to: string;
		cursor?: string;
		limit?: number;
	};
}
