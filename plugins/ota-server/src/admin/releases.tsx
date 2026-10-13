/**
 * Releases tab: what each app, platform, channel and binary currently serves,
 * plus manual upload, rollback and removal for the app manager.
 */

import { Badge, Button, Input, Select } from "@cloudflare/kumo";
import { useState } from "react";
import type { FormEvent } from "react";
import { get, post, uploadBundle } from "./client.js";
import type { OtaInfo, OtaRelease, OtaReleasePage } from "../domain/types.js";
import { CopyButton, Failure, Section, bytes, shortHash, useAsync, when } from "./shared.js";

type Platform = "android" | "ios";

export function releaseUrl(release: OtaRelease): string {
	const file = release.file
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `${window.location.origin}/ota/${release.app}/${release.platform}/${file}`;
}

export function ReleasesTab({ info }: { info: OtaInfo }) {
	const apps = info.apps;
	const [app, setApp] = useState(apps[0]?.slug ?? "");
	const [platform, setPlatform] = useState<Platform>("android");
	const [channelInput, setChannelInput] = useState("");
	const [binaryInput, setBinaryInput] = useState("");
	const [applied, setApplied] = useState({ channel: "", binary: "" });
	const [refresh, setRefresh] = useState(0);
	const [busy, setBusy] = useState("");
	const [actionError, setActionError] = useState<unknown>(null);

	const page = useAsync<OtaReleasePage>(
		(signal) =>
			get<OtaReleasePage>(
				"releases",
				{
					app: app === "" ? undefined : app,
					platform,
					channel: applied.channel === "" ? undefined : applied.channel,
					binary: applied.binary === "" ? undefined : applied.binary,
				},
				signal,
			),
		[app, platform, applied.channel, applied.binary, refresh],
	);

	async function mutate(action: string, body: unknown, id: string) {
		setBusy(id);
		setActionError(null);
		try {
			await post(action, body);
			page.reload();
		} catch (error) {
			setActionError(error);
		} finally {
			setBusy("");
		}
	}

	return (
		<>
			<Section
				title="Published builds"
				description="One entry per channel and binary is served to the apps. The previous build is kept for rollback until it expires."
				actions={
					<Button type="button" onClick={page.reload} disabled={page.loading}>
						{page.loading ? "Refreshing…" : "Refresh"}
					</Button>
				}
			>
				<div className="ota-filters">
					<Select
						label="App"
						value={app}
						items={apps.map((entry) => ({ value: entry.slug, label: entry.slug }))}
						onValueChange={(value) => setApp(String(value))}
					/>
					<Select
						label="Platform"
						value={platform}
						items={[
							{ value: "android", label: "android" },
							{ value: "ios", label: "ios" },
						]}
						onValueChange={(value) => setPlatform(String(value) as Platform)}
					/>
					<Input
						label="Channel"
						placeholder="any channel"
						value={channelInput}
						onChange={(event) => setChannelInput(event.target.value)}
					/>
					<Input
						label="Binary"
						placeholder="any binary"
						value={binaryInput}
						onChange={(event) => setBinaryInput(event.target.value)}
					/>
					<div className="ota-filter-apply">
						<Button
							type="button"
							onClick={() => setApplied({ channel: channelInput.trim(), binary: binaryInput.trim() })}
						>
							Apply filters
						</Button>
					</div>
				</div>

				<Failure error={page.error} onRetry={page.reload} />
				<Failure error={actionError} />

				{page.loading && !page.data ? <p role="status">Loading releases…</p> : null}

				{page.data ? (
					page.data.items.length === 0 ? (
						<p className="ota-muted">No builds are stored for this selection.</p>
					) : (
						<div className="ota-table-scroll" role="region" aria-label="OTA releases" tabIndex={0}>
							<table>
								<caption>
									{page.data.items.length} build{page.data.items.length === 1 ? "" : "s"}
									{page.data.nextCursor ? " (first page)" : ""}
								</caption>
								<thead>
									<tr>
										<th scope="col">Channel / binary</th>
										<th scope="col">Build id</th>
										<th scope="col">Size</th>
										<th scope="col">Note / commit</th>
										<th scope="col">Update metadata</th>
										<th scope="col">Created</th>
										<th scope="col">State</th>
										<th scope="col">Actions</th>
									</tr>
								</thead>
								<tbody>
									{page.data.items.map((release) => (
										<tr key={release.id}>
											<th scope="row">
												{release.channel}
												<small>
													{release.platform} · {release.binary}
												</small>
											</th>
											<td>
												<code>{release.releaseId}</code>
											</td>
											<td>
												{bytes(release.size)}
												<small title={release.sha256}>{shortHash(release.sha256)}</small>
											</td>
											<td>
												{release.note === "" ? <span className="ota-muted">—</span> : release.note}
												{release.commit === "" ? null : <small>{release.commit}</small>}
											</td>
											<td>
												<Badge variant={release.mandatory ? "warning" : "secondary"}>
													{release.mandatory ? "Mandatory" : "Optional"}
												</Badge>
												{release.signature === "" ? (
													<small className="ota-muted">No signature</small>
												) : (
													<small><code>{release.signature}</code></small>
												)}
											</td>
											<td>{when(release.createdAt)}</td>
											<td>
												{release.selected ? (
													<Badge variant="success">Current</Badge>
												) : (
													<Badge variant="secondary">Previous</Badge>
												)}
											</td>
											<td className="ota-row-actions">
												<CopyButton value={releaseUrl(release)} label="Copy URL" />
												{release.selected ? null : (
													<button
														type="button"
														className="ota-link"
														disabled={busy === release.id}
														onClick={() => void mutate("release-promote", { id: release.id }, release.id)}
													>
														Roll back
													</button>
												)}
												<button
													type="button"
													className="ota-link ota-danger"
													disabled={busy === release.id}
													onClick={() => {
														if (
															window.confirm(
																`Delete build ${release.releaseId} for ${release.channel} · ${release.binary}? Devices that already downloaded it keep working.`,
															)
														)
															void mutate("release-delete", { id: release.id }, release.id);
													}}
												>
													Delete
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)
				) : null}
			</Section>

			<UploadForm info={info} onUploaded={page.reload} />
		</>
	);
}

function UploadForm({ info, onUploaded }: { info: OtaInfo; onUploaded: () => void }) {
	const [app, setApp] = useState(info.apps[0]?.slug ?? "");
	const [platform, setPlatform] = useState<Platform>("android");
	const [channel, setChannel] = useState("");
	const [binary, setBinary] = useState("");
	const [note, setNote] = useState("");
	const [commit, setCommit] = useState("");
	const [signature, setSignature] = useState("");
	const [mandatory, setMandatory] = useState(false);
	const [file, setFile] = useState<File | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [done, setDone] = useState<string>("");

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!file) return;
		setPending(true);
		setError(null);
		setDone("");
		const form = new FormData();
		form.set("app", app);
		form.set("platform", platform);
		form.set("channel", channel.trim());
		form.set("binary", binary.trim());
		form.set("note", note);
		form.set("commit", commit);
		form.set("signature", signature);
		form.set("mandatory", mandatory ? "true" : "false");
		form.set("bundle", file, file.name);
		try {
			const release = await uploadBundle(form);
			setDone(`Published ${release.releaseId} for ${release.channel} · ${release.binary}.`);
			setNote("");
			setCommit("");
			setSignature("");
			setMandatory(false);
			setFile(null);
			onUploaded();
		} catch (cause) {
			setError(cause);
		} finally {
			setPending(false);
		}
	}

	return (
		<Section
			title="Upload a build"
			description={`Accept a bundle up to ${bytes(info.limits.maxBundleBytes)}. The server computes sha256; CI pushes the same release through the documented API.`}
		>
			<form className="ota-upload" onSubmit={(event) => void submit(event)}>
				<Select
					label="App"
					value={app}
					items={info.apps.map((entry) => ({ value: entry.slug, label: entry.slug }))}
					onValueChange={(value) => setApp(String(value))}
				/>
				<Select
					label="Platform"
					value={platform}
					items={[
						{ value: "android", label: "android" },
						{ value: "ios", label: "ios" },
					]}
					onValueChange={(value) => setPlatform(String(value) as Platform)}
				/>
				<Input
					label="Channel"
					required
					placeholder="ducnv/feature/luu-kho"
					value={channel}
					onChange={(event) => setChannel(event.target.value)}
				/>
				<Input
					label="Binary"
					required
					placeholder="1.0.66+93"
					value={binary}
					onChange={(event) => setBinary(event.target.value)}
				/>
				<Input label="Note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
				<Input label="Commit" value={commit} onChange={(event) => setCommit(event.target.value)} maxLength={64} />
				<Input
					label="Signature (standard base64, optional)"
					value={signature}
					onChange={(event) => setSignature(event.target.value)}
					maxLength={4096}
				/>
				<label className="ota-field">
					<span>
						<input
							type="checkbox"
							checked={mandatory}
							onChange={(event) => setMandatory(event.target.checked)}
						/>{" "}
						Mandatory update
					</span>
					<small>The mobile app must apply mandatory updates. The server stores this flag only.</small>
				</label>
				<label className="ota-field">
					<span>Bundle file</span>
					<input
						type="file"
						required
						accept=".bundle,application/octet-stream"
						onChange={(event) => setFile(event.target.files?.[0] ?? null)}
					/>
				</label>
				<div className="ota-form-actions">
					<Button type="submit" disabled={pending || !file || channel.trim() === "" || binary.trim() === ""}>
						{pending ? "Uploading…" : "Publish build"}
					</Button>
					{file ? <span className="ota-muted">{file.name} · {bytes(file.size)}</span> : null}
				</div>
				<Failure error={error} />
				{done === "" ? null : (
					<p className="ota-notice" role="status">
						{done}
					</p>
				)}
			</form>
		</Section>
	);
}
