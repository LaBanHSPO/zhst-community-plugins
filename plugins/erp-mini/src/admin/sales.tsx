import { useEffect, useState } from 'react';
import type { Action, Customer, Info, Item, ListEntry, QuoteInput, RecordView, Sale } from '../model.js';
import { money, request } from './api.js';
import { Failure, Field, Paged, SaveBar, Search, useEditorBlock, useMutation } from './shared.js';
import type { EditorProps } from './shared.js';

function MasterPicker<T extends Customer | Item>({ entity, onSelect }: { entity: 'customers' | 'items'; onSelect: (record: ListEntry<T>) => void }) {
  const [search, setSearch] = useState('');
  return <div className="erp-picker">
    <Search label={`Find active ${entity}`} value={search} onChange={setSearch} />
    <Paged<T> key={search} entity={entity} search={search} active={true}>{(page) => <ul className="erp-picker-list">{page.items.map((entry) => <li key={entry.id}>
      <div><strong>{entry.value.name}</strong><small>{entry.value.code}{'priceMinor' in entry.value ? ` · ${money(entry.value.priceMinor, entry.value.currency)} / ${entry.value.unit}` : entry.value.email ? ` · ${entry.value.email}` : ''}</small></div>
      <button type="button" onClick={() => onSelect(entry)} aria-label={`${entity === 'items' ? 'Add' : 'Select'} ${entry.value.name}`}>{entity === 'items' ? 'Add item' : 'Select'}</button>
    </li>)}</ul>}</Paged>
  </div>;
}

type DraftLine = { key: string; itemId: string; name: string; code: string; unit: string; priceMinor: number; quantity: string };

