import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Kysely } from 'kysely';
import { PluginStorageRepository, InvalidCursorError, type Database } from 'emdash';
import { createDialect } from 'emdash/db/sqlite';
import { runMigrations } from 'emdash/db';
import { ErpService, type ErpStorage } from '../src/service.js';
import type { Currency, CustomerInput, ItemInput, QuoteInput, RecordView, Sale } from '../src/model.js';
import { ErpError, checkedAdd, checkedLineTotal, settingsRecordSchema } from '../src/validation.js';

// ERP contract behavior against the public host storage API, not host internals.
// Auth/CSRF and deployed runtime boundaries require the separate real-host suite.
const ids = {
  customer: '11111111-1111-4111-8111-111111111111',
  item: '22222222-2222-4222-8222-222222222222',
  quote: '33333333-3333-4333-8333-333333333333',
};
const customerInput: CustomerInput = { id: ids.customer, revision: null, code: 'C-1', name: 'Acme', email: 'sales@example.test', phone: '123', address: 'One Main St', contacts: [{ name: 'Jo', email: 'jo@example.test', phone: '456' }], active: true };
const itemInput: ItemInput = { id: ids.item, revision: null, code: 'I-1', name: 'Consulting', unit: 'hour', priceMinor: 1250, active: true };
const quoteInput: QuoteInput = { id: ids.quote, revision: null, reference: 'Project A', customerId: ids.customer, contact: customerInput.contacts[0], lines: [{ itemId: ids.item, quantity: 3 }], validUntil: '2030-01-02', notes: 'Agreed scope' };

async function fixture(t: TestContext, currency: Currency = 'USD') {
  const db = new Kysely<Database>({ dialect: createDialect({ url: ':memory:' }) });
  t.after(() => db.destroy());
  await runMigrations(db);
  const storage: ErpStorage = {
    settings: new PluginStorageRepository(db, 'erp-mini', 'settings', []),
    customers: new PluginStorageRepository(db, 'erp-mini', 'customers', ['nameKey', 'active', ['active', 'nameKey']]),
    items: new PluginStorageRepository(db, 'erp-mini', 'items', ['nameKey', 'active', ['active', 'nameKey']]),
    sales: new PluginStorageRepository(db, 'erp-mini', 'sales', ['hasOrder']),
  };
  let time = '2030-01-01T12:00:00.000Z';
  const now = () => new Date(time);
  const service = new ErpService(storage, 'admin-1', currency, now);
  return { db, storage, service, now, setTime(value: string) { time = value; } };
}
async function seed(service: ErpService) {
  const customer = await service.saveCustomer(customerInput);
  const item = await service.saveItem(itemInput);
  const quote = await service.saveQuote(quoteInput);
  return { customer, item, quote };
}
async function accepted(service: ErpService, quote: RecordView<Sale>) {
  const submitted = await service.transition({ id: quote.id, revision: quote.revision, action: 'submit' });
  return service.transition({ id: quote.id, revision: submitted.revision, action: 'accept' });
}
async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof ErpError && error.code === code);
}

test('creates and updates metadata, enforces revision CAS and rejects duplicate create IDs', async (t) => {
  const { service, setTime } = await fixture(t);
  const customer = await service.saveCustomer(customerInput);
  assert.equal(customer.value.createdBy, 'admin-1');
  assert.equal(customer.value.schemaVersion, 1);
  setTime('2030-01-01T13:00:00.000Z');
  const edited = await service.saveCustomer({ ...customerInput, revision: customer.revision, name: 'Edited' });
  assert.notEqual(edited.revision, customer.revision);
  assert.equal(edited.value.createdAt, customer.value.createdAt);
  assert.equal(edited.value.updatedAt, '2030-01-01T13:00:00.000Z');
  await rejectsCode(service.saveCustomer({ ...customerInput, revision: customer.revision, name: 'Stale' }), 'CONFLICT');
  await rejectsCode(service.saveCustomer(customerInput), 'CONFLICT');
  const persisted = await service.get({ entity: 'customers', id: customer.id });
  assert.ok('name' in persisted.value);
  assert.equal(persisted.value.name, 'Edited');
  const item = await service.saveItem(itemInput);
  await service.saveItem({ ...itemInput, revision: item.revision, priceMinor: 0 });
  await rejectsCode(service.saveItem({ ...itemInput, revision: item.revision }), 'CONFLICT');
});

