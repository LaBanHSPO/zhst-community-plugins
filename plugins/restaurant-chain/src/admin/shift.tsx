import { Button, Input } from "@cloudflare/kumo";
import { useState } from "react";
import type { Bill, Shift as ShiftRecord, Workspace } from "../domain/types.js";
import { money } from "./client.js";
import { useText } from "./locale.js";
import { Choice, Failure, Section, Status, useCommand } from "./shared.js";

function timestamp(value: number): string {
	return new Intl.DateTimeFormat(undefined, {
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(value));
}

function totals(bills: Bill[], shiftId: string) {
	const settled = bills.filter((bill) => bill.shiftId === shiftId && bill.status === "settled");
	const cash = settled
		.filter((bill) => bill.method === "cash")
		.reduce((sum, bill) => sum + bill.total, 0);
	const bank = settled
		.filter((bill) => bill.method === "bank_transfer")
		.reduce((sum, bill) => sum + bill.total, 0);
	return { count: settled.length, cash, bank, sales: cash + bank };
}

function OpenShiftForm({ branchId, onDone }: { branchId: string; onDone: () => void }) {
	const { t } = useText();
	const [openingFloat, setOpeningFloat] = useState("0");
	const mutation = useCommand(onDone);
	return (
		<form
			className="rc-form"
			onSubmit={(event) => {
				event.preventDefault();
				void mutation.run("open-shift", { branchId, openingFloat: Number(openingFloat) });
			}}
		>
			<div className="rc-form-grid">
				<Input
					label={t("openingFloat")}
					type="number"
					min={0}
					step={1000}
					required
					value={openingFloat}
					onChange={(event) => setOpeningFloat(event.target.value)}
				/>
			</div>
			<Failure error={mutation.error} />
			<Button type="submit" variant="primary" disabled={mutation.pending}>
				{t(mutation.pending ? "saving" : "openShift")}
			</Button>
		</form>
	);
}

function CloseShiftForm({
	shift,
	branchId,
	expectedCash,
	onDone,
}: {
	shift: ShiftRecord;
	branchId: string;
	expectedCash: number;
	onDone: () => void;
}) {
	const { t, locale } = useText();
	const [countedCash, setCountedCash] = useState("");
	const [note, setNote] = useState("");
	const mutation = useCommand(onDone);
	const counted = countedCash === "" ? undefined : Number(countedCash);
	const variance = counted === undefined ? undefined : counted - expectedCash;
	return (
		<form
			className="rc-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (counted === undefined) return;
				void mutation.run("close-shift", {
					branchId,
					id: shift.id,
					expectedVersion: shift.version,
					countedCash: counted,
					note,
				});
			}}
		>
			<dl className="rc-details">
				<div>
					<dt>{t("expectedCash")}</dt>
					<dd>{money(expectedCash, locale)}</dd>
				</div>
				{variance !== undefined && (
					<div>
						<dt>{t("variance")}</dt>
						<dd>{money(variance, locale)}</dd>
					</div>
				)}
			</dl>
			<div className="rc-form-grid">
				<Input
					label={t("countedCash")}
					type="number"
					min={0}
					step={1000}
					required
					value={countedCash}
					onChange={(event) => setCountedCash(event.target.value)}
				/>
				<Input label={t("note")} value={note} onChange={(event) => setNote(event.target.value)} />
			</div>
			<Failure error={mutation.error} />
			<Button type="submit" variant="primary" disabled={mutation.pending || counted === undefined}>
				{t(mutation.pending ? "saving" : "closeShift")}
			</Button>
		</form>
	);
}

export function Shift({ data, onDone }: { data: Workspace; onDone: () => void }) {
	const { t, locale } = useText();
	const canOperate = ["manager", "administrator", "cashier"].includes(data.role);
	const open = data.shift;
	const openBills = data.bills.filter((bill) => bill.status === "open");
	const summary = open ? totals(data.bills, open.id) : { count: 0, cash: 0, bank: 0, sales: 0 };
	return (
		<>
			<Section title={t("shift")}>
				<div className="rc-panel">
					{open ? (
						<>
							<header>
								<h3>{t("shift")}</h3>
								<Status value="open" label="open" />
							</header>
							<dl className="rc-details">
								<div>
									<dt>{t("openingFloat")}</dt>
									<dd>{money(open.openingFloat, locale)}</dd>
								</div>
								<div>
									<dt>{t("shiftOpenedAt")}</dt>
									<dd>{timestamp(open.openedAt)}</dd>
								</div>
								<div>
									<dt>{t("cash")}</dt>
									<dd>{money(summary.cash, locale)}</dd>
								</div>
								<div>
									<dt>{t("bankTransfer")}</dt>
									<dd>{money(summary.bank, locale)}</dd>
								</div>
								<div>
									<dt>{t("bills")}</dt>
									<dd>{summary.count}</dd>
								</div>
							</dl>
							{openBills.length > 0 && <p className="rc-warning">{t("openBillsHint")}</p>}
							{canOperate ? (
								<CloseShiftForm
									shift={open}
									branchId={data.branch.id}
									expectedCash={open.openingFloat + summary.cash}
									onDone={onDone}
								/>
							) : (
								<p className="rc-muted">{t("readOnlyHint")}</p>
							)}
						</>
					) : (
						<>
							<header>
								<h3>{t("shift")}</h3>
							</header>
							<p className="rc-muted">{t("noOpenShift")}</p>
							{canOperate ? (
								<OpenShiftForm branchId={data.branch.id} onDone={onDone} />
							) : (
								<p className="rc-muted">{t("readOnlyHint")}</p>
							)}
						</>
					)}
				</div>
			</Section>
			<Section title={t("shiftHistory")}>
				{data.shifts.filter((shift) => shift.status === "closed").length === 0 ? (
					<p className="rc-empty">{t("empty")}</p>
				) : (
					<div className="rc-panel rc-list">
						{data.shifts
							.filter((shift) => shift.status === "closed")
							.map((shift) => {
								const record = totals(data.bills, shift.id);
								return (
									<article className="rc-list-row" key={shift.id}>
										<div>
											<strong>
												{timestamp(shift.openedAt)} →{" "}
												{shift.closedAt ? timestamp(shift.closedAt) : "—"}
											</strong>
											<small className="rc-muted">
												{t("bills")}: {record.count} · {t("shiftSales")}:{" "}
												{money(record.sales, locale)}
											</small>
										</div>
										<div className="rc-shift-numbers">
											<span>
												{t("countedCash")}: {money(shift.countedCash ?? 0, locale)}
											</span>
											<span data-variance={shift.variance === 0 ? "zero" : "diff"}>
												{t("variance")}: {money(shift.variance ?? 0, locale)}
											</span>
										</div>
									</article>
								);
							})}
					</div>
				)}
			</Section>
		</>
	);
}