export function QuoteEditor({ id, record, info, onSaved, onBlock, onReload }: EditorProps & {
  id: string; record?: RecordView<Sale>; info: Info; onSaved: (record: RecordView<Sale>) => void;
}) {
  const [reference, setReference] = useState(record?.value.reference ?? '');
  const [validUntil, setValidUntil] = useState(record?.value.validUntil ?? '');
  const [notes, setNotes] = useState(record?.value.notes ?? '');
  const [customer, setCustomer] = useState<ListEntry<Customer>>();
  const [contactIndex, setContactIndex] = useState('');
  const [contactLost, setContactLost] = useState(false);
  const [customerLoading, setCustomerLoading] = useState(Boolean(record));
  const [customerError, setCustomerError] = useState<unknown>(null);
  const [customerRetry, setCustomerRetry] = useState(0);
  const [chooseCustomer, setChooseCustomer] = useState(!record);
  const [chooseItem, setChooseItem] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>(() => record?.value.lines.map((line) => ({ ...line, key: crypto.randomUUID(), quantity: String(line.quantity) })) ?? []);
  const [dirty, setDirty] = useState(false);
  const mutation = useMutation();
  useEditorBlock(dirty, mutation.pending, onBlock);
  useEffect(() => {
    if (!record) return;
    const controller = new AbortController();
    setCustomerLoading(true);
    setCustomerError(null);
    request<RecordView<Customer>>('get', { entity: 'customers', id: record.value.customer.id }, controller.signal).then((value) => {
      setCustomer(value);
      const saved = record.value.customer.contact;
      const index = saved ? value.value.contacts.findIndex((contact) => contact.name === saved.name && contact.email === saved.email && contact.phone === saved.phone) : -1;
      setContactIndex(index >= 0 ? String(index) : '');
      setContactLost(Boolean(saved && index < 0));
      setCustomerLoading(false);
    }, (error: unknown) => { if (!controller.signal.aborted) { setCustomerError(error); setCustomerLoading(false); } });
    return () => controller.abort();
  }, [record, customerRetry]);
  let estimate = 0;
  let validEstimate = true;
  for (const line of lines) {
    const quantity = Number(line.quantity);
    const total = line.priceMinor * quantity;
    if (!/^\d+$/.test(line.quantity) || quantity < 1 || quantity > 1_000_000 || !Number.isSafeInteger(total) || !Number.isSafeInteger(estimate + total)) validEstimate = false;
    else estimate += total;
  }
  return <form onSubmit={(event) => {
    event.preventDefault();
    if (!customer?.value.active || !lines.length || contactLost || !validEstimate) { mutation.setError(new Error('Choose an active customer, resolve the contact selection, and add 1–50 lines with whole quantities from 1 to 1,000,000.')); return; }
    const input: QuoteInput = { id, revision: record?.revision ?? null, reference, customerId: customer.id, ...(contactIndex === '' ? {} : { contactIndex: Number(contactIndex) }), lines: lines.map((line) => ({ itemId: line.itemId, quantity: Number(line.quantity) })), validUntil, notes };
    void mutation.run(() => request<RecordView<Sale>>('save-quote', input), onSaved);
  }}>
    <Failure error={mutation.error} />
    <p className="erp-notice">Draft only. Saving refreshes customer details and all prices from the current active master records. Review the saved total before submitting; submission freezes the commercial details.</p>
    <fieldset disabled={mutation.pending} className="erp-fieldset">
      <legend>Quotation details</legend>
      <div className="erp-form-grid">
        <Field label="Your reference"><input maxLength={200} value={reference} onChange={(event) => { setReference(event.target.value); setDirty(true); }} /></Field>
        <Field label="Valid through (required)" hint="Acceptance and conversion use this date in UTC."><input type="date" required value={validUntil} onChange={(event) => { setValidUntil(event.target.value); setDirty(true); }} /></Field>
      </div>
    </fieldset>
    <fieldset disabled={mutation.pending} className="erp-fieldset">
      <legend>Customer & contact</legend>
      {customerLoading && <p role="status">Loading current customer…</p>}
      <Failure error={customerError} retry={() => setCustomerRetry((value) => value + 1)} />
      {customer && <div className="erp-selected"><strong>{customer.value.name}</strong><span>{customer.value.code} · {customer.value.active ? 'Active' : 'Archived — select another customer'}</span><span>{customer.value.email}</span><button type="button" disabled={customerLoading} onClick={() => setChooseCustomer((value) => !value)}>{chooseCustomer ? 'Close customer picker' : 'Change customer'}</button></div>}
      {!customer && !chooseCustomer && <button type="button" disabled={customerLoading} onClick={() => setChooseCustomer(true)}>Choose another customer</button>}
      {chooseCustomer && !customerLoading && <MasterPicker<Customer> entity="customers" onSelect={(value) => { setCustomer(value); setContactIndex(''); setContactLost(false); setCustomerError(null); setChooseCustomer(false); setDirty(true); }} />}
      {customer && <Field label="Contact (optional)"><select value={contactLost ? 'unresolved' : contactIndex} onChange={(event) => { setContactIndex(event.target.value); setContactLost(false); setDirty(true); }}>
        {contactLost && <option value="unresolved" disabled>Previous contact changed — choose explicitly</option>}
        <option value="">No named contact</option>{customer.value.contacts.map((contact, index) => <option key={index} value={index}>{contact.name}{contact.email ? ` · ${contact.email}` : ''}</option>)}
      </select></Field>}
      {contactLost && <p role="alert">The saved contact is no longer present in the customer record. Select a current contact or explicitly choose no named contact.</p>}
    </fieldset>
    <fieldset disabled={mutation.pending} className="erp-fieldset">
      <legend>Line items · {lines.length}/{info.maxLines}</legend>
      {!lines.length && <p className="erp-muted">Add an active item or service to begin.</p>}
      {lines.map((line, index) => <div className="erp-line" key={line.key}>
        <div><strong>{line.name}</strong><small>{line.code} · {money(line.priceMinor, info.currency)} / {line.unit}</small></div>
        <Field label={`Quantity · line ${index + 1}`}><input type="number" required min={1} max={1_000_000} step={1} value={line.quantity} onChange={(event) => { setLines((current) => current.map((value) => value.key === line.key ? { ...value, quantity: event.target.value } : value)); setDirty(true); }} /></Field>
        <button type="button" aria-label={`Remove line ${index + 1}: ${line.name}`} onClick={() => { setLines((current) => current.filter((value) => value.key !== line.key)); setDirty(true); }}>Remove</button>
      </div>)}
      <div className="erp-toolbar"><button type="button" disabled={lines.length >= info.maxLines} onClick={() => setChooseItem((value) => !value)}>{chooseItem ? 'Close item picker' : 'Find items to add'}</button><strong>Estimate: {validEstimate ? money(estimate, info.currency) : 'Check quantities or total'}</strong></div>
      <p className="erp-muted">Estimate only, based on the displayed prices. The server calculates the authoritative saved total using current prices; no taxes are included.</p>
      {chooseItem && lines.length < info.maxLines && <MasterPicker<Item> entity="items" onSelect={(value) => {
        setLines((current) => current.length >= info.maxLines ? current : [...current, { key: crypto.randomUUID(), itemId: value.id, name: value.value.name, code: value.value.code, unit: value.value.unit, priceMinor: value.value.priceMinor, quantity: '1' }]);
        setDirty(true);
      }} />}
    </fieldset>
    <fieldset disabled={mutation.pending} className="erp-fieldset"><legend>Notes</legend><Field label="Customer-facing notes (optional)"><textarea rows={4} maxLength={2000} value={notes} onChange={(event) => { setNotes(event.target.value); setDirty(true); }} /></Field></fieldset>
    <SaveBar pending={mutation.pending || customerLoading} dirty={dirty} existing={Boolean(record) || Boolean(mutation.error)} onReload={onReload} />
  </form>;
}

