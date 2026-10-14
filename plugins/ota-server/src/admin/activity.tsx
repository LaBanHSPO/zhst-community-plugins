/**
 * Activity tab: the audit trail for pushes, rollbacks, removals, token changes
 * and storage changes. An app manager's answer to "who changed this?".
 */

import { get } from "./client.js";
import type { OtaAuditEvent } from "../domain/types.js";
import { Badge, Button } from "@cloudflare/kumo";
import { Failure, Section, useAsync, when } from "./shared.js";

function tone(action: string): "success" | "error" | "warning" | "secondary" {
	if (action.startsWith("release-remove") || action.startsWith("release-delete") || action.startsWith("token-revoke"))
		return "error";
	if (action.startsWith("release-expire")) return "warning";
	if (action.startsWith("push") || action.startsWith("release-promote")) return "success";
	return "secondary";
}

function detail(event: OtaAuditEvent): string {
	const keys = Object.keys(event.detail);
	if (keys.length === 0) return "—";
	return keys.map((key) => `${key}=${String(event.detail[key])}`).join(" · ");
}

export function ActivityTab() {
	const events = useAsync<OtaAuditEvent[]>((signal) => get<OtaAuditEvent[]>("audit", { limit: 100 }, signal), []);

	return (
		<Section
			title="Activity"
			description="The most recent 100 recorded actions. Push and removal entries include the storage backend that served the bytes."
			actions={
				<Button type="button" onClick={events.reload} disabled={events.loading}>
					{events.loading ? "Refreshing…" : "Refresh"}
				</Button>
			}
		>
			<Failure error={events.error} onRetry={events.reload} />
			{events.loading && !events.data ? <p role="status">Loading activity…</p> : null}
			{events.data ? (
				events.data.length === 0 ? (
					<p className="ota-muted">Nothing recorded yet.</p>
				) : (
					<div className="ota-table-scroll" role="region" aria-label="OTA activity" tabIndex={0}>
						<table>
							<thead>
								<tr>
									<th scope="col">When</th>
									<th scope="col">Action</th>
									<th scope="col">Scope</th>
									<th scope="col">Actor</th>
									<th scope="col">Detail</th>
								</tr>
							</thead>
							<tbody>
								{events.data.map((event) => (
									<tr key={event.id}>
										<td>{when(event.createdAt)}</td>
										<td>
											<Badge variant={tone(event.action)}>{event.action}</Badge>
										</td>
										<td>
											{[event.app, event.platform, event.channel, event.binary].filter(Boolean).join(" · ") || "—"}
										</td>
										<td>{event.actorId ?? event.actorKind}</td>
										<td>
											<small>{detail(event)}</small>
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
