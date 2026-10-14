/**
 * Storage and push-token tabs.
 *
 * Storage is the operator's choice: the storage plan that comes with the
 * ZeroHostCMS site, or the operator's own Cloudflare R2 bucket reached through
 * its S3 endpoint. An R2 secret is encrypted before it is written to the
 * database and is never returned to the browser.
 */

import { Badge, Button, Input, Select } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { get, post } from "./client.js";
import type { OtaInfo, OtaStorageMode, OtaStorageView, OtaTokenSummary } from "../domain/types.js";
import { CLEAR_SECRET } from "../domain/data.js";
import { CopyButton, Failure, Section, bytes, useAsync, when } from "./shared.js";

export function StorageTab({ info }: { info: OtaInfo }) {
	const view = useAsync<OtaStorageView>((signal) => get<OtaStorageView>("storage", {}, signal), []);
	const [mode, setMode] = useState<OtaStorageMode>("platform");
	const [endpoint, setEndpoint] = useState("");
	const [bucket, setBucket] = useState("");
	const [region, setRegion] = useState("auto");
	const [accessKeyId, setAccessKeyId] = useState("");
	const [secret, setSecret] = useState("");
	const [publicUrl, setPublicUrl] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [pending, setPending] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [notice, setNotice] = useState("");

	useEffect(() => {
		const current = view.data;
		if (!current || loaded) return;
		setMode(current.mode);
		setEndpoint(current.r2.endpoint);
		setBucket(current.r2.bucket);
		setRegion(current.r2.region);
		setAccessKeyId(current.r2.accessKeyId);
		setPublicUrl(current.r2.publicUrl);
		setLoaded(true);
	}, [view.data, loaded]);

	function payload(nextSecret: string) {
		return {
			mode,
			r2: { endpoint: endpoint.trim(), bucket: bucket.trim(), region: region.trim(), accessKeyId: accessKeyId.trim(), secret: nextSecret, publicUrl: publicUrl.trim() },
		};
	}

	async function save(nextSecret: string) {
		setPending("save");
		setError(null);
		setNotice("");
		try {
			const saved = await post<OtaStorageView>("storage-save", payload(nextSecret));
			setSecret("");
			setLoaded(false);
			setNotice(`Storage settings saved. OTA bundles are written to ${saved.mode === "platform" ? "the site storage plan" : `R2 bucket ${saved.r2.bucket}`}.`);
			view.reload();
		} catch (cause) {
			setError(cause);
		} finally {
			setPending("");
		}
	}

	async function test() {
		setPending("test");
		setError(null);
		setNotice("");
		try {
			const result = await post<{ backend: string; bytes: number }>("storage-test", payload(secret));
			setNotice(`Storage reachable: ${result.backend} (wrote, read back and deleted ${bytes(result.bytes)}).`);
		} catch (cause) {
			setError(cause);
		} finally {
			setPending("");
		}
	}

	const current = view.data;

	return (
		<Section
			title="Bundle storage"
			description="Where release bundles live. The ZeroHostCMS storage plan keeps them in the site's own storage; a private R2 bucket keeps them in your Cloudflare account."
			actions={
				<Button type="button" onClick={view.reload} disabled={view.loading}>
					Reload
				</Button>
			}
		>
			<Failure error={view.error} onRetry={view.reload} />
			{view.loading && !current ? <p role="status">Loading storage settings…</p> : null}

			{current ? (
				<>
					<div className="ota-banner" data-tone={current.platformAvailable ? "info" : "warning"}>
						{current.platformAvailable
							? `Site storage is available (${bytes(info.counts.bytes)} of bundles stored now).`
							: "This host did not expose a site storage adapter, so the storage-plan mode cannot serve bundles. Use a private R2 bucket."}
					</div>
					{current.keyConfigured ? null : (
						<div className="ota-banner" data-tone="warning">
							<code>OTA_SECRET_KEY</code> is not set on this host. Generate one with{" "}
							<code>openssl rand -base64 32</code> and store it as a host secret before saving R2 credentials.
						</div>
					)}

					<form
						className="ota-storage"
						onSubmit={(event) => {
							event.preventDefault();
							void save(secret);
						}}
					>
						<Select
							label="Storage mode"
							value={mode}
							items={[
								{ value: "platform", label: "ZeroHostCMS storage plan (site storage)" },
								{ value: "r2", label: "My own Cloudflare R2 bucket (S3 API)" },
							]}
							onValueChange={(value) => setMode(String(value) as OtaStorageMode)}
						/>

						{mode === "r2" ? (
							<div className="ota-grid">
								<Input
									label="S3 endpoint"
									required
									placeholder="https://<account-id>.r2.cloudflarestorage.com"
									value={endpoint}
									onChange={(event) => setEndpoint(event.target.value)}
								/>
								<Input
									label="Bucket"
									required
									placeholder="ota-bundles"
									value={bucket}
									onChange={(event) => setBucket(event.target.value)}
								/>
								<Input label="Region" value={region} onChange={(event) => setRegion(event.target.value)} />
								<Input
									label="Access key ID"
									required
									value={accessKeyId}
									onChange={(event) => setAccessKeyId(event.target.value)}
								/>
								<Input
									label="Secret access key"
									type="password"
									placeholder={current.r2.hasSecret ? "stored — leave blank to keep it" : "required"}
									value={secret}
									onChange={(event) => setSecret(event.target.value)}
								/>
								<Input
									label="Public URL (optional)"
									placeholder="https://cdn.example.com"
									value={publicUrl}
									onChange={(event) => setPublicUrl(event.target.value)}
								/>
							</div>
						) : (
							<p className="ota-muted">
								Bundles are written through the storage adapter configured for this site. Nothing else to configure here.
							</p>
						)}

						<div className="ota-form-actions">
							<Button type="submit" disabled={pending !== ""}>
								{pending === "save" ? "Saving…" : "Save storage settings"}
							</Button>
							<Button type="button" onClick={() => void test()} disabled={pending !== ""}>
								{pending === "test" ? "Testing…" : "Test connection"}
							</Button>
							{current.r2.hasSecret ? (
								<Button type="button" onClick={() => void save(CLEAR_SECRET)} disabled={pending !== ""}>
									Remove stored secret
								</Button>
							) : null}
						</div>
						<Failure error={error} />
						{notice === "" ? null : (
							<p className="ota-notice" role="status">
								{notice}
							</p>
						)}
					</form>
				</>
			) : null}
		</Section>
	);
}


