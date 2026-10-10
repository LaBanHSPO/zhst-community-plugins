import { Button, Input, InputArea } from "@cloudflare/kumo";
import { useState } from "react";
import type {
	Branch,
	Member,
	MenuItem,
	Modifier,
	Role,
	Table,
	Workspace,
} from "../domain/types.js";
import { money } from "./client.js";
import { useText } from "./locale.js";
import type { TextKey } from "./locale.js";
import { Choice, Failure, Section, useCommand, useUnsaved } from "./shared.js";
import { TableQr } from "./table-qr.js";

const roles: Role[] = ["manager", "floor", "kitchen", "cashier", "accountant"];

function BranchForm({ branch, onDone }: { branch?: Branch; onDone: () => void }) {
	const { t } = useText();
	const [draft, setDraft] = useState(() => ({
		name: branch?.name ?? "",
		bankAccount: branch?.bankAccount ?? "",
		bankCode: branch?.bankCode ?? "",
		bankName: branch?.bankName ?? "",
		subAccount: branch?.subAccount ?? "",
		qrMode: branch?.qrMode ?? "direct",
		transferPrefix: branch?.transferPrefix ?? "",
		credentialContext: branch?.credentialContext ?? "",
		environment: branch?.environment ?? "sandbox",
		issuer: branch?.issuer ?? {
			name: "",
			taxCode: "",
			address: "",
			providerAccountId: "",
			templateCode: "",
			series: "",
			sellerStoreXid: "",
		},
	}));
	const [dirty, setDirty] = useState(false);
	const mutation = useCommand(() => {
		setDirty(false);
		onDone();
	});
	useUnsaved(dirty || mutation.pending);
	const fields: {
		key:
			| "name"
			| "bankAccount"
			| "bankCode"
			| "bankName"
			| "subAccount"
			| "credentialContext"
			| "transferPrefix";
		label: TextKey;
		optional?: boolean;
	}[] = [
		{ key: "name", label: "name" },
		{ key: "bankCode", label: "bank" },
		{ key: "bankAccount", label: "account" },
		{ key: "bankName", label: "bankName" },
		{ key: "subAccount", label: "subAccount", optional: true },
		{ key: "transferPrefix", label: "transferPrefix", optional: true },
		{ key: "credentialContext", label: "paymentContext" },
	];
	const issuerFields: { key: keyof Branch["issuer"]; label: TextKey; optional?: boolean }[] = [
		{ key: "name", label: "issuerName" },
		{ key: "taxCode", label: "taxCode" },
		{ key: "address", label: "address" },
		{ key: "providerAccountId", label: "providerAccount" },
		{ key: "templateCode", label: "template" },
		{ key: "series", label: "series" },
		{ key: "sellerStoreXid", label: "sellerStore", optional: true },
	];
	return (
		<form
			className="rc-form"
			onSubmit={(event) => {
				event.preventDefault();
				void mutation.run("save-branch", {
					...draft,
					issuer: { ...draft.issuer, sellerStoreXid: draft.issuer.sellerStoreXid || undefined },
					...(branch ? { id: branch.id, expectedVersion: branch.version } : {}),
				});
			}}
		>
			<div className="rc-form-grid">
				{fields.map((field) => (
					<Input
						key={field.key}
						label={t(field.label)}
						value={draft[field.key]}
						required={field.key === "subAccount" ? draft.qrMode !== "direct" : !field.optional}
						disabled={field.key === "subAccount" && draft.qrMode === "direct"}
						maxLength={field.key === "transferPrefix" || field.key === "subAccount" ? 40 : 300}
						onChange={(event) => {
							setDirty(true);
							setDraft({ ...draft, [field.key]: event.target.value });
						}}
					/>
				))}
				<Choice
					label={t("environment")}
					value={draft.environment}
					options={[
						{ value: "sandbox", label: t("sandbox") },
						{ value: "live", label: t("live") },
					]}
					onChange={(environment) => {
						if (environment === "sandbox" || environment === "live") {
							setDirty(true);
							setDraft({ ...draft, environment });
						}
					}}
				/>
				<Choice
					label={t("qrMode")}
					value={draft.qrMode}
					options={["direct", "virtual", "memo"].map((value) => ({
						value,
						label: t(value as TextKey),
					}))}
					onChange={(qrMode) => {
						if (qrMode === "direct" || qrMode === "virtual" || qrMode === "memo") {
							setDirty(true);
							setDraft({
								...draft,
								qrMode,
								subAccount: qrMode === "direct" ? "" : draft.subAccount,
							});
						}
					}}
				/>
				{issuerFields.map((field) => (
					<Input
						key={field.key}
						label={t(field.label)}
						value={draft.issuer[field.key] ?? ""}
						required={!field.optional}
						maxLength={500}
						onChange={(event) => {
							setDirty(true);
							setDraft({ ...draft, issuer: { ...draft.issuer, [field.key]: event.target.value } });
						}}
					/>
				))}
			</div>
			<p className="rc-muted">{t("qrConfigHint")}</p>
			<p className="rc-muted">{t("contextHint")}</p>
			<Failure error={mutation.error} />
			<Button type="submit" variant="primary" disabled={mutation.pending}>
				{t(mutation.pending ? "saving" : "save")}
			</Button>
			{mutation.saved && <p role="status">{t("saved")}</p>}
		</form>
	);
}