test('draft saves use server snapshots and submitted offers survive archived/edited masters', async (t) => {
  const { service } = await fixture(t);
  const { customer, item, quote } = await seed(service);
  assert.equal(quote.value.number, `Q-${ids.quote}`);
  assert.equal(quote.value.totalMinor, 3750);
  assert.deepEqual(quote.value.customer.contact, customerInput.contacts[0]);
  const submitted = await service.transition({ id: quote.id, revision: quote.revision, action: 'submit' });
  await service.saveCustomer({ ...customerInput, revision: customer.revision, name: 'Changed', contacts: [], active: false });
  await service.saveItem({ ...itemInput, revision: item.revision, name: 'Changed item', priceMinor: 9999, active: false });
  await rejectsCode(service.saveQuote({ ...quoteInput, revision: submitted.revision }), 'INVALID_TRANSITION');
  const saved = await service.get({ entity: 'quotes', id: quote.id });
  assert.deepEqual(saved.value, submitted.value);
  const approved = await service.transition({ id: quote.id, revision: submitted.revision, action: 'accept' });
  const order = await service.transition({ id: quote.id, revision: approved.revision, action: 'convert' });
  assert.deepEqual(order.value.lines, quote.value.lines);
  assert.deepEqual(order.value.customer, quote.value.customer);
  assert.equal(order.value.order?.number, `SO-${ids.quote}`);
});

test('keeps a selected contact stable across customer contact changes', async (t) => {
  const { service } = await fixture(t);
  const { customer, quote } = await seed(service);
  const changed = await service.saveCustomer({
    ...customerInput, revision: customer.revision,
    contacts: [{ name: 'Another contact', email: 'other@example.test', phone: '789' }, ...customerInput.contacts],
  });
  const revised = await service.saveQuote({ ...quoteInput, revision: quote.revision });
  assert.deepEqual(revised.value.customer.contact, customerInput.contacts[0]);
  await service.saveCustomer({
    ...customerInput, revision: changed.revision,
    contacts: [{ ...customerInput.contacts[0], email: 'changed@example.test' }],
  });
  await rejectsCode(service.saveQuote({ ...quoteInput, revision: revised.revision }), 'CONFLICT');
  assert.deepEqual(await service.get({ entity: 'quotes', id: revised.id }), revised);
  const unnamed = await service.saveQuote({ ...quoteInput, revision: revised.revision, contact: undefined });
  assert.equal(unnamed.value.customer.contact, undefined);
});

