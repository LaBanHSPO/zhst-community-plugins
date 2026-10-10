import type { StorageCollection } from 'emdash';
import type { z } from 'zod';
import type { Currency, Customer, Item, Sale, Metadata, RecordView, ListPage, Info } from './model.js';
import { MINOR_UNITS, PAGE_SIZE, MAX_LINES, MAX_CONTACTS } from './model.js';
import { ErpError, parse, currencySchema, customerSchema, itemSchema, quoteSchema, transitionSchema, getSchema, listSchema, checkedLineTotal, checkedAdd, settingsRecordSchema, customerRecordSchema, itemRecordSchema, saleRecordSchema } from './validation.js';

export type ErpCollection = Pick<StorageCollection<unknown>, 'getVersioned' | 'compareAndSet' | 'query'>;
export interface ErpStorage { settings: ErpCollection; customers: ErpCollection; items: ErpCollection; sales: ErpCollection }
interface Settings extends Metadata { currency: Currency }
type WhereClause = NonNullable<NonNullable<Parameters<ErpCollection['query']>[0]>['where']>;

function versionedValue<T>(schema: z.ZodType<T>, value: unknown): T {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1) {
    throw new ErpError('SCHEMA_VERSION', 'This installation contains an unsupported record schema. A reviewed migration is required.');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ErpError('INVALID_RECORD', 'A saved record is malformed. Ask your administrator to review it before continuing.');
  return parsed.data;
}
function conflict(): never {
  throw new ErpError('CONFLICT', 'This record changed or its ID already exists. Reload before saving; your unsaved form should be kept.');
}

export class ErpService {
  constructor(
    private readonly storage: ErpStorage,
    private readonly actorId: string,
    private readonly currency: Currency = 'USD',
    private readonly now: () => Date = () => new Date(),
  ) {}

  private metadata(previous?: Metadata): Metadata {
    const timestamp = this.now().toISOString();
    return { schemaVersion: 1, createdAt: previous?.createdAt ?? timestamp, createdBy: previous?.createdBy ?? this.actorId, updatedAt: timestamp, updatedBy: this.actorId };
  }

  private async configured(): Promise<Currency> {
    if (!this.actorId) throw new ErpError('AUTH_REQUIRED', 'An authenticated administrator is required.');
    const currency = parse(currencySchema, this.currency);
    let current = await this.storage.settings.getVersioned('configuration');
    if (!current) {
      const value: Settings = { ...this.metadata(), currency };
      const result = await this.storage.settings.compareAndSet('configuration', null, value);
      if (result.applied) return currency;
      // Only first-install configuration initialization may reread a lost CAS.
      current = await this.storage.settings.getVersioned('configuration');
      if (!current) conflict();
    }
    const saved = versionedValue(settingsRecordSchema, current.value);
    if (saved.currency !== currency) throw new ErpError('CURRENCY_MISMATCH', `This installation uses ${saved.currency}. Changing currency requires a reviewed migration or a new installation.`);
    return saved.currency;
  }

  private async read<T>(collection: ErpCollection, id: string, schema: z.ZodType<T>): Promise<RecordView<T>> {
    const record = await collection.getVersioned(id);
    if (!record) throw new ErpError('NOT_FOUND', 'The requested record does not exist.');
    return { id, revision: record.revision, value: versionedValue(schema, record.value) };
  }

  private async previous<T>(collection: ErpCollection, id: string, revision: string | null, schema: z.ZodType<T>): Promise<T | undefined> {
    const current = await collection.getVersioned(id);
    if (current) {
      const value = versionedValue(schema, current.value);
      if (revision !== current.revision) conflict();
      return value;
    }
    if (revision !== null) conflict();
    return undefined;
  }

  private async save<T>(collection: ErpCollection, id: string, revision: string | null, value: T): Promise<RecordView<T>> {
    const result = await collection.compareAndSet(id, revision, value);
    if (!result.applied) conflict();
    return { id, revision: result.revision, value };
  }

  async info(): Promise<Info> {
    const currency = await this.configured();
    return { version: '0.1.0', currency, minorUnits: MINOR_UNITS[currency], pageSize: PAGE_SIZE, maxLines: MAX_LINES, maxContacts: MAX_CONTACTS };
  }

  async get(input: unknown): Promise<RecordView<Customer | Item | Sale>> {
    const data = parse(getSchema, input);
    await this.configured();
    if (data.entity === 'customers') return this.read(this.storage.customers, data.id, customerRecordSchema);
    if (data.entity === 'items') return this.read(this.storage.items, data.id, itemRecordSchema);
    const record = await this.read(this.storage.sales, data.id, saleRecordSchema);
    if (data.entity === 'orders' && (!record.value.hasOrder || !record.value.order)) throw new ErpError('NOT_FOUND', 'This quotation has no sales order.');
    return record;
  }

  async list(input: unknown): Promise<ListPage<Customer | Item | Sale>> {
    const data = parse(listSchema, input);
    await this.configured();
    const masters = data.entity === 'customers' || data.entity === 'items';
    const collection = data.entity === 'customers' ? this.storage.customers : data.entity === 'items' ? this.storage.items : this.storage.sales;
    const schema: z.ZodType<Customer | Item | Sale> = data.entity === 'customers' ? customerRecordSchema : data.entity === 'items' ? itemRecordSchema : saleRecordSchema;
    const where: WhereClause = {};
    if (data.entity === 'orders') where.hasOrder = true;
    if (masters && data.active !== undefined) where.active = data.active;
    if (masters && data.search) where.nameKey = { startsWith: data.search.normalize('NFKC').toLowerCase() };
    const page = await collection.query({ where, limit: PAGE_SIZE, cursor: data.cursor });
    return { items: page.items.map(({ id, data: value }) => ({ id, value: versionedValue(schema, value) })), ...(page.cursor ? { cursor: page.cursor } : {}), hasMore: page.hasMore };
  }

