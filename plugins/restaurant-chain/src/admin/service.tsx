import { toDataURL } from "qrcode";
import { useEffect, useMemo, useState } from "react";
import type { MenuItem, Order, Table, Workspace } from "../domain/types.js";
import { IconMenu, IconQr } from "./brand.js";
import { money, safeImage } from "./client.js";
import { statusKey, useText } from "./locale.js";
import { Action, Section, Status } from "./shared.js";

const kitchenFlow = ["queued", "preparing", "ready", "served"] as const;

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

function TableTile({
	table,
	state,
	selected,
	onSelect,
}: {
	table: Table;
	state: string;
	selected: boolean;
	onSelect: () => void;
}) {
	const { t } = useText();
	return (
		<button
			type="button"
			className="rc-tile"
			data-state={state}
			aria-pressed={selected}
			onClick={onSelect}
		>
			<span className="rc-tile-dot" aria-hidden="true" />
			<strong>{table.name}</strong>
			{state !== "closed" && <small>{t(statusKey(state))}</small>}
		</button>
	);
}

function MenuPanel({ data, table }: { data: Workspace; table?: Table }) {
	const { t, locale } = useText();
	const [category, setCategory] = useState("");
	const [qr, setQr] = useState("");
	const categories = [...new Set(data.menu.map((item) => item.category))];
	const visible = category ? data.menu.filter((item) => item.category === category) : data.menu;
	const orderUrl = table
		? new URL(`/order/${encodeURIComponent(table.token)}`, window.location.origin).href
		: "";
	useEffect(() => {
		if (!orderUrl) {
			setQr("");
			return;
		}
		let active = true;
		toDataURL(orderUrl, { width: 220, margin: 2, errorCorrectionLevel: "M" }).then(
			(value) => {
				if (active) setQr(value);
			},
			() => {
				if (active) setQr("");
			},
		);
		return () => {
			active = false;
		};
	}, [orderUrl]);
	return (
		<section className="rc-panel rc-menu-panel rc-menu-rail">
			<header>
				<h3>{t("menuConfig")}</h3>
			</header>
			<div className="rc-menu-tabs" role="group" aria-label={t("category")}>
				<button
					type="button"
					className="rc-chip"
					aria-pressed={!category}
					onClick={() => setCategory("")}
				>
					{t("all")}
				</button>
				{categories.map((name) => (
					<button
						type="button"
						key={name}
						className="rc-chip"
						aria-pressed={category === name}
						onClick={() => setCategory(name)}
					>
						{name}
					</button>
				))}
			</div>
			{visible.length === 0 && <p className="rc-empty">{t("empty")}</p>}
			<div className="rc-menu-grid">
				{visible.slice(0, 12).map((item: MenuItem) => {
					const image = safeImage(item.image);
					return (
						<article className="rc-menu-card" key={item.id}>
							{image ? (
								<img src={image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
							) : (
								<span className="rc-menu-thumb" aria-hidden="true">
									<IconQr />
								</span>
							)}
							<div className="rc-menu-card-body">
								<strong>{item.name}</strong>
								<span>{money(item.price, locale)}</span>
							</div>
						</article>
					);
				})}
			</div>
			{table && (
				<article className="rc-guest-card">
					<div>
						<h4>{t("guestOrdering")}</h4>
						<small>{t("scanOrder")}</small>
					</div>
					{qr && <img src={qr} alt={`${t("tableQr")} ${table.name}`} width={84} height={84} />}
				</article>
			)}
		</section>
	);
}

function TableDetail({
	data,
	table,
	visitId,
	onDone,
}: {
	data: Workspace;
	table: Table;
	visitId?: string;
	onDone: () => void;
}) {
	const { t, locale } = useText();
	const orders = useMemo(
		() =>
			data.orders
				.filter((order) => order.visitId === visitId)
				.sort((a, b) => a.createdAt - b.createdAt),
		[data.orders, visitId],
	);
	const lines = orders.flatMap((order) =>
		order.lines.map((line) => ({ order, line })),
	);
	const total = orders.reduce((sum, order) => sum + order.total, 0);
	const visit = data.visits.find((candidate) => candidate.id === visitId);
	const openBill = data.bills.find((bill) => bill.visitId === visitId && bill.status === "open");
	const canBill = ["manager", "administrator", "cashier"].includes(data.role);
	const confirmedUnbilled = orders.some(
		(order) => order.status === "confirmed" && !order.billId,
	);
	const canFreeze =
		canBill &&
		!!visit &&
		!openBill &&
		confirmedUnbilled &&
		visit.pendingCount === 0 &&
		visit.unsettledCount === 0;
	const reached = (status: (typeof kitchenFlow)[number]) =>
		lines.length > 0 &&
		lines.every(
			(entry) => kitchenFlow.indexOf(entry.line.kitchenStatus) >= kitchenFlow.indexOf(status),
		);
	return (
		<Section title={`${t("table")} · ${table.name}`}>
			<div className="rc-table-detail">
				<div className="rc-panel">
					<header>
						<h3>{t("bill")}</h3>
						{visitId && <Status value={data.visits.find((v) => v.id === visitId)?.status ?? ""} />}
					</header>
					<div className="rc-stepper" aria-hidden="true">
						{kitchenFlow.map((state) => (
							<span key={state} data-done={reached(state) ? "" : undefined}>
								{t(state)}
							</span>
						))}
					</div>
					{lines.length === 0 && <p className="rc-empty">{t("empty")}</p>}
					<ul className="rc-detail-lines">
						{lines.map(({ order, line }) => {
							const item = data.menu.find((entry) => entry.id === line.menuItemId);
							const image = safeImage(item?.image);
							const next =
								line.kitchenStatus === "queued"
									? "preparing"
									: line.kitchenStatus === "preparing"
										? "ready"
										: line.kitchenStatus === "ready"
											? "served"
											: undefined;
							return (
								<li key={line.id}>
									{image ? (
										<img src={image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
									) : (
										<span className="rc-menu-thumb" aria-hidden="true">
											<IconMenu />
										</span>
									)}
									<div className="rc-line-main">
										<strong>{line.name}</strong>
										{line.modifiers.length > 0 && (
											<small>{line.modifiers.map((modifier) => modifier.name).join(", ")}</small>
										)}
										<Status value={line.kitchenStatus} />
									</div>
									<span className="rc-qty">×{line.quantity}</span>
									<span>{money(line.total, locale)}</span>
									{next &&
										(["manager", "administrator"].includes(data.role) ||
											(line.kitchenStatus === "ready"
												? ["floor", "cashier"].includes(data.role)
												: data.role === "kitchen")) && (
											<Action
												action="kitchen-transition"
												label={
													line.kitchenStatus === "queued"
														? "prepare"
														: line.kitchenStatus === "preparing"
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
									{order.note && <small className="rc-note">{order.note}</small>}
								</li>
							);
						})}
					</ul>
					<div className="rc-total">
						<strong>{t("total")}</strong>
						<strong>{money(total, locale)}</strong>
					</div>
				</div>
				<div className="rc-panel">
					<header>
						<h3>{t("visit")}</h3>
					</header>
					{visitId ? (
						<Action
							action="close-visit"
							label="closeVisit"
							input={{
								branchId: data.branch.id,
								id: visitId,
								expectedVersion: data.visits.find((v) => v.id === visitId)?.version,
							}}
							onDone={onDone}
						/>
					) : (
						<Action
							action="open-visit"
							label="openVisit"
							disabled={!!data.nextCursor}
							input={{ branchId: data.branch.id, tableId: table.id, expectedVersion: table.version }}
							onDone={onDone}
						/>
					)}
					{visitId && canBill && openBill && (
						<p className="rc-warning">
							{t("openBills")}: {money(openBill.total, locale)}
						</p>
					)}
					{visitId && canBill && !openBill && (
						<>
							<Action
								action="freeze-bill"
								label="freezeBill"
								disabled={!canFreeze}
								input={{
									branchId: data.branch.id,
									id: visitId,
									expectedVersion: visit?.version,
								}}
								onDone={onDone}
							/>
							<p className="rc-muted">{t("freezeHint")}</p>
						</>
					)}
					<p className="rc-muted">{t("paymentWarning")}</p>
				</div>
			</div>
		</Section>
	);
}

export function Floor({
	data,
	onDone,
	view,
}: {
	data: Workspace;
	onDone: () => void;
	view: "floor" | "list";
}) {
	const { t } = useText();
	const branchId = data.branch.id;
	const openVisits = data.visits.filter((visit) => visit.status !== "closed");
	const [selectedId, setSelectedId] = useState(
		() => openVisits[0]?.tableId ?? data.tables[0]?.id ?? "",
	);
	const selectedTable = data.tables.find((table) => table.id === selectedId);
	const selectedVisit = openVisits.find((visit) => visit.tableId === selectedId);
	const orders = useMemo(
		() =>
			[...data.orders].sort(
				(a, b) =>
					Number(b.status === "pending") - Number(a.status === "pending") ||
					b.createdAt - a.createdAt,
			),
		[data.orders],
	);
	function stateFor(tableId: string) {
		const visit = openVisits.find((candidate) => candidate.tableId === tableId);
		return visit ? visit.status : "closed";
	}
	return (
		<>
			<div className="rc-ops">
				<section className="rc-panel">
					<header>
						<h3>{t("tables")}</h3>
						<small className="rc-muted">{data.branch.name}</small>
					</header>
					{data.tables.length === 0 && <p className="rc-empty">{t("empty")}</p>}
					{view === "floor" ? (
						<div className="rc-floor">
							{data.tables.map((table) => (
								<TableTile
									key={table.id}
									table={table}
									state={stateFor(table.id)}
									selected={table.id === selectedId}
									onSelect={() => setSelectedId(table.id)}
								/>
							))}
						</div>
					) : (
						<div className="rc-table-grid">
							{data.tables.map((table) => {
								const visit = openVisits.find((candidate) => candidate.tableId === table.id);
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
					)}
					<div className="rc-legend">
						<span>
							<i data-state="closed" /> {t("active")}
						</span>
						<span>
							<i data-state="open" /> {t("open")}
						</span>
						<span>
							<i data-state="billing" /> {t("billing")}
						</span>
					</div>
				</section>
				<section className="rc-panel">
					<header>
						<h3>{t("requests")}</h3>
						{orders.filter((order) => order.status === "pending").length > 0 && (
							<span className="rc-status" data-status="pending">
								{orders.filter((order) => order.status === "pending").length}
							</span>
						)}
					</header>
					{orders.length === 0 && <p className="rc-empty">{t("empty")}</p>}
					<div className="rc-rail">
						{orders.map((order) => {
							const visit = data.visits.find((candidate) => candidate.id === order.visitId);
							const table = data.tables.find((candidate) => candidate.id === visit?.tableId);
							const input = { branchId, id: order.id, expectedVersion: order.version };
							return (
								<article className="rc-order-card" key={order.id} data-status={order.status}>
									<header>
										<span className="rc-order-table">
											<span className="rc-tile-dot" aria-hidden="true" />
											{table?.name ?? order.visitId}
										</span>
										<span className="rc-order-time">
											{new Intl.DateTimeFormat(undefined, {
												hour: "2-digit",
												minute: "2-digit",
											}).format(new Date(order.createdAt))}
										</span>
									</header>
									<ul className="rc-order-lines">
										{order.lines.slice(0, 4).map((line) => (
											<li key={line.id}>
												<span>
													{line.quantity} × {line.name}
												</span>
												<span>{money(line.total)}</span>
											</li>
										))}
									</ul>
									<Status value={order.status} />
									{order.status === "pending" && (
										<div className="rc-toolbar">
											<Action action="confirm-order" label="confirm" input={input} onDone={onDone} />
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
				</section>
				<MenuPanel data={data} table={selectedTable} />
			</div>
			{selectedTable && (
				<TableDetail
					data={data}
					table={selectedTable}
					visitId={selectedVisit?.id}
					onDone={onDone}
				/>
			)}
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
