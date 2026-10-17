import { z } from "zod";
import type {
	ActionInputs,
	Actor,
	Bill,
	BillLine,
	Branch,
	Buyer,
	CommandResult,
	ExportResult,
	GuestMenu,
	GuestSession,
	GuestStatus,
	Info,
	Invoice,
	Job,
	Member,
	Order,
	OrderLine,
	Payment,
	PaymentException,
	Role,
	Shift,
	Table,
	Visit,
	Workspace,
} from "./types.js";
import { issuerSchema, schemas } from "./validation.js";
import {
	branchDto,
	canonical,
	columns,
	csvCell,
	DomainError,
	exactVnd,
	hash,
	menuDto,
	paymentDto,
	taxIncluded,
} from "./data.js";
import type {
	BillLineRow,
	BillRow,
	BranchRow,
	InvoiceRow,
	LineRow,
	MenuRow,
	OrderRow,
	RefundRow,
	ServiceRequestRow,
	ShiftRow,
	VisitRow,
} from "./data.js";
export { DomainError } from "./data.js";

type Access = { branchId: string; role: Role | "administrator"; memberVersion: number };
type CommandContext = { scope: string; commandId: string; payloadHash: string; access?: Access };
type Build = {
	statements: D1PreparedStatement[];
	result: unknown;
	entityId: string;
	branchId: string;
	detail?: unknown;
};
const finance: Role[] = ["manager", "cashier", "accountant"];
const floor: Role[] = ["manager", "floor", "cashier"];

export class RestaurantService {
	constructor(
		private readonly db: D1Database,
		private readonly actor: Actor | null,
	) {}

	async execute(action: string, input: unknown): Promise<unknown> {
		try {
			switch (action) {
				case "info":
					schemas.info.parse(input);
					return await this.info();
				case "workspace":
					return await this.workspace(schemas.workspace.parse(input));
				case "save-branch":
					return await this.saveBranch(schemas["save-branch"].parse(input));
				case "save-member":
					return await this.saveMember(schemas["save-member"].parse(input));
				case "save-table":
					return await this.saveTable(schemas["save-table"].parse(input));
				case "save-menu-item":
					return await this.saveMenu(schemas["save-menu-item"].parse(input));
				case "open-visit":
					return await this.openVisit(schemas["open-visit"].parse(input));
				case "close-visit":
					return await this.closeVisit(schemas["close-visit"].parse(input));
				case "open-shift":
					return await this.openShift(schemas["open-shift"].parse(input));
				case "close-shift":
					return await this.closeShift(schemas["close-shift"].parse(input));
				case "freeze-bill":
					return await this.freezeBill(schemas["freeze-bill"].parse(input));
				case "settle-bill":
					return await this.settleBill(schemas["settle-bill"].parse(input));
				case "apply-discount":
					return await this.applyDiscount(schemas["apply-discount"].parse(input));
				case "refund-bill":
					return await this.refundBill(schemas["refund-bill"].parse(input));
				case "call-service":
					return await this.callService(schemas["call-service"].parse(input));
				case "attend-request":
					return await this.attendRequest(schemas["attend-request"].parse(input));
				case "join-table":
					return await this.join(schemas["join-table"].parse(input));
				case "menu":
					return await this.menu(schemas.menu.parse(input));
				case "guest-status":
					return await this.guestStatus(schemas["guest-status"].parse(input));
				case "submit-order":
					return await this.submit(schemas["submit-order"].parse(input));
				case "confirm-order":
					return await this.orderCommand(action, schemas[action].parse(input));
				case "reject-order":
					return await this.orderCommand(action, schemas[action].parse(input));
				case "void-order":
					return await this.orderCommand(action, schemas[action].parse(input));
				case "kitchen-transition":
					return await this.kitchen(schemas["kitchen-transition"].parse(input));
				case "create-payment":
					return await this.createPayment(schemas["create-payment"].parse(input));
				case "request-invoice":
					return await this.requestInvoice(schemas["request-invoice"].parse(input));
				case "correct-invoice":
					return await this.correctInvoice(schemas["correct-invoice"].parse(input));
				case "issue-invoice":
					return await this.invoiceCommand(action, schemas[action].parse(input));
				case "reconcile-invoice":
					return await this.invoiceCommand(action, schemas[action].parse(input));
				case "invoice-file": {
					const data = schemas["invoice-file"].parse(input);
					await this.access(data.branchId, finance);
					await this.invoice(data.branchId, data.id);
					return { invoiceId: data.id, branchId: data.branchId };
				}
				case "export":
					return await this.exportRows(schemas.export.parse(input));
				default:
					throw new DomainError("UNKNOWN_ACTION", "Unknown restaurant action", 404);
			}
		} catch (error) {
			if (error instanceof DomainError) throw error;
			if (error instanceof z.ZodError)
				throw new DomainError(
					"VALIDATION_ERROR",
					error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
				);
			console.error("[restaurant] operation failed", { action, error });
			throw new DomainError("INTERNAL_ERROR", "Restaurant operation failed", 500);
		}
	}

	private stmt(sql: string, ...values: (string | number | null)[]): D1PreparedStatement {
		return this.db.prepare(sql).bind(...values);
	}
	private async rows<T>(sql: string, ...values: (string | number | null)[]): Promise<T[]> {
		return (await this.stmt(sql, ...values).all<T>()).results;
	}
	private async required<T>(sql: string, ...values: (string | number | null)[]): Promise<T> {
		const row = await this.stmt(sql, ...values).first<T>();
		if (!row) throw new DomainError("NOT_FOUND", "Restaurant record not found", 404);
		return row;
	}
	private assertion(sql: string, ...values: (string | number | null)[]): D1PreparedStatement[] {
		const id = crypto.randomUUID();
		return [
			this.stmt(
				`INSERT INTO rc_assertions(id,ok) VALUES (?,CASE WHEN (${sql}) THEN 1 ELSE 0 END)`,
				id,
				...values,
			),
			this.stmt("DELETE FROM rc_assertions WHERE id=?", id),
		];
	}
	private fenced(statement: D1PreparedStatement): D1PreparedStatement[] {
		return [statement, ...this.assertion("changes()=1")];
	}
	private async access(branchId: string, roles?: Role[]): Promise<Access> {
		if (!this.actor) throw new DomainError("UNAUTHENTICATED", "Sign in to continue", 401);
		if (this.actor.administrator) return { branchId, role: "administrator", memberVersion: 0 };
		const member = await this.stmt(
			"SELECT role,version FROM rc_members WHERE branch_id=? AND user_id=? AND active=1",
			branchId,
			this.actor.id,
		).first<{ role: Role; version: number }>();
		if (!member || (roles && !roles.includes(member.role)))
			throw new DomainError("FORBIDDEN", "This branch action is not permitted", 403);
		return { branchId, role: member.role, memberVersion: member.version };
	}
	private async context(
		action: string,
		input: { commandId: string },
		access?: Access,
		guestScope?: string,
	): Promise<CommandContext> {
		return {
			scope: guestScope ?? `actor:${this.actor?.id}`,
			commandId: input.commandId,
			payloadHash: await hash(canonical({ action, input })),
			access,
		};
	}
	private async replay(context: CommandContext): Promise<{ result: unknown } | null> {
		const row = await this.stmt(
			"SELECT payload_hash,result_json FROM rc_commands WHERE scope=? AND id=?",
			context.scope,
			context.commandId,
		).first<{ payload_hash: string; result_json: string }>();
		if (!row) return null;
		if (row.payload_hash !== context.payloadHash)
			throw new DomainError(
				"IDEMPOTENCY_CONFLICT",
				"Command identifier was already used with different input",
				409,
			);
		return { result: JSON.parse(row.result_json) as unknown };
	}
	private async commit(
		context: CommandContext,
		action: string,
		build: () => Promise<Build>,
	): Promise<unknown> {
		const previous = await this.replay(context);
		if (previous) return previous.result;
		const work = await build();
		const now = Date.now();
		const statements = [
			this.stmt(
				"INSERT INTO rc_commands(scope,id,payload_hash,result_json,created_at) VALUES (?,?,?,?,?)",
				context.scope,
				context.commandId,
				context.payloadHash,
				JSON.stringify(work.result),
				now,
			),
		];
		if (context.access && context.access.role !== "administrator")
			statements.push(
				...this.assertion(
					"EXISTS(SELECT 1 FROM rc_members WHERE branch_id=? AND user_id=? AND version=? AND active=1)",
					context.access.branchId,
					this.actor!.id,
					context.access.memberVersion,
				),
			);
		statements.push(
			...work.statements,
			this.stmt(
				"INSERT INTO rc_audit(id,branch_id,actor_id,action,entity_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)",
				crypto.randomUUID(),
				work.branchId,
				this.actor?.id ?? null,
				action,
				work.entityId,
				JSON.stringify(work.detail ?? {}),
				now,
			),
		);
		try {
			await this.db.batch(statements);
		} catch (error) {
			const winner = await this.replay(context);
			if (winner) return winner.result;
			if (
				String(error).includes("constraint") ||
				String(error).includes("CONSTRAINT") ||
				String(error).includes("rc_guard")
			)
				throw new DomainError(
					"CONFLICT",
					"The record changed or the operation is no longer allowed. Refresh before retrying.",
					409,
				);
			throw error;
		}
		return work.result;
	}
	private async branch(id: string): Promise<Branch> {
		return branchDto(
			await this.required<BranchRow>(`SELECT ${columns.branch} FROM rc_branches WHERE id=?`, id),
		);
	}
	private async visit(branchId: string, id: string): Promise<Visit> {
		return this.required<Visit>(
			`SELECT ${columns.visit} FROM rc_visits WHERE branch_id=? AND id=?`,
			branchId,
			id,
		);
	}
	private async invoice(branchId: string, id: string): Promise<InvoiceRow> {
		return this.required<InvoiceRow>(
			`SELECT ${columns.invoice},credential_context AS credentialContext,environment,payload_json AS payloadJson,issuer_json AS issuerJson FROM rc_invoices WHERE branch_id=? AND id=?`,
			branchId,
			id,
		);
	}
	private async guest(token: string): Promise<VisitRow> {
		const visit = await this.stmt(
			`SELECT ${columns.visit
				.split(",")
				.map((field) => `v.${field}`)
				.join(
					",",
				)},v.branch_id AS branchId FROM rc_visits v JOIN rc_guest_sessions g ON g.visit_id=v.id WHERE g.token_hash=?`,
			await hash(token),
		).first<VisitRow>();
		if (!visit || visit.status === "closed" || visit.expiresAt <= Date.now())
			throw new DomainError("SESSION_CLOSED", "The table visit is closed or expired", 403);
		return visit;
	}
	private guestFence(visit: VisitRow): D1PreparedStatement[] {
		return this.assertion(
			"EXISTS(SELECT 1 FROM rc_visits WHERE id=? AND status<>'closed' AND expires_at>?)",
			visit.id,
			Date.now(),
		);
	}