  async saveCustomer(input: unknown): Promise<RecordView<Customer>> {
    const data = parse(customerSchema, input);
    await this.configured();
    const previous = await this.previous(this.storage.customers, data.id, data.revision, customerRecordSchema);
    const { id, revision, ...fields } = data;
    const value = { ...fields, ...this.metadata(previous), nameKey: fields.name.normalize('NFKC').toLowerCase() };
    return this.save(this.storage.customers, id, revision, value);
  }

  async saveItem(input: unknown): Promise<RecordView<Item>> {
    const data = parse(itemSchema, input);
    const currency = await this.configured();
    const previous = await this.previous(this.storage.items, data.id, data.revision, itemRecordSchema);
    const { id, revision, ...fields } = data;
    const value = { ...fields, currency, ...this.metadata(previous), nameKey: fields.name.normalize('NFKC').toLowerCase() };
    return this.save(this.storage.items, id, revision, value);
  }

  async saveQuote(input: unknown): Promise<RecordView<Sale>> {
    const data = parse(quoteSchema, input);
    const currency = await this.configured();
    const previous = await this.previous(this.storage.sales, data.id, data.revision, saleRecordSchema);
    if (previous && previous.status !== 'draft') throw new ErpError('INVALID_TRANSITION', 'Only draft quotations can be edited.');
    const { value: customer } = await this.read(this.storage.customers, data.customerId, customerRecordSchema);
    if (!customer.active) throw new ErpError('ARCHIVED_MASTER', 'Select an active customer.');
    const selectedContact = data.contact;
    const contact = selectedContact ? customer.contacts.find((candidate) =>
      candidate.name === selectedContact.name && candidate.email === selectedContact.email && candidate.phone === selectedContact.phone) : undefined;
    if (selectedContact && !contact) throw new ErpError('CONFLICT', 'The selected contact changed or was removed. Reload the customer and choose again.');
    const lines: Sale['lines'] = [];
    let totalMinor = 0;
    for (const line of data.lines) {
      const { value: item } = await this.read(this.storage.items, line.itemId, itemRecordSchema);
      if (!item.active) throw new ErpError('ARCHIVED_MASTER', 'Select active items for every quotation line.');
      if (item.currency !== currency) throw new ErpError('CURRENCY_MISMATCH', 'The selected item uses a different currency. A reviewed migration is required.');
      const lineTotal = checkedLineTotal(item.priceMinor, line.quantity);
      totalMinor = checkedAdd(totalMinor, lineTotal);
      lines.push({ itemId: line.itemId, code: item.code, name: item.name, unit: item.unit, quantity: line.quantity, priceMinor: item.priceMinor, totalMinor: lineTotal });
    }
    const value: Sale = {
      ...this.metadata(previous), number: previous?.number ?? `Q-${data.id}`, reference: data.reference, currency,
      customer: { id: data.customerId, name: customer.name, email: customer.email, phone: customer.phone, address: customer.address, ...(contact ? { contact: { ...contact } } : {}) },
      lines, totalMinor, validUntil: data.validUntil, notes: data.notes, status: 'draft', hasOrder: false, order: null,
    };
    return this.save(this.storage.sales, data.id, data.revision, value);
  }

  async transition(input: unknown): Promise<RecordView<Sale>> {
    const data = parse(transitionSchema, input);
    await this.configured();
    const previous = await this.previous(this.storage.sales, data.id, data.revision, saleRecordSchema);
    if (!previous) throw new ErpError('NOT_FOUND', 'The requested quotation does not exist.');
    const value: Sale = { ...previous, ...this.metadata(previous) };
    const timestamp = value.updatedAt;
    const invalid: () => never = () => { throw new ErpError('INVALID_TRANSITION', 'This action is not allowed in the current quotation or order state.'); };
    switch (data.action) {
      case 'submit':
        if (previous.status !== 'draft') invalid();
        value.status = 'submitted'; value.submittedAt = timestamp;
        break;
      case 'accept':
      case 'convert':
        if (previous.status !== (data.action === 'accept' ? 'submitted' : 'accepted') || previous.hasOrder || previous.order) invalid();
        if (previous.validUntil < timestamp.slice(0, 10)) throw new ErpError('EXPIRED', 'This quotation has expired. Acceptance and conversion are not allowed.');
        if (data.action === 'accept') { value.status = 'accepted'; value.acceptedAt = timestamp; }
        else {
          value.status = 'converted'; value.hasOrder = true;
          value.order = { id: data.id, number: `SO-${data.id}`, status: 'open', createdAt: timestamp, createdBy: this.actorId, updatedAt: timestamp, updatedBy: this.actorId };
        }
        break;
      case 'cancel-quote':
        if (!['draft', 'submitted', 'accepted'].includes(previous.status) || previous.hasOrder || previous.order) invalid();
        value.status = 'cancelled'; value.cancelledAt = timestamp;
        break;
      case 'fulfill-order':
      case 'cancel-order':
        if (previous.status !== 'converted' || !previous.hasOrder || !previous.order || previous.order.status !== 'open') invalid();
        value.order = { ...previous.order, status: data.action === 'fulfill-order' ? 'fulfilled' : 'cancelled', updatedAt: timestamp, updatedBy: this.actorId };
        break;
    }
    // Quotation and order are one aggregate: one revision, one conditional write.
    return this.save(this.storage.sales, data.id, data.revision, value);
  }
}
