import type { Workspace } from "../domain/types.js";

function mergeRecords<T extends { id: string }>(current: T[], next: T[]): T[] {
	const records = new Map(current.map((record) => [record.id, record]));
	for (const record of next) records.set(record.id, record);
	return [...records.values()];
}

/** Shared resource cursors can repeat rows; retain each row once with its latest snapshot. */
export function mergeWorkspacePage(current: Workspace, next: Workspace): Workspace {
	if (current.branch.id !== next.branch.id) throw new Error("Cannot combine different branches");
	const members = new Map(current.members.map((member) => [member.userId, member]));
	for (const member of next.members) members.set(member.userId, member);
	return {
		...next,
		members: [...members.values()],
		tables: mergeRecords(current.tables, next.tables),
		visits: mergeRecords(current.visits, next.visits),
		menu: mergeRecords(current.menu, next.menu),
		orders: mergeRecords(current.orders, next.orders),
		payments: mergeRecords(current.payments, next.payments),
		invoices: mergeRecords(current.invoices, next.invoices),
		jobs: mergeRecords(current.jobs, next.jobs),
		bills: mergeRecords(current.bills, next.bills),
		serviceRequests: mergeRecords(current.serviceRequests, next.serviceRequests),
		exceptions: mergeRecords(current.exceptions, next.exceptions),
	};
}
