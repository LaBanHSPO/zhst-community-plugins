import { definePlugin, definePluginRoute, InvalidCursorError, type PluginDescriptor, type RouteContext } from 'emdash';
import type { ApiResult, Currency } from './model.js';
import { ErpService } from './service.js';
import { ErpError } from './validation.js';

export interface ErpMiniOptions { currency?: Currency; accounting?: boolean }
const pages = [{ path: '/workspace', label: 'ERP mini' }];

export function erpMiniPlugin(options: ErpMiniOptions = {}): PluginDescriptor<ErpMiniOptions> {
  return {
    id: 'erp-mini', version: '0.1.0', format: 'native', entrypoint: '@zerohost/plugin-erp-mini',
    adminEntry: '@zerohost/plugin-erp-mini/admin', adminPages: pages, options,
  };
}

export function createPlugin(options: ErpMiniOptions = {}) {
  async function execute<T>(ctx: RouteContext, method: 'GET' | 'POST', action: (service: ErpService) => Promise<T>): Promise<ApiResult<T>> {
    try {
      if (ctx.request.method !== method) throw new ErpError('METHOD_NOT_ALLOWED', `Use ${method} for this action.`);
      if (!ctx.user?.id) throw new ErpError('AUTH_REQUIRED', 'An authenticated administrator is required.');
      const service = new ErpService({ settings: ctx.storage.settings, customers: ctx.storage.customers, items: ctx.storage.items, sales: ctx.storage.sales }, ctx.user.id, options.currency ?? 'USD');
      return { ok: true, data: await action(service) };
    } catch (error) {
      if (error instanceof ErpError) return { ok: false, error: { code: error.code, message: error.message } };
      if (error instanceof InvalidCursorError) return { ok: false, error: { code: 'INVALID_CURSOR', message: 'This pagination cursor is invalid. Reload the list from its first page.' } };
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'The action could not be completed. Keep your form and try again, or contact your administrator.' } };
    }
  }
  return definePlugin({
    id: 'erp-mini', version: '0.1.0',
    storage: {
      settings: { indexes: [] },
      customers: { indexes: ['nameKey', 'active', ['active', 'nameKey']] },
      items: { indexes: ['nameKey', 'active', ['active', 'nameKey']] },
      sales: { indexes: ['hasOrder'] },
    },
    admin: { pages },
    routes: {
      info: definePluginRoute({ methods: ['GET'], permission: 'plugins:manage', request: { body: 'none' }, handler: (ctx) => execute(ctx, 'GET', async (service) => ({ ...await service.info(), accounting: options.accounting === true })) }),
      list: definePluginRoute({ methods: ['POST'], permission: 'plugins:manage', request: { body: 'json', maxBytes: 4096 }, handler: (ctx) => execute(ctx, 'POST', (service) => service.list(ctx.input)) }),
      get: definePluginRoute({ methods: ['POST'], permission: 'plugins:manage', request: { body: 'json', maxBytes: 4096 }, handler: (ctx) => execute(ctx, 'POST', (service) => service.get(ctx.input)) }),
      'save-customer': definePluginRoute({ methods: ['POST'], permission: 'plugins:manage', request: { body: 'json', maxBytes: 65536 }, handler: (ctx) => execute(ctx, 'POST', (service) => service.saveCustomer(ctx.input)) }),
      'save-item': definePluginRoute({ methods: ['POST'], permission: 'plugins:manage', request: { body: 'json', maxBytes: 16384 }, handler: (ctx) => execute(ctx, 'POST', (service) => service.saveItem(ctx.input)) }),
      'save-quote': definePluginRoute({ methods: ['POST'], permission: 'plugins:manage', request: { body: 'json', maxBytes: 65536 }, handler: (ctx) => execute(ctx, 'POST', (service) => service.saveQuote(ctx.input)) }),
      transition: definePluginRoute({ methods: ['POST'], permission: 'plugins:manage', request: { body: 'json', maxBytes: 4096 }, handler: (ctx) => execute(ctx, 'POST', (service) => service.transition(ctx.input)) }),
    },
  });
}
