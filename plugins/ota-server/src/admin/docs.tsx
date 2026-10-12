/**
 * Integration tab: the frozen client contract, copy-paste friendly.
 */

import { Input } from "@cloudflare/kumo";
import { useState } from "react";
import type { OtaInfo } from "../domain/types.js";
import { CopyButton, Section, bytes } from "./shared.js";

function snippet(baseUrl: string, app: string, platform: string, binary: string, channel: string): string {
	const encodedChannel = encodeURIComponent(channel);
	const encodedBinary = encodeURIComponent(binary);
	return `set -euo pipefail

BASE="${baseUrl}"
APP="${app}"
PLATFORM="${platform}"
CHANNEL="${channel}"
BINARY="${binary}"
TOKEN="\$OTA_PUSH_TOKEN"          # created in the Push tokens tab
BUNDLE="./build/app.bundle"

SHA=\$(shasum -a 256 "\$BUNDLE" | awk '{print \$1}')

# Publish the build. channel and binary are URL-encoded because they contain / and +.
curl --fail-with-body -X POST \\
  "\$BASE/ota/\$APP/\$PLATFORM/releases" \\
  -H "Authorization: Bearer \$TOKEN" \\
  -F "bundle=@\$BUNDLE" \\
  -F "channel=\$CHANNEL" \\
  -F "binary=\$BINARY" \\
  -F "sha256=\$SHA" \\
  -F "note=nightly" \\
  -F "commit=\$(git rev-parse --short HEAD)"

# The apps read this anonymously; keep it fresh (no-cache is set).
curl --fail-with-body "\$BASE/ota/\$APP/\$PLATFORM/manifest.json"

# Remove one channel + binary. Devices fall back to their built-in version.
curl --fail-with-body -X DELETE \\
  "\$BASE/ota/\$APP/\$PLATFORM/releases?channel=${encodedChannel}&binary=${encodedBinary}" \\
  -H "Authorization: Bearer \$TOKEN"`;
}

export function ApiTab({ info }: { info: OtaInfo }) {
	const baseUrl = info.baseUrl === "" ? window.location.origin : info.baseUrl;
	const app = info.apps[0]?.slug ?? "unitel-man";
	const [platform, setPlatform] = useState("android");
	const [binary, setBinary] = useState("1.0.66+93");
	const [channel, setChannel] = useState("ducnv/feature/luu-kho");
	const text = snippet(baseUrl, app, platform, binary, channel);

	return (
		<>
			<Section
				title="Client contract"
				description="The mobile apps already call these endpoints. Treat the paths and response bodies as frozen."
			>
				<div className="ota-table-scroll">
					<table>
						<thead>
							<tr>
								<th scope="col">Method</th>
								<th scope="col">Path</th>
								<th scope="col">Auth</th>
								<th scope="col">Notes</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td>
									<code>GET</code>
								</td>
								<td>
									<code>/ota/&#123;app&#125;/&#123;platform&#125;/manifest.json</code>
								</td>
								<td>none</td>
								<td>
									<code>{`{"channels":{}}`}</code> when empty; <code>Cache-Control: no-cache</code>.
								</td>
							</tr>
							<tr>
								<td>
									<code>GET</code>
								</td>
								<td>
									<code>/ota/&#123;app&#125;/&#123;platform&#125;/&#123;file&#125;</code>
								</td>
								<td>none</td>
								<td>
									Bundle bytes with <code>Content-Length</code>, no compression,{" "}
									<code>max-age=31536000, immutable</code>. Range requests are supported for resumes.
								</td>
							</tr>
							<tr>
								<td>
									<code>POST</code>
								</td>
								<td>
									<code>/ota/&#123;app&#125;/&#123;platform&#125;/releases</code>
								</td>
								<td>Bearer</td>
								<td>
									<code>multipart/form-data</code>: <code>bundle</code>, <code>channel</code>, <code>binary</code>,{" "}
									<code>sha256</code>, optional <code>note</code>, <code>commit</code>. Answers{" "}
									<code>201</code> with the manifest entry. Maximum {bytes(info.limits.maxBundleBytes)}.
								</td>
							</tr>
							<tr>
								<td>
									<code>DELETE</code>
								</td>
								<td>
									<code>/ota/&#123;app&#125;/&#123;platform&#125;/releases?channel=&amp;binary=</code>
								</td>
								<td>Bearer</td>
								<td>
									Answers <code>204</code>. Devices on that channel fall back to the built-in build.
								</td>
							</tr>
							<tr>
								<td>
									<code>GET</code>
								</td>
								<td>
									<code>/ota/&#123;app&#125;/&#123;platform&#125;/releases</code>
								</td>
								<td>Bearer</td>
								<td>Same body as the manifest.</td>
							</tr>
						</tbody>
					</table>
				</div>
			</Section>

			<Section
				title="Publish from CI"
				description="Adjust the example, then copy it into the pipeline. SHA-256 is verified server-side; a mismatch is rejected with 400."
			>
				<div className="ota-grid">
					<Input
						label="Platform"
						value={platform}
						onChange={(event) => setPlatform(event.target.value)}
					/>
					<Input label="Binary" value={binary} onChange={(event) => setBinary(event.target.value)} />
					<Input label="Channel" value={channel} onChange={(event) => setChannel(event.target.value)} />
				</div>
				<div className="ota-snippet">
					<CopyButton value={text} label="Copy script" />
					<pre>
						<code>{text}</code>
					</pre>
				</div>
			</Section>

			<Section title="Retention rules" description="What the server does with published builds.">
				<ul className="ota-rules">
					<li>
						Each channel and binary keeps the <strong>current</strong> build and the{" "}
						<strong>previous</strong> one ({info.limits.keepPerBinary} total). Older builds and their objects are
						deleted.
					</li>
					<li>
						A build that is not pushed again within <strong>{info.limits.retentionDays} days</strong> expires
						automatically, including the current one. Push on the schedule the apps expect, or raise the retention
						window in the host configuration.
					</li>
					<li>
						Roll back from the Releases tab: the previous build becomes the manifest entry immediately, with no
						client change.
					</li>
					<li>
						Manifests are derived from the database inside one transaction, so two simultaneous pushes cannot lose
						each other's build.
					</li>
					<li>
						The same bundle pushed twice with the same SHA-256 for the same channel and binary is treated as a retry
						and does not create a duplicate.
					</li>
				</ul>
			</Section>
		</>
	);
}