	private async info(): Promise<Info> {
		if (!this.actor) throw new DomainError("UNAUTHENTICATED", "Sign in to continue", 401);
		const branches = this.actor.administrator
			? await this.rows<Info["branches"][number]>(
					"SELECT id,name,'administrator' AS role FROM rc_branches ORDER BY name,id LIMIT 500",
				)
			: await this.rows<Info["branches"][number]>(
					"SELECT b.id,b.name,m.role FROM rc_branches b JOIN rc_members m ON m.branch_id=b.id WHERE m.user_id=? AND m.active=1 ORDER BY b.name,b.id LIMIT 500",
					this.actor.id,
				);
		return { administrator: this.actor.administrator, branches };
	}
	private async orders(where: string, values: (string | number)[]): Promise<Order[]> {
		const orders = await this.rows<OrderRow>(
			`SELECT ${columns.order} FROM rc_orders WHERE ${where}`,
			...values,
		);
		if (!orders.length) return [];
		const lines: LineRow[] = [];
		for (let offset = 0; offset < orders.length; offset += 90) {
			const ids = orders.slice(offset, offset + 90).map((order) => order.id);
			lines.push(
				...(await this.rows<LineRow>(
					`SELECT ${columns.line},order_id AS orderId FROM rc_order_lines WHERE order_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
					...ids,
				)),
			);
		}
		const grouped = new Map<string, OrderLine[]>();
		for (const line of lines) {
			const { modifiersJson, orderId, ...rest } = line;
			const group = grouped.get(orderId) ?? [];
			group.push({ ...rest, modifiers: JSON.parse(modifiersJson) as OrderLine["modifiers"] });
			grouped.set(orderId, group);
		}
		return orders.map((order) => ({ ...order, lines: grouped.get(order.id) ?? [] }));
	}
	private async bills(where: string, values: (string | number)[]): Promise<Bill[]> {
		const bills = await this.rows<BillRow>(
			`SELECT ${columns.bill} FROM rc_bills WHERE ${where}`,
			...values,
		);
		if (!bills.length) return [];
		const lines: BillLineRow[] = [];
		for (let offset = 0; offset < bills.length; offset += 90) {
			const ids = bills.slice(offset, offset + 90).map((bill) => bill.id);
			lines.push(
				...(await this.rows<BillLineRow>(
					`SELECT ${columns.billLine} FROM rc_bill_lines WHERE bill_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
					...ids,
				)),
			);
		}
		const grouped = new Map<string, BillLine[]>();
		for (const line of lines) {
			const group = grouped.get(line.billId) ?? [];
			group.push(line);
			grouped.set(line.billId, group);
		}
		return bills.map((bill) => ({ ...bill, lines: grouped.get(bill.id) ?? [] }));
	}
	private async workspace(input: ActionInputs["workspace"]): Promise<Workspace> {
		const access = await this.access(input.branchId);
		const branch = await this.branch(input.branchId);
		const limit = input.limit ?? 50;
		const cursor = input.cursor ?? "";
		const privateFinance = access.role === "administrator" || finance.includes(access.role);
		const manager = access.role === "administrator" || access.role === "manager";
		const [tables, visits, menu, orders, members, payments, invoices, jobs, exceptions, bills, shift, shifts, serviceRequests, refunds] =
			await Promise.all([
				this.rows<Table>(
					"SELECT id,name,token,version FROM rc_tables WHERE branch_id=? AND id>? ORDER BY id LIMIT ?",
					branch.id,
					cursor,
					limit + 1,
				),
				this.rows<Workspace["visits"][number]>(
					`SELECT ${columns.visit},
				(SELECT COALESCE(SUM(o.total),0) FROM rc_orders o WHERE o.visit_id=rc_visits.id AND o.status='confirmed') AS total,
				(SELECT COUNT(*) FROM rc_orders o WHERE o.visit_id=rc_visits.id AND o.status='pending') AS pendingCount,
				(SELECT COUNT(*) FROM rc_order_lines l JOIN rc_orders o ON o.id=l.order_id WHERE o.visit_id=rc_visits.id AND o.status='confirmed' AND l.kitchen_status<>'served') AS unsettledCount
				FROM rc_visits WHERE branch_id=? AND id>? ORDER BY id LIMIT ?`,
					branch.id,
					cursor,
					limit + 1,
				),
				this.rows<MenuRow>(
					`SELECT ${columns.menu} FROM rc_menu WHERE branch_id=? AND id>? ORDER BY id LIMIT ?`,
					branch.id,
					cursor,
					limit + 1,
				),
				this.orders(
					`branch_id=? AND id>? ${access.role === "kitchen" ? "AND status='confirmed'" : ""} ORDER BY id LIMIT ?`,
					[branch.id, cursor, limit + 1],
				),
				manager
					? this.rows<Omit<Member, "active"> & { active: number }>(
							"SELECT user_id AS userId,role,active,version FROM rc_members WHERE branch_id=? AND user_id>? ORDER BY user_id LIMIT ?",
							branch.id,
							cursor,
							limit + 1,
						)
					: [],
				privateFinance
					? this.rows<Omit<Payment, "qrUrl">>(
							`SELECT ${columns.payment} FROM rc_payment_attempts WHERE branch_id=? AND id>? ORDER BY id LIMIT ?`,
							branch.id,
							cursor,
							limit + 1,
						)
					: [],
				privateFinance
					? this.rows<Invoice>(
							`SELECT ${columns.invoice} FROM rc_invoices WHERE branch_id=? AND id>? ORDER BY id LIMIT ?`,
							branch.id,
							cursor,
							limit + 1,
						)
					: [],
				privateFinance
					? this.rows<Job>(
							"SELECT o.id,i.id AS invoiceId,o.kind,o.state,o.attempts,o.last_error AS lastError,o.available_at AS availableAt FROM rc_outbox o JOIN rc_invoices i ON json_extract(o.payload_json,'$.invoiceId')=i.id WHERE i.branch_id=? AND o.id>? ORDER BY o.id LIMIT ?",
							branch.id,
							cursor,
							limit + 1,
						)
					: [],
				privateFinance
					? this.rows<PaymentException>(
							`
				WITH accounts AS (
					SELECT environment,credential_context,bank_account,bank_code,bank_name,sub_account FROM rc_branches WHERE id=?
					UNION SELECT environment,credential_context,bank_account,bank_code,bank_name,sub_account FROM rc_payment_attempts WHERE branch_id=?
				)
				SELECT x.id,x.exception,x.provider_transaction_id AS providerTransactionId,x.created_at AS createdAt
				FROM rc_payment_inbox x LEFT JOIN rc_payment_attempts p ON p.id=x.payment_id
				WHERE x.exception IS NOT NULL AND x.id>? AND (p.branch_id=? OR (
					x.payment_id IS NULL AND EXISTS(SELECT 1 FROM accounts a WHERE a.environment=x.environment
						AND a.credential_context=x.credential_context AND a.bank_account=json_extract(x.payload_json,'$.accountNumber')
						AND lower(json_extract(x.payload_json,'$.gateway')) IN (lower(a.bank_code),lower(a.bank_name))
						AND a.sub_account=COALESCE(json_extract(x.payload_json,'$.subAccount'),''))))
				UNION ALL
				SELECT r.id,'BANK_IDENTITY_REVIEW' AS exception,r.provider_transaction_id AS providerTransactionId,r.created_at AS createdAt
				FROM rc_bank_reconciliation r WHERE r.id>? AND r.state IN ('candidate_match','identity_review')
					AND EXISTS(SELECT 1 FROM accounts a WHERE a.environment=r.environment
						AND a.credential_context=r.credential_context AND a.bank_account=json_extract(r.payload_json,'$.account_number')
						AND lower(json_extract(r.payload_json,'$.bank_brand_name')) IN (lower(a.bank_code),lower(a.bank_name))
						AND a.sub_account=COALESCE(json_extract(r.payload_json,'$.va'),''))
				ORDER BY id LIMIT ?`,
							branch.id,
							branch.id,
							cursor,
							branch.id,
							cursor,
							limit + 1,
						)
					: [],
				privateFinance
					? this.bills("branch_id=? AND id>? ORDER BY id LIMIT ?", [branch.id, cursor, limit + 1])
					: [],
				privateFinance
					? this.stmt(
							`SELECT ${columns.shift} FROM rc_shifts WHERE branch_id=? AND status='open'`,
							branch.id,
						).first<ShiftRow>()
					: null,
				privateFinance
					? this.rows<ShiftRow>(
							`SELECT ${columns.shift} FROM rc_shifts WHERE branch_id=? ORDER BY opened_at DESC,id DESC LIMIT 20`,
							branch.id,
						)
					: [],
				access.role === "kitchen"
					? []
					: this.rows<ServiceRequestRow>(
							`SELECT ${columns.serviceRequest} FROM rc_service_requests WHERE branch_id=? AND id>? ORDER BY id LIMIT ?`,
							branch.id,
							cursor,
							limit + 1,
						),
				privateFinance
					? this.rows<RefundRow>(
							`SELECT ${columns.refund} FROM rc_refunds WHERE branch_id=? AND id>? ORDER BY id LIMIT ?`,
							branch.id,
							cursor,
							limit + 1,
						)
					: [],
			]);
		const pages = [tables, visits, menu, orders, payments, invoices, jobs, exceptions, bills, serviceRequests, refunds];
		const boundaries = pages
			.filter((page) => page.length > limit)
			.map((page) => page[limit - 1]!.id);
		if (members.length > limit) boundaries.push(members[limit - 1]!.userId);
		const nextCursor = boundaries.sort()[0] ?? null;
		const trim = <T extends { id: string }>(items: T[]): T[] =>
			items.filter((item) => !nextCursor || item.id <= nextCursor).slice(0, limit);
		return {
			branch:
				manager || privateFinance
					? branch
					: { id: branch.id, name: branch.name, version: branch.version },
			role: access.role,
			tables: trim(tables),
			visits: trim(visits),
			menu: trim(menu).map(menuDto),
			orders: trim(orders),
			members: members
				.filter((member) => !nextCursor || member.userId <= nextCursor)
				.slice(0, limit)
				.map((member) => ({ ...member, active: member.active === 1 })),
			payments: trim(payments).map(paymentDto),
			invoices: trim(invoices),
			jobs: trim(jobs),
			exceptions: trim(exceptions),
			shift: shift ?? null,
			shifts,
			bills: trim(bills),
			refunds: trim(refunds),
			serviceRequests: trim(serviceRequests),
			nextCursor,
		};
	}