test('concurrent conversion has exactly one CAS winner and one persisted aggregate', async (t) => {
  const { storage, service, now } = await fixture(t);
  const { quote } = await seed(service);
  const approved = await accepted(service, quote);
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sales = storage.sales;
  const synchronized: ErpStorage = { ...storage, sales: {
    async getVersioned(id) {
      const result = await sales.getVersioned(id);
      if (++arrivals === 2) release();
      await gate;
      return result;
    },
    compareAndSet: sales.compareAndSet.bind(sales), query: sales.query.bind(sales),
  } };
  const first = new ErpService(synchronized, 'admin-a', 'USD', now);
  const second = new ErpService(synchronized, 'admin-b', 'USD', now);
  const input = { id: quote.id, revision: approved.revision, action: 'convert' };
  const outcomes = await Promise.allSettled([first.transition(input), second.transition(input)]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const failure = outcomes.find((result) => result.status === 'rejected');
  assert.ok(failure?.status === 'rejected' && failure.reason instanceof ErpError);
  assert.equal(failure.reason.code, 'CONFLICT');
  const saved = await service.get({ entity: 'orders', id: quote.id });
  assert.ok('order' in saved.value);
  assert.equal(saved.value.order?.id, quote.id);
  assert.equal(saved.value.status, 'converted');
  assert.equal((await storage.sales.query()).items.length, 1);
  assert.equal((await service.list({ entity: 'orders' })).items.length, 1);
  assert.equal((await service.list({ entity: 'quotes' })).items.length, 1);
  await rejectsCode(service.transition({ id: quote.id, revision: saved.revision, action: 'convert' }), 'INVALID_TRANSITION');
});

test('only allowed quote/order transitions change state; fulfilled orders cannot be cancelled', async (t) => {
  const { service } = await fixture(t);
  const { quote } = await seed(service);
  for (const action of ['accept', 'convert', 'fulfill-order', 'cancel-order']) {
    await rejectsCode(service.transition({ id: quote.id, revision: quote.revision, action }), 'INVALID_TRANSITION');
  }
  await rejectsCode(service.get({ entity: 'orders', id: quote.id }), 'NOT_FOUND');
  const approved = await accepted(service, quote);
  await rejectsCode(service.transition({ id: quote.id, revision: quote.revision, action: 'cancel-quote' }), 'CONFLICT');
  const order = await service.transition({ id: quote.id, revision: approved.revision, action: 'convert' });
  await rejectsCode(service.transition({ id: quote.id, revision: order.revision, action: 'cancel-quote' }), 'INVALID_TRANSITION');
  const fulfilled = await service.transition({ id: quote.id, revision: order.revision, action: 'fulfill-order' });
  assert.equal(fulfilled.value.order?.status, 'fulfilled');
  assert.equal(fulfilled.value.status, 'converted');
  await rejectsCode(service.transition({ id: quote.id, revision: fulfilled.revision, action: 'cancel-order' }), 'INVALID_TRANSITION');
});

for (const state of ['draft', 'submitted', 'accepted'] as const) {
  test(`cancels ${state} quotation without creating an order`, async (t) => {
    const { service } = await fixture(t);
    let { quote } = await seed(service);
    if (state !== 'draft') quote = await service.transition({ id: quote.id, revision: quote.revision, action: 'submit' });
    if (state === 'accepted') quote = await service.transition({ id: quote.id, revision: quote.revision, action: 'accept' });
    const cancelled = await service.transition({ id: quote.id, revision: quote.revision, action: 'cancel-quote' });
    assert.equal(cancelled.value.status, 'cancelled');
    assert.equal(cancelled.value.hasOrder, false);
    assert.equal(cancelled.value.order, null);
    await rejectsCode(service.transition({ id: quote.id, revision: cancelled.revision, action: 'submit' }), 'INVALID_TRANSITION');
  });
}

test('cancels an open order without discarding the converted quote or snapshots', async (t) => {
  const { service } = await fixture(t);
  const { quote } = await seed(service);
  const approved = await accepted(service, quote);
  const order = await service.transition({ id: quote.id, revision: approved.revision, action: 'convert' });
  const cancelled = await service.transition({ id: quote.id, revision: order.revision, action: 'cancel-order' });
  assert.equal(cancelled.value.order?.status, 'cancelled');
  assert.equal(cancelled.value.status, 'converted');
  assert.deepEqual(cancelled.value.lines, quote.value.lines);
  assert.equal((await service.list({ entity: 'orders' })).items.length, 1);
  await rejectsCode(service.transition({ id: quote.id, revision: cancelled.revision, action: 'fulfill-order' }), 'INVALID_TRANSITION');
});

test('expiry uses inclusive UTC date for acceptance and is rechecked on conversion', async (t) => {
  const { service, setTime } = await fixture(t);
  const { quote } = await seed(service);
  const submitted = await service.transition({ id: quote.id, revision: quote.revision, action: 'submit' });
  setTime('2030-01-03T00:00:00.000Z');
  await rejectsCode(service.transition({ id: quote.id, revision: submitted.revision, action: 'accept' }), 'EXPIRED');
  assert.equal((await service.get({ entity: 'quotes', id: quote.id })).revision, submitted.revision);
  setTime('2030-01-02T23:59:59.999Z');
  const approved = await service.transition({ id: quote.id, revision: submitted.revision, action: 'accept' });
  setTime('2030-01-03T00:00:00.000Z');
  await rejectsCode(service.transition({ id: quote.id, revision: approved.revision, action: 'convert' }), 'EXPIRED');
  assert.equal((await service.get({ entity: 'quotes', id: quote.id })).revision, approved.revision);
});

test('draft references require active existing masters and existing selected contact', async (t) => {
  const { service } = await fixture(t);
  await rejectsCode(service.saveQuote(quoteInput), 'NOT_FOUND');
  const { customer, item, quote } = await seed(service);
  await rejectsCode(service.saveQuote({ ...quoteInput, revision: quote.revision, contact: { name: 'Unknown', email: '', phone: '' } }), 'CONFLICT');
  const archived = await service.saveCustomer({ ...customerInput, revision: customer.revision, active: false });
  await rejectsCode(service.saveQuote({ ...quoteInput, revision: quote.revision }), 'ARCHIVED_MASTER');
  await service.saveCustomer({ ...customerInput, revision: archived.revision, active: true });
  const archivedItem = await service.saveItem({ ...itemInput, revision: item.revision, active: false });
  await rejectsCode(service.saveQuote({ ...quoteInput, revision: quote.revision }), 'ARCHIVED_MASTER');
  await service.saveItem({ ...itemInput, revision: archivedItem.revision, active: true, priceMinor: 100 });
  const revised = await service.saveQuote({ ...quoteInput, revision: quote.revision });
  assert.equal(revised.value.totalMinor, 300);
  await rejectsCode(service.saveQuote({ ...quoteInput, revision: quote.revision }), 'CONFLICT');
});

test('money uses checked safe integer arithmetic including aggregate overflow', async (t) => {
  assert.equal(checkedLineTotal(0, 1_000_000), 0);
  assert.equal(checkedLineTotal(1_000_000_000_000, 1), 1_000_000_000_000);
  assert.throws(() => checkedLineTotal(1_000_000_000_000, 1_000_000), { code: 'MONEY_OVERFLOW' });
  assert.throws(() => checkedAdd(Number.MAX_SAFE_INTEGER, 1), { code: 'MONEY_OVERFLOW' });
  const { service } = await fixture(t);
  await service.saveCustomer(customerInput);
  await service.saveItem({ ...itemInput, priceMinor: 1_000_000_000_000 });
  await rejectsCode(service.saveQuote({ ...quoteInput, lines: [{ itemId: ids.item, quantity: 1_000_000 }] }), 'MONEY_OVERFLOW');
  await rejectsCode(service.saveQuote({ ...quoteInput, lines: [{ itemId: ids.item, quantity: 5000 }, { itemId: ids.item, quantity: 5000 }] }), 'MONEY_OVERFLOW');
  const saved = await service.saveQuote({ ...quoteInput, lines: [{ itemId: ids.item, quantity: 9007 }] });
  assert.equal(saved.value.totalMinor, 9_007_000_000_000_000);
});

test('rejects malformed, undeclared and server-owned fields before business writes', async (t) => {
  const { service, storage } = await fixture(t);
  for (const priceMinor of [-1, 0.1, 1_000_000_000_001, Number.NaN, Number.POSITIVE_INFINITY, '123']) {
    await rejectsCode(service.saveItem({ ...itemInput, priceMinor }), 'INVALID_INPUT');
  }
  for (const addition of [{ actorId: 'other' }, { currency: 'EUR' }, { schemaVersion: 2 }, { updatedAt: 'fake' }, { tenantId: 'other' }]) {
    await rejectsCode(service.saveItem({ ...itemInput, ...addition }), 'INVALID_INPUT');
  }
  await rejectsCode(service.saveCustomer({ ...customerInput, contacts: [{ ...customerInput.contacts[0], role: 'admin' }] }), 'INVALID_INPUT');
  await rejectsCode(service.saveCustomer({ ...customerInput, contacts: Array(11).fill(customerInput.contacts[0]) }), 'INVALID_INPUT');
  await rejectsCode(service.saveCustomer({ ...customerInput, email: 'invalid' }), 'INVALID_INPUT');
  await rejectsCode(service.saveCustomer({ ...customerInput, name: ' ' }), 'INVALID_INPUT');
  await rejectsCode(service.saveCustomer({ ...customerInput, active: 'false' }), 'INVALID_INPUT');
  for (const validUntil of ['2030-02-30', '2030-13-01', '2030-1-01', 'not-a-date']) {
    await rejectsCode(service.saveQuote({ ...quoteInput, validUntil }), 'INVALID_INPUT');
  }
  for (const quantity of [0, -1, 0.5, 1_000_001, '1']) {
    await rejectsCode(service.saveQuote({ ...quoteInput, lines: [{ itemId: ids.item, quantity }] }), 'INVALID_INPUT');
  }
  for (const addition of [{ status: 'accepted' }, { totalMinor: 0 }, { notes: 'x'.repeat(2001) }, { lines: [] }, { lines: Array(51).fill(quoteInput.lines[0]) }]) {
    await rejectsCode(service.saveQuote({ ...quoteInput, ...addition }), 'INVALID_INPUT');
  }
  await rejectsCode(service.saveQuote({ ...quoteInput, lines: [{ ...quoteInput.lines[0], priceMinor: 1 }] }), 'INVALID_INPUT');
  await rejectsCode(service.transition({ id: ids.quote, revision: null, action: 'convert' }), 'INVALID_INPUT');
  await rejectsCode(service.get({ entity: 'items', id: 'not-uuid' }), 'INVALID_INPUT');
  await rejectsCode(service.list({ entity: 'quotes', search: 'anything' }), 'INVALID_INPUT');
  await rejectsCode(service.list({ entity: 'orders', active: true }), 'INVALID_INPUT');
  assert.equal((await storage.customers.query()).items.length, 0);
  assert.equal((await storage.items.query()).items.length, 0);
  assert.equal((await storage.sales.query()).items.length, 0);
});

test('configuration is a currency lock, including concurrent initializers and zero-decimal currencies', async (t) => {
  const { storage, service, now } = await fixture(t, 'JPY');
  const other = new ErpService(storage, 'admin-2', 'EUR', now);
  const results = await Promise.allSettled([service.info(), other.info()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const saved = await storage.settings.getVersioned('configuration');
  const { currency } = settingsRecordSchema.parse(saved?.value);
  const winner = new ErpService(storage, 'admin-1', currency, now);
  const loser = new ErpService(storage, 'admin-1', currency === 'JPY' ? 'EUR' : 'JPY', now);
  await rejectsCode(loser.saveCustomer(customerInput), 'CURRENCY_MISMATCH');
  assert.equal((await storage.customers.query()).items.length, 0);
  const info = await winner.info();
  assert.equal(info.minorUnits, currency === 'JPY' ? 0 : 2);
  const item = await winner.saveItem({ ...itemInput, priceMinor: 1 });
  assert.equal(item.value.currency, currency);
  await rejectsCode(new ErpService(storage, '', currency, now).info(), 'AUTH_REQUIRED');
  await rejectsCode(new ErpService(storage, 'admin', 'BAD' as Currency, now).info(), 'INVALID_INPUT');
});

test('schema-version guards prevent unknown stored configuration and business records from being overwritten', async (t) => {
  const { storage, service } = await fixture(t);
  await service.info();
  const unknown = await storage.items.compareAndSet(ids.item, null, { schemaVersion: 2, name: 'Future item' });
  assert.ok(unknown.applied);
  await rejectsCode(service.get({ entity: 'items', id: ids.item }), 'SCHEMA_VERSION');
  await rejectsCode(service.list({ entity: 'items' }), 'SCHEMA_VERSION');
  await rejectsCode(service.saveItem({ ...itemInput, revision: unknown.revision }), 'SCHEMA_VERSION');
  const settings = await storage.settings.getVersioned('configuration');
  assert.ok(settings);
  await storage.settings.compareAndSet('configuration', settings.revision, { schemaVersion: 2, currency: 'USD' });
  await rejectsCode(service.info(), 'SCHEMA_VERSION');
  await rejectsCode(service.saveCustomer(customerInput), 'SCHEMA_VERSION');
  assert.equal((await storage.customers.query()).items.length, 0);
});

test('bounded indexed prefix lists honor cursor, archive filters and literal wildcard characters', async (t) => {
  const { service } = await fixture(t);
  for (let index = 0; index < 27; index++) {
    await service.saveCustomer({ ...customerInput, id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`, name: `Team ${index}`, active: index !== 26 });
  }
  const first = await service.list({ entity: 'customers', search: 'TEAM', active: true });
  assert.equal(first.items.length, 25);
  assert.equal(first.hasMore, true);
  assert.ok(first.cursor);
  const second = await service.list({ entity: 'customers', search: 'TEAM', active: true, cursor: first.cursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map((entry) => entry.id)).size, 26);
  assert.equal((await service.list({ entity: 'customers', active: false })).items.length, 1);
  await assert.rejects(service.list({ entity: 'customers', cursor: 'invalid-cursor' }), InvalidCursorError);
  await service.saveCustomer({ ...customerInput, name: '50%_off' });
  const exact = await service.list({ entity: 'customers', search: '50%_' });
  assert.deepEqual(exact.items.map((entry) => entry.id), [ids.customer]);
});

test('separate installations cannot share records or a currency configuration', async (t) => {
  const first = await fixture(t, 'USD');
  const second = await fixture(t, 'EUR');
  await first.service.saveCustomer(customerInput);
  assert.equal((await second.service.info()).currency, 'EUR');
  await rejectsCode(second.service.get({ entity: 'customers', id: ids.customer }), 'NOT_FOUND');
  await second.service.saveCustomer({ ...customerInput, name: 'Other installation' });
  const persisted = await first.service.get({ entity: 'customers', id: ids.customer });
  assert.ok('name' in persisted.value);
  assert.equal(persisted.value.name, 'Acme');
});
