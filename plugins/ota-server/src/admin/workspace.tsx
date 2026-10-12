/**
 * OTA workspace: the native admin page registered as “OTA server”.
 */

import { Badge, Button, Input, Switch } from "@cloudflare/kumo";
import { useState } from "react";
import type { FormEvent } from "react";
import { get, post } from "./client.js";
import type { OtaApp, OtaInfo } from "../domain/types.js";
import { ActivityTab } from "./activity.js";
import { ApiTab } from "./docs.js";
import { ReleasesTab } from "./releases.js";
import { StorageTab, TokensTab } from "./settings.js";
import { Failure, Stat, Section, bytes, useAsync, when } from "./shared.js";
import "./styles.css";

type TabId = "releases" | "apps" | "tokens" | "storage" | "activity" | "api";

const TABS: { id: TabId; label: string }[] = [
	{ id: "releases", label: "Releases" },
	{ id: "apps", label: "Apps" },
	{ id: "tokens", label: "Push tokens" },
	{ id: "storage", label: "Storage" },
	{ id: "activity", label: "Activity" },
	{ id: "api", label: "Integration" },
];

function AppsTab({ info, onChanged }: { info: OtaInfo; onChanged: () => void }) {
	const [slug, setSlug] = useState("");
	const [name, setName] = useState("");
	const [pending, setPending] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [notice, setNotice] = useState("");

	async function submit(event: FormEvent) {
		event.preventDefault();
		setPending("save");
		setError(null);
		setNotice("");
		try {
			await post<OtaApp>("app-save", { slug: slug.trim(), name: name.trim(), enabled: true });
			setNotice(`Saved ${slug.trim()}. Devices use this value in the URL: /ota/${slug.trim()}/android/manifest.json`);
			setSlug("");
			setName("");
			onChanged();
		} catch (cause) {
			setError(cause);
		} finally {
			setPending("");
		}
	}

	async function toggle(app: OtaApp, enabled: boolean) {
		setPending(app.slug);
		setError(null);
		try {
			await post("app-save", { slug: app.slug, name: app.name, enabled });
			onChanged();
		} catch (cause) {
			setError(cause);
		} finally {
			setPending("");
		}
	}

	return (
		<>
			<Section
				title="Apps"
				description="Each app is a separate namespace: its own tokens, releases and manifest. Disabling an app stops reads and pushes for it."
			>
				<Failure error={error} />
				<div className="ota-table-scroll" role="region" aria-label="OTA apps" tabIndex={0}>
					<table>
						<thead>
							<tr>
								<th scope="col">Slug</th>
								<th scope="col">Name</th>
								<th scope="col">State</th>
								<th scope="col">Manifest URL</th>
								<th scope="col">Updated</th>
								<th scope="col">Enabled</th>
							</tr>
						</thead>
						<tbody>
							{info.apps.map((app) => (
								<tr key={app.slug}>
									<th scope="row">
										<code>{app.slug}</code>
									</th>
									<td>{app.name}</td>
									<td>
										{app.enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="error">Disabled</Badge>}
									</td>
									<td>
										<code>/ota/{app.slug}/&#123;platform&#125;/manifest.json</code>
									</td>
									<td>{when(app.updatedAt)}</td>
									<td>
										<Switch
											label={`Enable ${app.slug}`}
											checked={app.enabled}
											disabled={pending === app.slug}
											onCheckedChange={(value) => void toggle(app, value)}
										/>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</Section>

			<Section title="Add or rename an app" description="The slug is permanent once CI and the apps use it; renaming keeps the same releases.">
				<form className="ota-token-form" onSubmit={(event) => void submit(event)}>
					<Input
						label="Slug"
						required
						placeholder="unitel-man"
						value={slug}
						onChange={(event) => setSlug(event.target.value)}
					/>
					<Input
						label="Display name"
						required
						placeholder="Unitel Man"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
					<Button type="submit" disabled={pending !== "" || slug.trim() === "" || name.trim() === ""}>
						{pending === "save" ? "Saving…" : "Save app"}
					</Button>
				</form>
				{notice === "" ? null : (
					<p className="ota-notice" role="status">
						{notice}
					</p>
				)}
			</Section>
		</>
	);
}

function Workspace() {
	const info = useAsync<OtaInfo>((signal) => get<OtaInfo>("info", {}, signal), []);
	// The tab lives in the URL, so a refresh or a shared link opens the same tab.
	const [tab, setTab] = useState<TabId>(() => {
		const requested = typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get("otaTab");
		return TABS.find((entry) => entry.id === requested)?.id ?? "releases";
	});

	function openTab(next: TabId) {
		const url = new URL(window.location.href);
		url.searchParams.set("otaTab", next);
		window.history.replaceState(window.history.state, "", url);
		setTab(next);
	}

	if (info.loading && !info.data)
		return (
			<div className="ota-server">
				<p role="status">Loading the OTA workspace…</p>
				<Failure error={info.error} onRetry={info.reload} />
			</div>
		);

	if (!info.data)
		return (
			<div className="ota-server">
				<Failure error={info.error ?? new Error("unavailable")} onRetry={info.reload} />
			</div>
		);

	const current = info.data;

	return (
		<div className="ota-server">
			<header className="ota-header">
				<div>
					<p className="ota-eyebrow">Release distribution</p>
					<h1>OTA server</h1>
					<p className="ota-muted">
						Manifest and bundle hosting for the Android and iOS dev builds, on the site storage plan or a private R2
						bucket.
					</p>
				</div>
				<Button type="button" onClick={info.reload} disabled={info.loading}>
					{info.loading ? "Refreshing…" : "Refresh"}
				</Button>
			</header>

			<div className="ota-stats">
				<Stat label="Stored builds" value={String(current.counts.releases)} hint={`${current.counts.channels} channels`} />
				<Stat label="Bundle storage" value={bytes(current.counts.bytes)} hint={`limit ${bytes(current.limits.maxBundleBytes)} per build`} />
				<Stat label="Active tokens" value={String(current.counts.tokens)} />
				<Stat
					label="Storage mode"
					value={current.storage.mode === "platform" ? "Site storage plan" : "Private R2 bucket"}
					hint={current.storage.mode === "r2" ? current.storage.r2.bucket : "storage adapter"}
				/>
			</div>

			{current.storage.mode === "r2" && !current.storage.keyConfigured ? (
				<div className="ota-banner" data-tone="warning">
					R2 settings are stored but <code>OTA_SECRET_KEY</code> is missing on this host, so downloads and pushes fail
					until the secret is set and the storage settings are saved again.
				</div>
			) : null}

			<nav className="ota-tabs" aria-label="OTA workspace sections">
				{TABS.map((entry) => (
					<a
						key={entry.id}
						href={`?otaTab=${entry.id}`}
						aria-current={tab === entry.id ? "page" : undefined}
						onClick={(event) => {
							event.preventDefault();
							openTab(entry.id);
						}}
					>
						{entry.label}
					</a>
				))}
			</nav>

			<Failure error={info.error} onRetry={info.reload} />

			{tab === "releases" ? <ReleasesTab info={current} /> : null}
			{tab === "apps" ? <AppsTab info={current} onChanged={info.reload} /> : null}
			{tab === "tokens" ? <TokensTab info={current} /> : null}
			{tab === "storage" ? <StorageTab info={current} /> : null}
			{tab === "activity" ? <ActivityTab /> : null}
			{tab === "api" ? <ApiTab info={current} /> : null}

			<footer className="ota-footer">
				Bundles are served from this site — no Vercel Blob and no external control plane. Every push, rollback, removal
				and settings change is recorded under Activity.
			</footer>
		</div>
	);
}

export default Workspace;