	private async saveBranch(input: ActionInputs["save-branch"]): Promise<unknown> {
		if (!this.actor) throw new DomainError("UNAUTHENTICATED", "Sign in to continue", 401);
		if (!this.actor.administrator)
			throw new DomainError(
				"FORBIDDEN",
				"Only administrators can configure legal issuers and bank accounts",
				403,
			);
		const context = await this.context("save-branch", input);
		return this.commit(context, "save-branch", async () => {
			const id = input.id ?? crypto.randomUUID();
			const values = [
				input.name,
				input.bankAccount,
				input.bankCode,
				input.bankName,
				input.subAccount ?? "",
				input.qrMode ?? "direct",
				input.transferPrefix ?? "",
				input.credentialContext,
				input.environment,
				JSON.stringify(input.issuer),
			];
			const statements = input.id
				? this.fenced(
						this.stmt(
							"UPDATE rc_branches SET name=?,bank_account=?,bank_code=?,bank_name=?,sub_account=?,qr_mode=?,transfer_prefix=?,credential_context=?,environment=?,issuer_json=?,version=version+1 WHERE id=? AND version=?",
							...values,
							id,
							input.expectedVersion!,
						),
					)
				: [
						this.stmt(
							"INSERT INTO rc_branches(name,bank_account,bank_code,bank_name,sub_account,qr_mode,transfer_prefix,credential_context,environment,issuer_json,id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
							...values,
							id,
							Date.now(),
						),
					];
			return {
				statements,
				result: { id, version: (input.expectedVersion ?? 0) + 1 },
				branchId: id,
				entityId: id,
			};
		});
	}
	private async saveMember(input: ActionInputs["save-member"]): Promise<unknown> {
		const access = await this.access(input.branchId, ["manager"]);
		return this.commit(
			await this.context("save-member", input, access),
			"save-member",
			async () => {
				const statements = input.expectedVersion
					? this.fenced(
							this.stmt(
								"UPDATE rc_members SET role=?,active=?,version=version+1 WHERE branch_id=? AND user_id=? AND version=?",
								input.role,
								Number(input.active ?? true),
								input.branchId,
								input.userId,
								input.expectedVersion,
							),
						)
					: [
							this.stmt(
								"INSERT INTO rc_members(branch_id,user_id,role,active) VALUES (?,?,?,?)",
								input.branchId,
								input.userId,
								input.role,
								Number(input.active ?? true),
							),
						];
				return {
					statements,
					result: { id: input.userId, version: (input.expectedVersion ?? 0) + 1 },
					branchId: input.branchId,
					entityId: input.userId,
					detail: { role: input.role, active: input.active ?? true },
				};
			},
		);
	}
	private async saveTable(input: ActionInputs["save-table"]): Promise<unknown> {
		const access = await this.access(input.branchId, ["manager"]);
		return this.commit(await this.context("save-table", input, access), "save-table", async () => {
			const id = input.id ?? crypto.randomUUID();
			const token =
				crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
			const statements = input.id
				? this.fenced(
						this.stmt(
							"UPDATE rc_tables SET name=?,version=version+1 WHERE branch_id=? AND id=? AND version=?",
							input.name,
							input.branchId,
							id,
							input.expectedVersion!,
						),
					)
				: [
						this.stmt(
							"INSERT INTO rc_tables(id,branch_id,name,token) VALUES (?,?,?,?)",
							id,
							input.branchId,
							input.name,
							token,
						),
					];
			return {
				statements,
				result: { id, version: (input.expectedVersion ?? 0) + 1 },
				branchId: input.branchId,
				entityId: id,
			};
		});
	}
	private async saveMenu(input: ActionInputs["save-menu-item"]): Promise<unknown> {
		const access = await this.access(input.branchId, ["manager"]);
		return this.commit(
			await this.context("save-menu-item", input, access),
			"save-menu-item",
			async () => {
				const id = input.id ?? crypto.randomUUID();
				const values = [
					input.name,
					input.category,
					input.description,
					input.image,
					input.price,
					input.taxRate,
					Number(input.available),
					JSON.stringify(input.modifiers),
				];
				const statements = input.id
					? this.fenced(
							this.stmt(
								"UPDATE rc_menu SET name=?,category=?,description=?,image=?,price=?,tax_rate=?,available=?,modifiers_json=?,version=version+1 WHERE branch_id=? AND id=? AND version=?",
								...values,
								input.branchId,
								id,
								input.expectedVersion!,
							),
						)
					: [
							this.stmt(
								"INSERT INTO rc_menu(name,category,description,image,price,tax_rate,available,modifiers_json,branch_id,id) VALUES (?,?,?,?,?,?,?,?,?,?)",
								...values,
								input.branchId,
								id,
							),
						];
				return {
					statements,
					result: { id, version: (input.expectedVersion ?? 0) + 1 },
					branchId: input.branchId,
					entityId: id,
				};
			},
		);
	}
	private async openVisit(input: ActionInputs["open-visit"]): Promise<unknown> {
		const access = await this.access(input.branchId, floor);
		return this.commit(await this.context("open-visit", input, access), "open-visit", async () => {
			const id = crypto.randomUUID();
			const now = Date.now();
			return {
				statements: [
					...this.fenced(
						this.stmt(
							"UPDATE rc_tables SET version=version+1 WHERE branch_id=? AND id=? AND version=?",
							input.branchId,
							input.tableId,
							input.expectedVersion,
						),
					),
					this.stmt(
						"INSERT INTO rc_visits(id,branch_id,table_id,status,expires_at,created_at) VALUES (?,?,?,'open',?,?)",
						id,
						input.branchId,
						input.tableId,
						now + 24 * 60 * 60 * 1000,
						now,
					),
				],
				result: { id, version: 1 },
				branchId: input.branchId,
				entityId: id,
			};
		});
	}
	private async closeVisit(input: ActionInputs["close-visit"]): Promise<unknown> {
		const access = await this.access(input.branchId, floor);
		return this.commit(
			await this.context("close-visit", input, access),
			"close-visit",
			async () => ({
				statements: [
					...this.assertion(
						"NOT EXISTS(SELECT 1 FROM rc_orders WHERE visit_id=? AND status='pending') AND NOT EXISTS(SELECT 1 FROM rc_orders o JOIN rc_order_lines l ON l.order_id=o.id WHERE o.visit_id=? AND o.status='confirmed' AND l.kitchen_status<>'served')",
						input.id,
						input.id,
					),
					...this.fenced(
						this.stmt(
							"UPDATE rc_visits SET status='closed',closed_at=?,version=version+1 WHERE id=? AND branch_id=? AND version=? AND (status='paid' OR (status='open' AND NOT EXISTS(SELECT 1 FROM rc_orders WHERE visit_id=? AND status='confirmed')))",
							Date.now(),
							input.id,
							input.branchId,
							input.expectedVersion,
							input.id,
						),
					),
				],
				result: { id: input.id, version: input.expectedVersion + 1 },
				branchId: input.branchId,
				entityId: input.id,
			}),
		);
	}
	private async openShift(input: ActionInputs["open-shift"]): Promise<unknown> {
		const access = await this.access(input.branchId, ["manager", "cashier"]);
		return this.commit(await this.context("open-shift", input, access), "open-shift", async () => {
			const id = crypto.randomUUID();
			return {
				statements: [
					...this.assertion(
						"NOT EXISTS(SELECT 1 FROM rc_shifts WHERE branch_id=? AND status='open')",
						input.branchId,
					),
					this.stmt(
						"INSERT INTO rc_shifts(id,branch_id,status,opened_by,opened_at,opening_float) VALUES (?,?,'open',?,?,?)",
						id,
						input.branchId,
						this.actor?.id ?? null,
						Date.now(),
						input.openingFloat,
					),
				],
				result: { id, version: 1 },
				branchId: input.branchId,
				entityId: id,
				detail: { openingFloat: input.openingFloat },
			};
		});
	}
	private async closeShift(input: ActionInputs["close-shift"]): Promise<unknown> {
		const access = await this.access(input.branchId, ["manager", "cashier"]);
		return this.commit(await this.context("close-shift", input, access), "close-shift", async () => {
			const shift = await this.required<{ status: string; openingFloat: number }>(
				"SELECT status,opening_float AS openingFloat FROM rc_shifts WHERE branch_id=? AND id=?",
				input.branchId,
				input.id,
			);
			if (shift.status !== "open")
				throw new DomainError("CONFLICT", "This shift is already closed", 409);
			const cash = await this.required<{ total: number }>(
				"SELECT COALESCE(SUM(COALESCE(amount,total)),0) AS total FROM rc_bills WHERE branch_id=? AND shift_id=? AND status='settled' AND method='cash'",
				input.branchId,
				input.id,
			);
			const refunds = await this.required<{ total: number }>(
				"SELECT COALESCE(SUM(amount),0) AS total FROM rc_refunds WHERE branch_id=? AND shift_id=? AND method='cash'",
				input.branchId,
				input.id,
			);
			const expectedCash = exactVnd(
				BigInt(shift.openingFloat) + BigInt(cash.total) - BigInt(refunds.total),
				true,
			);
			const variance = input.countedCash - expectedCash;
			return {
				statements: [
					...this.fenced(
						this.stmt(
							"UPDATE rc_shifts SET status='closed',closed_by=?,closed_at=?,expected_cash=?,counted_cash=?,variance=?,note=?,version=version+1 WHERE branch_id=? AND id=? AND version=? AND status='open'",
							this.actor?.id ?? null,
							Date.now(),
							expectedCash,
							input.countedCash,
							variance,
							input.note,
							input.branchId,
							input.id,
							input.expectedVersion,
						),
					),
				],
				result: { id: input.id, version: input.expectedVersion + 1, expectedCash, variance },
				branchId: input.branchId,
				entityId: input.id,
				detail: { countedCash: input.countedCash, expectedCash, variance },
			};
		});
	}
	private async freezeBill(input: ActionInputs["freeze-bill"]): Promise<unknown> {
		const access = await this.access(input.branchId, ["manager", "cashier"]);
		return this.commit(await this.context("freeze-bill", input, access), "freeze-bill", async () => {
			const visit = await this.visit(input.branchId, input.id);
			const blockers = await this.required<{ pending: number; unsettled: number }>(
				`SELECT (SELECT COUNT(*) FROM rc_orders WHERE visit_id=? AND status='pending') AS pending,
				(SELECT COUNT(*) FROM rc_order_lines l JOIN rc_orders o ON o.id=l.order_id WHERE o.visit_id=? AND o.status='confirmed' AND l.kitchen_status<>'served') AS unsettled`,
				visit.id,
				visit.id,
			);
			if (blockers.pending)
				throw new DomainError("PENDING_ORDERS", "Resolve pending requests before billing", 409);
			if (blockers.unsettled)
				throw new DomainError("UNSERVED_DISHES", "Serve every billed dish before billing", 409);
			const orders = await this.orders(
				"visit_id=? AND status='confirmed' AND bill_id IS NULL ORDER BY id",
				[visit.id],
			);
			if (!orders.length)
				throw new DomainError("EMPTY_BILL", "A bill requires confirmed, unbilled items");
			const total = exactVnd(orders.reduce((sum, order) => sum + BigInt(order.total), 0n));
			const billId = crypto.randomUUID();
			const shift = await this.stmt("SELECT id FROM rc_shifts WHERE branch_id=? AND status='open'")
				.bind(input.branchId)
				.first<{ id: string }>();
			const statements: D1PreparedStatement[] = [
				...this.fenced(
					this.stmt(
						"UPDATE rc_visits SET status='billing',version=version+1 WHERE branch_id=? AND id=? AND version=? AND status IN ('open','paid')",
						input.branchId,
						visit.id,
						input.expectedVersion,
					),
				),
				this.stmt(
					"INSERT INTO rc_bills(id,branch_id,visit_id,shift_id,status,total,created_by,created_at) VALUES (?,?,?,?,'open',?,?,?)",
					billId,
					input.branchId,
					visit.id,
					shift?.id ?? null,
					total,
					this.actor?.id ?? null,
					Date.now(),
				),
				this.stmt(
					"UPDATE rc_orders SET bill_id=? WHERE branch_id=? AND visit_id=? AND status='confirmed' AND bill_id IS NULL",
					billId,
					input.branchId,
					visit.id,
				),
			];
			for (const order of orders)
				for (const line of order.lines)
					statements.push(
						this.stmt(
							"INSERT INTO rc_bill_lines(id,bill_id,order_id,name,quantity,unit_price,tax_rate,total) VALUES (?,?,?,?,?,?,?,?)",
							crypto.randomUUID(),
							billId,
							order.id,
							line.name,
							line.quantity,
							line.unitPrice,
							line.taxRate,
							line.total,
						),
					);
			return {
				statements,
				result: { id: billId, version: 1 },
				branchId: input.branchId,
				entityId: billId,
				detail: { visitId: visit.id, total, orderCount: orders.length },
			};
		});
	}
	private async settleBill(input: ActionInputs["settle-bill"]): Promise<unknown> {
		const access = await this.access(input.branchId, ["manager", "cashier"]);
		return this.commit(await this.context("settle-bill", input, access), "settle-bill", async () => {
			const bill = await this.required<{
				visitId: string;
				status: string;
				total: number;
				discount: number;
			}>(
				"SELECT visit_id AS visitId,status,total,discount FROM rc_bills WHERE branch_id=? AND id=?",
				input.branchId,
				input.id,
			);
			if (bill.status !== "open")
				throw new DomainError("CONFLICT", "This bill is already settled", 409);
			const payable = exactVnd(BigInt(bill.total) - BigInt(bill.discount));
			const shift = await this.stmt("SELECT id FROM rc_shifts WHERE branch_id=? AND status='open'")
				.bind(input.branchId)
				.first<{ id: string }>();
			if (input.method === "cash" && !shift)
				throw new DomainError("SHIFT_REQUIRED", "Open a shift before recording cash", 409);
			return {
				statements: [
					...this.fenced(
						this.stmt(
							"UPDATE rc_bills SET status='settled',method=?,reference=?,shift_id=?,settled_by=?,settled_at=?,amount=?,version=version+1 WHERE branch_id=? AND id=? AND version=? AND status='open'",
							input.method,
							input.reference || null,
							shift?.id ?? null,
							this.actor?.id ?? null,
							Date.now(),
							payable,
							input.branchId,
							input.id,
							input.expectedVersion,
						),
					),
					this.stmt(
						"UPDATE rc_visits SET status=CASE WHEN EXISTS(SELECT 1 FROM rc_orders WHERE visit_id=? AND bill_id IS NULL) THEN 'open' ELSE 'paid' END,version=version+1 WHERE id=? AND branch_id=? AND status='billing'",
						bill.visitId,
						bill.visitId,
						input.branchId,
					),
				],
				result: { id: input.id, version: input.expectedVersion + 1, amount: payable },
				branchId: input.branchId,
				entityId: input.id,
				detail: {
					visitId: bill.visitId,
					method: input.method,
					reference: input.reference || null,
					discount: bill.discount,
					amount: payable,
				},
			};
		});
	}
	private async applyDiscount(input: ActionInputs["apply-discount"]): Promise<unknown> {
		const access = await this.access(input.branchId, ["manager"]);
		return this.commit(await this.context("apply-discount", input, access), "apply-discount", async () => {
			const bill = await this.required<{ status: string; total: number }>(
				"SELECT status,total FROM rc_bills WHERE branch_id=? AND id=?",
				input.branchId,
				input.id,
			);
			if (bill.status !== "open")
				throw new DomainError("CONFLICT", "Only an open bill can be discounted", 409);
			const discount = input.amount ?? Math.floor((bill.total * (input.percent ?? 0)) / 100);
			if (discount <= 0 || discount > bill.total)
				throw new DomainError(
					"INVALID_DISCOUNT",
					"The discount must be positive and within the bill total",
				);
			return {
				statements: [
					...this.fenced(
						this.stmt(
							"UPDATE rc_bills SET discount=?,discount_reason=?,version=version+1 WHERE branch_id=? AND id=? AND version=? AND status='open'",
							discount,
							input.reason,
							input.branchId,
							input.id,
							input.expectedVersion,
						),
					),
				],
				result: { id: input.id, version: input.expectedVersion + 1, discount },
				branchId: input.branchId,
				entityId: input.id,
				detail: { discount, percent: input.percent ?? null, reason: input.reason },
			};
		});
	}
	private async refundBill(input: ActionInputs["refund-bill"]): Promise<unknown> {
		const access = await this.access(input.branchId, ["manager"]);
		return this.commit(await this.context("refund-bill", input, access), "refund-bill", async () => {
			const bill = await this.required<{ status: string; amount: number | null; refunded: number }>(
				"SELECT status,amount,refunded FROM rc_bills WHERE branch_id=? AND id=?",
				input.branchId,
				input.id,
			);
			if (bill.status !== "settled" || bill.amount === null)
				throw new DomainError("CONFLICT", "Only a settled bill can be refunded", 409);
			if (input.amount > bill.amount - bill.refunded)
				throw new DomainError("REFUND_EXCEEDS", "The refund exceeds the retained amount", 409);
			const shift = await this.stmt("SELECT id FROM rc_shifts WHERE branch_id=? AND status='open'")
				.bind(input.branchId)
				.first<{ id: string }>();
			if (input.method === "cash" && !shift)
				throw new DomainError("SHIFT_REQUIRED", "Open a shift before refunding cash", 409);
			const refundId = crypto.randomUUID();
			return {
				statements: [
					...this.fenced(
						this.stmt(
							"UPDATE rc_bills SET refunded=refunded+?,version=version+1 WHERE branch_id=? AND id=? AND version=? AND status='settled' AND amount IS NOT NULL AND refunded+?<=amount",
							input.amount,
							input.branchId,
							input.id,
							input.expectedVersion,
							input.amount,
						),
					),
					this.stmt(
						"INSERT INTO rc_refunds(id,branch_id,bill_id,shift_id,amount,method,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
						refundId,
						input.branchId,
						input.id,
						shift?.id ?? null,
						input.amount,
						input.method,
						input.reason,
						this.actor?.id ?? null,
						Date.now(),
					),
				],
				result: { id: input.id, version: input.expectedVersion + 1, refundId },
				branchId: input.branchId,
				entityId: input.id,
				detail: { refundId, amount: input.amount, method: input.method, reason: input.reason },
			};
		});
	}
	private async callService(input: ActionInputs["call-service"]): Promise<unknown> {
		const visit = await this.guest(input.token);
		return this.commit(
			await this.context("call-service", input, undefined, `guest:${await hash(input.token)}`),
			"call-service",
			async () => {
				const existing = await this.stmt(
					"SELECT id FROM rc_service_requests WHERE visit_id=? AND kind=? AND status='open'",
					visit.id,
					input.kind,
				).first<{ id: string }>();
				if (existing)
					throw new DomainError(
						"ALREADY_REQUESTED",
						"A request of this kind is already open",
						409,
					);
				const id = crypto.randomUUID();
				return {
					statements: [
						...this.guestFence(visit),
						...this.assertion(
							"NOT EXISTS(SELECT 1 FROM rc_service_requests WHERE visit_id=? AND kind=? AND status='open')",
							visit.id,
							input.kind,
						),
						this.stmt(
							"INSERT INTO rc_service_requests(id,branch_id,visit_id,kind,status,note,created_at) VALUES (?,?,?,?,'open',?,?)",
							id,
							visit.branchId,
							visit.id,
							input.kind,
							input.note,
							Date.now(),
						),
					],
					result: { id, version: 1 },
					branchId: visit.branchId,
					entityId: id,
					detail: { kind: input.kind },
				};
			},
		);
	}
	private async attendRequest(input: ActionInputs["attend-request"]): Promise<unknown> {
		const access = await this.access(input.branchId, floor);
		return this.commit(await this.context("attend-request", input, access), "attend-request", async () => {
			await this.required<{ id: string }>(
				"SELECT id FROM rc_service_requests WHERE branch_id=? AND id=?",
				input.branchId,
				input.id,
			);
			return {
				statements: [
					...this.fenced(
						this.stmt(
							"UPDATE rc_service_requests SET status='done',done_by=?,done_at=?,version=version+1 WHERE branch_id=? AND id=? AND version=? AND status='open'",
							this.actor?.id ?? null,
							Date.now(),
							input.branchId,
							input.id,
							input.expectedVersion,
						),
					),
				],
				result: { id: input.id, version: input.expectedVersion + 1 },
				branchId: input.branchId,
				entityId: input.id,
			};
		});
	}
	private async join(input: ActionInputs["join-table"]): Promise<unknown> {
		const table = await this.required<Table & { branchId: string }>(
			"SELECT id,name,token,version,branch_id AS branchId FROM rc_tables WHERE token=?",
			input.tableToken,
		);
		const visit = await this.required<Visit>(
			`SELECT ${columns.visit} FROM rc_visits WHERE table_id=? AND status='open' AND expires_at>?`,
			table.id,
			Date.now(),
		);
		return this.commit(
			await this.context(
				"join-table",
				input,
				undefined,
				`table:${await hash(input.tableToken)}:visit:${visit.id}`,
			),
			"join-table",
			async () => {
				const token =
					crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
				const branch = await this.branch(table.branchId);
				const result: GuestSession = {
					token,
					visit,
					branch: { id: branch.id, name: branch.name },
					table: { id: table.id, name: table.name },
				};
				return {
					statements: [
						...this.assertion(
							"EXISTS(SELECT 1 FROM rc_visits WHERE id=? AND status='open' AND expires_at>?)",
							visit.id,
							Date.now(),
						),
						this.stmt(
							"INSERT INTO rc_guest_sessions(token_hash,visit_id,created_at) VALUES (?,?,?)",
							await hash(token),
							visit.id,
							Date.now(),
						),
					],
					result,
					branchId: branch.id,
					entityId: visit.id,
				};
			},
		);
	}
	private async menu(input: ActionInputs["menu"]): Promise<GuestMenu> {
		const visit = await this.guest(input.token);
		const limit = input.limit ?? 50;
		const [branch, table, items] = await Promise.all([
			this.required<{ id: string; name: string }>(
				"SELECT id,name FROM rc_branches WHERE id=?",
				visit.branchId,
			),
			this.required<{ id: string; name: string }>(
				"SELECT id,name FROM rc_tables WHERE id=?",
				visit.tableId,
			),
			this.rows<MenuRow>(
				`SELECT ${columns.menu} FROM rc_menu WHERE branch_id=? AND id>? ORDER BY id LIMIT ?`,
				visit.branchId,
				input.cursor ?? "",
				limit + 1,
			),
		]);
		const { branchId: _branchId, ...publicVisit } = visit;
		return {
			branch,
			table,
			visit: publicVisit,
			items: items.slice(0, limit).map(menuDto),
			nextCursor: items.length > limit ? items[limit - 1]!.id : null,
		};
	}
	private async guestStatus(input: ActionInputs["guest-status"]): Promise<GuestStatus> {
		const visit = await this.guest(input.token);
		const limit = input.limit ?? 50;
		const orders = await this.orders("visit_id=? AND id>? ORDER BY id LIMIT ?", [
			visit.id,
			input.cursor ?? "",
			limit + 1,
		]);
		const total = await this.required<{ total: number }>(
			"SELECT COALESCE(SUM(total),0) AS total FROM rc_orders WHERE visit_id=? AND status='confirmed'",
			visit.id,
		);
		const requests = await this.rows<ServiceRequestRow>(
			`SELECT ${columns.serviceRequest} FROM rc_service_requests WHERE visit_id=? AND status='open' ORDER BY created_at,id`,
			visit.id,
		);
		const { branchId: _branchId, ...publicVisit } = visit;
		return {
			visit: publicVisit,
			orders: orders.slice(0, limit),
			total: total.total,
			requests,
			nextCursor: orders.length > limit ? orders[limit - 1]!.id : null,
		};
	}
	private async submit(input: ActionInputs["submit-order"]): Promise<unknown> {
		const visit = await this.guest(input.token);
		return this.commit(
			await this.context("submit-order", input, undefined, `guest:${await hash(input.token)}`),
			"submit-order",
			async () => {
				const id = crypto.randomUUID();
				const statements = [
					...this.guestFence(visit),
					...this.fenced(
						this.stmt(
							"UPDATE rc_visits SET status='open',version=version+1 WHERE id=? AND version=? AND status IN ('open','paid')",
							visit.id,
							input.expectedVersion,
						),
					),
				];
				let total = 0n;
				const lines: D1PreparedStatement[] = [];
				for (const requested of input.lines) {
					const row = await this.required<MenuRow>(
						`SELECT ${columns.menu} FROM rc_menu WHERE id=? AND branch_id=? AND available=1`,
						requested.menuItemId,
						visit.branchId,
					);
					const item = menuDto(row);
					const selected = requested.modifierIds.map((modifierId) => {
						const modifier = item.modifiers.find((candidate) => candidate.id === modifierId);
						if (!modifier)
							throw new DomainError("INVALID_MODIFIER", "A selected modifier is not available");
						return modifier;
					});
					const unitPrice = exactVnd(
						BigInt(item.price) +
							selected.reduce((sum, modifier) => sum + BigInt(modifier.price), 0n),
					);
					const lineTotal = exactVnd(BigInt(unitPrice) * BigInt(requested.quantity));
					total += BigInt(lineTotal);
					statements.push(
						...this.assertion(
							"EXISTS(SELECT 1 FROM rc_menu WHERE id=? AND branch_id=? AND version=? AND available=1)",
							item.id,
							visit.branchId,
							item.version,
						),
					);
					lines.push(
						this.stmt(
							"INSERT INTO rc_order_lines(id,order_id,menu_item_id,name,quantity,unit_price,tax_rate,modifiers_json,total,tax_amount) VALUES (?,?,?,?,?,?,?,?,?,?)",
							crypto.randomUUID(),
							id,
							item.id,
							item.name,
							requested.quantity,
							unitPrice,
							item.taxRate,
							JSON.stringify(selected),
							lineTotal,
							taxIncluded(lineTotal, item.taxRate),
						),
					);
				}
				statements.push(
					this.stmt(
						"INSERT INTO rc_orders(id,branch_id,visit_id,status,note,total,created_at) VALUES (?,?,?,'pending',?,?,?)",
						id,
						visit.branchId,
						visit.id,
						input.note,
						exactVnd(total),
						Date.now(),
					),
					...lines,
				);
				return { statements, result: { id, version: 1 }, branchId: visit.branchId, entityId: id };
			},
		);
	}
	private async orderCommand(
		action: "confirm-order" | "reject-order" | "void-order",
		input: ActionInputs["confirm-order"] & { reason?: string },
	): Promise<unknown> {
		const access = await this.access(
			input.branchId,
			action === "void-order" ? ["manager", "cashier"] : floor,
		);
		if (action === "void-order" && access.role === "cashier") {
			const preparing = await this.stmt(
				"SELECT COUNT(*) AS count FROM rc_order_lines WHERE order_id=? AND kitchen_status='preparing'",
				input.id,
			).first<{ count: number }>();
			if (preparing && preparing.count > 0)
				throw new DomainError(
					"MANAGER_REQUIRED",
					"Only a manager can void an item already in preparation",
					403,
				);
		}
		return this.commit(await this.context(action, input, access), action, async () => {
			const order = await this.required<OrderRow>(
				`SELECT ${columns.order} FROM rc_orders WHERE branch_id=? AND id=?`,
				input.branchId,
				input.id,
			);
			const status =
				action === "confirm-order"
					? "confirmed"
					: action === "reject-order"
						? "rejected"
						: "voided";
			const expected = action === "void-order" ? "confirmed" : "pending";
			const statements = [
				...this.fenced(
					this.stmt(
						"UPDATE rc_visits SET version=version+1 WHERE id=? AND status='open'",
						order.visitId,
					),
				),
				...this.fenced(
					this.stmt(
						`UPDATE rc_orders SET status=?,reason=?,version=version+1 WHERE id=? AND branch_id=? AND version=? AND status=?${action === "void-order" ? " AND bill_id IS NULL" : ""}`,
						status,
						input.reason ?? null,
						input.id,
						input.branchId,
						input.expectedVersion,
						expected,
					),
				),
			];
			if (action === "confirm-order")
				statements.unshift(
					...this.assertion(
						"(SELECT COALESCE(SUM(total),0) FROM rc_orders WHERE visit_id=? AND status='confirmed') + ? <= 9000000000000",
						order.visitId,
						order.total,
					),
				);
			return {
				statements,
				result: { id: input.id, version: input.expectedVersion + 1 },
				branchId: input.branchId,
				entityId: input.id,
				detail: { reason: input.reason ?? null, status },
			};
		});
	}
	private async kitchen(input: ActionInputs["kitchen-transition"]): Promise<unknown> {
		const access = await this.access(
			input.branchId,
			input.status === "served" ? floor : ["manager", "kitchen"],
		);
		return this.commit(
			await this.context("kitchen-transition", input, access),
			"kitchen-transition",
			async () => {
				const line = await this.required<{ visitId: string }>(
					"SELECT o.visit_id AS visitId FROM rc_order_lines l JOIN rc_orders o ON o.id=l.order_id WHERE l.id=? AND o.branch_id=? AND o.status='confirmed'",
					input.id,
					input.branchId,
				);
				const from =
					input.status === "preparing"
						? "queued"
						: input.status === "ready"
							? "preparing"
							: "ready";
				return {
					statements: [
						...this.fenced(
							this.stmt(
								"UPDATE rc_visits SET version=version+1 WHERE id=? AND status='open'",
								line.visitId,
							),
						),
						...this.fenced(
							this.stmt(
								"UPDATE rc_order_lines SET kitchen_status=?,version=version+1 WHERE id=? AND version=? AND kitchen_status=? AND EXISTS(SELECT 1 FROM rc_orders WHERE id=rc_order_lines.order_id AND status='confirmed' AND branch_id=?)",
								input.status,
								input.id,
								input.expectedVersion,
								from,
								input.branchId,
							),
						),
					],
					result: { id: input.id, version: input.expectedVersion + 1 },
					branchId: input.branchId,
					entityId: input.id,
					detail: { status: input.status },
				};
			},
		);
	}
	private async createPayment(input: ActionInputs["create-payment"]): Promise<unknown> {
		const access = await this.access(input.branchId, ["manager", "cashier"]);
		return this.commit(
			await this.context("create-payment", input, access),
			"create-payment",
			async () => {
				const branch = await this.branch(input.branchId);
				const visit = await this.visit(branch.id, input.id);
				const totals = await this.required<{ total: number }>(
					"SELECT COALESCE(SUM(total),0) AS total FROM rc_orders WHERE visit_id=? AND status='confirmed'",
					visit.id,
				);
				const amount = exactVnd(BigInt(totals.total));
				if (!amount)
					throw new DomainError("EMPTY_BILL", "A payment requires a positive confirmed bill");
				const id = crypto.randomUUID();
				const reference = `RC${id.replaceAll("-", "").slice(0, 30).toUpperCase()}`;
				const now = Date.now();
				const result = paymentDto({
					id,
					visitId: visit.id,
					reference,
					amount,
					bankAccount: branch.bankAccount,
					bankCode: branch.bankCode,
					bankName: branch.bankName,
					subAccount: branch.subAccount,
					qrMode: branch.qrMode,
					transferPrefix: branch.transferPrefix,
					status: "pending",
					version: 1,
					createdAt: now,
				});
				return {
					statements: [
						...this.assertion(
							"EXISTS(SELECT 1 FROM rc_branches WHERE id=? AND version=?)",
							branch.id,
							branch.version,
						),
						...this.assertion(
							"NOT EXISTS(SELECT 1 FROM rc_orders WHERE visit_id=? AND status='pending') AND NOT EXISTS(SELECT 1 FROM rc_orders o JOIN rc_order_lines l ON l.order_id=o.id WHERE o.visit_id=? AND o.status='confirmed' AND l.kitchen_status<>'served')",
							visit.id,
							visit.id,
						),
						...this.fenced(
							this.stmt(
								"UPDATE rc_visits SET status='billing',version=version+1 WHERE id=? AND branch_id=? AND version=? AND status IN ('open','billing')",
								visit.id,
								branch.id,
								input.expectedVersion,
							),
						),
						this.stmt(
							"UPDATE rc_payment_attempts SET status='superseded',version=version+1 WHERE visit_id=? AND status='pending'",
							visit.id,
						),
						this.stmt(
							"INSERT INTO rc_payment_attempts(id,branch_id,visit_id,reference,amount,bank_account,bank_code,bank_name,sub_account,qr_mode,transfer_prefix,credential_context,environment,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)",
							id,
							branch.id,
							visit.id,
							reference,
							amount,
							branch.bankAccount,
							branch.bankCode,
							branch.bankName,
							branch.subAccount,
							branch.qrMode,
							branch.transferPrefix,
							branch.credentialContext,
							branch.environment,
							now,
						),
					],
					result,
					branchId: branch.id,
					entityId: id,
				};
			},
		);
	}

