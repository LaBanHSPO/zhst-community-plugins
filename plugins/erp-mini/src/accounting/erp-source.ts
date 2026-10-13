import type { Currency } from '../model.js';
import { ErpService, type ErpStorage } from '../service.js';
import { ErpError, parse, settingsRecordSchema, customerRecordSchema } from '../validation.js';
import { sourceCustomerSchema } from './validation.js';

export interface ErpAccountingSource {
  checkCurrency(initialize: boolean, allowMissing?: boolean): Promise<void>;
  customer(id: string, revision: string): Promise<{ code: string; name: string; sourceKind: 'customer'; sourceId: string; sourceRevision: string }>;
}
export function createErpAccountingSource(storage: ErpStorage, actorId: string, currency: Currency): ErpAccountingSource {
  return {
    async checkCurrency(initialize, allowMissing = false) {
      if (!actorId) throw new ErpError('AUTH_REQUIRED', 'An authenticated administrator is required.');
      if (currency !== 'VND') throw new ErpError('CURRENCY_MISMATCH', 'Accounting requires a VND installation. Currency changes need a reviewed migration.');
      if (initialize) { await new ErpService(storage, actorId, currency).info(); return; }
      const record = await storage.settings.getVersioned('configuration');
      if (!record) {
        if (allowMissing) return;
        throw new ErpError('BOOK_REQUIRED', 'Configure the accounting book before using accounting.');
      }
      if (!record.value || typeof record.value !== 'object' || !('schemaVersion' in record.value) || record.value.schemaVersion !== 1) throw new ErpError('SCHEMA_VERSION', 'The saved CRM configuration requires a compatible schema.');
      const saved = settingsRecordSchema.safeParse(record.value);
      if (!saved.success) throw new ErpError('INVALID_RECORD', 'The saved CRM configuration is malformed. A reviewed repair is required.');
      if (saved.data.currency !== currency) throw new ErpError('CURRENCY_MISMATCH', 'The saved CRM currency does not match this VND accounting installation.');
    },
    async customer(id, revision) {
      const input = parse(sourceCustomerSchema, { id, revision });
      await this.checkCurrency(false);
      const record = await storage.customers.getVersioned(input.id);
      if (!record) throw new ErpError('NOT_FOUND', 'The requested CRM customer does not exist.');
      if (!record.value || typeof record.value !== 'object' || !('schemaVersion' in record.value) || record.value.schemaVersion !== 1) throw new ErpError('SCHEMA_VERSION', 'The saved CRM customer requires a compatible schema.');
      const saved = customerRecordSchema.safeParse(record.value);
      if (!saved.success) throw new ErpError('INVALID_RECORD', 'The saved CRM customer is malformed. A reviewed repair is required.');
      if (record.revision !== input.revision) throw new ErpError('CONFLICT', 'The CRM customer changed. Reload it before linking.');
      if (!saved.data.active) throw new ErpError('ARCHIVED_MASTER', 'Select an active CRM customer.');
      return { code: saved.data.code, name: saved.data.name, sourceKind: 'customer', sourceId: input.id, sourceRevision: record.revision };
    },
  };
}
