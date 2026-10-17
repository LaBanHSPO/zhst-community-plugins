import { Button, Input } from "@cloudflare/kumo";
import { useState } from "react";
import type { Buyer, Invoice, OrderLine, Workspace } from "../domain/types.js";
import { money, RestaurantRequestError, safeImage } from "./client.js";
import { useText } from "./locale.js";
import type { TextKey } from "./locale.js";
import { Action, Choice, Failure, Section, Status, useCommand, useUnsaved } from "./shared.js";
import { OrderDetails } from "./service.js";
import { Bills } from "./shift.js";

function InvoiceForm({
	branchId,
	paymentId,
	invoice,
	lines,
	onDone,
}: {
	branchId: string;
	paymentId?: string;
	invoice?: Invoice;
	lines: OrderLine[];
	onDone: () => void;
}) {
	const { t } = useText();
	const [buyer, setBuyer] = useState<Buyer>({ name: "", taxCode: "", address: "", email: "" });
	const [kind, setKind] = useState("replacement");
	const [reason, setReason] = useState("");
	const [dirty, setDirty] = useState(false);
	const [correctedLines, setCorrectedLines] = useState(() =>
		lines.map((line) => ({
			name: line.name,
			quantity: line.quantity,
			unitPrice: line.unitPrice,
			taxRate: line.taxRate,
		})),
	);
	const mutation = useCommand(() => {
		setDirty(false);
		onDone();
	});
	useUnsaved(dirty || mutation.pending);
	const fields: { key: keyof Buyer; label: TextKey }[] = [
		{ key: "name", label: "buyerName" },
		{ key: "taxCode", label: "taxCode" },
		{ key: "address", label: "address" },
		{ key: "email", label: "email" },
	];
	return (
		<form
			className="rc-form"
			onChange={() => setDirty(true)}
			onSubmit={(event) => {
				event.preventDefault();
				void mutation.run(
					invoice ? "correct-invoice" : "request-invoice",
					invoice
						? {
								branchId,
								id: invoice.id,
								expectedVersion: invoice.version,
								buyer,
								kind,
								reason,
								lines: correctedLines,
							}
						: { branchId, paymentId, buyer },
				);
			}}
		>
			<h4>{t(invoice ? "correction" : "buyer")}</h4>
			<div className="rc-form-grid">
				{fields.map((field) => (
					<Input
						key={field.key}
						label={t(field.label)}
						type={field.key === "email" ? "email" : "text"}
						required={field.key === "name"}
						maxLength={500}
						value={buyer[field.key]}
						onChange={(event) => setBuyer({ ...buyer, [field.key]: event.target.value })}
					/>
				))}
			</div>
			{invoice && (
				<p className="rc-warning">
					{t(kind === "adjustment" ? "adjustmentHint" : "replacementHint")}
				</p>
			)}
			{invoice && (
				<>
					<Choice
						label={t("correction")}
						value={kind}
						options={[
							{ value: "adjustment", label: t("adjustment") },
							{ value: "replacement", label: t("replacement") },
						]}
						onChange={(value) => {
							setDirty(true);
							setKind(value);
							setCorrectedLines(
								value === "replacement"
									? lines.map((line) => ({
											name: line.name,
											quantity: line.quantity,
											unitPrice: line.unitPrice,
											taxRate: line.taxRate,
										}))
									: [],
							);
						}}
					/>
					<Input
						label={t("reason")}
						value={reason}
						onChange={(event) => setReason(event.target.value)}
						required
						maxLength={1000}
					/>
					<fieldset>
						<legend>{t("items")}</legend>
						{correctedLines.map((line, index) => (
							<div className="rc-correction-line" key={index}>
								<Input
									label={t("name")}
									value={line.name}
									required
									onChange={(event) =>
										setCorrectedLines(
											correctedLines.map((entry, offset) =>
												offset === index ? { ...entry, name: event.target.value } : entry,
											),
										)
									}
								/>
								<Input
									label={t("quantity")}
									type="number"
									min={1}
									step={1}
									required
									value={line.quantity}
									onChange={(event) =>
										setCorrectedLines(
											correctedLines.map((entry, offset) =>
												offset === index
													? { ...entry, quantity: Number(event.target.value) }
													: entry,
											),
										)
									}
								/>
								<Input
									label={t("price")}
									type="number"
									step={1}
									required
									value={line.unitPrice}
									onChange={(event) =>
										setCorrectedLines(
											correctedLines.map((entry, offset) =>
												offset === index
													? { ...entry, unitPrice: Number(event.target.value) }
													: entry,
											),
										)
									}
								/>
								<Choice
									label={t("taxRate")}
									value={String(line.taxRate)}
									options={[0, 500, 800, 1000].map((rate) => ({
										value: String(rate),
										label: `${rate / 100}%`,
									}))}
									onChange={(value) => {
										setDirty(true);
										setCorrectedLines(
											correctedLines.map((entry, offset) =>
												offset === index ? { ...entry, taxRate: Number(value) } : entry,
											),
										);
									}}
								/>
								<Button
									type="button"
									onClick={() => {
										setDirty(true);
										setCorrectedLines(correctedLines.filter((_, offset) => offset !== index));
									}}
								>
									{t("remove")}
								</Button>
							</div>
						))}
						<Button
							type="button"
							onClick={() => {
								setDirty(true);
								setCorrectedLines([
									...correctedLines,
									{ name: "", quantity: 1, unitPrice: 0, taxRate: 0 },
								]);
							}}
						>
							{t("add")}
						</Button>
					</fieldset>
					<p className="rc-muted">{t("taxHint")}</p>
				</>
			)}
			<Failure error={mutation.error} />
			<Button
				type="submit"
				variant="primary"
				disabled={mutation.pending || (!!invoice && correctedLines.length === 0)}
			>
				{t(mutation.pending ? "saving" : invoice ? "correction" : "createInvoice")}
			</Button>
			{mutation.saved && <p role="status">{t("saved")}</p>}
		</form>
	);
}

