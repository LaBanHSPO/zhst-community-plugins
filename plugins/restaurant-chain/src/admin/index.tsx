import { Button } from "@cloudflare/kumo";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginAdminExports } from "emdash";
import type { Info, Role, Workspace as WorkspaceData } from "../domain/types.js";
import {
	ChefHat,
	IconCard,
	IconExport,
	IconFloor,
	IconOrders,
	IconRefresh,
	IconSettings,
	IconShift,
	RestaurantLogo,
} from "./brand.js";
import { request } from "./client.js";
import { Configuration } from "./configuration.js";
import { Exports, Finance } from "./finance.js";
import { LanguageSelect, RestaurantLocale, useText } from "./locale.js";
import type { TextKey } from "./locale.js";
import { Floor, Kitchen } from "./service.js";
import { Shift } from "./shift.js";
import { Choice, Failure } from "./shared.js";
import { mergeWorkspacePage } from "./workspace-data.js";
import "./styles.css";

type Tab = "tables" | "kitchen" | "payments" | "shift" | "exports" | "configuration";
type FloorView = "floor" | "list";
const roles: Role[] = ["manager", "floor", "kitchen", "cashier", "accountant"];
const roleTabs: Record<Role | "administrator", Tab[]> = {
	administrator: ["tables", "kitchen", "payments", "shift", "exports", "configuration"],
	manager: ["tables", "kitchen", "payments", "shift", "exports", "configuration"],
	floor: ["tables", "kitchen"],
	kitchen: ["kitchen"],
	cashier: ["tables", "kitchen", "payments", "shift"],
	accountant: ["shift", "payments", "exports"],
};
const navMeta: Record<Tab, { Icon: typeof IconFloor; key: TextKey }> = {
	tables: { Icon: IconFloor, key: "navFloor" },
	kitchen: { Icon: IconOrders, key: "navOrders" },
	payments: { Icon: IconCard, key: "navPayments" },
	shift: { Icon: IconShift, key: "navShift" },
	exports: { Icon: IconExport, key: "navExports" },
	configuration: { Icon: IconSettings, key: "navSettings" },
};

