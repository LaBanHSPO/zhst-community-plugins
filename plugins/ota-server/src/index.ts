/**
 * Native EmDash plugin registration.
 *
 * The plugin deliberately declares no API routes: EmDash plugin routes are
 * always mounted at `/_emdash/api/plugins/{id}/*` with an 8 MiB body ceiling,
 * while the app-facing OTA contract is fixed at `/ota/{app}/{platform}/*` and
 * carries 25-100 MiB bundles. The companion theme serves those paths and calls
 * the server exports from this package.
 *
 * Runtime knobs (bundle ceiling, retention window) belong to the host, because
 * the theme builds the runtime for its own routes; see `OTA_MAX_BUNDLE_BYTES`
 * and `OTA_RETENTION_DAYS` in the theme's `wrangler.jsonc`.
 */

import { definePlugin, type PluginDescriptor } from "emdash";

const pages = [{ path: "/workspace", label: "OTA server" }];

export function otaServerPlugin(): PluginDescriptor {
	return {
		id: "ota-server",
		version: "0.1.0",
		format: "native",
		entrypoint: "@zerohost/plugin-ota-server",
		adminEntry: "@zerohost/plugin-ota-server/admin",
		adminPages: pages,
	};
}

export function createPlugin() {
	return definePlugin({
		id: "ota-server",
		version: "0.1.0",
		admin: { pages },
	});
}
