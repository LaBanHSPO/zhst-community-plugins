/**
 * Manifest assembly.
 *
 * The manifest is derived from the release table on every read rather than
 * stored as a blob, so a push can never publish a half-written document.
 */

import type { OtaManifest, OtaManifestEntry, OtaRelease } from "./types.js";

export function manifestEntry(release: OtaRelease): OtaManifestEntry {
	return {
		id: release.releaseId,
		file: release.file,
		sha256: release.sha256,
		size: release.size,
		note: release.note,
		commit: release.commit,
		branch: release.branch,
		createdAt: release.createdAt,
	};
}

/**
 * One entry per channel + binary: the release the operator selected, which is
 * the newest push unless a rollback was promoted explicitly.
 */
export function buildManifest(releases: readonly OtaRelease[]): OtaManifest {
	const channels: Record<string, Record<string, OtaManifestEntry>> = {};
	for (const release of releases) {
		if (!release.selected) continue;
		const binaries = channels[release.channel] ?? {};
		binaries[release.binary] = manifestEntry(release);
		channels[release.channel] = binaries;
	}
	const sorted: Record<string, Record<string, OtaManifestEntry>> = {};
	for (const channel of Object.keys(channels).sort()) {
		const binaries = channels[channel];
		if (!binaries) continue;
		const entry: Record<string, OtaManifestEntry> = {};
		for (const binary of Object.keys(binaries).sort()) {
			const release = binaries[binary];
			if (release) entry[binary] = release;
		}
		sorted[channel] = entry;
	}
	return { channels: sorted };
}