function Workspace() {
	const { t } = useText();
	const [info, setInfo] = useState<Info>();
	const [branchId, setBranchId] = useState("");
	const [data, setData] = useState<WorkspaceData>();
	const [tab, setTab] = useState<Tab>("tables");
	const [floorView, setFloorView] = useState<FloorView>("floor");
	const [viewRole, setViewRole] = useState<Role | "administrator">("manager");
	const [error, setError] = useState<unknown>();
	const [loading, setLoading] = useState(true);
	const [revision, setRevision] = useState(0);
	const [loadedPages, setLoadedPages] = useState(1);
	const dirty = useRef(false);
	const refresh = useCallback(() => {
		dirty.current = false;
		setRevision((value) => value + 1);
	}, []);
	useEffect(() => {
		const controller = new AbortController();
		request<Info>("info", {}, { signal: controller.signal }).then(
			(result) => {
				setInfo(result);
				setBranchId((current) =>
					result.branches.some((branch) => branch.id === current)
						? current
						: (result.branches[0]?.id ?? ""),
				);
				if (result.branches.length === 0) {
					setLoading(false);
					setTab("configuration");
				}
			},
			(cause: unknown) => {
				if (!controller.signal.aborted) {
					setError(cause);
					setLoading(false);
				}
			},
		);
		return () => controller.abort();
	}, [revision]);
	useEffect(() => {
		if (!branchId) return;
		const controller = new AbortController();
		let running = false;
		async function load() {
			if (running) return;
			running = true;
			try {
				let result = await request<WorkspaceData>(
					"workspace",
					{ branchId, limit: 100 },
					{ signal: controller.signal },
				);
				for (let page = 1; page < loadedPages && result.nextCursor; page++) {
					const next = await request<WorkspaceData>(
						"workspace",
						{ branchId, cursor: result.nextCursor, limit: 100 },
						{ signal: controller.signal },
					);
					result = mergeWorkspacePage(result, next);
				}
				if (!controller.signal.aborted) {
					setData(result);
					setError(undefined);
				}
			} catch (cause) {
				if (!controller.signal.aborted) setError(cause);
			} finally {
				running = false;
				if (!controller.signal.aborted) setLoading(false);
			}
		}
		setLoading(true);
		void load();
		const interval = window.setInterval(() => {
			if (document.visibilityState === "visible") void load();
		}, 15000);
		return () => {
			controller.abort();
			window.clearInterval(interval);
		};
	}, [branchId, loadedPages, revision]);
	const actualRole =
		info?.branches.find((branch) => branch.id === branchId)?.role ??
		(info?.administrator ? "administrator" : "floor");
	const canManage = actualRole === "manager" || actualRole === "administrator";
	const effectiveRole = canManage ? viewRole : actualRole;
	const tabs = roleTabs[effectiveRole];
	const currentTab = tabs.includes(tab) ? tab : tabs[0];
	const branchName = info?.branches.find((branch) => branch.id === branchId)?.name ?? "";
	const pending =
		(data?.orders.filter((order) => order.status === "pending").length ?? 0) +
		(data?.serviceRequests.filter((request) => request.status === "open").length ?? 0);
	function allowNavigate() {
		return !dirty.current || window.confirm(t("unsaved"));
	}
	function go(next: Tab) {
		if (allowNavigate()) {
			dirty.current = false;
			setTab(next);
		}
	}
	return (
		<div
			className="rc-workspace"
			onChangeCapture={(event) => {
				if (event.target instanceof Element && event.target.closest("form")) dirty.current = true;
			}}
		>
			<div className="rc-app">
				<aside className="rc-sidebar">
					<RestaurantLogo label={t("brandName")} subtitle={t("brandTag")} />
					<nav className="rc-nav" aria-label={t("workspace")}>
						{tabs.map((value) => {
							const { Icon, key } = navMeta[value];
							return (
								<button
									type="button"
									key={value}
									className="rc-nav-item"
									data-active={value === currentTab ? "" : undefined}
									aria-pressed={value === currentTab}
									onClick={() => go(value)}
								>
									<Icon />
									<span>{t(key)}</span>
									{value === "tables" && pending > 0 && (
										<span className="rc-nav-badge">{pending}</span>
									)}
								</button>
							);
						})}
					</nav>
					<div className="rc-sidebar-foot">
						<span className="rc-avatar">
							<ChefHat />
						</span>
						<span>
							<strong>{t(actualRole as TextKey)}</strong>
							<small>{branchName || t("workspace")}</small>
						</span>
					</div>
				</aside>
				<div className="rc-main">
					<header className="rc-topbar">
						<div className="rc-branch-picker">
							<Choice
								label={t("branch")}
								value={branchId}
								options={(info?.branches ?? []).map((branch) => ({
									value: branch.id,
									label: branch.name,
								}))}
								onChange={(value) => {
									if (allowNavigate()) {
										dirty.current = false;
										setBranchId(value);
										setData(undefined);
										setLoadedPages(1);
									}
								}}
							/>
						</div>
						{currentTab === "tables" && (
							<div className="rc-segmented" role="group" aria-label={t("workspace")}>
								<button
									type="button"
									aria-pressed={floorView === "floor"}
									onClick={() => setFloorView("floor")}
								>
									{t("viewFloor")}
								</button>
								<button
									type="button"
									aria-pressed={floorView === "list"}
									onClick={() => setFloorView("list")}
								>
									{t("viewList")}
								</button>
							</div>
						)}
						<span className="rc-topbar-spacer" />
						{canManage ? (
							<Choice
								label={t("role")}
								value={viewRole}
								options={roles.map((role) => ({ value: role, label: t(role) }))}
								onChange={(value) => {
									if (roles.includes(value as Role) && allowNavigate()) setViewRole(value as Role);
								}}
							/>
						) : (
							<p className="rc-muted">
								{t("role")}: <strong>{t(actualRole as TextKey)}</strong>
							</p>
						)}
						<LanguageSelect />
						<Button type="button" onClick={() => setRevision((value) => value + 1)} disabled={loading}>
							<IconRefresh />
							{t("refresh")}
						</Button>
						<div className="rc-tagline">
							<span>{t("tagline")}</span>
							<span className="rc-avatar" aria-hidden="true">
								<ChefHat />
							</span>
						</div>
					</header>
					<div className="rc-body">
						<Failure error={error} />
						{loading && <p role="status">{t("loading")}</p>}
						{info && info.branches.length === 0 && <p className="rc-empty">{t("noBranches")}</p>}
						{currentTab === "configuration" && (canManage || info?.administrator) && (
							<Configuration
								key={branchId}
								workspace={data}
								administrator={!!info?.administrator}
								onDone={refresh}
							/>
						)}
						{data && data.branch.id === branchId && (
							<div aria-busy={loading}>
								{currentTab === "tables" && (
									<Floor data={data} onDone={refresh} view={floorView} />
								)}
								{currentTab === "kitchen" && <Kitchen data={data} onDone={refresh} />}
								{currentTab === "payments" && <Finance data={data} onDone={refresh} />}
								{currentTab === "shift" && <Shift data={data} onDone={refresh} />}
								{currentTab === "exports" && <Exports key={branchId} branchId={branchId} />}
							</div>
						)}
						{data?.nextCursor && (
							<div className="rc-pagination">
								<p>{t("partialData")}</p>
								<Button disabled={loading} onClick={() => setLoadedPages((value) => value + 1)}>
									{t("loadMore")}
								</Button>
							</div>
						)}
					</div>
					<footer className="rc-footer">{t("online")}</footer>
				</div>
			</div>
		</div>
	);
}

function RestaurantWorkspace() {
	return (
		<RestaurantLocale>
			<Workspace />
		</RestaurantLocale>
	);
}
export const pages: PluginAdminExports["pages"] = { "/workspace": RestaurantWorkspace };
const admin: PluginAdminExports = { pages };
export default admin;
