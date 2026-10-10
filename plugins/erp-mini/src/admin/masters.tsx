import { useState } from 'react';
import type { Customer, CustomerInput, Info, Item, RecordView } from '../model.js';
import { parsePrice, priceText, request } from './api.js';
import { Failure, Field, SaveBar, useEditorBlock, useMutation } from './shared.js';
import type { EditorProps } from './shared.js';

export function CustomerEditor({ id, record, onSaved, onBlock, onReload }: EditorProps & {
  id: string; record?: RecordView<Customer>; onSaved: (record: RecordView<Customer>) => void;
}) {
  const [form, setForm] = useState<CustomerInput>(() => ({
    id, revision: record?.revision ?? null, code: record?.value.code ?? '', name: record?.value.name ?? '',
    email: record?.value.email ?? '', phone: record?.value.phone ?? '', address: record?.value.address ?? '',
    contacts: record?.value.contacts.map((contact) => ({ ...contact })) ?? [], active: record?.value.active ?? true,
  }));
  const [dirty, setDirty] = useState(false);
  const mutation = useMutation();
  useEditorBlock(dirty, mutation.pending, onBlock);
  function change<K extends keyof CustomerInput>(key: K, value: CustomerInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }
  return <form onSubmit={(event) => {
    event.preventDefault();
    if (record?.value.active && !form.active && !window.confirm(`Archive “${form.name}”? It will no longer be available for new quotations. Existing snapshots remain unchanged.`)) return;
    void mutation.run(() => request<RecordView<Customer>>('save-customer', form), onSaved);
  }}>
    <Failure error={mutation.error} />
    <fieldset disabled={mutation.pending} className="erp-fieldset">
      <legend>Customer details</legend>
      <div className="erp-form-grid">
        <Field label="Customer name (required)"><input required maxLength={200} autoComplete="organization" value={form.name} onChange={(event) => change('name', event.target.value)} /></Field>
        <Field label="Reference code (required)" hint="Your reference; codes do not have to be unique."><input required maxLength={64} value={form.code} onChange={(event) => change('code', event.target.value)} /></Field>
        <Field label="Email"><input type="email" maxLength={254} autoComplete="email" value={form.email} onChange={(event) => change('email', event.target.value)} /></Field>
        <Field label="Phone"><input type="tel" maxLength={64} autoComplete="tel" value={form.phone} onChange={(event) => change('phone', event.target.value)} /></Field>
      </div>
      <Field label="Address"><textarea rows={3} maxLength={1000} autoComplete="street-address" value={form.address} onChange={(event) => change('address', event.target.value)} /></Field>
      <label className="erp-check"><input type="checkbox" checked={form.active} onChange={(event) => change('active', event.target.checked)} />Active — available for new quotations</label>
      <p className="erp-muted">Uncheck and save to archive. Check and save to re-enable. Historical quotations are never changed.</p>
    </fieldset>
    <fieldset disabled={mutation.pending} className="erp-fieldset">
      <legend>Contacts · {form.contacts.length}/10</legend>
      {form.contacts.length === 0 && <p className="erp-muted">Add people you work with at this customer. Contacts are optional.</p>}
      {form.contacts.map((contact, index) => <div className="erp-contact" key={index}>
        <h4>Contact {index + 1}</h4>
        <div className="erp-form-grid">
          {(['name', 'email', 'phone'] as const).map((key) => <Field key={key} label={`${key === 'name' ? 'Name (required)' : key === 'email' ? 'Email' : 'Phone'} · contact ${index + 1}`}>
            <input type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'} required={key === 'name'} maxLength={key === 'name' ? 200 : key === 'email' ? 254 : 64} value={contact[key]} onChange={(event) => change('contacts', form.contacts.map((value, position) => position === index ? { ...value, [key]: event.target.value } : value))} />
          </Field>)}
        </div>
        <button type="button" onClick={() => change('contacts', form.contacts.filter((_, position) => position !== index))}>Remove contact {index + 1}</button>
      </div>)}
      <button type="button" disabled={form.contacts.length >= 10} onClick={() => change('contacts', [...form.contacts, { name: '', email: '', phone: '' }])}>Add contact</button>
    </fieldset>
    <SaveBar pending={mutation.pending} dirty={dirty} existing={Boolean(record) || Boolean(mutation.error)} onReload={onReload} />
  </form>;
}

export function ItemEditor({ id, record, info, onSaved, onBlock, onReload }: EditorProps & {
  id: string; record?: RecordView<Item>; info: Info; onSaved: (record: RecordView<Item>) => void;
}) {
  const [form, setForm] = useState(() => ({ code: record?.value.code ?? '', name: record?.value.name ?? '', unit: record?.value.unit ?? '', active: record?.value.active ?? true, price: priceText(record?.value.priceMinor ?? 0, info.minorUnits) }));
  const [dirty, setDirty] = useState(false);
  const [priceError, setPriceError] = useState('');
  const mutation = useMutation();
  useEditorBlock(dirty, mutation.pending, onBlock);
  function change<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }
  return <form onSubmit={(event) => {
    event.preventDefault();
    let priceMinor: number;
    try { priceMinor = parsePrice(form.price, info.minorUnits); setPriceError(''); }
    catch (cause) { setPriceError(cause instanceof Error ? cause.message : 'Enter a valid price.'); event.currentTarget.querySelector<HTMLInputElement>('[name="price"]')?.focus(); return; }
    if (record?.value.active && !form.active && !window.confirm(`Archive “${form.name}”? It will no longer be available for new quotations. Existing snapshots remain unchanged.`)) return;
    void mutation.run(() => request<RecordView<Item>>('save-item', { id, revision: record?.revision ?? null, code: form.code, name: form.name, unit: form.unit, active: form.active, priceMinor }), onSaved);
  }}>
    <Failure error={mutation.error} />
    <fieldset disabled={mutation.pending} className="erp-fieldset">
      <legend>Item details</legend>
      <div className="erp-form-grid">
        <Field label="Item name (required)"><input required maxLength={200} value={form.name} onChange={(event) => change('name', event.target.value)} /></Field>
        <Field label="Reference code (required)"><input required maxLength={64} value={form.code} onChange={(event) => change('code', event.target.value)} /></Field>
        <Field label="Unit (required)" hint="For example: each, hour, day or visit. Quantities must be whole numbers."><input required maxLength={32} value={form.unit} onChange={(event) => change('unit', event.target.value)} /></Field>
        <Field label={`Unit price · ${info.currency} (required)`} hint={info.minorUnits ? `Use a decimal point and up to ${info.minorUnits} decimal places; no thousands separators.` : 'Use whole currency units; no decimal point or thousands separators.'}>
          <input name="price" required inputMode={info.minorUnits ? 'decimal' : 'numeric'} maxLength={32} aria-invalid={Boolean(priceError)} aria-describedby={priceError ? 'erp-price-error' : undefined} value={form.price} onChange={(event) => { change('price', event.target.value); setPriceError(''); }} />
        </Field>
      </div>
      {priceError && <p id="erp-price-error" role="alert" className="erp-error">{priceError}</p>}
      <label className="erp-check"><input type="checkbox" checked={form.active} onChange={(event) => change('active', event.target.checked)} />Active — available for new quotations</label>
      <p className="erp-muted">Uncheck and save to archive. Prices are stored exactly in {info.currency} minor units. Updating an item never changes submitted quotations.</p>
    </fieldset>
    <SaveBar pending={mutation.pending} dirty={dirty} existing={Boolean(record) || Boolean(mutation.error)} onReload={onReload} />
  </form>;
}