	private invoicePayload(
		branch: Branch,
		buyer: Buyer,
		reference: string,
		lines: { name: string; quantity: number; unitPrice: number; taxRate: number }[],
	): Record<string, unknown> {
		let total = 0n;
		const items: {
			line_number: number;
			line_type: number;
			item_code: string;
			item_name: string;
			unit: string;
			quantity: number;
			unit_price: number;
			tax_rate: number;
			tax_amount: number;
		}[] = [];
		for (const [index, line] of lines.entries()) {
			const gross = exactVnd(BigInt(line.unitPrice) * BigInt(line.quantity), true);
			const taxAmount = branch.issuer.templateCode === "2" ? 0 : taxIncluded(gross, line.taxRate);
			total += BigInt(gross);
			const net = gross - taxAmount;
			const sign = net < 0 ? -1 : 1;
			const magnitude = BigInt(Math.abs(net));
			const quantity = BigInt(line.quantity);
			const basePrice = Number(magnitude / quantity);
			const highCount = Number(magnitude % quantity);
			const lowCount = line.quantity - highCount;
			const lowTax =
				Number((BigInt(Math.abs(taxAmount)) * BigInt(lowCount) + quantity / 2n) / quantity) *
				(taxAmount < 0 ? -1 : 1);
			for (const group of [
				{ quantity: lowCount, price: basePrice * sign, tax: lowTax },
				{ quantity: highCount, price: (basePrice + 1) * sign, tax: taxAmount - lowTax },
			]) {
				if (!group.quantity) continue;
				items.push({
					line_number: items.length + 1,
					line_type: 1,
					item_code: String(index + 1),
					item_name: line.name,
					unit: "phần",
					quantity: group.quantity,
					unit_price: group.price,
					tax_rate: branch.issuer.templateCode === "2" ? 0 : line.taxRate / 100,
					tax_amount: group.tax,
				});
			}
		}
		return {
			provider_account_id: branch.issuer.providerAccountId,
			template_code: branch.issuer.templateCode,
			invoice_series: branch.issuer.series,
			issued_date: new Date(Date.now() + 7 * 60 * 60 * 1000)
				.toISOString()
				.slice(0, 19)
				.replace("T", " "),
			currency: "VND",
			reference_code: reference,
			is_draft: true,
			payment_method: "CK",
			...(branch.issuer.sellerStoreXid ? { seller_store_xid: branch.issuer.sellerStoreXid } : {}),
			buyer: {
				type: buyer.taxCode ? "company" : "personal",
				name: buyer.name,
				legal_name: buyer.name,
				tax_code: buyer.taxCode,
				address: buyer.address,
				email: buyer.email,
				phone: "",
			},
			items,
			total_amount: exactVnd(total, true),
		};
	}
	private outbox(id: string, kind: string, invoiceId: string): D1PreparedStatement {
		const now = Date.now();
		return this.stmt(
			"INSERT INTO rc_outbox(id,kind,payload_json,state,attempts,available_at,created_at,updated_at) VALUES (?,?,?,'pending',0,?,?,?)",
			id,
			kind,
			JSON.stringify({ invoiceId }),
			now,
			now,
			now,
		);
	}
	private async requestInvoice(input: ActionInputs["request-invoice"]): Promise<unknown> {
		const access = await this.access(input.branchId, finance);
		return this.commit(
			await this.context("request-invoice", input, access),
			"request-invoice",
			async () => {
				const branch = await this.branch(input.branchId);
				const payment = await this.required<{ visitId: string; amount: number }>(
					"SELECT visit_id AS visitId,amount FROM rc_payment_attempts WHERE id=? AND branch_id=? AND status='paid'",
					input.paymentId,
					input.branchId,
				);
				const orders = await this.orders("visit_id=? AND status='confirmed' ORDER BY id", [
					payment.visitId,
				]);
				const lines = orders.flatMap((order) => order.lines);
				const id = crypto.randomUUID();
				const reference = `RCI${id.replaceAll("-", "")}`;
				const payload = this.invoicePayload(branch, input.buyer, reference, lines);
				if (payload.total_amount !== payment.amount)
					throw new DomainError(
						"BILL_MISMATCH",
						"Paid amount does not match the accepted bill",
						409,
					);
				const jobId = crypto.randomUUID();
				const now = Date.now();
				return {
					statements: [
						...this.assertion(
							"EXISTS(SELECT 1 FROM rc_branches WHERE id=? AND version=?) AND EXISTS(SELECT 1 FROM rc_payment_attempts WHERE id=? AND status='paid')",
							branch.id,
							branch.version,
							input.paymentId,
						),
						this.stmt(
							"INSERT INTO rc_invoices(id,branch_id,visit_id,payment_id,kind,status,reference,payload_json,issuer_json,credential_context,environment,created_at,updated_at) VALUES (?,?,?,?,'original','queued',?,?,?,?,?,?,?)",
							id,
							branch.id,
							payment.visitId,
							input.paymentId,
							reference,
							JSON.stringify(payload),
							JSON.stringify(branch.issuer),
							branch.credentialContext,
							branch.environment,
							now,
							now,
						),
						this.outbox(jobId, "invoice.create", id),
					],
					result: { id, version: 1, jobId } satisfies CommandResult,
					branchId: branch.id,
					entityId: id,
					detail: { issuer: branch.issuer, buyer: input.buyer, paymentId: input.paymentId },
				};
			},
		);
	}
	private async correctInvoice(input: ActionInputs["correct-invoice"]): Promise<unknown> {
		const access = await this.access(input.branchId, finance);
		return this.commit(
			await this.context("correct-invoice", input, access),
			"correct-invoice",
			async () => {
				const original = await this.invoice(input.branchId, input.id);
				const branch = await this.branch(input.branchId);
				if (input.kind === "replacement" && input.lines.some((line) => line.unitPrice < 0))
					throw new DomainError(
						"VALIDATION_ERROR",
						"Replacement lines cannot have negative prices",
					);
				const id = crypto.randomUUID();
				const reference = `RCI${id.replaceAll("-", "")}`;
				const originalIssuer = issuerSchema.parse(JSON.parse(original.issuerJson));
				const payload = this.invoicePayload(
					{ ...branch, issuer: originalIssuer },
					input.buyer,
					reference,
					input.lines,
				);
				delete payload.template_code;
				delete payload.invoice_series;
				payload.original_invoice_reference_code = original.reference;
				if (input.kind === "adjustment") {
					const decrease = input.lines.some((line) => line.unitPrice < 0);
					const increase = input.lines.some((line) => line.unitPrice > 0);
					payload.adjustment_type = decrease
						? increase
							? "combined"
							: "decrease"
						: increase
							? "increase"
							: "info";
					if (!decrease && !increase)
						payload.items = [{ line_number: 1, line_type: 4, item_name: input.reason }];
				}
				const jobId = crypto.randomUUID();
				const now = Date.now();
				return {
					statements: [
						...this.fenced(
							this.stmt(
								"UPDATE rc_invoices SET version=version+1,updated_at=? WHERE id=? AND branch_id=? AND version=? AND status='issued'",
								now,
								original.id,
								branch.id,
								input.expectedVersion,
							),
						),
						...this.assertion(
							"NOT EXISTS(SELECT 1 FROM rc_invoices WHERE original_invoice_id=? AND status NOT IN ('cancelled','failed'))",
							original.id,
						),
						this.stmt(
							"INSERT INTO rc_invoices(id,branch_id,visit_id,payment_id,kind,original_invoice_id,status,reference,payload_json,issuer_json,credential_context,environment,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?,?,?,?,?)",
							id,
							branch.id,
							original.visitId,
							original.paymentId,
							input.kind,
							original.id,
							reference,
							JSON.stringify(payload),
							JSON.stringify(originalIssuer),
							original.credentialContext,
							original.environment,
							now,
							now,
						),
						this.outbox(jobId, "invoice.create", id),
					],
					result: { id, version: 1, jobId } satisfies CommandResult,
					branchId: branch.id,
					entityId: id,
					detail: {
						reason: input.reason,
						originalInvoiceId: original.id,
						issuer: originalIssuer,
						buyer: input.buyer,
					},
				};
			},
		);
	}
	private async invoiceCommand(
		action: "issue-invoice" | "reconcile-invoice",
		input: ActionInputs["issue-invoice"],
	): Promise<unknown> {
		const access = await this.access(input.branchId, finance);
		return this.commit(await this.context(action, input, access), action, async () => {
			const invoice = await this.invoice(input.branchId, input.id);
			const jobId = crypto.randomUUID();
			const now = Date.now();
			let kind = action === "issue-invoice" ? "invoice.issue" : "invoice.reconcile";
			let update: D1PreparedStatement;
			if (action === "reconcile-invoice" && invoice.status === "queued") {
				const reviewed = await this.stmt(
					`
					SELECT o.id,o.kind FROM rc_outbox o JOIN rc_invoices i ON json_extract(o.payload_json,'$.invoiceId')=i.id
					WHERE i.id=? AND o.state='review' AND (
						(i.last_operation='issue' AND o.kind='invoice.issue') OR
						COALESCE(i.last_operation,'create')<>'issue' AND o.kind IN ('invoice.create','invoice.adjust','invoice.replace'))
					ORDER BY o.created_at DESC,o.id DESC LIMIT 1`,
					invoice.id,
				).first<{ id: string; kind: string }>();
				if (!reviewed)
					throw new DomainError(
						"CONFLICT",
						"Only a reviewed, undispatched invoice operation can be resumed",
						409,
					);
				kind = reviewed.kind;
				update = this.stmt(
					`
					UPDATE rc_invoices SET version=version+1,updated_at=? WHERE id=? AND branch_id=? AND version=?
						AND status='queued' AND dispatch_at IS NULL AND dispatch_token IS NULL AND issue_tracking_code IS NULL
						AND payload_json=?
						AND ((last_operation='issue' AND issue_payload_json IS NOT NULL AND (create_tracking_code IS NOT NULL OR (json_extract(provider_json,'$.status')='draft' AND json_extract(provider_json,'$.reference_code')=reference)) AND ?='invoice.issue')
							OR (COALESCE(last_operation,'create')<>'issue' AND create_tracking_code IS NULL AND provider_id IS NULL AND ?<>'invoice.issue'))
						AND EXISTS(SELECT 1 FROM rc_outbox WHERE id=? AND state='review' AND kind=?)`,
					now,
					invoice.id,
					input.branchId,
					input.expectedVersion,
					invoice.payloadJson,
					kind,
					kind,
					reviewed.id,
					kind,
				);
			} else if (action === "reconcile-invoice" && invoice.status === "pending") {
				kind = "invoice.poll";
				update = this.stmt(
					"UPDATE rc_invoices SET version=version+1,updated_at=? WHERE id=? AND branch_id=? AND version=? AND status='pending' AND ((last_operation='issue' AND issue_tracking_code IS NOT NULL) OR (COALESCE(last_operation,'create')<>'issue' AND create_tracking_code IS NOT NULL))",
					now,
					invoice.id,
					input.branchId,
					input.expectedVersion,
				);
			} else if (action === "issue-invoice") {
				update = this.stmt(
					"UPDATE rc_invoices SET status='queued',issue_payload_json=?,last_operation='issue',dispatch_at=NULL,dispatch_token=NULL,version=version+1,updated_at=? WHERE id=? AND branch_id=? AND version=? AND status='draft' AND (create_tracking_code IS NOT NULL OR (json_extract(provider_json,'$.status')='draft' AND json_extract(provider_json,'$.reference_code')=reference)) AND issue_tracking_code IS NULL",
					JSON.stringify({ reference_code: invoice.reference }),
					now,
					invoice.id,
					input.branchId,
					input.expectedVersion,
				);
			} else {
				update = this.stmt(
					"UPDATE rc_invoices SET version=version+1,updated_at=? WHERE id=? AND branch_id=? AND version=? AND status IN ('outcome_unknown','failed','issued','draft')",
					now,
					invoice.id,
					input.branchId,
					input.expectedVersion,
				);
			}
			return {
				statements: [
					...this.assertion(
						"NOT EXISTS(SELECT 1 FROM rc_outbox WHERE json_extract(payload_json,'$.invoiceId')=? AND state IN ('pending','running'))",
						invoice.id,
					),
					...this.fenced(update),
					this.outbox(jobId, kind, invoice.id),
				],
				result: {
					id: invoice.id,
					version: input.expectedVersion + 1,
					jobId,
				} satisfies CommandResult,
				branchId: input.branchId,
				entityId: invoice.id,
			};
		});
	}

