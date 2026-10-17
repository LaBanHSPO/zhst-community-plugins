export const PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const MAX_CSV_BYTES = 4_000_000;
export const MAX_IMPORT_ROWS = 10_000;
export const MAX_EXPORT_ROWS = 10_000;
export const MAX_AMOUNT_MINOR = 1_000_000_000_000_000;

export type MemberStatus = 'active' | 'paused';
export type FundKind = 'in' | 'out';
export type ApprovalStatus = 'pending' | 'approved';
export type DocumentType = 'decision' | 'resolution' | 'circular' | 'report' | 'ledger';

export interface Metadata {
	schemaVersion: 1;
	createdAt: string;
	updatedAt: string;
	createdBy: string;
	updatedBy: string;
}

export interface Member extends Metadata {
	code: string;
	fullName: string;
	birthYear: number | null;
	address: string;
	phone: string;
	cccd: string;
	status: MemberStatus;
	nameKey: string;
	codeKey: string;
	searchKey: string;
}

export interface FundEntry extends Metadata {
	date: string;
	kind: FundKind;
	category: string;
	description: string;
	amountMinor: number;
	documentRef: string;
	status: ApprovalStatus;
	approvedAt?: string;
	approvedBy?: string;
	monthKey: string;
	approvedAmountMinor: number;
}

export interface DocumentRecord extends Metadata {
	number: string;
	title: string;
	type: DocumentType;
	date: string;
	signer: string;
	fileUrl: string;
	fileName: string;
	isPublic: boolean;
	titleKey: string;
}

export interface RecordView<T> {
	id: string;
	revision: string;
	value: T;
}

export interface ListPage<T> {
	items: { id: string; value: T }[];
	cursor?: string;
	hasMore: boolean;
}

export type ApiResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: { code: string; message: string } };

export interface Info {
	version: '0.1.0';
	currency: 'VND';
	minorUnits: 0;
	pageSize: number;
	documentTypes: DocumentType[];
	fundCategories: string[];
}

export interface MemberInput {
	code: string;
	fullName: string;
	birthYear: number | null;
	address: string;
	phone: string;
	cccd: string;
	status: MemberStatus;
}

export interface ListMembersInput {
	search?: string;
	status?: MemberStatus;
	cursor?: string;
}

export interface ImportMembersInput {
	csv: string;
	dryRun?: boolean;
}

export interface ImportMembersResult {
	created: number;
	updated: number;
	skipped: number;
	errors: { line: number; message: string }[];
}

export interface FundListInput {
	year?: number;
	month?: number;
	kind?: FundKind;
	category?: string;
	status?: ApprovalStatus;
	cursor?: string;
}

export interface FundSaveInput {
	id: string;
	revision: string | null;
	date: string;
	kind: FundKind;
	category: string;
	description: string;
	amountMinor: number;
	documentRef: string;
}

export interface FundApproveInput {
	id: string;
	revision: string;
}

export interface DocumentListInput {
	search?: string;
	type?: DocumentType;
	year?: number;
	cursor?: string;
}

export interface DocumentSaveInput {
	id: string;
	revision: string | null;
	number: string;
	title: string;
	type: DocumentType;
	date: string;
	signer: string;
	fileUrl: string;
	fileName: string;
	isPublic: boolean;
}

export interface FundTotals {
	currency: 'VND';
	minorUnits: 0;
	totalInMinor: number;
	totalOutMinor: number;
	balanceMinor: number;
	pendingCount: number;
	monthly: { month: number; inMinor: number; outMinor: number }[];
	byCategory: { category: string; amountMinor: number }[];
}

export interface PublicFundEntry {
	date: string;
	kind: FundKind;
	category: string;
	description: string;
	amountMinor: number;
}

export interface PublicFund {
	totals: FundTotals;
	recent: PublicFundEntry[];
}

export interface PublicDocument {
	number: string;
	title: string;
	type: DocumentType;
	date: string;
	signer: string;
	fileUrl: string;
	fileName: string;
}