export function TokensTab({ info }: { info: OtaInfo }) {
	const tokens = useAsync<OtaTokenSummary[]>((signal) => get<OtaTokenSummary[]>("tokens", {}, signal), []);
	const [app, setApp] = useState(info.apps[0]?.slug ?? "");
	const [name, setName] = useState("");
	const [pending, setPending] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [issued, setIssued] = useState<{ token: string; app: string; name: string } | null>(null);

	async function create(event: FormEvent) {
		event.preventDefault();
		setPending("create");
		setError(null);
		try {
			const result = await post<{ token: string; record: OtaTokenSummary }>("token-create", { app, name: name.trim() });
			setIssued({ token: result.token, app, name: name.trim() });
			setName("");
			tokens.reload();
		} catch (cause) {
			setError(cause);
		} finally {
			setPending("");
		}
	}

	async function revoke(token: OtaTokenSummary) {
		if (!window.confirm(`Revoke “${token.name}” (${token.prefix}…)? Pushes using it start failing immediately.`)) return;
		setPending(token.id);
		setError(null);
		try {
			await post("token-revoke", { id: token.id });
			tokens.reload();
		} catch (cause) {
			setError(cause);
		} finally {
			setPending("");
		}
	}

	return (
		<Section
			title="Push tokens"
			description="One bearer token per app. CI sends it as Authorization: Bearer <token> when publishing or removing a release."
			actions={
				<Button type="button" onClick={tokens.reload} disabled={tokens.loading}>
					Refresh
				</Button>
			}
		>
			{issued ? (
				<div className="ota-banner" data-tone="success">
					<strong>Copy this token now — it is shown once.</strong>
					<div className="ota-token-value">
						<code>{issued.token}</code>
						<CopyButton value={issued.token} label="Copy token" />
					</div>
					<small>
						App {issued.app} · {issued.name}
					</small>
				</div>
			) : null}

			<form className="ota-token-form" onSubmit={(event) => void create(event)}>
				<Select
					label="App"
					value={app}
					items={info.apps.map((entry) => ({ value: entry.slug, label: entry.slug }))}
					onValueChange={(value) => setApp(String(value))}
				/>
				<Input
					label="Token name"
					required
					placeholder="GitHub Actions · release pipeline"
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
				<Button type="submit" disabled={pending !== "" || name.trim() === ""}>
					{pending === "create" ? "Creating…" : "Create token"}
				</Button>
			</form>

			<Failure error={tokens.error} onRetry={tokens.reload} />
			<Failure error={error} />
			{tokens.loading && !tokens.data ? <p role="status">Loading tokens…</p> : null}

			{tokens.data ? (
				tokens.data.length === 0 ? (
					<p className="ota-muted">No push tokens yet. Create one before enabling CI publishing.</p>
				) : (
					<div className="ota-table-scroll" role="region" aria-label="Push tokens" tabIndex={0}>
						<table>
							<thead>
								<tr>
									<th scope="col">App</th>
									<th scope="col">Name</th>
									<th scope="col">Prefix</th>
									<th scope="col">Created</th>
									<th scope="col">Last used</th>
									<th scope="col">State</th>
									<th scope="col">Actions</th>
								</tr>
							</thead>
							<tbody>
								{tokens.data.map((token) => (
									<tr key={token.id}>
										<th scope="row">{token.app}</th>
										<td>{token.name}</td>
										<td>
											<code>{token.prefix}…</code>
										</td>
										<td>{when(token.createdAt)}</td>
										<td>{when(token.lastUsedAt)}</td>
										<td>
											{token.revokedAt ? <Badge variant="error">Revoked</Badge> : <Badge variant="success">Active</Badge>}
										</td>
										<td>
											{token.revokedAt ? (
												<span className="ota-muted">—</span>
											) : (
												<button
													type="button"
													className="ota-link ota-danger"
													disabled={pending === token.id}
													onClick={() => void revoke(token)}
												>
													Revoke
												</button>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)
			) : null}
		</Section>
	);
}

