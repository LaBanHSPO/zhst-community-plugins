import type { ApiResult } from '../model.js';
import { ErpError, parse } from '../validation.js';
import type { AccountingService } from './service.js';
import type { ErpAccountingSource } from './erp-source.js';
import { accountSchema, accountingGetSchema, accountingListSchema, coaImportSchema, coaSelectionSchema, coaTemplateSchema, configureBookSchema, draftActionSchema, journalSchema, linkCustomerSchema, partySchema, postJournalSchema, reportSchema, reverseJournalSchema, settlementSchema } from './validation.js';
import { hkdConfigureSchema, hkdPostSchema, hkdVoidSchema, hkdListSchema, hkdReportSchema } from './hkd-validation.js';

export const ACCOUNTING_ACTIONS = {
  info: { method: 'GET', maxBytes: 0 },
  'configure-book': { method: 'POST', maxBytes: 4096 },
  list: { method: 'POST', maxBytes: 4096 },
  get: { method: 'POST', maxBytes: 4096 },
  report: { method: 'POST', maxBytes: 4096 },
  'save-account': { method: 'POST', maxBytes: 65536 },
  'account-templates': { method: 'GET', maxBytes: 0 },
  'account-template': { method: 'POST', maxBytes: 4096 },
  'preview-account-import': { method: 'POST', maxBytes: 65536 },
  'import-accounts': { method: 'POST', maxBytes: 65536 },
  'save-party': { method: 'POST', maxBytes: 65536 },
  'link-customer': { method: 'POST', maxBytes: 65536 },
  'save-journal': { method: 'POST', maxBytes: 65536 },
  'cancel-draft': { method: 'POST', maxBytes: 65536 },
  'post-journal': { method: 'POST', maxBytes: 65536 },
  'reverse-journal': { method: 'POST', maxBytes: 65536 },
  'save-settlement': { method: 'POST', maxBytes: 65536 },
  'hkd-info': { method: 'GET', maxBytes: 0 },
  'hkd-configure': { method: 'POST', maxBytes: 16384 },
  'hkd-post-entry': { method: 'POST', maxBytes: 16384 },
  'hkd-void-entry': { method: 'POST', maxBytes: 16384 },
  'hkd-list': { method: 'POST', maxBytes: 4096 },
  'hkd-report': { method: 'POST', maxBytes: 4096 },
} as const;

export function validateAccountingActionInput(action: string, input: unknown): unknown {
  switch (action) {
    case 'hkd-info':
      if (input !== undefined) throw new ErpError('INVALID_INPUT', 'Household book info does not accept a request body.');
      return undefined;
    case 'hkd-configure': return parse(hkdConfigureSchema, input);
    case 'hkd-post-entry': return parse(hkdPostSchema, input);
    case 'hkd-void-entry': return parse(hkdVoidSchema, input);
    case 'hkd-list': return parse(hkdListSchema, input);
    case 'hkd-report': return parse(hkdReportSchema, input);
    case 'info':
      if (input !== undefined) throw new ErpError('INVALID_INPUT', 'Accounting info does not accept a request body.');
      return undefined;
    case 'account-templates':
      if (input !== undefined) throw new ErpError('INVALID_INPUT', 'Account templates do not accept a request body.');
      return undefined;
    case 'account-template': return parse(coaTemplateSchema, input);
    case 'preview-account-import': return parse(coaSelectionSchema, input);
    case 'import-accounts': return parse(coaImportSchema, input);
    case 'configure-book': return parse(configureBookSchema, input);
    case 'list': return parse(accountingListSchema, input);
    case 'get': return parse(accountingGetSchema, input);
    case 'report': return parse(reportSchema, input);
    case 'save-account': return parse(accountSchema, input);
    case 'save-party': return parse(partySchema, input);
    case 'link-customer': return parse(linkCustomerSchema, input);
    case 'save-journal': return parse(journalSchema, input);
    case 'cancel-draft': return parse(draftActionSchema, input);
    case 'post-journal': return parse(postJournalSchema, input);
    case 'reverse-journal': return parse(reverseJournalSchema, input);
    case 'save-settlement': return parse(settlementSchema, input);
    default: throw new ErpError('INVALID_ACTION', 'This accounting action is not available.');
  }
}
export async function executeAccountingAction(service: AccountingService, action: string, input: unknown, source?: ErpAccountingSource): Promise<ApiResult<unknown>> {
  try {
    const data = validateAccountingActionInput(action, input);
    if (source) await source.checkCurrency(action === 'configure-book' || action === 'hkd-configure', action === 'info' || action === 'hkd-info');
    let result: unknown;
    switch (action) {
      case 'hkd-info': result = await service.hkd.info(); break;
      case 'hkd-configure': result = await service.hkd.configure(data); break;
      case 'hkd-post-entry': result = await service.hkd.postEntry(data); break;
      case 'hkd-void-entry': result = await service.hkd.voidEntry(data); break;
      case 'hkd-list': result = await service.hkd.list(data); break;
      case 'hkd-report': result = await service.hkd.report(data); break;
      case 'info': result = await service.info(); break;
      case 'configure-book': result = await service.configureBook(data); break;
      case 'list': result = await service.list(data); break;
      case 'get': result = await service.get(data); break;
      case 'report': result = await service.report(data); break;
      case 'save-account': result = await service.saveAccount(data); break;
      case 'account-templates': result = await service.accountTemplates(); break;
      case 'account-template': result = await service.accountTemplate(data); break;
      case 'preview-account-import': result = await service.previewAccountImport(data); break;
      case 'import-accounts': result = await service.importAccounts(data); break;
      case 'save-party': result = await service.saveParty(data); break;
      case 'link-customer': result = await service.linkCustomer(data, source); break;
      case 'save-journal': result = await service.saveJournal(data); break;
      case 'cancel-draft': result = await service.cancelDraft(data); break;
      case 'post-journal': result = await service.postJournal(data); break;
      case 'reverse-journal': result = await service.reverseJournal(data); break;
      case 'save-settlement': result = await service.saveSettlement(data); break;
      default: throw new ErpError('INVALID_ACTION', 'This accounting action is not available.');
    }
    return { ok: true, data: result };
  } catch (error) {
    if (error instanceof ErpError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Accounting could not complete the request. No successful commit has been confirmed.' } };
  }
}
