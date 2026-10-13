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
TOKEN="\$OTA_PUSH_TOKEN"          # private bearer, shown once in Push tokens
SIGNATURE="\${OTA_PUBLIC_SIGNATURE:-}" # public metadata, never an upload credential
MANDATORY="\${OTA_MANDATORY:-false}"   # exact text true/false; mobile implements the policy
set --
if [ -n "\${OTA_UPLOAD_KEY:-}" ]; then
  set -- -H "X-OTA-Upload-Key: \$OTA_UPLOAD_KEY"
fi
# A configured app requires its private OTA_UPLOAD_KEY from the approved CI secret store.
BUNDLE="./build/app.bundle"

SHA=\$(shasum -a 256 "\$BUNDLE" | awk '{print \$1}')

# Publish. Multipart channel/binary stay literal; URL query values below are encoded.
curl --fail-with-body -X POST \\
  "\$BASE/ota/\$APP/\$PLATFORM/releases" \\
  -H "Authorization: Bearer \$TOKEN" \\
  "\$@" \\
  -F "bundle=@\$BUNDLE" \\
  --form-string "channel=\$CHANNEL" \\
  --form-string "binary=\$BINARY" \\
  --form-string "sha256=\$SHA" \\
  --form-string "signature=\$SIGNATURE" \\
  --form-string "mandatory=\$MANDATORY" \\
  --form-string "note=nightly" \\
  --form-string "commit=\$(git rev-parse --short HEAD)"

# The apps read this anonymously; keep it fresh (no-cache is set).
curl --fail-with-body "\$BASE/ota/\$APP/\$PLATFORM/manifest.json"

# Destructive: removes every release for this pair; mobile owns any fallback policy.
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
								<td>Bearer + upload key if configured</td>
								<td>
									<code>multipart/form-data</code>: <code>bundle</code>, <code>channel</code>, <code>binary</code>,{" "}
									<code>sha256</code>; optional <code>note</code>, <code>commit</code>, <code>signature</code> and{" "}
									<code>mandatory</code>. Answers <code>201</code> with one manifest entry, including public{" "}
									<code>signature</code> and boolean <code>mandatory</code>. Maximum {bytes(info.limits.maxBundleBytes)}.
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
									Answers <code>204</code>; removes all releases for the pair, not bytes already on a device.
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

			<Section title="Release metadata and mobile policy" description="The backend stores metadata; the mobile app applies updates.">
				<ul className="ota-rules">
					<li>
						<code>signature</code> is optional public metadata, default <code>""</code>: canonical standard
						base64, at most 4096 characters. A 64-byte value is 88 characters; no algorithm-specific length is
						required. The server does not verify signatures or prove bundle origin.
					</li>
					<li>
						Send multipart <code>mandatory</code> as exactly <code>true</code> or <code>false</code>;
						omission defaults to <code>false</code>. It is returned as a JSON boolean, never a truthy string.
						<code>true</code> means mobile must apply the compatible update; <code>false</code> means optional.
						Mobile must implement that policy; the server cannot install or restart the app.
					</li>
					<li>SHA-256 checks uploaded bytes against the publisher's declared hash, not trusted signing.</li>
				</ul>
				<div className="ota-snippet">
					<pre><code>{`// 201 is one entry; manifest wraps it at channels[channel][binary].
// Other fields remain id, file, sha256, size, note, commit, branch, createdAt.
{"signature":"","mandatory":false}`}</code></pre>
				</div>
			</Section>

			<Section title="Private upload protection" description="Never put a bearer or upload key in signature or the mobile app.">
				<ul className="ota-rules">
					<li>
						Create or rotate the per-app key under Push tokens → Extra upload protection. The server generates
						64 random bytes as standard base64 (88 characters), stores only its hash and returns plaintext once.
						First creation enables an additional <code>X-OTA-Upload-Key</code> requirement for public POST releases.
						Unconfigured apps still require only the existing bearer.
					</li>
					<li>
						Rotation immediately replaces the key for newly authenticated pushes; an upload already authenticated
						may finish. Existing releases/downloads, bearer list/DELETE and session-authorized manual admin upload
						are unchanged. Missing/wrong configured keys return <code>403 UPLOAD_KEY_REQUIRED</code> or{" "}
						<code>UPLOAD_KEY_INVALID</code>.
					</li>
					<li>
						Admin endpoints use the same-origin EmDash session with <code>settings:manage</code>, not a push
						bearer. Writes require matching <code>Origin</code>, <code>X-EmDash-Request: 1</code>, and JSON
						<code>Content-Type: application/json</code>. Browser fetch uses <code>credentials: "same-origin"</code>.
					</li>
				</ul>
				<div className="ota-snippet">
					<pre><code>{`GET /api/ota/upload-key?app=${app}
200 {"ok":true,"data":{"app":"${app}","configured":false,"updatedAt":null}}

POST /api/ota/upload-key-rotate
JSON body: {"app":"${app}"}
201 {ok:true,data:{key:<one-time private value>,record:{app,configured:true,updatedAt}}}

Admin errors: {"ok":false,"error":{"code":"...","message":"..."}}
Admin responses: Cache-Control: private, no-store
Do not log the rotation response. Transfer the key to the approved CI secret store.`}</code></pre>
				</div>
			</Section>

			<Section
				title="Publish from CI"
				description="Bash example: inject private credentials from the approved CI store, never log them. SHA mismatch returns 400; it is not signature verification."
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
						A build expires <strong>{info.limits.retentionDays} days</strong> after creation, including the current
						one. Replaying identical bytes and metadata does not refresh its creation time. Choose a retention
						window appropriate to the dev release schedule.
					</li>
					<li>
						Roll back from Releases: the selected build becomes the manifest entry immediately. Mobile must poll
						and apply it; the server does not force a running device to revert.
					</li>
					<li>
						Manifests are derived from the database inside one transaction, so two simultaneous pushes cannot lose
						each other's build.
					</li>
					<li>
						A current bundle replay requires the same SHA-256, size, signature and mandatory flag. It returns
						the existing release without a duplicate; changing signature or mandatory creates a new release.
					</li>
				</ul>
			</Section>
		</>
	);
}