function InvoicePanel({
	invoice,
	data,
	onDone,
}: {
	invoice: Invoice;
	data: Workspace;
	onDone: () => void;
}) {
	const { t } = useText();
	const [correcting, setCorrecting] = useState(false);
	const input = { branchId: data.branch.id, id: invoice.id, expectedVersion: invoice.version };
	const lines = data.orders
		.filter((order) => order.visitId === invoice.visitId && order.status === "confirmed")
		.flatMap((order) => order.lines);
	return (
		<article className="rc-invoice">
			<header>
				<strong>{invoice.reference}</strong>
				<Status
					value={invoice.status}
					label={
						invoice.status === "queued"
							? "create_pending"
							: invoice.status === "pending"
								? "processing"
								: undefined
					}
				/>
			</header>
			<dl className="rc-details">
				<div>
					<dt>{t("tracking")}</dt>
					<dd>
						{invoice.createTrackingCode ?? "—"} / {invoice.issueTrackingCode ?? "—"}
					</dd>
				</div>
				<div>
					<dt>{t("taxStatus")}</dt>
					<dd>{invoice.taxAuthorityStatus ?? "—"}</dd>
				</div>
			</dl>
			{invoice.lastError && <p className="rc-error">{invoice.lastError}</p>}
			{invoice.status === "outcome_unknown" && (
				<p role="status" className="rc-warning">
					{t("unknownWarning")}
				</p>
			)}
			<div className="rc-toolbar">
				{invoice.status === "draft" && (
					<Action action="issue-invoice" label="issueInvoice" input={input} onDone={onDone} />
				)}
				{(["outcome_unknown", "failed", "issued", "draft"].includes(invoice.status) ||
					(["queued", "pending"].includes(invoice.status) &&
						data.jobs.some((job) => job.invoiceId === invoice.id && job.state === "review"))) && (
					<Action action="reconcile-invoice" label="reconcile" input={input} onDone={onDone} />
				)}
				{invoice.status === "issued" && (
					<>
						<Button disabled={!!data.nextCursor} onClick={() => setCorrecting(!correcting)}>
							{t(correcting ? "cancel" : "correction")}
						</Button>
						{(["pdf", "xml"] as const).map((type) => (
							<a
								key={type}
								className="rc-link"
								href={`/api/restaurant/invoice-file?${new URLSearchParams({ branchId: data.branch.id, id: invoice.id, type })}`}
								target="_blank"
								rel="noreferrer"
							>
								{t(type === "pdf" ? "downloadPdf" : "downloadXml")}
							</a>
						))}
					</>
				)}
			</div>
			{correcting && (
				<InvoiceForm
					branchId={data.branch.id}
					invoice={invoice}
					lines={lines}
					onDone={() => {
						setCorrecting(false);
						onDone();
					}}
				/>
			)}
		</article>
	);
}

