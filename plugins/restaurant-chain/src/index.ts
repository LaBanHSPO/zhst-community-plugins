import { definePlugin, type PluginDescriptor } from "emdash";

const pages = [{ path: "/workspace", label: "Nhà hàng" }];

export function restaurantChainPlugin(): PluginDescriptor {
	return {
		id: "restaurant-chain",
		version: "0.1.0",
		format: "native",
		entrypoint: "@zerohost/plugin-restaurant-chain",
		adminEntry: "@zerohost/plugin-restaurant-chain/admin",
		adminPages: pages,
	};
}

export function createPlugin() {
	return definePlugin({
		id: "restaurant-chain",
		version: "0.1.0",
		admin: { pages },
	});
}