function TableForm({
	table,
	branchId,
	onDone,
}: {
	table?: Table;
	branchId: string;
	onDone: () => void;
}) {
	const { t } = useText();
	const [name, setName] = useState(table?.name ?? "");
	const mutation = useCommand(onDone);
	return (
		<form
			className="rc-form"
			onSubmit={(event) => {
				event.preventDefault();
				void mutation.run("save-table", {
					branchId,
					name,
					...(table ? { id: table.id, expectedVersion: table.version } : {}),
				});
			}}
		>
			<Input
				label={t("name")}
				value={name}
				onChange={(event) => setName(event.target.value)}
				required
				maxLength={100}
			/>
			<Failure error={mutation.error} />
			<Button type="submit" variant="primary" disabled={mutation.pending}>
				{t(mutation.pending ? "saving" : "save")}
			</Button>
		</form>
	);
}

function MemberForm({
	member,
	branchId,
	onDone,
}: {
	member?: Member;
	branchId: string;
	onDone: () => void;
}) {
	const { t } = useText();
	const [userId, setUserId] = useState(member?.userId ?? "");
	const [role, setRole] = useState<Role>(member?.role ?? "floor");
	const [active, setActive] = useState(member?.active ?? true);
	const mutation = useCommand(onDone);
	return (
		<form
			className="rc-form"
			onSubmit={(event) => {
				event.preventDefault();
				void mutation.run("save-member", {
					branchId,
					userId,
					role,
					active,
					...(member ? { expectedVersion: member.version } : {}),
				});
			}}
		>
			<Input
				label={t("userId")}
				value={userId}
				disabled={!!member}
				onChange={(event) => setUserId(event.target.value)}
				required
				maxLength={200}
			/>
			<Choice
				label={t("role")}
				value={role}
				options={roles.map((value) => ({ value, label: t(value) }))}
				onChange={(value) => {
					if (roles.includes(value as Role)) setRole(value as Role);
				}}
			/>
			<Choice
				label={t("active")}
				value={active ? "yes" : "no"}
				options={[
					{ value: "yes", label: t("active") },
					{ value: "no", label: t("inactive") },
				]}
				onChange={(value) => setActive(value === "yes")}
			/>
			<Failure error={mutation.error} />
			<Button type="submit" variant="primary" disabled={mutation.pending}>
				{t(mutation.pending ? "saving" : "save")}
			</Button>
		</form>
	);
}