export function Finance({ data, onDone }: { data: Workspace; onDone: () => void }) {
	const { t, locale } = useText();
	const [selectedVisit, setSelectedVisit] = useState("");
	const visit =
		data.visits.find((entry) => entry.id === selectedVisit) ??
		data.visits.find((entry) => entry.status !== "closed") ??
		data.visits[0];
	const orders = data.orders.filter((order) => order.visitId === visit?.id);
	const payments = data.payments.filter((payment) => payment.visitId === visit?.id);
	const lines = orders
		.filter((order) => order.status === "confirmed")
		.flatMap((order) => order.lines);
	const total = visit?.total ?? 0;
	const canCashier = ["manager", "administrator", "cashier"].includes(data.role);
	return (
		<>
			<Bills data={data} onDone={onDone} />
			<Section title={t("payments")}>
				<Choice
					label={t("selectVisit")}
					value={visit?.id ?? ""}
					options={data.visits.map((entry) => ({
						value: entry.id,
						label: `${data.tables.find((table) => table.id === entry.tableId)?.name ?? entry.tableId} · ${entry.id.slice(-8)}`,
					}))}
					onChange={setSelectedVisit}
				/>
				{data.nextCursor && <p className="rc-warning">{t("partialData")}</p>}
				{!visit && <p>{t("empty")}</p>}
				{visit && (
					<div className="rc-finance-grid">
						<div>
							<div className="rc-section-heading">
								<h3>{t("bill")}</h3>
								<Status value={visit.status} />
							</div>
							<p>
								{t("pending")}: {visit.pendingCount} · {t("unsettled")}: {visit.unsettledCount}
							</p>
							{orders.map((order) => (
								<article className="rc-bill-order" key={order.id}>
									<Status value={order.status} />
									<OrderDetails order={order} />
								</article>
							))}
							<div className="rc-total">
								<strong>{t("total")}</strong>
								<strong>{money(total, locale)}</strong>
							</div>
							{canCashier && visit.status !== "closed" && visit.status !== "paid" && (
								<>
									<p className="rc-warning">{t("paymentWarning")}</p>
									<Action
										action="create-payment"
										label="createPayment"
										disabled={visit.pendingCount > 0 || visit.unsettledCount > 0}
										input={{
											branchId: data.branch.id,
											id: visit.id,
											expectedVersion: visit.version,
										}}
										onDone={onDone}
									/>
								</>
							)}
						</div>
						<div>
							{payments.map((payment) => {
								const receivingAccount =
									payment.qrMode === "virtual" ? payment.subAccount : payment.bankAccount;
								const transferContent = [
									payment.transferPrefix,
									payment.qrMode === "memo" ? `TKP${payment.subAccount}` : "",
									payment.reference,
								]
									.filter(Boolean)
									.join(" ");
								return (
									<article className="rc-payment" key={payment.id}>
										<header>
											<h3>{money(payment.amount, locale)}</h3>
											<Status
												value={payment.status}
												label={payment.status === "pending" ? "unpaid" : undefined}
											/>
										</header>
										{payment.status === "pending" && safeImage(payment.qrUrl) && (
											<img
												className="rc-qr"
												src={safeImage(payment.qrUrl)}
												alt={t("qr")}
												width={240}
												height={240}
												referrerPolicy="no-referrer"
											/>
										)}
										<dl className="rc-details">
											<div>
												<dt>{t("bank")}</dt>
												<dd>{payment.bankCode}</dd>
											</div>
											<div>
												<dt>{t("account")}</dt>
												<dd dir="ltr">{receivingAccount}</dd>
											</div>
											<div>
												<dt>{t("bankName")}</dt>
												<dd>{payment.bankName}</dd>
											</div>
											<div>
												<dt>{t("paymentReference")}</dt>
												<dd>
													<code>{transferContent}</code>
												</dd>
											</div>
										</dl>
										{payment.status === "paid" &&
											!data.nextCursor &&
											!data.invoices.some((invoice) => invoice.paymentId === payment.id) && (
												<InvoiceForm
													branchId={data.branch.id}
													paymentId={payment.id}
													lines={lines}
													onDone={onDone}
												/>
											)}
									</article>
								);
							})}
						</div>
					</div>
				)}
			</Section>
			<Section title={t("invoices")}>
				{data.invoices
					.filter((invoice) => !visit || invoice.visitId === visit.id)
					.map((invoice) => (
						<InvoicePanel key={invoice.id} invoice={invoice} data={data} onDone={onDone} />
					))}
			</Section>
			{data.exceptions.length > 0 && (
				<Section title={t("exceptions")}>
					{data.exceptions.map((exception) => (
						<article className="rc-list-row" key={exception.id}>
							<code>{exception.providerTransactionId}</code>
							<span>{exception.exception}</span>
						</article>
					))}
				</Section>
			)}
			{data.jobs.length > 0 && (
				<Section title={t("jobs")}>
					{data.jobs.map((job) => (
						<article className="rc-list-row" key={job.id}>
							<div>
								<code>{job.id}</code>
								<p>
									{job.kind} · {job.state}
								</p>
								{job.lastError && <p>{job.lastError}</p>}
							</div>
							<span>{job.attempts}</span>
						</article>
					))}
				</Section>
			)}
		</>
	);
}