	private async exportRows(input: ActionInputs["export"]): Promise<ExportResult> {
		await this.access(input.branchId, ["manager", "accountant"]);
		const from = Date.parse(`${input.from}T00:00:00+07:00`);
		const to = Date.parse(`${input.to}T00:00:00+07:00`) + 86400000;
		const limit = input.limit ?? 50;
		const cursor = input.cursor ?? "";
		const queries: Record<ActionInputs["export"]["kind"], string> = {
			sales:
				"SELECT l.id,o.branch_id,o.visit_id,o.id AS order_id,o.status,l.menu_item_id,l.name,l.quantity,l.unit_price,l.tax_rate,l.tax_amount,l.total,o.reason,o.created_at FROM rc_order_lines l JOIN rc_orders o ON o.id=l.order_id WHERE o.branch_id=? AND o.created_at>=? AND o.created_at<? AND l.id>? AND o.status IN ('confirmed','voided') ORDER BY l.id LIMIT ?",
			payments:
				"SELECT p.id,p.branch_id,p.visit_id,p.reference,p.amount,p.bank_account,p.status,a.inbox_id,x.provider_transaction_id,p.created_at,p.paid_at FROM rc_payment_attempts p LEFT JOIN rc_payment_allocations a ON a.payment_id=p.id LEFT JOIN rc_payment_inbox x ON x.id=a.inbox_id WHERE p.branch_id=? AND p.created_at>=? AND p.created_at<? AND p.id>? ORDER BY p.id LIMIT ?",
			invoices:
				"SELECT id,branch_id,visit_id,payment_id,kind,original_invoice_id,reference,status,create_tracking_code,issue_tracking_code,tax_authority_status,last_error,payload_json,created_at FROM rc_invoices WHERE branch_id=? AND created_at>=? AND created_at<? AND id>? ORDER BY id LIMIT ?",
			audit:
				"SELECT id,branch_id,actor_id,action,entity_id,detail_json,created_at FROM rc_audit WHERE branch_id=? AND created_at>=? AND created_at<? AND id>? ORDER BY id LIMIT ?",
		};
		const rows = await this.rows<Record<string, string | number | null>>(
			queries[input.kind],
			input.branchId,
			from,
			to,
			cursor,
			limit + 1,
		);
		const headers: Record<ActionInputs["export"]["kind"], string[]> = {
			sales: [
				"id",
				"branch_id",
				"visit_id",
				"order_id",
				"status",
				"menu_item_id",
				"name",
				"quantity",
				"unit_price",
				"tax_rate",
				"tax_amount",
				"total",
				"reason",
				"created_at",
			],
			payments: [
				"id",
				"branch_id",
				"visit_id",
				"reference",
				"amount",
				"bank_account",
				"status",
				"inbox_id",
				"provider_transaction_id",
				"created_at",
				"paid_at",
			],
			invoices: [
				"id",
				"branch_id",
				"visit_id",
				"payment_id",
				"kind",
				"original_invoice_id",
				"reference",
				"status",
				"create_tracking_code",
				"issue_tracking_code",
				"tax_authority_status",
				"last_error",
				"payload_json",
				"created_at",
			],
			audit: ["id", "branch_id", "actor_id", "action", "entity_id", "detail_json", "created_at"],
		};
		const keys = headers[input.kind];
		const csv = [
			keys.concat("business_date").map(csvCell).join(","),
			...rows
				.slice(0, limit)
				.map((row) =>
					[
						...keys.map((key) => csvCell(row[key])),
						csvCell(
							new Date(Number(row.created_at) + 7 * 60 * 60 * 1000).toISOString().slice(0, 10),
						),
					].join(","),
				),
		].join("\r\n");
		return {
			filename: `${input.kind}-${input.branchId}-${input.from}-${input.to}.csv`,
			contentType: "text/csv; charset=utf-8",
			csv,
			nextCursor: rows.length > limit ? String(rows[limit - 1]!.id) : null,
		};
	}
}