function MenuForm({
	item,
	branchId,
	onDone,
}: {
	item?: MenuItem;
	branchId: string;
	onDone: () => void;
}) {
	const { t } = useText();
	const [draft, setDraft] = useState(() => ({
		name: item?.name ?? "",
		category: item?.category ?? "",
		description: item?.description ?? "",
		image: item?.image ?? "",
		price: item?.price ?? 0,
		taxRate: item?.taxRate ?? 0,
		available: item?.available ?? true,
		modifiers: item?.modifiers ?? ([] as Modifier[]),
	}));
	const [dirty, setDirty] = useState(false);
	const mutation = useCommand(() => {
		setDirty(false);
		onDone();
	});
	useUnsaved(dirty || mutation.pending);
	function modifier(index: number, update: Partial<Modifier>) {
		setDirty(true);
		setDraft({
			...draft,
			modifiers: draft.modifiers.map((value, offset) =>
				offset === index ? { ...value, ...update } : value,
			),
		});
	}
	return (
		<form
			className="rc-form"
			onChange={() => setDirty(true)}
			onSubmit={(event) => {
				event.preventDefault();
				void mutation.run("save-menu-item", {
					branchId,
					...draft,
					...(item ? { id: item.id, expectedVersion: item.version } : {}),
				});
			}}
		>
			<div className="rc-form-grid">
				<Input
					label={t("name")}
					required
					maxLength={200}
					value={draft.name}
					onChange={(event) => setDraft({ ...draft, name: event.target.value })}
				/>
				<Input
					label={t("category")}
					required
					maxLength={100}
					value={draft.category}
					onChange={(event) => setDraft({ ...draft, category: event.target.value })}
				/>
				<Input
					label={t("price")}
					type="number"
					min={0}
					max={1000000000}
					step={1}
					required
					value={draft.price}
					onChange={(event) => setDraft({ ...draft, price: Number(event.target.value) })}
				/>
				<Choice
					label={t("taxRate")}
					value={String(draft.taxRate)}
					options={[0, 500, 800, 1000].map((rate) => ({
						value: String(rate),
						label: `${rate / 100}%`,
					}))}
					onChange={(value) => {
						setDirty(true);
						setDraft({ ...draft, taxRate: Number(value) });
					}}
				/>
				<Input
					label={t("image")}
					value={draft.image}
					maxLength={2000}
					onChange={(event) => setDraft({ ...draft, image: event.target.value })}
				/>
				<Choice
					label={t("available")}
					value={draft.available ? "yes" : "no"}
					options={[
						{ value: "yes", label: t("available") },
						{ value: "no", label: t("unavailable") },
					]}
					onChange={(value) => {
						setDirty(true);
						setDraft({ ...draft, available: value === "yes" });
					}}
				/>
			</div>
			<InputArea
				label={t("description")}
				value={draft.description}
				maxLength={2000}
				onChange={(event) => setDraft({ ...draft, description: event.target.value })}
			/>
			<p className="rc-muted">{t("taxHint")}</p>
			<fieldset>
				<legend>{t("modifiers")}</legend>
				{draft.modifiers.map((entry, index) => (
					<div className="rc-modifier-row" key={index}>
						<Input
							label={t("modifierId")}
							required
							value={entry.id}
							onChange={(event) => modifier(index, { id: event.target.value })}
						/>
						<Input
							label={t("name")}
							required
							value={entry.name}
							onChange={(event) => modifier(index, { name: event.target.value })}
						/>
						<Input
							label={t("price")}
							type="number"
							min={0}
							step={1}
							required
							value={entry.price}
							onChange={(event) => modifier(index, { price: Number(event.target.value) })}
						/>
						<Button
							type="button"
							onClick={() => {
								setDirty(true);
								setDraft({
									...draft,
									modifiers: draft.modifiers.filter((_, offset) => offset !== index),
								});
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
						setDraft({
							...draft,
							modifiers: [...draft.modifiers, { id: crypto.randomUUID(), name: "", price: 0 }],
						});
					}}
				>
					{t("addModifier")}
				</Button>
			</fieldset>
			<Failure error={mutation.error} />
			<Button type="submit" variant="primary" disabled={mutation.pending}>
				{t(mutation.pending ? "saving" : "save")}
			</Button>
		</form>
	);
}

type Selection =
	| { kind: "branch"; record?: Branch }
	| { kind: "table"; record?: Table }
	| { kind: "member"; record?: Member }
	| { kind: "menu"; record?: MenuItem };
export function Configuration({
	workspace,
	administrator,
	onDone,
}: {
	workspace?: Workspace;
	administrator: boolean;
	onDone: () => void;
}) {
	const { t, locale } = useText();
	const [selection, setSelection] = useState<Selection>();
	const [qrTable, setQrTable] = useState<Table>();
	const [editorGeneration, setEditorGeneration] = useState(0);
	const branchId = workspace?.branch.id ?? "";
	function done() {
		setSelection(undefined);
		onDone();
	}
	if (selection)
		return (
			<Section
				title={t(
					selection.kind === "branch"
						? "branches"
						: selection.kind === "table"
							? "tables"
							: selection.kind === "member"
								? "members"
								: "menuConfig",
				)}
			>
				<div className="rc-toolbar">
					<Button
						type="button"
						onClick={() => {
							if (window.confirm(t("unsaved"))) setSelection(undefined);
						}}
					>
						{t("cancel")}
					</Button>
					{selection.record && (
						<Button
							type="button"
							onClick={() => {
								if (!workspace || !window.confirm(t("unsaved"))) return;
								if (selection.kind === "branch" && "issuer" in workspace.branch)
									setSelection({ kind: "branch", record: workspace.branch });
								if (selection.kind === "table") {
									const record = workspace.tables.find(
										(value) => value.id === selection.record?.id,
									);
									if (record) setSelection({ kind: "table", record });
								}
								if (selection.kind === "member") {
									const record = workspace.members.find(
										(value) => value.userId === selection.record?.userId,
									);
									if (record) setSelection({ kind: "member", record });
								}
								if (selection.kind === "menu") {
									const record = workspace.menu.find((value) => value.id === selection.record?.id);
									if (record) setSelection({ kind: "menu", record });
								}
								setEditorGeneration((value) => value + 1);
							}}
						>
							{t("refresh")}
						</Button>
					)}
				</div>
				<div key={editorGeneration}>
					{selection.kind === "branch" ? (
						<BranchForm branch={selection.record} onDone={done} />
					) : selection.kind === "table" ? (
						<TableForm table={selection.record} branchId={branchId} onDone={done} />
					) : selection.kind === "member" ? (
						<MemberForm member={selection.record} branchId={branchId} onDone={done} />
					) : (
						<MenuForm item={selection.record} branchId={branchId} onDone={done} />
					)}
				</div>
			</Section>
		);
	return (
		<div className="rc-config">
			<Section title={t("branches")} hint={t("contextHint")}>
				<div className="rc-toolbar">
					{administrator && workspace && "issuer" in workspace.branch && (
						<Button
							onClick={() => setSelection({ kind: "branch", record: workspace.branch as Branch })}
						>
							{t("edit")}
						</Button>
					)}
					{administrator && (
						<Button onClick={() => setSelection({ kind: "branch" })}>{t("newRecord")}</Button>
					)}
					{!administrator && workspace && <p>{workspace.branch.name}</p>}
				</div>
			</Section>
			{workspace && (
				<>
					<Section title={t("tables")}>
						<Button onClick={() => setSelection({ kind: "table" })}>{t("newRecord")}</Button>
						<div className="rc-list">
							{workspace.tables.map((table) => (
								<article key={table.id} className="rc-list-row">
									<div>
										<strong>{table.name}</strong>
										<a
											href={`/order/${encodeURIComponent(table.token)}`}
											target="_blank"
											rel="noreferrer"
										>
											{t("tableLink")}
										</a>
										<code>/order/{table.token}</code>
									</div>
									<div className="rc-toolbar">
										<Button
											onClick={() => setQrTable(qrTable?.id === table.id ? undefined : table)}
										>
											{t("tableQr")}
										</Button>
										<Button onClick={() => setSelection({ kind: "table", record: table })}>
											{t("edit")}
										</Button>
									</div>
								</article>
							))}
						</div>
						{qrTable && <TableQr key={qrTable.id} table={qrTable} />}
					</Section>
					<Section title={t("members")}>
						<Button onClick={() => setSelection({ kind: "member" })}>{t("newRecord")}</Button>
						<div className="rc-list">
							{workspace.members.map((member) => (
								<article className="rc-list-row" key={member.userId}>
									<div>
										<strong>{member.userId}</strong>
										<p>
											{t(member.role)} · {t(member.active ? "active" : "inactive")}
										</p>
									</div>
									<Button onClick={() => setSelection({ kind: "member", record: member })}>
										{t("edit")}
									</Button>
								</article>
							))}
						</div>
					</Section>
					<Section title={t("menuConfig")}>
						<Button onClick={() => setSelection({ kind: "menu" })}>{t("newRecord")}</Button>
						<div className="rc-list">
							{workspace.menu.map((item) => (
								<article className="rc-list-row" key={item.id}>
									<div>
										<strong>{item.name}</strong>
										<p>
											{item.category} · {money(item.price, locale)} ·{" "}
											{t(item.available ? "available" : "unavailable")}
										</p>
									</div>
									<Button onClick={() => setSelection({ kind: "menu", record: item })}>
										{t("edit")}
									</Button>
								</article>
							))}
						</div>
					</Section>
				</>
			)}
		</div>
	);
}