function SettleForm({ bill, branchId, onDone }: { bill: Bill; branchId: string; onDone: () => void }) {
	const { t } = useText();
	const [method, setMethod] = useState("cash");
	const [reference, setReference] = useState("");
	const [received, setReceived] = useState(false);
	const mutation = useCommand(onDone);
	return (
		<form
			className="rc-settle"
			onSubmit={(event) => {
				event.preventDefault();
				void mutation.run("settle-bill", {
					branchId,
					id: bill.id,
					expectedVersion: bill.version,
					method,
					reference: method === "bank_transfer" ? reference : "",
				});
			}}
		>
			<Choice
				label={t("method")}
				value={method}
				options={[
					{ value: "cash", label: t("cash") },
					{ value: "bank_transfer", label: t("bankTransfer") },
				]}
				onChange={setMethod}
			/>
			{method === "bank_transfer" && (
				<Input
					label={t("transferReference")}
					value={reference}
					maxLength={100}
					onChange={(event) => setReference(event.target.value)}
				/>
			)}
			<label className="rc-check">
				<input
					type="checkbox"
					checked={received}
					onChange={(event) => setReceived(event.target.checked)}
				/>
				{t("received")}
			</label>
			<Failure error={mutation.error} />
			<Button type="submit" variant="primary" disabled={mutation.pending || !received}>
				{t(mutation.pending ? "saving" : "settleBill")}
			</Button>
		</form>
	);
}

export function Bills({ data, onDone }: { data: Workspace; onDone: () => void }) {
	const { t, locale } = useText();
	const canOperate = ["manager", "administrator", "cashier"].includes(data.role);
	const open = data.bills.filter((bill) => bill.status === "open");
	const settled = [...data.bills]
		.filter((bill) => bill.status === "settled")
		.sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
	const tableName = (visitId: string) => {
		const visit = data.visits.find((candidate) => candidate.id === visitId);
		return data.tables.find((candidate) => candidate.id === visit?.tableId)?.name ?? visitId.slice(-6);
	};
	return (
		<>
			<Section title={t("openBills")} hint={t("settleWarning")}>
				{open.length === 0 && <p className="rc-empty">{t("noBills")}</p>}
				{open.map((bill) => (
					<article className="rc-panel rc-bill" key={bill.id}>
						<header>
							<h3>{tableName(bill.visitId)}</h3>
							<Status value="pending" label="unpaid" />
						</header>
						<ul className="rc-bill-lines">
							{bill.lines.map((line) => (
								<li key={line.id}>
									<span>
										{line.quantity} × {line.name}
									</span>
									<span>{money(line.total, locale)}</span>
								</li>
							))}
						</ul>
						<div className="rc-total">
							<strong>{t("total")}</strong>
							<strong>{money(bill.total, locale)}</strong>
						</div>
						{canOperate ? (
							<SettleForm bill={bill} branchId={data.branch.id} onDone={onDone} />
						) : (
							<p className="rc-muted">{t("readOnlyHint")}</p>
						)}
					</article>
				))}
			</Section>
			<Section title={t("settledBills")}>
				{settled.length === 0 ? (
					<p className="rc-empty">{t("noBills")}</p>
				) : (
					<div className="rc-panel rc-list">
						{settled.map((bill) => (
							<article className="rc-list-row" key={bill.id}>
								<div>
									<strong>{tableName(bill.visitId)}</strong>
									<small className="rc-muted">
										{bill.method === "cash" ? t("cash") : t("bankTransfer")}
										{bill.reference ? ` · ${bill.reference}` : ""}
									</small>
								</div>
								<span>{money(bill.total, locale)}</span>
							</article>
						))}
					</div>
				)}
			</Section>
		</>
	);
}
