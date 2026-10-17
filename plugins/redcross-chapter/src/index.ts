import {
	definePlugin,
	definePluginRoute,
	InvalidCursorError,
	type PluginDescriptor,
	type RouteContext,
} from 'emdash';
import type { ApiResult } from './model.js';
import { ChapterService, type ChapterStorage } from './service.js';
import { ChapterError } from './validation.js';

export type {
	ApiResult,
	DocumentRecord,
	DocumentType,
	FundEntry,
	FundKind,
	FundTotals,
	Member,
	MemberStatus,
	PublicDocument,
	PublicFund,
	PublicFundEntry,
} from './model.js';

const pages = [{ path: '/workspace', label: 'Hội Chữ thập đỏ' }];
const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';

export function redcrossChapterPlugin(): PluginDescriptor<Record<string, never>> {
	return {
		id: 'redcross-chapter',
		version: '0.1.0',
		format: 'native',
		entrypoint: '@zerohost/plugin-redcross-chapter',
		adminEntry: '@zerohost/plugin-redcross-chapter/admin',
		adminPages: pages,
		options: {},
	};
}

export function createPlugin() {
	function storage(ctx: RouteContext): ChapterStorage {
		return {
			members: ctx.storage.members,
			fund: ctx.storage.fund,
			documents: ctx.storage.documents,
		};
	}

	async function execute<T>(
		ctx: RouteContext,
		method: 'GET' | 'POST',
		action: (service: ChapterService) => Promise<T>,
	): Promise<ApiResult<T>> {
		try {
			if (ctx.request.method !== method) {
				throw new ChapterError('METHOD_NOT_ALLOWED', `Use ${method} for this action.`);
			}
			if (!ctx.user?.id) {
				throw new ChapterError('AUTH_REQUIRED', 'An authenticated administrator is required.');
			}
			const service = new ChapterService(storage(ctx), ctx.user.id);
			return { ok: true, data: await action(service) };
		} catch (error) {
			if (error instanceof ChapterError) {
				return { ok: false, error: { code: error.code, message: error.message } };
			}
			if (error instanceof InvalidCursorError) {
				return {
					ok: false,
					error: {
						code: 'INVALID_CURSOR',
						message: 'This pagination cursor is invalid. Reload the list from its first page.',
					},
				};
			}
			ctx.log?.error?.('redcross-chapter action failed', error);
			return {
				ok: false,
				error: {
					code: 'INTERNAL_ERROR',
					message:
						'The action could not be completed. Keep your form and try again, or contact your administrator.',
				},
			};
		}
	}

	async function publicRead<T>(
		ctx: RouteContext,
		action: (service: ChapterService) => Promise<T>,
	): Promise<ApiResult<T>> {
		try {
			if (ctx.request.method !== 'GET') {
				throw new ChapterError('METHOD_NOT_ALLOWED', 'Use GET for this action.');
			}
			const service = new ChapterService(storage(ctx), ctx.user?.id ?? 'public');
			return { ok: true, data: await action(service) };
		} catch (error) {
			if (error instanceof ChapterError) {
				return { ok: false, error: { code: error.code, message: error.message } };
			}
			ctx.log?.error?.('redcross-chapter public read failed', error);
			return {
				ok: false,
				error: { code: 'INTERNAL_ERROR', message: 'This information is temporarily unavailable.' },
			};
		}
	}

	return definePlugin({
		id: 'redcross-chapter',
		version: '0.1.0',
		storage: {
			members: { indexes: ['status', 'nameKey', 'codeKey', ['status', 'nameKey']] },
			fund: { indexes: ['status', 'kind', 'category', 'date', 'monthKey', ['status', 'monthKey'], ['status', 'date']] },
			documents: { indexes: ['isPublic', 'type', 'date', 'titleKey', ['type', 'date'], ['isPublic', 'date']] },
		},
		admin: { pages },
		routes: {
			info: definePluginRoute({
				methods: ['GET'],
				permission: 'plugins:manage',
				request: { body: 'none' },
				handler: (ctx) => execute(ctx, 'GET', (service) => service.info()),
			}),
			'members-list': definePluginRoute({
				methods: ['POST'],
				permission: 'plugins:manage',
				request: { body: 'json', maxBytes: 4096 },
				handler: (ctx) => execute(ctx, 'POST', (service) => service.listMembers(ctx.input)),
			}),
			'members-import': definePluginRoute({
				methods: ['POST'],
				permission: 'plugins:manage',
				request: { body: 'json', maxBytes: 5_000_000 },
				handler: (ctx) => execute(ctx, 'POST', (service) => service.importMembers(ctx.input)),
			}),
			'members-export': definePluginRoute({
				methods: ['GET'],
				permission: 'plugins:manage',
				request: { body: 'none' },
				handler: (ctx) =>
					execute(ctx, 'GET', async (service) => {
						const { filename, csv } = await service.exportMembers();
						return { filename, csv };
					}),
			}),
			'fund-list': definePluginRoute({
				methods: ['POST'],
				permission: 'plugins:manage',
				request: { body: 'json', maxBytes: 4096 },
				handler: (ctx) => execute(ctx, 'POST', (service) => service.listFund(ctx.input)),
			}),
			'fund-totals': definePluginRoute({
				methods: ['GET'],
				permission: 'plugins:manage',
				request: { body: 'none' },
				handler: (ctx) => execute(ctx, 'GET', (service) => service.fundTotals()),
			}),
			'fund-save': definePluginRoute({
				methods: ['POST'],
				permission: 'plugins:manage',
				request: { body: 'json', maxBytes: 8192 },
				handler: (ctx) => execute(ctx, 'POST', (service) => service.saveFund(ctx.input)),
			}),
			'fund-approve': definePluginRoute({
				methods: ['POST'],
				permission: 'plugins:manage',
				request: { body: 'json', maxBytes: 4096 },
				handler: (ctx) => execute(ctx, 'POST', (service) => service.approveFund(ctx.input)),
			}),
			'documents-list': definePluginRoute({
				methods: ['POST'],
				permission: 'plugins:manage',
				request: { body: 'json', maxBytes: 4096 },
				handler: (ctx) => execute(ctx, 'POST', (service) => service.listDocuments(ctx.input)),
			}),
			'documents-save': definePluginRoute({
				methods: ['POST'],
				permission: 'plugins:manage',
				request: { body: 'json', maxBytes: 8192 },
				handler: (ctx) => execute(ctx, 'POST', (service) => service.saveDocument(ctx.input)),
			}),
			'public-fund': definePluginRoute({
				methods: ['GET'],
				public: true,
				cacheControl: CACHE_CONTROL,
				request: { body: 'none' },
				handler: (ctx) => publicRead(ctx, (service) => service.publicFund()),
			}),
			'public-documents': definePluginRoute({
				methods: ['GET'],
				public: true,
				cacheControl: CACHE_CONTROL,
				request: { body: 'none' },
				handler: (ctx) => publicRead(ctx, (service) => service.publicDocuments()),
			}),
		},
	});
}
