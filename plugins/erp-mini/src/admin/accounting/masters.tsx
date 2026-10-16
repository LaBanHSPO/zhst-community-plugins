import { useState } from 'react';
import type { Account, AccountInput, Party, PartyInput, RootType, AccountPurpose } from '../../accounting/model.js';
import type { Customer, ListPage, RecordView } from '../../model.js';
import { accountingRequest, request } from '../api.js';
import { Failure, Field, Paged, SaveBar, Search, useEditorBlock, useMutation } from '../shared.js';
import type { EditorProps } from '../shared.js';
import { MasterPicker } from './shared.js';

export function AccountEditor({ id, record, onSaved, onBlock, onReload }: EditorProps & { id: string; record?: RecordView<Account>; onSaved: (value: RecordView<Account>) => void }) {
  const [form, setForm] = useState<AccountInput>(() => ({ id, revision: record?.revision ?? null, code: record?.value.code ?? '', name: record?.value.name ?? '', rootType: record?.value.rootType ?? 'asset', purpose: record?.value.purpose ?? 'general', isGroup: record?.value.isGroup ?? false, parentId: record?.value.parentId ?? null, active: record?.value.active ?? true }));
  const [dirty, setDirty] = useState(false);
  const mutation = useMutation();
  useEditorBlock(dirty, mutation.pending, onBlock);
  function change<K extends keyof AccountInput>(key: K, value: AccountInput[K]) { setForm((current) => ({ ...current, [key]: value })); setDirty(true); }
  async function reloadRevision() {
    await mutation.run(() => accountingRequest<RecordView<Account>>('get', { entity: 'accounts', id }), (value) => {
      setForm((current) => ({ ...current, revision: value.revision }));
      setDirty(true);
    });
  }
  return <form onSubmit={(event) => { event.preventDefault(); if (record?.value.active && !form.active && !window.confirm('Disable this account for new entries? Posted history remains unchanged.')) return; void mutation.run(() => accountingRequest<RecordView<Account>>('save-account', form), onSaved); }}>
    <Failure error={mutation.error} />
    <p className="erp-muted">Stable account ID; codes are unique after normalization. Posted history locks root, purpose, group and parent. Rename or disable without changing historical snapshots. The server checks cycles and history on save.</p>
    <fieldset disabled={mutation.pending} className="erp-fieldset"><legend>Account details</legend><div className="erp-form-grid">
      <Field label="Account code"><input required maxLength={64} value={form.code} onChange={(event) => change('code', event.target.value)} /></Field>
      <Field label="Account name"><input required maxLength={200} value={form.name} onChange={(event) => change('name', event.target.value)} /></Field>
      <Field label="Root type"><select value={form.rootType} onChange={(event) => { change('rootType', event.target.value as RootType); change('parentId', null); change('purpose', 'general'); }}>{(['asset', 'liability', 'equity', 'income', 'expense', 'result'] as const).map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
      <Field label="Purpose"><select value={form.purpose} onChange={(event) => change('purpose', event.target.value as AccountPurpose)}><option value="general">General</option>{!form.isGroup && form.rootType === 'asset' && <><option value="cash">Cash</option><option value="bank">Bank</option><option value="receivable">Receivable</option></>}{!form.isGroup && form.rootType === 'liability' && <option value="payable">Payable</option>}</select></Field>
    </div>
      <label className="erp-check"><input type="checkbox" checked={form.isGroup} onChange={(event) => { change('isGroup', event.target.checked); if (event.target.checked) change('purpose', 'general'); }} />Group — cannot receive journal lines</label>
      <MasterPicker entity="accounts" label="Parent group" optional value={form.parentId ?? ''} onChange={(value) => change('parentId', value || null)} accept={(value) => 'rootType' in value && value.isGroup && value.rootType === form.rootType} />
      <label className="erp-check"><input type="checkbox" checked={form.active} onChange={(event) => change('active', event.target.checked)} />Active — selectable for new entries</label>
    </fieldset>
    {form.revision && <button type="button" disabled={mutation.pending} onClick={() => { if (window.confirm('Reload only the latest revision and retain your input? Review structural changes before saving again.')) void reloadRevision(); }}>Reload revision, retain edits</button>}
    <SaveBar pending={mutation.pending} dirty={dirty} existing={Boolean(record)} onReload={onReload} />
  </form>;
}

export function PartyEditor({ id, record, onSaved, onBlock, onReload }: EditorProps & { id: string; record?: RecordView<Party>; onSaved: (value: RecordView<Party>) => void }) {
  const [form, setForm] = useState<PartyInput>(() => ({ id, revision: record?.revision ?? null, code: record?.value.code ?? '', name: record?.value.name ?? '', kind: record?.value.kind ?? 'customer', active: record?.value.active ?? true }));
  const [dirty, setDirty] = useState(false);
  const [link, setLink] = useState(false);
  const [search, setSearch] = useState('');
  const [customer, setCustomer] = useState<RecordView<Customer>>();
  const mutation = useMutation();
  useEditorBlock(dirty, mutation.pending, onBlock);
  function change<K extends keyof PartyInput>(key: K, value: PartyInput[K]) { setForm((current) => ({ ...current, [key]: value })); setDirty(true); }
  return <form onSubmit={(event) => { event.preventDefault(); if (record?.value.active && !form.active && !window.confirm('Disable this party for new entries? Historical entries remain unchanged.')) return; if (link) { if (!customer) { mutation.setError(new Error('Choose a CRM customer first.')); return; } void mutation.run(() => accountingRequest<RecordView<Party>>('link-customer', { id, revision: null, customerId: customer.id, customerRevision: customer.revision }), onSaved); } else void mutation.run(() => accountingRequest<RecordView<Party>>('save-party', form), onSaved); }}>
    <Failure error={mutation.error} />
    <p className="erp-muted">Customer and supplier are separate accounting roles. Historical party kind is immutable. CRM linking snapshots the selected revision once; later CRM changes do not rewrite this record or posted journals.</p>
    <fieldset disabled={mutation.pending} className="erp-fieldset"><legend>Party details</legend>
      {!record && <label className="erp-check"><input type="checkbox" checked={link} onChange={(event) => { setLink(event.target.checked); setDirty(true); }} />Link an existing CRM customer once</label>}
      {link ? <><Search label="Search CRM customers" value={search} onChange={setSearch} />{customer && <p role="status">Selected {customer.value.code} · {customer.value.name} · revision {customer.revision}</p>}<Paged<Customer> key={search} entity="customers" search={search} active>{(page: ListPage<Customer>) => <ul className="erp-picker-list">{page.items.map((value) => <li key={value.id}><div>{value.value.code} · {value.value.name}</div><button type="button" onClick={() => { void mutation.run(() => request<RecordView<Customer>>('get', { entity: 'customers', id: value.id }), (snapshot) => { setCustomer(snapshot); setDirty(true); }); }}>Select CRM customer {value.value.code}</button></li>)}</ul>}</Paged></> : <><div className="erp-form-grid">
        <Field label="Party code"><input required maxLength={64} value={form.code} onChange={(event) => change('code', event.target.value)} /></Field>
        <Field label="Party name"><input required maxLength={200} value={form.name} onChange={(event) => change('name', event.target.value)} /></Field>
        <Field label="Party kind"><select disabled={Boolean(record?.value.sourceId)} value={form.kind} onChange={(event) => change('kind', event.target.value as PartyInput['kind'])}><option value="customer">Customer</option><option value="supplier">Supplier</option></select></Field>
      </div><label className="erp-check"><input type="checkbox" checked={form.active} onChange={(event) => change('active', event.target.checked)} />Active — selectable for new entries</label></>}
      {record?.value.sourceId && <p>CRM source: {record.value.sourceId} · snapshot revision {record.value.sourceRevision}</p>}
    </fieldset>
    {form.revision && <button type="button" disabled={mutation.pending} onClick={() => { if (!window.confirm('Reload latest revision while retaining edits?')) return; void mutation.run(() => accountingRequest<RecordView<Party>>('get', { entity: 'parties', id }), (value) => { setForm((current) => ({ ...current, revision: value.revision })); setDirty(true); }); }}>Reload revision, retain edits</button>}
    <SaveBar pending={mutation.pending} dirty={dirty} existing={Boolean(record)} onReload={onReload} />
  </form>;
}
