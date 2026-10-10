import { Miniflare } from "miniflare";

export function createTestRuntime(binding: string): Miniflare {
	return new Miniflare({
		workers: [
			{
				config: {
					name: "restaurant-test",
					compatibilityDate: "2026-10-10",
					manifest: {
						mainModule: "worker.mjs",
						modules: {
							"worker.mjs": {
								type: "esm",
								contents: 'export default { fetch() { return new Response("test"); } }',
							},
						},
					},
					env: { [binding]: { type: "d1", id: crypto.randomUUID() } },
				},
			},
		],
	});
}