export function Exports({ branchId }: { branchId: string }) {
	const { t } = useText();
	const today = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Ho_Chi_Minh",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
	const [from, setFrom] = useState(today);
	const [to, setTo] = useState(today);
	const [kind, setKind] = useState("sales");
	const [cursor, setCursor] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<unknown>();
	const [downloaded, setDownloaded] = useState(false);
	async function download(next: boolean) {
		if (pending) return;
		setPending(true);
		setError(undefined);
		try {
			const query = new URLSearchParams({ branchId, kind, from, to, limit: "100" });
			if (next && cursor) query.set("cursor", cursor);
			const response = await fetch(`/api/restaurant/export?${query}`, {
				credentials: "same-origin",
			});
			if (!response.ok) {
				let code = "REQUEST_FAILED";
				try {
					const result: unknown = await response.json();
					if (
						typeof result === "object" &&
						result !== null &&
						"error" in result &&
						typeof result.error === "object" &&
						result.error !== null &&
						"code" in result.error &&
						typeof result.error.code === "string"
					)
						code = result.error.code;
				} catch {
					code = "INVALID_RESPONSE";
				}
				throw new RestaurantRequestError(code, "Export failed");
			}
			if (!response.headers.get("Content-Type")?.startsWith("text/csv"))
				throw new RestaurantRequestError("INVALID_RESPONSE", "Invalid export");
			const url = URL.createObjectURL(await response.blob());
			const link = document.createElement("a");
			link.href = url;
			link.download = `restaurant-${kind}-${from}-${to}${next ? "-next" : ""}.csv`;
			link.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 1000);
			setCursor(response.headers.get("X-Next-Cursor"));
			setDownloaded(true);
		} catch (cause) {
			setError(cause);
		} finally {
			setPending(false);
		}
	}
	return (
		<Section title={t("exports")} hint={t("exportHint")}>
			<form
				className="rc-form"
				onSubmit={(event) => {
					event.preventDefault();
					void download(false);
				}}
			>
				<div className="rc-form-grid">
					<Input
						label={t("fromDate")}
						type="date"
						value={from}
						required
						onChange={(event) => {
							setFrom(event.target.value);
							setCursor(null);
							setDownloaded(false);
						}}
					/>
					<Input
						label={t("toDate")}
						type="date"
						value={to}
						min={from}
						required
						onChange={(event) => {
							setTo(event.target.value);
							setCursor(null);
							setDownloaded(false);
						}}
					/>
					<Choice
						label={t("exportType")}
						value={kind}
						options={["sales", "payments", "invoices", "audit"].map((value) => ({
							value,
							label: t(value as TextKey),
						}))}
						onChange={(value) => {
							setKind(value);
							setCursor(null);
							setDownloaded(false);
						}}
					/>
				</div>
				<Failure error={error} />
				<div className="rc-toolbar">
					<Button type="submit" variant="primary" disabled={pending}>
						{t(pending ? "loading" : "download")}
					</Button>
					{cursor && (
						<Button
							type="button"
							disabled={pending}
							onClick={() => {
								void download(true);
							}}
						>
							{t("next")}
						</Button>
					)}
				</div>
				{downloaded && <p role="status">{t(cursor ? "loadMore" : "saved")}</p>}
			</form>
		</Section>
	);
}