const transitions: Record<Action, { label: string; consequence: string }> = {
  submit: { label: 'Submit quotation', consequence: 'Freeze customer details, line items and prices permanently. Review the saved total before continuing.' },
  accept: { label: 'Accept quotation', consequence: 'Record the customer’s acceptance of these frozen terms.' },
  convert: { label: 'Create sales order', consequence: 'Create exactly one sales order from these frozen terms. The original quotation will remain available.' },
  'cancel-quote': { label: 'Cancel quotation', consequence: 'Close this quotation permanently. It cannot be reopened or converted to an order.' },
  'fulfill-order': { label: 'Mark fulfilled', consequence: 'Record this order as completed permanently. This does not create a stock movement, invoice or payment.' },
  'cancel-order': { label: 'Cancel order', consequence: 'Close this order permanently. The frozen quotation and order history remain available.' },
};

export function SaleDetail({ record, orderView, onSaved, onEdit, onOpenRelated, onBlock, onReload }: EditorProps & {
  record: RecordView<Sale>; orderView: boolean; onSaved: (record: RecordView<Sale>, action: Action) => void;
  onEdit: () => void; onOpenRelated: (entity: 'quotes' | 'orders', id: string) => void;
}) {
  const sale = record.value;
  const mutation = useMutation();
  useEditorBlock(false, mutation.pending, onBlock);
  const expired = sale.validUntil < new Date().toISOString().slice(0, 10);
  const actions: Action[] = orderView
    ? sale.order?.status === 'open' ? ['fulfill-order', 'cancel-order'] : []
    : sale.status === 'draft' ? ['submit', 'cancel-quote'] : sale.status === 'submitted' ? ['accept', 'cancel-quote'] : sale.status === 'accepted' ? ['convert', 'cancel-quote'] : [];
  return <div>
    <Failure error={mutation.error} />
    <div className="erp-document-heading"><div><span className="erp-status">{orderView ? sale.order?.status : sale.status}</span><h3>{sale.reference || (orderView ? 'Sales order' : 'Quotation')}</h3><p className="erp-number">{orderView ? sale.order?.number : sale.number}</p></div><div className="erp-total"><small>Saved total · no taxes</small><strong>{money(sale.totalMinor, sale.currency)}</strong></div></div>
    <p className="erp-notice">{sale.status === 'draft' ? 'Draft — still editable. Check the saved total before submitting.' : 'Commercial details are frozen. Master record changes do not alter this document.'}</p>
    <div className="erp-form-grid erp-detail-grid">
      <section><h4>Customer snapshot</h4><strong>{sale.customer.name}</strong><p>{sale.customer.email || 'No email'}<br />{sale.customer.phone || 'No phone'}</p><p className="erp-prewrap">{sale.customer.address || 'No address'}</p>{sale.customer.contact && <div><h4>Contact</h4><p>{sale.customer.contact.name}<br />{sale.customer.contact.email}<br />{sale.customer.contact.phone}</p></div>}</section>
      <section><h4>Document details</h4><dl><dt>Valid through (UTC)</dt><dd>{sale.validUntil}{expired && ['submitted', 'accepted'].includes(sale.status) ? ' · Expired' : ''}</dd><dt>Quotation status</dt><dd>{sale.status}</dd>{sale.order && <><dt>Order status</dt><dd>{sale.order.status}</dd></>}<dt>Created</dt><dd>{sale.createdAt}</dd><dt>Last updated</dt><dd>{sale.updatedAt}</dd></dl></section>
    </div>
    <div className="erp-table-scroll" role="region" aria-label="Frozen line items" tabIndex={0}><table><caption>Saved line items</caption><thead><tr><th scope="col">Item</th><th scope="col">Unit</th><th scope="col" className="erp-numeric">Quantity</th><th scope="col" className="erp-numeric">Unit price</th><th scope="col" className="erp-numeric">Total</th></tr></thead><tbody>{sale.lines.map((line, index) => <tr key={`${line.itemId}-${index}`}><th scope="row">{line.name}<small>{line.code}</small></th><td>{line.unit}</td><td className="erp-numeric">{line.quantity}</td><td className="erp-numeric">{money(line.priceMinor, sale.currency)}</td><td className="erp-numeric">{money(line.totalMinor, sale.currency)}</td></tr>)}</tbody><tfoot><tr><th scope="row" colSpan={4}>Total</th><td className="erp-numeric">{money(sale.totalMinor, sale.currency)}</td></tr></tfoot></table></div>
    {sale.notes && <section className="erp-section"><h4>Notes</h4><p className="erp-prewrap">{sale.notes}</p></section>}
    <details className="erp-section"><summary>Lifecycle & audit details</summary><dl><dt>Quotation number</dt><dd className="erp-number">{sale.number}</dd><dt>Created by</dt><dd>{sale.createdBy}</dd><dt>Last updated by</dt><dd>{sale.updatedBy}</dd>{sale.submittedAt && <><dt>Submitted</dt><dd>{sale.submittedAt}</dd></>}{sale.acceptedAt && <><dt>Accepted</dt><dd>{sale.acceptedAt}</dd></>}{sale.cancelledAt && <><dt>Quotation cancelled</dt><dd>{sale.cancelledAt}</dd></>}{sale.order && <><dt>Order number</dt><dd className="erp-number">{sale.order.number}</dd><dt>Order created</dt><dd>{sale.order.createdAt} · {sale.order.createdBy}</dd><dt>Order updated</dt><dd>{sale.order.updatedAt} · {sale.order.updatedBy}</dd></>}</dl></details>
    {expired && ['submitted', 'accepted'].includes(sale.status) && <p className="erp-notice">The validity date has passed in UTC. Acceptance and conversion are unavailable; cancellation remains available.</p>}
    <div className="erp-actions">
      {!orderView && sale.status === 'draft' && <button type="button" disabled={mutation.pending} onClick={onEdit}>Edit draft</button>}
      {actions.map((action, index) => <button type="button" key={action} className={action.startsWith('cancel') ? 'erp-danger' : index === 0 ? 'erp-primary' : undefined} disabled={mutation.pending || (expired && (action === 'accept' || action === 'convert'))} onClick={() => {
        if (!window.confirm(`${transitions[action].label} “${sale.reference || (orderView ? sale.order?.number : sale.number)}”?\n\n${transitions[action].consequence}`)) return;
        void mutation.run(() => request<RecordView<Sale>>('transition', { id: record.id, revision: record.revision, action }), (saved) => onSaved(saved, action));
      }}>{mutation.pending ? 'Updating…' : transitions[action].label}</button>)}
      {sale.order && <button type="button" disabled={mutation.pending} onClick={() => onOpenRelated(orderView ? 'quotes' : 'orders', record.id)}>{orderView ? 'View original quotation' : 'View sales order'}</button>}
      <button type="button" disabled={mutation.pending} onClick={onReload}>Reload saved record</button>
    </div>
    <p className="erp-muted">Sales tracking only. No taxes, invoices, payments or stock ledger. Fulfillment is an operator-recorded completion.</p>
  </div>;
}
