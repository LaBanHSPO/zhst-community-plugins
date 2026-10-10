import type { Order, Workspace } from "../domain/types.js";
import { money } from "./client.js";
import { useText } from "./locale.js";
import { Action, Section, Status } from "./shared.js";

export function OrderDetails({ order }: { order: Order }) {
	const { t, locale } = useText();
	return (
		<div className="rc-order-details">
			<ul>
				{order.lines.map((line) => (
					<li key={line.id}>
						<div>
							<strong>
								{line.quantity} × {line.name}
							</strong>
							{line.modifiers.length > 0 && (
								<small>{line.modifiers.map((modifier) => modifier.name).join(", ")}</small>
							)}
						</div>
						<span>{money(line.total, locale)}</span>
						<Status value={line.kitchenStatus} />
					</li>
				))}
			</ul>
			{order.note && (
				<p>
					<strong>{t("note")}: </strong>
					{order.note}
				</p>
			)}
			{order.reason && (
				<p>
					<strong>{t("reason")}: </strong>
					{order.reason}
				</p>
			)}
		</div>
	);
}

export function Floor({ data, onDone }: { data: Workspace; onDone: () => void }) {
	const { t } = useText();
	const branchId = data.branch.id;
	return (
		<>
			<Section title={t("tables")}>
				<div className="rc-table-grid">
					{data.tables.length === 0 && <p>{t("empty")}</p>}
					{data.tables.map((table) => {
						const visit = data.visits.find(
							(candidate) => candidate.tableId === table.id && candidate.status !== "closed",
						);
						return (
							<article className="rc-table" key={table.id}>
								<header>
									<h3>{table.name}</h3>
									{visit && <Status value={visit.status} />}
								</header>
								{visit ? (
									<>
										<small className="rc-id">{visit.id}</small>
										<p>
											{t("pending")}: {visit.pendingCount}
										</p>
										<Action
											action="close-visit"
											label="closeVisit"
											input={{ branchId, id: visit.id, expectedVersion: visit.version }}
											onDone={onDone}
										/>
									</>
								) : (
									<Action
										action="open-visit"
										label="openVisit"
										disabled={!!data.nextCursor}
										input={{ branchId, tableId: table.id, expectedVersion: table.version }}
										onDone={onDone}
									/>
								)}
							</article>
						);
					})}
				</div>
			</Section>
			<Section title={t("requests")}>
				<div className="rc-orders">
					{data.orders.length === 0 && <p>{t("empty")}</p>}
					{[...data.orders]
						.sort(
							(a, b) =>
								Number(b.status === "pending") - Number(a.status === "pending") ||
								b.createdAt - a.createdAt,
						)
						.map((order) => {
							const visit = data.visits.find((candidate) => candidate.id === order.visitId);
							const table = data.tables.find((candidate) => candidate.id === visit?.tableId);
							const input = { branchId, id: order.id, expectedVersion: order.version };
							return (
								<article className="rc-order" key={order.id}>
									<header>
										<h3>{table?.name ?? order.visitId}</h3>
										<Status value={order.status} />
									</header>
									<small className="rc-id">{order.id}</small>
									<OrderDetails order={order} />
									{order.status === "pending" && (
										<div className="rc-toolbar">
											<Action
												action="confirm-order"
												label="confirm"
												input={input}
												onDone={onDone}
											/>
											<Action
												action="reject-order"
												label="reject"
												input={input}
												onDone={onDone}
												reason
											/>
										</div>
									)}
									{order.status === "confirmed" &&
										["manager", "administrator", "cashier"].includes(data.role) && (
											<Action
												action="void-order"
												label="void"
												input={input}
												onDone={onDone}
												reason
											/>
										)}
								</article>
							);
						})}
				</div>
			</Section>
		</>
	);
}

export function Kitchen({ data, onDone }: { data: Workspace; onDone: () => void }) {
	const { t } = useText();
	const states = ["queued", "preparing", "ready"] as const;
	return (
		<Section title={t("kitchen")}>
			<div className="rc-kitchen">
				{states.map((state) => (
					<section className="rc-lane" key={state}>
						<h3>{t(state)}</h3>
						{data.orders
							.filter((order) => order.status === "confirmed")
							.flatMap((order) =>
								order.lines
									.filter((line) => line.kitchenStatus === state)
									.map((line) => {
										const visit = data.visits.find((candidate) => candidate.id === order.visitId);
										const table = data.tables.find((candidate) => candidate.id === visit?.tableId);
										const next =
											state === "queued" ? "preparing" : state === "preparing" ? "ready" : "served";
										return (
											<article className="rc-ticket" key={line.id}>
												<p className="rc-muted">{table?.name ?? order.visitId}</p>
												<h4>
													{line.quantity} × {line.name}
												</h4>
												{line.modifiers.length > 0 && (
													<p>{line.modifiers.map((modifier) => modifier.name).join(", ")}</p>
												)}
												{order.note && <p className="rc-note">{order.note}</p>}
												{(["manager", "administrator"].includes(data.role) ||
													(state === "ready"
														? ["floor", "cashier"].includes(data.role)
														: data.role === "kitchen")) && (
													<Action
														action="kitchen-transition"
														label={
															state === "queued"
																? "prepare"
																: state === "preparing"
																	? "markReady"
																	: "markServed"
														}
														input={{
															branchId: data.branch.id,
															id: line.id,
															expectedVersion: line.version,
															status: next,
														}}
														onDone={onDone}
													/>
												)}
											</article>
										);
									}),
							)}
					</section>
				))}
			</div>
		</Section>
	);
}
